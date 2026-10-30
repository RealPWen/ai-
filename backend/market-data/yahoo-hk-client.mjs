import { normalizeTradeDate } from './postgres-store.mjs';
import { PRICE_HISTORY_LOOKBACK_DAYS } from './price-history-window.mjs';

const ENDPOINT = 'https://query2.finance.yahoo.com/v8/finance/chart/';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hkDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' });

export class YahooHkError extends Error {
  constructor(message, { kind = 'invalid_response', retryable = false } = {}) {
    super(message); this.name = 'YahooHkError'; this.kind = kind; this.retryable = retryable;
  }
}
function invalid(message) { return new YahooHkError(message); }
function configuration() { return new YahooHkError('Yahoo 港股代码、日期范围或客户端配置无效。', { kind: 'configuration' }); }

function requestRange({ ticker, startDate, endDate }, { queryMode, rangePeriod, currentTime }) {
  if (typeof ticker !== 'string' || !/^\d{5}\.HK$/.test(ticker)) throw configuration();
  let start, end;
  try { start = normalizeTradeDate(startDate); end = normalizeTradeDate(endDate); } catch { throw configuration(); }
  if (start.compact > end.compact) throw configuration();
  const startMs = Date.parse(`${start.iso}T00:00:00+08:00`), endMs = Date.parse(`${end.iso}T00:00:00+08:00`);
  const days = Math.round((endMs - startMs) / 86400000) + 1;
  if (days > 10000) throw configuration();
  const range = { ticker, symbol: `${String(Number(ticker.slice(0, 5))).padStart(4, '0')}.HK`, start, end, queryMode, rangePeriod,
    period1: Math.floor(startMs / 1000) - 10 * 86400, period2: Math.floor(endMs / 1000) + 2 * 86400, maxBars: days + 11 };
  if (queryMode === 'range') {
    if (!Number.isFinite(currentTime)) throw configuration();
    const today = normalizeTradeDate(hkDate.format(new Date(currentTime)));
    const yearAgo = new Date(`${today.iso}T00:00:00Z`); yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
    // A named 1y response cannot supply the extra trading-close buffer. A 2y
    // response can; the annual and baseline lookup bounds stay explicit.
    if (rangePeriod === '2y') yearAgo.setUTCDate(yearAgo.getUTCDate() - PRICE_HISTORY_LOOKBACK_DAYS);
    if (start.compact < normalizeTradeDate(yearAgo.toISOString().slice(0, 10)).compact || end.compact > today.compact
      || days > (rangePeriod === '2y' ? 400 : 366)) throw configuration();
    const todayMs = Date.parse(`${today.iso}T00:00:00+08:00`);
    // A small tolerance accommodates source trading calendars and differing
    // definitions of a trailing year; logical request bounds stay strict.
    range.sourceMinTimestamp = Math.floor(todayMs / 1000) - ((rangePeriod === '2y' ? 2 : 1) * 366 + 15) * 86400;
    range.sourceMaxTimestamp = Math.floor(todayMs / 1000) + 86400;
    range.maxBars = 800;
  }
  return range;
}

function numeric(value, field) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
    || (field === 'volume' && !Number.isSafeInteger(value))) throw invalid(`Yahoo 港股字段 ${field} 须为非负有效数值或 null。`);
  return value;
}

