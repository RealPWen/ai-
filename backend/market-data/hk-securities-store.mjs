import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { normalizeTradeDate } from './postgres-store.mjs';

export const HK_SECURITY_FIELDS = 'ts_code,name,list_date,delist_date,list_status';
export const HK_LIST_STATUSES = Object.freeze(['L', 'D', 'P']);

// The source retains old issuers after their numeric ticker is reused. These
// aliases are audit records, not codes accepted by the daily-price table.
export function isHistoricalHkSecurityAlias(code) { return typeof code === 'string' && /^\d{5}!(?:AE)?\.HK$/.test(code); }

function invalid(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  error.kind = 'validation';
  return error;
}

/** Normalize provider dates and reject duplicate keys before opening a transaction. */
export function validateHkSecurities(rows, { listStatus, allowHistoricalAliases = false } = {}) {
  if (!Array.isArray(rows) || (listStatus !== undefined && !HK_LIST_STATUSES.includes(listStatus))) throw invalid('港股基础资料或上市状态无效。');
  const seen = new Set();
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.ts_code !== 'string' || (!/^\d{5}\.HK$/.test(row.ts_code)
        && !(allowHistoricalAliases && row.list_status === 'D' && isHistoricalHkSecurityAlias(row.ts_code)))
      || typeof row.name !== 'string' || !row.name.trim()
      || !HK_LIST_STATUSES.includes(row.list_status) || (listStatus !== undefined && row.list_status !== listStatus)
      || !Object.hasOwn(row, 'list_date') || !Object.hasOwn(row, 'delist_date')) throw invalid('港股基础资料字段与请求市场或上市状态不一致。');
    if (seen.has(row.ts_code)) throw invalid('港股基础资料包含重复股票代码，不能确认列表完整。');
    seen.add(row.ts_code);
    const date = value => value === null || value === '' ? null : normalizeTradeDate(value).iso;
    const listDate = date(row.list_date), delistDate = date(row.delist_date);
    if (listDate && delistDate && listDate > delistDate) throw invalid('港股上市日期不能晚于退市日期。');
    return { ts_code: row.ts_code, name: row.name.trim(), list_date: listDate, delist_date: delistDate, list_status: row.list_status };
  });
}

function databaseError(original) {
  const error = new Error('港股基础资料 PostgreSQL 操作失败。');
  error.code = 'DATABASE_ERROR';
  if (typeof original?.code === 'string' && /^[0-9A-Z]{5}$/.test(original.code)) error.sqlState = original.code;
  return error;
}

export function createHkSecuritiesStore({ connectionString, pool: injectedPool } = {}) {
  if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw invalid('请提供 PostgreSQL 连接配置。');
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000 });
  if (!injectedPool) pool.on('error', () => {});

  async function transaction(operation) {
    let client, began = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN'); began = true;
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (began) { try { await client.query('ROLLBACK'); } catch {} }
      throw databaseError(error);
    } finally { client?.release(); }
  }

  return {
    async migrate() {
      const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
      await transaction(client => client.query(schema));
    },

    async upsertSecurities({ rows, fetchedAt }) {
      const securities = validateHkSecurities(rows);
      if (!securities.length || typeof fetchedAt !== 'string' || !Number.isFinite(Date.parse(fetchedAt))) throw invalid('港股基础资料不能为空且须带有采集时间。');
      await transaction(async client => {
        for (let offset = 0; offset < securities.length; offset += 500) {
          const batch = securities.slice(offset, offset + 500);
          const placeholders = batch.map((_, index) => `(${Array.from({ length: 9 }, (__, column) => `$${index * 9 + column + 1}`).join(', ')})`).join(', ');
          await client.query(`INSERT INTO market_data.securities (ts_code, name, market, industry, list_date, delist_date, list_status, source, fetched_at) VALUES ${placeholders}
            ON CONFLICT (ts_code) DO UPDATE SET name = EXCLUDED.name, market = EXCLUDED.market,
              industry = EXCLUDED.industry, list_date = EXCLUDED.list_date, delist_date = EXCLUDED.delist_date,
              list_status = EXCLUDED.list_status, source = EXCLUDED.source, fetched_at = EXCLUDED.fetched_at`,
          batch.flatMap(row => [row.ts_code, row.name, 'HK', null, row.list_date, row.delist_date, row.list_status, 'tushare', fetchedAt]));
        }
      });
      return { market: 'HK', rowsCount: securities.length };
    },

    async close() { try { await pool.end(); } catch (error) { throw databaseError(error); } },
  };
}
