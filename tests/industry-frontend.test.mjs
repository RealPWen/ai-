import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adapters, assertPricesContext } from '../frontend/src/services/adapters.js';
import { endpoints } from '../frontend/src/api/endpoints.js';
import { createResearchService } from '../frontend/src/services/research-service.js';
import { createCompanySession } from '../frontend/src/features/company-session.js';

const example = () => ({
  ticker: '002920.SZ',
  points: [
    { date: '2026-10-09', open: 80, high: 86, low: 79, close: 85, volume: 100, amount: 800 },
    { date: '2026-10-12', open: 85, high: 87, low: 84, close: 86, volume: 120, amount: 1000 },
    { date: '2026-10-13', open: 86, high: 90, low: 85, close: 89, volume: 110, amount: 970 },
  ],
  meta: { adjustment: 'qfq', requestedAsOf: '2026-10-14', period: '1m', adjustmentStatus: 'available', adjustmentAnchorDate: '2026-10-13', adjustmentAnchorFactor: 3, missingFactorCount: 0 },
  benchmark: { status: 'available', system: 'SW2021', level: 3, membershipBasis: 'latest', membershipFetchedAt: '2026-10-14T01:00:00.000Z',
    indexCode: '850881.SI', industryName: '汽车电子', baseDate: '2026-10-09', baseStockClose: 85, baseIndexClose: 1000,
    points: [{ date: '2026-10-09', close: 1000, scaledClose: 85 }, { date: '2026-10-12', close: null, scaledClose: null }, { date: '2026-10-13', close: 1200, scaledClose: 102 }] },
});

test('行业适配保留分类、采集时间、实际点数、缩放数及缺日null，复制响应数据', () => {
  const source = example(), result = adapters.prices({ data: source });
  assert.deepEqual(result.benchmark, source.benchmark); assert.deepEqual(result.meta, source.meta);
  assert.equal(result.points[0].close, 85); assert.equal(result.points[0].value, 85); assert.equal(result.points[0].volume, 100);
  assert.equal(result.benchmark.points[1].close, null); assert.equal(result.benchmark.points[1].scaledClose, null);
  assert.notEqual(result.benchmark, source.benchmark); assert.notEqual(result.benchmark.points[0], source.benchmark.points[0]); assert.notEqual(result.meta, source.meta);
  for (const status of ['unmapped', 'ambiguous_membership', 'unpublished', 'missing_prices', 'no_common_date']) {
    const data = example(); data.benchmark = { ...data.benchmark, status, baseDate: null, baseStockClose: null, baseIndexClose: null,
      points: data.points.map(point => ({ date: point.date, close: null, scaledClose: null })) };
    assert.equal(adapters.prices(data).benchmark.status, status);
  }
});

test('行业适配拒绝非法口径、状态、日历、非有限值、乱序重复及交易日错配', () => {
  for (const mutate of [
    data => { data.benchmark.system = 'WIND'; },
    data => { data.benchmark.level = 1; },
    data => { data.benchmark.membershipBasis = 'historical'; },
    data => { data.benchmark.status = 'fake'; },
    data => { data.benchmark.membershipFetchedAt = '2026-02-30T00:00:00Z'; },
    data => { data.benchmark.baseDate = '2026-02-30'; },
    data => { data.benchmark.points[0].close = '1000'; },
    data => { data.benchmark.points[0].scaledClose = Infinity; },
    data => { data.benchmark.points[0].close = null; },
    data => { data.benchmark.points[0].close = -1; },
    data => { data.benchmark.points[0].date = '2026-02-30'; },
    data => { data.benchmark.points.reverse(); },
    data => { data.benchmark.points[1].date = data.benchmark.points[0].date; },
    data => { data.benchmark.points[1].date = '2026-10-11'; },
    data => { data.benchmark.points.pop(); },
    data => { data.benchmark.baseIndexClose = null; },
    data => { data.meta.missingFactorCount = -1; },
    data => { data.meta.adjustmentAnchorFactor = NaN; },
    data => { data.points[0].date = '2026-02-30'; },
  ]) {
    const data = example(); mutate(data); assert.throws(() => adapters.prices(data));
  }
});

test('二级回退保留原始三级标签和原因，仅接受实际采用层级的指数', () => {
  for (const reason of ['unpublished', 'missing_prices', 'no_common_date', 'missing_classification', 'ambiguous_membership']) {
    const source = example();
    source.benchmark = { ...source.benchmark, level: 2, indexCode: '801095.SI', industryName: '乘用车', fallbackReason: reason,
      classification: { l3Code: '850951.SI', l3Name: '电动乘用车', l2Code: '801095.SI', l2Name: '乘用车' } };
    const result = adapters.prices(source).benchmark;
    assert.deepEqual(result, source.benchmark);
    assert.notEqual(result.classification, source.benchmark.classification);
    source.benchmark.indexCode = '850951.SI';
    assert.throws(() => adapters.prices(source), /实际采用的分类层级不一致/);
  }
  const source = example(); source.benchmark.fallbackReason = null;
  source.benchmark.classification = { l3Code: '850881.SI', l3Name: '汽车电子', l2Code: '801093.SI', l2Name: '汽车零部件' };
  assert.deepEqual(adapters.prices(source).benchmark, source.benchmark);
  for (const mutate of [
    data => { data.benchmark.fallbackReason = 'network_error'; },
    data => { data.benchmark.classification.l3Code = '801093.SI'; },
    data => { data.benchmark.classification.l2Name = 1; },
    data => { data.benchmark.classification = []; },
  ]) {
    const data = structuredClone(source); mutate(data); assert.throws(() => adapters.prices(data));
  }
});

