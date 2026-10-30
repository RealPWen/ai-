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
      return { status: data == null || (Array.isArray(data) && !data.length) || (module === 'prices' && Array.isArray(data.points) && !data.points.length) || (module === 'forecasts' && Array.isArray(data.rows) && !data.rows.length) || (module === 'relations' && !data.relations.length) || (module === 'events' && !data.items.length) ? 'empty' : 'ready', data };
    },
    async searchCompanies(params = {}, options = {}) {
      if (!config.enabled || !routes.stocks) throw new Error('股票数据库搜索尚未配置');
      const spec = typeof routes.stocks === 'function' ? routes.stocks(params) : { path: routes.stocks };
      return mappers.stocks(await client.get(spec.path, { query: spec.query, signal: options.signal }));
    },
    async saveRelationsManual(params, options = {}) {
      if (!config.enabled || !routes.relationsManual) throw new Error('人工关系编辑接口尚未配置');
      return client.post(routes.relationsManual, { body: {
        ticker: params.ticker, asOf: params.asOf, expectedRevision: params.expectedRevision,
        changes: params.changes.map(({ action, relatedTicker, relationType, rationale }) => ({ action, relatedTicker,
          ...(action === 'upsert' ? { relationType, rationale: rationale || '' } : {}) })),
      }, signal: options.signal });
    },
    async startRelationsResearch(params, options = {}) {
      if (!config.enabled || !routes.relationsResearch) throw new Error('AI 关系识别接口尚未配置');
      return client.post(routes.relationsResearch, { body: { ticker: params.ticker, asOf: params.asOf }, signal: options.signal });
    },
    async loadRelationsResearch(params, options = {}) {
      if (!config.enabled || !routes.relationsResearch) throw new Error('AI 关系识别接口尚未配置');
      const query = params.jobId ? { jobId: params.jobId } : { ticker: params.ticker, asOf: params.asOf };
      return client.get(routes.relationsResearch, { query, signal: options.signal });
    },
    async startAttribution(params, options = {}) {
      if (!config.enabled || !routes.attributionGenerate) throw new Error('涨跌归因接口尚未配置');
      return client.post(routes.attributionGenerate, { body: { ticker: params.ticker, ...(params.periods ? { periods: params.periods } : {}) }, signal: options.signal });
    },
    async loadAttributionJob(params, options = {}) {
      if (!config.enabled || !routes.attributionJob) throw new Error('涨跌归因接口尚未配置');
      const spec = routes.attributionJob(params);
      return client.get(spec.path, { signal: options.signal });
    },
    async generateDebates(params, options = {}) {
      if (!config.enabled || !routes.debatesGenerate) throw new Error('观点生成接口尚未配置');
      const route = typeof routes.debatesGenerate === 'function' ? routes.debatesGenerate(params) : routes.debatesGenerate;
      const spec = typeof route === 'string' ? { path: route } : route;
      if (!spec?.path) throw new Error('观点生成接口尚未配置');
      const response = await client.post(spec.path, {
        body: { ticker: params.ticker, ...(params.companyName ? { companyName: params.companyName } : {}) },
        signal: options.signal, timeoutMs: config.generationTimeoutMs ?? 360000,
      });
      const data = mappers.debates(response);
      return { status: data == null ? 'empty' : 'ready', data };
    },
  };
}

export const researchService = createResearchService({ config: apiConfig, routes: endpoints, client: apiClient, mappers: adapters });
