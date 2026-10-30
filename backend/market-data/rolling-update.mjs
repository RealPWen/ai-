import { replaceFile } from '../src/replace-file.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeTradeDate } from './postgres-store.mjs';
import { syncDailyData } from './sync.mjs';
import { syncValuations } from './valuation-sync.mjs';
import { syncAdjustments, syncIndustries } from './industry-sync.mjs';
import { expandPriceHistoryWindow, PRICE_HISTORY_EXTRA_TRADING_DAYS } from './price-history-window.mjs';

export const ROLLING_APIS = Object.freeze(['daily', 'daily_basic', 'adj_factor', 'sw_daily']);
export const HK_ROLLING_APIS = Object.freeze(['hk_daily']);
const DAY_MS = 86_400_000;
const ERROR_CODES = new Set(['permission_denied', 'authentication_error', 'rate_limited', 'network_error', 'database_error', 'validation_error', 'provider_error', 'incomplete_window']);
const KIND_CODES = {
  permission: 'permission_denied', authentication: 'authentication_error', rate_limit: 'rate_limited',
  network: 'network_error', timeout: 'network_error', database: 'database_error', validation: 'validation_error', invalid_response: 'provider_error', incomplete_window: 'incomplete_window',
};
const COUNT_FIELDS = ['plannedDays', 'completedDays', 'downloadedDays', 'importedDays', 'cachedDays', 'skippedDays', 'rows'];

function invalid() { const error = new Error('滚动更新参数或交易日历无效。'); error.kind = 'validation'; return error; }
function safeCode(error) {
  if (ERROR_CODES.has(error?.errorCode)) return error.errorCode;
  if (error?.code === 'DATABASE_ERROR') return 'database_error';
  if (error?.code === 'VALIDATION_ERROR') return 'validation_error';
  return KIND_CODES[error?.kind] ?? 'provider_error';
}

/** One natural calendar year through yesterday; dates never depend on the host time zone. */
export function rollingWindowForDate(runDate) {
  const date = normalizeTradeDate(runDate);
  const current = new Date(`${date.iso}T00:00:00.000Z`);
  const year = current.getUTCFullYear() - 1, month = current.getUTCMonth();
  const previousYearLastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const start = new Date(Date.UTC(year, month, Math.min(current.getUTCDate(), previousYearLastDay)));
  const end = new Date(current.getTime() - DAY_MS);
  return {
    runDate: date.iso,
    windowStart: normalizeTradeDate(start.toISOString().slice(0, 10)).compact,
    windowEnd: normalizeTradeDate(end.toISOString().slice(0, 10)).compact,
  };
}

function tradingDates(rows, start, end) {
  if (!Array.isArray(rows) || !rows.length) throw invalid();
  const seen = new Map();
  for (const row of rows) {
    if (!row || ![0, 1, '0', '1'].includes(row.is_open)) throw invalid();
    const date = normalizeTradeDate(row.cal_date).compact;
    if (date !== row.cal_date || date < start || date > end || seen.has(date)) throw invalid();
    seen.set(date, Number(row.is_open));
  }
  // Closed days are required too: a truncated/empty response must never authorize pruning.
  let cursor = new Date(`${normalizeTradeDate(start).iso}T00:00:00.000Z`).getTime();
  const finish = new Date(`${normalizeTradeDate(end).iso}T00:00:00.000Z`).getTime();
  const dates = [];
  for (; cursor <= finish; cursor += DAY_MS) {
    const date = new Date(cursor).toISOString().slice(0, 10).replaceAll('-', '');
    if (!seen.has(date)) throw invalid();
    if (seen.get(date) === 1) dates.push(date);
  }
  if (!dates.length) throw invalid();
  return dates;
}

async function saveCalendar(cacheDir, window, dates, market) {
  const directory = join(cacheDir, market);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `calendar-${window.windowStart}-${window.windowEnd}.json`);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const value = { version: 1, market, startDate: window.windowStart, endDate: window.windowEnd, dates, fetchedAt: new Date().toISOString() };
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await replaceFile(temporary, path);
}

function collectorSummary(report, apiName, market) {
  const detail = ['daily', 'hk_daily'].includes(apiName) ? report?.markets?.find(item => item.market === market && item.apiName === apiName) : report;
  if (report?.status !== 'completed' || !detail || detail.status !== 'completed') {
    const error = new Error('本轮数据未完成，不清理历史数据。');
    error.errorCode = KIND_CODES[detail?.blockedBy ?? report?.blockedBy ?? detail?.failedDates?.[0]?.kind] ?? 'incomplete_window';
    throw error;
  }
  const counts = {};
  for (const field of COUNT_FIELDS) {
    const count = detail[field] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw invalid();
    counts[field] = count;
  }
  if (counts.plannedDays !== counts.completedDays || detail.failedDates?.length) {
    const error = new Error('本轮数据未完成，不清理历史数据。'); error.errorCode = 'incomplete_window'; throw error;
  }
  return counts;
}

/**
 * Incremental, resumable market update. Individual suspended/missing stocks need
 * no synthetic rows. Existing collectors commit one complete market day at a time;
 * only the final locked transaction can remove observations older than the window.
 */
