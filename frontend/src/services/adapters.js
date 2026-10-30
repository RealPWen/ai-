import { adaptAttributions } from '../features/attribution-data.js';
import { adaptValuationBands } from '../features/valuation-band-data.js';
import { adaptRelations } from '../features/relations-data.js';
import { adaptEvents } from '../features/events-data.js';

/**
 * ONLY this layer translates backend responses to frontend view models.
 * The shapes below are frontend needs, not mandatory backend API contracts.
 * Change these functions when actual response examples arrive.
 */
const unwrap = response => response && typeof response === 'object' && Object.hasOwn(response, 'data') ? response.data : response;
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}返回格式不符`);
  return value;
};
const array = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`${label}应返回列表`);
  return value;
};
const finite = (value, label) => {
  if (value !== null && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${label}应为数字或 null`);
  return value ?? null;
};
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const optionalDate = (value, label) => {
  if (value != null && !validDate(value)) throw new Error(`${label}日期无效`);
  return value ?? null;
};
const positive = (value, label) => {
  const number = finite(value, label);
  if (number != null && number <= 0) throw new Error(`${label}须为正数或 null`);
  return number;
};
function validateHkUnits(value, ticker) {
  if (!/^\d{5}\.HK$/.test(ticker)) return;
  const currency = value.currency ?? 'HKD', amountUnits = currency === 'USD' ? ['usd', '美元'] : ['hkd', '港元'];
  if ((value.market != null && value.market !== 'HK') || !['HKD', 'USD'].includes(currency)
    || (value.volumeUnit != null && !['share', '股'].includes(value.volumeUnit))
    || (value.amountUnit != null && !amountUnits.includes(value.amountUnit))
    || (value.adjustment != null && value.adjustment !== 'none')) throw new Error('港股行情市场、单位或复权口径不匹配');
}
function industryBenchmark(value, stockPoints, requestedAsOf, hongKong = false) {
  if (value == null) return null;
  const item = object(value, '行业指数');
  if (!['available', 'unmapped', 'missing_classification', 'ambiguous_membership', 'unpublished', 'missing_prices', 'no_common_date'].includes(item.status)) throw new Error('行业指数状态无效');
  if (hongKong ? item.system !== 'HSI' || item.level !== null || item.membershipBasis !== 'index' || item.membershipFetchedAt !== null || item.indexCode !== 'HSI' || item.industryName !== '恒生指数'
    : item.system !== 'SW2021' || ![2, 3].includes(item.level) || item.membershipBasis !== 'latest') throw new Error('行业指数分类口径无效');
  const text = (value, label) => {
    if (value != null && (typeof value !== 'string' || !value.trim())) throw new Error(`${label}无效`);
    return value ?? null;
  };
  const fetchedAt = text(item.membershipFetchedAt, '行业归属采集时间');
  if (fetchedAt != null && (!/^\d{4}-\d{2}-\d{2}T/.test(fetchedAt) || !validDate(fetchedAt.slice(0, 10)) || Number.isNaN(Date.parse(fetchedAt)))) throw new Error('行业归属采集时间无效');
  const points = array(item.points, '行业指数点位').map(point => {
    object(point, '行业指数点位');
    if (!validDate(point.date)) throw new Error('行业指数点位日期无效');
    const close = positive(point.close, '行业指数点数'), scaledClose = positive(point.scaledClose, '行业指数叠加价格');
    if (scaledClose != null && close == null) throw new Error('行业指数叠加价格缺少实际点数');
    return { date: point.date, close, scaledClose };
  });
  if (points.some((point, index) => index > 0 && point.date <= points[index - 1].date)) throw new Error('行业指数日期须按先后顺序且不重复');
  if (points.length && (points.length !== stockPoints.length || points.some((point, index) => point.date !== stockPoints[index].date))) throw new Error('行业指数日期须与股票交易日对齐');
  const result = { status: item.status, system: item.system, level: item.level, membershipBasis: item.membershipBasis, membershipFetchedAt: fetchedAt,
    indexCode: text(item.indexCode, '行业指数代码'), industryName: text(item.industryName, '行业名称'), baseDate: optionalDate(item.baseDate, '行业叠加基准'),
    baseStockClose: positive(item.baseStockClose, '基准股票收盘价'), baseIndexClose: positive(item.baseIndexClose, '基准行业指数点数'), points };
  if (Object.hasOwn(item, 'classification')) {
    result.classification = null;
    if (item.classification != null) {
      const classification = object(item.classification, '行业归属');
      result.classification = Object.fromEntries(['l3Code', 'l3Name', 'l2Code', 'l2Name'].map(key => [key, text(classification[key], '行业归属') ]));
      const code = result.classification[`l${item.level}Code`], name = result.classification[`l${item.level}Name`];
      if (result.status === 'available' && (!code || !name || code !== result.indexCode || name !== result.industryName)) throw new Error('行业指数与实际采用的分类层级不一致');
    }
  }
  if (Object.hasOwn(item, 'fallbackReason')) {
    if (item.fallbackReason != null && !['unpublished', 'missing_prices', 'no_common_date', 'missing_classification', 'ambiguous_membership'].includes(item.fallbackReason)) throw new Error('行业指数回退原因无效');
    result.fallbackReason = item.fallbackReason ?? null;
  }
  if (Object.hasOwn(item, 'latest')) {
    result.latest = null;
    if (item.latest != null) {
      const latest = object(item.latest, '最新行业指数');
      const close = positive(latest.close, '最新行业指数点数');
      if (!validDate(latest.date) || close == null) throw new Error('最新行业指数缺少有效日期或点数');
      const cutoff = optionalDate(requestedAsOf, '研究截止');
      if (cutoff && latest.date > cutoff) throw new Error('最新行业指数日期晚于研究截止日');
      result.latest = { date: latest.date, close };
    }
  }
  if (result.status === 'available' && (!result.indexCode || !result.industryName || !result.baseDate || result.baseStockClose == null || result.baseIndexClose == null || !points.some(point => point.date === result.baseDate && point.scaledClose != null))) throw new Error('可用行业指数缺少共同基准数据');
  return result;
}

