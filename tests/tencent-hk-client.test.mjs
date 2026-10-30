import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTencentHkClient } from '../backend/market-data/tencent-hk-client.mjs';
import { createMarketStore } from '../backend/market-data/postgres-store.mjs';

const range = { ticker: '02020.HK', startDate: '20261014', endDate: '20261016' };
const body = (changes = {}) => ({ code: 0, data: { hk02020: { qt: { hk02020: ['100', '安踏体育', '02020'] },
  day: [['2026-10-13', '50.000', '50.000', '51.000', '49.000', '123.000'],
    ['2026-10-14', '50.000', '51.000', '52.000', '49.500', '456.000', ''],
    ['2026-10-16', '51.000', '52.000', '53.000', '50.000', '789.000']],
  qfqday: [['2026-10-14', '1', '2', '3', '1', '456']], ...changes } } });
const response = value => ({ status: 200, async json() { return value; } });
const collector = value => createTencentHkClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async () => response(value ?? body()) });

test('Tencent requests only the raw day endpoint with ten-day previous-close padding and preserves raw values', async () => {
  let requested; const upstream = body();
  const client = createTencentHkClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async (url, options) => {
    requested = new URL(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); return response(upstream);
  } });
  const result = await client.collectDaily(range);
  assert.equal(requested.origin, 'https://web.ifzq.gtimg.cn'); assert.equal(requested.pathname, '/appstock/app/kline/kline');
  assert.equal(requested.searchParams.get('param'), 'hk02020,day,2026-10-04,2026-10-16,640,');
  assert.equal(result.source, 'tencent'); assert.equal(result.apiName, 'tencent_hk_daily'); assert.equal(result.adjustment, 'none');
  assert.deepEqual([result.volumeUnit, result.amountUnit, result.currency], ['share', 'hkd', 'HKD']);
  assert.deepEqual(result.rows.map(row => [row.trade_date, row.close, row.pre_close, row.change, row.pct_chg, row.vol, row.amount]),
    [['20261014', '51.000', '50.000', 1, 2, '456.000', null], ['20261016', '52.000', '51.000', 1, 1 / 51 * 100, '789.000', null]]);
  assert.deepEqual(result.raw.response, upstream); assert.equal(result.raw.derivations.pre_close, 'previous_non_null_day_close');
  assert.equal(result.raw.derivations.ohlc, 'raw_day_without_fq'); assert.equal(result.raw.derivations.amount, 'unavailable_null');
});

test('Tencent preserves finite number prices and HK auction outliers without substituting adjusted-day values', async () => {
  const result = await collector(body({ day: [['2026-10-14', 0.30000000001, 0.3, 0.29, 0.28, 12345]] })).collectDaily(range);
  assert.equal(result.rows[0].open, 0.30000000001); assert.equal(result.rows[0].high, 0.29); assert.equal(result.rows[0].close, 0.3);
  assert.equal(result.rows[0].pre_close, null); assert.equal(result.rows[0].change, null); assert.equal(result.rows[0].pct_chg, null);
  await assert.rejects(collector(body({ day: undefined })).collectDaily(range), { kind: 'invalid_response' });
});

test('Tencent null-close rows stay in raw audit and do not replace the prior valid close', async () => {
  const upstream = body(); upstream.data.hk02020.day[1][2] = null;
  const result = await collector(upstream).collectDaily(range);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].pre_close, '50.000'); assert.equal(result.rows[0].change, 2);
  assert.equal(result.raw.skippedNullCloseBars, 1); assert.equal(result.raw.response.data.hk02020.day.length, 3);
});

test('Tencent validates identity, unique dates, request bounds and numeric prices or volumes', async () => {
  for (const upstream of [
    { code: -1, msg: 'raw upstream secret' }, body({ qt: { hk02020: ['51', 'wrong market', '02020'] } }),
    body({ qt: { hk02020: ['100', '安踏体育', '00700'] } }), body({ day: [['2026-02-30', 1, 1, 1, 1, 1]] }),
    body({ day: [['2026-10-03', 1, 1, 1, 1, 1]] }), body({ day: [['2026-10-17', 1, 1, 1, 1, 1]] }),
    body({ day: [body().data.hk02020.day[1], body().data.hk02020.day[1]] }),
    body({ day: [['2026-10-14', '-1', '1', '1', '1', '1']] }),
    body({ day: [['2026-10-14', '1', 'NaN', '1', '1', '1']] }),
    body({ day: [['2026-10-14', '1', '1', '1', '1', '1.5']] }),
  ]) await assert.rejects(collector(upstream).collectDaily(range), error => {
    assert.equal(error.kind, 'invalid_response'); assert.doesNotMatch(error.message, /secret/); return true;
  });
  await assert.rejects(collector(body({ day: [] })).collectDaily(range), { kind: 'no_data' });
});

