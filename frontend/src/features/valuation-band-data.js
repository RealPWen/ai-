const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function nullableNumber(value, label, { positive = false, percentage = false } = {}) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0) || (percentage && (value < 0 || value > 100))) throw new Error(`${label}无效`);
  return value;
}
function optionalDate(value, label) {
  if (value === null) return null;
  if (!validDate(value)) throw new Error(`${label}日期无效`);
  return value;
}

/** Preserve explicit gaps and the requested stock/date identity before plotting. */
export function adaptValuationBands(data) {
  if (data == null) return null;
  if (!object(data) || !/^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/.test(data.ticker) || !validDate(data.asOf)
    || !validDate(data.windowStart) || data.windowStart > data.asOf || !['6m', '1y'].includes(data.period)) throw new Error('估值 band 请求范围或标的无效');
  const market = data.ticker.endsWith('.HK') ? 'HK' : 'A';
  if ((data.market != null && data.market !== market) || (data.currency != null && !(market === 'HK' ? ['HKD', 'USD'] : ['CNY']).includes(data.currency))) throw new Error('估值 band 市场或币种与标的不一致');
  const read = (name, metric) => {
    const group = data[name];
    if (!object(group) || group.metric !== metric || !['available', 'insufficient_samples', 'no_data'].includes(group.status)
      || !Array.isArray(group.points) || !object(group.quantiles) || !object(group.latest) || !object(group.meta)) throw new Error('估值 band 返回格式不符');
    const points = group.points.map(point => {
      if (!object(point) || !validDate(point.date) || point.date < data.windowStart || point.date > data.asOf) throw new Error('估值点位日期超出查询区间');
      const sourceMetadata = {};
      for (const key of ['source', 'sourceId', 'sourceApi']) {
        if (Object.hasOwn(point, key)) {
          if (point[key] != null && typeof point[key] !== 'string') throw new Error('估值点位来源无效');
          sourceMetadata[key] = point[key];
        }
      }
      return { date: point.date, value: nullableNumber(point.value, '估值倍数', { positive: true }), ...sourceMetadata };
    });
    if (points.some((point, index) => index > 0 && point.date <= points[index - 1].date)) throw new Error('估值日期须按先后顺序且不重复');
    const quantiles = Object.fromEntries(['p10', 'p25', 'p50', 'p75', 'p90'].map(key => [key, nullableNumber(group.quantiles[key], '估值分位线', { positive: true })]));
    const levels = Object.values(quantiles);
    if (group.status === 'available' ? levels.some(value => value === null) || levels.some((value, index) => index > 0 && value < levels[index - 1]) : levels.some(value => value !== null)) throw new Error('估值分位线与样本状态不一致');
    const latest = { date: optionalDate(group.latest.date, '最新估值'), rawValue: nullableNumber(group.latest.rawValue, '源端最新估值'),
      value: nullableNumber(group.latest.value, '最新有效估值', { positive: true }), percentile: nullableNumber(group.latest.percentile, '当前历史分位', { percentage: true }) };
    if (latest.date !== (points.at(-1)?.date ?? null) || latest.value !== (points.at(-1)?.value ?? null)
      || latest.value !== (latest.rawValue > 0 ? latest.rawValue : null)
      || ((latest.value === null || group.status !== 'available') && latest.percentile !== null)) throw new Error('最新估值与原始末日数据不一致');
    const meta = { ...group.meta };
    for (const key of ['validCount', 'totalCount', 'missingCount', 'nonPositiveCount', 'minSamples']) {
      if (!Number.isInteger(meta[key]) || meta[key] < 0 || (key === 'minSamples' && meta[key] < 1)) throw new Error('估值样本计数无效');
    }
    if (meta.totalCount !== points.length || meta.validCount !== points.filter(point => point.value !== null).length
      || meta.validCount + meta.missingCount + meta.nonPositiveCount !== meta.totalCount
      || group.status !== (meta.validCount === 0 ? 'no_data' : meta.validCount < meta.minSamples ? 'insufficient_samples' : 'available')) throw new Error('估值样本计数与状态不一致');
    for (const key of ['firstDate', 'lastDate', 'availableFrom', 'databaseThrough']) optionalDate(meta[key], '估值覆盖');
    if (meta.firstDate !== (points[0]?.date ?? null) || meta.lastDate !== latest.date) throw new Error('估值覆盖范围与点位不一致');
    return { metric, status: group.status, points, quantiles, latest, meta };
  };
  const metadata = {};
  for (const key of ['market', 'currency', 'sourceId', 'sourceApi', 'sourceUrl', 'coverageScope', 'coverageStatus']) {
    if (Object.hasOwn(data, key)) {
      if (data[key] != null && typeof data[key] !== 'string') throw new Error('估值 band 来源元数据无效');
      metadata[key] = data[key];
    }
  }
  if (Object.hasOwn(data, 'sources')) {
    if (!Array.isArray(data.sources) || data.sources.some(source => typeof source !== 'string' && !object(source))) throw new Error('估值 band 来源列表无效');
    metadata.sources = data.sources.map(source => object(source) ? { ...source } : source);
  }
  if (Object.hasOwn(data, 'meta')) {
    if (!object(data.meta)) throw new Error('估值采集元数据无效');
    const meta = { ...data.meta };
    if (Object.hasOwn(meta, 'lastAttemptDate')) {
      optionalDate(meta.lastAttemptDate, '估值采集');
      if (meta.lastAttemptDate > data.asOf) throw new Error('估值采集日期晚于研究截止日');
    }
    for (const key of ['priceCount', 'valuationCount', 'missingPriceCount']) if (Object.hasOwn(meta, key) && (!Number.isInteger(meta[key]) || meta[key] < 0)) throw new Error('估值采集计数无效');
    if (meta.priceCount != null && (meta.valuationCount > meta.priceCount || meta.missingPriceCount > meta.priceCount)) throw new Error('估值采集计数不一致');
    if (meta.sourceCoverage != null && !object(meta.sourceCoverage)) throw new Error('估值来源覆盖元数据无效');
    metadata.meta = meta;
  }
  return { ticker: data.ticker, asOf: data.asOf, period: data.period, windowStart: data.windowStart,
    source: typeof data.source === 'string' ? data.source : '', ...metadata, peTtm: read('peTtm', 'pe_ttm'), pb: read('pb', 'pb') };
}

export function assertBandsContext(data, { ticker, asOf, period }) {
  if (!data || data.ticker !== ticker || data.asOf !== asOf || data.period !== period) throw new Error('估值 band 返回的标的、日期或区间与当前请求不一致');
  return data;
}
