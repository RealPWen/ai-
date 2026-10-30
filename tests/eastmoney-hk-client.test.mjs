import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEastmoneyHkClient } from '../backend/market-data/eastmoney-hk-client.mjs';
import { createMarketStore } from '../backend/market-data/postgres-store.mjs';

const range = { ticker: '02020.HK', startDate: '20251019', endDate: '20261018' };
const line = (date = '2026-10-16', values = {}) => {
  const fields = { date, open: '84.20', close: '84.10', high: '84.90', low: '83.70', vol: '1234567', amount: '103828824.70',
    amplitude: '1.42', pctChg: '-0.71', change: '-0.60', turnover: '0.16', ...values };
  return Object.values(fields).join(',');
};
const body = (changes = {}) => ({ rc: 0, data: { code: '02020', market: 116, name: '安踏体育', dktotal: 4731, preKPrice: 84.7,
  klines: [line()], ...changes } });
const response = value => ({ status: 200, async json() { return value; } });
const collector = (value = body()) => createEastmoneyHkClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async () => response(value) });

test('Eastmoney HK collector requests unadjusted daily data and retains raw provider values and units', async () => {
  let requested;
  const upstream = body();
  const client = createEastmoneyHkClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async (url, options) => {
    requested = new URL(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); return response(upstream);
  } });
  const result = await client.collectDaily({ ...range, client: { queryAll() { throw new Error('must not use Tushare'); } } });
  assert.equal(requested.origin, 'https://push2his.eastmoney.com'); assert.equal(requested.searchParams.get('secid'), '116.02020');
  assert.equal(requested.searchParams.get('klt'), '101'); assert.equal(requested.searchParams.get('fqt'), '0');
  assert.equal(requested.searchParams.get('beg'), range.startDate); assert.equal(requested.searchParams.get('end'), range.endDate);
  assert.equal(requested.searchParams.get('fields2'), 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61');
  assert.equal(result.source, 'eastmoney'); assert.equal(result.apiName, 'eastmoney_hk_daily'); assert.equal(result.adjustment, 'none');
  assert.deepEqual([result.volumeUnit, result.amountUnit, result.currency], ['share', 'hkd', 'HKD']);
  assert.deepEqual(result.rows, [{ ts_code: '02020.HK', trade_date: '20261016', open: '84.20', high: '84.90', low: '83.70', close: '84.10',
    change: '-0.60', pct_chg: '-0.71', vol: '1234567', amount: '103828824.70', pre_close: '84.7' }]);
  assert.deepEqual(result.raw.response, upstream); assert.equal(result.raw.derivations.pre_close, 'close_minus_change_decimal');
  assert.equal(result.raw.derivations.pct_chg, 'provider');
});

test('decimal previous close derivation is exact and HK auction OHLC outliers are preserved', async () => {
  const result = await collector(body({ klines: [
    line('2026-10-16', { close: '0.3', change: '0.1', high: '0.29', open: '0.31', low: '0.28', pctChg: '77.77' }),
    line('2026-10-15', { close: '10', change: '-0.0001' }),
  ] })).collectDaily(range);
  assert.deepEqual(result.rows.map(row => row.trade_date), ['20261015', '20261016']);
  assert.equal(result.rows[0].pre_close, '10.0001'); assert.equal(result.rows[1].pre_close, '0.2');
  assert.equal(result.rows[1].pct_chg, '77.77'); assert.equal(result.rows[1].high, '0.29');
});

test('invalid identity, malformed dates, duplicate keys and invalid numbers reject complete responses', async () => {
  for (const value of [
    { rc: -1, data: body().data }, body({ code: '00700' }), body({ market: 128 }), body({ name: '' }),
    body({ dktotal: 0 }), body({ klines: ['bad'] }), body({ klines: [line('2026-02-30')] }),
    body({ klines: [line('2025-10-18')] }), body({ klines: [line(), line()] }),
    body({ klines: [line('2026-10-16', { close: 'NaN' })] }),
    body({ klines: [line('2026-10-16', { amount: 'Infinity' })] }),
    body({ klines: [line('2026-10-16', { open: '-1' })] }),
    body({ klines: [line('2026-10-16', { vol: '1.5' })] }),
    body({ klines: [line('2026-10-16', { pctChg: '-' })] }),
    body({ klines: [line('2026-10-16', { close: '1', change: '2' })] }),
  ]) await assert.rejects(collector(value).collectDaily(range), { kind: 'invalid_response' });
});

