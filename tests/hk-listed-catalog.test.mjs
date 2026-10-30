import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HKEX_SECURITIES_URL, HK_LISTED_FIELDS, parseHkexSecuritiesXlsx, buildHkListedCatalog,
  syncHkListedCatalog, loadHkListedCatalog } from '../backend/market-data/hk-listed-catalog.mjs';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const xmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function zip(parts) {
  const data = [], directory = []; let offset = 0;
  for (const [name, value] of Object.entries(parts)) {
    const fileName = Buffer.from(name), raw = Buffer.from(value), compressed = deflateRawSync(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(fileName.length, 26);
    data.push(local, fileName, compressed);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE(offset, 42); directory.push(central, fileName);
    offset += local.length + fileName.length + compressed.length;
  }
  const centralData = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(parts).length, 8); end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, centralData, end]);
}
const main = 'Equity Securities (Main Board)', gem = 'Equity Securities (GEM)';
const hk = (ticker = '00001.HK', changes = {}) => ({ ticker, name: 'CKH & HOLDINGS', category: 'Equity', subCategory: main,
  currency: 'HKD', isin: 'KYG217651051', rmbCounter: null, ...changes });
const basic = (ticker = '00001.HK', changes = {}) => ({ ts_code: ticker, name: '长和', list_date: '20150318', delist_date: null,
  list_status: 'L', market: '主板', curr_type: 'HKD', isin: 'KYG217651051', ...changes });
function workbook(securities = [hk()], { prefix = 'x:', sourceDate = '20/10/2026', header = 'Stock Code' } = {}) {
  const cells = (n, values) => `<${prefix}row r="${n}">${Object.entries(values).map(([col, value]) =>
    `<${prefix}c r="${col}${n}" t="inlineStr"><${prefix}is><${prefix}t>${xmlEscape(value ?? '')}</${prefix}t></${prefix}is></${prefix}c>`).join('')}</${prefix}row>`;
  const rows = [`<${prefix}row r="1"><${prefix}c r="A1" t="s"><${prefix}v>0</${prefix}v></${prefix}c></${prefix}row>`,
    cells(2, { A: `Updated as at ${sourceDate}` }), cells(3, { A: header, B: 'Name of Securities', C: 'Category', D: 'Sub-Category', F: 'ISIN', Q: 'Trading Currency', R: 'RMB Counter' }),
    ...securities.map((row, i) => cells(i + 4, { A: row.ticker.slice(0, 5), B: row.name, C: row.category, D: row.subCategory, F: row.isin, Q: row.currency, R: row.rmbCounter }))];
  const ns = `xmlns${prefix ? ':x' : ''}="${NS}"`;
  return zip({ 'xl/sharedStrings.xml': `<${prefix}sst ${ns}><${prefix}si><${prefix}r><${prefix}t>List of </${prefix}t></${prefix}r><${prefix}r><${prefix}t>Securities</${prefix}t></${prefix}r></${prefix}si></${prefix}sst>`,
    'xl/worksheets/sheet1.xml': `<${prefix}worksheet ${ns}><${prefix}sheetData>${rows.join('')}</${prefix}sheetData></${prefix}worksheet>` });
}
const parsed = securities => parseHkexSecuritiesXlsx(workbook(securities));
const catalog = (securities = [hk()], tushareRows = [basic()], changes = {}) => buildHkListedCatalog({ hkex: parsed(securities), tushareRows, asOf: '2026-10-19', fetchedAt: '2026-10-19T08:00:00.000Z', ...changes });

test('HKEX parser reads namespaced OpenXML, rich shared strings, currency and five-digit codes', () => {
  for (const prefix of ['x:', '']) {
    const result = parseHkexSecuritiesXlsx(workbook([hk(), hk('08007.HK', { subCategory: gem, isin: null })], { prefix }));
    assert.equal(result.sourceDate, '2026-10-20'); assert.equal(result.sourceUrl, HKEX_SECURITIES_URL);
    assert.match(result.sourceHash, /^[a-f0-9]{64}$/); assert.equal(result.securities[0].ticker, '00001.HK');
    assert.equal(result.securities[0].name, 'CKH & HOLDINGS'); assert.equal(result.securities[1].isin, null);
  }
});

test('catalog includes confirmed Main Board, GEM, investment companies and DR and excludes funds, warrants, RMB and trading-only counters', () => {
  const rows = [hk(), hk('08007.HK', { subCategory: gem }), hk('00122.HK', { subCategory: 'Investment Companies' }),
    hk('06288.HK', { subCategory: 'Depositary Receipts' }), hk('06806.HK', { category: 'Real Estate Investment Trusts', subCategory: '' }),
    hk('02800.HK', { category: 'Exchange Traded Products', subCategory: 'Exchange Traded Funds' }), hk('80016.HK', { currency: 'RMB' }),
    hk('05001.HK', { category: 'Derivative Warrants', subCategory: '' }), hk('04332.HK', { subCategory: 'Trading Only Securities' })];
  const result = catalog(rows, rows.map(row => basic(row.ticker)));
  assert.deepEqual(result.securities.map(row => row.ticker), ['00001.HK', '00122.HK', '06288.HK', '08007.HK']);
  assert.deepEqual(result.securities.map(row => row.securityType), ['equity', 'investment_company', 'depositary_receipt', 'equity']);
  assert.equal(result.securities.at(-1).board, 'gem'); assert.equal(result.audit.tushareOnly.length, 5);
  assert.equal(result.audit.hkexCandidateRecords, 4); assert.equal(result.audit.confirmedRecords, 4);
});

