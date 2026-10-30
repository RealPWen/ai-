import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createYahooHkClient } from '../backend/market-data/yahoo-hk-client.mjs';
import { createMarketStore } from '../backend/market-data/postgres-store.mjs';

const range = { ticker: '03606.HK', startDate: '20261014', endDate: '20261016' };
const timestamp = date => Date.parse(`${date}T16:00:00+08:00`) / 1000;
const body = ({ meta = {}, timestamps = ['2026-10-13', '2026-10-14', '2026-10-16'].map(timestamp), quote = {} } = {}) => ({ chart: { error: null,
  result: [{ meta: { symbol: '3606.HK', exchangeName: 'HKG', currency: 'HKD', chartPreviousClose: 999, ...meta }, timestamp: timestamps,
    indicators: { quote: [{ open: [49.25, 50, 51], high: [51, 52, 53], low: [49, 49.5, 50], close: [50, 51, 52], volume: [10, 20, 30], ...quote }],
      adjclose: [{ adjclose: [1, 2, 3] }] } }] } });
const response = value => ({ status: 200, async json() { return value; } });
const collector = value => createYahooHkClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async () => response(value ?? body()) });

test('Yahoo HK requests the fixed host with ten-day previous-close and one-day trailing split detection padding', async () => {
  let requested;
  const upstream = body(), client = createYahooHkClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async (url, options) => {
    requested = new URL(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); return response(upstream);
  } });
  const result = await client.collectDaily(range);
  assert.equal(requested.origin, 'https://query2.finance.yahoo.com'); assert.equal(requested.pathname, '/v8/finance/chart/3606.HK');
  assert.equal(Number(requested.searchParams.get('period1')), Date.parse('2026-10-04T00:00:00+08:00') / 1000);
  assert.equal(Number(requested.searchParams.get('period2')), Date.parse('2026-10-18T00:00:00+08:00') / 1000);
  assert.equal(requested.searchParams.get('interval'), '1d'); assert.equal(requested.searchParams.get('includeAdjustedClose'), 'false');
  assert.equal(requested.searchParams.get('events'), 'splits');
  assert.equal(result.source, 'yahoo'); assert.equal(result.apiName, 'yahoo_hk_daily'); assert.equal(result.adjustment, 'none');
  assert.deepEqual([result.volumeUnit, result.amountUnit, result.currency], ['share', 'hkd', 'HKD']);
  assert.deepEqual(result.rows.map(row => [row.trade_date, row.close, row.pre_close, row.change, row.pct_chg, row.vol, row.amount]),
    [['20261014', 51, 50, 1, 2, 20, null], ['20261016', 52, 51, 1, 1 / 51 * 100, 30, null]]);
  assert.deepEqual(result.raw.response, upstream); assert.equal(result.raw.derivations.pre_close, 'previous_non_null_quote_close');
  assert.equal(result.raw.derivations.amount, 'unavailable_null');
});

test('HK symbols use a minimum four digits while preserving greater-than-four-digit listings', async () => {
  for (const [ticker, symbol] of [['00700.HK', '0700.HK'], ['00001.HK', '0001.HK'], ['10000.HK', '10000.HK']]) {
    const client = createYahooHkClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async url => {
      assert.equal(new URL(url).pathname, `/v8/finance/chart/${symbol}`); return response(body({ meta: { symbol } }));
    } });
    assert.equal((await client.collectDaily({ ...range, ticker })).rows[0].ts_code, ticker);
  }
});

test('original quote floats and HK date conversion are retained; adjusted close and quote metadata are ignored', async () => {
  const upstream = body({ timestamps: [Date.parse('2026-10-13T16:30:00Z') / 1000], quote: {
    open: [0.30000001192092896], high: [0.29], low: [0.28], close: [0.3], volume: [12345],
  } });
  const result = await collector(upstream).collectDaily(range), row = result.rows[0];
  assert.equal(row.trade_date, '20261014'); assert.equal(row.open, 0.30000001192092896); assert.equal(row.high, 0.29); assert.equal(row.close, 0.3);
  assert.equal(row.pre_close, null); assert.equal(row.change, null); assert.equal(row.pct_chg, null);
  assert.equal(result.raw.derivations.ohlc, 'original_quote_arrays_without_adjclose');
});

