const TICKER = /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/;
const ENDPOINT = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const DAY_MS = 86400000;
const UNKNOWN = Object.freeze({ name: null, source: 'unavailable', known: false });

function sectorName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f<>]|https?:|[{}\[\]]/iu.test(name)
    || /^(?:--?|null|undefined|n\/?a|未知|暂无|暂无数据|其他|其它|恒生指数|恒指|HSI)$/iu.test(name)) return null;
  return name;
}

export function attributionSectorUrl(ticker) {
  if (typeof ticker !== 'string' || !/^\d{5}\.HK$/.test(ticker)) return null;
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ reportName: 'RPT_HKF10_INFO_ORGPROFILE',
    columns: 'SECUCODE,SECURITY_CODE,BELONG_INDUSTRY', filter: `(SECUCODE="${ticker}")`,
    pageNumber: '1', pageSize: '2', source: 'F10', client: 'PC' }).toString();
  return url.href;
}

/** A classification is metadata, independent of the return-comparison index.
 * HK metadata is fetched only when resolve() is explicitly called by generation.
 * No model, file cache, or inferred ticker/name mapping is used here. */
export function createAttributionSectorResolver({ fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = 8000, cacheTtlMs = DAY_MS, failureTtlMs = 60000, maxConcurrency = 2,
  maxCacheEntries = 4096, maxQueued = 32 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000
    || !Number.isInteger(cacheTtlMs) || cacheTtlMs < 1 || cacheTtlMs > DAY_MS
    || !Number.isInteger(failureTtlMs) || failureTtlMs < 0 || failureTtlMs > cacheTtlMs
    || !Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4
    || !Number.isInteger(maxCacheEntries) || maxCacheEntries < 1 || maxCacheEntries > 10000
    || !Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 100) {
    throw new TypeError('归因行业资料解析器配置无效。');
  }
  const cache = new Map(), inFlight = new Map(), waiting = [];
  let active = 0;
  const clock = () => Number(now());
  async function scheduled(operation) {
    if (active >= maxConcurrency) {
      if (waiting.length >= maxQueued) return UNKNOWN;
      await new Promise(resolve => waiting.push(resolve));
    } else active++;
    try { return await operation(); }
    finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  async function readHk(ticker) {
    const sourceUrl = attributionSectorUrl(ticker), controller = new AbortController();
    let timer;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('sector timeout')); }, timeoutMs);
        timer.unref?.();
      });
      const result = await Promise.race([deadline, (async () => {
        const response = await fetchImpl(sourceUrl, { signal: controller.signal,
          redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response?.ok) return UNKNOWN;
        if (Number(response.headers?.get?.('content-length')) > 100000) return UNKNOWN;
        const body = await response.text();
        if (typeof body !== 'string' || Buffer.byteLength(body) > 100000) return UNKNOWN;
        const json = JSON.parse(body), rows = json?.result?.data;
        if (json?.success !== true || json.code !== 0 || !Array.isArray(rows) || rows.length !== 1) return UNKNOWN;
        const row = rows[0];
        if (row?.SECUCODE !== ticker || row?.SECURITY_CODE !== ticker.slice(0, 5)) return UNKNOWN;
        const name = sectorName(row.BELONG_INDUSTRY);
        return name ? Object.freeze({ name, source: 'eastmoney', known: true, sourceUrl }) : UNKNOWN;
      })()]);
      return result;
    } catch { return UNKNOWN; }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return {
    async resolve({ ticker, profile, benchmark } = {}) {
      if (typeof ticker !== 'string' || !TICKER.test(ticker)) return { ...UNKNOWN };
      if (!ticker.endsWith('.HK')) {
        const swName = benchmark?.system === 'SW2021' ? sectorName(benchmark.industryName) : null;
        if (swName) return { name: swName, source: 'sw2021', known: true };
        const databaseName = sectorName(profile?.industry)
          ?? (Array.isArray(profile?.businesses) && profile.businesses.length === 1 ? sectorName(profile.businesses[0]) : null);
        return databaseName ? { name: databaseName, source: 'database', known: true } : { ...UNKNOWN };
      }
      const cached = cache.get(ticker);
      if (cached && cached.expiresAt > clock()) return { ...cached.value };
      if (cached) cache.delete(ticker);
      const existing = inFlight.get(ticker);
      if (existing) return { ...await existing };
      const pending = scheduled(() => readHk(ticker)).then(value => {
        if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value);
        cache.set(ticker, { value, expiresAt: clock() + (value.known ? cacheTtlMs : failureTtlMs) });
        return value;
      });
      inFlight.set(ticker, pending);
      try { return { ...await pending }; }
      finally { inFlight.delete(ticker); }
    },
  };
}
