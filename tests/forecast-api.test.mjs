import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchServer } from '../backend/app.mjs';
import { createForecastReadService } from '../backend/market-data/forecast-read-service.mjs';
import { ResearchError } from '../backend/src/errors.mjs';

async function fixture(t, forecastService) {
  let inferenceCalls = 0, authCalls = 0;
  const forbidden = () => { inferenceCalls += 1; throw new Error('unexpected inference'); };
  const server = createResearchServer({
    forecastService, health: { status: 'ok' }, service: { generate: forbidden, get: forbidden },
    chatClient: { probe: forbidden }, auth: { status() { authCalls += 1; throw new Error('unexpected auth'); } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, get inferenceCalls() { return inferenceCalls; }, get authCalls() { return authCalls; } };
}

test('forecast GET forwards query parameters and never calls ChatGPT or requires login', async t => {
  const calls = [];
  const data = { ticker: '002920.SZ', rows: [], meta: { brokerCount: 0 } };
  const f = await fixture(t, { get: async params => { calls.push(params); return data; } });
  const response = await fetch(`${f.base}/api/forecasts?ticker=002920.SZ&asOf=2026-10-14&windowDays=90`, { headers: { Origin: 'http://127.0.0.1:8765' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:8765');
  assert.deepEqual(await response.json(), { data });
  assert.deepEqual(calls, [{ ticker: '002920.SZ', asOf: '2026-10-14', windowDays: '90' }]);
  assert.equal(f.inferenceCalls, 0);
  assert.equal(f.authCalls, 0);
});

test('forecast GET propagates input/business errors and missing configuration is a safe 503', async t => {
  const missing = await fixture(t);
  const response = await fetch(`${missing.base}/api/forecasts?ticker=002920.SZ`);
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json()).error, { code: 'FORECAST_DATABASE_NOT_CONFIGURED', message: '卖方预测数据库尚未配置' });
  const f = await fixture(t, { get: async () => { throw new ResearchError('MARKET_NOT_IN_UNIVERSE', '该港股不在投资池', 404); } });
  const invalid = await fetch(`${f.base}/api/forecasts?ticker=00001.HK`);
  assert.equal(invalid.status, 404);
  assert.equal((await invalid.json()).error.code, 'MARKET_NOT_IN_UNIVERSE');
});

test('HK forecast endpoint reads the latest known snapshot locally and retains source units and update-date meaning', async t => {
  const queries = [];
  const forecastService = createForecastReadService({ now: () => new Date('2026-10-14T01:00:00Z'), pool: {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT ts_code, name FROM market_data.hk_listed_universe')) return { rows: [{ ts_code: params[0], name: '腾讯控股' }] };
      return { rows: [{
        forecast_id: 'hk-sample', org_name: '中金国际', report_date: '2026-10-13', fiscal_year: 2027, fiscal_period: '2027-06', eps: '1.2',
        currency: 'HKD', eps_basis: null, source: 'etnet', source_api: 'etnet_hk_profit_forecast',
        source_url: 'https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php?code=00700',
        snapshot_date: '2026-10-14', available_from: '2026-10-14', database_through: '2026-10-13', fetched_at_max: '2026-10-14T01:00:00.000Z',
      }] };
    },
  } });
  const f = await fixture(t, forecastService);
  const response = await fetch(`${f.base}/api/forecasts?ticker=00700.HK&asOf=2026-10-14`);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.source, '经济通');
  assert.equal(data.unit, '港元/股');
  assert.equal(data.rows[0].fiscalPeriod, '2027-06');
  assert.equal(data.rows[0].samples[0].eps, 1.2);
  assert.equal(data.meta.dateMeaning, 'broker_update_date');
  assert.equal(data.meta.snapshotDate, '2026-10-14');
  assert.equal(data.meta.historicalArchiveAvailable, false);
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /hk_listed_universe.*active = true/);
  assert.match(queries[1].sql, /FROM market_data.hk_forecast_symbol_runs/);
  assert.equal(f.inferenceCalls, 0);
  assert.equal(f.authCalls, 0);
});

test('forecast endpoint uses only local SQL and preserves tied broker attribution', async t => {
  const queries = [];
  const forecastService = createForecastReadService({ now: () => new Date('2026-10-14T01:00:00Z'), pool: {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: ['甲证券', '乙证券'].map((broker, index) => ({
        forecast_id: String(index), org_name: broker, report_date: '2026-10-13', quarter: '2026Q4', eps: '1.2',
      })) };
    },
  } });
  const f = await fixture(t, forecastService);
  const response = await fetch(`${f.base}/api/forecasts?ticker=002920.SZ&asOf=2026-10-14`);
  const { data } = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.rows[0].sampleSize, 2);
  assert.equal(data.rows[0].consensus.value, 1.2);
  assert.deepEqual(new Set(data.rows[0].low.brokers), new Set(['甲证券', '乙证券']));
  assert.equal(data.meta.brokerCount, 2);
  assert.equal(data.currency, null);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, ['002920.SZ', '2026-07-17', '2026-10-14']);
  assert.equal(f.inferenceCalls, 0);
  assert.equal(f.authCalls, 0);
});

test('forecast GET sanitizes a missing table and rejects invalid params before database access', async t => {
  let calls = 0;
  const forecastService = createForecastReadService({ now: () => new Date('2026-10-14T01:00:00Z'), pool: {
    async query() { calls += 1; throw new Error('relation sell_side_forecasts missing; postgresql://secret'); },
  } });
  const f = await fixture(t, forecastService);
  const invalid = await fetch(`${f.base}/api/forecasts?ticker=002920.SZ&windowDays=2000`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_WINDOW');
  assert.equal(calls, 0);
  const failed = await fetch(`${f.base}/api/forecasts?ticker=002920.SZ`);
  assert.equal(failed.status, 503);
  const body = await failed.text();
  assert.ok(!body.includes('postgresql'));
  assert.ok(!body.includes('sell_side_forecasts'));
  assert.match(body, /FORECAST_DATABASE_UNAVAILABLE/);
  assert.equal(f.inferenceCalls, 0);
});
