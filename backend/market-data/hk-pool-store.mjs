import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { normalizeTradeDate } from './postgres-store.mjs';
import { DAILY_FIELDS } from './sync.mjs';
import { PRICE_HISTORY_LOOKBACK_DAYS } from './price-history-window.mjs';

export const HK_POOL_LOCK_KEYS = Object.freeze([20261019, 628]);
export const HK_POOL_PROVIDERS = Object.freeze({
  tushare: Object.freeze({ source: 'tushare', apiName: 'hk_daily' }),
  eastmoney: Object.freeze({ source: 'eastmoney', apiName: 'eastmoney_hk_daily' }),
  yahoo: Object.freeze({ source: 'yahoo', apiName: 'yahoo_hk_daily' }),
  tencent: Object.freeze({ source: 'tencent', apiName: 'tencent_hk_daily' }),
});
const DAY_MS = 86_400_000;
const NUMERIC_FIELDS = DAILY_FIELDS.split(',').slice(2);
const PRICE_COLUMNS = ['ts_code', 'trade_date', 'market', ...NUMERIC_FIELDS, 'source', 'source_api', 'adjustment', 'volume_unit', 'amount_unit', 'currency'];
const SAFE_CODES = new Set(['provider_error', 'network_error', 'database_error', 'validation_error', 'permission_denied', 'authentication_error', 'rate_limited', 'no_data', 'incomplete_window']);
const RUN_COLUMNS = `to_char(run_date, 'YYYY-MM-DD') AS "runDate", universe_hash AS "universeHash", source, source_api AS "apiName", tickers,
  to_char(window_start, 'YYYY-MM-DD') AS "windowStart", to_char(window_end, 'YYYY-MM-DD') AS "windowEnd", status, summary, error_code AS "errorCode"`;

function invalid(message = '港股投资池同步参数无效。') { const error = new Error(message); error.kind = 'validation'; error.code = 'VALIDATION_ERROR'; return error; }
function databaseError(original) { const error = new Error('港股投资池 PostgreSQL 操作失败。'); error.kind = 'database'; error.code = 'DATABASE_ERROR';
  if (typeof original?.code === 'string' && /^[0-9A-Z]{5}$/.test(original.code)) error.sqlState = original.code; return error; }
function tickerCode(ticker) { if (typeof ticker !== 'string' || !/^\d{5}\.HK$/.test(ticker)) throw invalid(); return ticker; }
function providerIdentity({ universeHash, source, apiName }) {
  if (typeof universeHash !== 'string' || !/^[a-f0-9]{64}$/.test(universeHash)
    || !Object.values(HK_POOL_PROVIDERS).some(value => value.source === source && value.apiName === apiName)) throw invalid();
  return { universeHash, source, apiName };
}
function identityValues(options) { const identity = providerIdentity(options); return [identity.universeHash, identity.source, identity.apiName]; }
function runIdentity(options) { const run = normalizeTradeDate(options.runDate); return [run.iso, ...identityValues(options)]; }
export function normalizeHkPoolRange(startDate, endDate) {
  const start = normalizeTradeDate(startDate), end = normalizeTradeDate(endDate);
  const days = (Date.parse(`${end.iso}T00:00:00Z`) - Date.parse(`${start.iso}T00:00:00Z`)) / DAY_MS + 1;
  if (days < 1 || days > 400) throw invalid('港股单次下载范围不能超过 400 个自然日。');
  return { start, end };
}
function windowFor(options) {
  const run = normalizeTradeDate(options.runDate), { start, end } = normalizeHkPoolRange(options.windowStart, options.windowEnd);
  if (end.compact >= run.compact) throw invalid();
  return { run, start, end };
}
function jsonSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw invalid();
  let json; try { json = JSON.stringify(summary); } catch { throw invalid(); }
  if (json.length > 100000) throw invalid(); return json;
}
function tickerList(tickers, universeHash) {
  if (!Array.isArray(tickers) || !tickers.length || tickers.length > 1000) throw invalid();
  tickers.forEach(tickerCode);
  if (new Set(tickers).size !== tickers.length || createHash('sha256').update([...tickers].sort().join('\n')).digest('hex') !== universeHash) throw invalid();
  return tickers;
}

