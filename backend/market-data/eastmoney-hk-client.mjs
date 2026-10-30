import { normalizeTradeDate } from './postgres-store.mjs';

const ENDPOINT = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const FIELDS1 = 'f1,f2,f3,f4,f5,f6';
const FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Fixed messages keep upstream response bodies and exception causes out of logs. */
export class EastmoneyHkError extends Error {
  constructor(message, { kind = 'invalid_response', retryable = false } = {}) {
    super(message); this.name = 'EastmoneyHkError'; this.kind = kind; this.retryable = retryable;
  }
}
function invalid(message) { return new EastmoneyHkError(message); }
function configuration() { return new EastmoneyHkError('东方财富港股代码、日期范围或客户端配置无效。', { kind: 'configuration' }); }
function decimal(value, field, nonnegative = false) {
  if (typeof value !== 'string' || value.length > 40 || !DECIMAL.test(value) || !Number.isFinite(Number(value))
    || (nonnegative && Number(value) < 0)) throw invalid(`东方财富港股字段 ${field} 须为有效数值。`);
  return value;
}

// Subtract the provider's decimal strings exactly rather than introducing
// binary floating-point error into an inferred previous closing price.
function subtractDecimal(left, right) {
  const parts = value => {
    const negative = value.startsWith('-'), text = value.replace(/^[+-]/, ''), [whole = '', fraction = ''] = text.split('.');
    return { coefficient: BigInt(`${negative ? '-' : ''}${whole || '0'}${fraction}`), scale: fraction.length };
  };
  const a = parts(left), b = parts(right), scale = Math.max(a.scale, b.scale);
  const coefficient = a.coefficient * 10n ** BigInt(scale - a.scale) - b.coefficient * 10n ** BigInt(scale - b.scale);
  const sign = coefficient < 0n ? '-' : '', digits = (coefficient < 0n ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  if (!scale) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '');
}

function requestRange({ ticker, startDate, endDate }) {
  if (typeof ticker !== 'string' || !/^\d{5}\.HK$/.test(ticker)) throw configuration();
  let start, end;
  try { start = normalizeTradeDate(startDate); end = normalizeTradeDate(endDate); } catch { throw configuration(); }
  if (start.compact > end.compact) throw configuration();
  const days = Math.round((Date.parse(`${end.iso}T00:00:00Z`) - Date.parse(`${start.iso}T00:00:00Z`)) / 86400000) + 1;
  // Each response has at most one bar per calendar day. Bound collection below
  // the requested lmt so a server-side response cap cannot silently truncate it.
  if (days > 10000) throw configuration();
  return { ticker, start, end, days };
}

function normalizeResponse(body, range) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.rc !== 0) throw invalid('东方财富港股接口返回失败或数据结构无效。');
  const data = body.data;
  if (data === null) throw new EastmoneyHkError('东方财富未返回该港股日期范围内的行情。', { kind: 'no_data' });
  if (!data || typeof data !== 'object' || data.code !== range.ticker.slice(0, 5) || data.market !== 116
    || typeof data.name !== 'string' || !data.name.trim() || !Array.isArray(data.klines)
    || !Number.isInteger(data.dktotal) || data.dktotal < data.klines.length || data.klines.length > range.days) throw invalid('东方财富港股标的、市场或行情条数与请求不一致。');
  if (!data.klines.length) throw new EastmoneyHkError('东方财富未返回该港股日期范围内的行情。', { kind: 'no_data' });
  const seen = new Set();
  const rows = data.klines.map(line => {
    if (typeof line !== 'string') throw invalid('东方财富港股日线记录格式无效。');
    const values = line.split(',');
    if (values.length !== 11) throw invalid('东方财富港股日线字段数量无效。');
    const [date, open, close, high, low, vol, amount, amplitude, pctChg, change, turnover] = values;
    let tradeDate;
    try { tradeDate = normalizeTradeDate(date).compact; } catch { throw invalid('东方财富港股日线日期无效。'); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || tradeDate < range.start.compact || tradeDate > range.end.compact || seen.has(tradeDate)) throw invalid('东方财富港股日线日期重复或超出请求范围。');
    seen.add(tradeDate);
    const row = { ts_code: range.ticker, trade_date: tradeDate, open: decimal(open, 'open', true), high: decimal(high, 'high', true),
      low: decimal(low, 'low', true), close: decimal(close, 'close', true), change: decimal(change, 'change'),
      pct_chg: decimal(pctChg, 'pct_chg'), vol: decimal(vol, 'vol', true), amount: decimal(amount, 'amount', true) };
    if (!/^\+?\d+(?:\.0+)?$/.test(vol)) throw invalid('东方财富港股成交量须为非负整数股数。');
    decimal(amplitude, 'amplitude', true); decimal(turnover, 'turnover', true);
    row.pre_close = decimal(subtractDecimal(close, change), 'pre_close', true);
    return row;
  });
  rows.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
  return rows;
}

