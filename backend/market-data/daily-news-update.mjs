import { createHash } from 'node:crypto';
import { unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeTradeDate } from './postgres-store.mjs';
import { todayShanghai } from '../src/input.mjs';
import { syncClsNewsSearch } from './cls-news-search.mjs';

const SAFE_STOPS = new Set(['range_start_confirmed', 'range_already_reached', 'search_exhausted_after_start']);
const SAFE_CODES = new Set(['permission_denied', 'authentication_error', 'rate_limited', 'network_error', 'database_error', 'validation_error', 'provider_error', 'incomplete_window']);
const SAFE_REASONS = new Set([...SAFE_STOPS, 'page_limit', 'permission', 'captcha', 'rate_limit', 'network', 'timeout', 'provider', 'invalid_response', 'database', 'validation',
  'unknown', 'search_index_exhausted', 'no_article_rows', 'repeated_page', 'non_monotonic_page', 'oldest_time_not_descending']);
const KIND_CODES = { permission: 'permission_denied', captcha: 'permission_denied', authentication: 'authentication_error', rate_limit: 'rate_limited',
  network: 'network_error', timeout: 'network_error', database: 'database_error', validation: 'validation_error', invalid_response: 'provider_error', provider: 'provider_error' };
const invalid = () => Object.assign(new Error('每日资讯更新参数或范围无效。'), { kind: 'validation' });
const codeFor = value => SAFE_CODES.has(value?.errorCode) ? value.errorCode : value?.code === 'DATABASE_ERROR' ? 'database_error'
  : value?.code === 'VALIDATION_ERROR' ? 'validation_error' : KIND_CODES[value?.kind ?? value?.stopReason] ?? 'incomplete_window';

/** Previous complete Shanghai calendar day, independently of machine time zone. */
export function dailyClsNewsWindow(runDate) {
  const run = normalizeTradeDate(runDate), end = new Date(`${run.iso}T00:00:00.000+08:00`).getTime();
  return { runDate: run.iso, windowStart: new Date(end - 86400000).toISOString(), windowEnd: new Date(end).toISOString() };
}

function collectorSummary(report, window) {
  const summary = { searchType: 'depth', searchKeyword: '财联社', start: window.windowStart, end: window.windowEnd,
    rangeReachedStart: report?.rangeReachedStart === true, coverageVerified: false, historicalPointInTime: false,
    stopReason: SAFE_REASONS.has(report?.stopReason) ? report.stopReason : 'unknown' };
  for (const field of ['runPages', 'completedPages', 'runSaved', 'runLinks', 'cachedPages', 'requests', 'nextPage']) {
    const value = report?.[field] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0 || field === 'nextPage' && value > 100000) throw invalid();
    summary[field] = value;
  }
  summary.warningCount = Array.isArray(report?.warnings) ? report.warnings.length : 0;
  return summary;
}

/** Invalidate only an uncommitted terminal page. Previously committed public pages remain reusable. */
async function resetTerminalCache(cacheDir, previous, window) {
  const page = previous?.summary?.nextPage;
  if (!previous || previous.status === 'succeeded' || previous.errorCode === 'database_error' || !Number.isSafeInteger(page) || page < 0 || page > 100000) return;
  const keywordKey = createHash('sha256').update('财联社').digest('hex').slice(0, 24);
  const range = `${window.windowStart.replace(/[-:.]/g, '')}-${window.windowEnd.replace(/[-:.]/g, '')}`;
  const path = join(cacheDir, 'news', 'cls_web', `search-${keywordKey}`, range, 'pages', `page-${page}.json`);
  try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw Object.assign(new Error('未能重置上一轮未完成的资讯页。'), { kind: 'provider' }); }
}

/** A page budget is a pause, so continue only a checkpoint matching the daily ledger. */
async function canResumePageBudget(cacheDir, previous, window) {
  if (previous?.status === 'succeeded' || previous?.summary?.stopReason !== 'page_limit') return false;
  const expectedPage = previous.summary.nextPage;
  if (!Number.isSafeInteger(expectedPage) || expectedPage < 1 || expectedPage > 100000) throw invalid();
  const keywordKey = createHash('sha256').update('财联社').digest('hex').slice(0, 24);
  const range = `${window.windowStart.replace(/[-:.]/g, '')}-${window.windowEnd.replace(/[-:.]/g, '')}`;
  const base = join(cacheDir, 'news', 'cls_web', `search-${keywordKey}`);
  let latest, checkpoint;
  try {
    latest = JSON.parse(await readFile(join(base, 'latest.json'), 'utf8'));
    // Never use an unvalidated pointer to construct a filesystem path.
    if (latest.version !== 1 || latest.rangeKey !== range || latest.searchType !== 'depth' || latest.searchKeyword !== '财联社') throw invalid();
    checkpoint = JSON.parse(await readFile(join(base, range, 'checkpoint.json'), 'utf8'));
  } catch { throw invalid(); }
  if (checkpoint.version !== 1 || checkpoint.sourceApi !== 'cls_web' || checkpoint.searchType !== 'depth' || checkpoint.searchKeyword !== '财联社'
    || checkpoint.start !== window.windowStart || checkpoint.end !== window.windowEnd || checkpoint.nextPage !== expectedPage
    || checkpoint.status !== 'partial' || checkpoint.stopReason !== 'page_limit' || checkpoint.rangeReachedStart !== false
    || checkpoint.coverageVerified !== false || checkpoint.historicalPointInTime !== false) throw invalid();
  return true;
}

