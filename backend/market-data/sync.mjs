import { replaceFile } from '../src/replace-file.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { normalizeTradeDate } from './postgres-store.mjs';

export const DAILY_FIELDS = 'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount';
export const MARKET_CONFIG = {
  A: { apiName: 'daily', calendarApi: 'trade_cal', calendarParams: { exchange: 'SSE' }, pageSize: 6000 },
  HK: { apiName: 'hk_daily', calendarApi: 'hk_tradecal', calendarParams: {}, pageSize: 5000 },
};

function invalid(message) { const error = new Error(message); error.kind = 'validation'; return error; }

export function validateDailyRows(rows, market, tradeDate) {
  const date = normalizeTradeDate(tradeDate).compact;
  const codePattern = market === 'A' ? /^\d{6}\.(SH|SZ|BJ)$/ : market === 'HK' ? /^\d{5}\.HK$/ : null;
  if (!codePattern || !Array.isArray(rows) || !rows.length) throw invalid('开市日没有可验证的行情记录。');
  const seen = new Set();
  for (const row of rows) {
    if (!row || DAILY_FIELDS.split(',').some(field => !Object.hasOwn(row, field))) throw invalid('行情记录缺少必需字段。');
    if (!codePattern.test(row.ts_code) || row.trade_date !== date || seen.has(row.ts_code)) throw invalid('行情代码、日期或唯一键校验失败。');
    seen.add(row.ts_code);
    for (const field of DAILY_FIELDS.split(',').slice(2)) {
      const value = row[field];
      if (value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid('行情数值校验失败。');
      if (!['change', 'pct_chg'].includes(field) && value < 0) throw invalid('价格或成交数值不能为负数。');
    }
  }
  if (!rows.some(row => typeof row.close === 'number' && Number.isFinite(row.close) && row.close > 0)) throw invalid('全市场日线缺少有效收盘价，不能确认当日数据完整。');
  return rows;
}

async function readJson(path, compressed = false) {
  try { const bytes = await readFile(path); return JSON.parse((compressed ? gunzipSync(bytes) : bytes).toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw invalid('本地行情缓存损坏，请检查对应缓存文件。'); }
}

async function atomicJson(path, value, compressed = false) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, compressed ? gzipSync(bytes) : bytes, { mode: 0o600 });
  await replaceFile(temporary, path);
}

function validCalendar(value, { market, startDate, endDate }) {
  if (!value || value.version !== 1 || value.market !== market || value.startDate !== startDate || value.endDate !== endDate || !Array.isArray(value.dates) || !value.dates.length) return false;
  const unique = new Set();
  for (const date of value.dates) {
    const compact = normalizeTradeDate(date).compact;
    if (compact !== date || date < startDate || date > endDate || unique.has(date)) return false;
    unique.add(date);
  }
  return true;
}

