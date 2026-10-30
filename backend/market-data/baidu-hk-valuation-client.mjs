import { normalizeTradeDate } from './postgres-store.mjs';

const ENDPOINT = 'https://finance.baidu.com/opendata';
const PERIOD = '近三年';
const METRICS = { peTtm: '市盈率(TTM)', pb: '市净率' };
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export class BaiduHkValuationError extends Error {
  constructor(message, { kind = 'invalid_response', retryable = false } = {}) {
    super(message); this.name = 'BaiduHkValuationError'; this.kind = kind; this.retryable = retryable;
  }
}
const invalid = message => new BaiduHkValuationError(message);
const configuration = () => new BaiduHkValuationError('百度港股估值代码、日期范围或客户端配置无效。', { kind: 'configuration' });
function requestRange({ ticker, startDate, endDate, allowPartialMetrics = false, allowEmpty = false } = {}) {
  if (typeof ticker !== 'string' || !/^\d{5}\.HK$/.test(ticker)) throw configuration();
  if (typeof allowPartialMetrics !== 'boolean' || typeof allowEmpty !== 'boolean') throw configuration();
  let start, end;
  try { start = normalizeTradeDate(startDate); end = normalizeTradeDate(endDate); } catch { throw configuration(); }
  const days = (Date.parse(`${end.iso}T00:00:00Z`) - Date.parse(`${start.iso}T00:00:00Z`)) / 86400000 + 1;
  if (days < 1 || days > 366) throw configuration();
  return { ticker, code: ticker.slice(0, 5), start, end, allowPartialMetrics, allowEmpty };
}
function numeric(value) {
  // These are explicit upstream missing values, never a substitute for a failed request or missing date.
  if (value === null || ['--', '-', ''].includes(value)) return null;
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && (value.length > 64 || !DECIMAL.test(value)))
    || !Number.isFinite(Number(value))) throw invalid('百度港股估值须为有效数值或明确缺失值。');
  return value;
}
function normalizeResponse(body, range, tag) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.ResultCode !== 0 || !Array.isArray(body.Result)
    || body.Result.length !== 1) throw invalid('百度港股估值接口返回失败或数据结构无效。');
  const result = body.Result[0]?.DisplayData?.resultData?.tplData?.result;
  if (!result || result.code !== range.code) throw invalid('百度港股估值代码与请求不一致。');
  const chart = result.chartInfo?.[0];
  if (!Array.isArray(result.chartInfo) || result.chartInfo.length !== 1 || !chart
    || !Array.isArray(chart.header) || chart.header.length !== 1 || chart.header[0] !== tag
    || !Array.isArray(chart.dimensions) || chart.dimensions.length !== 2
    || chart.dimensions[0] !== 'date' || chart.dimensions[1] !== 'curTagValue'
    || ![PERIOD, '全部'].includes(chart.type) || chart.unit !== '' || !Array.isArray(chart.body) || chart.body.length > 1200) {
    throw invalid('百度港股估值指标、周期、单位或日期数组无效。');
  }
  let releaseDate = null;
  if (chart.body.length || ![undefined, null, ''].includes(chart.releaseDate)) {
    if (typeof chart.releaseDate !== 'string' || !/^\d{4}-\d{2}-\d{2} 00:00:00$/.test(chart.releaseDate)) throw invalid('百度港股估值上市日期无效。');
    try { releaseDate = normalizeTradeDate(chart.releaseDate.slice(0, 10)); } catch { throw invalid('百度港股估值上市日期无效。'); }
  }
  const dates = new Map();
  for (const point of chart.body) {
    if (!Array.isArray(point) || point.length !== 2 || typeof point[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(point[0])) throw invalid('百度港股估值日期或字段数量无效。');
    let date;
    try { date = normalizeTradeDate(point[0]).compact; } catch { throw invalid('百度港股估值日期无效。'); }
    if (dates.has(date) || date < releaseDate.compact) throw invalid('百度港股估值日期重复或早于上市日期。');
    dates.set(date, numeric(point[1]));
  }
  const all = [...dates.keys()].sort(), requested = all.filter(date => date >= range.start.compact && date <= range.end.compact);
  // Recently listed securities are returned as 全部 even when 近三年 is requested.
  // Only accept that fallback when it truly starts at the reported listing date.
  if (chart.type === '全部' && all.length && all[0] !== releaseDate.compact) throw invalid('百度港股全部历史估值未覆盖上市日起点。');
  return { dates, requested, coverage: { firstDate: all[0] ?? null, lastDate: all.at(-1) ?? null, count: all.length,
    requestedFirstDate: requested[0] ?? null, requestedLastDate: requested.at(-1) ?? null, requestedCount: requested.length,
    releaseDate: releaseDate?.compact ?? null, missingValueCount: requested.filter(date => dates.get(date) === null).length,
    ...(!requested.length ? { noDataEvidence: all.length ? 'identified_metric_chart_has_no_dates_in_requested_window' : 'identified_metric_chart_body_empty' } : {}) } };
}

