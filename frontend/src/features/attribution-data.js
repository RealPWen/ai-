export const attributionPeriods = ['1m', '6m', '1y'];
export const attributionPeriodNames = { '1m': '1个月', '6m': '6个月', '1y': '1年' };
const unwrap = value => value && Object.hasOwn(value, 'data') ? value.data : value;
const supported = value => typeof value === 'string' && /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const obj = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = value => typeof value === 'string' ? value : '';
const stamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && date(value.slice(0, 10)) && !Number.isNaN(Date.parse(value));

export function adaptAttributionJob(response, context) {
  const value = unwrap(response);
  if (value == null) return null;
  if (!obj(value) || !supported(value.ticker) || !text(value.jobId).trim() || !date(value.requestedAsOf)
    || !['running', 'succeeded', 'partial', 'failed'].includes(value.status) || !obj(value.periods)
    || (context && value.ticker !== context.ticker)) throw new Error('涨跌归因任务的标的或状态无效。');
  const periods = {};
  for (const [period, item] of Object.entries(value.periods)) {
    if (!attributionPeriods.includes(period) || !obj(item) || !['queued', 'running', 'succeeded', 'failed'].includes(item.status)) throw new Error('归因周期任务状态无效。');
    periods[period] = { ...item, stage: text(item.stage), error: item.error ? { code: text(item.error.code), message: text(item.error.message) } : null };
  }
  if (!Object.keys(periods).length) throw new Error('涨跌归因任务缺少周期。');
  return { ...value, periods, stage: text(value.stage) };
}
function metrics(value, ticker, period) {
  if (!obj(value) || !date(value.from) || !date(value.to) || value.from >= value.to
    || ![value.stockReturn, value.indexReturn, value.excessPercentagePoints].every(finite)
    || !obj(value.benchmark) || !text(value.benchmark.industryName).trim()
    || (value.ticker != null && value.ticker !== ticker) || (value.period != null && value.period !== period)) throw new Error('归因比较区间或涨跌数据无效。');
  if (Math.abs((value.stockReturn - value.indexReturn) * 100 - value.excessPercentagePoints) > 0.00001) throw new Error('归因超额涨跌幅与计算结果不一致。');
  const hk = ticker.endsWith('.HK');
  if (hk ? value.benchmark.system !== 'HSI' || value.benchmark.indexCode !== 'HSI' : value.benchmark.system !== 'SW2021') throw new Error('归因基准与证券市场不匹配。');
  return { ...value, benchmark: { ...value.benchmark }, ...(obj(value.coverage) ? { coverage: { ...value.coverage } } : {}) };
}
function report(value, ticker, period) {
  if (value == null) return null;
  const result = metrics(value, ticker, period);
  if (value.ticker !== ticker || value.period !== period || !date(value.requestedAsOf) || value.to > value.requestedAsOf || !stamp(value.generatedAt)
    || !text(value.summary).trim() || !Array.isArray(value.drivers) || !Array.isArray(value.sources) || !Array.isArray(value.limitations)) throw new Error('涨跌归因报告格式或身份无效。');
  const newsSummary = value.evidenceMode === 'news_summary';
  if (value.newsWindow != null && (!obj(value.newsWindow) || !date(value.newsWindow.from) || !date(value.newsWindow.to)
    || value.newsWindow.from > value.newsWindow.to || value.newsWindow.to > value.requestedAsOf)) throw new Error('归因新闻时间窗口无效。');
  if (value.sector != null && (!obj(value.sector) || typeof value.sector.known !== 'boolean'
    || (value.sector.known && !text(value.sector.name).trim()))) throw new Error('归因板块信息无效。');
  if (value.newsCoverage != null && (!obj(value.newsCoverage)
    || ![value.newsCoverage.stock, value.newsCoverage.sector].every(count => Number.isInteger(count) && count >= 0))) throw new Error('归因新闻覆盖数量无效。');
  const sources = value.sources.map(source => {
    if (!obj(source) || !text(source.id).trim()) throw new Error('归因来源缺少编号。');
    if (source.newsKinds != null && (!Array.isArray(source.newsKinds) || source.newsKinds.some(kind => !['stock', 'sector'].includes(kind)))) throw new Error('归因新闻分类无效。');
    return { ...source, id: source.id, title: text(source.title), url: text(source.url), publishedAt: text(source.publishedAt) || null,
      ...(source.newsKinds ? { newsKinds: [...source.newsKinds] } : {}) };
  });
  const ids = new Set(sources.map(item => item.id));
  if (ids.size !== sources.length) throw new Error('归因来源编号重复。');
  const drivers = value.drivers.map(driver => {
    if (!obj(driver) || !text(driver.title).trim() || !text(driver.explanation).trim() || !Array.isArray(driver.evidence)) throw new Error('归因原因缺少说明或证据。');
    const evidence = driver.evidence.map(item => {
      if (!obj(item) || !ids.has(item.sourceId) || (newsSummary ? item.citationVerified !== true : !text(item.quote).trim())) throw new Error('归因原因引用了无效来源。');
      return { sourceId: item.sourceId, ...(text(item.quote).trim() ? { quote: item.quote } : {}),
        ...(item.citationVerified != null ? { citationVerified: item.citationVerified } : {}) };
    });
    return { ...driver, evidence };
  });
  return { ...result, sources, drivers, limitations: value.limitations.map(text),
    ...(value.newsWindow ? { newsWindow: { ...value.newsWindow } } : {}),
    ...(value.sector ? { sector: { ...value.sector } } : {}),
    ...(value.newsCoverage ? { newsCoverage: { ...value.newsCoverage } } : {}) };
}

export function adaptAttributions(response) {
  const value = unwrap(response);
  if (!obj(value) || !supported(value.ticker) || !date(value.requestedAsOf) || !obj(value.periods) || typeof value.historical !== 'boolean') throw new Error('涨跌归因返回的标的或数据日期无效。');
  const periods = {};
  for (const period of attributionPeriods) {
    const item = value.periods[period];
    if (!obj(item) || !['missing', 'fresh', 'stale', 'unavailable'].includes(item.freshness)) throw new Error('涨跌归因数据状态无效。');
    periods[period] = { ...item, reason: text(item.reason) || null, report: report(item.report, value.ticker, period), currentMetrics: item.currentMetrics == null ? null : metrics(item.currentMetrics, value.ticker, period) };
  }
  return { ...value, periods, job: adaptAttributionJob(value.job, value) };
}
export function assertAttributionsContext(data, context) {
  if (!data || data.ticker !== context.ticker || data.requestedAsOf !== context.asOf) throw new Error('涨跌归因与当前股票或数据日期不一致。');
  for (const period of attributionPeriods) {
    const item = data.periods?.[period];
    if (item?.currentMetrics?.to > context.asOf || (!data.historical && item?.report?.requestedAsOf > context.asOf)) throw new Error('归因行情或报告晚于当前数据日期。');
  }
  return data;
}