export async function updateRollingMarketData({
  client, store, marketStore, valuationStore, industryStore, cacheDir, runDate, market = 'A', log = () => {}, collectors = {},
} = {}) {
  let window;
  const summary = {};
  const safeLog = entry => { try { log(entry); } catch { /* Progress reporting is optional. */ } };
  try {
    window = rollingWindowForDate(runDate);
    const lookupWindow = market === 'A' ? expandPriceHistoryWindow(window) : window;
    if (!client || typeof client.query !== 'function' || !store || typeof store.withLock !== 'function'
      || !['A', 'HK'].includes(market) || typeof cacheDir !== 'string' || !cacheDir.trim() || !marketStore
      || (market === 'A' && (!valuationStore || !industryStore))) throw invalid();
    await store.migrate();
    const result = await store.withLock(async scope => {
      const previous = await scope.getRun(window.runDate);
      const historyComplete = market !== 'A' || (previous?.summary?.priceHistoryExtraTradingDays === PRICE_HISTORY_EXTRA_TRADING_DAYS
        && previous.summary.priceHistoryWindowStart < window.windowStart
        && previous.summary.priceHistoryWindowStart >= lookupWindow.windowStart
        && normalizeTradeDate(previous.windowStart).compact === window.windowStart
        && normalizeTradeDate(previous.windowEnd).compact === window.windowEnd);
      if (previous?.status === 'succeeded' && historyComplete) return { status: 'already_completed', ...window, summary: previous.summary ?? {} };
      let began = false;
      try {
        await scope.beginRun({ ...window, reopen: previous?.status === 'succeeded' }); began = true;
        safeLog({ type: 'rolling_update_started', market, ...window });
        // Query unfiltered calendar rows, validate every calendar date, then share
        // the validated open-date cache with all four existing collectors.
        const rows = await client.query(market === 'HK' ? 'hk_tradecal' : 'trade_cal', {
          ...(market === 'A' ? { exchange: 'SSE' } : {}), start_date: lookupWindow.windowStart, end_date: window.windowEnd,
        }, 'cal_date,is_open');
        const lookupDates = tradingDates(rows, lookupWindow.windowStart, window.windowEnd);
        const expectedDates = lookupDates.filter(date => date >= window.windowStart);
        if (!expectedDates.length) throw invalid();
        const baselineDate = lookupDates.filter(date => date < window.windowStart).at(-1);
        if (market === 'A' && !baselineDate) throw invalid();
        const historyWindow = market === 'A' ? expandPriceHistoryWindow(window, baselineDate) : window;
        const historyExpectedDates = market === 'A' ? [baselineDate, ...expectedDates] : expectedDates;
        await saveCalendar(cacheDir, window, expectedDates, market);
        if (market === 'A') {
          await saveCalendar(cacheDir, historyWindow, historyExpectedDates, market);
          summary.priceHistoryWindowStart = historyWindow.windowStart;
          summary.priceHistoryExtraTradingDays = PRICE_HISTORY_EXTRA_TRADING_DAYS;
        }
        const common = { client, cacheDir, startDate: window.windowStart, endDate: window.windowEnd, mode: 'sync', log: safeLog };
        const operations = market === 'HK' ? [
          ['hk_daily', collectors.daily ?? syncDailyData, marketStore, { markets: ['HK'] }],
        ] : [
          ['daily', collectors.daily ?? syncDailyData, marketStore, { markets: ['A'] }],
          ['daily_basic', collectors.valuations ?? syncValuations, valuationStore, {}],
          ['adj_factor', collectors.adjustments ?? syncAdjustments, industryStore, {}],
          ['sw_daily', collectors.industries ?? syncIndustries, industryStore, { refresh: false }],
        ];
        for (const [apiName, collect, targetStore, extra] of operations) {
          const buffered = market === 'A' && ['daily', 'adj_factor'].includes(apiName);
          const report = await collect({ ...common, ...(buffered ? { startDate: historyWindow.windowStart } : {}), store: targetStore, ...extra });
          summary[apiName] = collectorSummary(report, apiName, market);
          if (summary[apiName].plannedDays !== (buffered ? historyExpectedDates : expectedDates).length) throw invalid();
        }
        const finalized = await scope.finalize({ ...window, expectedDates,
          ...(market === 'A' ? { priceHistoryExpectedDates: historyExpectedDates } : {}),
          apis: [...(market === 'HK' ? HK_ROLLING_APIS : ROLLING_APIS)], summary });
        safeLog({ type: 'rolling_update_succeeded', market, ...window });
        return { status: 'succeeded', ...window, summary: { ...summary, ...(finalized?.deleted ? { deleted: finalized.deleted } : {}) } };
      } catch (error) {
        let errorCode = safeCode(error);
        if (began) {
          try { await scope.failRun({ runDate: window.runDate, errorCode }); }
          catch { errorCode = 'database_error'; }
        }
        safeLog({ type: 'rolling_update_failed', market, ...window, errorCode });
        return { status: 'failed', ...window, summary, errorCode };
      }
    });
    return result?.status === 'busy' || !result ? { status: 'busy', ...window, summary: {} } : result;
  } catch (error) {
    const errorCode = safeCode(error);
    safeLog({ type: 'rolling_update_failed', market, ...(window ?? {}), errorCode });
    return { status: 'failed', ...(window ?? { runDate: null, windowStart: null, windowEnd: null }), summary, errorCode };
  }
}
