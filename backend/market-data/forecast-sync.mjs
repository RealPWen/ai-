import { replaceFile } from '../src/replace-file.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { FORECAST_FIELDS, validateForecastRows, forecastRange, forecastValidationError } from './forecast-store.mjs';

export { FORECAST_FIELDS, validateForecastRows };
const API = 'report_rc';
const KINDS = new Set(['permission', 'authentication', 'rate_limit', 'network', 'timeout', 'validation', 'invalid_response', 'database']);
const ERROR_CODES = { permission: 'permission_denied', authentication: 'authentication_error', rate_limit: 'rate_limited', database: 'database_error', validation: 'validation_error', invalid_response: 'validation_error', network: 'network_error', timeout: 'network_error' };
function kindOf(error) { return error?.code === 'DATABASE_ERROR' ? 'database' : KINDS.has(error?.kind) ? error.kind : 'unknown'; }
async function atomicJson(path, value, compressed = false) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`), temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, compressed ? gzipSync(bytes) : bytes, { mode: 0o600 }); await replaceFile(temporary, path);
}
async function readCache(path) {
  try { return JSON.parse(gunzipSync(await readFile(path)).toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw forecastValidationError('卖方预测本地缓存损坏，请检查对应文件。'); }
}
/** Calendar-month partitions, clipped to the inclusive request; reports published on weekends are included. */
export function partitionForecastRange(startDate, endDate) {
  const { start, end } = forecastRange(startDate, endDate), result = [];
  let cursor = start.iso;
  while (cursor <= end.iso) {
    const year = Number(cursor.slice(0, 4)), month = Number(cursor.slice(5, 7));
    const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const until = monthEnd < end.iso ? monthEnd : end.iso;
    result.push({ startDate: cursor.replaceAll('-', ''), endDate: until.replaceAll('-', '') });
    cursor = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  }
  return result.reverse();
}
/** report_rc has nullable report identity fields and many rows per ticker, so daily-price queryAll keys cannot be reused. */
export async function fetchForecastRows(client, startDate, endDate, { pageSize = 3000, maxPages = 400, maxRows = 1000000 } = {}) {
  const { start, end } = forecastRange(startDate, endDate);
  if (!client || typeof client.query !== 'function' || ![pageSize, maxPages, maxRows].every(value => Number.isInteger(value) && value > 0) || pageSize > 3000) throw forecastValidationError('卖方预测分页参数无效。');
  const result = [], pages = new Set(); let schema;
  for (let page = 0; page < maxPages; page++) {
    const rows = await client.query(API, { start_date: start.compact, end_date: end.compact, limit: pageSize, offset: result.length }, FORECAST_FIELDS);
    if (!Array.isArray(rows) || rows.length > pageSize) throw forecastValidationError('卖方预测分页返回格式或条数异常。');
    if (!rows.length) { validateForecastRows(result, start.compact, end.compact); return result; }
    validateForecastRows(rows, start.compact, end.compact);
    const pageSchema = JSON.stringify(Object.keys(rows[0]).sort());
    if (schema && schema !== pageSchema) throw forecastValidationError('卖方预测分页字段变化，无法确认数据完整。');
    schema = pageSchema;
    const fingerprint = JSON.stringify(rows);
    if (pages.has(fingerprint)) throw forecastValidationError('卖方预测返回重复分页，无法确认数据完整。');
    pages.add(fingerprint);
    if (result.length + rows.length > maxRows) throw forecastValidationError('卖方预测条数超过配置上限。');
    result.push(...rows);
    // Continue after a short page: provider caps may be lower than the requested limit.
  }
  throw forecastValidationError('卖方预测分页次数超过配置上限，无法确认数据完整。');
}

export async function syncForecasts({ client, store, cacheDir, startDate, endDate, mode = 'sync', refresh = false, log = () => {} }) {
  const { start, end } = forecastRange(startDate, endDate);
  if (!['download', 'import', 'sync'].includes(mode) || typeof cacheDir !== 'string' || !cacheDir || typeof refresh !== 'boolean' || (mode === 'import' && refresh)) throw forecastValidationError('卖方预测运行方式、缓存位置或刷新选项无效。');
  if (mode !== 'import' && !client) throw forecastValidationError('下载卖方预测需要 Tushare 客户端。');
  if (mode !== 'download' && !store) throw forecastValidationError('卖方预测入库需要 PostgreSQL 连接。');
  const directory = join(cacheDir, 'forecasts', 'A'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const partitions = partitionForecastRange(start.compact, end.compact);
  const report = { version: 1, source: 'tushare', apiName: API, market: 'A', startDate: start.compact, endDate: end.compact, mode, refresh,
    startedAt: new Date().toISOString(), status: 'running', plannedRanges: partitions.length, completedRanges: 0,
    downloadedRanges: 0, importedRanges: 0, cachedRanges: 0, skippedRanges: 0, rows: 0, rawRows: 0, duplicateRows: 0, ranges: [], failedRanges: [] };
  const statusPath = join(directory, `status-${start.compact}-${end.compact}-${mode}.json`); await atomicJson(statusPath, report);
  try {
    if (mode !== 'download') await store.migrate();
    const completed = mode === 'download' || refresh ? new Set() : await store.getCompletedRanges({ startDate: start.compact, endDate: end.compact });
    log({ type: 'forecast_start', market: 'A', apiName: API, plannedRanges: partitions.length, existingRanges: completed.size });
    for (const partition of partitions) {
      const key = `${partition.startDate}-${partition.endDate}`, entry = { ...partition, status: 'pending' }; report.ranges.push(entry);
      try {
        if (completed.has(key)) {
          report.skippedRanges++; report.completedRanges++; entry.status = 'database_completed';
        } else {
          const path = join(directory, `${key}.json.gz`); let cached = refresh ? null : await readCache(path);
          if (cached && (cached.version !== 1 || cached.source !== 'tushare' || cached.market !== 'A' || cached.apiName !== API || cached.startDate !== partition.startDate || cached.endDate !== partition.endDate
            || typeof cached.fetchedAt !== 'string' || !Number.isFinite(Date.parse(cached.fetchedAt)))) throw forecastValidationError('卖方预测缓存版本、来源、时间或日期范围不匹配。');
          if (!cached) {
            if (mode === 'import') throw forecastValidationError('卖方预测范围缓存尚未下载。');
            const rows = await fetchForecastRows(client, partition.startDate, partition.endDate);
            cached = { version: 1, source: 'tushare', market: 'A', apiName: API, ...partition, fetchedAt: new Date().toISOString(), rows };
            await atomicJson(path, cached, true); report.downloadedRanges++; entry.downloaded = true;
          } else { report.cachedRanges++; entry.cached = true; }
          const validated = validateForecastRows(cached.rows, partition.startDate, partition.endDate);
          if (mode !== 'download') {
            await store.saveRange({ ...partition, rows: cached.rows, fetchedAt: cached.fetchedAt, runId: `forecasts-${start.compact}-${end.compact}` }); report.importedRanges++;
          }
          report.completedRanges++; report.rows += validated.length; report.rawRows += cached.rows.length; report.duplicateRows += cached.rows.length - validated.length;
          entry.status = mode === 'download' ? 'downloaded' : 'imported'; entry.rowsCount = validated.length; entry.rawRowsCount = cached.rows.length;
        }
        log({ type: 'forecast_progress', ...partition, completedRanges: report.completedRanges, plannedRanges: report.plannedRanges, rows: report.rows, rawRows: report.rawRows });
      } catch (error) {
        let kind = kindOf(error); entry.status = 'failed'; entry.kind = kind;
        if (store && mode !== 'download') {
          try { await store.markFailedRange({ ...partition, errorCode: ERROR_CODES[kind] ?? 'provider_error' }); }
          catch { kind = 'database'; entry.kind = kind; }
        }
        report.failedRanges.push({ ...partition, kind }); log({ type: 'forecast_range_failed', ...partition, kind });
        if (['permission', 'authentication', 'rate_limit', 'database'].includes(kind)) { report.blockedBy = kind; await atomicJson(statusPath, report); break; }
      }
      await atomicJson(statusPath, report);
    }
    report.status = report.completedRanges === report.plannedRanges && !report.failedRanges.length ? 'completed' : 'incomplete';
    if (store && mode !== 'download') report.database = await store.summary({ startDate: start.compact, endDate: end.compact });
  } catch (error) { report.status = 'incomplete'; report.blockedBy = kindOf(error); log({ type: 'forecast_failed', kind: report.blockedBy }); }
  report.finishedAt = new Date().toISOString(); await atomicJson(statusPath, report); return report;
}
