import { fileURLToPath } from 'node:url';
import { createMarketUpdateRuntime } from '../backend/market-data/update-runtime.mjs';

const runtime = createMarketUpdateRuntime({ connectionString: process.env.DATABASE_URL, token: process.env.TUSHARE_TOKEN,
  hkProvider: process.env.HK_PRICE_PROVIDER || 'eastmoney',
  hkPriceScope: process.env.HK_PRICE_SCOPE || 'pool',
  hkForecastScope: process.env.HK_FORECAST_SCOPE || 'all',
  hkValuationScope: process.env.HK_VALUATION_SCOPE || 'all',
  hkValuationEnabled: process.env.HK_VALUATION_AUTO_UPDATE_ENABLED !== 'false',
  hkForecastEnabled: process.env.HK_FORECAST_AUTO_UPDATE_ENABLED !== 'false',
  cacheDir: fileURLToPath(new URL('../backend/storage/market-data/', import.meta.url)),
  newsEnabled: process.env.CLS_NEWS_AUTO_UPDATE_ENABLED !== 'false',
  catchUp: process.env.MARKET_AUTO_UPDATE_CATCH_UP !== 'false', log: value => console.log(JSON.stringify(value)) });
if (!runtime.snapshot().enabled) {
  console.error(JSON.stringify({ type: 'daily_update_failed', reason: 'not_configured' })); process.exitCode = 1;
} else runtime.start();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  try { await runtime.close(); process.exit(0); }
  catch { console.error(JSON.stringify({ type: 'daily_update_failed', reason: 'shutdown' })); process.exit(1); }
});
