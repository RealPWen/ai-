import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { syncIndustries, syncAdjustments, collectClassification, collectL2Classification, collectL2Members } from '../backend/market-data/industry-sync.mjs';
import { createTushareClient } from '../backend/market-data/tushare-client.mjs';

const START = '20261012', END = '20261013';
const industry = (overrides = {}) => ({ index_code: '850731.SI', industry_name: '汽车电子', parent_code: '801093.SI', industry_code: '730103', level: 'L3', src: 'SW2021', is_pub: 1, ...overrides });
const l2Industry = (overrides = {}) => industry({ index_code: '801093.SI', industry_name: '汽车零部件', parent_code: '801880.SI', industry_code: '730100', level: 'L2', ...overrides });
const member = (code = '850731.SI', overrides = {}) => ({ ts_code: '002920.SZ', name: '德赛西威', l1_code: '801880.SI', l1_name: '汽车', l2_code: '801093.SI', l2_name: '汽车零部件', l3_code: code, l3_name: '汽车电子', in_date: '20211213', out_date: null, is_new: 'Y', ...overrides });
const index = (date, code = '850731.SI') => ({ ts_code: code, trade_date: date, open: 100, high: 110, low: 98, close: 105, pct_change: 1, vol: 500, amount: null });
const factor = date => ({ ts_code: '002920.SZ', trade_date: date, adj_factor: 2 });
async function fixture(t, dates = [START, END]) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'industry-sync-')); t.after(() => rm(cacheDir, { recursive: true, force: true }));
  await mkdir(join(cacheDir, 'A')); await writeFile(join(cacheDir, 'A', `calendar-${START}-${END}.json`), JSON.stringify({ version: 1, market: 'A', startDate: START, endDate: END, dates }));
  const queries = [], saved = [], failed = [], snapshots = [], l2Snapshots = [], l2MemberSnapshots = [];
  const client = {
    async query(api, params, fields) { queries.push({ api, params, fields }); assert.equal(api, 'index_classify'); return params.level === 'L2' ? [l2Industry()] : [industry(), industry({ index_code: '850732.SI', is_pub: 0 })]; },
    async queryAll(api, params, fields, options) { queries.push({ api, params, fields, options }); if (api === 'index_member_all') return [member(params.l3_code)]; if (api === 'adj_factor') return [factor(params.trade_date)]; return [index(params.trade_date), index(params.trade_date, '850732.SI'), index(params.trade_date, '801093.SI'), index(params.trade_date, '801000.SI')]; },
  };
  const store = { async migrate() {}, async replaceClassification(value) { snapshots.push(value); }, async replaceL2Classification(value) { l2Snapshots.push(value); }, async replaceL2Members(value) { l2MemberSnapshots.push(value); }, async getCompletedDays() { return new Set(); }, async saveDay(value) { saved.push(value); }, async markFailedDay(value) { failed.push(value); }, async summary() { return { rowsCount: saved.length }; } };
  return { cacheDir, startDate: START, endDate: END, client, store, queries, saved, failed, snapshots, l2Snapshots, l2MemberSnapshots };
}