test('null-close dates remain in raw audit but do not replace the previous real closing quote', async () => {
  const result = await collector(body({ quote: { close: [50, null, 52] } })).collectDaily(range);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].pre_close, 50); assert.equal(result.rows[0].change, 2);
  assert.equal(result.rows[0].pct_chg, 4); assert.equal(result.raw.skippedNullCloseBars, 1);
});

test('the trailing day is checked for splits but its partial quote is excluded from the requested output', async () => {
  const upstream = body({ timestamps: ['2026-10-13', '2026-10-14', '2026-10-17'].map(timestamp) });
  const result = await collector(upstream).collectDaily(range);
  assert.deepEqual(result.rows.map(row => row.trade_date), ['20261014']);
  assert.equal(result.raw.request.splitDetectionTrailingCalendarDays, 1);
  upstream.chart.result[0].events = { splits: { [timestamp('2026-10-17')]: { date: timestamp('2026-10-17'), numerator: 2, denominator: 1 } } };
  await assert.rejects(collector(upstream).collectDaily(range), { kind: 'invalid_response' });
});

test('Yahoo windows containing stock splits cannot be mislabeled as unadjusted data', async () => {
  const upstream = body(); upstream.chart.result[0].events = { splits: { '1791975600': { date: 1791975600, numerator: 2, denominator: 1 } } };
  await assert.rejects(collector(upstream).collectDaily(range), error => {
    assert.equal(error.kind, 'invalid_response'); assert.match(error.message, /拆股/); return true;
  });
});

test('Yahoo identity, quote-array lengths, duplicate HK dates and numeric fields validate before publication', async () => {
  const duplicate = body({ timestamps: [timestamp('2026-10-14'), timestamp('2026-10-14') + 60, timestamp('2026-10-16')] });
  for (const upstream of [
    body({ meta: { symbol: '0700.HK' } }), body({ meta: { exchangeName: 'NMS' } }), body({ meta: { currency: 'CNY' } }),
    body({ quote: { open: [1] } }), duplicate,
    body({ timestamps: [timestamp('2026-10-03'), timestamp('2026-10-14'), timestamp('2026-10-16')] }),
    body({ timestamps: [timestamp('2026-10-13'), timestamp('2026-10-14'), timestamp('2026-10-18')] }),
    body({ quote: { close: [50, '51', 52] } }), body({ quote: { close: [50, NaN, 52] } }),
    body({ quote: { low: [49, -1, 50] } }), body({ quote: { volume: [10, 1.2, 30] } }),
  ]) await assert.rejects(collector(upstream).collectDaily(range), { kind: 'invalid_response' });
});

test('Yahoo missing chart data and ranges without real closing bars fail explicitly', async () => {
  for (const upstream of [{ chart: { error: null, result: null } }, body({ quote: { close: [50, null, null] } })]) await assert.rejects(collector(upstream).collectDaily(range), { kind: 'no_data' });
  await assert.rejects(collector({ chart: { error: { code: 'Not Found', description: 'raw upstream content' }, result: null } }).collectDaily(range), error => {
    assert.equal(error.kind, 'invalid_response'); assert.doesNotMatch(error.message, /raw upstream content/); return true;
  });
  let calls = 0; const client = createYahooHkClient({ fetchImpl: async () => { calls++; return response(body()); } });
  for (const changes of [{ ticker: '3606.HK' }, { ticker: '03606.SH' }, { startDate: '20260230' }, { startDate: '20261017' }]) await assert.rejects(client.collectDaily({ ...range, ...changes }), { kind: 'configuration' });
  assert.equal(calls, 0);
});

