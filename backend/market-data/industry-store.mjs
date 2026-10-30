import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { normalizeTradeDate } from './postgres-store.mjs';

export const INDUSTRY_FIELDS = 'index_code,industry_name,parent_code,level,industry_code,is_pub,src';
export const MEMBER_FIELDS = 'l1_code,l1_name,l2_code,l2_name,l3_code,l3_name,ts_code,name,in_date,out_date,is_new';
export const INDEX_DAILY_FIELDS = 'ts_code,trade_date,open,high,low,close,pct_change,vol,amount';
export const ADJUSTMENT_FIELDS = 'ts_code,trade_date,adj_factor';
const A_CODE = /^\d{6}\.(SH|SZ|BJ)$/;
const INDEX_CODE = /^\d{6}\.SI$/;
const HISTORICAL_ALIAS = /^T\d{5}\.(SH|SZ|BJ)$/;
const SAFE_CODES = new Set(['provider_error', 'network_error', 'database_error', 'validation_error', 'unknown_error', 'permission_denied', 'authentication_error', 'rate_limited', 'no_data']);
const INDEX_COLUMNS = ['index_code', 'trade_date', 'open', 'high', 'low', 'close', 'pct_change', 'vol', 'amount', 'fetched_at'];
const FACTOR_COLUMNS = ['ts_code', 'trade_date', 'adj_factor', 'fetched_at'];

function invalid(message) { const error = new Error(message); error.code = 'VALIDATION_ERROR'; error.kind = 'validation'; return error; }
function finite(value) { return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value))); }
function text(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 500; }
function timestamp(value) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalid('采集时间无效。'); return new Date(value).toISOString(); }
function bool(value) { if ([true, 1, '1'].includes(value)) return true; if ([false, 0, '0'].includes(value)) return false; throw invalid('行业指数发布标记无效。'); }
function maybeDate(value) { return value === null || value === '' || value === undefined ? null : normalizeTradeDate(value).iso; }
function range(startDate, endDate) { const start = normalizeTradeDate(startDate), end = normalizeTradeDate(endDate); if (start.compact > end.compact) throw invalid('开始日期不能晚于结束日期。'); return { start, end }; }
function context(market, apiName) { if (market !== 'A' || !['sw_daily', 'adj_factor'].includes(apiName)) throw invalid('行业与复权同步仅支持 A 股指定接口。'); }
function requireFields(row, fields) { if (!row || typeof row !== 'object' || Array.isArray(row) || fields.some(field => !Object.hasOwn(row, field))) throw invalid('数据记录缺少必需字段。'); }

export function validateIndustries(rows, { level = 'L3' } = {}) {
  if (!['L2', 'L3'].includes(level)) throw invalid('申万目录级别无效。');
  if (!Array.isArray(rows) || !rows.length || rows.length >= 2000) throw invalid('申万目录为空或达到接口截断上限。');
  const seen = new Set();
  return rows.map(row => {
    requireFields(row, INDUSTRY_FIELDS.split(','));
    if (!INDEX_CODE.test(row.index_code) || seen.has(row.index_code) || !text(row.industry_name) || row.src !== 'SW2021' || row.level !== level) throw invalid('申万目录标识、名称、级别或唯一键无效。');
    seen.add(row.index_code);
    for (const field of ['industry_code', 'parent_code']) if (row[field] !== null && !text(row[field])) throw invalid('申万目录父级或行业代码无效。');
    if (row.fetched_at !== undefined) timestamp(row.fetched_at);
    return { ...row, is_pub: bool(row.is_pub) };
  });
}

/** Current member records already carry L2 labels; reject an unresolvable hierarchy. */
export function validateL2Membership(industries, members) {
  const normalized = validateIndustries(industries, { level: 'L2' });
  if (!Array.isArray(members)) throw invalid('申万成员数组无效。');
  const directory = new Map(normalized.map(row => [row.index_code, row]));
  for (const row of members) {
    if (!directory.has(row?.l2_code) || directory.get(row.l2_code).industry_name !== row.l2_name) throw invalid('股票二级标签与完整申万二级目录不一致。');
  }
  return normalized;
}

