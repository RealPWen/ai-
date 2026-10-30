import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { syncValuations, VALUATION_FIELDS } from '../backend/market-data/valuation-sync.mjs';
const START = '20261012', END = '20261013';
const row = date => ({ ts_code: '002920.SZ', trade_date: date, close: 76.96, pe: null, pe_ttm: 30, pb: 4, total_mv: 2000000, circ_mv: 1900000, turnover_rate: 0.5, total_share: 30000, float_share: 27000 });
async function fixture(t, dates = [START, END]) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'valuation-sync-')); t.after(() => rm(cacheDir, { recursive: true, force: true }));
  await mkdir(join(cacheDir, 'A')); await writeFile(join(cacheDir, 'A', `calendar-${START}-${END}.json`), JSON.stringify({ version: 1, market: 'A', startDate: START, endDate: END, dates }));
  const saved = [], failed = [], queries = [];
  const store = { async migrate() {}, async getCompletedDays(options) { assert.equal(options.apiName, 'daily_basic'); return new Set(); }, async saveDay(value) { saved.push(value); }, async markFailedDay(value) { failed.push(value); }, async summary() { return { totals: { rows_count: saved.length } }; } };
  const client = { async query() { throw new Error('must reuse calendar'); }, async queryAll(api, params, fields, options) { queries.push({ api, params, fields, options }); return [row(params.trade_date)]; } };
  return { cacheDir, saved, failed, queries, store, client, startDate: START, endDate: END };
}
test('valuation collector reuses daily calendar, fetches daily_basic newest first, preserves nulls and writes complete metadata', async t => {
  const f = await fixture(t); const result = await syncValuations(f);
  assert.equal(result.status, 'completed'); assert.equal(result.downloadedDays, 2); assert.equal(result.importedDays, 2);
  assert.deepEqual(f.queries.map(q => q.params.trade_date), [END, START]); assert.ok(f.queries.every(q => q.api === 'daily_basic' && q.fields === VALUATION_FIELDS && q.options.pageSize === 6000));
  assert.equal(f.saved[0].rows[0].pe, null); assert.equal(f.saved[0].apiName, 'daily_basic');
  const cached = JSON.parse(gunzipSync(await readFile(join(f.cacheDir, 'valuations', 'A', `${END}.json.gz`))));
  assert.equal(cached.source, 'tushare'); assert.equal(cached.version, 1); assert.equal(cached.apiName, 'daily_basic'); assert.equal(cached.rows[0].pe, null);
  assert.ok(result.days.every(day => day.status === 'imported' && day.rowsCount === 1));
});
test('download then import resumes cache without using Tushare and keeps download-only independent of database', async t => {
  const f = await fixture(t); const downloaded = await syncValuations({ ...f, mode: 'download', store: null });
  assert.equal(downloaded.status, 'completed'); assert.equal(f.saved.length, 0);
  const imported = await syncValuations({ ...f, mode: 'import', client: null });
  assert.equal(imported.status, 'completed'); assert.equal(imported.cachedDays, 2); assert.equal(imported.downloadedDays, 0); assert.equal(f.queries.length, 2);
});
test('valuation resume skips only dates returned by API-specific store query', async t => {
  const f = await fixture(t); f.store.getCompletedDays = async options => { assert.equal(options.apiName, 'daily_basic'); return new Set([END]); };
  const result = await syncValuations(f); assert.equal(result.skippedDays, 1); assert.deepEqual(f.queries.map(q => q.params.trade_date), [START]); assert.equal(result.days[0].status, 'database_completed');
});
test('empty open day is never cached or marked completed; other valid day can succeed', async t => {
  const f = await fixture(t); f.client.queryAll = async (_, params) => params.trade_date === END ? [] : [row(params.trade_date)];
  const result = await syncValuations(f); assert.equal(result.status, 'incomplete'); assert.equal(result.completedDays, 1); assert.equal(f.failed.length, 1); assert.equal(f.saved.length, 1);
  assert.deepEqual(result.failedDates, [{ date: END, kind: 'validation' }]);
  await assert.rejects(readFile(join(f.cacheDir, 'valuations', 'A', `${END}.json.gz`)), { code: 'ENOENT' });
});
test('permission/rate/auth/database errors stop market and persist only fixed classifications', async t => {
  for (const kind of ['permission', 'rate_limit', 'authentication', 'database']) {
    const f = await fixture(t); let calls = 0;
    if (kind === 'database') f.store.saveDay = async () => { throw Object.assign(new Error('password secret'), { code: 'DATABASE_ERROR' }); };
    else f.client.queryAll = async () => { calls++; throw Object.assign(new Error('token=secret'), { kind }); };
    const result = await syncValuations(f); assert.equal(result.status, 'incomplete'); assert.equal(result.blockedBy, kind); assert.equal(result.completedDays, 0); assert.equal(result.failedDates.length, 1); if (kind !== 'database') assert.equal(calls, 1);
    const status = await readFile(join(f.cacheDir, 'valuations', 'A', `status-${START}-${END}-sync.json`), 'utf8'); assert.doesNotMatch(status, /secret|password/);
  }
});
test('wrong cache source and missing field cannot be imported as complete', async t => {
  const f = await fixture(t, [END]); const directory = join(f.cacheDir, 'valuations', 'A'); await mkdir(directory, { recursive: true });
  const cached = { version: 1, source: 'tushare', market: 'A', apiName: 'daily', tradeDate: END, rows: [row(END)] };
  await writeFile(join(directory, `${END}.json.gz`), gzipSync(JSON.stringify(cached)));
  const wrong = await syncValuations({ ...f, mode: 'import', client: null }); assert.equal(wrong.status, 'incomplete'); assert.equal(f.saved.length, 0);
  cached.apiName = 'daily_basic'; delete cached.rows[0].pb;
  await writeFile(join(directory, `${END}.json.gz`), gzipSync(JSON.stringify(cached)));
  const missing = await syncValuations({ ...f, mode: 'import', client: null }); assert.equal(missing.status, 'incomplete'); assert.equal(f.saved.length, 0);
});
test('failure after successful download leaves a cache that can be imported on retry', async t => {
  const f = await fixture(t, [END]); const originalSave = f.store.saveDay;
  f.store.saveDay = async () => { throw Object.assign(new Error('secret'), { code: 'DATABASE_ERROR' }); };
  assert.equal((await syncValuations(f)).status, 'incomplete'); assert.equal(f.queries.length, 1);
  f.store.saveDay = originalSave;
  const retried = await syncValuations({ ...f, mode: 'import', client: null }); assert.equal(retried.status, 'completed'); assert.equal(retried.cachedDays, 1); assert.equal(f.saved.length, 1);
});
test('when no shared calendar exists, collector calls only A-share trade_cal and daily_basic', async t => {
  const f = await fixture(t); await rm(join(f.cacheDir, 'A', `calendar-${START}-${END}.json`));
  f.client.query = async (api, params) => { assert.equal(api, 'trade_cal'); assert.equal(params.exchange, 'SSE'); return [{ cal_date: END, is_open: 1 }]; };
  assert.equal((await syncValuations(f)).status, 'completed'); assert.equal(f.queries[0].api, 'daily_basic');
});
