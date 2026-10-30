import test from 'node:test';
import assert from 'node:assert/strict';
import { relationReturnGap, summarizeRelationReturnGaps } from '../frontend/src/features/relations-return-gap.js';

function market(w1, m6, extra = {}) {
  return {
    tradeDate: '2026-10-21',
    returns: { w1, m6 },
    returnStatus: { w1: 'available', m6: 'available' },
    returnBaseDates: { w1: '2026-10-14', m6: '2026-04-21' },
    ...extra,
  };
}

test('差值按当前标的减关联股票计算，保留正负、零及原始精度', () => {
  assert.deepEqual(relationReturnGap(market(0.11, -30.33), market(-1.55, -8.13), 'w1'), { value: 0.11 - -1.55, reason: '' });
  assert.deepEqual(relationReturnGap(market(0.11, -30.33), market(-1.55, -8.13), 'm6'), { value: -30.33 - -8.13, reason: '' });
  assert.deepEqual(relationReturnGap(market(0, 0), market(0, 0), 'w1'), { value: 0, reason: '' });
  assert.equal(relationReturnGap(market(1.23456789, 0), market(0.11111111, 0), 'w1').value, 1.23456789 - 0.11111111);
});

test('不混用其他周期，也不将缺失、字符串、NaN及无限值作为零', () => {
  for (const value of [undefined, null, '1.2', NaN, Infinity, -Infinity]) {
    assert.match(relationReturnGap(market(value, 5), market(2, 3), 'w1').reason, /当前标的缺少有效的1周涨跌幅/);
    assert.equal(relationReturnGap(market(2, 5), market(value, 3), 'w1').value, null);
  }
  assert.deepEqual(relationReturnGap(null, market(2, 3), 'w1'), { value: null, reason: '当前标的缺少有效的1周涨跌幅' });
  assert.equal(relationReturnGap(market(1, 2), market(1, 2), 'm1').value, null);
  assert.equal(relationReturnGap(market(Number.MAX_VALUE, 0), market(-Number.MAX_VALUE, 0), 'w1').value, null);
});

test('明确不可用状态优先拒绝，即使涨跌幅字段仍有数字', () => {
  for (const [status, reason] of [
    ['no_prices', '日线尚未取得'], ['insufficient_history', '历史区间不足'],
    ['missing_base_factor', '缺少基准日复权因子'], ['invalid_base_price', '基准日价格无效'],
    ['missing_anchor_factor', '缺少收盘日复权因子'], ['invalid_price', '收盘价无效'],
    ['missing', '数据尚未取得'], ['unexpected', '该区间数据不可用'],
  ]) {
    const unavailable = market(2, 3, { returnStatus: { w1: status } });
    assert.deepEqual(relationReturnGap(market(4, 5), unavailable, 'w1'), { value: null, reason: `关联股票1周涨跌幅不可用：${reason}` });
    assert.equal(relationReturnGap(unavailable, market(4, 5), 'w1').value, null);
  }
  for (const returnStatus of [undefined, {}, { w1: '' }, { w1: null }]) {
    assert.equal(relationReturnGap(market(4, 5, { returnStatus }), market(2, 3), 'w1').value, 2);
  }
});

test('双方行情日期和所选周期基准日期必须齐全且一致', () => {
  const subject = market(4, 5), related = market(2, 3);
  for (const [field, value, reason] of [
    ['tradeDate', null, '缺少有效的行情日期'],
    ['tradeDate', '', '缺少有效的行情日期'],
    ['tradeDate', '2026-10-20', '行情日期不一致'],
    ['returnBaseDates', undefined, '缺少有效的1周基准日期'],
    ['returnBaseDates', { w1: null }, '缺少有效的1周基准日期'],
    ['returnBaseDates', { w1: '2026-10-13' }, '1周基准日期不一致'],
  ]) {
    const result = relationReturnGap(subject, { ...related, [field]: value }, 'w1');
    assert.equal(result.value, null); assert.ok(result.reason.includes(reason), result.reason);
    assert.equal(relationReturnGap({ ...subject, [field]: value }, related, 'w1').value, null);
  }
  assert.equal(relationReturnGap(subject, market(2, 3, { returnBaseDates: { w1: '2026-10-14', m6: '2026-04-20' } }), 'm6').value, null);
  assert.equal(relationReturnGap(subject, market(2, 3, { returnBaseDates: { w1: '2026-10-14', m6: '2026-04-20' } }), 'w1').value, 2);
});

test('沿用原表A股前复权、港股未复权口径，不因币种或市场不同拒绝', () => {
  const subject = market(4, 5, { currency: 'CNY', returnAdjustment: 'qfq' });
  const related = market(2, 3, { currency: 'HKD', returnAdjustment: 'none' });
  assert.deepEqual(relationReturnGap(subject, related, 'w1'), { value: 2, reason: '' });
});

