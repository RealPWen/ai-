import { readFile } from 'node:fs/promises';
import pg from 'pg';

const NUMERIC_FIELDS = ['open', 'high', 'low', 'close', 'pre_close', 'change', 'pct_chg', 'vol', 'amount'];
const PRICE_COLUMNS = ['ts_code', 'trade_date', 'market', ...NUMERIC_FIELDS,
  'source', 'source_api', 'adjustment', 'volume_unit', 'amount_unit', 'currency'];
const UNITS = {
  A: { volume: 'lot', amount: 'thousand_cny', currency: 'CNY' },
  HK: { volume: 'share', amount: 'hkd', currency: 'HKD' },
};
const SAFE_ERROR_CODES = new Set([
  'provider_error', 'network_error', 'database_error', 'validation_error',
  'unknown_error', 'permission_denied', 'rate_limited', 'no_data',
]);

function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  return error;
}

/** Accept YYYYMMDD or YYYY-MM-DD; use UTC validation, never host timezone. */
export function normalizeTradeDate(value) {
  if (typeof value !== 'string' || !/^(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(value)) {
    throw validationError('交易日期须为 YYYYMMDD 或 YYYY-MM-DD。');
  }
  const compact = value.replaceAll('-', '');
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number(compact.slice(0, 4)) < 1900 || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw validationError('交易日期无效。');
  }
  return { compact, iso };
}

function validateMarket(market) {
  if (!Object.hasOwn(UNITS, market)) throw validationError('市场须为 A 或 HK。');
  return market;
}

function validateApiName(apiName) {
  if (typeof apiName !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(apiName)) {
    throw validationError('数据接口名称无效。');
  }
  return apiName;
}

function validateSource({ market, apiName, source }) {
  if ((source === 'tushare' && !['eastmoney_hk_daily', 'yahoo_hk_daily', 'tencent_hk_daily'].includes(apiName))
    || (source === 'eastmoney' && market === 'HK' && apiName === 'eastmoney_hk_daily')
    || (source === 'yahoo' && market === 'HK' && apiName === 'yahoo_hk_daily')
    || (source === 'tencent' && market === 'HK' && apiName === 'tencent_hk_daily')) return;
  throw validationError('行情来源、市场与数据接口不匹配。');
}

function validateRange(startDate, endDate) {
  const start = normalizeTradeDate(startDate);
  const end = normalizeTradeDate(endDate);
  if (start.compact > end.compact) throw validationError('开始日期不能晚于结束日期。');
  return { start, end };
}

function numericValue(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value))) return value;
  throw validationError(`行情字段 ${field} 必须为有限数值或 null。`);
}

function normalizedRows({ market, apiName, source, date, rows }) {
  if (!Array.isArray(rows)) throw validationError('rows 须为行情记录数组。');
  const units = UNITS[market];
  const byCode = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw validationError('行情记录格式无效。');
    const codePattern = market === 'A' ? /^\d{6}\.(?:SH|SZ|BJ)$/ : /^\d{5}\.HK$/;
    if (typeof row.ts_code !== 'string' || !codePattern.test(row.ts_code)) throw validationError('股票代码与所选市场不匹配。');
    if (normalizeTradeDate(row.trade_date).compact !== date.compact) throw validationError('行情记录日期与同步日期不一致。');
    // Deduplicate within a provider response; the last record wins, as on a later retry.
    byCode.set(row.ts_code, [row.ts_code, date.iso, market,
      ...NUMERIC_FIELDS.map(field => numericValue(row[field], field)),
      source, apiName, 'none', units.volume, units.amount, units.currency]);
  }
  return [...byCode.values()];
}

function safeDatabaseError(original) {
  const error = new Error('PostgreSQL 数据操作失败。');
  error.code = 'DATABASE_ERROR';
  if (typeof original?.code === 'string' && /^[0-9A-Z]{5}$/.test(original.code)) error.sqlState = original.code;
  return error;
}

