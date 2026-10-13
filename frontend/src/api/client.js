import { apiConfig } from '../../config.js';

export class ApiError extends Error {
  constructor(message, { code = 'NETWORK_ERROR', status = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function createApiClient(config, fetchImpl = globalThis.fetch) {
  return {
    async get(path, { query = {}, signal } = {}) {
      if (!config.enabled) throw new ApiError('后端接口尚未启用', { code: 'API_DISABLED' });
      if (!path) throw new ApiError('接口地址尚未配置', { code: 'ENDPOINT_NOT_CONFIGURED' });
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs ?? 12000);
      try {
        // Leading / on a route does not discard a base URL's /api prefix.
        const joined = `${config.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
        const base = typeof location !== 'undefined' ? location.origin : 'http://localhost';
        const url = new URL(joined, base);
        if (!['http:', 'https:'].includes(url.protocol)) throw new ApiError('接口地址无效', { code: 'INVALID_URL' });
        for (const [key, value] of Object.entries(query)) {
          if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
        }
        const response = await fetchImpl(url.toString(), {
          method: 'GET', headers: { Accept: 'application/json' },
          credentials: config.credentials ?? 'omit', signal: controller.signal,
        });
        if (!response.ok) throw new ApiError(`接口返回 HTTP ${response.status}`, { code: 'HTTP_ERROR', status: response.status });
        try { return await response.json(); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          throw new ApiError('接口返回的内容不是有效 JSON', { code: 'INVALID_JSON' });
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (timedOut) throw new ApiError('请求超时，请稍后重试', { code: 'TIMEOUT' });
        if (controller.signal.aborted) throw new ApiError('请求已取消', { code: 'ABORTED' });
        throw new ApiError('无法连接后端，请检查服务地址及跨域配置');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

export const apiClient = createApiClient(apiConfig);
