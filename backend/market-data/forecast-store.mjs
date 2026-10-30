import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { normalizeTradeDate } from './postgres-store.mjs';

export const FORECAST_FIELDS = 'ts_code,name,report_date,report_title,report_type,classify,org_name,author_name,quarter,op_rt,op_pr,tp,np,eps,pe,rd,roe,ev_ebitda,rating,max_price,min_price,imp_dg,create_time';
const FIELDS = FORECAST_FIELDS.split(',');
const IDENTITY_FIELDS = ['ts_code', 'report_date', 'org_name', 'report_title', 'author_name', 'report_type', 'classify', 'quarter', 'create_time'];
const NUMERIC_FIELDS = ['op_rt', 'op_pr', 'tp', 'np', 'eps', 'pe', 'rd', 'roe', 'ev_ebitda', 'max_price', 'min_price'];
const TEXT_FIELDS = FIELDS.filter(field => !NUMERIC_FIELDS.includes(field));
const COLUMNS = ['forecast_id', 'ts_code', 'name', 'report_date', 'report_title', 'report_type', 'classify', 'org_name', 'author_name', 'quarter', 'eps', 'np', 'pe', 'rating', 'max_price', 'min_price', 'source_create_time', 'source', 'source_api', 'raw_data', 'source_duplicate_count', 'fetched_at', 'identity_version'];
const SAFE_CODES = new Set(['provider_error', 'network_error', 'database_error', 'validation_error', 'unknown_error', 'permission_denied', 'rate_limited', 'authentication_error']);
export function forecastValidationError(message) { const error = new Error(message); error.code = 'VALIDATION_ERROR'; error.kind = 'validation'; return error; }
export function forecastRange(startDate, endDate) {
  let start, end;
  try { start = normalizeTradeDate(startDate); end = normalizeTradeDate(endDate); }
  catch { throw forecastValidationError('卖方预测日期须为有效 YYYYMMDD 或 YYYY-MM-DD。'); }
  if (start.compact > end.compact) throw forecastValidationError('卖方预测开始日期不能晚于结束日期。');
  return { start, end };
}
function numeric(value, field) {
  if (value === null) return null;
  const valid = typeof value === 'number' || (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value));
  if (!valid || !Number.isFinite(Number(value))) throw forecastValidationError(`卖方预测字段 ${field} 须为有限数值或 null。`);
  return String(value);
}
function canonical(row) { return JSON.stringify(Object.keys(row).sort().map(key => [key, row[key]])); }
export function forecastIdentity(row) {
  const identity = IDENTITY_FIELDS.map(field => field === 'report_date' ? normalizeTradeDate(row[field]).compact : row[field]);
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
/** Keep every source period/author/report. Only byte-equivalent observations sharing a report identity collapse. */
export function validateForecastRows(rows, startDate, endDate) {
  const { start, end } = forecastRange(startDate, endDate);
  if (!Array.isArray(rows)) throw forecastValidationError('卖方预测须为记录数组。');
  const unique = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || FIELDS.some(field => !Object.hasOwn(row, field))) throw forecastValidationError('卖方预测记录缺少必需字段。');
    if (typeof row.ts_code !== 'string' || !/^\d{6}\.(?:SH|SZ|BJ)$/.test(row.ts_code)) throw forecastValidationError('卖方预测记录含非 A 股代码。');
    const date = forecastRange(row.report_date, row.report_date).start;
    if (date.compact < start.compact || date.compact > end.compact) throw forecastValidationError('卖方预测报告日期超出请求范围。');
    for (const field of TEXT_FIELDS) if (row[field] !== null && typeof row[field] !== 'string') throw forecastValidationError(`卖方预测字段 ${field} 须为文本或 null。`);
    for (const field of NUMERIC_FIELDS) numeric(row[field], field);
    const id = forecastIdentity(row), fingerprint = canonical(row), prior = unique.get(id);
    if (prior && prior.fingerprint !== fingerprint) throw forecastValidationError('同一报告预测期出现冲突记录，已停止以免丢失原始预测。');
    if (prior) prior.duplicateCount++;
    else unique.set(id, { id, row, fingerprint, duplicateCount: 1 });
  }
  return [...unique.values()];
}
function databaseError(original) {
  const error = new Error('PostgreSQL 卖方预测数据操作失败。'); error.code = 'DATABASE_ERROR'; error.kind = 'database';
  if (typeof original?.code === 'string' && /^[0-9A-Z]{5}$/.test(original.code)) error.sqlState = original.code;
  return error;
}
export function createForecastStore({ connectionString, pool: injectedPool } = {}) {
  if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw forecastValidationError('请提供 PostgreSQL 连接配置。');
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10000 });
  async function query(sql, values) { try { return await pool.query(sql, values); } catch (error) { throw databaseError(error); } }
  async function transaction(operation) {
    let client, began = false;
    try { client = await pool.connect(); await client.query('BEGIN'); began = true; const value = await operation(client); await client.query('COMMIT'); return value; }
    catch (error) { if (began) { try { await client.query('ROLLBACK'); } catch {} } throw databaseError(error); }
    finally { client?.release(); }
  }
  return {
    async migrate() {
      const schema = await readFile(new URL('./forecast-schema.sql', import.meta.url), 'utf8');
      await transaction(async client => {
        await client.query(schema);
        // v1 used the report business key alone. Recompute with the very same Node serializer
        // as new downloads, preserving source revisions that differ only by create_time.
        // Updating the version in the same transaction makes retries idempotent and atomic.
        while (true) {
          const legacy = await client.query(`SELECT forecast_id, ts_code, to_char(report_date, 'YYYYMMDD') AS report_date,
            org_name, report_title, author_name, report_type, classify, quarter, source_create_time AS create_time
            FROM market_data.sell_side_forecasts WHERE identity_version = 1 ORDER BY forecast_id LIMIT 500 FOR UPDATE`);
          if (!legacy.rows.length) break;
          const pairs = legacy.rows.map(row => [row.forecast_id, forecastIdentity(row)]);
          const placeholders = pairs.map((_, index) => `($${index * 2 + 1}::text, $${index * 2 + 2}::text)`).join(', ');
          await client.query(`UPDATE market_data.sell_side_forecasts AS f SET forecast_id = migrated.new_id, identity_version = 2
            FROM (VALUES ${placeholders}) AS migrated(old_id, new_id) WHERE f.forecast_id = migrated.old_id`, pairs.flat());
        }
      });
    },
    async saveRange({ startDate, endDate, rows, fetchedAt = new Date().toISOString(), runId = null }) {
      const { start, end } = forecastRange(startDate, endDate), validated = validateForecastRows(rows, startDate, endDate);
      if (typeof fetchedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(fetchedAt) || !Number.isFinite(Date.parse(fetchedAt))) throw forecastValidationError('卖方预测抓取时间无效。');
      if (runId !== null && (typeof runId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(runId))) throw forecastValidationError('卖方预测同步任务 ID 无效。');
      const values = validated.map(({ id, row, duplicateCount }) => [id, row.ts_code, row.name, normalizeTradeDate(row.report_date).iso, row.report_title, row.report_type, row.classify, row.org_name, row.author_name, row.quarter,
        numeric(row.eps, 'eps'), numeric(row.np, 'np'), numeric(row.pe, 'pe'), row.rating, numeric(row.max_price, 'max_price'), numeric(row.min_price, 'min_price'), row.create_time, 'tushare', 'report_rc', JSON.stringify(row), duplicateCount, fetchedAt, 2]);
      await transaction(async client => {
        for (let offset = 0; offset < values.length; offset += 500) {
          const batch = values.slice(offset, offset + 500), placeholders = batch.map((_, index) => `(${COLUMNS.map((__, column) => `$${index * COLUMNS.length + column + 1}`).join(', ')})`).join(', ');
          await client.query(`INSERT INTO market_data.sell_side_forecasts (${COLUMNS.join(', ')}) VALUES ${placeholders}
            ON CONFLICT (forecast_id) DO UPDATE SET ${COLUMNS.slice(1).map(column => `${column} = EXCLUDED.${column}`).join(', ')}`, batch.flat());
        }
        await client.query(`INSERT INTO market_data.forecast_sync_ranges (market, source_api, start_date, end_date, status, rows_count, raw_rows_count, run_id, error_code)
          VALUES ('A', 'report_rc', $1, $2, 'completed', $3, $4, $5, NULL)
          ON CONFLICT (market, source_api, start_date, end_date) DO UPDATE SET status = 'completed', rows_count = EXCLUDED.rows_count,
          raw_rows_count = EXCLUDED.raw_rows_count, run_id = EXCLUDED.run_id, error_code = NULL, updated_at = now()`, [start.iso, end.iso, values.length, rows.length, runId]);
      });
      return { startDate: start.compact, endDate: end.compact, rowsCount: values.length, rawRowsCount: rows.length, duplicateRows: rows.length - values.length };
    },
    async getCompletedRanges({ startDate, endDate }) {
      const { start, end } = forecastRange(startDate, endDate);
      const result = await query(`SELECT to_char(start_date, 'YYYYMMDD') AS start_date, to_char(end_date, 'YYYYMMDD') AS end_date
        FROM market_data.forecast_sync_ranges WHERE market = 'A' AND source_api = 'report_rc' AND status = 'completed'
        AND start_date >= $1 AND end_date <= $2 ORDER BY start_date`, [start.iso, end.iso]);
      return new Set(result.rows.map(row => `${row.start_date}-${row.end_date}`));
    },
    async markFailedRange({ startDate, endDate, errorCode = 'unknown_error' }) {
      const { start, end } = forecastRange(startDate, endDate), code = SAFE_CODES.has(errorCode) ? errorCode : 'unknown_error';
      await query(`INSERT INTO market_data.forecast_sync_ranges (market, source_api, start_date, end_date, status, rows_count, raw_rows_count, error_code)
        VALUES ('A', 'report_rc', $1, $2, 'failed', 0, 0, $3) ON CONFLICT (market, source_api, start_date, end_date)
        DO UPDATE SET status = 'failed', error_code = EXCLUDED.error_code, updated_at = now()
        WHERE market_data.forecast_sync_ranges.status <> 'completed'`, [start.iso, end.iso, code]);
    },
    async withDailyLock(operation) {
      const client = await pool.connect();
      let locked = false;
      try {
        locked = (await client.query("SELECT pg_try_advisory_lock(786214, 61) AS locked")).rows[0].locked;
        if (!locked) return { status: 'busy' };
        return await operation();
      } finally {
        if (locked) await client.query("SELECT pg_advisory_unlock(786214, 61)");
        client.release();
      }
    },
    async pruneBefore(date) {
      const { iso } = normalizeTradeDate(date);
      return transaction(async client => {
        const result = await client.query('DELETE FROM market_data.sell_side_forecasts WHERE report_date < $1', [iso]);
        await client.query('DELETE FROM market_data.forecast_sync_ranges WHERE end_date < $1', [iso]);
        return result.rowCount;
      });
    },
    async summary({ startDate, endDate }) {
      const { start, end } = forecastRange(startDate, endDate);
      const result = await query(`SELECT count(*) AS rows_count, count(DISTINCT ts_code) AS ticker_count, count(DISTINCT org_name) AS broker_count,
        count(DISTINCT report_date) AS report_date_count, count(eps) AS eps_count, to_char(min(report_date), 'YYYY-MM-DD') AS min_date,
        to_char(max(report_date), 'YYYY-MM-DD') AS max_date FROM market_data.sell_side_forecasts WHERE report_date BETWEEN $1 AND $2`, [start.iso, end.iso]);
      const row = result.rows[0] ?? {}, counts = ['rows_count', 'ticker_count', 'broker_count', 'report_date_count', 'eps_count'];
      return { startDate: start.iso, endDate: end.iso, market: 'A', sourceApi: 'report_rc', ...row, ...Object.fromEntries(counts.map(key => [key, Number(row[key] ?? 0)])) };
    },
    async close() { try { await pool.end(); } catch (error) { throw databaseError(error); } },
  };
}
