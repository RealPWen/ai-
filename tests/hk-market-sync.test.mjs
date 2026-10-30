import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { updateRollingHongKongMarket } from '../backend/market-data/hk-market-sync.mjs';
import { missingHkPoolRanges } from '../backend/market-data/hk-pool-store.mjs';
import { createTencentHkClient } from '../backend/market-data/tencent-hk-client.mjs';

const runDate = '2026-10-19', annualStart = '20251019', annualEnd = '20261018', bufferedStart = '20250919';
const catalog = (tickers = ['00001.HK', '00700.HK']) => ({ complete: true, asOf: runDate, source: 'hkex', apiName: 'hkex_listed_companies',
  universeHash: createHash('sha256').update([...tickers].sort().join('\n')).digest('hex'),
  securities: tickers.map(ticker => ({ ticker, name: ticker, currency: ticker === '00770.HK' ? 'USD' : 'HKD', listDate: '2000-01-01' })) });
const row = (ticker, trade_date = '20261016') => ({ ts_code: ticker, trade_date, open: '10', high: '11', low: '9', close: '10.5',
  pre_close: '10', change: '0.5', pct_chg: '5', vol: '100', amount: null });
const value = (options, rows = [row(options.ticker)]) => ({ rows, source: 'tencent', apiName: 'tencent_hk_daily', adjustment: 'none',
  currency: options.currency ?? 'HKD', volumeUnit: 'share', amountUnit: (options.currency ?? 'HKD').toLowerCase(),
  raw: { sourceEmpty: !rows.length, adjustment: 'none', units: { currency: options.currency ?? 'HKD', volume: 'share', amount: (options.currency ?? 'HKD').toLowerCase() } } });
function ledger() {
  const calls = [], ranges = new Map(), attempts = new Map(), runs = new Map();
  let inMethod = 0, maxInMethod = 0;
  const method = (name, action) => async options => {
    inMethod++; maxInMethod = Math.max(maxInMethod, inMethod);
    try { calls.push([name, options]); await Promise.resolve(); return await action(options); } finally { inMethod--; }
  };
  const scope = {
    getRun: method('getRun', options => runs.get(options.runDate)),
    beginRun: method('beginRun', options => runs.set(options.runDate, { status: 'running' })),
    getRanges: method('getRanges', options => ranges.get(options.ticker) ?? []),
    getSymbolAttempt: method('getSymbolAttempt', options => attempts.get(options.ticker)),
    confirmSymbol: method('confirmSymbol', options => attempts.set(options.ticker, { status: 'completed', universeHash: options.universeHash })),
    markSymbol: method('markSymbol', options => attempts.set(options.ticker, { status: options.status })),
    saveSymbol: method('saveSymbol', options => {
      const startDate = options.requestedStartDate < options.windowStart ? options.windowStart : options.requestedStartDate;
      const list = [...(ranges.get(options.ticker) ?? []), { startDate, endDate: options.requestedEndDate }];
      ranges.set(options.ticker, list);
      return { rowsCount: options.rows.length, deleted: 0, complete: !missingHkPoolRanges(list, options.windowStart, options.windowEnd).length };
    }),
    finishRun: method('finishRun', options => runs.set(options.runDate, { status: options.status })),
  };
  return { calls, ranges, attempts, runs, get maxInMethod() { return maxInMethod; },
    migrate: async () => calls.push(['migrate']), upsertCatalog: async options => calls.push(['upsertCatalog', options]),
    withLock: async operation => operation(scope) };
}
async function fixture(t, extra = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'hk-market-sync-')); t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const requests = [];
  return { runDate, catalog: catalog(), store: ledger(), cacheDir, intervalMs: 0, concurrency: 1,
    collector: async options => { requests.push(options); return value(options); }, requests, ...extra };
}
const saves = options => options.store.calls.filter(call => call[0] === 'saveSymbol').map(call => call[1]);
const cachePath = (options, ticker = '00001.HK', start = bufferedStart, end = annualEnd) => join(options.cacheDir, 'hk-market', 'tencent', ticker, `${start}-${end}.json.gz`);
const calendar = (start, end, closed = []) => {
  const rows = [];
  for (let date = Date.parse(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6)}T00:00:00Z`);
    date <= Date.parse(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6)}T00:00:00Z`); date += 86400000) {
    const current = new Date(date), cal_date = current.toISOString().slice(0, 10).replaceAll('-', '');
    rows.push({ cal_date, is_open: [0, 6].includes(current.getUTCDay()) || closed.includes(cal_date) ? 0 : 1 });
  }
  return rows;
};

