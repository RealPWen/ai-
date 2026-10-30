import { createFileCache } from './cache.mjs';
import { createDebatesService } from './research-service.mjs';
import { ResearchError } from './errors.mjs';

/** One local latest report per ticker; GET preserves its original provider. */
export function createDeepSeekResearchService({ client, configured, directory, cache, store, prompt, model, promptVersion, now = () => new Date() }) {
  const service = createDebatesService({ client, cache: store ?? cache ?? createFileCache(directory), prompt, model, provider: 'deepseek', promptVersion, now });
  return {
    get: raw => service.get(raw),
    async generate(raw) {
      if (!configured) throw new ResearchError('DEEPSEEK_MISSING_API_KEY', '请在后端 .env 配置 DEEPSEEK_API_KEY 并重启后端', 503);
      return service.generate(raw);
    },
    close: () => service.close(),
  };
}
