import { dataPath } from '../backend/src/runtime-config.mjs';
import { resolve } from 'node:path';
import { createNewsStore } from '../backend/market-data/news-store.mjs';
import { syncClsNewsSearch, clsPublicSearchRequest } from '../backend/market-data/cls-news-search.mjs';
import { newsRange } from '../backend/market-data/news-sync.mjs';

let store;
try {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) {
    console.log('用法：node --env-file-if-exists=.env scripts/sync-cls-news-search.mjs [--start 20260719] [--end 20261019] [--keyword 财联社] [--resume] [--max-pages 1000]');
    console.log('仅读取财联社匿名公开搜索type=depth，默认关键词“财联社”、近3个日历月。保存标题、公开摘要及原文链接。日期含末日，时间戳左闭右开。');
    console.log('--resume沿用该关键词的原始范围和已提交页码，不与--start/--end混用；每轮最多1000页，可设1–5000，单并发至少间隔2秒。');
    console.log('公开搜索索引持续更新，无法证明历史PIT或无漏；coverageVerified=false。range_reached仅表示关键词结果已触达起点，不代表财联社全站或全平台完整。无需上游密钥，不创建定时任务。');
  } else {
    for (let index = 0; index < args.length; index++) {
      const flag = args[index], key = flag.slice(2);
      if (Object.hasOwn(options, key)) throw new Error('invalid_arguments');
      if (flag === '--resume') { options.resume = true; continue; }
      if (!['--start', '--end', '--max-pages', '--keyword'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('invalid_arguments');
      options[key] = args[++index];
    }
    const maxPages = options['max-pages'] === undefined ? 1000 : Number(options['max-pages']);
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5000 || options.resume && (options.start !== undefined || options.end !== undefined)) throw new Error('invalid_arguments');
    clsPublicSearchRequest({ keyword: options.keyword });
    const now = new Date(); if (!options.resume) newsRange({ startDate: options.start, endDate: options.end, now });
    store = createNewsStore({ connectionString: process.env.DATABASE_URL }); await store.migrate();
    const report = await syncClsNewsSearch({ store, cacheDir: dataPath('market-data'), keyword: options.keyword,
      startDate: options.start, endDate: options.end, now, resume: options.resume ?? false, maxPages, log: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify({ type: 'cls_search_summary', ...report, fingerprints: undefined }));
    process.exitCode = ['page_limit', 'range_start_confirmed', 'range_already_reached', 'search_exhausted_after_start'].includes(report.stopReason) ? 0 : 2;
  }
} catch {
  console.error(JSON.stringify({ type: 'cls_search_failed', kind: 'configuration_or_runtime', message: '财联社公开搜索采集未完成，请检查日期、关键词、续传记录或数据库配置。已保留可恢复进度。' })); process.exitCode = 1;
} finally {
  if (store) try { await store.close(); } catch { console.error(JSON.stringify({ type: 'cls_search_failed', kind: 'database' })); process.exitCode = 1; }
}
