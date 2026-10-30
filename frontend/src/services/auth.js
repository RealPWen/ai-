import { apiConfig } from '../../config.js';
import { apiClient } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';

const payload = value => value && typeof value === 'object' && Object.hasOwn(value, 'data') ? value.data : value;
const safeText = (value, limit = 200) => typeof value === 'string' ? value.slice(0, limit) : '';

export function officialChatgptLoginUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('后端返回的官方登录地址无效'); }
  if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.username || url.password) {
    throw new Error('登录地址不是 OpenAI 官方授权页面，请检查后端配置');
  }
  return url.href;
}

export function normalizeAuthStatus(response) {
  const value = payload(response);
  if (value?.provider === 'deepseek') {
    if (typeof value.configured !== 'boolean' || typeof value.authenticated !== 'boolean' || typeof value.researchEnabled !== 'boolean') {
      throw new Error('后端返回的 DeepSeek 连接状态无效');
    }
    if (value.sharedReadOnly === true) return {
      provider: 'deepseek', configured: false, authenticated: false, researchEnabled: false,
      model: '', error: null, sharedReadOnly: true,
    };
    return {
      provider: 'deepseek', configured: value.configured, authenticated: value.authenticated,
      researchEnabled: value.researchEnabled, model: safeText(value.model),
      error: value.error?.message ? { code: safeText(value.error.code, 80), message: safeText(value.error.message, 1200) } : null,
    };
  }
  if (!value || value.provider !== 'chatgpt' || typeof value.authenticated !== 'boolean' || typeof value.planEnabled !== 'boolean') {
    throw new Error('后端返回的 AI 连接状态无效');
  }
  if (value.sharedReadOnly === true) return {
    provider: 'chatgpt', authenticated: false, planEnabled: false,
    expiresAt: null, account: null, error: null, sharedReadOnly: true,
  };
  return {
    provider: 'chatgpt', authenticated: value.authenticated, planEnabled: value.planEnabled,
    expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null,
    account: value.authenticated ? { name: safeText(value.account?.name), email: safeText(value.account?.email) } : null,
    error: value.error?.message ? { code: safeText(value.error.code, 80), message: safeText(value.error.message, 1200) } : null,
  };
}

export const canUseChatgptPlan = status => status?.provider === 'chatgpt' && status.sharedReadOnly !== true && status.authenticated === true && status.planEnabled === true;
export const canUseAIResearch = status => status?.sharedReadOnly !== true && (canUseChatgptPlan(status) || (status?.provider === 'deepseek' && status.configured === true && status.authenticated === true && status.researchEnabled === true));

export function isAuthCallbackMessage(event, { backendOrigin, popup }) {
  return Boolean(popup && event.source === popup && event.origin === backendOrigin && event.data?.type === 'chatgpt-auth-complete');
}

export function createAuthService({ client, routes, config }) {
  return {
    async status() { return normalizeAuthStatus(await client.get(routes.authStatus)); },
    async start() {
      const value = payload(await client.post(routes.authStart, { body: {} }));
      return { url: officialChatgptLoginUrl(value?.url), expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null };
    },
    async logout() {
      const value = payload(await client.post(routes.authLogout, { body: {} }));
      if (value?.authenticated !== false) throw new Error('后端未确认退出，请刷新登录状态');
      return value;
    },
    async models() {
      const value = payload(await client.get(routes.authModels));
      if (!Array.isArray(value) || value.some(item => typeof item?.id !== 'string')) throw new Error('后端返回的订阅模型列表无效');
      return value.map(item => ({ id: safeText(item.id), displayName: safeText(item.displayName || item.id) }));
    },
    async test() {
      const value = payload(await client.post(routes.authTest, { body: {}, timeoutMs: config.generationTimeoutMs ?? 180000 }));
      const succeeded = value?.ok === true || (value?.provider === 'deepseek' && value.ok === undefined);
      if (!succeeded || typeof value.model !== 'string' || typeof value.message !== 'string') throw new Error('后端返回的 AI 连接测试结果无效');
      return { ok: true, ...(value.provider === 'deepseek' ? { provider: 'deepseek' } : {}), model: safeText(value.model), message: safeText(value.message, 2000) };
    },
  };
}

export const authService = createAuthService({ client: apiClient, routes: endpoints, config: apiConfig });
