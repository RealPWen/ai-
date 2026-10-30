import { dataPath } from '../backend/src/runtime-config.mjs';
import { resolve } from 'node:path';
import { createTushareClient } from '../backend/market-data/tushare-client.mjs';
import { createNewsStore } from '../backend/market-data/news-store.mjs';
import { syncNews, probeNewsSources, newsRange, createNewsClient } from '../backend/market-data/news-sync.mjs';

let store;
try {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) {
    console.log('用法：node --env-file-if-exists=.env scripts/sync-news.mjs [--start 20260715] [--end 20261014] [--mode sync|download|import] [--refresh] [--source 来源] [--no-probe]');
    console.log('默认：上海时间今天往前 3 个日历月 00:00 起，截至运行时刻；日期参数含末日。时间戳参数采用左闭右开窗口。原始数据缓存：backend/storage/market-data/news/major_news/all。');
    console.log('NEWS_MAX_RETRIES：单次请求失败后最多重试次数，默认 3，允许 0–10；持续失败会退出并保留续传进度。');
  } else {
    for (let index = 0; index < args.length; index++) {
      const argument = args[index];
      if (['--refresh', '--no-probe'].includes(argument)) {
        if (options[argument.slice(2)]) throw new Error('invalid_arguments'); options[argument.slice(2)] = true; continue;
      }
      if (!['--start', '--end', '--mode', '--source'].includes(argument) || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(options, argument.slice(2))) throw new Error('invalid_arguments');
      options[argument.slice(2)] = args[++index];
    }
    const mode = options.mode ?? 'sync';
    if (!['sync', 'download', 'import'].includes(mode) || (mode === 'import' && options.refresh)) throw new Error('invalid_arguments');
    if (options.source && !/^[\p{L}\p{N}_-]{1,80}$/u.test(options.source)) throw new Error('invalid_arguments');
    const runNow = new Date(), range = newsRange({ startDate: options.start, endDate: options.end, now: runNow });
    const interval = process.env.NEWS_TUSHARE_INTERVAL_MS === undefined ? 122000 : Number(process.env.NEWS_TUSHARE_INTERVAL_MS);
    const rateLimitBackoff = process.env.NEWS_RATE_LIMIT_BACKOFF_MS === undefined ? 3600000 : Number(process.env.NEWS_RATE_LIMIT_BACKOFF_MS);
    const networkBase = process.env.NEWS_NETWORK_RETRY_BASE_MS === undefined ? 5000 : Number(process.env.NEWS_NETWORK_RETRY_BASE_MS);
    const networkMax = process.env.NEWS_NETWORK_MAX_RETRY_MS === undefined ? 300000 : Number(process.env.NEWS_NETWORK_MAX_RETRY_MS);
    const maxRetries = process.env.NEWS_MAX_RETRIES === undefined ? 3 : Number(process.env.NEWS_MAX_RETRIES);
    const client = mode === 'import' ? null : createNewsClient(createTushareClient({ token: process.env.TUSHARE_TOKEN, intervalMs: 0, maxRetries: 0 }), {
      intervalMs: interval, rateLimitBackoffMs: rateLimitBackoff, networkRetryBaseMs: networkBase, maxNetworkRetryMs: networkMax, maxRetries, log: value => console.log(JSON.stringify(value)),
    });
    if (mode !== 'download') { store = createNewsStore({ connectionString: process.env.DATABASE_URL }); await store.migrate(); }
    if (client && !options['no-probe']) {
      for (const { sampleRows, ...status } of await probeNewsSources(client)) {
        if (store) await store.setSourceStatus(status);
        console.log(JSON.stringify({ type: 'news_source_status', ...status, sampleRows: sampleRows ?? 0 }));
      }
    }
    const report = await syncNews({ client, store, mode, refresh: options.refresh ?? false, sourceName: options.source ?? '',
      startDate: range.start, endDate: range.end, now: runNow, cacheDir: dataPath('market-data'), log: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify({ type: 'news_summary', ...report }));
    process.exitCode = report.status === 'completed' ? 0 : 2;
  }
} catch {
  console.error(JSON.stringify({ type: 'news_failed', kind: 'configuration_or_runtime', message: '资讯同步失败，请检查日期、Tushare 权限或数据库配置；已完成的窗口可以断点续传。' })); process.exitCode = 1;
} finally {
  if (store) try { await store.close(); } catch { console.error(JSON.stringify({ type: 'news_failed', kind: 'database' })); process.exitCode = 1; }
}