/** No environment lookup; callers supply a DSN, or an injected Pool for tests. */
export function createMarketStore({ connectionString, pool: injectedPool } = {}) {
  if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) {
    throw validationError('请提供 PostgreSQL 连接配置。');
  }
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10_000 });
  if (!injectedPool) pool.on('error', () => {});

  async function transaction(operation) {
    let client;
    let began = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      began = true;
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      if (began) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the operation failure. */ }
      }
      throw safeDatabaseError(error);
    } finally {
      client?.release();
    }
  }

  async function query(sql, params) {
    try { return await pool.query(sql, params); } catch (error) { throw safeDatabaseError(error); }
  }

  return {
    async migrate() {
      const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
      const valuations = await readFile(new URL('./valuation-schema.sql', import.meta.url), 'utf8');
      await transaction(async client => { await client.query(schema); await client.query(valuations); });
    },

    async saveDay({ market, apiName, source = 'tushare', tradeDate, rows, runId = null }) {
      validateMarket(market);
      validateApiName(apiName);
      validateSource({ market, apiName, source });
      const date = normalizeTradeDate(tradeDate);
      if (runId !== null && (typeof runId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(runId))) throw validationError('同步任务 ID 无效。');
      const values = normalizedRows({ market, apiName, source, date, rows });
      await transaction(async client => {
        // Bound query parameters below PostgreSQL's per-query limit for a full market day.
        for (let offset = 0; offset < values.length; offset += 1000) {
          const batch = values.slice(offset, offset + 1000);
          const placeholders = batch.map((_, index) => `(${PRICE_COLUMNS.map((__, column) => `$${index * PRICE_COLUMNS.length + column + 1}`).join(', ')})`).join(', ');
          await client.query(`INSERT INTO market_data.daily_prices (${PRICE_COLUMNS.join(', ')}) VALUES ${placeholders}
            ON CONFLICT (ts_code, trade_date) DO UPDATE SET
            ${PRICE_COLUMNS.slice(2).map(column => `${column} = EXCLUDED.${column}`).join(', ')}, fetched_at = now()`, batch.flat());
        }
        await client.query(`INSERT INTO market_data.sync_days (market, source_api, trade_date, status, rows_count, run_id, error_code)
          VALUES ($1, $2, $3, 'completed', $4, $5, NULL)
          ON CONFLICT (market, source_api, trade_date) DO UPDATE SET
          status = 'completed', rows_count = EXCLUDED.rows_count, run_id = EXCLUDED.run_id, error_code = NULL, updated_at = now()`,
        [market, apiName, date.iso, values.length, runId]);
      });
      return { market, apiName, tradeDate: date.compact, rowsCount: values.length };
    },

    /** Return Set<YYYYMMDD>, convenient for resumable collectors. */
    async getCompletedDays({ market, startDate, endDate }) {
      validateMarket(market);
      const { start, end } = validateRange(startDate, endDate);
      const result = await query(`SELECT DISTINCT to_char(trade_date, 'YYYYMMDD') AS trade_date
        FROM market_data.sync_days WHERE market = $1 AND trade_date BETWEEN $2 AND $3 AND status = 'completed' AND source_api = $4
        ORDER BY trade_date`, [market, start.iso, end.iso, market === 'A' ? 'daily' : 'hk_daily']);
      return new Set(result.rows.map(row => row.trade_date));
    },

    async markFailedDay({ market, apiName, tradeDate, errorCode = 'unknown_error' }) {
      validateMarket(market);
      validateApiName(apiName);
      const date = normalizeTradeDate(tradeDate);
      // Only fixed codes enter storage. Never persist provider messages, tokens, or DSNs.
      const code = typeof errorCode === 'string' && SAFE_ERROR_CODES.has(errorCode.toLowerCase()) ? errorCode.toLowerCase() : 'unknown_error';
      await query(`INSERT INTO market_data.sync_days (market, source_api, trade_date, status, rows_count, error_code)
        VALUES ($1, $2, $3, 'failed', 0, $4)
        ON CONFLICT (market, source_api, trade_date) DO UPDATE SET
        status = 'failed', rows_count = 0, error_code = EXCLUDED.error_code, updated_at = now()
        WHERE market_data.sync_days.status <> 'completed'`, [market, apiName, date.iso, code]);
    },

    async summary({ startDate, endDate }) {
      const { start, end } = validateRange(startDate, endDate);
      const result = await query(`WITH prices AS (
        SELECT market, count(*) AS rows_count, count(DISTINCT ts_code) AS ticker_count,
          count(DISTINCT trade_date) AS trade_date_count,
          to_char(min(trade_date), 'YYYY-MM-DD') AS min_date, to_char(max(trade_date), 'YYYY-MM-DD') AS max_date
        FROM market_data.daily_prices WHERE trade_date BETWEEN $1 AND $2 GROUP BY market
      ), days AS (
        SELECT market, count(DISTINCT trade_date) FILTER (WHERE status = 'completed') AS completed_days,
          count(DISTINCT trade_date) FILTER (WHERE status = 'failed') AS failed_days
        FROM market_data.sync_days WHERE trade_date BETWEEN $1 AND $2
          AND source_api = CASE WHEN market = 'A' THEN 'daily' ELSE 'hk_daily' END GROUP BY market
      ) SELECT markets.market, coalesce(prices.rows_count, 0) AS rows_count,
        coalesce(prices.ticker_count, 0) AS ticker_count, coalesce(prices.trade_date_count, 0) AS trade_date_count,
        prices.min_date, prices.max_date, coalesce(days.completed_days, 0) AS completed_days, coalesce(days.failed_days, 0) AS failed_days
        FROM (VALUES ('A'), ('HK')) AS markets(market)
        LEFT JOIN prices USING (market) LEFT JOIN days USING (market) ORDER BY markets.market`, [start.iso, end.iso]);
      const countFields = ['rows_count', 'ticker_count', 'trade_date_count', 'completed_days', 'failed_days'];
      const markets = result.rows.map(row => ({ ...row, ...Object.fromEntries(countFields.map(field => [field, Number(row[field])])) }));
      // A day present in both markets counts once per market in these totals.
      const totals = Object.fromEntries(countFields.map(field => [field, markets.reduce((sum, row) => sum + row[field], 0)]));
      return { startDate: start.iso, endDate: end.iso, markets, totals };
    },

    async close() {
      try { await pool.end(); } catch (error) { throw safeDatabaseError(error); }
    },
  };
}