test('平均值仅包含传入可见关联中有效差值，统计有效家数且不将缺失计作零', () => {
  const subject = market(4, 5);
  const relations = [
    { market: market(1, 10) }, { market: market(7, 0) }, { market: market(4, 5) },
    { market: market(null, 3) }, { market: market(1, 2, { tradeDate: '2026-10-20' }) },
  ];
  assert.deepEqual(summarizeRelationReturnGaps(subject, relations, 'w1'), { value: 0, count: 3, total: 5, trimmedValue: 0, trimmedCount: 1 });
  assert.deepEqual(summarizeRelationReturnGaps(subject, relations.slice(0, 1), 'w1'), { value: 3, count: 1, total: 1, trimmedValue: null, trimmedCount: 0 });
  const precise = summarizeRelationReturnGaps(market(1, 1), [{ market: market(0, 0) }, { market: market(0, 0) }, { market: market(0.1, 0.1) }], 'w1');
  assert.ok(Math.abs(precise.value - (1 + 1 + 0.9) / 3) < 1e-15);
});

test('没有有效关联时平均值为null，不显示虚假的0或除零结果', () => {
  assert.deepEqual(summarizeRelationReturnGaps(market(4, 5), [], 'w1'), { value: null, count: 0, total: 0, trimmedValue: null, trimmedCount: 0 });
  assert.deepEqual(summarizeRelationReturnGaps(market(4, 5), [{ market: null }, {}], 'w1'), { value: null, count: 0, total: 2, trimmedValue: null, trimmedCount: 0 });
  assert.deepEqual(summarizeRelationReturnGaps(null, [{ market: market(1, 2) }], 'w1'), { value: null, count: 0, total: 1, trimmedValue: null, trimmedCount: 0 });
});

test('去极值平均至少需要3个有效差值，分别去掉一条最大值和最小值', () => {
  const subject = market(0, 0);
  const relations = [{ market: market(-9, 0) }, { market: market(7, 0) }, { market: market(-2, 0) }];
  for (const size of [0, 1, 2, 3]) {
    const result = summarizeRelationReturnGaps(subject, relations.slice(0, size), 'w1');
    assert.equal(result.count, size);
    assert.equal(result.trimmedValue, size === 3 ? 2 : null);
    assert.equal(result.trimmedCount, size === 3 ? 1 : 0);
  }
  const onlyTwoValid = [...relations.slice(0, 2), { market: market(null, 0) }];
  assert.equal(summarizeRelationReturnGaps(subject, onlyTwoValid, 'w1').trimmedValue, null);
});

test('重复极值也仅各去掉一条，零和正负差值均参与计算', () => {
  const relations = [-10, 10, 0, -10, 10, -2].map(value => ({ market: market(-value, 0) }));
  const result = summarizeRelationReturnGaps(market(0, 0), relations, 'w1');
  assert.equal(result.count, 6);
  assert.equal(result.trimmedCount, 4);
  assert.ok(Math.abs(result.trimmedValue - -0.5) < 1e-15);
  const identical = Array.from({ length: 4 }, () => ({ market: market(-3, 0) }));
  assert.equal(summarizeRelationReturnGaps(market(0, 0), identical, 'w1').trimmedValue, 3);
  const zeros = Array.from({ length: 3 }, () => ({ market: market(0, 0) }));
  assert.equal(summarizeRelationReturnGaps(market(0, 0), zeros, 'w1').trimmedValue, 0);
});

test('两个周期分别筛选有效样本后去极值，不提前舍入且不修改输入', () => {
  const subject = market(1, 10);
  const relations = [
    { market: market(-99, 9) },
    { market: market(0.12345678, 6) },
    { market: market(-1, 3, { returnBaseDates: { w1: '2026-10-14', m6: '2026-04-20' } }) },
    { market: market(9, 1, { returnStatus: { w1: 'missing', m6: 'available' } }) },
    { market: market(8, null) },
    { market: market(0, 0, { tradeDate: '2026-10-20' }) },
  ];
  const before = structuredClone({ subject, relations });
  const weekly = summarizeRelationReturnGaps(subject, relations, 'w1');
  const sixMonths = summarizeRelationReturnGaps(subject, relations, 'm6');
  assert.equal(weekly.count, 4);
  assert.equal(weekly.trimmedCount, 2);
  assert.equal(weekly.trimmedValue, ((1 - 0.12345678) + 2) / 2);
  assert.equal(sixMonths.count, 3);
  assert.equal(sixMonths.trimmedCount, 1);
  assert.equal(sixMonths.trimmedValue, 4);
  assert.deepEqual({ subject, relations }, before);
});