test('full HK initial import requests one annual window plus 30-day baseline buffer and retains honest cache semantics', async t => {
  const options = await fixture(t, { catalog: catalog(['00770.HK']) });
  const result = await updateRollingHongKongMarket(options);
  assert.equal(result.status, 'succeeded'); assert.equal(result.priceScope, 'all');
  assert.equal(result.windowStart, annualStart); assert.equal(result.windowEnd, annualEnd);
  assert.deepEqual(options.requests, [{ ticker: '00770.HK', startDate: bufferedStart, endDate: annualEnd, allowEmpty: true, currency: 'USD' }]);
  assert.equal(saves(options)[0].currency, 'USD'); assert.equal(saves(options)[0].requestedStartDate, bufferedStart);
  const cached = JSON.parse(gunzipSync(await readFile(cachePath(options, '00770.HK'))));
  assert.equal(cached.currency, 'USD'); assert.equal(cached.amountUnit, 'usd'); assert.equal(cached.adjustment, 'none');
  assert.equal(cached.raw.units.currency, 'USD'); assert.equal(result.summary.priceHistoryExtraTradingDays, 1);
});

test('no-data never saves or deletes that company and later companies continue; retry is explicit and cached empty is refetched', async t => {
  const options = await fixture(t);
  let empty = true;
  options.collector = async request => { options.requests.push(request); return value(request, request.ticker === '00001.HK' && empty ? [] : [row(request.ticker)]); };
  const first = await updateRollingHongKongMarket(options);
  assert.equal(first.status, 'partial'); assert.equal(first.summary.noDataTickers, 1); assert.equal(first.summary.completedTickers, 1);
  assert.deepEqual(saves(options).map(saved => saved.ticker), ['00700.HK']);
  assert.equal(options.store.ranges.has('00001.HK'), false); assert.equal(first.summary.deleted, 0);
  const count = options.requests.length;
  await updateRollingHongKongMarket(options); assert.equal(options.requests.length, count);
  empty = false;
  const retry = await updateRollingHongKongMarket({ ...options, retryNoData: true });
  assert.equal(retry.status, 'succeeded'); assert.equal(options.requests.length, count + 1);
  assert.equal(options.requests.at(-1).ticker, '00001.HK');
});

test('explicit no-data retry refetches a nonempty cache that contains only the preceding baseline', async t => {
  const options = await fixture(t, { catalog: catalog(['00001.HK']) });
  let priorOnly = true;
  options.collector = async request => { options.requests.push(request); return value(request, [row(request.ticker, priorOnly ? '20251017' : '20261016')]); };
  const initial = await updateRollingHongKongMarket(options);
  assert.equal(initial.summary.noDataTickers, 1); assert.equal(saves(options).length, 0);
  priorOnly = false;
  const result = await updateRollingHongKongMarket({ ...options, retryNoData: true });
  assert.equal(result.status, 'succeeded'); assert.equal(options.requests.length, 2); assert.equal(saves(options).length, 1);
});

