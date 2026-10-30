import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { normalizeTradeDate } from './postgres-store.mjs';

export const VALUATION_FIELDS = 'ts_code,trade_date,close,pe,pe_ttm,pb,total_mv,circ_mv,turnover_rate,total_share,float_share';
const FIELDS = VALUATION_FIELDS.split(',');
const NUMERIC_FIELDS = FIELDS.slice(2);
const COLUMNS = ['ts_code', 'trade_date', 'market', ...NUMERIC_FIELDS, 'source', 'source_api'];
const SIGNED = new Set(['pe', 'pe_ttm', 'pb']);
const SAFE_CODES = new Set(['provider_error', 'network_error', 'database_error', 'validation_error', 'unknown_error', 'permission_denied', 'rate_limited', 'authentication_error', 'no_data']);
function invalid(message) { const error = new Error(message); error.code = 'VALIDATION_ERROR'; error.kind = 'validation'; return error; }
function context(market = 'A', apiName = 'daily_basic') {
  if (market !== 'A' || apiName !== 'daily_basic') throw invalid('估值同步仅支持 A 股 daily_basic 接口。');
}
function range(startDate, endDate) {
  const start = normalizeTradeDate(startDate), end = normalizeTradeDate(endDate);
  if (start.compact > end.compact) throw invalid('开始日期不能晚于结束日期。');
  return { start, end };
}
function numeric(value, field) {
  if (value === null) return null;
  const valid = typeof value === 'number' || (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value));
  if (!valid || !Number.isFinite(Number(value)) || (!SIGNED.has(field) && Number(value) < 0)) throw invalid(`估值字段 ${field} 须为有效数值或 null。`);
  return String(value);
}

/** Validate source schema and uniqueness before either caching or opening a transaction. */
export function validateValuationRows(rows, tradeDate) {
  const date = normalizeTradeDate(tradeDate).compact;
  if (!Array.isArray(rows) || !rows.length) throw invalid('开市日没有可验证的估值记录，不能标记完成。');
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || FIELDS.some(field => !Object.hasOwn(row, field))) throw invalid('估值记录缺少必需字段。');
    if (typeof row.ts_code !== 'string' || !/^\d{6}\.(?:SH|SZ|BJ)$/.test(row.ts_code) || typeof row.trade_date !== 'string'
      || normalizeTradeDate(row.trade_date).compact !== date || seen.has(row.ts_code)) throw invalid('估值代码、日期或唯一键校验失败。');
    seen.add(row.ts_code);
    for (const field of NUMERIC_FIELDS) numeric(row[field], field);
  }
  return rows;
}
function safeDatabaseError(original) {
  const error = new Error('PostgreSQL 估值数据操作失败。');
  error.code = 'DATABASE_ERROR'; error.kind = 'database';
  if (typeof original?.code === 'string' && /^[0-9A-Z]{5}$/.test(original.code)) error.sqlState = original.code;
  return error;
}

