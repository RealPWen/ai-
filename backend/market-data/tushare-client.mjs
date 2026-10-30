const ENDPOINT = 'https://api.tushare.pro';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Messages deliberately exclude upstream bodies, credentials, and exception causes. */
export class TushareError extends Error {
  constructor(message, { code = null, kind = 'upstream', retryable = false, quotaPeriod = null } = {}) {
    super(message);
    this.name = 'TushareError';
    this.code = code;
    this.kind = kind;
    this.permission = kind === 'permission';
    this.retryable = retryable;
    this.quotaPeriod = quotaPeriod;
  }
}

function invalid(message = 'Tushare 返回的数据结构不符合预期。') {
  return new TushareError(message, { kind: 'invalid_response' });
}

function classifyUpstream(code, message) {
  const msg = typeof message === 'string' ? message.slice(0, 2048) : '';
  if (/(?:token|令牌|凭证).{0,24}(?:错误|不正确|不对|非法|无效|失效|过期|invalid|expired)|(?:invalid|expired|incorrect).{0,24}token|认证失败|未登录|登录失效|unauthori[sz]ed|authentication/i.test(msg)) {
    return new TushareError('Tushare Token 无效或认证失败，请检查本地配置。', { code, kind: 'authentication' });
  }
  // Explicit denial wins over a quota mentioned in permission guidance. A neutral
  // "see permission documentation" footer must still allow genuine rate errors.
  if (/(?:没有|不具备|不具有).{0,15}权限|无权|无(?:访问)?权限|权限不足|未开通|尚未开通|需(?:要)?单独开通|(?:权限|试用).{0,30}(?:只|仅).{0,20}(?:最近|历史|近\d|当日|当天)|积分.{0,12}(?:不足|不够|未达到|未达标)|permission denied|access denied|forbidden/i.test(msg)) {
    return new TushareError('当前 Tushare 账号没有此接口的数据权限。', { code, kind: 'permission' });
  }
  if (/每(?:分钟|小时|秒|天|日)|频率|频次|频繁|限流|rate.?limit|too many requests/i.test(msg)) {
    const quotaPeriod = /每(?:天|日)|[\/／](?:天|日)|per\s+day/i.test(msg) ? 'day'
      : /每小时|[\/／]小时|per\s+hour/i.test(msg) ? 'hour' : null;
    return new TushareError(quotaPeriod === 'hour' ? 'Tushare 接口每小时调用额度已用尽，请检查接口权限后重试。'
      : quotaPeriod === 'day' ? 'Tushare 接口每日调用额度已用尽，请检查接口权限后重试。'
        : 'Tushare 请求频率受限，已按策略退避。', { code, kind: 'rate_limit', retryable: true, quotaPeriod });
  }
  if (/权限|积分|无权|未开通|permission|forbidden|access denied/i.test(msg) || code === -2002 || code === 2002) {
    return new TushareError('当前 Tushare 账号没有此接口的数据权限。', { code, kind: 'permission' });
  }
  if (/服务.*忙|服务.*异常|系统.*忙|系统.*异常|稍后重试|temporarily|unavailable/i.test(msg)) {
    return new TushareError('Tushare 服务暂时不可用。', { code, kind: 'upstream', retryable: true });
  }
  return new TushareError('Tushare 拒绝了数据请求，请核对接口及参数。', { code, kind: 'upstream' });
}

function readRows(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isInteger(body.code)) throw invalid();
  if (body.code !== 0) throw classifyUpstream(body.code, body.msg);
  const { fields, items } = body.data || {};
  if (!Array.isArray(fields) || !Array.isArray(items)
    || fields.length > 500 || items.length > 100000
    || fields.some(field => typeof field !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,99}$/.test(field))
    || new Set(fields).size !== fields.length || (items.length > 0 && fields.length === 0)) throw invalid();
  return items.map(row => {
    if (!Array.isArray(row) || row.length !== fields.length
      || row.some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))
      || row.some(value => typeof value === 'number' && !Number.isFinite(value))) throw invalid();
    return Object.fromEntries(fields.map((field, index) => [field, row[index]]));
  });
}

function checkOptions(options) {
  for (const key of ['intervalMs', 'maxRetries', 'timeoutMs', 'retryBaseMs', 'maxRetryDelayMs']) {
    if (!Number.isInteger(options[key]) || options[key] < (key === 'timeoutMs' ? 1 : 0)) {
      throw new TypeError(`Invalid Tushare client option: ${key}`);
    }
  }
  if (options.maxRetries > 10) throw new TypeError('Tushare maxRetries must not exceed 10.');
}