function normalizeResponse(body, range) {
  const chart = body?.chart;
  if (!chart || typeof chart !== 'object' || Array.isArray(chart) || chart.error !== null) throw invalid('Yahoo 港股接口返回失败或数据结构无效。');
  if (!Array.isArray(chart.result) || chart.result.length !== 1) throw new YahooHkError('Yahoo 未返回该港股日期范围内的行情。', { kind: 'no_data' });
  const result = chart.result[0], meta = result?.meta;
  if (!meta || meta.symbol !== range.symbol || meta.exchangeName !== 'HKG' || meta.currency !== 'HKD'
    || !Array.isArray(result.timestamp) || result.timestamp.length > range.maxBars
    || !Array.isArray(result.indicators?.quote) || result.indicators.quote.length !== 1) throw invalid('Yahoo 港股标的、交易所、货币或行情条数与请求不一致。');
  if (result.events !== undefined && (!result.events || typeof result.events !== 'object' || Array.isArray(result.events))) throw invalid('Yahoo 港股公司行动数据格式无效。');
  // Yahoo quote arrays can already reflect stock splits. Refuse any split in
  // this request window rather than label those historical prices unadjusted.
  if (result.events?.splits !== undefined && (!result.events.splits || typeof result.events.splits !== 'object'
    || Array.isArray(result.events.splits) || Object.keys(result.events.splits).length)) throw invalid('Yahoo 港股窗口含拆股或拆股记录无效，不能作为未复权行情导入。');
  if (!result.timestamp.length) throw new YahooHkError('Yahoo 未返回该港股日期范围内的行情。', { kind: 'no_data' });
  const quote = result.indicators.quote[0], fields = ['open', 'high', 'low', 'close', 'volume'];
  if (!quote || fields.some(field => !Array.isArray(quote[field]) || quote[field].length !== result.timestamp.length)) throw invalid('Yahoo 港股 OHLC 与时间戳数量不一致。');
  const seen = new Set();
  const bars = result.timestamp.map((timestamp, index) => {
    const minTimestamp = range.queryMode === 'range' ? range.sourceMinTimestamp : range.period1;
    const maxTimestamp = range.queryMode === 'range' ? range.sourceMaxTimestamp : range.period2;
    if (!Number.isSafeInteger(timestamp) || timestamp < minTimestamp || timestamp >= maxTimestamp) throw invalid('Yahoo 港股时间戳超出请求范围或格式无效。');
    let date;
    try { date = normalizeTradeDate(hkDate.format(new Date(timestamp * 1000))).compact; } catch { throw invalid('Yahoo 港股交易日期无效。'); }
    if (seen.has(date)) throw invalid('Yahoo 港股日线含重复交易日期。');
    seen.add(date);
    return { timestamp, trade_date: date, ...Object.fromEntries(fields.map(field => [field, numeric(quote[field][index], field)])) };
  }).sort((a, b) => a.timestamp - b.timestamp);
  if (range.queryMode === 'range') {
    const dated = value => {
      if (!Number.isSafeInteger(value) || value <= 0 || value >= range.sourceMaxTimestamp) return null;
      try { return normalizeTradeDate(hkDate.format(new Date(value * 1000))).compact; } catch { return null; }
    };
    const available = bars.filter(bar => bar.close !== null), first = available[0], last = available.at(-1);
    if (!first || !last) throw new YahooHkError('Yahoo 未返回该港股日期范围内的有效收盘行情。', { kind: 'no_data' });
    const ipoDate = dated(meta.firstTradeDate), marketDate = dated(meta.regularMarketTime);
    const ipoLagDays = ipoDate ? (Date.parse(normalizeTradeDate(first.trade_date).iso) - Date.parse(normalizeTradeDate(ipoDate).iso)) / 86400000 : Infinity;
    if (first.trade_date > range.start.compact && !(ipoDate && ipoDate >= range.start.compact && ipoLagDays >= 0 && ipoLagDays <= 10)) throw invalid('Yahoo 宽区间源行情未覆盖逻辑开始日期，不能确认完整。');
    if (!marketDate || (marketDate <= range.end.compact && last.trade_date < marketDate)) throw invalid('Yahoo 宽区间源行情未覆盖已知最近成交日期，不能确认完整。');
  }
  let previousClose = null, skippedNullCloseBars = 0;
  const rows = [];
  for (const bar of bars) {
    if (bar.close === null) { skippedNullCloseBars++; continue; }
    if (bar.trade_date >= range.start.compact && bar.trade_date <= range.end.compact) {
      const change = previousClose === null ? null : bar.close - previousClose;
      const pctChg = previousClose === null || previousClose === 0 ? null : change / previousClose * 100;
      if ((change !== null && !Number.isFinite(change)) || (pctChg !== null && !Number.isFinite(pctChg))) throw invalid('Yahoo 港股派生涨跌字段超出有效数值范围。');
      rows.push({ ts_code: range.ticker, trade_date: bar.trade_date, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        pre_close: previousClose, change, pct_chg: pctChg, vol: bar.volume, amount: null });
    }
    previousClose = bar.close;
  }
  if (!rows.length) throw new YahooHkError('Yahoo 未返回该港股日期范围内的有效收盘行情。', { kind: 'no_data' });
  return { rows, skippedNullCloseBars };
}