export function isHistoricalMemberAlias(tsCode) { return typeof tsCode === 'string' && HISTORICAL_ALIAS.test(tsCode); }

export function validateMembers(rows, l3Code, { allowHistoricalAliases = false } = {}) {
  if (!Array.isArray(rows) || !INDEX_CODE.test(l3Code)) throw invalid('申万成员数组或三级代码无效。');
  const seen = new Set();
  for (const row of rows) {
    requireFields(row, MEMBER_FIELDS.split(','));
    const supportedCode = typeof row.ts_code === 'string' && A_CODE.test(row.ts_code);
    if ((!supportedCode && !(allowHistoricalAliases && isHistoricalMemberAlias(row.ts_code))) || row.l3_code !== l3Code || row.is_new !== 'Y' || seen.has(row.ts_code)) throw invalid('申万成员代码、最新归属标记或唯一键无效。');
    seen.add(row.ts_code);
    if (['l1_code', 'l1_name', 'l2_code', 'l2_name', 'l3_name'].some(field => !text(row[field])) || (row.name !== null && !text(row.name))) throw invalid('申万成员分类字段无效。');
    maybeDate(row.in_date); maybeDate(row.out_date);
    if (row.fetched_at !== undefined) timestamp(row.fetched_at);
  }
  return rows;
}

export function validateL2Members(rows, l2Code, { allowHistoricalAliases = false } = {}) {
  if (!Array.isArray(rows) || !INDEX_CODE.test(l2Code)) throw invalid('申万二级成员数组或代码无效。');
  const grouped = new Map();
  for (const row of rows) {
    if (!row || row.l2_code !== l2Code || !INDEX_CODE.test(row.l3_code)) throw invalid('申万二级成员归属或源三级代码无效。');
    if (!grouped.has(row.l3_code)) grouped.set(row.l3_code, []);
    grouped.get(row.l3_code).push(row);
  }
  for (const [l3Code, records] of grouped) validateMembers(records, l3Code, { allowHistoricalAliases });
  return rows;
}

export function validateL2MembersSnapshot({ industries, members, fetchedAt, completedCodes }) {
  const normalized = validateIndustries(industries, { level: 'L2' }); timestamp(fetchedAt);
  if (!Array.isArray(members) || !members.length || !Array.isArray(completedCodes) || completedCodes.length !== normalized.length || new Set(completedCodes).size !== normalized.length) throw invalid('二级成员快照尚未完整采集。');
  const grouped = new Map(normalized.map(row => [row.index_code, []]));
  if (completedCodes.some(code => !grouped.has(code))) throw invalid('二级成员快照完成列表与目录不一致。');
  for (const row of members) {
    if (!grouped.has(row?.l2_code)) throw invalid('二级成员不在完整目录中。');
    grouped.get(row.l2_code).push(row);
  }
  for (const [code, rows] of grouped) validateL2Members(rows, code);
  validateL2Membership(normalized, members);
  return { industries: normalized, members, fetchedAt: timestamp(fetchedAt), completedCodes };
}

export function validateClassification({ industries, members, fetchedAt, completedCodes }) {
  const normalized = validateIndustries(industries); timestamp(fetchedAt);
  if (!Array.isArray(members) || !members.length || !Array.isArray(completedCodes) || completedCodes.length !== normalized.length || new Set(completedCodes).size !== normalized.length) throw invalid('申万分类快照尚未完整采集。');
  const codes = new Set(normalized.map(row => row.index_code));
  if (completedCodes.some(code => !codes.has(code)) || members.some(row => !codes.has(row?.l3_code))) throw invalid('申万成员与完整目录不一致。');
  const grouped = new Map(normalized.map(row => [row.index_code, []]));
  for (const row of members) grouped.get(row.l3_code).push(row);
  for (const [code, rows] of grouped) validateMembers(rows, code);
  return { industries: normalized, members, fetchedAt: timestamp(fetchedAt), completedCodes };
}