test('Yahoo requests serialize with a two-second interval and retry only the same host', async () => {
  let clock = 0, calls = 0; const starts = [], hosts = [];
  const client = createYahooHkClient({ intervalMs: 2000, maxRetries: 1, retryBaseMs: 1000, now: () => clock, sleep: async ms => { clock += ms; },
    fetchImpl: async url => { starts.push(clock); hosts.push(new URL(url).host); if (++calls === 1) return { status: 429 }; return response(body()); } });
  await Promise.all([client.collectDaily(range), client.collectDaily(range)]);
  assert.deepEqual(starts, [0, 2000, 4000]); assert.deepEqual(hosts, Array(3).fill('query2.finance.yahoo.com'));
});

test('Yahoo timeout aborts fetch and failure messages do not expose upstream details', async () => {
  const client = createYahooHkClient({ intervalMs: 0, timeoutMs: 5, maxRetries: 0, fetchImpl: async (_, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('raw secret')))) });
  await assert.rejects(client.collectDaily(range), error => { assert.equal(error.kind, 'timeout'); assert.doesNotMatch(error.message, /secret/); return true; });
});

test('range mode accepts a broad two-year source for a small logical gap and records the actual range request', async () => {
  let requested;
  const upstream = body({ timestamps: ['2024-10-17', '2026-10-14', '2026-10-16'].map(timestamp),
    meta: { firstTradeDate: timestamp('2015-03-31'), regularMarketTime: timestamp('2026-10-16') } });
  const client = createYahooHkClient({ queryMode: 'range', intervalMs: 0, maxRetries: 0, now: () => Date.parse('2026-10-19T10:00:00+08:00'),
    fetchImpl: async url => { requested = new URL(url); return response(upstream); } });
  const result = await client.collectDaily({ ...range, startDate: '20261016', endDate: '20261016' });
  assert.equal(requested.searchParams.get('range'), '2y'); assert.equal(requested.searchParams.has('period1'), false);
  assert.equal(requested.searchParams.has('period2'), false); assert.equal(result.raw.request.queryMode, 'range');
  assert.equal(result.raw.request.range, '2y'); assert.equal(Object.hasOwn(result.raw.request, 'period1'), false);
  assert.deepEqual(result.rows.map(row => row.trade_date), ['20261016']); assert.equal(result.rows[0].pre_close, 51);
});

test('range mode allows a leap-year retention buffer and rejects logic outside the buffered annual window', async () => {
  let calls = 0;
  const upstream = body({ timestamps: ['2023-02-28', '2023-03-01', '2024-02-29'].map(timestamp), meta: { regularMarketTime: timestamp('2024-02-29') } });
  const client = createYahooHkClient({ queryMode: 'range', intervalMs: 0, maxRetries: 0, now: () => Date.parse('2024-03-01T10:00:00+08:00'),
    fetchImpl: async () => { calls++; return response(upstream); } });
  const result = await client.collectDaily({ ...range, startDate: '20230301', endDate: '20240229' });
  assert.equal(result.rows.length, 2);
  for (const changes of [{ startDate: '20230129', endDate: '20240229' }, { startDate: '20230301', endDate: '20240302' }]) await assert.rejects(client.collectDaily({ ...range, ...changes }), { kind: 'configuration' });
  assert.equal(calls, 1);
});

test('two-year source covers the 30-day annual baseline buffer while named one-year sources fail before fetching', async () => {
  const logical = { ...range, startDate: '20250919', endDate: '20261018' }, requests = [];
  const upstream = body({ timestamps: ['2025-09-18', '2025-10-17', '2026-10-16'].map(timestamp),
    meta: { regularMarketTime: timestamp('2026-10-16') } });
  const options = { queryMode: 'range', intervalMs: 0, maxRetries: 0, now: () => Date.parse('2026-10-19T10:00:00+08:00'),
    fetchImpl: async url => { requests.push(new URL(url).searchParams.get('range')); return response(upstream); } };
  const result = await createYahooHkClient(options).collectDaily(logical);
  assert.deepEqual(result.rows.map(row => row.trade_date), ['20251017', '20261016']);
  assert.deepEqual(requests, ['2y']);
  await assert.rejects(createYahooHkClient({ ...options, rangePeriod: '1y' }).collectDaily(logical), { kind: 'configuration' });
  assert.deepEqual(requests, ['2y']);
});

