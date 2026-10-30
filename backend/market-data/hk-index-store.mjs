import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { normalizeTradeDate } from './postgres-store.mjs';
import { normalizeHkIndexRange, validateHkIndexRows, HkIndexError } from './hk-index-client.mjs';

export const HK_INDEX_LOCK_KEYS = Object.freeze([20261020, 7001]);
const dbError = () => new HkIndexError('恒生指数数据库暂不可用。', 'database');
const invalid = () => new HkIndexError('恒生指数更新参数无效。');

export function createHkIndexStore({ connectionString, pool: injectedPool } = {}) {
  if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw invalid();
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000, query_timeout: 20000 });
  if (!injectedPool) pool.on('error', () => {});
  async function query(client, sql, params) { try { return await client.query(sql, params); } catch { throw dbError(); } }
  async function transaction(client, operation) {
    await query(client, 'BEGIN');
    try { const result = await operation(); await query(client, 'COMMIT'); return result; }
    catch (error) { try { await query(client, 'ROLLBACK'); } catch {} throw error; }
  }
  function scope(client, active = () => true) {
    const q = (sql, params) => { if (!active()) throw invalid(); return query(client, sql, params); };
    async function upsert({ rows, startDate, endDate, retentionStart }) {
      const range = normalizeHkIndexRange({ startDate, endDate });
      validateHkIndexRows(rows, { startDate, endDate });
      const cutoff = retentionStart === undefined ? null : normalizeTradeDate(retentionStart);
      if (cutoff && cutoff.compact > range.start.compact) throw invalid();
      const columns = ['index_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol'];
      const placeholders = rows.map((_, index) => `(${columns.map((__, j) => `$${index * columns.length + j + 1}`).join(',')})`).join(',');
      await q(`INSERT INTO market_data.hk_index_daily (${columns.join(',')}) VALUES ${placeholders}
        ON CONFLICT(index_code,trade_date) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,
        vol=EXCLUDED.vol,source='tencent',source_api='tencent_hsi_daily',fetched_at=clock_timestamp()`,
      rows.flatMap(row => ['HSI', normalizeTradeDate(row.trade_date).iso, row.open, row.high, row.low, row.close, row.vol]));
      const deleted = cutoff ? await q("DELETE FROM market_data.hk_index_daily WHERE index_code='HSI' AND trade_date < $1::date", [cutoff.iso]) : null;
      return { rows: rows.length, deleted: deleted?.rowCount ?? 0 };
    }
    return {
      async get({ indexCode = 'HSI', startDate, endDate } = {}) {
        const range = normalizeHkIndexRange({ indexCode, startDate, endDate });
        const result = await q(`SELECT index_code,to_char(trade_date,'YYYYMMDD') AS trade_date,open,high,low,close,vol,source,source_api,fetched_at
          FROM market_data.hk_index_daily WHERE index_code=$1 AND trade_date BETWEEN $2::date AND $3::date ORDER BY trade_date`, ['HSI', range.start.iso, range.end.iso]);
        return result.rows;
      },
      async getRun(runDate) {
        const date = normalizeTradeDate(runDate);
        const result = await q('SELECT status,summary FROM market_data.hk_index_update_runs WHERE run_date=$1::date', [date.iso]);
        return result.rows[0] ?? null;
      },
      async beginRun({ runDate, windowStart, windowEnd }) {
        const run = normalizeTradeDate(runDate), range = normalizeHkIndexRange({ startDate: windowStart, endDate: windowEnd });
        if (range.end.compact >= run.compact) throw invalid();
        await q(`INSERT INTO market_data.hk_index_update_runs(run_date,window_start,window_end,status) VALUES($1,$2,$3,'running')
          ON CONFLICT(run_date) DO UPDATE SET status='running',summary='{}',error_code=NULL,updated_at=clock_timestamp()`, [run.iso, range.start.iso, range.end.iso]);
      },
      async finalize({ runDate, windowStart, windowEnd, rows, startDate, summary }) {
        const run = normalizeTradeDate(runDate), range = normalizeHkIndexRange({ startDate: windowStart, endDate: windowEnd });
        if (range.end.compact >= run.compact) throw invalid();
        return transaction(client, async () => {
          const result = await upsert({ rows, startDate, endDate: windowEnd, retentionStart: windowStart });
          const changed = await q(`UPDATE market_data.hk_index_update_runs SET status='succeeded',summary=$2::jsonb,error_code=NULL,updated_at=clock_timestamp()
            WHERE run_date=$1::date AND status='running'`, [run.iso, JSON.stringify({ ...summary, ...result })]);
          if (changed.rowCount !== 1) throw invalid();
          await q('DELETE FROM market_data.hk_index_update_runs WHERE run_date < $1::date', [range.start.iso]);
          return result;
        });
      },
      async failRun({ runDate, errorCode }) {
        const allowed = ['validation_error', 'database_error', 'network_error', 'incomplete_window', 'provider_error'];
        await q("UPDATE market_data.hk_index_update_runs SET status='failed',error_code=$2,updated_at=clock_timestamp() WHERE run_date=$1::date AND status<>'succeeded'", [normalizeTradeDate(runDate).iso, allowed.includes(errorCode) ? errorCode : 'provider_error']);
      },
      upsert,
    };
  }
  return {
    async migrate() { await query(pool, await readFile(new URL('./hk-index-schema.sql', import.meta.url), 'utf8')); },
    get: options => scope(pool).get(options),
    async upsert(options) {
      let client; try { client = await pool.connect(); } catch { throw dbError(); }
      try { return await transaction(client, () => scope(client).upsert(options)); } finally { client.release(); }
    },
    async withLock(operation) {
      let client, locked = false, active = true;
      try {
        try { client = await pool.connect(); } catch { throw dbError(); }
        const result = await query(client, 'SELECT pg_try_advisory_lock($1,$2) AS locked', HK_INDEX_LOCK_KEYS);
        locked = result.rows[0]?.locked === true;
        if (!locked) return { status: 'busy' };
        return await operation(scope(client, () => active));
      } finally {
        active = false;
        try { if (locked) await query(client, 'SELECT pg_advisory_unlock($1,$2)', HK_INDEX_LOCK_KEYS); }
        finally { client?.release(); }
      }
    },
    async close() { try { await pool.end(); } catch { throw dbError(); } },
  };
}