/** Read the original quote OHLC arrays. Adjusted-close arrays are never used. */
export function createYahooHkClient({ fetchImpl = globalThis.fetch, intervalMs = 2000, timeoutMs = 15000,
  maxRetries = 1, retryBaseMs = 1000, sleep = wait, now = Date.now, queryMode = 'period', rangePeriod = '2y' } = {}) {
  if (typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof now !== 'function'
    || !Number.isInteger(intervalMs) || intervalMs < 0 || !Number.isInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5 || !Number.isInteger(retryBaseMs) || retryBaseMs < 0
    || !['period', 'range'].includes(queryMode) || !['1y', '2y'].includes(rangePeriod)) throw configuration();
  let queue = Promise.resolve(), lastStarted = -Infinity;
  async function request(range) {
    const url = new URL(`${ENDPOINT}${encodeURIComponent(range.symbol)}`);
    url.search = new URLSearchParams({ ...(queryMode === 'range' ? { range: rangePeriod } : { period1: String(range.period1), period2: String(range.period2) }),
      interval: '1d', events: 'splits', includeAdjustedClose: 'false' }).toString();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const pause = Math.max(0, lastStarted + intervalMs - now()); if (pause) await sleep(pause);
      lastStarted = now();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      let failure;
      try {
        const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response || !Number.isInteger(response.status)) throw invalid('Yahoo 港股 HTTP 响应结构无效。');
        if (response.status === 429 || response.status >= 500) throw new YahooHkError('Yahoo 港股服务暂时不可用或请求频率受限。', { kind: response.status === 429 ? 'rate_limit' : 'upstream', retryable: true });
        if (response.status < 200 || response.status >= 300) throw new YahooHkError('Yahoo 港股 HTTP 请求失败。', { kind: 'http' });
        let body;
        try { body = await response.json(); } catch {
          if (controller.signal.aborted) throw new YahooHkError('Yahoo 港股请求超时。', { kind: 'timeout', retryable: true });
          throw invalid('Yahoo 港股返回不可解析的 JSON。');
        }
        const { rows, skippedNullCloseBars } = normalizeResponse(body, range);
        return { rows, source: 'yahoo', apiName: 'yahoo_hk_daily', adjustment: 'none', volumeUnit: 'share', amountUnit: 'hkd', currency: 'HKD',
          raw: { request: { url: url.href, ticker: range.ticker, symbol: range.symbol, startDate: range.start.compact, endDate: range.end.compact, queryMode,
            ...(queryMode === 'range' ? { range: rangePeriod, validatedSourceMinTimestamp: range.sourceMinTimestamp, validatedSourceMaxTimestamp: range.sourceMaxTimestamp }
              : { period1: range.period1, period2: range.period2, previousClosePaddingCalendarDays: 10, splitDetectionTrailingCalendarDays: 1 }) }, response: body,
            derivations: { pre_close: 'previous_non_null_quote_close', change: 'quote_close_minus_previous_quote_close',
              pct_chg: 'change_divided_by_previous_quote_close_times_100', amount: 'unavailable_null', missingPreviousClose: 'null',
              ohlc: 'original_quote_arrays_without_adjclose', adjustmentValidation: 'no_split_events_in_request_window' }, skippedNullCloseBars,
            units: { volume: 'share', amount: 'hkd', currency: 'HKD' }, adjustment: 'none' } };
      } catch (error) {
        failure = error instanceof YahooHkError ? error : new YahooHkError(controller.signal.aborted ? 'Yahoo 港股请求超时。' : '无法连接 Yahoo 港股行情服务。', { kind: controller.signal.aborted ? 'timeout' : 'network', retryable: true });
      } finally { clearTimeout(timer); }
      if (!failure.retryable || attempt === maxRetries) throw failure;
      await sleep(Math.min(30000, retryBaseMs * 2 ** attempt));
    }
  }
  return { collectDaily(options) {
    let range;
    try { range = requestRange(options, { queryMode, rangePeriod, currentTime: now() }); } catch (error) { return Promise.reject(error instanceof YahooHkError ? error : configuration()); }
    const pending = queue.then(() => request(range)); queue = pending.catch(() => {}); return pending;
  } };
}

// The source must extend beyond one year to supply the prior trading close.
// Validation and logical-date filtering run before any observations are saved.
const defaultClient = createYahooHkClient({ queryMode: 'range', rangePeriod: '2y' });
export function collectYahooHkDaily(options) { return defaultClient.collectDaily(options); }