/** Parameters and units follow AKShare's stock_hk_hist implementation/docs:
 * https://github.com/akfamily/akshare/blob/master/akshare/stock_feature/stock_hist_em.py
 * https://akshare.akfamily.xyz/data/stock/stock.html#id88
 * No OHLC cross-field constraints: HK closing auctions may produce outliers.
 */
export function createEastmoneyHkClient({ fetchImpl = globalThis.fetch, intervalMs = 800, timeoutMs = 20000,
  maxRetries = 2, retryBaseMs = 1000, sleep = wait, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof now !== 'function'
    || !Number.isInteger(intervalMs) || intervalMs < 0 || !Number.isInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5 || !Number.isInteger(retryBaseMs) || retryBaseMs < 0) throw configuration();
  let queue = Promise.resolve(), lastStarted = -Infinity;
  async function request(range) {
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({ secid: `116.${range.ticker.slice(0, 5)}`, fields1: FIELDS1, fields2: FIELDS2,
      klt: '101', fqt: '0', beg: range.start.compact, end: range.end.compact, lmt: '100000' }).toString();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const pause = Math.max(0, lastStarted + intervalMs - now()); if (pause) await sleep(pause);
      lastStarted = now();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      let failure;
      try {
        const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json' } });
        if (!response || !Number.isInteger(response.status)) throw invalid('东方财富港股 HTTP 响应结构无效。');
        if (response.status === 429 || response.status >= 500) throw new EastmoneyHkError('东方财富港股服务暂时不可用或请求频率受限。', { kind: response.status === 429 ? 'rate_limit' : 'upstream', retryable: true });
        if (response.status < 200 || response.status >= 300) throw new EastmoneyHkError('东方财富港股 HTTP 请求失败。', { kind: 'http' });
        let body;
        try { body = await response.json(); } catch {
          if (controller.signal.aborted) throw new EastmoneyHkError('东方财富港股请求超时。', { kind: 'timeout', retryable: true });
          throw invalid('东方财富港股返回不可解析的 JSON。');
        }
        const rows = normalizeResponse(body, range);
        return { rows, source: 'eastmoney', apiName: 'eastmoney_hk_daily', adjustment: 'none', volumeUnit: 'share', amountUnit: 'hkd', currency: 'HKD',
          raw: { request: { url: url.href, ticker: range.ticker, startDate: range.start.compact, endDate: range.end.compact }, response: body,
            derivations: { pre_close: 'close_minus_change_decimal', change: 'provider', pct_chg: 'provider' },
            units: { volume: 'share', amount: 'hkd', currency: 'HKD' }, adjustment: 'none' } };
      } catch (error) {
        failure = error instanceof EastmoneyHkError ? error : new EastmoneyHkError(controller.signal.aborted ? '东方财富港股请求超时。' : '无法连接东方财富港股行情服务。', { kind: controller.signal.aborted ? 'timeout' : 'network', retryable: true });
      } finally { clearTimeout(timer); }
      if (!failure.retryable || attempt === maxRetries) throw failure;
      await sleep(Math.min(30000, retryBaseMs * 2 ** attempt));
    }
  }
  return { collectDaily(options) {
    let range;
    try { range = requestRange(options); } catch (error) { return Promise.reject(error instanceof EastmoneyHkError ? error : configuration()); }
    const pending = queue.then(() => request(range)); queue = pending.catch(() => {}); return pending;
  } };
}

const defaultClient = createEastmoneyHkClient();
// A Tushare client passed by the shared runtime is intentionally unused.
export function collectEastmoneyHkDaily(options) { return defaultClient.collectDaily(options); }
