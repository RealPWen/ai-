import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createNewsStore } from '../backend/market-data/news-store.mjs';
import { clsArticleUrl, syncClsNews } from '../backend/market-data/cls-news-sync.mjs';
import { newsRange } from '../backend/market-data/news-sync.mjs';

let store;
try {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) {
    console.log('用法：node --env-file-if-exists=.env scripts/sync-cls-news.mjs [--start 20260716] [--end 20261016] [--urls-file 文件] [--no-homepage] [--max-articles 200] [--mode sync|download|import]');
    console.log('仅读取财联社官网公开 HTML；默认近 3 个日历月，日期含末日、时间戳左闭右开。单并发，每次请求至少间隔 2 秒，403/429 立即停止。无需 Tushare 或 GPT API Key。');
    console.log('公开首页和显式文章链接不能证明历史范围完整，结果始终为 partial / coverageVerified=false。缓存可续传；import 仅从缓存入库。不会启动定时任务。');
    console.log('--max-articles 限制每轮新增文章请求数量，复用缓存不占下载预算；import 模式限制本轮处理的缓存条数。');
  } else {
    for (let index = 0; index < args.length; index++) {
      const flag = args[index], key = flag.slice(2);
      if (Object.hasOwn(options, key)) throw new Error('invalid_arguments');
      if (flag === '--no-homepage') { options[key] = true; continue; }
      if (!['--start', '--end', '--urls-file', '--max-articles', '--mode'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('invalid_arguments');
      options[key] = args[++index];
    }
    const mode = options.mode ?? 'sync', maxArticles = options['max-articles'] === undefined ? 200 : Number(options['max-articles']);
    if (!['sync', 'download', 'import'].includes(mode) || !Number.isInteger(maxArticles) || maxArticles < 1 || maxArticles > 1000) throw new Error('invalid_arguments');
    const runNow = new Date(), range = newsRange({ startDate: options.start, endDate: options.end, now: runNow });
    let urls = [];
    if (options['urls-file']) {
      const content = await readFile(resolve(options['urls-file']), 'utf8');
      if (Buffer.byteLength(content) > 3 * 1024 * 1024) throw new Error('invalid_arguments');
      urls = content.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#')).map(clsArticleUrl);
      if (urls.length > 10000) throw new Error('invalid_arguments');
    }
    if (mode !== 'download') { store = createNewsStore({ connectionString: process.env.DATABASE_URL }); await store.migrate(); }
    const report = await syncClsNews({ store, urls, mode, maxArticles, includeHomepage: !options['no-homepage'],
      startDate: range.start, endDate: range.end, now: runNow, cacheDir: resolve('backend/storage/market-data'), log: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify({ type: 'cls_news_summary', ...report }));
    process.exitCode = report.failed > 0 ? 2 : 0;
  }
} catch {
  console.error(JSON.stringify({ type: 'cls_news_failed', kind: 'configuration_or_runtime', message: '财联社公开资讯采集未完成，请检查日期、文章链接或数据库配置。未输出密钥或上游原始错误。' }));
  process.exitCode = 1;
} finally {
  if (store) try { await store.close(); } catch { console.error(JSON.stringify({ type: 'cls_news_failed', kind: 'database' })); process.exitCode = 1; }
}
