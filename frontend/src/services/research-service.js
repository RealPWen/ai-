import { apiConfig } from '../../config.js';
import { endpoints } from '../api/endpoints.js';
import { apiClient } from '../api/client.js';
import { adapters } from './adapters.js';

export function createResearchService({ config, routes, client, mappers }) {
  return {
    async load(module, params = {}, options = {}) {
      if (!Object.hasOwn(routes, module) || typeof mappers[module] !== 'function') throw new Error(`未知研究模块：${module}`);
      if (!config.enabled || !routes[module]) return { status: 'not_configured', data: null };
      const route = typeof routes[module] === 'function' ? routes[module](params) : routes[module];
      const spec = typeof route === 'string' ? { path: route } : route;
      if (!spec?.path) return { status: 'not_configured', data: null };
      const response = await client.get(spec.path, { query: spec.query, signal: options.signal });
      const data = mappers[module](response);
      return { status: data == null || (Array.isArray(data) && !data.length) ? 'empty' : 'ready', data };
    },
  };
}

export const researchService = createResearchService({ config: apiConfig, routes: endpoints, client: apiClient, mappers: adapters });
