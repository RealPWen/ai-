import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { normalizeTradeDate } from './postgres-store.mjs';
import { expandPriceHistoryWindow, PRICE_HISTORY_EXTRA_TRADING_DAYS } from './price-history-window.mjs';

export const ROLLING_UPDATE_APIS = Object.freeze(['daily', 'daily_basic', 'adj_factor', 'sw_daily']);
export const HK_ROLLING_UPDATE_APIS = Object.freeze(['hk_daily']);
// Session locks cover collection as well as retention, across daemon/CLI processes.
export const ROLLING_UPDATE_LOCK_KEYS = Object.freeze([20261015, 600]);
export const HK_ROLLING_UPDATE_LOCK_KEYS = Object.freeze([20261015, 601]);
const MARKET_CONFIG = Object.freeze({
  A: { apis: ROLLING_UPDATE_APIS, lockKeys: ROLLING_UPDATE_LOCK_KEYS, runTable: 'daily_update_runs' },
  HK: { apis: HK_ROLLING_UPDATE_APIS, lockKeys: HK_ROLLING_UPDATE_LOCK_KEYS, runTable: 'hk_daily_update_runs' },
});
const SAFE_CODES = new Set(['provider_error', 'network_error', 'database_error', 'validation_error',
  'unknown_error', 'permission_denied', 'authentication_error', 'rate_limited', 'no_data',
  'incomplete_window', 'cancelled']);
const RUN_COLUMNS = `to_char(run_date, 'YYYY-MM-DD') AS "runDate",
  to_char(window_start, 'YYYY-MM-DD') AS "windowStart", to_char(window_end, 'YYYY-MM-DD') AS "windowEnd",
  status, summary, error_code AS "errorCode", started_at AS "startedAt", finished_at AS "finishedAt"`;
const DELETIONS = Object.freeze({
  daily: { table: 'daily_prices', condition: "market = 'A' AND source_api = 'daily' AND " },
  hk_daily: { table: 'daily_prices', condition: "market = 'HK' AND source_api = 'hk_daily' AND " },
  daily_basic: { table: 'daily_valuations', condition: "market = 'A' AND " },
  adj_factor: { table: 'stock_adj_factors', condition: '' },
  sw_daily: { table: 'sw_index_daily', condition: '' },
});

function invalid(message) { const error = new Error(message); error.code = 'VALIDATION_ERROR'; error.kind = 'validation'; return error; }
function safeDatabaseError(original) {
  const error = new Error('PostgreSQL 日线更新状态操作失败。'); error.code = 'DATABASE_ERROR'; error.kind = 'database';
  if (typeof original?.code === 'string' && /^[0-9A-Z]{5}$/.test(original.code)) error.sqlState = original.code;
  return error;
}
function range(startDate, endDate) {
  const start = normalizeTradeDate(startDate), end = normalizeTradeDate(endDate);
  if (start.compact > end.compact) throw invalid('更新窗口开始日期不能晚于结束日期。');
  return { start, end };
}
function runWindow({ runDate, windowStart, windowEnd }) {
  const run = normalizeTradeDate(runDate), { start, end } = range(windowStart, windowEnd);
  if (end.compact >= run.compact) throw invalid('日线更新窗口只能截至运行日期的前一天。');
  return { run, start, end };
}
function apiList(apis, allowed) {
  if (!Array.isArray(apis) || !apis.length || new Set(apis).size !== apis.length || apis.some(api => !allowed.includes(api))) throw invalid('日线更新接口列表无效。');
  return apis;
}
function summaryJson(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw invalid('更新摘要须为对象。');
  let value;
  try { value = JSON.stringify(summary); } catch { throw invalid('更新摘要无法序列化。'); }
  if (!value || value.length > 100000) throw invalid('更新摘要过大或无效。');
  return value;
}
function expectedDatesInWindow(values, start, end) {
  if (!(Array.isArray(values) || values instanceof Set)) throw invalid('须提供交易日历确认的完整交易日集合。');
  const dates = [...values].map(value => normalizeTradeDate(value).compact);
  if (new Set(dates).size !== dates.length || dates.some(value => value < start.compact || value > end.compact)) throw invalid('预期交易日重复或超出更新窗口。');
  return dates;
}

