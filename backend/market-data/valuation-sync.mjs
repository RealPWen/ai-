import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { normalizeTradeDate } from './postgres-store.mjs';
import { VALUATION_FIELDS, validateValuationRows } from './valuation-store.mjs';

export { VALUATION_FIELDS, validateValuationRows };
const API = 'daily_basic';
const KINDS = new Set(['permission', 'authentication', 'rate_limit', 'network', 'timeout', 'validation', 'invalid_response', 'database']);
const ERROR_CODES = { permission: 'permission_denied', authentication: 'authentication_error', rate_limit: 'rate_limited', database: 'database_error', validation: 'validation_error', network: 'network_error', timeout: 'network_error' };
function invalid(message) { const error = new Error(message); error.kind = 'validation'; return error; }
function kindOf(error) { return error?.code === 'DATABASE_ERROR' ? 'database' : KINDS.has(error?.kind) ? error.kind : 'unknown'; }
async function readJson(path, compressed = false) {
  try { const bytes = await readFile(path); return JSON.parse((compressed ? gunzipSync(bytes) : bytes).toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw invalid('本地估值缓存或日历损坏，请检查对应文件。'); }
}
async function atomicJson(path, value, compressed = false) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`), temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, compressed ? gzipSync(bytes) : bytes, { mode: 0o600 }); await rename(temporary, path);
}
function validCalendar(value, start, end) {
  if (!value || value.version !== 1 || value.market !== 'A' || value.startDate !== start || value.endDate !== end || !Array.isArray(value.dates) || !value.dates.length) return false;
  const unique = new Set();
  try {
    for (const date of value.dates) {
      if (normalizeTradeDate(date).compact !== date || date < start || date > end || unique.has(date)) return false;
      unique.add(date);
    }
  } catch { return false; }
  return true;
}

/** Newest first, one atomic all-stock day per cache file / transaction. */
export async function syncValuations({ client, store, cacheDir, startDate, endDate, mode = 'sync', log = () => {} }) {
  const start = normalizeTradeDate(startDate).compact, end = normalizeTradeDate(endDate).compact;
  if (start > end || !['download', 'import', 'sync'].includes(mode) || typeof cacheDir !== 'string' || !cacheDir) throw invalid('估值下载范围、运行方式或缓存位置无效。');
  if (mode !== 'import' && !client) throw invalid('下载估值需要 Tushare 客户端。');
  if (mode !== 'download' && !store) throw invalid('估值入库需要 PostgreSQL 连接。');
  const directory = join(cacheDir, 'valuations', 'A');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { version: 1, source: 'tushare', apiName: API, market: 'A', startDate: start, endDate: end, mode,
    startedAt: new Date().toISOString(), status: 'running', plannedDays: 0, completedDays: 0,
    downloadedDays: 0, importedDays: 0, cachedDays: 0, skippedDays: 0, rows: 0, days: [], failedDates: [] };
  const statusPath = join(directory, `status-${start}-${end}-${mode}.json`);
  await atomicJson(statusPath, report);
  try {
    if (mode !== 'download') await store.migrate();
    // Reuse the daily-price collector's calendar; never download daily prices here.
    const calendarDirectory = join(cacheDir, 'A');
    const calendarPath = join(calendarDirectory, `calendar-${start}-${end}.json`);
    let calendar = await readJson(calendarPath);
    if (!validCalendar(calendar, start, end)) {
      if (mode === 'import') throw invalid('缺少有效的 A 股交易日历，不能确认估值导入范围。');
      const rows = await client.query('trade_cal', { exchange: 'SSE', start_date: start, end_date: end, is_open: '1' }, 'cal_date,is_open');
      calendar = { version: 1, market: 'A', startDate: start, endDate: end,
        dates: rows.filter(row => row.is_open === 1 || row.is_open === '1').map(row => row.cal_date).sort(), fetchedAt: new Date().toISOString() };
      if (!validCalendar(calendar, start, end)) throw invalid('A 股交易日历为空、重复或超出请求范围。');
      await mkdir(calendarDirectory, { recursive: true, mode: 0o700 }); await atomicJson(calendarPath, calendar);
    }
    report.plannedDays = calendar.dates.length;
    const completed = mode === 'download' ? new Set() : await store.getCompletedDays({ market: 'A', apiName: API, startDate: start, endDate: end });
    log({ type: 'valuation_start', market: 'A', apiName: API, plannedDays: report.plannedDays, existingDays: completed.size });
    for (const tradeDate of [...calendar.dates].sort().reverse()) {
      const day = { date: tradeDate, status: 'pending' }; report.days.push(day);
      try {
        if (completed.has(tradeDate)) {
          report.skippedDays++; report.completedDays++; day.status = 'database_completed';
        } else {
          const path = join(directory, `${tradeDate}.json.gz`);
          let cached = await readJson(path, true);
          if (cached && (cached.version !== 1 || cached.source !== 'tushare' || cached.market !== 'A' || cached.apiName !== API || cached.tradeDate !== tradeDate)) throw invalid('估值缓存版本、来源或日期不匹配。');
          if (!cached) {
            if (mode === 'import') throw invalid('交易日估值缓存尚未下载。');
            const rows = await client.queryAll(API, { trade_date: tradeDate }, VALUATION_FIELDS, { pageSize: 6000, maxPages: 20, maxRows: 100000, primaryKey: ['ts_code', 'trade_date'] });
            validateValuationRows(rows, tradeDate);
            cached = { version: 1, source: 'tushare', market: 'A', apiName: API, tradeDate, fetchedAt: new Date().toISOString(), rows };
            await atomicJson(path, cached, true); report.downloadedDays++; day.downloaded = true;
          } else { report.cachedDays++; day.cached = true; }
          validateValuationRows(cached.rows, tradeDate);
          if (mode !== 'download') {
            await store.saveDay({ market: 'A', apiName: API, tradeDate, rows: cached.rows, runId: `valuations-${start}-${end}` });
            report.importedDays++;
          }
          report.completedDays++; report.rows += cached.rows.length;
          day.status = mode === 'download' ? 'downloaded' : 'imported'; day.rowsCount = cached.rows.length;
        }
        if (report.completedDays === 1 || report.completedDays % 10 === 0 || report.completedDays === report.plannedDays) log({ type: 'valuation_progress', date: tradeDate, completedDays: report.completedDays, plannedDays: report.plannedDays, rows: report.rows });
      } catch (error) {
        let kind = kindOf(error);
        day.status = 'failed'; day.kind = kind;
        if (store && mode !== 'download') {
          try { await store.markFailedDay({ market: 'A', apiName: API, tradeDate, errorCode: ERROR_CODES[kind] ?? 'provider_error' }); }
          catch { kind = 'database'; day.kind = kind; }
        }
        report.failedDates.push({ date: tradeDate, kind }); log({ type: 'valuation_day_failed', date: tradeDate, kind });
        if (['permission', 'authentication', 'rate_limit', 'database'].includes(kind)) { report.blockedBy = kind; await atomicJson(statusPath, report); break; }
      }
      await atomicJson(statusPath, report);
    }
    report.status = report.completedDays === report.plannedDays && !report.failedDates.length ? 'completed' : 'incomplete';
    if (store && mode !== 'download') report.database = await store.summary({ startDate: start, endDate: end });
  } catch (error) {
    report.status = 'incomplete'; report.blockedBy = kindOf(error);
    log({ type: 'valuation_failed', kind: report.blockedBy });
  }
  report.finishedAt = new Date().toISOString(); await atomicJson(statusPath, report); return report;
}
