import { replaceFile } from '../src/replace-file.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { rollingWindowForDate } from './rolling-update.mjs';
import { expandPriceHistoryWindow } from './price-history-window.mjs';
import { normalizeTradeDate } from './postgres-store.mjs';
import { missingHkPoolRanges, validateHkPoolRows, normalizeHkPoolRange } from './hk-pool-store.mjs';
import { syncHkListedCatalog } from './hk-listed-catalog.mjs';
import { createTencentHkClient } from './tencent-hk-client.mjs';

const SOURCE = 'tencent', API = 'tencent_hk_daily';
const priceSemantics = currency => ({ adjustment: 'none', volumeUnit: 'share', amountUnit: currency.toLowerCase(), currency });
function invalid() { const error = new Error('港股全市场更新参数或响应无效。'); error.kind = 'validation'; return error; }
function safeCode(error) {
  if (error?.code === 'DATABASE_ERROR') return 'database_error';
  return { network: 'network_error', timeout: 'network_error', database: 'database_error', validation: 'validation_error',
    configuration: 'validation_error', permission: 'permission_denied', authentication: 'authentication_error', rate_limit: 'rate_limited', no_data: 'no_data' }[error?.kind] ?? 'provider_error';
}
function datesInRange(startDate, endDate) {
  const { start, end } = normalizeHkPoolRange(startDate, endDate), dates = [];
  for (let cursor = Date.parse(start.iso); cursor <= Date.parse(end.iso); cursor += 86400000) {
    const value = new Date(cursor); dates.push({ date: value.toISOString().slice(0, 10).replaceAll('-', ''), weekend: [0, 6].includes(value.getUTCDay()) });
  }
  return dates;
}
async function calendarFor(client, window) {
  if (typeof client?.query !== 'function') return null;
  try {
    const rows = await client.query('hk_tradecal', { start_date: window.windowStart, end_date: window.windowEnd }, 'cal_date,is_open');
    if (!Array.isArray(rows)) return null;
    const expected = new Set(datesInRange(window.windowStart, window.windowEnd).map(row => row.date)), result = new Map();
    for (const row of rows) {
      if (!expected.has(row?.cal_date) || result.has(row.cal_date) || ![0, 1, '0', '1'].includes(row.is_open)) return null;
      result.set(row.cal_date, Number(row.is_open));
    }
    return result.size === expected.size ? result : null;
  } catch { return null; }
}
function closure(range, calendar) {
  const dates = datesInRange(range.startDate, range.endDate);
  if (dates.every(row => row.weekend)) return { emptyProof: 'weekends' };
  if (calendar && dates.every(row => calendar.get(row.date) === 0)) return { emptyProof: 'hk_tradecal', calendarRows: dates.map(row => ({ cal_date: row.date, is_open: 0 })) };
  return null;
}
async function cachedOrCollect({ cacheDir, ticker, range, collect, retryEmpty, currency, minimumTradeDate }) {
  const directory = join(cacheDir, 'hk-market', SOURCE, ticker), path = join(directory, `${range.startDate}-${range.endDate}.json.gz`);
  const identity = { source: SOURCE, apiName: API, ticker, ...range };
  const semantics = priceSemantics(currency);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let cached;
  try { cached = JSON.parse(gunzipSync(await readFile(path)).toString('utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') {
      // Preserve a damaged cache for audit, then fetch the range again.
      await replaceFile(path, `${path}.invalid-${randomUUID()}`);
    }
  }
  if (cached) {
    const cachedSemantics = { adjustment: cached.adjustment ?? cached.raw?.adjustment, volumeUnit: cached.volumeUnit ?? cached.raw?.units?.volume,
      amountUnit: cached.amountUnit ?? cached.raw?.units?.amount, currency: cached.currency ?? cached.raw?.units?.currency };
    const rawSemantics = { adjustment: cached.raw?.adjustment, volumeUnit: cached.raw?.units?.volume,
      amountUnit: cached.raw?.units?.amount, currency: cached.raw?.units?.currency };
    if (cached.version !== 1 || Object.entries(identity).some(([key, value]) => cached[key] !== value)
      || Object.entries(semantics).some(([key, value]) => cachedSemantics[key] !== value
        || rawSemantics[key] !== undefined && rawSemantics[key] !== value)) throw invalid();
    validateHkPoolRows(cached.rows, { ticker, ...range, allowEmpty: true });
    if (!cached.rows.length && cached.raw?.sourceEmpty !== true) throw invalid();
    if (!retryEmpty || cached.rows.some(row => row.trade_date >= minimumTradeDate)) return { rows: cached.rows, cached: true };
  }
  const value = await collect({ ticker, ...range, allowEmpty: true, currency });
  if (!value || value.source !== SOURCE || value.apiName !== API || Object.entries(semantics).some(([key, expected]) => value[key] !== expected)) throw invalid();
  validateHkPoolRows(value.rows, { ticker, ...range, allowEmpty: true });
  if (!value.rows.length && value.raw?.sourceEmpty !== true) throw invalid();
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, gzipSync(Buffer.from(`${JSON.stringify({ version: 1, ...identity, ...semantics, rows: value.rows, raw: value.raw,
    fetchedAt: new Date().toISOString() })}\n`)), { mode: 0o600 });
  await replaceFile(temporary, path);
  return { rows: value.rows, cached: false };
}