test('tomorrow-prepared official workbook cannot add a future IPO or company without confirmed listing dates', () => {
  const rows = [hk(), hk('02513.HK'), hk('02699.HK'), hk('03233.HK'), hk('01657.HK'), hk('00002.HK')];
  const basics = [basic(), basic('02513.HK', { list_date: '20261020' }), basic('02699.HK', { list_date: null }),
    basic('01657.HK', { isin: 'different' }), basic('00002.HK', { delist_date: '20261018' }), basic('00770.HK')];
  const result = catalog(rows, basics);
  assert.equal(result.audit.sourceAheadOfAsOf, true); assert.equal(result.sourceDate, '2026-10-20'); assert.equal(result.asOf, '2026-10-19');
  assert.deepEqual(result.securities.map(row => row.ticker), ['00001.HK']);
  assert.equal(result.audit.futureListings[0].ticker, '02513.HK'); assert.equal(result.audit.unknownListingDates[0].ticker, '02699.HK');
  assert.equal(result.audit.hkexOnly[0].ticker, '03233.HK'); assert.equal(result.audit.membershipConflicts[0].ticker, '01657.HK');
  assert.equal(result.audit.delistedByAsOf[0].ticker, '00002.HK'); assert.equal(result.audit.tushareOnly[0].ticker, '00770.HK');
  assert.equal(result.audit.reconciliationStatus, 'differences_reported');
  assert.equal(result.complete, false); assert.equal(result.audit.pendingTushareOnly, 1); assert.equal(result.audit.pendingRecords, 4);
});

test('audited supplements keep missing stapled stocks and receipts, exclude temporary duplicate counters and reconcile corporate actions', () => {
  const rows = [hk(), hk('01270.HK', { isin: 'HK0000150521' }), hk('06288.HK', { subCategory: 'Depositary Receipts', isin: 'US31188H2004' }),
    hk('01657.HK', { isin: 'KYG8061B1150' }), hk('02936.HK'), hk('08551.HK', { subCategory: gem }),
    hk('00770.HK', { subCategory: 'Investment Companies', currency: 'USD', isin: null })];
  const result = catalog(rows, [basic(), basic('01657.HK', { isin: 'KYG8061B1077' }), basic('00770.HK', { isin: null })]);
  assert.deepEqual(result.securities.map(row => row.ticker), ['00001.HK', '00770.HK', '01270.HK', '01657.HK', '06288.HK']);
  assert.equal(result.securities.find(row => row.ticker === '00770.HK').currency, 'USD');
  assert.equal(result.securities.find(row => row.ticker === '01270.HK').securityType, 'stapled_security');
  assert.equal(result.audit.supplementalConfirmations.length, 2); assert.equal(result.audit.corporateActionReconciliations.length, 1);
  assert.equal(result.audit.currencyReconciliations.length, 1); assert.equal(result.audit.temporaryCounters.length, 2);
  assert.equal(result.audit.pendingRecords, 0); assert.equal(result.complete, true); assert.equal(result.source, 'hkex_tushare');
});

test('catalog preserves suspended companies and membership hash is independent of names and order', () => {
  const a = catalog([hk('00002.HK'), hk()], [basic(), basic('00002.HK', { name: '长期停牌公司' })]);
  const b = catalog([hk(), hk('00002.HK')], [basic('00002.HK', { name: '更名公司' }), basic()]);
  assert.equal(a.securities.length, 2); assert.equal(a.universeHash, b.universeHash);
  assert.equal(a.audit.reconciliationStatus, 'matched');
});

test('catalog rejects duplicate source codes, unexpected Tushare statuses and malformed listing dates', () => {
  assert.throws(() => catalog([hk(), hk()])); assert.throws(() => catalog([hk()], [basic(), basic()]));
  assert.throws(() => catalog([hk()], [basic('00001.HK', { list_status: 'D' })]));
  assert.throws(() => catalog([hk()], [basic('00001.HK', { list_date: '20260230' })]));
  assert.equal(catalog([hk()], [basic()], { asOf: '2026-10-17' }).audit.sourceAheadOfAsOf, true);
  assert.throws(() => catalog([hk()], [basic()], { asOf: '2026-10-01' }));
});