test('null or empty provider data is a clear no-data failure and invalid requests never call fetch', async () => {
  for (const value of [{ rc: 0, data: null }, body({ klines: [] })]) await assert.rejects(collector(value).collectDaily(range), { kind: 'no_data' });
  let calls = 0; const client = createEastmoneyHkClient({ fetchImpl: async () => { calls++; return response(body()); } });
  for (const changes of [{ ticker: '2020.HK' }, { ticker: '02020.SH' }, { startDate: '20260230' }, { startDate: '20261019' }, { startDate: '19000101' }]) await assert.rejects(client.collectDaily({ ...range, ...changes }), { kind: 'configuration' });
  assert.equal(calls, 0);
});

test('requests are serialized and throttled, while retryable network failures retry the same provider', async () => {
  let clock = 0, calls = 0; const pauses = [], starts = [];
  const client = createEastmoneyHkClient({ intervalMs: 800, maxRetries: 1, retryBaseMs: 100, now: () => clock,
    sleep: async ms => { pauses.push(ms); clock += ms; }, fetchImpl: async () => {
      starts.push(clock); calls++; if (calls === 1) throw new Error('raw secret exception'); return response(body());
    } });
  await Promise.all([client.collectDaily(range), client.collectDaily(range)]);
  assert.deepEqual(starts, [0, 800, 1600]); assert.deepEqual(pauses, [100, 700, 800]);
});

test('rate-limited and server errors back off; invalid responses do not retry or leak upstream text', async () => {
  for (const status of [429, 503]) {
    let calls = 0; const client = createEastmoneyHkClient({ intervalMs: 0, maxRetries: 1, sleep: async () => {}, fetchImpl: async () => ++calls === 1 ? { status } : response(body()) });
    assert.equal((await client.collectDaily(range)).rows.length, 1); assert.equal(calls, 2);
  }
  let calls = 0; const client = createEastmoneyHkClient({ intervalMs: 0, maxRetries: 2, fetchImpl: async () => { calls++; return response({ rc: -1, error: 'token=secret' }); } });
  await assert.rejects(client.collectDaily(range), error => { assert.equal(error.kind, 'invalid_response'); assert.doesNotMatch(error.message, /secret/); return true; });
  assert.equal(calls, 1);
});

test('fetch aborts on timeout and a failed queued request does not block later requests', async () => {
  let calls = 0;
  const client = createEastmoneyHkClient({ intervalMs: 0, timeoutMs: 5, maxRetries: 0, fetchImpl: async (_, { signal }) => {
    if (++calls > 1) return response(body());
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('raw upstream timeout'))));
  } });
  await assert.rejects(client.collectDaily(range), { kind: 'timeout' }); assert.equal((await client.collectDaily(range)).rows.length, 1);
});

function poolMock() {
  const calls = [];
  const pool = { calls, async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; }, async connect() { return { query: pool.query.bind(pool), release() {} }; }, async end() {} };
  return pool;
}

test('market store preserves explicit Eastmoney HK provenance and keeps Tushare default behavior', async () => {
  const pool = poolMock(), store = createMarketStore({ pool }), rows = (await collector().collectDaily(range)).rows;
  await store.saveDay({ market: 'HK', apiName: 'eastmoney_hk_daily', source: 'eastmoney', tradeDate: '20261016', rows });
  const values = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.daily_prices')).values;
  assert.deepEqual(values.slice(12), ['eastmoney', 'eastmoney_hk_daily', 'none', 'share', 'hkd', 'HKD']);
  const before = pool.calls.length;
  for (const changes of [
    { market: 'A' }, { apiName: 'hk_daily' }, { source: 'unknown' }, { source: 'tushare' },
  ]) await assert.rejects(store.saveDay({ market: 'HK', apiName: 'eastmoney_hk_daily', source: 'eastmoney', tradeDate: '20261016', rows, ...changes }), { code: 'VALIDATION_ERROR' });
  assert.equal(pool.calls.length, before);
  await store.saveDay({ market: 'HK', apiName: 'hk_daily', tradeDate: '20261016', rows });
  assert.equal(pool.calls.filter(call => call.sql.startsWith('INSERT INTO market_data.daily_prices')).at(-1).values[12], 'tushare');
});

test('schema upgrades the old check idempotently and limits Eastmoney data to its HK daily endpoint', async () => {
  const schema = await readFile(new URL('../backend/market-data/schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /DROP CONSTRAINT IF EXISTS daily_prices_source_check/);
  assert.match(schema, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint[\s\S]*daily_prices_source_provider_check/);
  assert.match(schema, /source = 'eastmoney' AND market = 'HK' AND source_api = 'eastmoney_hk_daily'/);
  assert.doesNotMatch(schema, /\b(?:TRUNCATE|DELETE)\b|DROP\s+(?:TABLE|SCHEMA)/);
});