export function assertPricesContext(series, { ticker, asOf, period, adjustment = /^\d{5}\.HK$/.test(ticker) ? 'none' : 'qfq' }) {
  if (!series || typeof series.ticker !== 'string' || series.ticker.toUpperCase() !== ticker) throw new Error('行情接口返回的证券代码与当前标的不一致');
  if (series.meta?.requestedAsOf !== asOf) throw new Error('行情接口返回的研究截止日与当前请求不一致');
  if (series.meta?.period !== period) throw new Error('行情接口返回的区间与当前请求不一致');
  if (series.meta?.adjustment !== adjustment) throw new Error('行情接口未返回请求的复权口径');
  if (series.points?.some(point => point.date > asOf)) throw new Error('行情记录晚于研究截止日');
  if (series.benchmark != null && (/^\d{5}\.HK$/.test(ticker) ? series.benchmark.system !== 'HSI' : series.benchmark.system !== 'SW2021')) throw new Error('行情基准与证券市场不匹配');
  return series;
}

export function assertQuoteContext(quote, { ticker, asOf }) {
  if (!quote || quote.ticker !== ticker || quote.requestedAsOf !== asOf || !validDate(quote.asOf) || quote.asOf > asOf) throw new Error('行情快照与当前证券代码或研究截止日不一致');
  if (quote.valuationAsOf != null && (!validDate(quote.valuationAsOf) || quote.valuationAsOf > asOf)) throw new Error('估值日期晚于研究截止日或格式无效');
  if (/^\d{5}\.HK$/.test(ticker) && quote.valuationAsOf != null && quote.valuationAsOf !== quote.asOf) throw new Error('港股估值日期与当前收盘日不一致');
  return quote;
}

export function assertForecastsContext(forecasts, { ticker, asOf }) {
  if (!forecasts || forecasts.ticker !== ticker || forecasts.asOf !== asOf) throw new Error('卖方预测与当前证券代码或研究截止日不一致');
  if (forecasts.meta?.snapshotDate != null && (!validDate(forecasts.meta.snapshotDate) || forecasts.meta.snapshotDate > asOf)) throw new Error('卖方预测快照晚于研究截止日或格式无效');
  if (forecasts.windowStart != null && (!validDate(forecasts.windowStart) || forecasts.windowStart > asOf)) throw new Error('卖方预测样本窗口无效');
  for (const row of forecasts.rows || []) {
    if (row.asOf != null && (!validDate(row.asOf) || row.asOf > asOf)) throw new Error('卖方预测研报日期晚于研究截止日或格式无效');
    for (const sample of row.samples || []) {
      if (!validDate(sample.reportDate) || sample.reportDate > asOf || (forecasts.windowStart && sample.reportDate < forecasts.windowStart)) throw new Error('卖方预测样本日期超出当前研究窗口');
    }
  }
  return forecasts;
}