test('range mode confirms initial coverage or a later IPO and accepts explicit one-year range selection', async () => {
  const options = { queryMode: 'range', rangePeriod: '1y', intervalMs: 0, maxRetries: 0, now: () => Date.parse('2026-10-19T10:00:00+08:00') };
  const logical = { ...range, startDate: '20251019', endDate: '20261018' };
  const complete = body({ timestamps: ['2025-10-16', '2026-10-14', '2026-10-16'].map(timestamp), meta: { regularMarketTime: timestamp('2026-10-16') } });
  const result = await createYahooHkClient({ ...options, fetchImpl: async url => { assert.equal(new URL(url).searchParams.get('range'), '1y'); return response(complete); } }).collectDaily(logical);
  assert.equal(result.rows.length, 2);
  const truncated = body({ meta: { firstTradeDate: timestamp('2015-03-31'), regularMarketTime: timestamp('2026-10-16') } });
  await assert.rejects(createYahooHkClient({ ...options, fetchImpl: async () => response(truncated) }).collectDaily(logical), { kind: 'invalid_response' });
  truncated.chart.result[0].meta.firstTradeDate = timestamp('2026-10-13');
  assert.equal((await createYahooHkClient({ ...options, fetchImpl: async () => response(truncated) }).collectDaily(logical)).rows.length, 3);
  truncated.chart.result[0].meta.firstTradeDate = timestamp('2025-10-20');
  await assert.rejects(createYahooHkClient({ ...options, fetchImpl: async () => response(truncated) }).collectDaily(logical), { kind: 'invalid_response' });
});

test('range mode rejects stale or implausibly broad source data rather than marking it complete', async () => {
  const options = { queryMode: 'range', intervalMs: 0, maxRetries: 0, now: () => Date.parse('2026-10-19T10:00:00+08:00') };
  for (const upstream of [
    body({ timestamps: ['2026-10-12', '2026-10-13', '2026-10-14'].map(timestamp), meta: { regularMarketTime: timestamp('2026-10-16') } }),
    body({ timestamps: ['2020-10-13', '2026-10-14', '2026-10-16'].map(timestamp), meta: { regularMarketTime: timestamp('2026-10-16') } }),
    body({ timestamps: Array(801).fill(timestamp('2026-10-16')), meta: { regularMarketTime: timestamp('2026-10-16') } }),
  ]) await assert.rejects(createYahooHkClient({ ...options, fetchImpl: async () => response(upstream) }).collectDaily({ ...range, endDate: '20261018' }), { kind: 'invalid_response' });
});

test('market store allows only explicit Yahoo HK daily provenance and stores unavailable turnover as null', async () => {
  const calls = [], pool = { async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; }, async connect() { return { query: pool.query.bind(pool), release() {} }; }, async end() {} };
  const store = createMarketStore({ pool }), rows = (await collector().collectDaily(range)).rows.slice(0, 1);
  await store.saveDay({ market: 'HK', apiName: 'yahoo_hk_daily', source: 'yahoo', tradeDate: '20261014', rows });
  const values = calls.find(call => call.sql.startsWith('INSERT INTO market_data.daily_prices')).values;
  assert.equal(values[11], null); assert.deepEqual(values.slice(12), ['yahoo', 'yahoo_hk_daily', 'none', 'share', 'hkd', 'HKD']);
  const before = calls.length;
  for (const changes of [{ market: 'A' }, { apiName: 'hk_daily' }, { source: 'tushare' }, { source: 'eastmoney' }]) await assert.rejects(store.saveDay({ market: 'HK', apiName: 'yahoo_hk_daily', source: 'yahoo', tradeDate: '20261014', rows, ...changes }), { code: 'VALIDATION_ERROR' });
  assert.equal(calls.length, before);
  const schema = await readFile(new URL('../backend/market-data/schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /source = 'yahoo' AND market = 'HK' AND source_api = 'yahoo_hk_daily'/);
  assert.match(schema, /position\('yahoo_hk_daily' in pg_get_constraintdef\(oid\)\) = 0/);
});