export function validateIndexDailyRows(rows, tradeDate) {
  const date = normalizeTradeDate(tradeDate).compact, seen = new Set();
  if (!Array.isArray(rows) || !rows.length) throw invalid('开市日没有行业指数记录。');
  for (const row of rows) {
    requireFields(row, INDEX_DAILY_FIELDS.split(','));
    if (!INDEX_CODE.test(row.ts_code) || row.trade_date !== date || seen.has(row.ts_code)) throw invalid('行业指数代码、日期或唯一键无效。');
    seen.add(row.ts_code);
    for (const field of INDEX_DAILY_FIELDS.split(',').slice(2)) {
      const value = row[field];
      if (value === null && field !== 'close') continue;
      if (!finite(value) || (field !== 'pct_change' && Number(value) < 0) || (field === 'close' && Number(value) <= 0)) throw invalid('行业指数数值无效。');
    }
  }
  return rows;
}

export function validateAdjustmentRows(rows, tradeDate) {
  const date = normalizeTradeDate(tradeDate).compact, seen = new Set();
  if (!Array.isArray(rows) || !rows.length) throw invalid('开市日没有复权因子记录。');
  for (const row of rows) {
    requireFields(row, ADJUSTMENT_FIELDS.split(','));
    if (!A_CODE.test(row.ts_code) || row.trade_date !== date || seen.has(row.ts_code) || !finite(row.adj_factor) || Number(row.adj_factor) <= 0) throw invalid('复权因子代码、日期、数值或唯一键无效。');
    seen.add(row.ts_code);
  }
  return rows;
}

function safeDatabaseError(original) { const error = new Error('PostgreSQL 行业或复权数据操作失败。'); error.code = 'DATABASE_ERROR'; if (typeof original?.code === 'string' && /^[0-9A-Z]{5}$/.test(original.code)) error.sqlState = original.code; return error; }

