import { apiConfig } from '../../config.js';

function safeDiagnostic(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  if (['authorization', 'models', 'responses', 'stream', 'request'].includes(value.stage)) result.stage = value.stage;
  for (const [key, max] of [['elapsedMs', 600000], ['curlExitCode', 100]]) {
    if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= max) result[key] = value[key];
  }
  return Object.keys(result).length ? result : null;
}

export class ApiError extends Error {
  constructor(message, { code = 'NETWORK_ERROR', status = null, diagnostic } = {}) {
    const details = safeDiagnostic(diagnostic);
    const phases = { authorization: '授权续期', models: '读取可用模型', responses: '提交生成请求', stream: '接收生成结果' };
    const phase = phases[details?.stage];
    const elapsed = Number.isInteger(details?.elapsedMs) ? `，等待 ${Math.ceil(details.elapsedMs / 1000)} 秒` : '';
    super(phase ? `${message}（${phase}阶段${elapsed}）` : message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    if (details) this.diagnostic = details;
  }
}

export function createApiClient(config, fetchImpl = globalThis.fetch) {
  async function request(method, path, { query = {}, body, signal, timeoutMs } = {}) {
    if (!config.enabled) throw new ApiError('后端接口尚未启用', { code: 'API_DISABLED' });
    if (!path) throw new ApiError('接口地址尚未配置', { code: 'ENDPOINT_NOT_CONFIGURED' });
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs ?? config.timeoutMs ?? 12000);
    try {
      // Leading / on a route does not discard a base URL's /api prefix.
      const joined = `${String(config.baseUrl ?? '').replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
      const base = typeof location !== 'undefined' ? location.origin : 'http://localhost';
      const url = new URL(joined, base);
      if (!['http:', 'https:'].includes(url.protocol)) throw new ApiError('接口地址无效', { code: 'INVALID_URL' });
      for (const [key, value] of Object.entries(query)) {
        if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
      }
      const response = await fetchImpl(url.toString(), {
        method, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: config.credentials ?? 'omit', signal: controller.signal,
      });
      if (!response.ok) {
        let error;
        try { error = (await response.json())?.error; } catch { /* Plain HTTP errors still retain their status. */ }
        throw new ApiError(typeof error?.message === 'string' ? error.message : `接口返回 HTTP ${response.status}`, {
          code: typeof error?.code === 'string' ? error.code : 'HTTP_ERROR', status: response.status, diagnostic: error?.diagnostic,
        });
      }
      try { return await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        throw new ApiError('接口返回的内容不是有效 JSON', { code: 'INVALID_JSON' });
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (timedOut) throw new ApiError('请求超时，请稍后查看缓存；后端任务可能仍在完成', { code: 'TIMEOUT' });
      if (controller.signal.aborted) throw new ApiError('请求已取消', { code: 'ABORTED' });
      throw new ApiError('无法连接后端，请检查服务地址及跨域配置');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return {
    get: (path, options) => request('GET', path, options),
    post: (path, options) => request('POST', path, options),
  };
}

export const apiClient = createApiClient(apiConfig);
