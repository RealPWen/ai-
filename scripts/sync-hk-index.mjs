import { createHkIndexStore } from '../backend/market-data/hk-index-store.mjs';
import { updateRollingHkIndex } from '../backend/market-data/hk-index-sync.mjs';
import { todayShanghai } from '../backend/src/input.mjs';

let store;
try {
  if (process.argv.includes('--help')) console.log('用法：node --env-file=.env scripts/sync-hk-index.mjs；同步腾讯恒生指数已收盘日线，首次近一年，之后增量更新并保留一年。');
  else {
    if (process.argv.length !== 2) throw new Error('invalid_arguments');
    store = createHkIndexStore({ connectionString: process.env.DATABASE_URL });
    const result = await updateRollingHkIndex({ store, runDate: todayShanghai(), log: value => console.log(JSON.stringify(value)) });
    process.exitCode = ['succeeded', 'already_completed'].includes(result.status) ? 0 : 2;
  }
} catch { console.error(JSON.stringify({ type: 'hk_index_update_failed', errorCode: 'configuration_or_runtime' })); process.exitCode = 1; }
finally { await store?.close(); }