/** Direct, separately labelled PE-TTM and PB history from the endpoint used by AKShare stock_hk_valuation_baidu. */
export function createBaiduHkValuationClient({ fetchImpl = globalThis.fetch, intervalMs = 1000, timeoutMs = 15000,
  maxRetries = 1, retryBaseMs = 1000, sleep = wait, now = Date.now, concurrency = 1 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof now !== 'function'
    || !Number.isInteger(intervalMs) || intervalMs < 0 || !Number.isInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3
    || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5 || !Number.isInteger(retryBaseMs) || retryBaseMs < 0) throw configuration();
  const startIntervalMs = concurrency > 1 ? Math.max(intervalMs, 1000) : intervalMs, waiting = [];
  let startGate = Promise.resolve(), lastStarted = -Infinity, active = 0, stopped = null;
  function startRequest() {
    const pending = startGate.then(async () => {
      if (stopped) throw stopped;
      const pause = Math.max(0, lastStarted + startIntervalMs - now()); if (pause) await sleep(pause);
      if (stopped) throw stopped;
      lastStarted = now();
    });
    startGate = pending.catch(() => {}); return pending;
  }
  async function request(range, metric, tag) {
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({ openapi: '1', dspName: 'iphone', tn: 'tangram', client: 'app', query: tag,
      code: range.code, word: '', resource_id: '51171', market: 'hk', tag, chart_select: PERIOD,
      industry_select: '', skip_industry: '1', finClientType: 'pc' }).toString();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await startRequest();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs); let failure;
      try {
        const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response || !Number.isInteger(response.status)) throw invalid('百度港股估值 HTTP 响应结构无效。');
        if ([429, 403].includes(response.status)) {
          stopped = new BaiduHkValuationError('百度港股估值请求受限，本次采集已停止，请稍后检查访问状态。', { kind: response.status === 429 ? 'rate_limit' : 'permission' });
          throw stopped;
        }
        if (response.status >= 500) throw new BaiduHkValuationError('百度港股估值服务暂时不可用。', { kind: 'upstream', retryable: true });
        if (response.status < 200 || response.status >= 300) throw new BaiduHkValuationError('百度港股估值 HTTP 请求失败。', { kind: 'http' });
        let body;
        try { body = await response.json(); } catch {
          if (controller.signal.aborted) throw new BaiduHkValuationError('百度港股估值请求超时。', { kind: 'timeout', retryable: true });
          throw invalid('百度港股估值返回不可解析的 JSON。');
        }
        return { ...normalizeResponse(body, range, tag), raw: { request: { url: url.href, metric, tag }, response: body } };
      } catch (error) {
        failure = error instanceof BaiduHkValuationError ? error : new BaiduHkValuationError(controller.signal.aborted ? '百度港股估值请求超时。' : '无法连接百度港股估值服务。', { kind: controller.signal.aborted ? 'timeout' : 'network', retryable: true });
      } finally { clearTimeout(timer); }
      if (!failure.retryable || attempt === maxRetries) throw failure;
      await sleep(Math.min(30000, retryBaseMs * 2 ** attempt));
    }
  }
  async function collectRange(range) {
    const pe = await request(range, 'pe_ttm', METRICS.peTtm), pb = await request(range, 'pb', METRICS.pb);
    const metricStatus = { pe_ttm: pe.requested.length ? 'available' : 'no_data', pb: pb.requested.length ? 'available' : 'no_data' };
    const noData = !pe.requested.length && !pb.requested.length;
    if ((!pe.requested.length || !pb.requested.length) && !range.allowPartialMetrics && !(noData && range.allowEmpty)
      || noData && !range.allowEmpty) throw new BaiduHkValuationError('百度未返回请求区间内完整的港股历史估值。', { kind: 'no_data' });
    const releaseDateMismatch = !!(pe.coverage.releaseDate && pb.coverage.releaseDate && pe.coverage.releaseDate !== pb.coverage.releaseDate);
    // Baidu can attach different old releaseDate metadata to PE and PB for
    // the same code (observed 00065: 2001-08-30 vs 2002-03-18). Each chart's
    // identity/date bounds remain validated independently. All-market mode
    // must not discard an identical current date series for that old metadata.
    if (releaseDateMismatch && !range.allowPartialMetrics) throw invalid('百度港股 PE-TTM 与 PB 的上市日期不一致。');
    const sameDates = pe.requested.length === pb.requested.length && pe.requested.every((date, index) => date === pb.requested[index]);
    if (!range.allowPartialMetrics && !sameDates) {
      throw new BaiduHkValuationError('百度港股 PE-TTM 与 PB 的日期覆盖不一致。', { kind: 'incomplete_window' });
    }
    const requested = [...new Set([...pe.requested, ...pb.requested])].sort();
    const partial = !noData && (!sameDates || !pe.requested.length || !pb.requested.length);
    return { rows: requested.map(date => ({ ts_code: range.ticker, trade_date: date, pe_ttm: pe.dates.has(date) ? pe.dates.get(date) : null, pb: pb.dates.has(date) ? pb.dates.get(date) : null })),
      source: 'baidu', apiName: 'baidu_hk_valuation', sourceUrl: 'https://finance.baidu.com',
      coverage: { kind: noData ? 'no_data' : partial ? 'partial_metrics' : 'available', metricStatus,
        ...(noData ? { noDataEvidence: 'both_metric_charts_explicitly_empty_in_requested_window' } : {}),
        ...(releaseDateMismatch ? { metricReleaseDateMismatch: true } : {}),
        missingDateCount: { pe_ttm: requested.filter(date => !pe.dates.has(date)).length, pb: requested.filter(date => !pb.dates.has(date)).length } },
      raw: { request: { ticker: range.ticker, startDate: range.start.compact, endDate: range.end.compact, chartSelect: PERIOD },
        peTtm: pe.raw, pb: pb.raw, metricDateCoverage: { pe_ttm: pe.coverage, pb: pb.coverage },
        methodology: { pe_ttm: 'upstream_reported_pe_ttm', pb: 'upstream_reported_pb', dates: 'upstream_calendar_dates_no_fill',
          tradingDayFilter: 'caller_must_intersect_with_actual_hk_daily_prices', negativesAndZero: 'preserved',
          missingValues: 'explicit_upstream_null_or_placeholder_or_absent_metric_date_after_valid_response_only', history: 'three_year_daily_payload_filtered_to_requested_max_366_days' },
        units: { pe_ttm: 'multiple', pb: 'multiple' } } };
  }
  function pump() {
    while (active < concurrency && waiting.length) {
      const task = waiting.shift(); active++;
      collectRange(task.range).then(task.resolve, task.reject).finally(() => { active--; pump(); });
    }
  }
  return { collect(options) {
    let range;
    try { range = requestRange(options); } catch (error) { return Promise.reject(error instanceof BaiduHkValuationError ? error : configuration()); }
    if (stopped) return Promise.reject(stopped);
    return new Promise((resolve, reject) => { waiting.push({ range, resolve, reject }); pump(); });
  } };
}