/** Listed HK company counters only. Prices and their coverage are independent
 * of the 28-stock valuation/EPS pool. Individual provider gaps never certify
 * coverage or authorize deletion; other symbols can continue and resume. */
export async function updateRollingHongKongMarket({ client, store, cacheDir, runDate, catalog, catalogSync = syncHkListedCatalog,
  collector, intervalMs = 500, concurrency = 3, retryNoData = false, log = () => {} } = {}) {
  let window, universe;
  const summary = { plannedTickers: 0, completedTickers: 0, skippedTickers: 0, noDataTickers: 0, failedTickers: 0,
    downloadedRanges: 0, cachedRanges: 0, closedRanges: 0, rows: 0, deleted: 0, priceHistoryExtraTradingDays: 1 };
  const safeLog = value => { try { log(value); } catch {} };
  const result = (status, extra = {}) => ({ status, ...window, source: SOURCE, apiName: API, priceScope: 'all',
    universeHash: universe?.universeHash, summary, ...extra });
  try {
    window = rollingWindowForDate(runDate);
    if (typeof store?.withLock !== 'function' || typeof store?.migrate !== 'function' || typeof store?.upsertCatalog !== 'function'
      || typeof cacheDir !== 'string' || !cacheDir.trim() || !Number.isInteger(intervalMs) || intervalMs < 0
      || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw invalid();
    universe = catalog ?? await catalogSync({ client, cacheDir, asOf: window.runDate, log: safeLog });
    if (universe?.complete !== true || normalizeTradeDate(universe.asOf).iso !== window.runDate) throw invalid();
    await store.migrate();
    summary.plannedTickers = universe.securities.length;
    const run = { ...window, universeHash: universe.universeHash, tickers: universe.securities.map(row => row.ticker) };
    const providers = Array.from({ length: concurrency }, () => collector ?? createTencentHkClient({ intervalMs: 0, maxRetries: 0 }).collectDaily);
    if (providers.some(collect => typeof collect !== 'function')) throw invalid();
    let startQueue = Promise.resolve(), lastStarted = -Infinity;
    const scheduleCollect = (worker, options) => {
      const started = startQueue.then(async () => {
        const pause = Math.max(0, lastStarted + intervalMs - Date.now());
        if (pause) await new Promise(resolve => setTimeout(resolve, pause));
        lastStarted = Date.now();
        // The gate releases when the request starts, rather than after its
        // response. Three workers share this single request-start budget.
        return { response: providers[worker](options) };
      });
      startQueue = started.then(() => {}, () => {});
      return started.then(value => value.response);
    };
    const outcome = await store.withLock(async rawScope => {
      // One pg client owns the lock: each store method (including a complete
      // transaction) must finish before another worker uses that client.
      let databaseQueue = Promise.resolve();
      const scope = Object.fromEntries(Object.entries(rawScope).map(([name, method]) => [name, (...args) => {
        const pending = databaseQueue.then(() => method(...args));
        databaseQueue = pending.catch(() => {}); return pending;
      }]));
      await store.upsertCatalog(universe);
      const previous = await scope.getRun(run);
      await scope.beginRun(run);
      safeLog({ type: 'hk_market_update_started', ...window, universeHash: universe.universeHash, plannedTickers: summary.plannedTickers });
      const calendar = await calendarFor(client, window);
      if (calendar) {
        const directory = join(cacheDir, 'hk-market', 'calendars');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${window.runDate}.json`), temporary = `${path}.tmp-${randomUUID()}`;
        await writeFile(temporary, `${JSON.stringify({ source: 'tushare', apiName: 'hk_tradecal', ...window,
          fetchedAt: new Date().toISOString(), rows: [...calendar].map(([cal_date, is_open]) => ({ cal_date, is_open })) })}\n`, { mode: 0o600 });
        await replaceFile(temporary, path);
      }
      let fatal = null, nextSecurity = 0;
      const worker = async workerIndex => {
      while (!fatal && nextSecurity < universe.securities.length) {
        const security = universe.securities[nextSecurity++];
        const ticker = security.ticker;
        try {
          const currency = security.currency ?? 'HKD';
          if (!['HKD', 'USD'].includes(currency)) throw invalid();
          const completed = await scope.getRanges({ ticker, startDate: window.windowStart, endDate: window.windowEnd });
          const missing = missingHkPoolRanges(completed, window.windowStart, window.windowEnd);
          if (!missing.length) {
            await scope.confirmSymbol?.({ ...run, ticker, currency });
            summary.completedTickers++; summary.skippedTickers++; continue;
          }
          const attempt = await scope.getSymbolAttempt?.({ ...run, ticker });
          if (!retryNoData && attempt?.status === 'no_data') { summary.noDataTickers++; summary.skippedTickers++; continue; }
          let complete = false, noData = false;
          for (const missingRange of missing) {
            const proof = closure(missingRange, calendar);
            const range = !completed.length ? { startDate: expandPriceHistoryWindow(window).windowStart, endDate: window.windowEnd } : missingRange;
            const data = proof ? { rows: [], closed: true } : await cachedOrCollect({ cacheDir, ticker, range,
              collect: options => scheduleCollect(workerIndex, options), retryEmpty: retryNoData, currency, minimumTradeDate: window.windowStart });
            if (data.closed) summary.closedRanges++;
            else if (data.cached) summary.cachedRanges++;
            else summary.downloadedRanges++;
            if (!proof && !data.rows.some(row => row.trade_date >= window.windowStart)) {
              await scope.markSymbol({ ...run, ticker, status: 'no_data', errorCode: 'no_data' }); noData = true; break;
            }
            const saved = await scope.saveSymbol({ ...run, ticker, requestedStartDate: proof ? missingRange.startDate : range.startDate,
              requestedEndDate: proof ? missingRange.endDate : range.endDate, rows: data.rows, listDate: security.listDate, currency, ...(proof ?? {}) });
            summary.rows += saved.rowsCount; summary.deleted += saved.deleted ?? 0; complete = saved.complete;
          }
          if (noData) summary.noDataTickers++;
          else if (complete) summary.completedTickers++;
          else { summary.failedTickers++; await scope.markSymbol({ ...run, ticker, status: 'failed', errorCode: 'incomplete_window' }); }
        } catch (error) {
          const code = safeCode(error);
          if (code === 'no_data') summary.noDataTickers++; else summary.failedTickers++;
          if (code !== 'database_error') await scope.markSymbol({ ...run, ticker, status: code === 'no_data' ? 'no_data' : 'failed', errorCode: code });
          safeLog({ type: 'hk_market_ticker_failed', ticker, errorCode: code });
          if (['database_error', 'rate_limited', 'permission_denied', 'authentication_error'].includes(code)) { fatal = code; break; }
        }
        safeLog({ type: 'hk_market_progress', ticker, ...summary });
      }
      };
      const workers = await Promise.allSettled(Array.from({ length: concurrency }, (_, index) => worker(index)));
      const rejected = workers.find(value => value.status === 'rejected');
      if (rejected) throw rejected.reason;
      const status = fatal || summary.noDataTickers || summary.failedTickers ? (summary.completedTickers ? 'partial' : 'failed') : 'succeeded';
      await scope.finishRun({ ...run, status, summary });
      return result(previous?.status === 'succeeded' && status === 'succeeded' && summary.skippedTickers === summary.plannedTickers ? 'already_completed' : status,
        status === 'succeeded' ? {} : { errorCode: fatal ?? (summary.failedTickers ? 'provider_error' : 'no_data') });
    });
    const final = outcome?.status === 'busy' ? result('busy') : outcome;
    safeLog({ type: 'hk_market_update_result', ...final });
    return final;
  } catch (error) {
    const final = result('failed', { errorCode: safeCode(error) }); safeLog({ type: 'hk_market_update_result', ...final }); return final;
  }
}