export function createValuationStore({ connectionString, pool: injectedPool } = {}) {
  if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw invalid('请提供 PostgreSQL 连接配置。');
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10000 });
  if (!injectedPool) pool.on('error', () => {});
  async function query(sql, params) { try { return await pool.query(sql, params); } catch (error) { throw safeDatabaseError(error); } }
  async function transaction(operation) {
    let client, began = false;
    try {
      client = await pool.connect(); await client.query('BEGIN'); began = true;
      const value = await operation(client); await client.query('COMMIT'); return value;
    } catch (error) {
      if (began) { try { await client.query('ROLLBACK'); } catch { /* Keep fixed operation failure. */ } }
      throw safeDatabaseError(error);
    } finally { client?.release(); }
  }
  return {
    async migrate() { const schema = await readFile(new URL('./valuation-schema.sql', import.meta.url), 'utf8'); await transaction(client => client.query(schema)); },
    async saveDay({ market = 'A', apiName = 'daily_basic', tradeDate, rows, runId = null }) {
      context(market, apiName); const date = normalizeTradeDate(tradeDate);
      if (runId !== null && (typeof runId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(runId))) throw invalid('同步任务 ID 无效。');
      validateValuationRows(rows, date.compact);
      const values = rows.map(row => [row.ts_code, date.iso, 'A', ...NUMERIC_FIELDS.map(field => numeric(row[field], field)), 'tushare', 'daily_basic']);
      await transaction(async client => {
        for (let offset = 0; offset < values.length; offset += 1000) {
          const batch = values.slice(offset, offset + 1000);
          const placeholders = batch.map((_, index) => `(${COLUMNS.map((__, column) => `$${index * COLUMNS.length + column + 1}`).join(', ')})`).join(', ');
          await client.query(`INSERT INTO market_data.daily_valuations (${COLUMNS.join(', ')}) VALUES ${placeholders}
            ON CONFLICT (ts_code, trade_date) DO UPDATE SET
            ${COLUMNS.slice(2).map(column => `${column} = EXCLUDED.${column}`).join(', ')}, fetched_at = now()`, batch.flat());
        }
        await client.query(`INSERT INTO market_data.sync_days (market, source_api, trade_date, status, rows_count, run_id, error_code)
          VALUES ($1, $2, $3, 'completed', $4, $5, NULL)
          ON CONFLICT (market, source_api, trade_date) DO UPDATE SET status = 'completed', rows_count = EXCLUDED.rows_count,
          run_id = EXCLUDED.run_id, error_code = NULL, updated_at = now()`, ['A', 'daily_basic', date.iso, values.length, runId]);
      });
      return { market: 'A', apiName: 'daily_basic', tradeDate: date.compact, rowsCount: values.length };
    },
    async getCompletedDays({ market = 'A', apiName = 'daily_basic', startDate, endDate }) {
      context(market, apiName); const { start, end } = range(startDate, endDate);
      const result = await query(`SELECT to_char(trade_date, 'YYYYMMDD') AS trade_date FROM market_data.sync_days
        WHERE market = $1 AND source_api = $2 AND trade_date BETWEEN $3 AND $4 AND status = 'completed' AND rows_count > 0 ORDER BY trade_date`, ['A', 'daily_basic', start.iso, end.iso]);
      return new Set(result.rows.map(row => row.trade_date));
    },
    async markFailedDay({ market = 'A', apiName = 'daily_basic', tradeDate, errorCode = 'unknown_error' }) {
      context(market, apiName); const date = normalizeTradeDate(tradeDate);
      const code = typeof errorCode === 'string' && SAFE_CODES.has(errorCode.toLowerCase()) ? errorCode.toLowerCase() : 'unknown_error';
      await query(`INSERT INTO market_data.sync_days (market, source_api, trade_date, status, rows_count, error_code)
        VALUES ($1, $2, $3, 'failed', 0, $4)
        ON CONFLICT (market, source_api, trade_date) DO UPDATE SET status = 'failed', rows_count = 0,
        error_code = EXCLUDED.error_code, updated_at = now() WHERE market_data.sync_days.status <> 'completed'`, ['A', 'daily_basic', date.iso, code]);
    },
    async summary({ startDate, endDate }) {
      const { start, end } = range(startDate, endDate);
      const result = await query(`WITH valuations AS (
        SELECT count(*) AS rows_count, count(DISTINCT ts_code) AS ticker_count, count(DISTINCT trade_date) AS trade_date_count,
          to_char(min(trade_date), 'YYYY-MM-DD') AS min_date, to_char(max(trade_date), 'YYYY-MM-DD') AS max_date,
          count(pe_ttm) AS pe_ttm_count, count(pb) AS pb_count FROM market_data.daily_valuations WHERE market = 'A' AND trade_date BETWEEN $1 AND $2
      ), days AS (SELECT count(*) FILTER (WHERE status = 'completed' AND rows_count > 0) AS completed_days,
          count(*) FILTER (WHERE status = 'failed') AS failed_days FROM market_data.sync_days
          WHERE market = 'A' AND source_api = 'daily_basic' AND trade_date BETWEEN $1 AND $2)
      SELECT 'A' AS market, valuations.*, days.* FROM valuations CROSS JOIN days`, [start.iso, end.iso]);
      const counts = ['rows_count', 'ticker_count', 'trade_date_count', 'pe_ttm_count', 'pb_count', 'completed_days', 'failed_days'];
      const rows = result.rows.map(row => ({ ...row, ...Object.fromEntries(counts.map(field => [field, Number(row[field] ?? 0)])) }));
      return { startDate: start.iso, endDate: end.iso, sourceApi: 'daily_basic', markets: rows,
        totals: Object.fromEntries(counts.map(field => [field, rows.reduce((sum, row) => sum + row[field], 0)])) };
    },
    async close() { try { await pool.end(); } catch (error) { throw safeDatabaseError(error); } },
  };
}
