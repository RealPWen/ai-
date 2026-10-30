import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { normalizeTradeDate } from './postgres-store.mjs';

export const DAILY_NEWS_UPDATE_LOCK_KEYS = Object.freeze([20261019, 602]);
const SAFE_CODES = new Set(['permission_denied', 'authentication_error', 'rate_limited', 'network_error', 'database_error', 'validation_error', 'provider_error', 'incomplete_window']);
const SAFE_STOPS = new Set(['range_start_confirmed', 'range_already_reached', 'search_exhausted_after_start']);
const RUN_COLUMNS = `to_char(run_date, 'YYYY-MM-DD') AS "runDate", window_start AS "windowStart", window_end AS "windowEnd",
  status, attempt_count AS "attemptCount", summary, error_code AS "errorCode", started_at AS "startedAt", finished_at AS "finishedAt"`;
const invalid = () => Object.assign(new Error('每日资讯更新日期、范围或状态无效。'), { code: 'VALIDATION_ERROR', kind: 'validation' });
function databaseError(original) {
  const error = Object.assign(new Error('PostgreSQL 每日资讯更新状态操作失败。'), { code: 'DATABASE_ERROR', kind: 'database' });
  if (typeof original?.code === 'string' && /^[0-9A-Z]{5}$/.test(original.code)) error.sqlState = original.code;
  return error;
}
function windowValue({ runDate, windowStart, windowEnd }) {
  const run = normalizeTradeDate(runDate), end = new Date(`${run.iso}T00:00:00.000+08:00`).getTime();
  if (!Number.isFinite(Date.parse(windowStart)) || !Number.isFinite(Date.parse(windowEnd))
    || Date.parse(windowEnd) !== end || Date.parse(windowStart) !== end - 86400000) throw invalid();
  return { runDate: run.iso, windowStart: new Date(end - 86400000).toISOString(), windowEnd: new Date(end).toISOString() };
}
function summaryJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  let serialized; try { serialized = JSON.stringify(value); } catch { throw invalid(); }
  if (!serialized || serialized.length > 100000) throw invalid();
  return serialized;
}
function runRow(row) {
  if (!row) return null;
  return { ...row, windowStart: new Date(row.windowStart).toISOString(), windowEnd: new Date(row.windowEnd).toISOString() };
}

export function createDailyNewsUpdateStore({ connectionString, pool: injectedPool } = {}) {
  if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw invalid();
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000 });
  if (!injectedPool) pool.on('error', () => {});
  const connect = async () => { try { return await pool.connect(); } catch (error) { throw databaseError(error); } };
  const dbQuery = async (client, sql, values) => { try { return await client.query(sql, values); } catch (error) { throw databaseError(error); } };
  async function transaction(client, operation) {
    let began = false;
    try { await dbQuery(client, 'BEGIN'); began = true; const result = await operation(); await dbQuery(client, 'COMMIT'); return result; }
    catch (error) { if (began) try { await dbQuery(client, 'ROLLBACK'); } catch {} throw error; }
  }
  function scopeFor(client, isActive) {
    const query = (sql, values) => { if (!isActive()) throw invalid(); return dbQuery(client, sql, values); };
    async function getRun(runDate, { forUpdate = false } = {}) {
      const run = normalizeTradeDate(runDate);
      const result = await query(`SELECT ${RUN_COLUMNS} FROM market_data.daily_news_update_runs WHERE run_date = $1${forUpdate ? ' FOR UPDATE' : ''}`, [run.iso]);
      return runRow(result.rows[0]);
    }
    return {
      getRun,
      async beginRun(input) {
        const window = windowValue(input);
        const result = await query(`INSERT INTO market_data.daily_news_update_runs (run_date, window_start, window_end, status)
          VALUES ($1, $2, $3, 'running') ON CONFLICT (run_date) DO UPDATE SET
          window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end, status = 'running',
          attempt_count = market_data.daily_news_update_runs.attempt_count + 1, summary = '{}'::jsonb,
          error_code = NULL, started_at = now(), finished_at = NULL, updated_at = now()
          WHERE market_data.daily_news_update_runs.status <> 'succeeded' RETURNING ${RUN_COLUMNS}`, [window.runDate, window.windowStart, window.windowEnd]);
        return runRow(result.rows[0]) ?? getRun(window.runDate);
      },
      async failRun({ runDate, errorCode = 'provider_error', summary = {} }) {
        const run = normalizeTradeDate(runDate), code = SAFE_CODES.has(errorCode) ? errorCode : 'provider_error';
        const result = await query(`UPDATE market_data.daily_news_update_runs SET status = 'failed', error_code = $2, summary = $3::jsonb,
          finished_at = now(), updated_at = now() WHERE run_date = $1 AND status <> 'succeeded' RETURNING ${RUN_COLUMNS}`, [run.iso, code, summaryJson(summary)]);
        return runRow(result.rows[0]);
      },
      async finalize({ runDate, windowStart, windowEnd, summary }) {
        const window = windowValue({ runDate, windowStart, windowEnd }); summaryJson(summary);
        if (summary.rangeReachedStart !== true || summary.coverageVerified !== false || summary.historicalPointInTime !== false
          || !SAFE_STOPS.has(summary.stopReason) || summary.searchType !== 'depth' || summary.searchKeyword !== '财联社'
          || summary.start !== window.windowStart || summary.end !== window.windowEnd) throw invalid();
        if (!isActive()) throw invalid();
        return transaction(client, async () => {
          const current = await getRun(window.runDate, { forUpdate: true });
          if (current?.status !== 'running' || current.windowStart !== window.windowStart || current.windowEnd !== window.windowEnd) throw invalid();
          await query(`UPDATE market_data.daily_news_update_runs SET status = 'succeeded', summary = $2::jsonb,
            error_code = NULL, finished_at = now(), updated_at = now() WHERE run_date = $1 AND status = 'running'`, [window.runDate, summaryJson(summary)]);
          return { status: 'succeeded', ...window, summary };
        });
      },
    };
  }
  return {
    async migrate() {
      const schema = await readFile(new URL('./daily-news-update-schema.sql', import.meta.url), 'utf8'), client = await connect();
      try { await transaction(client, () => dbQuery(client, schema)); } finally { client.release(); }
    },
    async withLock(operation) {
      if (typeof operation !== 'function') throw invalid();
      const client = await connect(); let locked = false, active = true, discard, operationError, sessionError;
      const onClientError = () => { sessionError ??= databaseError(); discard = sessionError; active = false; };
      client.on?.('error', onClientError);
      const isActive = () => { if (sessionError) throw sessionError; return active; };
      try {
        const result = await dbQuery(client, 'SELECT pg_try_advisory_lock($1, $2) AS locked', DAILY_NEWS_UPDATE_LOCK_KEYS); isActive();
        locked = result.rows[0]?.locked === true; if (!locked) return { status: 'busy' };
        const value = await operation(scopeFor(client, isActive)); isActive(); return value;
      } catch (error) { operationError = error; if (error?.code === 'DATABASE_ERROR') discard = error; throw error; }
      finally {
        active = false;
        if (locked && !sessionError) {
          try { const result = await dbQuery(client, 'SELECT pg_advisory_unlock($1, $2) AS unlocked', DAILY_NEWS_UPDATE_LOCK_KEYS); if (result.rows[0]?.unlocked !== true) throw databaseError(); }
          catch (error) { discard = error; }
        }
        try { client.release(discard); } finally { client.off?.('error', onClientError); }
        if (discard && !operationError) throw discard;
      }
    },
    async close() { try { await pool.end(); } catch (error) { throw databaseError(error); } },
  };
}
