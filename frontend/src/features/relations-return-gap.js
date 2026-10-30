const PERIOD_NAMES = { w1: '1周', m6: '6个月' };
const STATUS_REASONS = {
  missing_base_factor: '缺少基准日复权因子',
  invalid_base_price: '基准日价格无效',
  invalid_price: '收盘价无效',
  insufficient_history: '历史区间不足',
  missing_anchor_factor: '缺少收盘日复权因子',
  no_prices: '日线尚未取得',
  missing: '数据尚未取得',
};
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

/** Values use percentage points and the same return basis as the existing table. */
export function relationReturnGap(subjectMarket, relatedMarket, period) {
  const periodName = PERIOD_NAMES[period];
  if (!periodName) return { value: null, reason: '仅支持1周和6个月涨跌幅差值' };
  for (const [label, market] of [['当前标的', subjectMarket], ['关联股票', relatedMarket]]) {
    const status = market?.returnStatus?.[period];
    if (status != null && status !== '' && status !== 'available') {
      return { value: null, reason: `${label}${periodName}涨跌幅不可用：${STATUS_REASONS[status] || '该区间数据不可用'}` };
    }
    if (!finiteNumber(market?.returns?.[period])) {
      return { value: null, reason: `${label}缺少有效的${periodName}涨跌幅` };
    }
    if (!date(market?.tradeDate)) return { value: null, reason: `${label}缺少有效的行情日期` };
    if (!date(market?.returnBaseDates?.[period])) {
      return { value: null, reason: `${label}缺少有效的${periodName}基准日期` };
    }
  }
  if (subjectMarket.tradeDate !== relatedMarket.tradeDate) {
    return { value: null, reason: `行情日期不一致：当前标的 ${subjectMarket.tradeDate}，关联股票 ${relatedMarket.tradeDate}` };
  }
  if (subjectMarket.returnBaseDates[period] !== relatedMarket.returnBaseDates[period]) {
    return { value: null, reason: `${periodName}基准日期不一致：当前标的 ${subjectMarket.returnBaseDates[period]}，关联股票 ${relatedMarket.returnBaseDates[period]}` };
  }
  const value = subjectMarket.returns[period] - relatedMarket.returns[period];
  if (!finiteNumber(value)) return { value: null, reason: `${periodName}涨跌幅差值无效` };
  return { value, reason: '' };
}

export function summarizeRelationReturnGaps(subjectMarket, relations, period) {
  const rows = Array.isArray(relations) ? relations : [];
  const values = [];
  let value = null, count = 0;
  for (const relation of rows) {
    const gap = relationReturnGap(subjectMarket, relation?.market, period);
    if (gap.value === null) continue;
    values.push(gap.value);
    count += 1;
    value = count === 1 ? gap.value : value * ((count - 1) / count) + gap.value / count;
  }
  const trimmedValues = values.length >= 3 ? values.sort((a, b) => a - b).slice(1, -1) : [];
  const trimmedValue = trimmedValues.reduce((mean, gap, index) => (
    index === 0 ? gap : mean * (index / (index + 1)) + gap / (index + 1)
  ), null);
  return { value, count, total: rows.length, trimmedValue, trimmedCount: trimmedValues.length };
}
