import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeValuationBands } from '../backend/market-data/valuation-bands.mjs';
import { adapters } from '../frontend/src/services/adapters.js';
import { endpoints } from '../frontend/src/api/endpoints.js';
import { assertBandsContext } from '../frontend/src/features/valuation-band-data.js';
import { createResearchService } from '../frontend/src/services/research-service.js';
import { createCompanySession } from '../frontend/src/features/company-session.js';

function payload(ticker = '600519.SH', period = '1y') {
  const rows = Array.from({ length: 21 }, (_, index) => ({ trade_date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    pe_ttm: index === 20 ? null : String(index + 1), pb: index === 20 ? '-0.2' : String((index + 1) / 10),
    available_from: '2025-10-14', database_through: '2026-10-13' }));
  return summarizeValuationBands({ ticker, asOf: '2026-10-15', period, windowStart: period === '1y' ? '2025-10-15' : '2026-04-15', rows });
}

test('band 后端统计经前端适配保留真实缺口、原始负值、分位通道和覆盖信息', () => {
  const source = payload(), data = adapters.bands({ data: source });
  assert.deepEqual(data, source);
  assert.equal(data.peTtm.quantiles.p50, 10.5);
  assert.equal(data.peTtm.latest.date, '2026-09-21');
  assert.equal(data.peTtm.latest.value, null);
  assert.equal(data.peTtm.latest.percentile, null);
  assert.equal(data.pb.latest.rawValue, -0.2);
  assert.equal(data.pb.latest.value, null);
  assert.equal(data.pb.points.at(-1).value, null);
  assert.notEqual(data.peTtm.points, source.peTtm.points);
  assert.equal(adapters.bands(null), null);
});

test('band 适配拒绝未来/重复日期、伪零值、错乱分位和不一致样本计数', () => {
  for (const mutate of [
    data => { data.peTtm.points[0].date = '2026-10-16'; },
    data => { data.peTtm.points[1].date = data.peTtm.points[0].date; },
    data => { data.peTtm.points[0].value = 0; },
    data => { data.peTtm.points[0].value = '1'; },
    data => { data.peTtm.quantiles.p10 = 999; },
    data => { data.peTtm.latest.percentile = 101; },
    data => { data.pb.latest.value = 0; },
    data => { data.peTtm.meta.validCount += 1; },
    data => { data.peTtm.latest.value = 20; },
  ]) {
    const data = payload(); mutate(data);
    assert.throws(() => adapters.bands(data));
  }
});

test('band 路由仅转发标的/日期/独立区间并传递取消信号，响应身份必须匹配', async () => {
  const calls = [], controller = new AbortController();
  const service = createResearchService({ config: { enabled: true }, routes: endpoints, mappers: adapters,
    client: { get: async (path, options) => { calls.push({ path, ...options }); return { data: payload('600519.SH', '6m') }; } } });
  const context = { ticker: '600519.SH', asOf: '2026-10-15', period: '6m' };
  const result = await service.load('bands', { ...context, category: '上游' }, { signal: controller.signal });
  assert.equal(calls[0].path, '/api/market/bands');
  assert.deepEqual(calls[0].query, context);
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(assertBandsContext(result.data, context), result.data);
  for (const mismatch of [{ ticker: '002920.SZ' }, { asOf: '2026-10-14' }, { period: '1y' }]) {
    assert.throws(() => assertBandsContext(result.data, { ...context, ...mismatch }));
  }
  assert.equal(endpoints.bands({ ticker: context.ticker }).query.period, '1y');
});

test('HK band保留五位代码、独立市场来源和真实缺口，6M/1Y正常请求', async () => {
  const calls = [], signal = new AbortController().signal;
  const makePayload = period => ({ ...payload('00700.HK', period), market: 'HK', currency: 'HKD', source: 'Example HK provider', sourceId: 'hk_provider', sourceApi: 'hk_valuations',
    sources: [{ source: 'Example HK provider', sourceId: 'hk_provider', sourceApi: 'hk_valuations' }] });
  const service = createResearchService({ config: { enabled: true }, routes: endpoints, mappers: adapters,
    client: { get: async (path, options) => { calls.push({ path, ...options }); return { data: makePayload(options.query.period) }; } } });
  for (const period of ['6m', '1y']) {
    const context = { ticker: '00700.HK', asOf: '2026-10-15', period };
    const result = await service.load('bands', context, { signal });
    assert.equal(result.status, 'ready'); assert.deepEqual(calls.at(-1).query, context); assert.equal(calls.at(-1).signal, signal);
    assert.deepEqual(assertBandsContext(result.data, context), makePayload(period));
    assert.equal(result.data.pb.points.at(-1).value, null); assert.equal(result.data.pb.latest.rawValue, -0.2);
  }
  for (const changes of [{ ticker: '0700.HK' }, { market: 'A' }, { currency: 'CNY' }, { sourceId: {} }]) assert.throws(() => adapters.bands({ ...makePayload('1y'), ...changes }));
  for (const changes of [{ ticker: '000338.SZ' }, { asOf: '2026-10-14' }, { period: '6m' }]) assert.throws(() => assertBandsContext(adapters.bands(makePayload('1y')), { ticker: '00700.HK', asOf: '2026-10-15', period: '1y', ...changes }));
});

test('全市场港股估值空结果经过适配保留真实采集状态与逐股元数据', () => {
  const empty = { ...summarizeValuationBands({ ticker: '00001.HK', asOf: '2026-10-15', period: '1y', windowStart: '2025-10-15', rows: [] }),
    market: 'HK', currency: 'HKD', source: null, sources: [], coverageScope: 'hk_listed_universe', coverageStatus: 'no_data',
    meta: { lastAttemptDate: '2026-10-15', updateStatus: 'no_data', priceCount: 20, valuationCount: 0, missingPriceCount: 20, sourceCoverage: { kind: 'no_data' } } };
  const adapted = adapters.bands(empty);
  assert.equal(adapted.coverageScope, 'hk_listed_universe'); assert.equal(adapted.coverageStatus, 'no_data');
  assert.deepEqual(adapted.meta, empty.meta);
  assert.deepEqual(adapted.peTtm.points, []); assert.equal(adapted.peTtm.latest.rawValue, null);
  for (const key of ['coverageScope', 'coverageStatus']) assert.throws(() => adapters.bands({ ...empty, [key]: {} }), /元数据无效/);
  assert.throws(() => adapters.bands({ ...empty, meta: { ...empty.meta, lastAttemptDate: '2026-10-16' } }), /晚于研究截止日/);
  assert.throws(() => adapters.bands({ ...empty, meta: { ...empty.meta, valuationCount: 21 } }), /计数不一致/);
});

test('切股或切估值区间后，迟到的旧 band 响应无法覆盖新请求', () => {
  const session = createCompanySession({ ticker: '600519.SH' });
  const first = session.begin('bands');
  const second = session.begin('bands');
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  session.select({ ticker: '00700.HK' });
  const current = session.begin('bands');
  assert.equal(second.signal.aborted, true);
  assert.equal(second.isCurrent(), false);
  assert.equal(current.ticker, '00700.HK');
  assert.equal(current.isCurrent(), true);
});
