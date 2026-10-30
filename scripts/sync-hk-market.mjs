import { fileURLToPath } from 'node:url';
import { createHkMarketStore } from '../backend/market-data/hk-market-store.mjs';
import { createTushareClient } from '../backend/market-data/tushare-client.mjs';
import { updateRollingHongKongMarket } from '../backend/market-data/hk-market-sync.mjs';
import { todayShanghai } from '../backend/src/input.mjs';

let store;
try {
  if (process.argv.includes('--help')) console.log('用法：npm run data:hk:market [--retry-no-data]；同步当前上市港股公司港元柜台腾讯未复权日线，保留一年及1条前收盘基准，支持断点续传。本命令仅更新日线；PE/PB及EPS由各自全市场流程独立更新。');
  else {
    if (process.argv.slice(2).some(value => value !== '--retry-no-data')) throw new Error('invalid_arguments');
    store = createHkMarketStore({ connectionString: process.env.DATABASE_URL });
    const client = createTushareClient({ token: process.env.TUSHARE_TOKEN });
    const result = await updateRollingHongKongMarket({ store, client, runDate: todayShanghai(),
      cacheDir: fileURLToPath(new URL('../backend/storage/market-data/', import.meta.url)), retryNoData: process.argv.includes('--retry-no-data'),
      log: value => console.log(JSON.stringify(value)) });
    process.exitCode = ['succeeded', 'already_completed'].includes(result.status) ? 0 : 2;
  }
} catch { console.error(JSON.stringify({ type: 'hk_market_update_failed', errorCode: 'configuration_or_runtime' })); process.exitCode = 1; }
finally { await store?.close(); }