/** Inject configuration explicitly. Collection and retention share one session lock. */
export function createRollingUpdateStore({ connectionString, pool: injectedPool, market = 'A' } = {}) {
  const config = MARKET_CONFIG[market];
  if (!config || !['A', 'HK'].includes(market)) throw invalid('日线更新市场无效。');
  const { apis: allowedApis, lockKeys, runTable } = config;
  if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw invalid('请提供 PostgreSQL 连接配置。');
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000 });
  // An idle connection failure must not crash the long-running scheduler.
  if (!injectedPool) pool.on('error', () => {});

  async function connect() { try { return await pool.connect(); } catch (error) { throw safeDatabaseError(error); } }
  async function dbQuery(client, sql, values) { try { return await client.query(sql, values); } catch (error) { throw safeDatabaseError(error); } }
  async function transaction(client, operation) {
    let began = false;
    try { await dbQuery(client, 'BEGIN'); began = true; const value = await operation(); await dbQuery(client, 'COMMIT'); return value; }
    catch (error) { if (began) try { await dbQuery(client, 'ROLLBACK'); } catch {} throw error; }
  }
  function scopeFor(client, isActive) {
    async function query(sql, values) {
      if (!isActive()) throw invalid('日线更新锁已释放。');
      return dbQuery(client, sql, values);
    }
    async function getRun(runDate, { forUpdate = false } = {}) {
      const run = normalizeTradeDate(runDate);
      const result = await query(`SELECT ${RUN_COLUMNS} FROM market_data.${runTable} WHERE run_date = $1${forUpdate ? ' FOR UPDATE' : ''}`, [run.iso]);
      return result.rows[0] ?? null;
    }
    async function getCompletedDates({ apiName, startDate, endDate }) {
      apiList([apiName], allowedApis); const { start, end } = range(startDate, endDate);
      const { table } = DELETIONS[apiName];
      const observationFilter = ['daily', 'hk_daily'].includes(apiName) ? `AND observations.market = '${market}' AND observations.source_api = '${apiName}'`
        : apiName === 'daily_basic' ? "AND observations.market = 'A'" : '';
      const result = await query(`SELECT to_char(trade_date, 'YYYYMMDD') AS trade_date FROM market_data.sync_days AS days
        WHERE market = '${market}' AND source_api = $1 AND trade_date BETWEEN $2 AND $3
        AND status = 'completed' AND rows_count > 0
        AND EXISTS (SELECT 1 FROM market_data.${table} AS observations
          WHERE observations.trade_date = days.trade_date ${observationFilter}) ORDER BY trade_date`, [apiName, start.iso, end.iso]);
      return new Set(result.rows.map(row => row.trade_date));
    }
    return {
      getRun,
      getCompletedDates,
      async beginRun(options) {
        const { run, start, end } = runWindow(options);
        const result = await query(`INSERT INTO market_data.${runTable} (run_date, window_start, window_end, status)
          VALUES ($1, $2, $3, 'running') ON CONFLICT (run_date) DO UPDATE SET
          window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end, status = 'running', summary = '{}'::jsonb,
          error_code = NULL, started_at = now(), finished_at = NULL, updated_at = now()
          WHERE market_data.${runTable}.status <> 'succeeded' OR $4::boolean RETURNING ${RUN_COLUMNS}`, [run.iso, start.iso, end.iso, options.reopen === true]);
        return result.rows[0] ?? getRun(run.iso);
      },
      async failRun({ runDate, errorCode = 'unknown_error' }) {
        const run = normalizeTradeDate(runDate), code = typeof errorCode === 'string' && SAFE_CODES.has(errorCode.toLowerCase()) ? errorCode.toLowerCase() : 'unknown_error';
        const result = await query(`UPDATE market_data.${runTable} SET status = 'failed', error_code = $2,
          finished_at = now(), updated_at = now() WHERE run_date = $1 AND status <> 'succeeded' RETURNING ${RUN_COLUMNS}`, [run.iso, code]);
        return result.rows[0] ?? null;
      },
      async finalize({ runDate, windowStart, windowEnd, expectedDates, priceHistoryExpectedDates, apis = [...allowedApis], summary = {} }) {
        const { run, start, end } = runWindow({ runDate, windowStart, windowEnd }); apiList(apis, allowedApis); summaryJson(summary);
        const dates = expectedDatesInWindow(expectedDates, start, end);
        const buffered = apiName => market === 'A' && ['daily', 'adj_factor'].includes(apiName);
        const lookupStart = normalizeTradeDate(expandPriceHistoryWindow({ windowStart }).windowStart);
        const historyDates = apis.some(buffered) ? expectedDatesInWindow(priceHistoryExpectedDates, lookupStart, end) : dates;
        const annualHistoryDates = new Set(historyDates.filter(date => date >= start.compact));
        const baselineDates = historyDates.filter(date => date < start.compact);
        if (apis.some(buffered) && (baselineDates.length !== PRICE_HISTORY_EXTRA_TRADING_DAYS
          || annualHistoryDates.size !== dates.length || dates.some(date => !annualHistoryDates.has(date)))) throw invalid('价格历史须包含一年窗口及之前一个交易日。');
        const historyStart = apis.some(buffered) ? normalizeTradeDate(baselineDates[0]) : start;
        if (!isActive()) throw invalid('日线更新锁已释放。');
        return transaction(client, async () => {
          const current = await getRun(run.iso, { forUpdate: true });
          if (current?.status !== 'running' || current.windowStart !== start.iso || current.windowEnd !== end.iso) throw invalid('更新任务状态或窗口已变化，不能清理历史数据。');
          // Aggregate market-day completion permits individual stocks to be absent
          // or contain nullable observations (for example suspension/IPO dates).
          for (const apiName of apis) {
            const requiredDates = buffered(apiName) ? historyDates : dates;
            const completed = await getCompletedDates({ apiName, startDate: buffered(apiName) ? historyStart.iso : start.iso, endDate: end.iso });
            if (requiredDates.some(date => !completed.has(date))) {
              const error = new Error('更新窗口存在未完成的接口交易日，已保留历史数据。');
              error.code = 'INCOMPLETE_WINDOW'; error.kind = 'incomplete_window'; throw error;
            }
          }
          const deleted = {};
          for (const apiName of apis) {
            const { table, condition } = DELETIONS[apiName];
            // Retain one usable close per stock before the annual window;
            // suspended stocks may need a close older than the market baseline.
            const retainBaseline = buffered(apiName) ? ` AND history.trade_date IS DISTINCT FROM (
              SELECT max(prices.trade_date) FROM market_data.daily_prices prices
              WHERE prices.ts_code = history.ts_code AND prices.market = 'A' AND prices.source_api = 'daily'
                AND prices.trade_date < $1 AND prices.close > 0)` : '';
            const result = await query(`DELETE FROM market_data.${table}${buffered(apiName) ? ' AS history' : ''} WHERE ${condition}trade_date < $1${retainBaseline}`, [start.iso]);
            deleted[table] = result.rowCount;
          }
          const cutoffs = new Map();
          for (const apiName of apis) {
            const cutoff = buffered(apiName) ? historyStart.iso : start.iso;
            if (!cutoffs.has(cutoff)) cutoffs.set(cutoff, []);
            cutoffs.get(cutoff).push(apiName);
          }
          deleted.sync_days = 0;
          for (const [cutoff, cutoffApis] of cutoffs) {
            const ledger = await query(`DELETE FROM market_data.sync_days WHERE market = '${market}' AND source_api = ANY($1::text[]) AND trade_date < $2`, [cutoffApis, cutoff]);
            deleted.sync_days += ledger.rowCount;
          }
          const { priceHistoryBufferDays, ...currentSummary } = summary;
          const resultSummary = { ...currentSummary, ...(apis.some(buffered) ? {
            priceHistoryWindowStart: historyStart.compact, priceHistoryExtraTradingDays: PRICE_HISTORY_EXTRA_TRADING_DAYS,
          } : {}), deleted };
          await query(`UPDATE market_data.${runTable} SET status = 'succeeded', summary = $2::jsonb,
            error_code = NULL, finished_at = now(), updated_at = now() WHERE run_date = $1 AND status = 'running'`, [run.iso, summaryJson(resultSummary)]);
          return { ...resultSummary, status: 'succeeded', runDate: run.iso, windowStart: start.iso, windowEnd: end.iso };
        });
      },
    };
  }
  return {
    async migrate() {
      const schema = await readFile(new URL('./rolling-update-schema.sql', import.meta.url), 'utf8'), client = await connect();
      try { await transaction(client, () => dbQuery(client, schema)); } finally { client.release(); }
    },
    async withLock(operation) {
      if (typeof operation !== 'function') throw invalid('须提供日线更新操作。');
      const client = await connect(); let locked = false, active = true, discard, operationError, sessionError;
      // A checked-out pg client has no pool idle-error handler. PG may restart
      // while this session is holding the lock and waiting for Tushare network I/O.
      const onClientError = () => { sessionError ??= safeDatabaseError(); discard = sessionError; active = false; };
      client.on?.('error', onClientError);
      const isActive = () => { if (sessionError) throw sessionError; return active; };
      try {
        const result = await dbQuery(client, 'SELECT pg_try_advisory_lock($1, $2) AS locked', lockKeys);
        isActive();
        locked = result.rows[0]?.locked === true;
        if (!locked) return { status: 'busy' };
        const value = await operation(scopeFor(client, isActive));
        isActive();
        return value;
      } catch (error) { operationError = error; if (error?.code === 'DATABASE_ERROR') discard = error; throw error; }
      finally {
        active = false;
        if (locked && !sessionError) {
          try {
            const result = await dbQuery(client, 'SELECT pg_advisory_unlock($1, $2) AS unlocked', lockKeys);
            if (result.rows[0]?.unlocked !== true) throw safeDatabaseError();
          } catch (error) { discard = error; }
        }
        // Destroy failed sessions instead of returning a potentially retained
        // advisory lock to the pool. Keep the listener through synchronous release.
        try { client.release(discard); }
        finally { client.off?.('error', onClientError); }
        if (discard && !operationError) throw discard;
      }
    },
    async close() { try { await pool.end(); } catch (error) { throw safeDatabaseError(error); } },
  };
}