test('industry collector completes all classifications then fetches newest all-level days once, storing published L2 and L3', async t => {
  const f = await fixture(t), result = await syncIndustries(f);
  assert.equal(result.status, 'completed'); assert.equal(result.importedDays, 2); assert.equal(result.rows, 4); assert.equal(f.l2Snapshots.length, 1); assert.equal(result.classification.l2Industries, 1); assert.equal(result.classification.totalPublishedIndustries, 2); assert.equal(f.snapshots.length, 1); assert.equal(f.snapshots[0].members.length, 2);
  assert.deepEqual(f.queries.filter(q => q.api === 'sw_daily').map(q => q.params.trade_date), [END, START]);
  assert.ok(f.queries.filter(q => q.api === 'sw_daily').every(q => q.options.pageSize === 4000));
  assert.ok(f.queries.filter(q => q.api === 'index_member_all' && q.params.l3_code).every(q => q.options.pageSize === 2000 && q.params.is_new === 'Y' && q.options.primaryKey.join(',') === 'ts_code,l3_code'));
  assert.ok(f.saved.every(day => day.apiName === 'sw_daily' && day.rows.length === 2 && day.rows[0].ts_code === '850731.SI' && day.rows[1].ts_code === '801093.SI'));
  const snapshot = JSON.parse(await readFile(join(f.cacheDir, 'industries', 'SW2021', 'snapshot.json'))); assert.equal(snapshot.status, 'completed'); assert.equal(snapshot.completedCodes.length, 2);
});
test('download and offline import use complete metadata with no database during download and no Tushare during import', async t => {
  const f = await fixture(t); assert.equal((await syncIndustries({ ...f, mode: 'download', store: null })).status, 'completed'); assert.equal(f.saved.length, 0); assert.equal(f.snapshots.length, 0);
  const count = f.queries.length, imported = await syncIndustries({ ...f, mode: 'import', client: null });
  assert.equal(imported.status, 'completed'); assert.equal(imported.cachedDays, 2); assert.equal(f.queries.length, count); assert.equal(f.saved.length, 2);
});
test('offline snapshot normalizes the source publication flags so string zero cannot select an unpublished index', async t => {
  const f = await fixture(t, [END]); await syncIndustries({ ...f, mode: 'download', store: null });
  const path = join(f.cacheDir, 'industries', 'SW2021', 'snapshot.json'), snapshot = JSON.parse(await readFile(path)); snapshot.industries[1].is_pub = '0'; await writeFile(path, JSON.stringify(snapshot));
  assert.equal((await syncIndustries({ ...f, mode: 'import', client: null })).status, 'completed');
  assert.deepEqual(f.saved[0].rows.map(row => row.ts_code), ['850731.SI', '801093.SI']);
});
test('known historical aliases remain audited in raw member cache, are counted explicitly and excluded from published members', async t => {
  const f = await fixture(t), original = f.client.queryAll, logs = [];
  f.client.queryAll = async (api, params, ...rest) => { const rows = await original(api, params, ...rest); return api === 'index_member_all' && params.l3_code === '850732.SI' ? [...rows, member(params.l3_code, { ts_code: 'T00018.SH', name: '上港集箱(退市)' })] : rows; };
  const result = await syncIndustries({ ...f, log: event => logs.push(event) });
  assert.equal(result.status, 'completed'); assert.equal(result.classification.unsupportedHistoricalAliases, 1); assert.equal(result.classification.sourceMembers, 3); assert.equal(result.classification.members, 2);
  assert.ok(logs.some(event => event.type === 'industry_historical_aliases_excluded' && event.unsupportedHistoricalAliases === 1));
  const cached = JSON.parse(gunzipSync(await readFile(join(f.cacheDir, 'industries', 'SW2021', 'members', '850732.SI.json.gz'))));
  assert.equal(cached.unsupportedHistoricalAliases, 1); assert.ok(cached.rows.some(row => row.ts_code === 'T00018.SH' && row.name === '上港集箱(退市)'));
  assert.ok(f.snapshots[0].members.every(row => /^\d{6}\.(SH|SZ|BJ)$/.test(row.ts_code))); assert.equal(f.snapshots[0].unsupportedHistoricalAliases, 1);
});
test('ordinary illegal codes and malformed historical alias fields abort source snapshot publication instead of being skipped', async t => {
  for (const bad of [member('850732.SI', { ts_code: 'not-a-stock' }), member('850732.SI', { ts_code: 'T00018.SH', l1_name: '' })]) {
    const f = await fixture(t), original = f.client.queryAll;
    f.client.queryAll = async (api, params, ...rest) => api === 'index_member_all' && params.l3_code === '850732.SI' ? [bad] : original(api, params, ...rest);
    assert.equal((await syncIndustries(f)).blockedBy, 'validation'); assert.equal(f.snapshots.length, 0);
    await assert.rejects(readFile(join(f.cacheDir, 'industries', 'SW2021', 'snapshot.json')), { code: 'ENOENT' });
  }
});
test('partial member download retains resume files and never publishes snapshot; next run resumes finished L3', async t => {
  const f = await fixture(t), original = f.client.queryAll; let shouldFail = true;
  f.client.queryAll = async (api, params, ...rest) => { if (api === 'index_member_all' && params.l3_code === '850732.SI' && shouldFail) throw Object.assign(new Error('token secret'), { kind: 'permission' }); return original(api, params, ...rest); };
  const first = await syncIndustries(f); assert.equal(first.status, 'incomplete'); assert.equal(first.blockedBy, 'permission'); assert.equal(f.snapshots.length, 0); assert.equal(f.saved.length, 0);
  await assert.rejects(readFile(join(f.cacheDir, 'industries', 'SW2021', 'snapshot.json')), { code: 'ENOENT' });
  assert.equal((await syncIndustries({ ...f, mode: 'import', client: null })).status, 'incomplete');
  const memberPath = join(f.cacheDir, 'industries', 'SW2021', 'members', '850731.SI.json.gz'), oldMembers = JSON.parse(gunzipSync(await readFile(memberPath)));
  oldMembers.fetchedAt = '2026-10-12T00:00:00.000Z'; await writeFile(memberPath, gzipSync(JSON.stringify(oldMembers)));
  shouldFail = false; const resumed = await syncIndustries(f); assert.equal(resumed.status, 'completed');
  assert.equal(f.queries.filter(q => q.api === 'index_classify' && q.params.level === 'L3').length, 1); assert.equal(f.queries.filter(q => q.api === 'index_member_all' && q.params.l3_code === '850731.SI').length, 1);
  assert.equal(f.snapshots[0].members.find(row => row.l3_code === '850731.SI').fetched_at, oldMembers.fetchedAt); assert.ok(f.snapshots[0].completedAt > oldMembers.fetchedAt);
});
test('refresh failure retains the prior complete snapshot and database reference instead of publishing partial members', async t => {
  const f = await fixture(t); assert.equal((await syncIndustries(f)).status, 'completed');
  const path = join(f.cacheDir, 'industries', 'SW2021', 'snapshot.json'), before = await readFile(path, 'utf8');
  f.client.queryAll = async () => { throw Object.assign(new Error('token secret'), { kind: 'authentication' }); };
  const refresh = await syncIndustries({ ...f, refresh: true }); assert.equal(refresh.blockedBy, 'authentication'); assert.equal(await readFile(path, 'utf8'), before); assert.equal(f.snapshots.length, 1);
});
test('default snapshot reuse avoids classification downloads; API-specific completion skips days; refresh re-downloads', async t => {
  const f = await fixture(t); await syncIndustries(f); f.queries.length = 0; f.store.getCompletedDays = async options => { assert.equal(options.apiName, 'sw_daily'); return new Set([START, END]); };
  const skipped = await syncIndustries(f); assert.equal(skipped.skippedDays, 2); assert.equal(f.queries.length, 0);
  const refreshed = await syncIndustries({ ...f, refresh: true }); assert.equal(refreshed.skippedDays, 0); assert.equal(refreshed.downloadedDays, 2); assert.equal(f.queries.filter(q => q.api === 'index_classify' && q.params.level === 'L3').length, 1);
});
test('reimport upgrades L3-only completed days from raw all-level cache without redownloading or skipping L2', async t => {
  const f = await fixture(t);
  await syncIndustries({ ...f, mode: 'download', store: null });
  f.queries.length = 0;
  f.store.getCompletedDays = async () => { throw new Error('a reimport must not consult the old L3-only completion ledger'); };
  const report = await syncIndustries({ ...f, client: null, mode: 'import', reimport: true });
  assert.equal(report.status, 'completed'); assert.equal(report.reimport, true); assert.equal(report.cachedDays, 2); assert.equal(report.importedDays, 2); assert.equal(report.skippedDays, 0); assert.equal(report.downloadedDays, 0);
  assert.equal(f.queries.length, 0);
  assert.ok(f.saved.every(day => day.rows.some(row => row.ts_code === '801093.SI') && day.rows.some(row => row.ts_code === '850731.SI')));
});
test('an unresolved or mismatched stock L2 label blocks all database snapshot replacements', async t => {
  for (const override of [{ l2_code: '801095.SI' }, { l2_name: '乘用车' }]) {
    const f = await fixture(t), original = f.client.queryAll;
    f.client.queryAll = async (api, params, ...rest) => api === 'index_member_all' ? [member(params.l3_code, override)] : original(api, params, ...rest);
    const report = await syncIndustries(f);
    assert.equal(report.status, 'incomplete'); assert.equal(report.blockedBy, 'validation'); assert.equal(f.snapshots.length, 0); assert.equal(f.l2Snapshots.length, 0); assert.equal(f.saved.length, 0);
  }
});
test('L2 collection refresh keeps previous complete cache if upstream fails and offline import validates level', async t => {
  const f = await fixture(t), first = await collectL2Classification(f);
  assert.equal(first.level, 'L2'); assert.equal(f.queries.length, 1); assert.deepEqual(f.queries[0].params, { level: 'L2', src: 'SW2021' });
  const path = join(f.cacheDir, 'industries', 'SW2021', 'snapshot-l2.json'), before = await readFile(path, 'utf8');
  f.client.query = async () => { throw Object.assign(new Error('token secret'), { kind: 'permission' }); };
  await assert.rejects(collectL2Classification({ ...f, refresh: true }), { kind: 'permission' }); assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await collectL2Classification({ ...f, client: null, mode: 'import' })).snapshotId, first.snapshotId);
  const corrupt = JSON.parse(before); corrupt.industries[0].level = 'L3'; await writeFile(path, JSON.stringify(corrupt));
  await assert.rejects(collectL2Classification({ ...f, client: null, mode: 'import' }), { code: 'VALIDATION_ERROR' });
});
test('a normal later day replacement retains both L2 and L3 after the initial L2 backfill', async t => {
  const f = await fixture(t); await syncIndustries(f); f.saved.length = 0;
  f.store.getCompletedDays = async () => new Set([START]);
  const next = await syncIndustries(f);
  assert.equal(next.status, 'completed'); assert.equal(next.skippedDays, 1); assert.equal(f.saved.length, 1);
  assert.deepEqual(f.saved[0].rows.map(row => row.ts_code), ['850731.SI', '801093.SI']);
});
test('independent L2 member source fills a directory-mismatched L3 code and reuses its complete cache offline', async t => {
  const f = await fixture(t), original = f.client.queryAll;
  f.client.queryAll = async (api, params, ...rest) => api === 'index_member_all' && params.l2_code
    ? [member('850412.SI', { l3_name: '特钢Ⅲ' }), member('850412.SI', { ts_code: 'T00018.SH', name: '历史别名', l3_name: '特钢Ⅲ' })]
    : original(api, params, ...rest);
  const report = await syncIndustries(f);
  assert.equal(report.status, 'completed'); assert.equal(report.classification.l2Members, 1); assert.equal(report.classification.l2SourceMembers, 2); assert.equal(report.classification.l2UnsupportedHistoricalAliases, 1);
  assert.equal(f.l2MemberSnapshots[0].members[0].l3_code, '850412.SI'); assert.equal(f.l2MemberSnapshots[0].members[0].l2_code, '801093.SI');
  assert.ok(!f.snapshots[0].members.some(row => row.l3_code === '850412.SI'));
  const cached = JSON.parse(gunzipSync(await readFile(join(f.cacheDir, 'industries', 'SW2021', 'members-l2', '801093.SI.json.gz')))); assert.equal(cached.rows.length, 2);
  f.client.queryAll = async () => { throw new Error('cache should be used'); };
  const imported = await collectL2Members({ ...f, client: null, mode: 'import' }); assert.equal(imported.members.length, 1);
});
test('partial L2 group collection never publishes and resumes only missing groups before atomic snapshot publication', async t => {
  const f = await fixture(t), originalQuery = f.client.query;
  f.client.query = async (api, params, fields) => params.level === 'L2' ? [l2Industry(), l2Industry({ index_code: '801095.SI', industry_name: '乘用车' })] : originalQuery(api, params, fields);
  let failSecond = true, firstCalls = 0;
  f.client.queryAll = async (api, params) => {
    assert.equal(api, 'index_member_all');
    if (params.l2_code === '801093.SI') { firstCalls++; return [member()]; }
    if (failSecond) throw Object.assign(new Error('secret token'), { kind: 'permission' });
    return [member('850951.SI', { ts_code: '002594.SZ', l2_code: '801095.SI', l2_name: '乘用车', l3_name: '电动乘用车' })];
  };
  await assert.rejects(collectL2Members(f), { kind: 'permission' });
  const path = join(f.cacheDir, 'industries', 'SW2021', 'snapshot-l2-members.json'); await assert.rejects(readFile(path), { code: 'ENOENT' });
  await assert.rejects(collectL2Members({ ...f, mode: 'import', client: null }));
  failSecond = false; const completed = await collectL2Members(f);
  assert.equal(completed.completedCodes.length, 2); assert.equal(completed.members.length, 2); assert.equal(firstCalls, 1);
  await assert.rejects(readFile(join(f.cacheDir, 'industries', 'SW2021', 'snapshot-l2-members-pending.json')), { code: 'ENOENT' });
  const before = await readFile(path, 'utf8'); failSecond = true;
  await assert.rejects(collectL2Members({ ...f, refresh: true }), { kind: 'permission' }); assert.equal(await readFile(path, 'utf8'), before);
});
test('adjustment collector shares calendar and supports source-specific resume plus offline import', async t => {
  const f = await fixture(t); const downloaded = await syncAdjustments({ ...f, mode: 'download', store: null });
  assert.equal(downloaded.status, 'completed'); assert.equal(f.snapshots.length, 0); assert.ok(f.queries.every(q => q.api === 'adj_factor' && q.options.pageSize === 6000));
  f.store.getCompletedDays = async options => { assert.equal(options.apiName, 'adj_factor'); return new Set([END]); };
  const imported = await syncAdjustments({ ...f, mode: 'import', client: null }); assert.equal(imported.status, 'completed'); assert.equal(imported.skippedDays, 1); assert.equal(f.saved[0].apiName, 'adj_factor');
});
test('provider permission/authentication/rate and database errors stop without sensitive status output', async t => {
  for (const kind of ['permission', 'authentication', 'rate_limit', 'database']) {
    const f = await fixture(t); let calls = 0;
    if (kind === 'database') f.store.saveDay = async () => { throw Object.assign(new Error('postgres://secret'), { code: 'DATABASE_ERROR' }); };
    else f.client.queryAll = async () => { calls++; throw Object.assign(new Error('token secret'), { kind }); };
    const result = await syncAdjustments(f); assert.equal(result.status, 'incomplete'); assert.equal(result.blockedBy, kind); assert.equal(result.completedDays, 0); assert.equal(f.failed.length, 1); if (kind !== 'database') assert.equal(calls, 1);
    assert.doesNotMatch(await readFile(join(f.cacheDir, 'adjustments', 'A', `status-${START}-${END}-sync.json`), 'utf8'), /secret/);
  }
});
test('zero or duplicate factors and empty dates cannot be cached or completed; a subsequent valid day still succeeds', async t => {
  for (const bad of [[], [factor(END), factor(END)], [factor(END), { ...factor(END), ts_code: '000001.SZ', adj_factor: 0 }]]) {
    const f = await fixture(t); f.client.queryAll = async (_, params) => params.trade_date === END ? bad : [factor(START)];
    const result = await syncAdjustments(f); assert.equal(result.status, 'incomplete'); assert.equal(result.completedDays, 1); assert.equal(f.saved.length, 1); assert.equal(f.failed.length, 1);
    await assert.rejects(readFile(join(f.cacheDir, 'adjustments', 'A', `${END}.json.gz`)), { code: 'ENOENT' });
  }
});
test('failed database day keeps downloaded cache and supports an import-only retry', async t => {
  const f = await fixture(t, [END]), save = f.store.saveDay; f.store.saveDay = async () => { throw Object.assign(new Error('secret'), { code: 'DATABASE_ERROR' }); };
  assert.equal((await syncAdjustments(f)).status, 'incomplete'); f.store.saveDay = save;
  const resumed = await syncAdjustments({ ...f, mode: 'import', client: null }); assert.equal(resumed.status, 'completed'); assert.equal(resumed.cachedDays, 1);
});
test('corrupt day metadata and incomplete classification completion lists cannot import', async t => {
  const f = await fixture(t, [END]); await syncIndustries({ ...f, mode: 'download', store: null });
  const directory = join(f.cacheDir, 'industries', 'SW2021', 'daily');
  await writeFile(join(directory, `${END}.json.gz`), gzipSync(JSON.stringify({ version: 1, source: 'tushare', market: 'A', apiName: 'daily', tradeDate: END, fetchedAt: new Date().toISOString(), rows: [index(END)] })));
  const wrong = await syncIndustries({ ...f, mode: 'import', client: null }); assert.equal(wrong.status, 'incomplete'); assert.equal(f.saved.length, 0);
  const path = join(f.cacheDir, 'industries', 'SW2021', 'snapshot.json'), snapshot = JSON.parse(await readFile(path)); snapshot.completedCodes.pop(); await writeFile(path, JSON.stringify(snapshot));
  assert.equal((await syncIndustries({ ...f, mode: 'import', client: null })).blockedBy, 'validation');
});
test('membership real client paginates through a provider cap smaller than requested and requires terminal empty page', async t => {
  const f = await fixture(t), offsets = [];
  const client = createTushareClient({ token: 'test', intervalMs: 0, maxRetries: 0, fetchImpl: async (_, request) => {
    const { api_name: api, params } = JSON.parse(request.body); let rows;
    if (api === 'index_classify') rows = [industry()];
    else { assert.equal(api, 'index_member_all'); offsets.push(params.offset); rows = params.offset === 0 ? [member()] : params.offset === 1 ? [member('850731.SI', { ts_code: '000001.SZ' })] : []; }
    const fields = Object.keys(rows[0] ?? member()); return { status: 200, async json() { return { code: 0, data: { fields, items: rows.map(row => fields.map(field => row[field])) } }; } };
  } });
  const snapshot = await collectClassification({ client, cacheDir: f.cacheDir }); assert.equal(snapshot.members.length, 2); assert.deepEqual(offsets, [0, 1, 2]);
});