export async function syncDailyData({ client, store, cacheDir, startDate, endDate, markets = ['A', 'HK'], mode = 'sync', log = () => {} }) {
  const start = normalizeTradeDate(startDate).compact, end = normalizeTradeDate(endDate).compact;
  if (start > end || !['download', 'import', 'sync'].includes(mode) || !markets.length || markets.some(market => !MARKET_CONFIG[market])) throw invalid('下载范围、市场或运行方式无效。');
  if (mode !== 'import' && !client) throw invalid('下载需要 Tushare 客户端。');
  if (mode !== 'download' && !store) throw invalid('入库需要 PostgreSQL 连接。');
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  if (store && mode !== 'download') await store.migrate();
  const report = { version: 1, startDate: start, endDate: end, mode, startedAt: new Date().toISOString(), markets: [] };
  const statusPath = join(cacheDir, `status-${start}-${end}-${mode}.json`);
  for (const market of [...new Set(markets)]) {
    const config = MARKET_CONFIG[market];
    const result = { market, apiName: config.apiName, plannedDays: 0, completedDays: 0, downloadedDays: 0, importedDays: 0, cachedDays: 0, skippedDays: 0, rows: 0, failedDates: [] };
    report.markets.push(result);
    const directory = join(cacheDir, market);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const calendarPath = join(directory, `calendar-${start}-${end}.json`);
    let calendar = await readJson(calendarPath);
    if (!validCalendar(calendar, { market, startDate: start, endDate: end })) {
      if (mode === 'import') throw invalid('缺少已下载的交易日历，不能确认导入范围。');
      const rows = await client.query(config.calendarApi, { ...config.calendarParams, start_date: start, end_date: end, is_open: '1' }, 'cal_date,is_open');
      calendar = { version: 1, market, startDate: start, endDate: end, dates: rows.filter(row => row.is_open === 1 || row.is_open === '1').map(row => row.cal_date).sort(), fetchedAt: new Date().toISOString() };
      if (!validCalendar(calendar, { market, startDate: start, endDate: end })) throw invalid('交易日历为空、重复或超出研究范围。');
      await atomicJson(calendarPath, calendar);
    }
    result.plannedDays = calendar.dates.length;
    const completed = mode === 'download' ? new Set() : await store.getCompletedDays({ market, startDate: start, endDate: end });
    log({ type: 'market_start', market, plannedDays: result.plannedDays, existingDays: completed.size });
    // Newest first: the requested latest data becomes available immediately.
    for (const tradeDate of [...calendar.dates].sort().reverse()) {
      try {
        if (completed.has(tradeDate)) { result.skippedDays += 1; result.completedDays += 1; continue; }
        const path = join(directory, `${tradeDate}.json.gz`);
        let cached = await readJson(path, true);
        if (cached && (cached.version !== 1 || cached.market !== market || cached.apiName !== config.apiName || cached.tradeDate !== tradeDate)) throw invalid('行情缓存标识与请求日期不一致。');
        if (!cached) {
          if (mode === 'import') throw invalid('交易日行情缓存尚未下载。');
          const rows = await client.queryAll(config.apiName, { trade_date: tradeDate }, DAILY_FIELDS, { pageSize: config.pageSize, maxPages: 20, maxRows: 100000 });
          validateDailyRows(rows, market, tradeDate);
          cached = { version: 1, market, apiName: config.apiName, tradeDate, fetchedAt: new Date().toISOString(), rows };
          await atomicJson(path, cached, true);
          result.downloadedDays += 1;
        } else result.cachedDays += 1;
        validateDailyRows(cached.rows, market, tradeDate);
        if (mode !== 'download') {
          await store.saveDay({ market, apiName: config.apiName, tradeDate, rows: cached.rows, runId: `${start}-${end}` });
          result.importedDays += 1;
        }
        result.completedDays += 1; result.rows += cached.rows.length;
        if (result.completedDays === 1 || result.completedDays % 10 === 0 || result.completedDays === result.plannedDays) log({ type: 'progress', market, date: tradeDate, completedDays: result.completedDays, plannedDays: result.plannedDays, rows: result.rows });
      } catch (error) {
        const kind = ['permission', 'authentication', 'rate_limit', 'network', 'timeout', 'validation', 'invalid_response'].includes(error.kind) ? error.kind : error.code === 'DATABASE_ERROR' ? 'database' : 'unknown';
        result.failedDates.push({ date: tradeDate, kind });
        if (store && mode !== 'download') await store.markFailedDay({ market, apiName: config.apiName, tradeDate, errorCode: kind === 'rate_limit' ? 'rate_limited' : kind === 'permission' ? 'permission_denied' : kind === 'database' ? 'database_error' : kind === 'validation' ? 'validation_error' : 'provider_error' });
        log({ type: 'day_failed', market, date: tradeDate, kind });
        if (['permission', 'authentication', 'rate_limit', 'database'].includes(kind)) { result.blockedBy = kind; break; }
      }
      await atomicJson(statusPath, report);
    }
    result.status = result.completedDays === result.plannedDays && !result.failedDates.length ? 'completed' : 'incomplete';
    await atomicJson(statusPath, report);
  }
  report.finishedAt = new Date().toISOString();
  report.status = report.markets.every(market => market.status === 'completed') ? 'completed' : 'incomplete';
  if (store && mode !== 'download') report.database = await store.summary({ startDate: start, endDate: end });
  await atomicJson(statusPath, report);
  return report;
}