test('缺少行业目录时保留实际分类元数据和missing_classification状态，不误判未发布', () => {
  const source = example();
  source.benchmark = { ...source.benchmark, status: 'missing_classification', level: 2, indexCode: '801095.SI', industryName: '乘用车',
    fallbackReason: 'missing_classification', classification: { l3Code: '850951.SI', l3Name: '电动乘用车', l2Code: '801095.SI', l2Name: '乘用车' },
    baseDate: null, baseStockClose: null, baseIndexClose: null, latest: null,
    points: source.points.map(point => ({ date: point.date, close: null, scaledClose: null })) };
  const result = adapters.prices(source).benchmark;
  assert.deepEqual(result, source.benchmark);
  assert.equal(result.status, 'missing_classification');
  assert.notEqual(result.classification, source.benchmark.classification);
});

test('最新行业点位独立于股票交易日，保持原始点数并兼容缺少字段的旧响应', () => {
  const source = example();
  source.benchmark.latest = { date: '2026-10-14', close: 1288 };
  const result = adapters.prices(source);
  assert.deepEqual(result.benchmark.latest, source.benchmark.latest);
  assert.notEqual(result.benchmark.latest, source.benchmark.latest);
  assert.equal(result.points.at(-1).date, '2026-10-13');
  assert.equal(result.benchmark.points.at(-1).date, '2026-10-13');
  source.benchmark.latest = null;
  assert.equal(adapters.prices(source).benchmark.latest, null);
  delete source.benchmark.latest;
  assert.equal(Object.hasOwn(adapters.prices(source).benchmark, 'latest'), false);
});

test('最新行业点位拒绝未来日期及无效点数，没有共同交易日仍保留独立最新点位', () => {
  for (const latest of [
    { date: '2026-10-15', close: 1200 }, { date: '2026-02-30', close: 1200 },
    { date: '2026-10-14', close: 0 }, { date: '2026-10-14', close: -1 },
    { date: '2026-10-14', close: null }, { date: '2026-10-14', close: Infinity },
    { date: '2026-10-14', close: '1200' },
  ]) {
    const source = example(); source.benchmark.latest = latest;
    assert.throws(() => adapters.prices(source));
  }
  const source = example();
  source.benchmark = { ...source.benchmark, status: 'no_common_date', baseDate: null, baseStockClose: null,
    baseIndexClose: null, latest: { date: '2026-10-14', close: 1288 },
    points: source.points.map(point => ({ date: point.date, close: null, scaledClose: null })) };
  assert.deepEqual(adapters.prices(source).benchmark.latest, { date: '2026-10-14', close: 1288 });
});

test('行业和前复权共用一次GET请求与取消信号，旧未复权响应仍可适配', async () => {
  const calls = [], signal = new AbortController().signal;
  const service = createResearchService({ config: { enabled: true }, routes: endpoints, mappers: adapters,
    client: { get: async (path, options) => { calls.push({ path, ...options }); return { data: example() }; } } });
  const result = await service.load('prices', { ticker: '002920.SZ', asOf: '2026-10-14', period: '1m' }, { signal });
  assert.equal(result.status, 'ready'); assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/market/prices');
  assert.equal(calls[0].signal, signal);
  assert.deepEqual(calls[0].query, { ticker: '002920.SZ', asOf: '2026-10-14', period: '1m', adjustment: 'qfq', benchmark: 'sw2021_l3' });
  const legacy = adapters.prices({ ticker: '002920.SZ', points: example().points, meta: { adjustment: 'none' } });
  assert.equal(legacy.meta.adjustment, 'none'); assert.equal(Object.hasOwn(legacy, 'benchmark'), false);
});

test('价格上下文校验拦截错误代码、截止日、区间和口径；快速切换后晚到数据不能绘制', async () => {
  const params = { ticker: '002920.SZ', asOf: '2026-10-14', period: '1m' };
  assert.equal(assertPricesContext(example(), params).ticker, params.ticker);
  for (const mutate of [
    data => { data.ticker = '600519.SH'; }, data => { delete data.ticker; },
    data => { data.meta.requestedAsOf = '2026-10-13'; }, data => { delete data.meta.requestedAsOf; },
    data => { data.meta.period = '6m'; }, data => { data.meta.adjustment = 'none'; },
  ]) { const data = example(); mutate(data); assert.throws(() => assertPricesContext(data, params)); }
  const session = createCompanySession({ ticker: params.ticker }), rendered = [];
  let resolve;
  const oldRequest = session.begin('prices');
  const pending = new Promise(done => { resolve = done; }).then(data => { if (oldRequest.isCurrent()) rendered.push(assertPricesContext(data, params)); });
  const newPeriodRequest = session.begin('prices');
  assert.equal(oldRequest.signal.aborted, true); assert.equal(oldRequest.isCurrent(), false);
  session.select({ ticker: '600519.SH' });
  assert.equal(newPeriodRequest.signal.aborted, true); assert.equal(newPeriodRequest.isCurrent(), false);
  resolve(example()); await pending; assert.deepEqual(rendered, []);
  const main = await readFile(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.ok(main.indexOf('if (!request.isCurrent()) return;') < main.indexOf('assertPricesContext(result.data, params)'), '先排除取消请求再验证/显示价格');
  assert.match(main, /module === 'prices'.*adjustment: 'qfq'.*benchmark: 'sw2021_l3'/);
});