export const adapters = {
  attributions: adaptAttributions,
  relations: adaptRelations,
  stocks(response) {
    const data = unwrap(response);
    return data == null ? [] : array(data, '股票搜索').map(item => {
      object(item, '股票记录');
      const market = typeof item.ticker === 'string' && /^\d{6}\.(SH|SZ|BJ)$/.test(item.ticker) ? 'A' : typeof item.ticker === 'string' && /^\d{5}\.HK$/.test(item.ticker) ? 'HK' : null;
      if (!market || (item.market != null && item.market !== market)) throw new Error('股票搜索返回了无效代码或不匹配的市场');
      return { ticker: item.ticker, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.ticker, market };
    });
  },
  profile(response) {
    const data = unwrap(response);
    if (data == null) return null;
    const item = object(data, '公司信息');
    return { name: item.name, ticker: item.ticker, market: item.market, description: item.description, businesses: array(item.businesses ?? [], '业务分类'), sourceUrl: item.sourceUrl,
      ...(item.currency != null ? { currency: item.currency } : {}), ...(item.scope != null ? { scope: item.scope } : {}) };
  },
  quote(response) {
    const data = unwrap(response);
    if (data == null) return null;
    const item = object(data, '行情快照');
    validateHkUnits(item, item.ticker);
    return { ticker: item.ticker, market: item.market, price: finite(item.price, '股价'), currency: item.currency, asOf: item.asOf, requestedAsOf: item.requestedAsOf,
      open: finite(item.open, '开盘价'), high: finite(item.high, '最高价'), low: finite(item.low, '最低价'), previousClose: finite(item.previousClose, '昨收价'),
      change: finite(item.change, '涨跌额'), pctChange: finite(item.pctChange, '涨跌幅'), volume: finite(item.volume, '成交量'), volumeUnit: item.volumeUnit,
      amount: finite(item.amount, '成交额'), amountUnit: item.amountUnit, source: item.source, sourceId: item.sourceId, sourceApi: item.sourceApi, adjustment: item.adjustment, databaseThrough: item.databaseThrough,
      valuationAsOf: optionalDate(item.valuationAsOf, '估值'), valuationStatus: item.valuationStatus, valuationSource: item.valuationSource,
      ...(item.valuationMeta != null ? { valuationMeta: { ...object(item.valuationMeta, '估值元数据') } } : {}),
      peTtm: finite(item.peTtm, 'PE-TTM'), pb: finite(item.pb, 'PB') };
  },
  prices(response) {
    const data = unwrap(response);
    const series = data == null || Array.isArray(data) ? { points: data || [], meta: {} } : object(data, '价格序列');
    const points = array(series.points, '价格记录').map(item => {
      object(item, '价格记录');
      if (!validDate(item.date) || !Object.hasOwn(item, 'close')) throw new Error('价格记录缺少有效日期或收盘价');
      const close = finite(item.close, '收盘价');
      if (close !== null && close <= 0) throw new Error('收盘价应为正数或 null');
      return { date: item.date, value: close, close, open: finite(item.open, '开盘价'), high: finite(item.high, '最高价'), low: finite(item.low, '最低价'), volume: finite(item.volume, '成交量'), amount: finite(item.amount, '成交额'),
        ...(item.source != null ? { source: item.source } : {}), ...(item.sourceApi != null ? { sourceApi: item.sourceApi } : {}) };
    });
    if (points.some((point, index) => index > 0 && point.date <= points[index - 1].date)) throw new Error('价格记录日期须按先后顺序且不重复');
    const meta = series.meta == null ? {} : object(series.meta, '行情元数据');
    validateHkUnits(meta, series.ticker);
    if (meta.adjustment != null && !['none', 'qfq'].includes(meta.adjustment)) throw new Error('行情复权口径无效');
    if (meta.adjustmentStatus != null && !['available', 'partial', 'missing_anchor_factor', 'no_prices'].includes(meta.adjustmentStatus)) throw new Error('行情复权状态无效');
    if (meta.missingFactorCount != null && (!Number.isInteger(meta.missingFactorCount) || meta.missingFactorCount < 0)) throw new Error('缺失复权因子数量无效');
    optionalDate(meta.adjustmentAnchorDate, '复权锚点'); positive(meta.adjustmentAnchorFactor, '复权锚点因子');
    return { ticker: series.ticker, points, meta: { ...meta }, ...(series.benchmark != null ? { benchmark: industryBenchmark(series.benchmark, points, meta.requestedAsOf, /^\d{5}\.HK$/.test(series.ticker)) } : {}) };
  },
  debates(response) {
    const data = unwrap(response);
    if (data == null) return null;
    const report = object(data, '分歧报告');
    if (typeof report.ticker !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(report.asOf)) throw new Error('分歧报告缺少证券代码或研究截止日');
    const text = value => typeof value === 'string' ? value : '';
    const sources = array(report.sources ?? [], '来源').map(source => {
      object(source, '来源记录');
      if (typeof source.id !== 'string' || !source.id) throw new Error('来源记录缺少编号');
      return { ...source, title: text(source.title), author: text(source.author), url: text(source.url), publishedAt: text(source.publishedAt) || null, qualityLabel: source.platform === 'xueqiu' ? '低质量引用' : text(source.qualityLabel), citationVerified: source.citationVerified === true };
    });
    const ids = new Set(sources.map(source => source.id));
    if (ids.size !== sources.length) throw new Error('来源编号重复');
    const side = value => {
      const item = object(value, '正反方观点');
      if (!['source_view', 'model_inference', 'insufficient'].includes(item.evidenceStatus)) throw new Error('观点缺少有效的证据标记');
      const sourceIds = array(item.sourceIds ?? [], '观点来源编号');
      if (sourceIds.some(id => !ids.has(id))) throw new Error('观点引用了不存在的来源编号');
      return { summary: text(item.summary), evidenceStatus: item.evidenceStatus, sourceIds };
    };
    const debates = array(report.debates ?? [], '核心分歧').map(item => {
      object(item, '分歧记录');
      if (!item.title || !['documented_disagreement', 'research_hypothesis', 'insufficient_evidence'].includes(item.status)) throw new Error('分歧记录缺少标题或有效状态');
      return { ...item, summary: text(item.summary), bull: side(item.bull), bear: side(item.bear), metrics: array(item.metrics ?? [], '验证指标').map(text) };
    });
    if (debates.length > 3) throw new Error('分歧报告最多展示 3 个核心问题');
    return { ...report, summary: text(report.summary), company: object(report.company ?? {}, '公司识别'), debates, sources, coverage: array(report.coverage ?? [], '平台覆盖'), limitations: array(report.limitations ?? [], '研究限制').map(text) };
  },
  forecasts(response) {
    const data = unwrap(response);
    if (data == null) return null;
    const result = Array.isArray(data) ? { rows: data, meta: {} } : object(data, '卖方预测');
    const market = result.ticker == null ? null : /^\d{6}\.(SH|SZ|BJ)$/.test(result.ticker) ? 'A' : /^\d{5}\.HK$/.test(result.ticker) ? 'HK' : null;
    if ((result.ticker != null && !market) || (result.market != null && result.market !== market)) throw new Error('卖方预测返回了无效代码或不匹配的市场');
    const integer = (value, label) => {
      if (value != null && (!Number.isInteger(value) || value < 0)) throw new Error(`${label}无效`);
      return value ?? null;
    };
    const text = value => typeof value === 'string' ? value : '';
    const metadata = item => {
      const values = {};
      for (const name of ['currency', 'unit', 'basis', 'source', 'sourceUrl']) {
        if (!Object.hasOwn(item, name)) continue;
        if (item[name] != null && (typeof item[name] !== 'string' || !item[name].trim())) throw new Error('卖方预测币种、单位、口径或来源无效');
        values[name] = item[name]?.trim() ?? null;
      }
      return values;
    };
    const rows = array(result.rows, 'EPS 情景').map(item => {
      object(item, 'EPS 情景记录');
      if (typeof item.fiscalYear !== 'string' || !item.fiscalYear) throw new Error('EPS 情景缺少财年');
      if (item.fiscalPeriod != null && !/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(item.fiscalPeriod)) throw new Error('EPS 财年或结束月份无效');
      const estimate = name => {
        if (item[name] == null) return null;
        const value = object(item[name], 'EPS');
        return { ...value, value: finite(value.value, 'EPS'), brokers: array(value.brokers ?? [], '券商名称').map(text).filter(Boolean) };
      };
      const samples = array(item.samples ?? [], '券商预测样本').map(sample => {
        object(sample, '券商预测记录');
        return { ...sample, ...metadata(sample), broker: text(sample.broker), author: text(sample.author), reportDate: text(sample.reportDate), title: text(sample.title),
          eps: finite(sample.eps, '预测 EPS'), pe: finite(sample.pe, '预测 PE'), netProfit: finite(sample.netProfit, '预测净利润'),
          rating: text(sample.rating), period: text(sample.period), sourceUrl: text(sample.sourceUrl) || null };
      });
      return { ...item, ...metadata(item), sampleSize: integer(item.sampleSize, 'EPS 样本数'), low: estimate('low'), consensus: estimate('consensus'), high: estimate('high'), median: finite(item.median, 'EPS 中位数'), samples };
    });
    const meta = result.meta == null ? {} : object(result.meta, '卖方预测元数据');
    for (const name of ['rawRowCount', 'reportCount', 'brokerCount', 'excludedCount']) integer(meta[name], '预测记录数');
    return { ...result, ...metadata(result), windowDays: integer(result.windowDays, '预测窗口天数'), rows, meta: { ...meta } };
  },
  bands(response) {
    return adaptValuationBands(unwrap(response));
  },
  events(response) {
    return adaptEvents(unwrap(response));
  },
};
