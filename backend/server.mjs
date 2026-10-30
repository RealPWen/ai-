import { createRelationAttributionService } from './src/relation-attribution-service.mjs';
import { createWatchlistAttributionRuntime } from './src/watchlist-attribution-runtime.mjs';
import { createWatchlistStore } from './src/watchlist-store.mjs';
import { createNotesStore } from './src/notes-store.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createResearchServer } from './app.mjs';
import { createChatGPTAuth } from './src/chatgpt-auth.mjs';
import { createChatGPTClient } from './src/chatgpt-client.mjs';
import { createCurlFetch } from './src/curl-fetch.mjs';
import { createSubscriptionResearchService } from './src/subscription-service.mjs';
import { createDeepSeekClient, DEFAULT_DEEPSEEK_MODEL } from './src/deepseek-client.mjs';
import { createImaRetriever } from './src/ima-retriever.mjs';
import { imaReferencePrompt, IMA_PIPELINE_VERSION } from './src/ima-evidence.mjs';
import { createDeepSeekResearchService } from './src/deepseek-service.mjs';
import { createDebateStore, migrateLegacyDebates } from './src/debate-store.mjs';
import { createAttributionStore } from './src/attribution-store.mjs';
import { createAttributionService } from './src/attribution-service.mjs';
import { createAttributionSectorResolver } from './src/attribution-sector.mjs';
import { createHkIndexStore } from './market-data/hk-index-store.mjs';
import { reportSchema } from './src/schema.mjs';
import { AUDIT_VERSION } from './src/source-audit.mjs';
import { createMarketReadService } from './market-data/read-service.mjs';
import { createHkMarketStore } from './market-data/hk-market-store.mjs';
import { createHkForecastStore } from './market-data/hk-forecast-store.mjs';
import { createHkValuationStore } from './market-data/hk-valuation-store.mjs';
import { createForecastReadService } from './market-data/forecast-read-service.mjs';
import { createRelationsReadService } from './market-data/relations-read-service.mjs';
import { createRelationsManualStore } from './market-data/relations-manual-store.mjs';
import { createRelationsAiStore } from './market-data/relations-ai-store.mjs';
import { createRelationsAiService } from './src/relations-ai-service.mjs';
import { createNewsReadService } from './market-data/news-read-service.mjs';
import { createMarketUpdateRuntime } from './market-data/update-runtime.mjs';
const prompt = await readFile(new URL('./prompts/core-debates.md', import.meta.url), 'utf8');
const fingerprint = createHash('sha256').update(prompt + JSON.stringify(reportSchema) + AUDIT_VERSION + imaReferencePrompt + IMA_PIPELINE_VERSION).digest('hex');
const promptVersion = `core-debates-v1-${fingerprint.slice(0, 12)}`;
const port = Number(process.env.BACKEND_PORT || 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BACKEND_PORT should be a valid TCP port');
const transport = process.env.BACKEND_HTTP_TRANSPORT?.trim() || 'native';
if (!['native', 'curl'].includes(transport)) throw new Error('BACKEND_HTTP_TRANSPORT should be native or curl');
// Choose the transport before sending a request; never retry inference through a second transport.
const fetchImpl = transport === 'curl' ? createCurlFetch({ proxyEnv: process.env }) : globalThis.fetch;
const provider = process.env.AI_PROVIDER?.trim() || 'deepseek';
if (!['deepseek', 'chatgpt'].includes(provider)) throw new Error('AI_PROVIDER should be deepseek or chatgpt');
const model = provider === 'deepseek' ? process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL : process.env.CHATGPT_MODEL?.trim() || null;
let auth, client, service, aiStatus;
const directory = fileURLToPath(new URL('./storage/debates/', import.meta.url));
const debateStore = process.env.DATABASE_URL?.trim() ? createDebateStore({ connectionString: process.env.DATABASE_URL }) : null;
if (debateStore) {
  await debateStore.migrate();
  const migrated = await migrateLegacyDebates({ directory, store: debateStore,
    acceptReport(report, { filename }) {
      // Only migrate reports whose filename proves they belonged to the known
      // shared DeepSeek cache. Account-partitioned legacy reports stay private.
      if (report?.promptVersion !== promptVersion || typeof report.model !== 'string' || !report.model.startsWith('deepseek-')) return false;
      const legacyPartition = createHash('sha256').update(JSON.stringify(['deepseek', report.model, fingerprint])).digest('hex');
      const expected = createHash('sha256').update(JSON.stringify([report.ticker, report.asOf, legacyPartition])).digest('hex');
      return filename === `${expected}.json` ? { provider: 'deepseek' } : false;
    },
  });
  console.log(JSON.stringify({ type: 'debates_storage_migrated', ...migrated }));
}
if (provider === 'deepseek') {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() || '';
  const imaRetriever = await createImaRetriever({ enabled: process.env.IMA_RESEARCH_ENABLED !== 'false' });
  client = createDeepSeekClient({ apiKey, model, fetchImpl, imaRetriever, timeoutMs: 45000, researchTimeoutMs: 300000 });
  service = createDeepSeekResearchService({ client, configured: Boolean(apiKey), directory, cache: debateStore ?? undefined, prompt, model, promptVersion, fingerprint });
  aiStatus = () => ({ provider, model, configured: Boolean(apiKey), authenticated: Boolean(apiKey), researchEnabled: Boolean(apiKey),
    ima: { enabled: imaRetriever.enabled, configured: imaRetriever.configured },
    error: apiKey ? null : { code: 'DEEPSEEK_MISSING_API_KEY', message: '请在后端 .env 配置 DEEPSEEK_API_KEY 并重启后端' } });
} else {
  auth = await createChatGPTAuth({ directory: fileURLToPath(new URL('./storage/chatgpt/', import.meta.url)), redirectUri: `http://127.0.0.1:${port}/auth/callback`, fetchImpl });
  client = createChatGPTClient({ auth, model: model || undefined, fetchImpl, timeoutMs: 45000, researchTimeoutMs: 300000 });
  service = createSubscriptionResearchService({ auth, client, directory, cache: debateStore ?? undefined, prompt, promptVersion, fingerprint });
}
// Readers use the active HK catalog even when the daily updater is disabled or
// its source refresh fails. Create the additive tables before accepting traffic.
if (process.env.DATABASE_URL?.trim()) {
  const hkMarketSetup = createHkMarketStore({ connectionString: process.env.DATABASE_URL });
  try { await hkMarketSetup.migrate(); } finally { await hkMarketSetup.close(); }
  const hkForecastSetup = createHkForecastStore({ connectionString: process.env.DATABASE_URL });
  try { await hkForecastSetup.migrate(); } finally { await hkForecastSetup.close(); }
  const hkValuationSetup = createHkValuationStore({ connectionString: process.env.DATABASE_URL });
  try { await hkValuationSetup.migrate(); } finally { await hkValuationSetup.close(); }
  const hkIndexSetup = createHkIndexStore({ connectionString: process.env.DATABASE_URL });
  try { await hkIndexSetup.migrate(); } finally { await hkIndexSetup.close(); }
}
const marketService = process.env.DATABASE_URL?.trim() ? createMarketReadService({ connectionString: process.env.DATABASE_URL }) : null;
const forecastService = process.env.DATABASE_URL?.trim() ? createForecastReadService({ connectionString: process.env.DATABASE_URL }) : null;
const relationsService = process.env.DATABASE_URL?.trim() ? createRelationsReadService({ connectionString: process.env.DATABASE_URL }) : null;
const relationsManualService = process.env.DATABASE_URL?.trim() ? createRelationsManualStore({ connectionString: process.env.DATABASE_URL }) : null;
await relationsManualService?.migrate();
const relationsAiStore = process.env.DATABASE_URL?.trim() ? createRelationsAiStore({ connectionString: process.env.DATABASE_URL }) : null;
await relationsAiStore?.migrate();
const relationsAiPrompt = await readFile(new URL('./prompts/relations-ai.md', import.meta.url), 'utf8');
const relationsAiService = relationsAiStore ? createRelationsAiService({ store: relationsAiStore, client, prompt: relationsAiPrompt,
  provider, model, configured: provider === 'deepseek' && Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
  log: value => console.log(JSON.stringify(value)) }) : null;
const newsService = process.env.DATABASE_URL?.trim() ? createNewsReadService({ connectionString: process.env.DATABASE_URL }) : null;
const attributionStore = process.env.DATABASE_URL?.trim() ? createAttributionStore({ connectionString: process.env.DATABASE_URL }) : null;
await attributionStore?.migrate();
const attributionPrompt = await readFile(new URL('./prompts/return-attribution.md', import.meta.url), 'utf8');
const attributionService = attributionStore ? createAttributionService({ store: attributionStore, marketService, client,
  prompt: attributionPrompt, sectorResolver: createAttributionSectorResolver({ fetchImpl }), provider, configured: provider === 'deepseek' && Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
  log: value => console.log(JSON.stringify(value)) }) : null;
const marketUpdater = createMarketUpdateRuntime({ connectionString: process.env.DATABASE_URL, token: process.env.TUSHARE_TOKEN,
  hkProvider: process.env.HK_PRICE_PROVIDER || 'eastmoney',
  hkPriceScope: process.env.HK_PRICE_SCOPE || 'pool',
  hkForecastScope: process.env.HK_FORECAST_SCOPE || 'all',
  hkValuationScope: process.env.HK_VALUATION_SCOPE || 'all',
  hkValuationEnabled: process.env.HK_VALUATION_AUTO_UPDATE_ENABLED !== 'false',
  hkForecastEnabled: process.env.HK_FORECAST_AUTO_UPDATE_ENABLED !== 'false',
  cacheDir: fileURLToPath(new URL('./storage/market-data/', import.meta.url)),
  enabled: process.env.MARKET_AUTO_UPDATE_ENABLED !== 'false', catchUp: process.env.MARKET_AUTO_UPDATE_CATCH_UP !== 'false',
  newsEnabled: process.env.CLS_NEWS_AUTO_UPDATE_ENABLED !== 'false',
  log: value => console.log(JSON.stringify(value)) });
const watchlistStore = process.env.DATABASE_URL?.trim() ? createWatchlistStore({ connectionString: process.env.DATABASE_URL }) : null;
await watchlistStore?.migrate();
const notesStore = process.env.DATABASE_URL?.trim() ? createNotesStore({ connectionString: process.env.DATABASE_URL }) : null;
await notesStore?.migrate();
const watchlistAttributionRuntime = watchlistStore && attributionService ? createWatchlistAttributionRuntime({
 connectionString: process.env.DATABASE_URL, watchlistStore, service: attributionService,
 enabled: process.env.WATCHLIST_ATTRIBUTION_AUTO_UPDATE_ENABLED !== 'false', log: value => console.log(JSON.stringify(value)) }) : null;
await watchlistAttributionRuntime?.migrate();
const relativePrompt = await readFile(new URL('./prompts/relation-attribution.md', import.meta.url), 'utf8');
const relationAttributionService = watchlistStore && relationsService ? createRelationAttributionService({
 connectionString: process.env.DATABASE_URL, relationsService, watchlistStore, client, prompt: relativePrompt,
 enabled: process.env.RELATION_ATTRIBUTION_AUTO_UPDATE_ENABLED !== 'false', log: value => console.log(JSON.stringify(value)) }) : null;
await relationAttributionService?.migrate();
const server = createResearchServer({ service, auth, aiStatus, watchlistStore, notesStore, watchlistAttributionRuntime, relationAttributionService, chatClient: client, marketService, forecastService, relationsService, relationsManualService, relationsAiService, newsService, attributionService, health: { status: 'ok', provider, model, promptVersion, transport, notesData: notesStore ? 'postgresql' : 'not_configured', debatesData: debateStore ? 'postgresql' : 'file', marketData: marketService ? 'postgresql' : 'not_configured', forecastData: forecastService ? 'postgresql' : 'not_configured', relationsData: relationsService ? 'postgresql' : 'not_configured', relationsManualData: relationsManualService ? 'postgresql' : 'not_configured', relationsAiData: relationsAiService ? 'postgresql' : 'not_configured', newsData: newsService ? 'postgresql' : 'not_configured', attributionData: attributionService ? 'postgresql' : 'not_configured', get marketAutoUpdate() { return marketUpdater.snapshot(); } } });
server.listen(port, '127.0.0.1', () => { console.log(`Research backend: http://127.0.0.1:${port} (${provider})`); marketUpdater.start(); watchlistAttributionRuntime?.start(); relationAttributionService?.startDaily(); });
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : 'Unable to start research backend.'); process.exitCode = 1; });
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (shuttingDown) return; shuttingDown = true;
  server.close(async () => {
    try { await relationAttributionService?.close(); await watchlistAttributionRuntime?.close(); await Promise.all([relationsAiService?.close(), service.close?.(), attributionService?.close()]); await Promise.all([notesStore?.close(), watchlistStore?.close(), debateStore?.close(), marketService?.close(), forecastService?.close(), relationsService?.close(), relationsManualService?.close(), relationsAiStore?.close(), newsService?.close(), attributionStore?.close(), marketUpdater.close()]); process.exit(0); }
    catch { console.error('Backend shutdown failed.'); process.exit(1); }
  });
});
