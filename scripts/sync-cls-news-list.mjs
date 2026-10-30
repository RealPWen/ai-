import { resolve } from 'node:path';
import { createNewsStore } from '../backend/market-data/news-store.mjs';
import { syncClsNewsList } from '../backend/market-data/cls-news-list.mjs';
import { newsRange } from '../backend/market-data/news-sync.mjs';

let store;
try {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) {
    console.log('用法：node --env-file-if-exists=.env scripts/sync-cls-news-list.mjs [--start 20260719] [--end 20261019] [--resume] [--max-pages 1000]');
    console.log('采集财联社公开深度栏目1003，保存标题、明确标记的公开摘要及原文链接。默认近3个日历月；日期含末日、时间戳左闭右开。');
    console.log('--resume 使用已保存的原始范围和游标，不可与 --start/--end 混用。每次运行最多1000页，可设1–5000；单并发、至少间隔2秒。');
    console.log('仅使用公开客户端的匿名参数校验，不需要Tushare/GPT密钥，不启动定时任务。栏目范围触达记为range_reached；coverageVerified始终false，不代表全站完整。');
  } else {
    for (let index = 0; index < args.length; index++) {
      const flag = args[index], key = flag.slice(2);
      if (Object.hasOwn(options, key)) throw new Error('invalid_arguments');
      if (flag === '--resume') { options.resume = true; continue; }
      if (!['--start', '--end', '--max-pages'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('invalid_arguments');
      options[key] = args[++index];
    }
    const maxPages = options['max-pages'] === undefined ? 1000 : Number(options['max-pages']);
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5000 || options.resume && (options.start !== undefined || options.end !== undefined)) throw new Error('invalid_arguments');
    const now = new Date();
    if (!options.resume) newsRange({ startDate: options.start, endDate: options.end, now });
    store = createNewsStore({ connectionString: process.env.DATABASE_URL }); await store.migrate();
    const report = await syncClsNewsList({ store, cacheDir: resolve('backend/storage/market-data'), startDate: options.start, endDate: options.end,
      now, resume: options.resume ?? false, maxPages, log: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify({ type: 'cls_list_summary', ...report, fingerprints: undefined }));
    process.exitCode = ['page_limit', 'range_start_confirmed', 'range_already_reached'].includes(report.stopReason) ? 0 : 2;
  }
} catch {
  console.error(JSON.stringify({ type: 'cls_list_failed', kind: 'configuration_or_runtime', message: '财联社历史栏目采集未完成，请检查日期、续传记录或数据库配置。已保留可恢复进度。' })); process.exitCode = 1;
} finally {
  if (store) try { await store.close(); } catch { console.error(JSON.stringify({ type: 'cls_list_failed', kind: 'database' })); process.exitCode = 1; }
}