export function validateHkPoolRows(rows, { ticker, startDate, endDate, allowEmpty = true }) {
  tickerCode(ticker); const { start, end } = normalizeHkPoolRange(startDate, endDate);
  // A stock has at most one row per calendar date. Staying strictly below the
  // 5,000 row API cap proves a buffered annual response is not truncated.
  if (!Array.isArray(rows) || rows.length > 400 || rows.length >= 5000) throw invalid('港股单股票响应可能被截断。');
  if (!rows.length && !allowEmpty) { const error = new Error('港股初始年度下载没有有效行情。'); error.kind = 'no_data'; throw error; }
  const seen = new Set();
  for (const row of rows) {
    if (!row || DAILY_FIELDS.split(',').some(field => !Object.hasOwn(row, field)) || row.ts_code !== ticker) throw invalid('港股响应包含名单外代码或缺少字段。');
    const date = normalizeTradeDate(row.trade_date).compact;
    if (date !== row.trade_date || date < start.compact || date > end.compact || seen.has(date)) throw invalid('港股响应日期重复或超出请求范围。');
    seen.add(date);
    for (const field of NUMERIC_FIELDS) {
      const value = row[field];
      if (value === null) continue;
      const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? Number(value) : NaN;
      if (!Number.isFinite(numeric) || (!['change', 'pct_chg'].includes(field) && numeric < 0)) throw invalid('港股行情数值无效。');
    }
  }
  if (rows.length && !rows.some(row => row.close !== null && Number(row.close) > 0)) throw invalid('港股响应缺少有效收盘价。');
  return rows;
}

/** Complete range union, clipped to the current rolling window. */
export function missingHkPoolRanges(ranges, startDate, endDate) {
  const { start, end } = normalizeHkPoolRange(startDate, endDate);
  if (!Array.isArray(ranges)) throw invalid();
  const millis = date => Date.parse(`${normalizeTradeDate(date).iso}T00:00:00Z`);
  const compact = value => new Date(value).toISOString().slice(0, 10).replaceAll('-', '');
  const finish = millis(end.compact), missing = [];
  let cursor = millis(start.compact);
  const sorted = ranges.map(range => { const normalized = normalizeHkPoolRange(range.startDate, range.endDate); return [millis(normalized.start.compact), millis(normalized.end.compact)]; }).sort((a, b) => a[0] - b[0]);
  for (const [first, last] of sorted) {
    if (last < cursor || first > finish) continue;
    if (first > cursor) missing.push({ startDate: compact(cursor), endDate: compact(Math.min(finish, first - DAY_MS)) });
    cursor = Math.max(cursor, last + DAY_MS);
    if (cursor > finish) break;
  }
  if (cursor <= finish) missing.push({ startDate: compact(cursor), endDate: compact(finish) });
  return missing;
}

