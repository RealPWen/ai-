import { dataPath } from '../backend/src/runtime-config.mjs';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createTushareClient } from '../backend/market-data/tushare-client.mjs';
import { createHkSecuritiesStore } from '../backend/market-data/hk-securities-store.mjs';
import { syncHkPoolSecurities } from '../backend/market-data/pool-securities-sync.mjs';

let store;
try {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) {
    console.log('用法：npm run data:hk:securities -- [--mode sync|download|import] [--refresh]；仅同步 hk-universe.json 名单中的港股资料。');
  } else {
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      if (key === '--refresh' && !options.refresh) { options.refresh = true; continue; }
      if (key !== '--mode' || options.mode || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('invalid_arguments');
      options.mode = args[++index];
    }
    const mode = options.mode ?? 'sync';
    if (!['sync', 'download', 'import'].includes(mode)) throw new Error('invalid_arguments');
    const client = mode === 'import' ? null : createTushareClient({ token: process.env.TUSHARE_TOKEN, intervalMs: 500 });
    if (mode !== 'download') store = createHkSecuritiesStore({ connectionString: process.env.DATABASE_URL });
    const universe = JSON.parse(await readFile(new URL('../backend/market-data/hk-universe.json', import.meta.url), 'utf8'));
    const report = await syncHkPoolSecurities({ universe, client, store, mode, refresh: options.refresh ?? false,
      cacheDir: dataPath('market-data'), log: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify({ type: 'hk_securities_summary', ...report }));
  }
} catch (error) {
  const kind = error.code === 'DATABASE_ERROR' ? 'database' : ['permission', 'authentication', 'rate_limit', 'network', 'timeout', 'validation', 'invalid_response'].includes(error.kind) ? error.kind : 'configuration_or_runtime';
  console.error(JSON.stringify({ type: 'hk_securities_failed', kind, message: '港股基础资料同步失败，请检查接口权限、缓存及数据库配置。' }));
  process.exitCode = 1;
} finally {
  if (store) { try { await store.close(); } catch { console.error(JSON.stringify({ type: 'hk_securities_failed', kind: 'database' })); process.exitCode = 1; } }
}
