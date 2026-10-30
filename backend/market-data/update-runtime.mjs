import { createForecastStore } from './forecast-store.mjs';
import { updateRollingForecasts } from './forecast-daily-update.mjs';
import { createTushareClient } from './tushare-client.mjs';
import { createMarketStore } from './postgres-store.mjs';
import { createValuationStore } from './valuation-store.mjs';
import { createIndustryStore } from './industry-store.mjs';
import { createRollingUpdateStore } from './rolling-update-store.mjs';
import { createDailyScheduler } from './daily-scheduler.mjs';
import { updateRollingMarketData } from './rolling-update.mjs';
import { createHkPoolStore } from './hk-pool-store.mjs';
import { updateRollingHongKongPool } from './hk-pool-sync.mjs';
import { createHkMarketStore } from './hk-market-store.mjs';
import { updateRollingHongKongMarket } from './hk-market-sync.mjs';
import { createHkValuationStore } from './hk-valuation-store.mjs';
import { updateRollingHkValuations } from './hk-valuation-sync.mjs';
import { createHkForecastStore } from './hk-forecast-store.mjs';
import { updateRollingHkForecasts } from './hk-forecast-sync.mjs';
import { createHkIndexStore } from './hk-index-store.mjs';
import { updateRollingHkIndex } from './hk-index-sync.mjs';
import { createNewsStore } from './news-store.mjs';
import { createDailyNewsUpdateStore } from './daily-news-update-store.mjs';
import { updateDailyClsNews } from './daily-news-update.mjs';
import { todayShanghai } from '../src/input.mjs';

