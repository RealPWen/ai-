import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeValuationBands, summarizeValuationMetric } from '../backend/market-data/valuation-bands.mjs';
import { createMarketReadService } from '../backend/market-data/read-service.mjs';
import { createResearchServer } from '../backend/app.mjs';

const TICKER = '002920.SZ';
const AS_OF = '2026-10-15';
const EMPTY_QUANTILES = { p10: null, p25: null, p50: null, p75: null, p90: null };
function rows(values, pbValues = values) {
  return values.map((pe, index) => {
    const date = new Date('2026-09-01T00:00:00Z'); date.setUTCDate(date.getUTCDate() + index);
    return { trade_date: date.toISOString().slice(0, 10), pe_ttm: pe, pb: pbValues[index] };
  });
}
function summarize(observations) {
  return summarizeValuationBands({ ticker: TICKER, asOf: AS_OF, period: '1y', windowStart: '2025-10-15', rows: observations });
}
function close(actual, expected, tolerance = 1e-10) { assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`); }
function serviceFixture(observations = [], { now = '2026-10-15T01:00:00Z', fail = false } = {}) {
  const calls = [];
  const pool = { async query(sql, params) {
    if (sql.startsWith('SELECT ts_code, name, currency FROM market_data.hk_listed_universe')) return { rows: [{ ts_code: params[0], name: params[0], currency: 'HKD' }] };
    calls.push({ sql, params });
    if (fail) throw new Error('postgresql://account:secret-password@private/hidden daily_valuations missing');
    return { rows: observations };
  } };
  return { calls, service: createMarketReadService({ pool, now: () => new Date(now) }) };
}

test('type-7 valuation quantiles interpolate over all 20 positive observations without rounding', () => {
  const result = summarize(rows(Array.from({ length: 20 }, (_, index) => index + 1)));
  assert.equal(result.ticker, TICKER); assert.equal(result.asOf, AS_OF); assert.equal(result.period, '1y');
  assert.equal(result.windowStart, '2025-10-15'); assert.equal(result.source, 'Tushare daily_basic');
  assert.equal(result.peTtm.metric, 'pe_ttm'); assert.equal(result.pb.metric, 'pb');
  for (const group of [result.peTtm, result.pb]) {
    assert.equal(group.status, 'available');
    for (const [key, expected] of Object.entries({ p10: 2.9, p25: 5.75, p50: 10.5, p75: 15.25, p90: 18.1 })) close(group.quantiles[key], expected);
    assert.deepEqual(group.latest, { date: '2026-09-20', rawValue: 20, value: 20, percentile: 97.5 });
    assert.equal(group.meta.validCount, 20); assert.equal(group.meta.minSamples, 20);
  }
});

test('valuation percentile uses midrank for ties and constant samples stay at the 50th percentile', () => {
  const values = [...Array(5).fill(1), ...Array(9).fill(2), ...Array(5).fill(3), 2];
  const tied = summarize(rows(values)).peTtm;
  assert.equal(tied.latest.value, 2); assert.equal(tied.latest.percentile, 50);
  assert.deepEqual(tied.quantiles, { p10: 1, p25: 1.75, p50: 2, p75: 2.25, p90: 3 });
  const constant = summarize(rows(Array(20).fill('7.25'))).peTtm;
  assert.deepEqual(constant.quantiles, { p10: 7.25, p25: 7.25, p50: 7.25, p75: 7.25, p90: 7.25 });
  assert.equal(constant.latest.percentile, 50);
});

test('latest minimum has a nonzero midrank, independent of chronological ordering of values', () => {
  const group = summarize(rows(Array.from({ length: 20 }, (_, index) => 20 - index))).peTtm;
  assert.equal(group.points[0].value, 20); assert.equal(group.points.at(-1).value, 1);
  assert.equal(group.latest.percentile, 2.5);
  close(group.quantiles.p10, 2.9);
});

test('0, 1, 19 and 20 positive samples have explicit thresholds, without fabricated quantiles', () => {
  for (const count of [0, 1, 19, 20]) {
    const group = summarize(rows(Array(count).fill(5))).peTtm;
    assert.equal(group.meta.validCount, count);
    assert.equal(group.status, count === 0 ? 'no_data' : count < 20 ? 'insufficient_samples' : 'available');
    if (count < 20) {
      assert.deepEqual(group.quantiles, EMPTY_QUANTILES);
      assert.equal(group.latest.percentile, null);
    }
  }
});

test('latest missing, non-finite, zero or negative observations never revive an older positive value', () => {
  for (const latest of [null, 'NaN', Infinity, 0, -3.5]) {
    const observations = rows([...Array(20).fill(10), latest]);
    const group = summarize(observations).peTtm;
    assert.equal(group.status, 'available');
    assert.deepEqual(group.quantiles, { p10: 10, p25: 10, p50: 10, p75: 10, p90: 10 });
    assert.equal(group.latest.date, '2026-09-21');
    assert.equal(group.latest.rawValue, typeof latest === 'number' && Number.isFinite(latest) ? latest : null);
    assert.equal(group.latest.value, null); assert.equal(group.latest.percentile, null);
    assert.deepEqual(group.points.at(-1), { date: '2026-09-21', value: null });
  }
});

test('missing and non-positive observations are counted separately and preserved as dated gaps', () => {
  const values = [null, undefined, 'NaN', Infinity, -Infinity, '', '  ', 'bad', true, {}, '0x10', 0, -2, ' -3 ', 1, '2.5', '1e2'];
  const group = summarize(rows(values)).peTtm;
  assert.equal(group.meta.totalCount, 17);
  assert.equal(group.meta.missingCount, 11); assert.equal(group.meta.nonPositiveCount, 3); assert.equal(group.meta.validCount, 3);
  assert.equal(group.meta.totalCount, group.meta.validCount + group.meta.missingCount + group.meta.nonPositiveCount);
  assert.equal(group.points.length, values.length);
  assert.ok(group.points.slice(0, 14).every(point => point.value === null));
  assert.deepEqual(group.points.slice(14).map(point => point.value), [1, 2.5, 100]);
  assert.deepEqual(group.latest, { date: '2026-09-17', rawValue: 100, value: 100, percentile: null });
  assert.equal(group.meta.firstDate, '2026-09-01'); assert.equal(group.meta.lastDate, '2026-09-17');
});

test('PE-TTM and PB use independent positive samples, statuses, counts and latest values', () => {
  const observations = rows(Array(20).fill(10), [...Array(19).fill(2), null]);
  const result = summarize(observations);
  assert.equal(result.peTtm.status, 'available'); assert.equal(result.peTtm.latest.percentile, 50);
  assert.equal(result.pb.status, 'insufficient_samples'); assert.equal(result.pb.meta.validCount, 19);
  assert.equal(result.pb.meta.missingCount, 1); assert.equal(result.pb.latest.date, '2026-09-20');
  assert.equal(result.pb.latest.value, null); assert.deepEqual(result.pb.quantiles, EMPTY_QUANTILES);
});

test('no-data includes all missing or non-positive samples while keeping original coverage dates', () => {
  const result = summarize(rows([null, 0, -1], [null, null, null]));
  for (const group of [result.peTtm, result.pb]) {
    assert.equal(group.status, 'no_data'); assert.equal(group.points.length, 3);
    assert.equal(group.meta.firstDate, '2026-09-01'); assert.equal(group.meta.lastDate, '2026-09-03');
    assert.deepEqual(group.quantiles, EMPTY_QUANTILES);
  }
  assert.equal(result.peTtm.meta.nonPositiveCount, 2); assert.equal(result.pb.meta.missingCount, 3);
  assert.equal(result.peTtm.latest.rawValue, -1); assert.equal(result.peTtm.latest.value, null);
});

test('extreme positive multiples remain in the complete sample and can materially move a quantile', () => {
  const group = summarize(rows([...Array(18).fill(1), 1e9, 1e9])).peTtm;
  assert.equal(group.meta.validCount, 20);
  assert.ok(group.quantiles.p90 > 1e7);
  close(group.quantiles.p90, 100000000.9, 0.00001);
  assert.equal(group.latest.rawValue, 1e9); assert.equal(group.latest.percentile, 95);
});

test('metric summaries order dates without mutating observations, and preserve global coverage separately', () => {
  const observations = rows([null, 5, -2]).reverse(), before = structuredClone(observations);
  const group = summarizeValuationMetric('pe_ttm', observations, { availableFrom: '2020-01-01', databaseThrough: '2026-10-14' });
  assert.deepEqual(observations, before);
  assert.deepEqual(group.points.map(point => point.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(group.latest.rawValue, -2);
  assert.equal(group.meta.availableFrom, '2020-01-01'); assert.equal(group.meta.databaseThrough, '2026-10-14');
});

test('one parameterized read obtains both multiples and coverage without price or forecast data', async () => {
  const observations = rows(Array(20).fill('10.5'), Array(20).fill('2.75')).map(row => ({ ...row,
    available_from: '2025-10-14', database_through: '2026-10-14' }));
  const f = serviceFixture(observations);
  const result = await f.service.bands({ ticker: ' 002920.sz ', asOf: AS_OF, period: '6m' });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].params, [TICKER, '2026-04-15', AS_OF]);
  assert.match(f.calls[0].sql, /SELECT trade_date, pe_ttm, pb FROM market_data\.daily_valuations/);
  assert.match(f.calls[0].sql, /ts_code = \$1 AND market = 'A' AND trade_date BETWEEN \$2::date AND \$3::date/);
  assert.match(f.calls[0].sql, /daily_valuations WHERE market = 'A'/);
  assert.match(f.calls[0].sql, /LEFT JOIN observations o ON true ORDER BY o\.trade_date ASC/);
  assert.doesNotMatch(f.calls[0].sql, /daily_prices|forecasts|INSERT|UPDATE|DELETE|CREATE|LIMIT/i);
  assert.equal(result.peTtm.meta.availableFrom, '2025-10-14'); assert.equal(result.pb.meta.databaseThrough, '2026-10-14');
  assert.equal(result.peTtm.latest.value, 10.5); assert.equal(result.pb.latest.value, 2.75);
});

test('no window rows retains global valuation coverage without creating a NULL-dated observation', async () => {
  const f = serviceFixture([{ trade_date: null, pe_ttm: null, pb: null,
    available_from: '2025-10-14', database_through: '2026-10-14' }]);
  const result = await f.service.bands({ ticker: TICKER });
  assert.equal(result.period, '1y'); assert.equal(result.windowStart, '2025-10-15');
  for (const group of [result.peTtm, result.pb]) {
    assert.equal(group.status, 'no_data'); assert.deepEqual(group.points, []);
    assert.deepEqual(group.latest, { date: null, rawValue: null, value: null, percentile: null });
    assert.deepEqual(group.meta, { validCount: 0, totalCount: 0, missingCount: 0, nonPositiveCount: 0,
      firstDate: null, lastDate: null, availableFrom: '2025-10-14', databaseThrough: '2026-10-14', minSamples: 20 });
  }
});

test('cutoff uses Shanghai today and natural month/year windows clamp at month end', async () => {
  const f = serviceFixture([], { now: '2026-10-14T16:01:00Z' });
  const result = await f.service.bands({ ticker: TICKER });
  assert.equal(result.asOf, AS_OF); assert.deepEqual(f.calls[0].params, [TICKER, '2025-10-15', AS_OF]);
  for (const [asOf, period, from] of [['2026-08-31', '6m', '2026-02-28'], ['2024-02-29', '1y', '2023-02-28']]) {
    await f.service.bands({ ticker: TICKER, asOf, period });
    assert.deepEqual(f.calls.at(-1).params, [TICKER, from, asOf]);
  }
});

test('bands returns HK no-data from its own table and rejects invalid inputs before further SQL', async () => {
  const f = serviceFixture();
  for (const ticker of [undefined, '002920', "002920.SZ' OR 1=1", 'AAPL']) await assert.rejects(f.service.bands({ ticker }), { code: 'INVALID_TICKER', status: 400 });
  const hk = await f.service.bands({ ticker: '00700.HK' });
  assert.equal(hk.status, 'no_data'); assert.equal(hk.source, null);
  assert.deepEqual(hk.peTtm.points, []); assert.deepEqual(hk.pb.points, []);
  for (const asOf of ['2026-10-16', '2026-02-30', '2025-02-29', '', 20261015]) await assert.rejects(f.service.bands({ ticker: TICKER, asOf }), { code: 'INVALID_DATE', status: 400 });
  for (const period of ['1m', '3y', '6M', '__proto__', '', null, ['6m']]) await assert.rejects(f.service.bands({ ticker: TICKER, period }), { code: 'INVALID_PERIOD', status: 400 });
  for (const params of [null, [], 'bad', { ticker: TICKER, adjustment: 'qfq' }, { ticker: TICKER, unknown: 'x' }]) await assert.rejects(f.service.bands(params), { code: 'INVALID_PARAMETERS', status: 400 });
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].sql, /market_data\.hk_daily_valuations/);
  assert.doesNotMatch(f.calls[0].sql, /market_data\.daily_valuations|market = 'A'/);
});

test('HK valuation bands retain provider provenance and use independent positive PE/PB samples on stock price dates', async () => {
  const observations = rows(Array(20).fill('15.25'), [...Array(19).fill('1.75'), null]).map(row => ({ ...row,
    source: 'baidu', source_api: 'baidu_hk_valuation', available_from: '2025-10-20', database_through: '2026-10-14' }));
  const f = serviceFixture(observations);
  const result = await f.service.bands({ ticker: '00700.HK', asOf: AS_OF, period: '6m' });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].params.slice(0, 3), ['00700.HK', '2026-04-15', AS_OF]);
  assert.equal(f.calls[0].params.length, 3);
  assert.match(f.calls[0].sql, /v\.ts_code = p\.ts_code AND v\.trade_date = p\.trade_date/);
  assert.match(f.calls[0].sql, /WHERE p\.ts_code = \$1 AND p\.market = 'HK' AND p\.trade_date BETWEEN \$2::date AND \$3::date/);
  assert.doesNotMatch(f.calls[0].sql, /market_data\.daily_valuations|market = 'A'|INSERT|DELETE|CREATE|\$4::text\[\]/i);
  assert.equal(result.market, 'HK'); assert.equal(result.currency, 'HKD'); assert.equal(result.source, '百度股市通');
  assert.equal(result.sourceId, 'baidu'); assert.equal(result.sourceApi, 'baidu_hk_valuation');
  assert.deepEqual(result.sources, [{ source: '百度股市通', sourceId: 'baidu', sourceApi: 'baidu_hk_valuation' }]);
  assert.equal(result.status, 'available'); assert.equal(result.peTtm.status, 'available'); assert.equal(result.pb.status, 'insufficient_samples');
  assert.equal(result.peTtm.latest.value, 15.25); assert.equal(result.peTtm.latest.percentile, 50);
  assert.equal(result.pb.latest.value, null); assert.equal(result.pb.meta.validCount, 19); assert.equal(result.pb.meta.missingCount, 1);
  assert.equal(result.pb.meta.databaseThrough, '2026-10-14'); assert.equal(result.peTtm.meta.availableFrom, '2025-10-20');
});

test('HK mixed or absent providers never fall back to an A-share source', async () => {
  const observations = rows([10, 12]).map((row, index) => ({ ...row,
    source: index ? 'another_provider' : 'baidu', source_api: index ? 'hk_valuation_v2' : 'baidu_hk_valuation' }));
  const mixed = await serviceFixture(observations).service.bands({ ticker: '00700.HK' });
  assert.equal(mixed.source, '混合来源'); assert.equal(mixed.sourceId, null); assert.equal(mixed.sourceApi, null);
  assert.deepEqual(mixed.sources, [{ source: '百度股市通', sourceId: 'baidu', sourceApi: 'baidu_hk_valuation' },
    { source: 'another_provider hk_valuation_v2', sourceId: 'another_provider', sourceApi: 'hk_valuation_v2' }]);
  assert.equal(mixed.status, 'insufficient_samples');
  const empty = await serviceFixture([{ trade_date: null, source: 'baidu', source_api: 'baidu_hk_valuation',
    available_from: '2025-10-20', database_through: '2026-10-14' }]).service.bands({ ticker: '00700.HK' });
  assert.equal(empty.source, null); assert.deepEqual(empty.sources, []); assert.deepEqual(empty.peTtm.points, []);
  assert.equal(empty.pb.meta.availableFrom, '2025-10-20'); assert.equal(empty.pb.meta.databaseThrough, '2026-10-14');
});

test('bands database failures are sanitized to the existing market 503 without driver details', async () => {
  const f = serviceFixture([], { fail: true });
  await assert.rejects(f.service.bands({ ticker: TICKER }), error => {
    assert.equal(error.code, 'MARKET_DATABASE_UNAVAILABLE'); assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /postgresql|secret-password|daily_valuations|private/);
    assert.equal(error.cause, undefined); return true;
  });
});

async function apiFixture(t, marketService) {
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('must not log in, generate, or download'); };
  const server = createResearchServer({ marketService, health: { status: 'ok' },
    service: { generate: forbidden, get: forbidden }, auth: { status: forbidden }, chatClient: { models: forbidden, probe: forbidden } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, get forbiddenCalls() { return forbiddenCalls; } };
}

test('GET /api/market/bands forwards the query and reads local valuations without authentication or generation', async t => {
  const f = serviceFixture(rows(Array(20).fill(12), Array(20).fill(2)));
  const api = await apiFixture(t, f.service);
  const response = await fetch(`${api.base}/api/market/bands?ticker=${TICKER}&asOf=${AS_OF}&period=6m`, { headers: { Origin: 'http://127.0.0.1:8765' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:8765');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const { data } = await response.json();
  assert.equal(data.source, 'Tushare daily_basic'); assert.equal(data.period, '6m'); assert.equal(data.windowStart, '2026-04-15');
  assert.equal(data.peTtm.latest.value, 12); assert.equal(data.pb.latest.value, 2);
  assert.deepEqual(f.calls[0].params, [TICKER, '2026-04-15', AS_OF]);
  assert.equal(f.calls.length, 1); assert.equal(api.forbiddenCalls, 0);
});

test('bands API reports invalid inputs, absent configuration and failed reads explicitly', async t => {
  const f = serviceFixture(), api = await apiFixture(t, f.service);
  for (const [query, code] of [[`ticker=${TICKER}&period=1m`, 'INVALID_PERIOD'], [`ticker=${TICKER}&asOf=2026-10-16`, 'INVALID_DATE'],
    [`ticker=${TICKER}&unknown=1`, 'INVALID_PARAMETERS']]) {
    const response = await fetch(`${api.base}/api/market/bands?${query}`);
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, code);
  }
  const hk = await fetch(`${api.base}/api/market/bands?ticker=00700.HK`);
  assert.equal(hk.status, 200);
  const hkData = (await hk.json()).data;
  assert.equal(hkData.status, 'no_data'); assert.equal(hkData.market, 'HK'); assert.equal(hkData.source, null);
  assert.deepEqual(hkData.peTtm.points, []); assert.deepEqual(hkData.pb.points, []);
  assert.equal(f.calls.length, 1); assert.equal(api.forbiddenCalls, 0);
  const missing = await apiFixture(t, undefined);
  const notConfigured = await fetch(`${missing.base}/api/market/bands?ticker=${TICKER}`);
  assert.equal(notConfigured.status, 503); assert.equal((await notConfigured.json()).error.code, 'MARKET_DATABASE_NOT_CONFIGURED');
  const failing = await apiFixture(t, serviceFixture([], { fail: true }).service);
  const failed = await fetch(`${failing.base}/api/market/bands?ticker=${TICKER}`);
  assert.equal(failed.status, 503);
  const failure = await failed.text(); assert.doesNotMatch(failure, /secret-password|postgresql|daily_valuations/);
  assert.equal(JSON.parse(failure).error.code, 'MARKET_DATABASE_UNAVAILABLE');
});
