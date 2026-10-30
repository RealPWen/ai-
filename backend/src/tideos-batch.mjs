import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createDeepSeekClient } from './deepseek-client.mjs';
import { createCurlFetch } from './curl-fetch.mjs';
import { createWatchlistStore } from './watchlist-store.mjs';
import { createAttributionStore } from './attribution-store.mjs';
import { createAttributionService } from './attribution-service.mjs';
import { createAttributionSectorResolver } from './attribution-sector.mjs';
import { createWatchlistAttributionRuntime } from './watchlist-attribution-runtime.mjs';
import { createRelationAttributionService } from './relation-attribution-service.mjs';
import { createMarketReadService } from '../market-data/read-service.mjs';
import { createRelationsReadService } from '../market-data/relations-read-service.mjs';

export async function checkDatabase(env) {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000, query_timeout: 10000 });
  try {
    await pool.query('SELECT 1');
    // A check never creates tables, migrates data or invokes an AI/data provider.
    const tables = ['market_data.daily_prices', 'market_data.user_watchlists', 'market_data.stock_return_attributions'];
    const { rows } = await pool.query('SELECT name, to_regclass(name) IS NOT NULL AS ready FROM unnest($1::text[]) AS name', [tables]);
    return { status: rows.every(row => row.ready) ? 'succeeded' : 'partial', database: 'connected', tables: rows };
  } finally { await pool.end(); }
}

export async function createAttributionBatch({ stage, env, log }) {
  const resources = [];
  const own = value => { resources.unshift(value); return value; };
  const close = async () => {
    let failure;
    for (const resource of resources) {
      try { await resource.close?.(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  };
  try {
    const fetchImpl = env.BACKEND_HTTP_TRANSPORT === 'curl' ? createCurlFetch({ proxyEnv: env }) : globalThis.fetch;
    const client = createDeepSeekClient({ apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL,
      fetchImpl, timeoutMs: 45000, researchTimeoutMs: 300000 });
    const connectionString = env.DATABASE_URL;
    const watchlistStore = own(createWatchlistStore({ connectionString }));
    await watchlistStore.migrate();
    if (stage === 'watchlist-attribution') {
      const marketService = own(createMarketReadService({ connectionString }));
      const store = own(createAttributionStore({ connectionString }));
      await store.migrate();
      const prompt = await readFile(new URL('../prompts/return-attribution.md', import.meta.url), 'utf8');
      const service = own(createAttributionService({ store, marketService, client, prompt,
        sectorResolver: createAttributionSectorResolver({ fetchImpl }), provider: 'deepseek', configured: true, log }));
      const runtime = own(createWatchlistAttributionRuntime({ connectionString, watchlistStore, service, enabled: true, log }));
      await runtime.migrate();
      return { run: () => runtime.runOnce(), close };
    }
    const relationsService = own(createRelationsReadService({ connectionString }));
    const prompt = await readFile(new URL('../prompts/relation-attribution.md', import.meta.url), 'utf8');
    const runtime = own(createRelationAttributionService({ connectionString, relationsService, watchlistStore,
      client, prompt, enabled: true, log }));
    await runtime.migrate();
    // Do not call startDaily(): TideOS owns retry intervals and scheduling.
    return { run: async () => {
      const result = await runtime.updateAll();
      return { ...result, status: result.status ?? (result.failed ? 'partial' : result.deferred ? 'waiting' : 'completed') };
    }, close };
  } catch (error) { await close(); throw error; }
}