/** Independent, retryable daily keyword traversal; its outcome must not hide market-data outcomes. */
export async function updateDailyClsNews({ store, newsStore, cacheDir, runDate, now = new Date(), log = () => {}, collector = syncClsNewsSearch,
  maxPages = 1000, fetchImpl, sleep, clock } = {}) {
  let window, summary = {};
  const safeLog = value => { try { log(value); } catch {} };
  try {
    const current = new Date(typeof now === 'function' ? now() : now);
    if (!Number.isFinite(current.getTime())) throw invalid();
    window = dailyClsNewsWindow(runDate ?? todayShanghai(current));
    if (Date.parse(window.windowEnd) > current.getTime() || !store || typeof store.migrate !== 'function' || typeof store.withLock !== 'function'
      || !newsStore || typeof newsStore.migrate !== 'function' || typeof cacheDir !== 'string' || !cacheDir.trim()
      || typeof collector !== 'function' || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5000) throw invalid();
    await store.migrate();
    const result = await store.withLock(async scope => {
      const previous = await scope.getRun(window.runDate);
      if (previous?.status === 'succeeded') return { status: 'already_completed', ...window, summary: previous.summary ?? {} };
      let began = false;
      try {
        await scope.beginRun(window); began = true;
        await newsStore.migrate();
        const dailyCacheDir = join(cacheDir, 'daily', window.runDate);
        const resumePageBudget = await canResumePageBudget(dailyCacheDir, previous, window);
        if (!resumePageBudget) await resetTerminalCache(dailyCacheDir, previous, window);
        safeLog({ type: 'daily_news_update_started', ...window });
        // A page limit continues its verified cursor; provider/validation failures
        // rebuild state with reusable good pages and retry the uncommitted page.
        const report = await collector({ store: newsStore, cacheDir: dailyCacheDir, keyword: '财联社',
          ...(resumePageBudget ? { resume: true } : { startDate: window.windowStart, endDate: window.windowEnd, resume: false }),
          now: current, maxPages, log: safeLog, ...(fetchImpl ? { fetchImpl } : {}), ...(sleep ? { sleep } : {}), ...(clock ? { clock } : {}) });
        summary = collectorSummary(report, window);
        const confirmed = report?.status === 'range_reached' && report.rangeReachedStart === true && SAFE_STOPS.has(report.stopReason)
          && report.coverageVerified === false && report.historicalPointInTime === false && report.start === window.windowStart && report.end === window.windowEnd
          && report.sourceApi === 'cls_web' && report.searchType === 'depth' && report.searchKeyword === '财联社';
        if (!confirmed) {
          const errorCode = codeFor(report);
          await scope.failRun({ runDate: window.runDate, errorCode, summary });
          const status = errorCode === 'incomplete_window' ? 'partial' : 'failed';
          safeLog({ type: 'daily_news_update_failed', ...window, status, errorCode });
          return { status, ...window, summary, errorCode };
        }
        const finalized = await scope.finalize({ ...window, summary });
        safeLog({ type: 'daily_news_update_succeeded', ...window, coverageVerified: false });
        return { status: 'succeeded', ...window, summary: finalized?.summary ?? summary };
      } catch (error) {
        let errorCode = codeFor(error); if (errorCode === 'incomplete_window') errorCode = 'provider_error';
        if (began) try { await scope.failRun({ runDate: window.runDate, errorCode, summary }); } catch { errorCode = 'database_error'; }
        safeLog({ type: 'daily_news_update_failed', ...window, errorCode });
        return { status: 'failed', ...window, summary, errorCode };
      }
    });
    return result?.status === 'busy' || !result ? { status: 'busy', ...window, summary: {} } : result;
  } catch (error) {
    let errorCode = codeFor(error); if (errorCode === 'incomplete_window') errorCode = 'provider_error';
    safeLog({ type: 'daily_news_update_failed', ...(window ?? {}), errorCode });
    return { status: 'failed', ...(window ?? { runDate: null, windowStart: null, windowEnd: null }), summary, errorCode };
  }
}