test('resume reuses source-specific saved ranges and downloads only a missing trading date, across catalog membership changes', async t => {
  const options = await fixture(t, { catalog: catalog(['00001.HK']) });
  options.store.ranges.set('00001.HK', [{ startDate: annualStart, endDate: '20261014' }, { startDate: '20261016', endDate: annualEnd }]);
  options.collector = async request => { options.requests.push(request); return value(request, [row(request.ticker, '20261015')]); };
  const result = await updateRollingHongKongMarket(options);
  assert.equal(result.status, 'succeeded'); assert.deepEqual(options.requests.map(({ startDate, endDate }) => ({ startDate, endDate })), [{ startDate: '20261015', endDate: '20261015' }]);
  const expanded = { ...options, catalog: catalog(['00001.HK', '00700.HK']), collector: async request => { options.requests.push(request); return value(request); } };
  const second = await updateRollingHongKongMarket(expanded);
  assert.equal(second.status, 'succeeded'); assert.equal(second.summary.skippedTickers, 1); assert.equal(options.requests.at(-1).ticker, '00700.HK');
  assert.equal(options.store.attempts.get('00001.HK').universeHash, expanded.catalog.universeHash);
  const confirmed = options.store.calls.filter(call => call[0] === 'confirmSymbol').at(-1)[1];
  assert.equal(confirmed.ticker, '00001.HK'); assert.equal(confirmed.currency, 'HKD');
});

test('weekend gaps close with explicit proof and no request; complete verified holiday calendar allows weekday closure', async t => {
  const options = await fixture(t, { catalog: catalog(['00001.HK']) });
  options.store.ranges.set('00001.HK', [{ startDate: annualStart, endDate: '20261016' }]);
  const weekend = await updateRollingHongKongMarket(options);
  assert.equal(weekend.status, 'succeeded'); assert.equal(options.requests.length, 0); assert.equal(saves(options)[0].emptyProof, 'weekends');
  const holiday = await fixture(t, { runDate: '2026-10-20', catalog: { ...catalog(['00001.HK']), asOf: '2026-10-20' },
    client: { query: async () => calendar('20251020', '20261019', ['20261019']) } });
  holiday.store.ranges.set('00001.HK', [{ startDate: '20251020', endDate: '20261016' }]);
  const result = await updateRollingHongKongMarket(holiday);
  assert.equal(result.status, 'succeeded'); assert.equal(holiday.requests.length, 0);
  assert.equal(saves(holiday)[0].emptyProof, 'hk_tradecal'); assert.equal(saves(holiday)[0].calendarRows.length, 3);
});

test('an incomplete or open-day calendar cannot turn an empty weekday response into coverage', async t => {
  for (const rows of [[{ cal_date: '20261019', is_open: 0 }], calendar('20251020', '20261019')]) {
    const options = await fixture(t, { runDate: '2026-10-20', catalog: { ...catalog(['00001.HK']), asOf: '2026-10-20' }, client: { query: async () => rows } });
    options.store.ranges.set('00001.HK', [{ startDate: '20251020', endDate: '20261018' }]);
    options.collector = async request => value(request, []);
    const result = await updateRollingHongKongMarket(options);
    assert.equal(result.status, 'failed'); assert.equal(result.summary.noDataTickers, 1); assert.equal(saves(options).length, 0);
  }
});

test('rate limiting stops new security work, stores a safe failure and never emits raw provider details', async t => {
  const logs = [], options = await fixture(t, { log: entry => logs.push(entry) });
  options.collector = async request => { options.requests.push(request); throw Object.assign(new Error('raw-token-secret'), { kind: 'rate_limit' }); };
  const result = await updateRollingHongKongMarket(options);
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'rate_limited'); assert.equal(options.requests.length, 1);
  assert.equal(saves(options).length, 0); assert.doesNotMatch(JSON.stringify([result, logs]), /raw-token-secret/);
});

test('cache identity, row identity, currency, source units and adjustment are validated before database writes', async t => {
  for (const mutate of [cache => { cache.ticker = '00700.HK'; }, cache => { cache.source = 'yahoo'; }, cache => { cache.currency = 'USD'; },
    cache => { cache.amountUnit = 'usd'; }, cache => { cache.adjustment = 'qfq'; }, cache => { cache.raw.units.amount = 'usd'; }, cache => { cache.rows[0].ts_code = '00700.HK'; }]) {
    const options = await fixture(t, { catalog: catalog(['00001.HK']) });
    assert.equal((await updateRollingHongKongMarket(options)).status, 'succeeded');
    const path = cachePath(options), cached = JSON.parse(gunzipSync(await readFile(path))); mutate(cached);
    await writeFile(path, gzipSync(JSON.stringify(cached))); options.store.ranges.clear(); options.store.calls.length = 0;
    options.collector = async () => { throw new Error('bad cache must not trigger another request'); };
    const result = await updateRollingHongKongMarket(options);
    assert.equal(result.status, 'failed'); assert.equal(saves(options).length, 0);
    assert.ok(options.store.calls.some(call => call[0] === 'markSymbol' && call[1].errorCode === 'validation_error'));
  }
});

