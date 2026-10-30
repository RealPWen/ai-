import { normalizeTradeDate } from './postgres-store.mjs';

const ENDPOINT = 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export class TencentHkError extends Error {
  constructor(message, { kind = 'invalid_response', retryable = false } = {}) {
    super(message); this.name = 'TencentHkError'; this.kind = kind; this.retryable = retryable;
  }
}
function invalid(message) { return new TencentHkError(message); }
function configuration() { return new TencentHkError('腾讯港股代码、日期范围或客户端配置无效。', { kind: 'configuration' }); }
function requestRange({ ticker, startDate, endDate, currency = 'HKD' }) {
  if (typeof ticker !== 'string' || !/^\d{5}\.HK$/.test(ticker)) throw configuration();
  if (!['HKD', 'USD'].includes(currency)) throw configuration();
  let start, end;
  try { start = normalizeTradeDate(startDate); end = normalizeTradeDate(endDate); } catch { throw configuration(); }
  const startMs = Date.parse(`${start.iso}T00:00:00Z`), endMs = Date.parse(`${end.iso}T00:00:00Z`);
  const days = Math.round((endMs - startMs) / 86400000) + 1;
  // The buffered annual window plus previous-close padding stays below the
  // endpoint's 640-bar cap even if every calendar day contained an observation.
  if (days < 1 || days > 400) throw configuration();
  const requestedStart = normalizeTradeDate(new Date(startMs - 10 * 86400000).toISOString().slice(0, 10));
  return { ticker, code: ticker.slice(0, 5), symbol: `hk${ticker.slice(0, 5)}`, currency,
    amountUnit: currency.toLowerCase(), start, end, requestedStart, maxBars: days + 10 };
}
function numeric(value, field) {
  if (value === null) return null;
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && (value.length > 64 || !DECIMAL.test(value)))
    || !Number.isFinite(Number(value)) || Number(value) < 0 || (field === 'volume' && !Number.isSafeInteger(Number(value)))) throw invalid(`腾讯港股字段 ${field} 须为非负有效数值或 null。`);
  return value;
}
function normalizeResponse(body, range, allowEmpty) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.code !== 0) throw invalid('腾讯港股接口返回失败或数据结构无效。');
  const data = body.data?.[range.symbol], identity = data?.qt?.[range.symbol];
  if (!data || !Array.isArray(identity) || !['100', 100].includes(identity[0]) || typeof identity[1] !== 'string'
    || !identity[1].trim() || identity[2] !== range.code) throw invalid('腾讯港股代码或市场标识与请求不一致。');
  if ((identity[75] && identity[75] !== range.currency) || (range.currency === 'USD' && identity[75] !== 'USD')) throw invalid('腾讯港股行情币种与上市柜台不一致。');
  // The raw endpoint's day array is required. Never substitute qfqday/hfqday.
  if (!Array.isArray(data.day) || data.day.length > Math.min(640, range.maxBars)) throw invalid('腾讯未复权日线数组缺失或条数超出请求范围。');
  if (!data.day.length && !allowEmpty) throw new TencentHkError('腾讯未返回该港股日期范围内的行情。', { kind: 'no_data' });
  const seen = new Set();
  const bars = data.day.map(values => {
    if (!Array.isArray(values) || values.length < 6 || values.length > 12 || typeof values[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(values[0])) throw invalid('腾讯港股日线字段数量或日期格式无效。');
    let date;
    try { date = normalizeTradeDate(values[0]).compact; } catch { throw invalid('腾讯港股日线日期无效。'); }
    if (date < range.requestedStart.compact || date > range.end.compact || seen.has(date)) throw invalid('腾讯港股日期重复或超出请求范围。');
    seen.add(date);
    return { trade_date: date, open: numeric(values[1], 'open'), close: numeric(values[2], 'close'), high: numeric(values[3], 'high'),
      low: numeric(values[4], 'low'), vol: numeric(values[5], 'volume') };
  }).sort((a, b) => a.trade_date.localeCompare(b.trade_date));
  let previousClose = null, skippedNullCloseBars = 0; const rows = [];
  for (const bar of bars) {
    if (bar.close === null) { skippedNullCloseBars++; continue; }
    if (bar.trade_date >= range.start.compact) {
      const change = previousClose === null ? null : Number(bar.close) - Number(previousClose);
      const pctChg = previousClose === null || Number(previousClose) === 0 ? null : change / Number(previousClose) * 100;
      if ((change !== null && !Number.isFinite(change)) || (pctChg !== null && !Number.isFinite(pctChg))) throw invalid('腾讯港股派生涨跌字段超出有效数值范围。');
      rows.push({ ts_code: range.ticker, ...bar, pre_close: previousClose, change, pct_chg: pctChg, amount: null });
    }
    previousClose = bar.close;
  }
  if (!rows.length && !allowEmpty) throw new TencentHkError('腾讯未返回该港股日期范围内的有效收盘行情。', { kind: 'no_data' });
  return { rows, skippedNullCloseBars };
}