export function createTushareClient({
  token, fetchImpl = globalThis.fetch, intervalMs = 350, maxRetries = 3,
  timeoutMs = 30000, sleep = wait, now = Date.now,
  retryBaseMs = 1000, maxRetryDelayMs = 30000,
} = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new TushareError('缺少 Tushare Token，请检查本地配置。', { kind: 'configuration' });
  }
  if (typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof now !== 'function') {
    throw new TypeError('Tushare client dependencies must be functions.');
  }
  checkOptions({ intervalMs, maxRetries, timeoutMs, retryBaseMs, maxRetryDelayMs });
  let queue = Promise.resolve();
  let lastStarted = -Infinity;

  async function request(apiName, params, fields) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const pause = Math.max(0, lastStarted + intervalMs - now());
      if (pause) await sleep(pause);
      lastStarted = now();
      let error;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(ENDPOINT, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_name: apiName, token, params, fields }),
        });
        if (!response || !Number.isInteger(response.status)) throw invalid();
        if (response.status === 429 || response.status >= 500) {
          throw new TushareError('Tushare 服务暂时不可用或请求频率受限。', {
            code: response.status, kind: response.status === 429 ? 'rate_limit' : 'upstream', retryable: true,
          });
        }
        if (response.status === 401 || response.status === 403) {
          throw new TushareError('Tushare 认证失败或当前账号没有接口权限。', {
            code: response.status, kind: response.status === 401 ? 'authentication' : 'permission',
          });
        }
        if (response.status < 200 || response.status >= 300) {
          throw new TushareError('Tushare HTTP 请求失败。', { code: response.status, kind: 'http' });
        }
        let body;
        try { body = await response.json(); } catch {
          if (controller.signal.aborted) throw new TushareError('Tushare 请求超时。', { kind: 'timeout', retryable: true });
          throw invalid('Tushare 未返回可解析的 JSON 数据。');
        }
        return readRows(body);
      } catch (caught) {
        error = caught instanceof TushareError ? caught : new TushareError(
          controller.signal.aborted ? 'Tushare 请求超时。' : '无法连接 Tushare 数据服务。',
          { kind: controller.signal.aborted ? 'timeout' : 'network', retryable: true },
        );
      } finally {
        clearTimeout(timer);
      }
      // Seconds of backoff cannot recover an explicit hourly/daily quota. Let a
      // later scheduled run resume instead of repeatedly consuming requests.
      if (!error.retryable || ['hour', 'day'].includes(error.quotaPeriod) || attempt === maxRetries) throw error;
      await sleep(Math.min(maxRetryDelayMs, retryBaseMs * 2 ** attempt));
    }
  }

  function query(apiName, params = {}, fields = '') {
    if (typeof apiName !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(apiName)
      || !params || typeof params !== 'object' || Array.isArray(params)
      || Object.values(params).some(value => value !== null && (!['string', 'number', 'boolean'].includes(typeof value)
        || (typeof value === 'number' && !Number.isFinite(value))))
      || typeof fields !== 'string' || fields.length > 10000) {
      return Promise.reject(new TushareError('Tushare 接口名或请求参数无效。', { kind: 'configuration' }));
    }
    // Copy before joining the queue so caller mutation cannot change a pending request.
    const copy = { ...params };
    const pending = queue.then(() => request(apiName, copy, fields));
    queue = pending.catch(() => {});
    return pending;
  }

  async function queryAll(apiName, params = {}, fields = '', {
    pageSize = apiName === 'hk_daily' ? 5000 : 6000,
    maxPages = 10000, maxRows = 5000000, primaryKey,
  } = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params)
      || ![pageSize, maxPages, maxRows].every(value => Number.isInteger(value) && value > 0)
      || pageSize > 100000 || (primaryKey !== undefined
        && (!Array.isArray(primaryKey) || !primaryKey.length || primaryKey.some(key => typeof key !== 'string')))) {
      throw new TushareError('Tushare 分页参数无效。', { kind: 'configuration' });
    }
    if (params && ('offset' in params || 'limit' in params)) {
      throw new TushareError('queryAll 自动管理 limit 和 offset，请勿重复传入。', { kind: 'configuration' });
    }
    params = { ...params };
    const result = [];
    const seen = new Set();
    const seenPages = new Set();
    let schema;
    for (let page = 0; page < maxPages; page += 1) {
      const rows = await query(apiName, { ...params, limit: pageSize, offset: result.length }, fields);
      if (!rows.length) return result;
      if (rows.length > pageSize) throw invalid('Tushare 返回条数超出请求分页上限，已停止导入。');
      const pageSchema = JSON.stringify(Object.keys(rows[0]).sort());
      if (schema && schema !== pageSchema) throw invalid('Tushare 分页字段发生变化，无法确认数据完整。');
      schema = pageSchema;
      const fingerprint = JSON.stringify(rows);
      if (seenPages.has(fingerprint)) throw invalid('Tushare 返回重复分页，已停止导入以防数据截断。');
      seenPages.add(fingerprint);
      for (const row of rows) {
        let keys = primaryKey;
        if (!keys) keys = 'ts_code' in row ? ('trade_date' in row ? ['ts_code', 'trade_date'] : ['ts_code']) : null;
        if (keys?.some(key => row[key] === undefined || row[key] === null || row[key] === '')) {
          throw invalid('Tushare 返回的数据缺少唯一键。');
        }
        const identity = keys ? JSON.stringify(keys.map(key => row[key])) : JSON.stringify(row);
        if (seen.has(identity)) throw invalid('Tushare 返回重复数据键，已停止导入以防分页截断。');
        seen.add(identity);
        if ('trade_date' in row) {
          if (typeof row.trade_date !== 'string' || !/^\d{8}$/.test(row.trade_date)
            || (params.trade_date && row.trade_date !== params.trade_date)
            || (params.start_date && row.trade_date < params.start_date)
            || (params.end_date && row.trade_date > params.end_date)) {
            throw invalid('Tushare 返回的交易日期超出请求范围或格式无效。');
          }
        }
        if (params.ts_code && row.ts_code !== params.ts_code) throw invalid('Tushare 返回了请求标的以外的数据。');
      }
      if (result.length + rows.length > maxRows) throw invalid('Tushare 数据量超过配置上限，已停止导入。');
      result.push(...rows);
      // Continue even after a short page: the provider may enforce a lower cap.
    }
    throw invalid('Tushare 分页次数超过配置上限，无法确认数据完整。');
  }

  return { query, queryAll };
}
