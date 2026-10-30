import { normalizeTradeDate } from './postgres-store.mjs';

const ENDPOINT = 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline';
const DECIMAL = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export class HkIndexError extends Error {
  constructor(message, kind = 'validation') { super(message); this.name = 'HkIndexError'; this.kind = kind; }
}
const invalid = () => new HkIndexError('腾讯恒生指数行情响应无效。');

export function normalizeHkIndexRange({ indexCode = 'HSI', startDate, endDate } = {}) {
  if (indexCode !== 'HSI') throw invalid();
  let start, end;
  try { start = normalizeTradeDate(startDate); end = normalizeTradeDate(endDate); } catch { throw invalid(); }
  const days = (Date.parse(end.iso) - Date.parse(start.iso)) / 86400000 + 1;
  if (days < 1 || days > 400) throw invalid();
  return { indexCode, start, end, days };
}

function numeric(value, positive = true) {
  if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && (value.length > 64 || !DECIMAL.test(value))
    || !Number.isFinite(Number(value)) || (positive ? Number(value) <= 0 : Number(value) < 0)) throw invalid();
  return Number(value);
}

export function validateHkIndexRows(rows, options) {
  const range = normalizeHkIndexRange(options), seen = new Set();
  if (!Array.isArray(rows) || !rows.length || rows.length > range.days) throw invalid();
  for (const row of rows) {
    if (!row || row.index_code !== 'HSI') throw invalid();
    let date;
    try { date = normalizeTradeDate(row.trade_date); } catch { throw invalid(); }
    if (row.trade_date !== date.compact || date.compact < range.start.compact || date.compact > range.end.compact || seen.has(date.compact)) throw invalid();
    seen.add(date.compact);
    const [open, high, low, close] = ['open', 'high', 'low', 'close'].map(key => numeric(row[key]));
    numeric(row.vol, false);
    if (low > high || open < low || open > high || close < low || close > high) throw invalid();
  }
  return rows;
}

/** Raw daily index observations; qt proves the symbol, market and index identity. */
export function createTencentHkIndexClient({ fetchImpl = globalThis.fetch, timeoutMs = 20000, maxRetries = 2 } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) throw invalid();
  return {
    async getDaily(options = {}) {
      const range = normalizeHkIndexRange(options);
      const url = new URL(ENDPOINT);
      url.searchParams.set('param', `hkHSI,day,${range.start.iso},${range.end.iso},${Math.min(640, range.days + 10)}`);
      let body;
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
          if (!response.ok) throw new HkIndexError('腾讯恒生指数行情暂不可用。', 'network');
          body = await response.json(); break;
        } catch (error) {
          if (attempt >= maxRetries) throw new HkIndexError('腾讯恒生指数行情请求失败。', 'network');
          await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 4000)));
        }
      }
      const data = body?.data?.hkHSI, qt = data?.qt?.hkHSI;
      if (body?.code !== 0 || !Array.isArray(qt) || !['100', 100].includes(qt[0]) || qt[1] !== '恒生指数' || qt[2] !== 'HSI'
        || qt[63] !== 'ZS' || qt[75] !== 'HKD' || !Array.isArray(data.day) || !data.day.length || data.day.length > Math.min(640, range.days + 10)) throw invalid();
      const rows = data.day.map(values => {
        if (!Array.isArray(values) || values.length < 6 || values.length > 12 || typeof values[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(values[0])) throw invalid();
        let tradeDate;
        try { tradeDate = normalizeTradeDate(values[0]).compact; } catch { throw invalid(); }
        return { index_code: 'HSI', trade_date: tradeDate, open: numeric(values[1]), close: numeric(values[2]), high: numeric(values[3]), low: numeric(values[4]), vol: numeric(values[5], false) };
      });
      validateHkIndexRows(rows, options);
      rows.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
      return { rows, source: 'tencent', apiName: 'tencent_hsi_daily', coverage: { symbol: 'hkHSI', firstDate: rows[0].trade_date, lastDate: rows.at(-1).trade_date, adjustment: 'none' } };
    },
  };
}