test('Tencent allows up to 400 logical calendar days with padding below its 640-bar cap and rejects larger requests before fetch', async () => {
  let calls = 0; const client = createTencentHkClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async () => { calls++; return response(body({ day: [['2024-02-29', 1, 1, 1, 1, 1]] })); } });
  assert.equal((await client.collectDaily({ ...range, startDate: '20230301', endDate: '20240229' })).rows.length, 1);
  assert.equal((await client.collectDaily({ ...range, startDate: '20230126', endDate: '20240229' })).rows.length, 1);
  for (const changes of [{ ticker: '2020.HK' }, { ticker: '02020.SH' }, { startDate: '20230125', endDate: '20240229' },
    { startDate: '20261017' }, { startDate: '20260230' }]) await assert.rejects(client.collectDaily({ ...range, ...changes }), { kind: 'configuration' });
  assert.equal(calls, 2);
});

test('Tencent audits identity-verified empty history only with explicit opt-in and checks USD counter currency', async () => {
  const empty = body({ day: [] });
  await assert.rejects(collector(empty).collectDaily(range), { kind: 'no_data' });
  const result = await collector(empty).collectDaily({ ...range, allowEmpty: true });
  assert.deepEqual(result.rows, []); assert.equal(result.raw.sourceEmpty, true);
  assert.deepEqual(result.raw.response, empty);
  await assert.rejects(collector(body({ day: undefined })).collectDaily({ ...range, allowEmpty: true }), { kind: 'invalid_response' });
  await assert.rejects(collector(body()).collectDaily({ ...range, currency: 'USD' }), { kind: 'invalid_response' });
  const usd = body(); usd.data.hk02020.qt.hk02020[75] = 'USD';
  await assert.rejects(collector(usd).collectDaily(range), { kind: 'invalid_response' });
  const prices = await collector(usd).collectDaily({ ...range, currency: 'USD' });
  assert.equal(prices.currency, 'USD'); assert.equal(prices.amountUnit, 'usd'); assert.equal(prices.rows[0].amount, null);
  assert.deepEqual(prices.raw.units, { volume: 'share', amount: 'usd', currency: 'USD' });
});

test('Tencent calls serialize at two-second intervals and retry only the same fixed host', async () => {
  let clock = 0, calls = 0; const starts = [], hosts = [];
  const client = createTencentHkClient({ intervalMs: 2000, maxRetries: 1, retryBaseMs: 1000, now: () => clock, sleep: async ms => { clock += ms; },
    fetchImpl: async url => { starts.push(clock); hosts.push(new URL(url).host); if (++calls === 1) return { status: 429 }; return response(body()); } });
  await Promise.all([client.collectDaily(range), client.collectDaily(range)]);
  assert.deepEqual(starts, [0, 2000, 4000]); assert.deepEqual(hosts, Array(3).fill('web.ifzq.gtimg.cn'));
});

test('Tencent timeout aborts fetch and invalid upstream responses do not trigger hidden retries', async () => {
  const client = createTencentHkClient({ intervalMs: 0, timeoutMs: 5, maxRetries: 0, fetchImpl: async (_, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('raw secret')))) });
  await assert.rejects(client.collectDaily(range), error => { assert.equal(error.kind, 'timeout'); assert.doesNotMatch(error.message, /secret/); return true; });
  let calls = 0; const invalid = createTencentHkClient({ intervalMs: 0, maxRetries: 1, fetchImpl: async () => { calls++; return response({ code: -1 }); } });
  await assert.rejects(invalid.collectDaily(range), { kind: 'invalid_response' }); assert.equal(calls, 1);
});

test('Tencent access denials are non-retryable fatal provider categories', async () => {
  for (const [status, kind] of [[401, 'authentication'], [403, 'permission']]) {
    let calls = 0;
    const client = createTencentHkClient({ intervalMs: 0, maxRetries: 1, fetchImpl: async () => { calls++; return { status }; } });
    await assert.rejects(client.collectDaily(range), { kind, retryable: false });
    assert.equal(calls, 1);
  }
});

test('market store and additive schema permit only explicit Tencent HK daily provenance', async () => {
  const calls = [], pool = { async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; }, async connect() { return { query: pool.query.bind(pool), release() {} }; }, async end() {} };
  const store = createMarketStore({ pool }), rows = (await collector().collectDaily(range)).rows.slice(0, 1);
  await store.saveDay({ market: 'HK', apiName: 'tencent_hk_daily', source: 'tencent', tradeDate: '20261014', rows });
  const values = calls.find(call => call.sql.startsWith('INSERT INTO market_data.daily_prices')).values;
  assert.equal(values[11], null); assert.deepEqual(values.slice(12), ['tencent', 'tencent_hk_daily', 'none', 'share', 'hkd', 'HKD']);
  const before = calls.length;
  for (const changes of [{ market: 'A' }, { apiName: 'hk_daily' }, { source: 'tushare' }, { source: 'yahoo' }]) await assert.rejects(store.saveDay({ market: 'HK', apiName: 'tencent_hk_daily', source: 'tencent', tradeDate: '20261014', rows, ...changes }), { code: 'VALIDATION_ERROR' });
  assert.equal(calls.length, before);
  const schema = await readFile(new URL('../backend/market-data/schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /source = 'tencent' AND market = 'HK' AND source_api = 'tencent_hk_daily'/);
  assert.match(schema, /position\('tencent_hk_daily' in pg_get_constraintdef\(oid\)\) = 0/);
});
