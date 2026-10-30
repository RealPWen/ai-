import { createFileCache } from './cache.mjs';
import { createDebatesService } from './research-service.mjs';
import { ResearchError } from './errors.mjs';

// Reading the shared local report requires no subscription or model lookup.
// Authentication still gates generation, and a switched account cannot publish.
export function createSubscriptionResearchService({ auth, client, directory, cache, store, prompt, promptVersion, now = () => new Date() }) {
  const guardedClient = {
    async research(input, instructions) {
      const status = await auth.status();
      if (!status.authenticated || !status.planEnabled) {
        await auth.getAccessToken();
        throw new ResearchError('CHATGPT_LOGIN_REQUIRED', '请先登录并授权使用 ChatGPT 套餐', 401);
      }
      const identity = await auth.cacheIdentity(), selectedModel = await client.resolveModel();
      const result = await client.research(input, instructions);
      try {
        const current = await auth.status();
        if (!current.authenticated || !current.planEnabled || await auth.cacheIdentity() !== identity) throw new Error('Account changed');
      } catch { throw new ResearchError('CHATGPT_ACCOUNT_CHANGED', '登录状态已变化，本次研究结果未保存，请重新尝试', 409); }
      return { ...result, response: { ...result.response, model: typeof result.response?.model === 'string' && result.response.model.trim() ? result.response.model : selectedModel } };
    },
  };
  const service = createDebatesService({ client: guardedClient, cache: store ?? cache ?? createFileCache(directory), prompt, promptVersion, provider: 'chatgpt', now });
  return {
    get: raw => service.get(raw),
    generate: raw => service.generate(raw),
    close: () => service.close(),
  };
}