test('unresolved listing dates, ISIN conflicts and Tushare-only listed companies prevent publication as complete', () => {
  for (const [rows, basics] of [
    [[hk(), hk('00002.HK')], [basic(), basic('00002.HK', { list_date: null })]],
    [[hk(), hk('00002.HK')], [basic(), basic('00002.HK', { isin: 'different' })]],
    [[hk()], [basic(), basic('00002.HK')]],
  ]) {
    const result = catalog(rows, basics); assert.equal(result.complete, false); assert.equal(result.audit.pendingRecords, 1);
  }
  const unresolvedOnly = catalog([hk()], [basic('00001.HK', { list_date: null })]);
  assert.equal(unresolvedOnly.complete, false); assert.equal(unresolvedOnly.securities.length, 0);
});

test('XLSX parser rejects missing parts, truncated archives, changed headers and duplicate codes', () => {
  for (const source of [Buffer.from('not a zip'), workbook().subarray(0, -10), zip({ test: 'test' }), workbook([hk()], { header: 'Changed' }), workbook([hk(), hk()])]) {
    assert.throws(() => parseHkexSecuritiesXlsx(source), { code: 'VALIDATION_ERROR' });
  }
  const encrypted = workbook(); const directory = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); encrypted.writeUInt16LE(1, directory + 8);
  assert.throws(() => parseHkexSecuritiesXlsx(encrypted), { code: 'VALIDATION_ERROR' });
});

test('sync writes isolated source audit snapshots and same-day cache avoids all network calls', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'hk-listed-catalog-')); let calls = 0, queries = 0;
  try {
    const bytes = workbook();
    const options = { cacheDir, asOf: '20261019', fetchedAt: '2026-10-19T08:00:00.000Z',
      fetchImpl: async (url, options) => { calls++; assert.equal(url, HKEX_SECURITIES_URL); assert.equal(options.redirect, 'error'); return { status: 200, async arrayBuffer() { return bytes; } }; },
      client: { async queryAll(api, params, fields, paging) { queries++; assert.equal(api, 'hk_basic'); assert.deepEqual(params, { list_status: 'L' }); assert.equal(fields, HK_LISTED_FIELDS); assert.deepEqual(paging.primaryKey, ['ts_code']); return [basic()]; } } };
    const first = await syncHkListedCatalog(options), second = await syncHkListedCatalog({ ...options, client: null, fetchImpl: null });
    assert.equal(first.cached, false); assert.equal(second.cached, true); assert.equal(calls, 1); assert.equal(queries, 1);
    assert.match(first.path, /hk-market\/catalog\/snapshot-2026-10-19.json$/);
    assert.deepEqual(await readFile(join(cacheDir, 'hk-market/catalog/hkex-2026-10-19.xlsx')), bytes);
    const tushare = JSON.parse(await readFile(join(cacheDir, 'hk-market/catalog/tushare-2026-10-19.json'), 'utf8'));
    assert.equal(tushare.apiName, 'hk_basic'); assert.deepEqual(tushare.rows, [basic()]);
    const modified = { ...first, securities: [...first.securities, ...first.securities] };
    await writeFile(first.path, JSON.stringify(modified)); await assert.rejects(loadHkListedCatalog(first.path), { code: 'VALIDATION_ERROR' });
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('incomplete refresh saves an audit attempt without replacing verified membership or its sources', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'hk-listed-catalog-incomplete-'));
  try {
    const directory = join(cacheDir, 'hk-market/catalog'), bytes = workbook();
    const options = { cacheDir, asOf: '20261019', fetchImpl: async () => ({ status: 200, async arrayBuffer() { return bytes; } }),
      client: { async queryAll() { return [basic()]; } } };
    const verified = await syncHkListedCatalog(options), pointerPath = join(directory, 'snapshot.json');
    const beforeSnapshot = await readFile(verified.path), beforePointer = await readFile(pointerPath);
    const beforeXlsx = await readFile(join(directory, 'hkex-2026-10-19.xlsx')), beforeTushare = await readFile(join(directory, 'tushare-2026-10-19.json'));
    const incomplete = await syncHkListedCatalog({ ...options, refresh: true, client: { async queryAll() { return [basic(), basic('00002.HK')]; } } });
    assert.equal(incomplete.complete, false); assert.equal(incomplete.audit.pendingRecords, 1); assert.match(incomplete.path, /incomplete-2026-10-19-/);
    assert.equal(JSON.parse(await readFile(incomplete.path, 'utf8')).complete, false);
    await assert.rejects(loadHkListedCatalog(incomplete.path), { code: 'VALIDATION_ERROR' });
    await writeFile(incomplete.path, JSON.stringify({ ...incomplete, complete: true }));
    await assert.rejects(loadHkListedCatalog(incomplete.path), { code: 'VALIDATION_ERROR' });
    assert.deepEqual(await readFile(verified.path), beforeSnapshot); assert.deepEqual(await readFile(pointerPath), beforePointer);
    assert.deepEqual(await readFile(join(directory, 'hkex-2026-10-19.xlsx')), beforeXlsx);
    assert.deepEqual(await readFile(join(directory, 'tushare-2026-10-19.json')), beforeTushare);
    assert.equal((await loadHkListedCatalog(pointerPath)).universeHash, verified.universeHash);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});
