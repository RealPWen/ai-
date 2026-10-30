import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMarketComparison } from '../frontend/src/features/market-comparison.js';

const stocks = () => [{ date: '2026-10-09', close: 100 }, { date: '2026-10-13', close: 110 }];
const benchmark = () => ({ status: 'available', latest: { date: '2026-10-13', close: 1200 },
  points: [{ date: '2026-10-09', close: 1000, scaledClose: 100 }, { date: '2026-10-13', close: 1200, scaledClose: 120 }] });

test('收益差按共同首末日的涨跌幅之差计算百分点，不用价格差或已缩放指数', () => {
  const index = benchmark(); index.points[1].scaledClose = 99999; index.baseStockClose = 1; index.baseIndexClose = 1;
  const result = summarizeMarketComparison(stocks(), index);
  assert.deepEqual(result.stock, { date: '2026-10-13', close: 110 });
  assert.deepEqual(result.index, { date: '2026-10-13', close: 1200 });
  assert.equal(result.performance.from, '2026-10-09'); assert.equal(result.performance.to, '2026-10-13');
  assert.ok(Math.abs(result.performance.stockReturn - 0.1) < 1e-12);
  assert.ok(Math.abs(result.performance.indexReturn - 0.2) < 1e-12);
  assert.ok(Math.abs(result.performance.excessPercentagePoints + 10) < 1e-10);
  assert.ok(summarizeMarketComparison([{ date: '2026-10-09', close: 100 }, { date: '2026-10-13', close: 130 }], index).performance.excessPercentagePoints > 0);
});

test('最新股价和最新指数可有各自日期，收益差不混用两个最新日', () => {
  const points = [{ date: '2026-10-09', close: 100 }, { date: '2026-10-12', close: 90 }, { date: '2026-10-13', close: 80 }];
  const index = { status: 'available', latest: { date: '2026-10-14', close: 1100 }, points: [
    { date: '2026-10-09', close: 1000 }, { date: '2026-10-12', close: 900 }, { date: '2026-10-13', close: null },
  ] };
  const result = summarizeMarketComparison(points, index);
  assert.equal(result.stock.date, '2026-10-13'); assert.equal(result.stock.close, 80);
  assert.equal(result.index.date, '2026-10-14'); assert.equal(result.index.close, 1100);
  assert.equal(result.performance.to, '2026-10-12'); assert.equal(result.performance.excessPercentagePoints, 0);
});

test('不补零、不填停牌日；只有一个共同日或分母非正时不伪造区间相对表现', () => {
  const index = benchmark();
  assert.equal(summarizeMarketComparison(stocks().slice(1), index).performance, null);
  assert.equal(summarizeMarketComparison([{ date: '2026-10-09', close: 0 }, ...stocks().slice(1)], index).performance, null);
  index.points[0].close = null; assert.equal(summarizeMarketComparison(stocks(), index).performance, null);
  for (const status of ['unmapped', 'unpublished', 'ambiguous_membership', 'missing_prices']) {
    const result = summarizeMarketComparison(stocks(), { ...benchmark(), status });
    assert.equal(result.index, null); assert.equal(result.performance, null);
  }
  const noCommon = summarizeMarketComparison(stocks(), { ...benchmark(), status: 'no_common_date' });
  assert.equal(noCommon.index.close, 1200); assert.equal(noCommon.performance, null);
});

test('旧接口没有独立最新点位时兼容对齐序列，显式缺失不当作零点', () => {
  const index = benchmark(); delete index.latest;
  assert.deepEqual(summarizeMarketComparison(stocks(), index).index, { date: '2026-10-13', close: 1200 });
  index.latest = null; assert.equal(summarizeMarketComparison(stocks(), index).index, null);
  const source = JSON.stringify(index); summarizeMarketComparison(stocks(), index); assert.equal(JSON.stringify(index), source);
  assert.deepEqual(summarizeMarketComparison([], null), { stock: null, index: null, performance: null });
});

test('二级回退按实际二级点位计算，原三级标签不参与收益且回退失败保留缺失', () => {
  const index = { ...benchmark(), level: 2, indexCode: '801095.SI', industryName: '乘用车', fallbackReason: 'unpublished',
    classification: { l3Code: '850951.SI', l3Name: '电动乘用车', l2Code: '801095.SI', l2Name: '乘用车' } };
  const result = summarizeMarketComparison(stocks(), index);
  assert.ok(Math.abs(result.performance.excessPercentagePoints + 10) < 1e-10);
  assert.deepEqual(result.index, { date: '2026-10-13', close: 1200 });
  assert.equal(summarizeMarketComparison(stocks(), { ...index, status: 'missing_prices' }).performance, null);
});