export function createHkPoolStore({ connectionString, pool: injectedPool } = {}) {
  if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw invalid('请提供 PostgreSQL 连接配置。');
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000 });
  if (!injectedPool) pool.on('error', () => {});
  async function connect() { try { return await pool.connect(); } catch (error) { throw databaseError(error); } }
  async function dbQuery(client, sql, values) { try { return await client.query(sql, values); } catch (error) { throw databaseError(error); } }
  async function transaction(client, operation) {
    let began = false;
    try { await dbQuery(client, 'BEGIN'); began = true; const result = await operation(); await dbQuery(client, 'COMMIT'); return result; }
    catch (error) { if (began) try { await dbQuery(client, 'ROLLBACK'); } catch {} throw error; }
  }
  function scopeFor(client, isActive) {
    async function query(sql, values) { if (!isActive()) throw invalid('港股投资池更新锁已释放。'); return dbQuery(client, sql, values); }
    async function getRun(options, { forUpdate = false } = {}) {
      const result = await query(`SELECT ${RUN_COLUMNS} FROM market_data.hk_pool_update_runs
        WHERE run_date = $1 AND universe_hash = $2 AND source = $3 AND source_api = $4${forUpdate ? ' FOR UPDATE' : ''}`, runIdentity(options));
      return result.rows[0] ?? null;
    }
    async function getRanges(options) {
      const ticker = tickerCode(options.ticker), identity = identityValues(options);
      const { start, end } = normalizeHkPoolRange(options.startDate, options.endDate);
      const result = await query(`SELECT to_char(range_start, 'YYYYMMDD') AS "startDate", to_char(range_end, 'YYYYMMDD') AS "endDate", rows_count AS "rowsCount"
        FROM market_data.hk_pool_symbol_ranges AS coverage WHERE universe_hash = $1 AND source = $2 AND source_api = $3 AND ts_code = $4
        AND range_start <= $6 AND range_end >= $5
        AND rows_count = (SELECT count(*) FROM market_data.daily_prices AS prices WHERE prices.market = 'HK'
          AND prices.ts_code = coverage.ts_code AND prices.source = coverage.source AND prices.source_api = coverage.source_api
          AND prices.trade_date BETWEEN coverage.range_start AND coverage.range_end)
        ORDER BY range_start, range_end`, [...identity, ticker, start.iso, end.iso]);
      return result.rows;
    }
    async function getBaseline(options) {
      const { start } = windowFor(options), ticker = tickerCode(options.ticker);
      const result = await query(`SELECT to_char(baseline_date, 'YYYYMMDD') AS "baselineDate"
        FROM market_data.hk_pool_symbol_baselines AS baseline
        WHERE universe_hash=$1 AND source=$2 AND source_api=$3 AND ts_code=$4 AND annual_start=$5::date
        AND baseline_date IS NOT DISTINCT FROM (SELECT max(prices.trade_date) FROM market_data.daily_prices AS prices
          WHERE prices.market='HK' AND prices.ts_code=baseline.ts_code AND prices.source=baseline.source AND prices.source_api=baseline.source_api
          AND prices.trade_date < baseline.annual_start AND prices.close > 0)`, [...identityValues(options), ticker, start.iso]);
      return result.rows[0] ?? null;
    }
    return {
      getRun, getRanges, getBaseline,
      async beginRun(options) {
        const { start, end } = windowFor(options), values = runIdentity(options), tickers = tickerList(options.tickers, options.universeHash);
        await query(`INSERT INTO market_data.hk_pool_update_runs (run_date, universe_hash, source, source_api, tickers, window_start, window_end, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'running') ON CONFLICT (run_date, universe_hash, source, source_api) DO UPDATE SET
          tickers = EXCLUDED.tickers, window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end, status = 'running',
          summary = '{}'::jsonb, error_code = NULL, started_at = now(), finished_at = NULL, updated_at = now()
          WHERE market_data.hk_pool_update_runs.status <> 'succeeded' OR $8::boolean`, [...values, tickers, start.iso, end.iso, options.reopen === true]);
      },
      async saveRange(options) {
        const identity = identityValues(options), ticker = tickerCode(options.ticker); runIdentity(options);
        const { start, end } = normalizeHkPoolRange(options.startDate, options.endDate);
        const rows = validateHkPoolRows(options.rows, { ticker, startDate: start.compact, endDate: end.compact });
        return transaction(client, async () => {
          const run = await getRun(options, { forUpdate: true });
          if (run?.status !== 'running' || !run.tickers?.includes(ticker)
            || start.iso < run.windowStart || end.iso > run.windowEnd) throw invalid('港股下载范围与当前投资池任务不一致。');
          if (rows.length) {
            const prices = rows.map(row => [ticker, normalizeTradeDate(row.trade_date).iso, 'HK', ...NUMERIC_FIELDS.map(field => row[field]),
              options.source, options.apiName, 'none', 'share', 'hkd', 'HKD']);
            const placeholders = prices.map((_, index) => `(${PRICE_COLUMNS.map((__, column) => `$${index * PRICE_COLUMNS.length + column + 1}`).join(',')})`).join(',');
            await query(`INSERT INTO market_data.daily_prices (${PRICE_COLUMNS.join(',')}) VALUES ${placeholders}
              ON CONFLICT (ts_code, trade_date) DO UPDATE SET ${PRICE_COLUMNS.slice(2).map(column => `${column}=EXCLUDED.${column}`).join(',')}, fetched_at=now()`, prices.flat());
          }
          await query(`INSERT INTO market_data.hk_pool_symbol_ranges (universe_hash, source, source_api, ts_code, range_start, range_end, rows_count)
            VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (universe_hash, ts_code, source, source_api, range_start, range_end)
            DO UPDATE SET rows_count=EXCLUDED.rows_count, fetched_at=now()`, [...identity, ticker, start.iso, end.iso, rows.length]);
          return { ticker, rowsCount: rows.length };
        });
      },
      async saveBaseline(options) {
        const { start: annualStart } = windowFor(options), ticker = tickerCode(options.ticker);
        const { start, end } = normalizeHkPoolRange(options.startDate, options.endDate);
        const rows = validateHkPoolRows(options.rows, { ticker, startDate: start.compact, endDate: end.compact });
        const lookupDays = (Date.parse(end.iso) - Date.parse(start.iso)) / DAY_MS + 1;
        if (rows.length > 1 || lookupDays !== PRICE_HISTORY_LOOKBACK_DAYS || Date.parse(annualStart.iso) - Date.parse(end.iso) !== DAY_MS) throw invalid('港股年度基准只能保存一条前置行情。');
        return transaction(client, async () => {
          const run = await getRun(options, { forUpdate: true });
          if (run?.status !== 'running' || run.windowStart !== annualStart.iso || !run.tickers?.includes(ticker)) throw invalid();
          if (rows.length) {
            const row = rows[0], values = [ticker, normalizeTradeDate(row.trade_date).iso, 'HK', ...NUMERIC_FIELDS.map(field => row[field]),
              options.source, options.apiName, 'none', 'share', 'hkd', 'HKD'];
            await query(`INSERT INTO market_data.daily_prices (${PRICE_COLUMNS.join(',')}) VALUES (${values.map((_, index) => `$${index + 1}`).join(',')})
              ON CONFLICT (ts_code, trade_date) DO UPDATE SET ${PRICE_COLUMNS.slice(2).map(column => `${column}=EXCLUDED.${column}`).join(',')}, fetched_at=now()`, values);
          }
          await query(`INSERT INTO market_data.hk_pool_symbol_baselines
            (universe_hash, source, source_api, ts_code, annual_start, lookup_start, lookup_end, baseline_date)
            SELECT $1,$2,$3,$4,$5::date,$6::date,$7::date,max(trade_date) FROM market_data.daily_prices
            WHERE market='HK' AND ts_code=$4 AND source=$2 AND source_api=$3 AND trade_date < $5::date AND close > 0
            ON CONFLICT (universe_hash, ts_code, source, source_api, annual_start) DO UPDATE SET
              lookup_start=EXCLUDED.lookup_start, lookup_end=EXCLUDED.lookup_end, baseline_date=EXCLUDED.baseline_date, fetched_at=now()`,
          [...identityValues(options), ticker, annualStart.iso, start.iso, end.iso]);
          return { ticker, rowsCount: rows.length };
        });
      },
      async failRun(options) {
        const code = SAFE_CODES.has(options.errorCode) ? options.errorCode : 'provider_error';
        const status = options.partial ? 'partial' : 'failed';
        await query(`UPDATE market_data.hk_pool_update_runs SET status=$5, error_code=$6, summary=$7::jsonb,
          finished_at=now(), updated_at=now() WHERE run_date=$1 AND universe_hash=$2 AND source=$3 AND source_api=$4 AND status <> 'succeeded'`,
        [...runIdentity(options), status, code, jsonSummary(options.summary ?? {})]);
      },
      async finalize(options) {
        const { start, end } = windowFor(options), tickers = tickerList(options.tickers, options.universeHash); jsonSummary(options.summary ?? {});
        return transaction(client, async () => {
          const run = await getRun(options, { forUpdate: true });
          if (run?.status !== 'running' || run.windowStart !== start.iso || run.windowEnd !== end.iso
            || run.tickers?.length !== tickers.length || tickers.some(ticker => !run.tickers.includes(ticker))) throw invalid();
          for (const ticker of tickers) {
            const ranges = await getRanges({ ...options, ticker, startDate: start.compact, endDate: end.compact });
            if (missingHkPoolRanges(ranges, start.compact, end.compact).length || !await getBaseline({ ...options, ticker })) {
              const error = new Error('港股投资池仍有未完成的股票范围，保留历史数据。'); error.kind = 'incomplete_window'; throw error;
            }
          }
          const prices = await query(`DELETE FROM market_data.daily_prices AS expired WHERE market = 'HK' AND trade_date < $1
            AND ts_code = ANY($2::text[]) AND source = $3 AND source_api = $4
            AND trade_date IS DISTINCT FROM (SELECT max(prior.trade_date) FROM market_data.daily_prices AS prior
              WHERE prior.market='HK' AND prior.ts_code=expired.ts_code AND prior.source=expired.source AND prior.source_api=expired.source_api
              AND prior.trade_date < $1 AND prior.close > 0)`, [start.iso, tickers, options.source, options.apiName]);
          // Compact verified coverage to the retained annual window. Its count
          // remains verifiable tomorrow after today's expired observations are
          // removed, and overwritten provider rows invalidate stale coverage.
          const ranges = await query(`DELETE FROM market_data.hk_pool_symbol_ranges WHERE universe_hash = $1 AND source = $2 AND source_api = $3
            AND ts_code = ANY($4::text[])`, [...identityValues(options), tickers]);
          for (const ticker of tickers) await query(`INSERT INTO market_data.hk_pool_symbol_ranges
            (universe_hash, source, source_api, ts_code, range_start, range_end, rows_count)
            SELECT $1,$2,$3,$4,$5::date,$6::date,count(*) FROM market_data.daily_prices
            WHERE market = 'HK' AND ts_code=$4 AND source=$2 AND source_api=$3 AND trade_date BETWEEN $5::date AND $6::date`,
          [...identityValues(options), ticker, start.iso, end.iso]);
          const deleted = { daily_prices: prices.rowCount, symbol_ranges: ranges.rowCount };
          const summary = { ...options.summary, deleted };
          await query(`UPDATE market_data.hk_pool_update_runs SET status='succeeded', summary=$5::jsonb, error_code=NULL,
            finished_at=now(), updated_at=now() WHERE run_date=$1 AND universe_hash=$2 AND source=$3 AND source_api=$4 AND status='running'`, [...runIdentity(options), jsonSummary(summary)]);
          return { deleted };
        });
      },
    };
  }
  return {
    async migrate() {
      const [base, schema] = await Promise.all([readFile(new URL('./schema.sql', import.meta.url), 'utf8'), readFile(new URL('./hk-pool-schema.sql', import.meta.url), 'utf8')]);
      const client = await connect(); try { await transaction(client, async () => { await dbQuery(client, base); await dbQuery(client, schema); }); } finally { client.release(); }
    },
    async withLock(operation) {
      if (typeof operation !== 'function') throw invalid();
      const client = await connect(); let active = true, locked = false, sessionError, discard, operationError;
      const onError = () => { sessionError ??= databaseError(); active = false; discard = sessionError; };
      client.on?.('error', onError);
      const isActive = () => { if (sessionError) throw sessionError; return active; };
      try {
        const result = await dbQuery(client, 'SELECT pg_try_advisory_lock($1, $2) AS locked', HK_POOL_LOCK_KEYS); isActive();
        locked = result.rows[0]?.locked === true; if (!locked) return { status: 'busy' };
        const resultValue = await operation(scopeFor(client, isActive)); isActive(); return resultValue;
      } catch (error) { operationError = error; if (error?.code === 'DATABASE_ERROR') discard = error; throw error; }
      finally {
        active = false;
        if (locked && !sessionError) try {
          const result = await dbQuery(client, 'SELECT pg_advisory_unlock($1, $2) AS unlocked', HK_POOL_LOCK_KEYS);
          if (result.rows[0]?.unlocked !== true) throw databaseError();
        } catch (error) { discard = error; }
        try { client.release(discard); } finally { client.off?.('error', onError); }
        if (discard && !operationError) throw discard;
      }
    },
    async close() { try { await pool.end(); } catch (error) { throw databaseError(error); } },
  };
}