/** Unadjusted day mapping follows AKShare stock_zh_ah_daily(adjust=''). */
export function createTencentHkClient({ fetchImpl = globalThis.fetch, intervalMs = 2000, timeoutMs = 15000,
  maxRetries = 1, retryBaseMs = 1000, sleep = wait, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof now !== 'function'
    || !Number.isInteger(intervalMs) || intervalMs < 0 || !Number.isInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5 || !Number.isInteger(retryBaseMs) || retryBaseMs < 0) throw configuration();
  let queue = Promise.resolve(), lastStarted = -Infinity;
  async function request(range, allowEmpty) {
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({ param: `${range.symbol},day,${range.requestedStart.iso},${range.end.iso},640,` }).toString();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const pause = Math.max(0, lastStarted + intervalMs - now()); if (pause) await sleep(pause);
      lastStarted = now();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs); let failure;
      try {
        const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response || !Number.isInteger(response.status)) throw invalid('腾讯港股 HTTP 响应结构无效。');
        if (response.status === 429 || response.status >= 500) throw new TencentHkError('腾讯港股服务暂时不可用或请求频率受限。', { kind: response.status === 429 ? 'rate_limit' : 'upstream', retryable: true });
        if ([401, 403].includes(response.status)) throw new TencentHkError('腾讯港股服务拒绝访问。', { kind: response.status === 401 ? 'authentication' : 'permission' });
        if (response.status < 200 || response.status >= 300) throw new TencentHkError('腾讯港股 HTTP 请求失败。', { kind: 'http' });
        let body;
        try { body = await response.json(); } catch {
          if (controller.signal.aborted) throw new TencentHkError('腾讯港股请求超时。', { kind: 'timeout', retryable: true });
          throw invalid('腾讯港股返回不可解析的 JSON。');
        }
        const { rows, skippedNullCloseBars } = normalizeResponse(body, range, allowEmpty);
        return { rows, source: 'tencent', apiName: 'tencent_hk_daily', adjustment: 'none', volumeUnit: 'share', amountUnit: range.amountUnit, currency: range.currency,
          raw: { request: { url: url.href, ticker: range.ticker, startDate: range.start.compact, endDate: range.end.compact,
            requestedStartDate: range.requestedStart.compact, countLimit: 640, previousClosePaddingCalendarDays: 10 }, response: body,
            derivations: { pre_close: 'previous_non_null_day_close', change: 'day_close_minus_previous_day_close',
              pct_chg: 'change_divided_by_previous_day_close_times_100', amount: 'unavailable_null', missingPreviousClose: 'null', ohlc: 'raw_day_without_fq' },
            sourceEmpty: rows.length === 0, skippedNullCloseBars, units: { volume: 'share', amount: range.amountUnit, currency: range.currency }, adjustment: 'none' } };
      } catch (error) {
        failure = error instanceof TencentHkError ? error : new TencentHkError(controller.signal.aborted ? '腾讯港股请求超时。' : '无法连接腾讯港股行情服务。', { kind: controller.signal.aborted ? 'timeout' : 'network', retryable: true });
      } finally { clearTimeout(timer); }
      if (!failure.retryable || attempt === maxRetries) throw failure;
      await sleep(Math.min(30000, retryBaseMs * 2 ** attempt));
    }
  }
  return { collectDaily(options) {
    let range;
    try { if (options?.allowEmpty !== undefined && typeof options.allowEmpty !== 'boolean') throw configuration(); range = requestRange(options); } catch (error) { return Promise.reject(error instanceof TencentHkError ? error : configuration()); }
    const pending = queue.then(() => request(range, options.allowEmpty === true)); queue = pending.catch(() => {}); return pending;
  } };
}
const defaultClient = createTencentHkClient();
export function collectTencentHkDaily(options) { return defaultClient.collectDaily(options); }