/** Shared by the HTTP backend and an optional standalone worker; secrets stay here. */
export function createMarketUpdateRuntime({ connectionString, token, cacheDir, markets = ['A', 'HK'], hkProvider = 'eastmoney', hkPriceScope = 'pool', hkValuationScope = 'pool', hkForecastScope = 'pool', hkUniversePath, hkCollector, hkValuationCollector, hkForecastCollector, enabled = true, newsEnabled = true, hkValuationEnabled = true, hkForecastEnabled = true, hkIndexEnabled = true, catchUp = true, now = () => new Date(), log = () => {}, dependencies = {} } = {}) {
  if (!Array.isArray(markets) || !markets.length || markets.some(market => !['A', 'HK'].includes(market))) throw new TypeError('日线更新市场无效。');
  if (!['eastmoney', 'tushare', 'yahoo', 'tencent'].includes(hkProvider)) throw new TypeError('港股行情来源无效。');
  if (!['pool', 'all'].includes(hkPriceScope) || (hkPriceScope === 'all' && hkProvider !== 'tencent')) throw new TypeError('港股全市场日线仅支持腾讯来源，范围须为 pool 或 all。');
  if (!['pool', 'all'].includes(hkForecastScope)) throw new TypeError('港股预测更新范围须为 pool 或 all。');
  if (!['pool', 'all'].includes(hkValuationScope)) throw new TypeError('港股估值更新范围须为 pool 或 all。');
  const selectedMarkets = [...new Set(markets)];
  const databaseConfigured = typeof connectionString === 'string' && !!connectionString.trim();
  const tokenConfigured = typeof token === 'string' && !!token.trim();
  // All-market Tencent prices still require a token to refresh the complete
  // currently-listed directory. The existing workbook price mode does not.
  const configuredMarkets = selectedMarkets.filter(market => databaseConfigured && (market === 'HK' && hkPriceScope === 'pool' && hkProvider !== 'tushare' || tokenConfigured));
  const newsConfigured = newsEnabled && databaseConfigured;
  const hkValuationConfigured = hkValuationEnabled && databaseConfigured && selectedMarkets.includes('HK');
  const hkForecastConfigured = hkForecastEnabled && databaseConfigured && selectedMarkets.includes('HK');
  const hkIndexConfigured = hkIndexEnabled && databaseConfigured && selectedMarkets.includes('HK');
  const configured = configuredMarkets.length > 0 || newsConfigured || hkValuationConfigured || hkForecastConfigured || hkIndexConfigured;
  const active = enabled && configured;
  let lastResult = null, inFlight = null, closing = false, started = false;
  const stores = active ? {
    ...(configuredMarkets.includes('A') ? {
      marketStore: (dependencies.createMarketStore ?? createMarketStore)({ connectionString }),
      valuationStore: (dependencies.createValuationStore ?? createValuationStore)({ connectionString }),
      industryStore: (dependencies.createIndustryStore ?? createIndustryStore)({ connectionString }),
    } : {}),
  } : {};
  const runStores = active ? Object.fromEntries(configuredMarkets.map(market => [market,
    market === 'HK' ? (hkPriceScope === 'all'
      ? (dependencies.createHkMarketStore ?? createHkMarketStore)({ connectionString, market })
      : (dependencies.createHkPoolStore ?? createHkPoolStore)({ connectionString, market }))
      : (dependencies.createRollingUpdateStore ?? createRollingUpdateStore)({ connectionString, market }),
  ])) : {};
  const clients = active && tokenConfigured ? Object.fromEntries(configuredMarkets.map(market => [market,
    (dependencies.createTushareClient ?? createTushareClient)({ token, intervalMs: 400, ...(market === 'HK' ? { maxRetries: 0 } : {}) }),
  ])) : {};
  const newsStores = active && newsConfigured ? {
    newsStore: (dependencies.createNewsStore ?? createNewsStore)({ connectionString }),
    store: (dependencies.createDailyNewsUpdateStore ?? createDailyNewsUpdateStore)({ connectionString }),
  } : null;
  const hkValuationStore = active && hkValuationConfigured ? (dependencies.createHkValuationStore ?? createHkValuationStore)({ connectionString }) : null;
  const hkForecastStore = active && hkForecastConfigured ? (dependencies.createHkForecastStore ?? createHkForecastStore)({ connectionString }) : null;
  const hkIndexStore = active && hkIndexConfigured ? (dependencies.createHkIndexStore ?? createHkIndexStore)({ connectionString }) : null;
  const aForecastStore = active && configuredMarkets.includes('A') ? (dependencies.createForecastStore ?? createForecastStore)({ connectionString }) : null;
  const safeLog = value => { try { log(value); } catch {} };
  const aggregateStatus = values => values.some(result => result.status === 'failed') ? 'failed'
    : values.some(result => ['partial', 'disabled'].includes(result.status)) ? 'partial'
      : values.some(result => result.status === 'busy') ? 'busy'
        : values.every(result => result.status === 'already_completed') ? 'already_completed' : 'succeeded';

  async function updateHkValuations(runDate) {
    let result;
    try {
      result = await (dependencies.updateRollingHkValuations ?? updateRollingHkValuations)({
        store: hkValuationStore, cacheDir, runDate, universePath: hkUniversePath,
        scope: hkValuationScope, client: clients.HK, concurrency: hkValuationScope === 'all' ? 3 : 1,
        collector: hkValuationCollector ?? dependencies.hkValuationCollector, log: safeLog,
      });
    } catch {
      result = { status: 'failed', runDate, errorCode: 'hk_valuation_update_error', source: 'baidu', apiName: 'baidu_hk_valuation', summary: {} };
    }
    safeLog({ type: 'hk_valuation_runtime_result', ...result });
    return result;
  }

  async function updateHkForecasts(runDate) {
    let result;
    try {
      result = await (dependencies.updateRollingHkForecasts ?? updateRollingHkForecasts)({
        store: hkForecastStore, cacheDir, runDate, universePath: hkUniversePath,
        scope: hkForecastScope, client: clients.HK, concurrency: hkForecastScope === 'all' ? 3 : 1,
        collector: hkForecastCollector ?? dependencies.hkForecastCollector, log: safeLog,
      });
    } catch {
      result = { status: 'failed', runDate, errorCode: 'hk_forecast_update_error', source: 'etnet', apiName: 'etnet_hk_profit_forecast', summary: {} };
    }
    safeLog({ type: 'hk_forecast_runtime_result', ...result });
    return result;
  }

  async function updateSelectedMarkets(runDate) {
    const results = {}; let hkValuations = null, hkForecasts = null;
    // Keep all market outcomes even when a provider entitlement or database error
    // blocks one market. Each updater owns an independent durable run and lock.
    for (const market of selectedMarkets) {
      try {
        if (!configuredMarkets.includes(market)) results[market] = { status: 'disabled', reason: 'not_configured', runDate, summary: {} };
        else if (market === 'HK' && hkPriceScope === 'all') results[market] = await (dependencies.updateRollingHongKongMarket ?? updateRollingHongKongMarket)({
          client: clients.HK, store: runStores.HK, market, cacheDir, runDate, collector: hkCollector, log: safeLog,
        });
        else if (market === 'HK') results[market] = await (dependencies.updateRollingHongKongPool ?? updateRollingHongKongPool)({
          client: clients.HK, store: runStores.HK, market, cacheDir, runDate, provider: hkProvider,
          universePath: hkUniversePath, collector: hkCollector, log: safeLog,
        });
        else results[market] = await (dependencies.updateRollingMarketData ?? updateRollingMarketData)({
          ...stores, client: clients.A, store: runStores.A, market, cacheDir, runDate, log: safeLog,
        });
      } catch {
        results[market] = { status: 'failed', runDate, errorCode: 'provider_error', summary: {} };
      }
      safeLog({ type: 'market_daily_update_result', market, ...results[market] });
      // Both sources have independent ledgers, locks and pacing. A full-market
      // valuation run must not hold up the independently resumable EPS run.
      if (market === 'HK') {
        [hkValuations, hkForecasts] = await Promise.all([
          hkValuationStore ? updateHkValuations(runDate) : Promise.resolve(null),
          hkForecastStore ? updateHkForecasts(runDate) : Promise.resolve(null),
        ]);
      }
    }
    const values = Object.values(results);
    const priceStatus = aggregateStatus(values), allValues = [...values, ...(hkValuations ? [hkValuations] : []), ...(hkForecasts ? [hkForecasts] : [])];
    const status = aggregateStatus(allValues);
    // Retain the existing A-share window/summary fields for API consumers. The
    // aggregate status also reports HK failures so CLI runs cannot hide them.
    const primary = results.A ?? values[0];
    const failure = allValues.find(result => ['failed', 'partial'].includes(result.status));
    return { ...primary, status, ...(failure ? { errorCode: failure.errorCode } : {}), markets: results,
      ...(hkValuations || hkForecasts ? { marketStatus: priceStatus } : {}),
      ...(hkValuations ? { hkValuations } : {}), ...(hkForecasts ? { hkForecasts } : {}) };
  }

  async function updateNews(runDate) {
    try {
      return await (dependencies.updateDailyClsNews ?? updateDailyClsNews)({ ...newsStores, cacheDir, runDate, now: now(), log: safeLog });
    } catch {
      return { status: 'failed', runDate, errorCode: 'news_update_error', sourceApi: 'cls_web' };
    }
  }

  async function updateDailyData(runDate) {
    // News has its own lock and completion ledger. It must still run on a
    // market holiday, or while a market provider is failing or waiting.
    const [marketResult, news, hkIndex, aForecasts] = await Promise.all([
      updateSelectedMarkets(runDate), newsStores ? updateNews(runDate) : Promise.resolve(null),
      hkIndexStore ? (async () => {
        let result;
        try { result = await (dependencies.updateRollingHkIndex ?? updateRollingHkIndex)({ store: hkIndexStore, runDate, log: safeLog }); }
        catch { result = { status: 'failed', runDate, source: 'tencent', apiName: 'tencent_hsi_daily', errorCode: 'hk_index_update_error', summary: {} }; }
        safeLog({ type: 'hk_index_runtime_result', ...result }); return result;
      })() : Promise.resolve(null),
      aForecastStore ? (dependencies.updateRollingForecasts ?? updateRollingForecasts)({ store: aForecastStore, client: clients.A, cacheDir, runDate, log: safeLog }).catch(() => ({ status: 'failed', errorCode: 'forecast_update_error' })) : Promise.resolve(null),
    ]);
    if (!news && !hkIndex && !aForecasts) return marketResult;
    const values = [marketResult, ...(news ? [news] : []), ...(hkIndex ? [hkIndex] : []), ...(aForecasts ? [aForecasts] : [])];
    const status = aggregateStatus(values);
    const failure = values.find(result => ['failed', 'partial'].includes(result.status));
    return { ...marketResult, status, marketStatus: marketResult.marketStatus ?? marketResult.status,
      ...(news ? { news } : {}), ...(hkIndex ? { hkIndex } : {}), ...(aForecasts ? { aForecasts } : {}),
      ...(failure?.errorCode ? { errorCode: failure.errorCode } : {}) };
  }

  function runOnce({ runDate = todayShanghai(now()) } = {}) {
    if (!active || closing) return Promise.resolve({ status: 'disabled', reason: !configured ? 'not_configured' : 'disabled' });
    if (inFlight) return inFlight;
    inFlight = updateDailyData(runDate)
      .then(result => {
        lastResult = { ...result, finishedAt: now().toISOString() };
        safeLog({ type: 'daily_update_result', ...lastResult });
        return result;
      }).finally(() => { inFlight = null; });
    return inFlight;
  }
  const scheduler = active ? (dependencies.createDailyScheduler ?? createDailyScheduler)({ run: runOnce, now, catchUp, hour: 6, log: safeLog }) : null;
  return {
    runOnce,
    start() {
      if (started || closing) return;
      started = true; scheduler?.start();
      safeLog({ type: 'daily_update_schedule', enabled: active, markets: selectedMarkets, hkProvider, hkPriceScope, hkValuationScope, hkForecastScope, newsEnabled: !!newsStores, hkValuationEnabled: !!hkValuationStore, hkForecastEnabled: !!hkForecastStore, hkIndexEnabled: !!hkIndexStore, timeZone: 'Asia/Shanghai', hour: 6,
        nextRunAt: scheduler?.nextRunAt ?? null, ...(!active ? { reason: configured ? 'disabled' : 'not_configured' } : {}) });
    },
    snapshot() { return { enabled: active, markets: [...selectedMarkets], hkProvider, hkPriceScope,
      aForecasts: { enabled: !!aForecastStore, sourceApi: 'report_rc', target: 'previous_calendar_day', retention: 'one_year' },
      news: { enabled: !!newsStores, sourceApi: 'cls_web', target: 'previous_calendar_day' },
      hkValuations: { enabled: !!hkValuationStore, sourceApi: 'baidu_hk_valuation', scope: hkValuationScope, concurrency: hkValuationScope === 'all' ? 3 : 1 },
      hkForecasts: { enabled: !!hkForecastStore, sourceApi: 'etnet_hk_profit_forecast', scope: hkForecastScope, concurrency: hkForecastScope === 'all' ? 3 : 1 },
      hkIndex: { enabled: !!hkIndexStore, sourceApi: 'tencent_hsi_daily', indexCode: 'HSI', target: 'previous_calendar_day' },
      timeZone: 'Asia/Shanghai', hour: 6, running: !!inFlight, nextRunAt: scheduler?.nextRunAt ?? null, lastResult }; },
    async close() {
      closing = true; scheduler?.stop();
      try { await inFlight; }
      finally { await Promise.all([...(aForecastStore ? [aForecastStore] : []), ...Object.values(stores), ...Object.values(runStores), ...Object.values(newsStores ?? {}), ...(hkValuationStore ? [hkValuationStore] : []), ...(hkForecastStore ? [hkForecastStore] : []), ...(hkIndexStore ? [hkIndexStore] : [])].map(store => store.close())); }
    },
  };
}
