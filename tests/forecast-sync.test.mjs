import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { partitionForecastRange, fetchForecastRows, syncForecasts, FORECAST_FIELDS } from '../backend/market-data/forecast-sync.mjs';
const row = (date = '20261011', changes = {}) => ({ ...Object.fromEntries(FORECAST_FIELDS.split(',').map(key => [key, null])), ts_code: '002920.SZ', name: '德赛西威', report_date: date, report_title: '公司跟踪', org_name: '甲证券', quarter: '2027Q4', eps: 3.1, ...changes });
async function fixture(t, overrides = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'forecast-sync-')); t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const saved = [], failed = [], queries = [], completed = new Set();
  const store = { async migrate() {}, async getCompletedRanges() { return completed; }, async saveRange(value) { saved.push(value); completed.add(`${value.startDate}-${value.endDate}`); }, async markFailedRange(value) { failed.push(value); }, async summary() { return { rows_count: saved.reduce((total, value) => total + value.rows.length, 0) }; } };
  const client = { async query(api, params, fields) { queries.push({ api, params, fields }); return params.offset === 0 ? [row(params.start_date)] : []; } };
  return { cacheDir, saved, failed, queries, completed, store, client, startDate: '20260929', endDate: '20261013', ...overrides };
}
test('forecast monthly partitions clip both ends, include weekend and leap day, newest first', () => {
  assert.deepEqual(partitionForecastRange('20250929', '20251013'), [{ startDate: '20251001', endDate: '20251013' }, { startDate: '20250929', endDate: '20250930' }]);
  assert.deepEqual(partitionForecastRange('20240228', '20240301'), [{ startDate: '20240301', endDate: '20240301' }, { startDate: '20240228', endDate: '20240229' }]);
  assert.equal(partitionForecastRange('20251014', '20261013').length, 13);
  assert.throws(() => partitionForecastRange('20261014', '20251013'), { code: 'VALIDATION_ERROR' });
});
test('forecast pagination uses offset of all raw rows and continues through short pages to empty', async () => {
  const calls = [], pages = [[row(), row('20261011', { org_name: '乙证券' })], [row('20261011', { quarter: '2028Q4' })], []];
  const client = { async query(api, params, fields) { calls.push({ api, params, fields }); return pages.shift(); } };
  const rows = await fetchForecastRows(client, '20261001', '20261013');
  assert.equal(rows.length, 3); assert.deepEqual(calls.map(call => call.params.offset), [0, 2, 3]); assert.ok(calls.every(call => call.api === 'report_rc' && call.params.limit === 3000 && call.fields === FORECAST_FIELDS));
});
test('forecast nullable identity fields and identical duplicates are retained in raw download, but conflicting identities reject', async () => {
  const pages = [[row(), { ...row() }], [row('20261011', { quarter: '2028Q4' })], []];
  assert.equal((await fetchForecastRows({ async query() { return pages.shift(); } }, '20261001', '20261013')).length, 3);
  const conflicting = [[row()], [row('20261011', { eps: 9 })], []];
  await assert.rejects(fetchForecastRows({ async query() { return conflicting.shift(); } }, '20261001', '20261013'), { kind: 'validation' });
});
test('repeated pages, unexpected date/code, too many rows and missing pagination termination are rejected', async () => {
  await assert.rejects(fetchForecastRows({ async query() { return [row()]; } }, '20261001', '20261013'), { kind: 'validation' });
  await assert.rejects(fetchForecastRows({ async query() { return [row('20260930')]; } }, '20261001', '20261013'), { kind: 'validation' });
  await assert.rejects(fetchForecastRows({ async query() { return [row('20261011', { ts_code: '00700.HK' })]; } }, '20261001', '20261013'), { kind: 'validation' });
  const pages = [[row()], [row('20261011', { quarter: '2028Q4' })], []];
  await assert.rejects(fetchForecastRows({ async query() { return pages.shift(); } }, '20261001', '20261013', { maxRows: 1 }), { kind: 'validation' });
  await assert.rejects(fetchForecastRows({ async query() { return [row()]; } }, '20261001', '20261013', { maxPages: 1 }), { kind: 'validation' });
});
test('forecast collector uses calendar date ranges, no trading calendar, and atomic raw cache metadata', async t => {
  const f = await fixture(t), result = await syncForecasts(f);
  assert.equal(result.status, 'completed'); assert.equal(result.plannedRanges, 2); assert.equal(result.importedRanges, 2);
  assert.deepEqual(f.queries.filter(q => q.params.offset === 0).map(q => [q.params.start_date, q.params.end_date]), [['20261001', '20261013'], ['20260929', '20260930']]);
  assert.ok(f.queries.every(query => query.api === 'report_rc'));
  const cached = JSON.parse(gunzipSync(await readFile(join(f.cacheDir, 'forecasts', 'A', '20261001-20261013.json.gz'))));
  assert.equal(cached.apiName, 'report_rc'); assert.equal(cached.startDate, '20261001'); assert.equal(cached.endDate, '20261013'); assert.equal(cached.rows[0].eps, 3.1); assert.equal(cached.rows[0].author_name, null);
  assert.equal(f.saved[0].fetchedAt, cached.fetchedAt);
});
test('empty calendar ranges complete, cache, import, and resume without provider calls', async t => {
  const f = await fixture(t); f.client.query = async () => [];
  const first = await syncForecasts({ ...f, mode: 'download', store: null }); assert.equal(first.status, 'completed'); assert.equal(first.rows, 0); assert.equal(first.completedRanges, 2);
  const imported = await syncForecasts({ ...f, mode: 'import', client: null }); assert.equal(imported.status, 'completed'); assert.equal(f.saved.length, 2); assert.ok(f.saved.every(value => value.rows.length === 0));
  const resumed = await syncForecasts({ ...f, client: { async query() { throw new Error('must not query'); } } }); assert.equal(resumed.status, 'completed'); assert.equal(resumed.skippedRanges, 2);
});
test('forecast identical raw duplicates remain cached and counts distinguish unique report periods', async t => {
  const f = await fixture(t, { startDate: '20261001' }); const pages = [[row(), { ...row() }], []]; f.client.query = async () => pages.shift();
  const result = await syncForecasts(f); assert.equal(result.status, 'completed'); assert.equal(result.rows, 1); assert.equal(result.rawRows, 2); assert.equal(result.duplicateRows, 1); assert.equal(f.saved[0].rows.length, 2);
});
test('forecast permissions/rate/auth/database errors stop the run and persist fixed classifications only', async t => {
  for (const kind of ['permission', 'rate_limit', 'authentication', 'database']) {
    const f = await fixture(t); let calls = 0;
    if (kind === 'database') f.store.saveRange = async () => { throw Object.assign(new Error('password=secret'), { code: 'DATABASE_ERROR' }); };
    else f.client.query = async () => { calls++; throw Object.assign(new Error('token=secret'), { kind }); };
    const result = await syncForecasts(f); assert.equal(result.status, 'incomplete'); assert.equal(result.blockedBy, kind); assert.equal(result.completedRanges, 0); assert.equal(result.failedRanges.length, 1); if (kind !== 'database') assert.equal(calls, 1);
    const status = await readFile(join(f.cacheDir, 'forecasts', 'A', 'status-20260929-20261013-sync.json'), 'utf8'); assert.doesNotMatch(status, /secret|password/);
  }
});
test('failed import can resume the successfully downloaded raw cache without API access', async t => {
  const f = await fixture(t, { startDate: '20261001' }), save = f.store.saveRange;
  f.store.saveRange = async () => { throw Object.assign(new Error('secret'), { code: 'DATABASE_ERROR' }); };
  assert.equal((await syncForecasts(f)).status, 'incomplete'); assert.equal(f.queries.length, 2);
  f.store.saveRange = save; const retried = await syncForecasts({ ...f, mode: 'import', client: null }); assert.equal(retried.status, 'completed'); assert.equal(retried.cachedRanges, 1);
});
test('wrong cache source, out of range raw row and missing cache cannot import as complete', async t => {
  const f = await fixture(t, { startDate: '20261001' }), directory = join(f.cacheDir, 'forecasts', 'A'); await mkdir(directory, { recursive: true });
  const cached = { version: 1, source: 'tushare', market: 'A', apiName: 'daily_basic', startDate: '20261001', endDate: '20261013', fetchedAt: new Date().toISOString(), rows: [row()] };
  await writeFile(join(directory, '20261001-20261013.json.gz'), gzipSync(JSON.stringify(cached)));
  assert.equal((await syncForecasts({ ...f, mode: 'import', client: null })).status, 'incomplete'); assert.equal(f.saved.length, 0);
  cached.apiName = 'report_rc'; cached.rows = [row('20260930')]; await writeFile(join(directory, '20261001-20261013.json.gz'), gzipSync(JSON.stringify(cached)));
  assert.equal((await syncForecasts({ ...f, mode: 'import', client: null })).status, 'incomplete'); assert.equal(f.saved.length, 0);
  await rm(join(directory, '20261001-20261013.json.gz')); assert.equal((await syncForecasts({ ...f, mode: 'import', client: null })).status, 'incomplete');
});
test('explicit refresh fetches newer source corrections even for completed range, ordinary rerun skips', async t => {
  const f = await fixture(t, { startDate: '20261001' }); assert.equal((await syncForecasts(f)).status, 'completed');
  assert.equal((await syncForecasts(f)).skippedRanges, 1); assert.equal(f.saved.length, 1);
  f.client.query = async (_, params) => params.offset === 0 ? [row(params.start_date, { eps: 9.7 })] : [];
  const refreshed = await syncForecasts({ ...f, refresh: true }); assert.equal(refreshed.status, 'completed'); assert.equal(refreshed.downloadedRanges, 1); assert.equal(f.saved.at(-1).rows[0].eps, 9.7);
});

test('source versions differing only in create_time are fully collected across pages', async () => {
  const first = row('20260117', { quarter: null, ts_code: '920159.BJ', org_name: '华源证券', eps: null, create_time: '2026-01-18 18:08:22' });
  const second = { ...first, create_time: '2026-01-19 18:08:22' }, pages = [[first], [second], []];
  const collected = await fetchForecastRows({ async query() { return pages.shift(); } }, '20260101', '20260131');
  assert.deepEqual(collected, [first, second]);
});