/** Shared additive schema; the two collectors keep separate source_api ledgers. */
export function createIndustryStore({ connectionString, pool: injectedPool, defaultApi = 'sw_daily' } = {}) {
  context('A', defaultApi);
  if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw invalid('请提供 PostgreSQL 连接配置。');
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10000 });
  if (!injectedPool) pool.on('error', () => {});
  async function transaction(operation) {
    let client, began = false;
    try { client = await pool.connect(); await client.query('BEGIN'); began = true; const result = await operation(client); await client.query('COMMIT'); return result; }
    catch (error) { if (began) try { await client.query('ROLLBACK'); } catch {} throw safeDatabaseError(error); }
    finally { client?.release(); }
  }
  async function query(sql, params) { try { return await pool.query(sql, params); } catch (error) { throw safeDatabaseError(error); } }
  async function insertBatches(client, table, columns, values, conflict, updates) {
    for (let offset = 0; offset < values.length; offset += 1000) {
      const batch = values.slice(offset, offset + 1000);
      const placeholders = batch.map((_, i) => `(${columns.map((__, j) => `$${i * columns.length + j + 1}`).join(', ')})`).join(', ');
      await client.query(`INSERT INTO market_data.${table} (${columns.join(', ')}) VALUES ${placeholders} ON CONFLICT (${conflict}) DO UPDATE SET ${updates.map(column => `${column} = EXCLUDED.${column}`).join(', ')}`, batch.flat());
    }
  }
  return {
    async migrate() { const schema = await readFile(new URL('./industry-schema.sql', import.meta.url), 'utf8'); await transaction(client => client.query(schema)); },
    async replaceClassification(snapshot) {
      const { industries, members, fetchedAt } = validateClassification(snapshot);
      const industryColumns = ['index_code', 'industry_name', 'is_pub', 'src', 'level', 'industry_code', 'parent_code', 'fetched_at'];
      const memberColumns = ['ts_code', 'l3_code', 'l1_code', 'l1_name', 'l2_code', 'l2_name', 'l3_name', 'name', 'in_date', 'out_date', 'is_new', 'fetched_at'];
      await transaction(async client => {
        // Readers see either full snapshot; conflicts remain distinct (ts_code, l3_code).
        await client.query('DELETE FROM market_data.sw_industry_members'); await client.query('DELETE FROM market_data.sw_industries');
        await insertBatches(client, 'sw_industries', industryColumns, industries.map(row => [row.index_code, row.industry_name, row.is_pub, 'SW2021', 'L3', row.industry_code, row.parent_code, row.fetched_at ?? fetchedAt]), 'index_code', industryColumns.slice(1));
        await insertBatches(client, 'sw_industry_members', memberColumns, members.map(row => [row.ts_code, row.l3_code, row.l1_code, row.l1_name, row.l2_code, row.l2_name, row.l3_name, row.name, maybeDate(row.in_date), maybeDate(row.out_date), 'Y', row.fetched_at ?? fetchedAt]), 'ts_code, l3_code', memberColumns.slice(2));
      });
      return { industries: industries.length, members: members.length, fetchedAt };
    },
    async replaceL2Classification({ industries: rows, fetchedAt }) {
      const industries = validateIndustries(rows, { level: 'L2' }), collectedAt = timestamp(fetchedAt);
      const columns = ['index_code', 'industry_name', 'is_pub', 'src', 'level', 'industry_code', 'parent_code', 'fetched_at'];
      await transaction(async client => {
        await client.query('DELETE FROM market_data.sw_industries_l2');
        await insertBatches(client, 'sw_industries_l2', columns, industries.map(row => [row.index_code, row.industry_name, row.is_pub, 'SW2021', 'L2', row.industry_code, row.parent_code, row.fetched_at ?? collectedAt]), 'index_code', columns.slice(1));
      });
      return { industries: industries.length, fetchedAt: collectedAt };
    },
    async replaceL2Members(snapshot) {
      const { members, fetchedAt } = validateL2MembersSnapshot(snapshot);
      const columns = ['ts_code', 'l3_code', 'l1_code', 'l1_name', 'l2_code', 'l2_name', 'l3_name', 'name', 'in_date', 'out_date', 'is_new', 'fetched_at'];
      await transaction(async client => {
        await client.query('DELETE FROM market_data.sw_industry_members_l2');
        await insertBatches(client, 'sw_industry_members_l2', columns, members.map(row => [row.ts_code, row.l3_code, row.l1_code, row.l1_name, row.l2_code, row.l2_name, row.l3_name, row.name, maybeDate(row.in_date), maybeDate(row.out_date), 'Y', row.fetched_at ?? fetchedAt]), 'ts_code, l2_code, l3_code', columns.filter(column => !['ts_code', 'l2_code', 'l3_code'].includes(column)));
      });
      return { members: members.length, fetchedAt };
    },
    async saveDay({ market = 'A', apiName = defaultApi, tradeDate, rows, fetchedAt = new Date().toISOString(), runId = null }) {
      context(market, apiName); const date = normalizeTradeDate(tradeDate); timestamp(fetchedAt);
      if (runId !== null && (typeof runId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(runId))) throw invalid('同步任务 ID 无效。');
      const adjustment = apiName === 'adj_factor';
      (adjustment ? validateAdjustmentRows : validateIndexDailyRows)(rows, tradeDate);
      const columns = adjustment ? FACTOR_COLUMNS : INDEX_COLUMNS, table = adjustment ? 'stock_adj_factors' : 'sw_index_daily';
      const values = rows.map(row => adjustment ? [row.ts_code, date.iso, String(row.adj_factor), fetchedAt] : [row.ts_code, date.iso, ...INDEX_DAILY_FIELDS.split(',').slice(2).map(field => row[field] === null ? null : String(row[field])), fetchedAt]);
      await transaction(async client => {
        // Each response is a fully validated day partition. A refresh can remove
        // source rows; replace that day's partition so stale values cannot survive.
        await client.query(`DELETE FROM market_data.${table} WHERE trade_date = $1`, [date.iso]);
        await insertBatches(client, table, columns, values, `${columns[0]}, trade_date`, columns.slice(2));
        await client.query(`INSERT INTO market_data.sync_days (market, source_api, trade_date, status, rows_count, run_id, error_code)
          VALUES ($1, $2, $3, 'completed', $4, $5, NULL) ON CONFLICT (market, source_api, trade_date) DO UPDATE SET
          status = 'completed', rows_count = EXCLUDED.rows_count, run_id = EXCLUDED.run_id, error_code = NULL, updated_at = now()`, ['A', apiName, date.iso, values.length, runId]);
      });
      return { market: 'A', apiName, tradeDate: date.compact, rowsCount: values.length };
    },
    async getCompletedDays({ market = 'A', apiName = defaultApi, startDate, endDate }) {
      context(market, apiName); const { start, end } = range(startDate, endDate);
      const result = await query(`SELECT to_char(trade_date, 'YYYYMMDD') AS trade_date FROM market_data.sync_days
        WHERE market = $1 AND source_api = $2 AND trade_date BETWEEN $3 AND $4 AND status = 'completed' AND rows_count > 0 ORDER BY trade_date`, ['A', apiName, start.iso, end.iso]);
      return new Set(result.rows.map(row => row.trade_date));
    },
    async markFailedDay({ market = 'A', apiName = defaultApi, tradeDate, errorCode = 'unknown_error' }) {
      context(market, apiName); const date = normalizeTradeDate(tradeDate), code = typeof errorCode === 'string' && SAFE_CODES.has(errorCode) ? errorCode : 'unknown_error';
      await query(`INSERT INTO market_data.sync_days (market, source_api, trade_date, status, rows_count, error_code)
        VALUES ($1, $2, $3, 'failed', 0, $4) ON CONFLICT (market, source_api, trade_date) DO UPDATE SET
        status = 'failed', rows_count = 0, error_code = EXCLUDED.error_code, updated_at = now() WHERE market_data.sync_days.status <> 'completed'`, ['A', apiName, date.iso, code]);
    },
    async summary({ apiName = defaultApi, startDate, endDate }) {
      context('A', apiName); const { start, end } = range(startDate, endDate), adjustment = apiName === 'adj_factor';
      const result = await query(`WITH observations AS (SELECT count(*) AS rows_count, count(DISTINCT ${adjustment ? 'ts_code' : 'index_code'}) AS ticker_count,
        count(DISTINCT trade_date) AS trade_date_count, to_char(min(trade_date), 'YYYY-MM-DD') AS min_date,
        to_char(max(trade_date), 'YYYY-MM-DD') AS max_date FROM market_data.${adjustment ? 'stock_adj_factors' : 'sw_index_daily'} WHERE trade_date BETWEEN $1 AND $2),
        days AS (SELECT count(*) FILTER (WHERE status = 'completed' AND rows_count > 0) AS completed_days, count(*) FILTER (WHERE status = 'failed') AS failed_days
        FROM market_data.sync_days WHERE market = 'A' AND source_api = $3 AND trade_date BETWEEN $1 AND $2)
        SELECT observations.*, days.* FROM observations CROSS JOIN days`, [start.iso, end.iso, apiName]);
      const counts = ['rows_count', 'ticker_count', 'trade_date_count', 'completed_days', 'failed_days'];
      const data = result.rows[0] ?? {};
      return { startDate: start.iso, endDate: end.iso, sourceApi: apiName, ...data, totals: Object.fromEntries(counts.map(field => [field, Number(data[field] ?? 0)])) };
    },
    async close() { try { await pool.end(); } catch (error) { throw safeDatabaseError(error); } },
  };
}

export function createAdjustmentStore(options = {}) { return createIndustryStore({ ...options, defaultApi: 'adj_factor' }); }