test('legacy live-backfill cache is reusable only with matching explicit raw units and adjustment', async t => {
  const options = await fixture(t, { catalog: catalog(['00001.HK']) });
  await updateRollingHongKongMarket(options); const path = cachePath(options);
  const cached = JSON.parse(gunzipSync(await readFile(path)));
  for (const key of ['adjustment', 'volumeUnit', 'amountUnit', 'currency']) delete cached[key];
  await writeFile(path, gzipSync(JSON.stringify(cached))); options.store.ranges.clear();
  options.collector = async () => { throw new Error('valid legacy cache should be reused'); };
  const result = await updateRollingHongKongMarket(options);
  assert.equal(result.status, 'succeeded'); assert.equal(result.summary.cachedRanges, 1);
  cached.raw.units.amount = 'usd'; await writeFile(path, gzipSync(JSON.stringify(cached))); options.store.ranges.clear(); options.store.calls.length = 0;
  const bad = await updateRollingHongKongMarket(options); assert.equal(bad.status, 'failed'); assert.equal(saves(options).length, 0);
});

test('live provider source, currency and units are rejected before caching or saving', async t => {
  for (const bad of [{ source: 'yahoo' }, { currency: 'CNY' }, { volumeUnit: 'lot' }, { amountUnit: 'usd' }, { adjustment: 'qfq' }]) {
    const options = await fixture(t, { catalog: catalog(['00001.HK']) }); options.collector = async request => ({ ...value(request), ...bad });
    const result = await updateRollingHongKongMarket(options); assert.equal(result.status, 'failed'); assert.equal(saves(options).length, 0);
    await assert.rejects(readFile(cachePath(options)), { code: 'ENOENT' });
  }
});

test('bounded workers overlap transport with a shared start interval while all database methods remain serial', async t => {
  const starts = [], options = await fixture(t, { catalog: catalog(['00001.HK', '00700.HK', '00005.HK', '00941.HK']), concurrency: 3, intervalMs: 20 });
  let active = 0, maximum = 0;
  options.collector = async request => {
    starts.push(Date.now()); active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setTimeout(resolve, 55)); return value(request); } finally { active--; }
  };
  const result = await updateRollingHongKongMarket(options);
  assert.equal(result.status, 'succeeded'); assert.equal(starts.length, 4); assert.ok(maximum > 1 && maximum <= 3);
  assert.ok(starts.slice(1).every((start, index) => start - starts[index] >= 19));
  assert.equal(options.store.maxInMethod, 1);
});

test('Tencent allowEmpty records source emptiness without weakening ticker, raw-day or numerical validation', async () => {
  const body = day => ({ code: 0, data: { hk00001: { qt: { hk00001: ['100', '长和', '00001'] }, day } } });
  const client = payload => createTencentHkClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async () => ({ status: 200, json: async () => payload }) });
  const options = { ticker: '00001.HK', startDate: '20261014', endDate: '20261016' };
  await assert.rejects(client(body([])).collectDaily(options), { kind: 'no_data' });
  const empty = await client(body([])).collectDaily({ ...options, allowEmpty: true });
  assert.deepEqual(empty.rows, []); assert.equal(empty.raw.sourceEmpty, true); assert.equal(empty.currency, 'HKD');
  for (const invalid of [body(undefined), body([['2026-10-14', 1, 'bad', 1, 1, 1]]), { code: 0, data: {} }]) {
    await assert.rejects(client(invalid).collectDaily({ ...options, allowEmpty: true }), { kind: 'invalid_response' });
  }
  await assert.rejects(client(body([])).collectDaily({ ...options, allowEmpty: 'true' }), { kind: 'configuration' });
});
