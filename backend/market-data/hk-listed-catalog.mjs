import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'cheerio';
import { normalizeTradeDate } from './postgres-store.mjs';

export const HKEX_SECURITIES_URL = 'https://www.hkex.com.hk/eng/services/trading/securities/securitieslists/ListOfSecurities.xlsx';
export const HK_LISTED_FIELDS = 'ts_code,name,list_date,delist_date,list_status,market,isin,curr_type';
export const HKEX_CODE_ALLOCATION_URL = 'https://www.hkex.com.hk/-/media/HKEX-Market/Products/Securities/Stock-Code-Allocation-Plan/scap.pdf';
// Tushare hk_basic omits these stapled securities and depositary receipts. Their
// HKEX/issuer listing documents establish pre-existing listings, while each run
// still requires their current primary counter to exist in the HKEX workbook.
const LISTING_SUPPLEMENTS = new Map([
  ['01270.HK', { name: '朗廷-SS', listDate: '2013-05-30', isin: 'HK0000150521', securityType: 'stapled_security',
    sourceUrl: 'https://www.hkexnews.hk/listedco/listconews/sehk/2022/0908/2022090800355.pdf' }],
  ['02638.HK', { name: '港灯-SS', listDate: '2014-01-29', isin: 'HK0000179108', securityType: 'stapled_security',
    sourceUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2018/0406/ltn20180406341.pdf' }],
  ['06823.HK', { name: '香港电讯-SS', listDate: '2011-11-29', isin: 'HK0000093390', securityType: 'stapled_security',
    sourceUrl: 'https://www.hkexnews.hk/listedco/listconews/sehk/2011/1116/ltn20111116015.pdf' }],
  ['06228.HK', { name: '自由黄金-DRS', listDate: '2026-06-26', isin: 'US5889221124', securityType: 'depositary_receipt',
    sourceUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0617/2026061700073.pdf' }],
  ['06288.HK', { name: '迅销有限公司-预托证券', listDate: '2014-03-05', isin: 'US31188H2004', securityType: 'depositary_receipt',
    sourceUrl: 'https://www.fastretailing.com/eng/ir/news/1403030900.html' }],
]);
const CORPORATE_ACTION_RECONCILIATIONS = new Map([
  ['01657.HK', { effectiveDate: '2026-10-05', previousIsin: 'KYG8061B1077', currentIsin: 'KYG8061B1150',
    action: 'share_subdivision_1_into_10', temporaryCounter: '02936.HK',
    sourceUrl: 'https://www.hkex.com.hk/eng/market/sec_tradinfo/tradarng/tradarng_news/premonth/e2936g_260930.htm' }],
]);
const SUBCATEGORIES = new Map([['Equity Securities (Main Board)', 'main'], ['Equity Securities (GEM)', 'gem'],
  ['Investment Companies', 'main'], ['Depositary Receipts', 'main']]);
const SECURITY_TYPES = { 'Equity Securities (Main Board)': 'equity', 'Equity Securities (GEM)': 'equity',
  'Investment Companies': 'investment_company', 'Depositary Receipts': 'depositary_receipt' };
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024, MAX_XML_BYTES = 64 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
function invalid(message = '港股全市场在市名册无效。') {
  const error = new Error(message); error.kind = 'validation'; error.code = 'VALIDATION_ERROR'; return error;
}
const date = value => normalizeTradeDate(value).iso;
function xmlDocument(text) {
  const namespace = /xmlns(?::([A-Za-z_][\w.-]*))?="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/.exec(text);
  if (!namespace) throw invalid('港交所证券名册 XML 命名空间无效。');
  const prefix = namespace[1];
  if (prefix) text = text.replace(new RegExp(`(<\\/?)${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'g'), '$1');
  return load(text, { xmlMode: true });
}

// Read only the two small OpenXML parts needed by this known HKEX workbook.
// No archive paths are extracted to disk and ZIP64/encrypted/multi-disk files
// are rejected. Bound compressed and inflated sizes before parsing XML.
function archiveParts(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < 22 || buffer.length > MAX_ARCHIVE_BYTES) throw invalid('港交所证券名册文件大小无效。');
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)
    || buffer.readUInt16LE(end + 8) !== buffer.readUInt16LE(end + 10)) throw invalid('港交所证券名册 ZIP 结构无效。');
  const entries = buffer.readUInt16LE(end + 10), directorySize = buffer.readUInt32LE(end + 12), offset = buffer.readUInt32LE(end + 16);
  if (!entries || entries > 1000 || offset + directorySize !== end) throw invalid('港交所证券名册 ZIP 目录无效。');
  const wanted = new Set(['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']), found = new Map();
  let cursor = offset;
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw invalid('港交所证券名册 ZIP 条目无效。');
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20), expanded = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw invalid('港交所证券名册 ZIP 条目越界。');
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength); cursor = next;
    if (!wanted.has(name)) continue;
    if (found.has(name) || flags & 1 || ![0, 8].includes(method) || expanded > MAX_XML_BYTES
      || localOffset + 30 > offset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw invalid('港交所证券名册 XML 条目无效。');
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (start + compressed > offset) throw invalid('港交所证券名册 XML 数据越界。');
    const source = buffer.subarray(start, start + compressed);
    let xml;
    try { xml = method === 0 ? source : inflateRawSync(source, { maxOutputLength: MAX_XML_BYTES }); } catch { throw invalid('港交所证券名册 XML 解压失败。'); }
    if (xml.length !== expanded) throw invalid('港交所证券名册 XML 大小不符。');
    const text = xml.toString('utf8'); if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw invalid('港交所证券名册 XML 含不支持的声明。');
    found.set(name, text);
  }
  if (cursor !== end || !found.has('xl/worksheets/sheet1.xml')) throw invalid('港交所证券名册缺少证券工作表。');
  return found;
}

export function parseHkexSecuritiesXlsx(input) {
  const parts = archiveParts(input), strings = [];
  if (parts.has('xl/sharedStrings.xml')) {
    const $ = xmlDocument(parts.get('xl/sharedStrings.xml'));
    $('sst > si').each((_, node) => strings.push($(node).find('t').text()));
  }
  const $ = xmlDocument(parts.get('xl/worksheets/sheet1.xml')), rows = [];
  $('sheetData > row').each((_, row) => {
    const cells = {};
    $(row).children('c').each((__, cell) => {
      const ref = $(cell).attr('r'); if (!/^[A-Z]{1,3}\d+$/.test(ref ?? '')) throw invalid('港交所证券名册单元格位置无效。');
      let value = $(cell).children('v').text();
      if ($(cell).attr('t') === 's') {
        if (!/^\d+$/.test(value) || strings[Number(value)] === undefined) throw invalid('港交所证券名册共享字符串无效。');
        value = strings[Number(value)];
      } else if ($(cell).attr('t') === 'inlineStr') value = $(cell).find('t').text();
      cells[ref.replace(/\d+$/, '')] = value.trim();
    });
    rows.push(cells);
  });
  if (rows.length < 4 || rows[0].A !== 'List of Securities' || rows[2].A !== 'Stock Code'
    || rows[2].B !== 'Name of Securities' || rows[2].C !== 'Category' || rows[2].D !== 'Sub-Category'
    || rows[2].F !== 'ISIN' || rows[2].Q !== 'Trading Currency' || rows[2].R !== 'RMB Counter') throw invalid('港交所证券名册字段发生变化。');
  const stamp = /^Updated as at (\d{2})\/(\d{2})\/(\d{4})$/.exec(rows[1].A ?? '');
  if (!stamp) throw invalid('港交所证券名册发布日期无效。');
  const sourceDate = date(`${stamp[3]}-${stamp[2]}-${stamp[1]}`), securities = [], codes = new Set();
  for (const row of rows.slice(3)) {
    if (!row.A) continue;
    if (!/^\d{5}$/.test(row.A) || !row.B || !row.C) throw invalid('港交所证券名册证券代码或名称无效。');
    if (codes.has(row.A)) throw invalid('港交所证券名册含重复证券代码。'); codes.add(row.A);
    securities.push({ ticker: `${row.A}.HK`, name: row.B, category: row.C, subCategory: row.D ?? '',
      currency: row.Q ?? '', isin: row.F || null, rmbCounter: row.R || null });
  }
  if (!securities.length) throw invalid('港交所证券名册为空。');
  return { sourceDate, sourceUrl: HKEX_SECURITIES_URL, sourceHash: sha(Buffer.from(input)), securities };
}

export function buildHkListedCatalog({ hkex, tushareRows, asOf, fetchedAt = new Date().toISOString() }) {
  asOf = date(asOf);
  if (!hkex || !Array.isArray(hkex.securities) || !hkex.securities.length || !Array.isArray(tushareRows)
    || !tushareRows.length || !Number.isFinite(Date.parse(fetchedAt))) throw invalid();
  const sourceDate = date(hkex.sourceDate), byTicker = new Map();
  // The official sheet is prepared for the next trading day, which can be
  // several calendar days ahead across weekends and exchange holidays.
  if (sourceDate > date(new Date(Date.parse(`${asOf}T00:00:00Z`) + 14 * 86400000).toISOString().slice(0, 10))) throw invalid('港交所证券名册日期超出本次观察范围。');
  for (const row of tushareRows) {
    if (!row || !/^\d{5}\.HK$/.test(row.ts_code) || row.list_status !== 'L' || typeof row.name !== 'string'
      || !row.name.trim() || byTicker.has(row.ts_code)) throw invalid('Tushare 当前在市股票名册字段或代码无效。');
    const listDate = row.list_date ? date(row.list_date) : null;
    const delistDate = row.delist_date ? date(row.delist_date) : null;
    byTicker.set(row.ts_code, { ...row, listDate, delistDate });
  }
  const audit = { hkexRecords: hkex.securities.length, tushareListedRecords: tushareRows.length,
    sourceAheadOfAsOf: sourceDate > asOf, criteria: { category: 'Equity', subCategories: [...SUBCATEGORIES.keys()], currencies: ['HKD', 'USD'],
      excludeRmbCounters: true, excludeTemporaryCounters: true, excludeProfessionalPreferenceShares: true },
    excludedByCategory: {}, temporaryCounters: [], temporaryCounterSource: HKEX_CODE_ALLOCATION_URL,
    supplementalConfirmations: [], corporateActionReconciliations: [], currencyReconciliations: [],
    unknownListingDates: [], hkexOnly: [], tushareOnly: [], futureListings: [], delistedByAsOf: [], membershipConflicts: [] };
  const securities = [], candidates = new Set(), seen = new Set();
  for (const row of hkex.securities) {
    if (!/^\d{5}\.HK$/.test(row.ticker) || seen.has(row.ticker)) throw invalid('港交所名册含无效或重复代码。'); seen.add(row.ticker);
    const board = SUBCATEGORIES.get(row.subCategory);
    const code = Number(row.ticker.slice(0, 5));
    if (row.category !== 'Equity' || !board || !['HKD', 'USD'].includes(row.currency) || /^8\d{4}\.HK$/.test(row.ticker) || row.name.endsWith('-R')
      || (code >= 4600 && code <= 4699)) {
      const reason = `${row.category}/${row.subCategory}/${row.currency}`;
      audit.excludedByCategory[reason] = (audit.excludedByCategory[reason] ?? 0) + 1; continue;
    }
    if ((code >= 2900 && code <= 2999) || (code >= 8551 && code <= 8600)) {
      audit.temporaryCounters.push({ ticker: row.ticker, name: row.name, reason: 'temporary_counter_not_additional_company' }); continue;
    }
    candidates.add(row.ticker);
    let basic = byTicker.get(row.ticker);
    const supplement = LISTING_SUPPLEMENTS.get(row.ticker);
    if (!basic && supplement && supplement.isin === row.isin && supplement.listDate <= asOf) {
      basic = { ts_code: row.ticker, name: supplement.name, listDate: supplement.listDate, delistDate: null, curr_type: 'HKD', isin: supplement.isin };
      audit.supplementalConfirmations.push({ ticker: row.ticker, ...supplement, confirmation: 'official_listing_document_and_current_hkex_primary_counter' });
    }
    if (!basic) { audit.hkexOnly.push({ ticker: row.ticker, name: row.name, isin: row.isin }); continue; }
    if (!basic.listDate) { audit.unknownListingDates.push({ ticker: row.ticker, name: basic.name }); continue; }
    if (basic.listDate > asOf) { audit.futureListings.push({ ticker: row.ticker, name: basic.name, listDate: basic.listDate }); continue; }
    if (basic.delistDate && basic.delistDate <= asOf) { audit.delistedByAsOf.push({ ticker: row.ticker, delistDate: basic.delistDate }); continue; }
    if (basic.curr_type && basic.curr_type !== row.currency) {
      // 00770's provider reference says HKD, while both HKEX and Tencent's live
      // quote currency field (qt[75]) say USD. Do not relabel its prices HKD.
      if (row.ticker === '00770.HK' && row.currency === 'USD' && basic.curr_type === 'HKD') {
        audit.currencyReconciliations.push({ ticker: row.ticker, currency: 'USD', tushareCurrency: 'HKD',
          confirmation: 'hkex_trading_currency_and_tencent_qt_75', sourceUrl: 'https://qt.gtimg.cn/q=hk00770' });
      } else { audit.membershipConflicts.push({ ticker: row.ticker, reason: 'currency', hkex: row.currency, tushare: basic.curr_type }); continue; }
    }
    if (row.isin && basic.isin?.trim() && row.isin !== basic.isin.trim()) {
      const action = CORPORATE_ACTION_RECONCILIATIONS.get(row.ticker);
      if (action && action.effectiveDate <= asOf && action.currentIsin === row.isin && action.previousIsin === basic.isin.trim()) {
        audit.corporateActionReconciliations.push({ ticker: row.ticker, ...action });
      } else { audit.membershipConflicts.push({ ticker: row.ticker, reason: 'isin', hkex: row.isin, tushare: basic.isin.trim() }); continue; }
    }
    securities.push({ ticker: row.ticker, name: basic.name.trim(), listDate: basic.listDate, board, securityType: supplement?.securityType ?? SECURITY_TYPES[row.subCategory],
      subCategory: row.subCategory, currency: row.currency, isin: row.isin || basic.isin?.trim() || null });
  }
  for (const basic of byTicker.values()) if (!candidates.has(basic.ts_code)) audit.tushareOnly.push({ ticker: basic.ts_code, name: basic.name,
    listDate: basic.listDate, market: basic.market ?? null, currency: basic.curr_type ?? null, reason: seen.has(basic.ts_code) ? 'excluded_hkex_category_or_currency' : 'absent_from_hkex' });
  securities.sort((a, b) => a.ticker.localeCompare(b.ticker));
  audit.hkexCandidateRecords = candidates.size; audit.confirmedRecords = securities.length;
  audit.reconciliationStatus = audit.hkexOnly.length || audit.tushareOnly.length || audit.unknownListingDates.length || audit.membershipConflicts.length ? 'differences_reported' : 'matched';
  audit.pendingTushareOnly = audit.tushareOnly.filter(row => row.reason === 'absent_from_hkex').length;
  audit.pendingRecords = audit.hkexOnly.length + audit.unknownListingDates.length + audit.membershipConflicts.length + audit.pendingTushareOnly;
  if (!securities.length && audit.pendingRecords === 0) throw invalid('港交所与当前在市股票名册没有可确认的交集。');
  return { version: 1, complete: audit.pendingRecords === 0, source: 'hkex_tushare', apiName: 'hkex_listed_equities', asOf, sourceDate, sourceUrl: HKEX_SECURITIES_URL, sourceHash: hkex.sourceHash ?? null,
    fetchedAt, securities, universeHash: sha(securities.map(row => row.ticker).join('\n')), audit };
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(temporary, path);
}
export async function loadHkListedCatalog(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || value.version !== 1 || value.complete !== true || value.source !== 'hkex_tushare' || value.apiName !== 'hkex_listed_equities'
    || value.audit?.pendingRecords !== 0 || value.audit?.confirmedRecords !== value.securities?.length
    || !Array.isArray(value.audit?.tushareOnly) || value.audit.tushareOnly.some(row => row.reason === 'absent_from_hkex')
    || !Array.isArray(value.securities) || !value.securities.length
    || value.securities.some(row => !/^\d{5}\.HK$/.test(row.ticker) || !row.name || !['main', 'gem'].includes(row.board)
      || !['HKD', 'USD'].includes(row.currency) || !row.listDate || date(row.listDate) > date(value.asOf))
    || new Set(value.securities.map(row => row.ticker)).size !== value.securities.length
    || value.universeHash !== sha(value.securities.map(row => row.ticker).sort().join('\n'))) throw invalid();
  date(value.sourceDate); return value;
}

/** Cache source snapshots separately from the 28-stock valuation/EPS universe. */
export async function syncHkListedCatalog({ client, cacheDir, asOf, fetchImpl = globalThis.fetch, timeoutMs = 30000, refresh = false,
  fetchedAt = new Date().toISOString(), log = () => {} }) {
  asOf = date(asOf);
  if (!cacheDir || typeof cacheDir !== 'string' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw invalid();
  const directory = join(cacheDir, 'hk-market', 'catalog'), snapshotPath = join(directory, `snapshot-${asOf}.json`);
  if (!refresh) {
    try { const cached = await loadHkListedCatalog(snapshotPath); return { ...cached, path: snapshotPath, cached: true }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!client || typeof client.queryAll !== 'function' || typeof fetchImpl !== 'function') throw invalid('下载港股在市名册需要 Tushare 与港交所连接。');
  const response = await fetchImpl(HKEX_SECURITIES_URL, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
  if (response.status !== 200 || Number(response.headers?.get('content-length') ?? 0) > MAX_ARCHIVE_BYTES) throw invalid('港交所证券名册下载失败。');
  const bytes = Buffer.from(await response.arrayBuffer()), hkex = parseHkexSecuritiesXlsx(bytes);
  const tushareRows = await client.queryAll('hk_basic', { list_status: 'L' }, HK_LISTED_FIELDS,
    { pageSize: 6000, maxPages: 5, maxRows: 20000, primaryKey: ['ts_code'] });
  const catalog = buildHkListedCatalog({ hkex, tushareRows, asOf, fetchedAt });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!catalog.complete) {
    // Retain diagnostics for reconciliation without replacing the last verified
    // membership snapshot or its source files. Consumers must reject complete:false.
    const attempt = `incomplete-${asOf}-${randomUUID()}`, incompletePath = join(directory, `${attempt}.json`);
    await writeFile(join(directory, `${attempt}.xlsx`), bytes, { mode: 0o600 });
    await atomicJson(join(directory, `${attempt}-tushare.json`), { source: 'tushare', apiName: 'hk_basic', params: { list_status: 'L' }, fetchedAt, rows: tushareRows });
    await atomicJson(incompletePath, catalog);
    log({ type: 'hk_listed_catalog_incomplete', asOf, sourceDate: catalog.sourceDate, pendingRecords: catalog.audit.pendingRecords });
    return { ...catalog, path: incompletePath, cached: false };
  }
  await writeFile(join(directory, `hkex-${asOf}.xlsx`), bytes, { mode: 0o600 });
  await atomicJson(join(directory, `tushare-${asOf}.json`), { source: 'tushare', apiName: 'hk_basic', params: { list_status: 'L' }, fetchedAt, rows: tushareRows });
  await atomicJson(snapshotPath, catalog); await atomicJson(join(directory, 'snapshot.json'), catalog);
  log({ type: 'hk_listed_catalog_completed', asOf, sourceDate: catalog.sourceDate, confirmedRecords: catalog.securities.length,
    reconciliationStatus: catalog.audit.reconciliationStatus, universeHash: catalog.universeHash });
  return { ...catalog, path: snapshotPath, cached: false };
}
