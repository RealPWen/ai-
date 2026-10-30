import { resolve } from 'node:path';
import { createTushareClient } from '../backend/market-data/tushare-client.mjs';
import { createIndustryStore } from '../backend/market-data/industry-store.mjs';
import { collectL2Classification, collectL2Members } from '../backend/market-data/industry-sync.mjs';

let store;
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('用法：node --env-file-if-exists=.env scripts/sync-l2-members.mjs [--mode sync|download|import] [--refresh]；完整下载独立申万二级成员标签，不重新下载行情。');
  else {
    let mode = 'sync', refresh = false, modeSet = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--refresh' && !refresh) refresh = true;
      else if (args[index] === '--mode' && !modeSet && ['sync', 'download', 'import'].includes(args[index + 1])) { mode = args[++index]; modeSet = true; }
      else throw new Error('invalid_arguments');
    }
    const cacheDir = resolve('backend/storage/market-data'), client = mode === 'import' ? null : createTushareClient({ token: process.env.TUSHARE_TOKEN, intervalMs: 400 });
    const log = value => console.log(JSON.stringify(value));
    const classification = await collectL2Classification({ client, cacheDir, mode, refresh, log });
    const members = await collectL2Members({ client, cacheDir, classification, mode, refresh, log });
    if (mode !== 'download') {
      store = createIndustryStore({ connectionString: process.env.DATABASE_URL }); await store.migrate();
      await store.replaceL2Classification(classification); await store.replaceL2Members(members);
    }
    console.log(JSON.stringify({ type: 'industry_l2_members_summary', status: 'completed', mode, snapshotId: members.snapshotId, industries: classification.industries.length, members: members.members.length, sourceMembers: members.sourceMembers, unsupportedHistoricalAliases: members.unsupportedHistoricalAliases, fetchedAt: members.fetchedAt }));
  }
} catch (error) {
  const safeKinds = ['permission', 'authentication', 'rate_limit', 'validation', 'network', 'timeout', 'invalid_response'];
  console.error(JSON.stringify({ type: 'industry_l2_members_failed', kind: error?.code === 'DATABASE_ERROR' ? 'database' : safeKinds.includes(error?.kind) ? error.kind : 'configuration_or_runtime' })); process.exitCode = 1;
} finally { if (store) try { await store.close(); } catch { console.error(JSON.stringify({ type: 'industry_l2_members_failed', kind: 'database' })); process.exitCode = 1; } }
