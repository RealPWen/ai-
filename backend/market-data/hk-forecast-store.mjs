import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { normalizeTradeDate } from './postgres-store.mjs';
import { rollingWindowForDate } from './rolling-update.mjs';

export const HK_FORECAST_SOURCE = Object.freeze({ source: 'etnet', apiName: 'etnet_hk_profit_forecast' });
export const HK_FORECAST_LOCK_KEYS = Object.freeze([20261019, 630]);
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const COLUMNS = ['forecast_id','snapshot_date','universe_hash','ts_code','source_record_id','report_date','report_title','org_name','author_name','fiscal_year','fiscal_period','eps','currency','eps_basis','np','pe','rating','source','source_api','source_url','raw_data'];
function invalid(message = '港股卖方预测参数或响应无效。') { const error = new Error(message); error.kind = 'validation'; error.code = 'VALIDATION_ERROR'; return error; }
function databaseError() { const error = new Error('港股卖方预测 PostgreSQL 操作失败。'); error.kind = 'database'; error.code = 'DATABASE_ERROR'; return error; }
function tickerCode(value) { if (typeof value !== 'string' || !/^\d{5}\.HK$/.test(value)) throw invalid(); return value; }
export function hkForecastWindow(runDate) {
  const window = rollingWindowForDate(runDate);
  return { ...window, windowEnd: window.runDate.replaceAll('-','') };
}
function identity(options) {
  const window = hkForecastWindow(options.runDate), tickers = options.tickers, scope = options.scope ?? 'pool';
  if (options.windowStart !== window.windowStart || options.windowEnd !== window.windowEnd || !Array.isArray(tickers)
    || !['pool', 'all'].includes(scope) || !tickers.length || tickers.length > (scope === 'all' ? 10000 : 1000)
    || new Set(tickers).size !== tickers.length) throw invalid();
  tickers.forEach(tickerCode);
  const hash = createHash('sha256').update([...tickers].sort().join('\n')).digest('hex');
  if (hash !== options.universeHash) throw invalid();
  return { ...window, scope, start: normalizeTradeDate(window.windowStart).iso, end: normalizeTradeDate(window.windowEnd).iso, tickers, universeHash: hash };
}
function safeSourceUrl(value, ticker) {
  let url; try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.etnet.com.hk' || url.pathname !== '/www/sc/stocks/realtime/quote_profit.php'
    || url.username || url.password || url.port || url.hash || [...url.searchParams.keys()].some(key => key !== 'code')
    || url.searchParams.getAll('code').length !== 1 || !/^\d{1,5}$/.test(url.searchParams.get('code') ?? '')
    || Number(url.searchParams.get('code')) !== Number(ticker.slice(0,5))) throw invalid('港股预测来源链接与标的不一致。');
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export function validateHkForecastRows(rows, { ticker, startDate, endDate }) {
  tickerCode(ticker); const start = normalizeTradeDate(startDate).compact, end = normalizeTradeDate(endDate).compact;
  if (start > end || !Array.isArray(rows) || rows.length > 10000) throw invalid();
  const unique = new Map();
  for (const row of rows) {
    if (!row || row.ts_code !== ticker || typeof row.org_name !== 'string' || !row.org_name.trim()
      || typeof row.source_record_id !== 'string' || !row.source_record_id.trim() || !Number.isInteger(row.fiscal_year)
      || row.fiscal_year < 1900 || row.fiscal_year > 2200 || typeof row.fiscal_period !== 'string'
      || !new RegExp(`^${row.fiscal_year}(?:-(?:0[1-9]|1[0-2]))?$`).test(row.fiscal_period)
      || !row.raw_data || typeof row.raw_data !== 'object' || Array.isArray(row.raw_data)) throw invalid();
    const date = normalizeTradeDate(row.report_date).compact;
    if (date !== row.report_date || date < start || date > end) throw invalid('港股预测机构更新日期超出本次范围。');
    for (const field of ['eps','np','pe']) {
      const value = row[field];
      if (value !== null && (!(typeof value === 'number' || typeof value === 'string' && DECIMAL.test(value)) || !Number.isFinite(Number(value)))) throw invalid();
    }
    for (const field of ['report_title','author_name','eps_basis','rating']) if (row[field] !== null && typeof row[field] !== 'string') throw invalid();
    if (row.currency !== null && (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency))) throw invalid();
    safeSourceUrl(row.source_url,ticker);
    const fingerprint = canonical(row); unique.set(fingerprint,row);
  }
  return [...unique.values()];
}
export function validateHkForecastCoverage(coverage, rowsCount) {
  if (!coverage || coverage.kind !== 'current_snapshot' || coverage.dateMeaning !== 'broker_update_date'
    || coverage.historicalArchiveAvailable !== false || !Number.isInteger(coverage.sourceRows) || coverage.sourceRows < rowsCount
    || coverage.rowsInRange !== rowsCount) throw invalid('港股预测采集范围或来源证据无效。');
  if (rowsCount === 0 && (coverage.sourceRows === 0
    ? typeof coverage.noDataEvidence !== 'string' || !coverage.noDataEvidence.trim()
    : !Number.isInteger(coverage.outsideRange) || coverage.outsideRange !== coverage.sourceRows)) throw invalid('空港股预测快照缺少来源无数据证据。');
  return coverage;
}
export function createHkForecastStore({ connectionString, pool: injectedPool } = {}) {
  if (!injectedPool && !connectionString?.trim()) throw invalid();
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000 });
  if (!injectedPool) pool.on('error',()=>{});
  async function query(client,sql,values) { try { return await client.query(sql,values); } catch { throw databaseError(); } }
  async function transaction(client,operation) {
    await query(client,'BEGIN');
    try { const result = await operation(); await query(client,'COMMIT'); return result; }
    catch (error) { try { await query(client,'ROLLBACK'); } catch {} throw error; }
  }
  function scope(client,active) {
    function q(sql,values) { if (!active()) throw invalid('港股预测更新锁已释放。'); return query(client,sql,values); }
    async function getRun(options) {
      const x=identity(options);
      const result=await q('SELECT status,summary FROM market_data.hk_forecast_update_runs WHERE run_date=$1 AND universe_hash=$2',[x.runDate,x.universeHash]);
      return result.rows[0]??null;
    }
    async function getSymbolCheckpoint(options) {
      const x=identity(options), ticker=tickerCode(options.ticker); if (!x.tickers.includes(ticker)) throw invalid();
      const result=await q(x.scope === 'all' ? `SELECT s.universe_hash,s.rows_count,(SELECT count(*) FROM market_data.hk_sell_side_forecasts f
          WHERE f.snapshot_date=$1 AND f.universe_hash=s.universe_hash AND f.ts_code=$3 AND f.source='etnet' AND f.source_api='etnet_hk_profit_forecast') AS stored_count
        FROM market_data.hk_forecast_symbol_runs s WHERE s.run_date=$1 AND s.ts_code=$3 AND s.status='succeeded'
        ORDER BY (s.universe_hash=$2::text) DESC,s.fetched_at DESC,s.universe_hash` : `SELECT s.rows_count,(SELECT count(*) FROM market_data.hk_sell_side_forecasts f
          WHERE f.snapshot_date=$1 AND f.universe_hash=$2 AND f.ts_code=$3 AND f.source='etnet' AND f.source_api='etnet_hk_profit_forecast') AS stored_count
        FROM market_data.hk_forecast_symbol_runs s WHERE s.run_date=$1 AND s.universe_hash=$2 AND s.ts_code=$3 AND s.status='succeeded'`,[x.runDate,x.universeHash,ticker]);
      const row=result.rows.find(row => Number.isInteger(Number(row.rows_count)) && Number(row.rows_count)>=0 && Number(row.rows_count)===Number(row.stored_count));
      return row ? {snapshotDate:x.runDate,universeHash:row.universe_hash??x.universeHash,rowsCount:Number(row.rows_count),status:Number(row.rows_count)?'available':'no_data'} : null;
    }
    async function symbolComplete(options) {return !!await getSymbolCheckpoint(options);}
    async function markSymbol(options) {
      const x=identity(options),ticker=tickerCode(options.ticker);
      if(x.scope!=='all'||!x.tickers.includes(ticker)||!['running','failed'].includes(options.status))throw invalid();
      if((await getRun(options))?.status!=='running')throw invalid();
      const codes=new Set(['provider_error','network_error','database_error','validation_error','rate_limited','permission_denied','incomplete_window','observation_date_changed']);
      await q(`INSERT INTO market_data.hk_forecast_symbol_attempts(run_date,ts_code,universe_hash,status,rows_count,error_code)
        VALUES($1,$2,$3,$4,0,$5) ON CONFLICT(run_date,ts_code) DO UPDATE SET universe_hash=EXCLUDED.universe_hash,
        status=EXCLUDED.status,rows_count=0,error_code=EXCLUDED.error_code,updated_at=clock_timestamp()`,
      [x.runDate,ticker,x.universeHash,options.status,options.status==='running'?null:codes.has(options.errorCode)?options.errorCode:'provider_error']);
    }
    async function confirmSymbol(options) {
      const x=identity(options),ticker=tickerCode(options.ticker);
      if(x.scope!=='all')throw invalid();
      if((await getRun(options))?.status!=='running')throw invalid();
      const checkpoint=await getSymbolCheckpoint(options);if(!checkpoint)throw invalid();
      await q(`INSERT INTO market_data.hk_forecast_symbol_attempts(run_date,ts_code,universe_hash,status,rows_count,error_code)
        VALUES($1,$2,$3,$4,$5,NULL) ON CONFLICT(run_date,ts_code) DO UPDATE SET universe_hash=EXCLUDED.universe_hash,
        status=EXCLUDED.status,rows_count=EXCLUDED.rows_count,error_code=NULL,updated_at=clock_timestamp()`,
      [x.runDate,ticker,checkpoint.universeHash,checkpoint.rowsCount?'succeeded':'no_data',checkpoint.rowsCount]);
      return checkpoint;
    }
    return {
      getRun,symbolComplete,getSymbolCheckpoint,markSymbol,confirmSymbol,
      async beginRun(options) {
        if(!active())throw invalid('港股预测更新锁已释放。');
        const x=identity(options);
        const start=async()=>{
          // This scope owns the process-wide forecast advisory lock, so no
          // earlier running attempt can still belong to a live collector.
          // Keep the original observation date and all successful snapshots.
          if(x.scope==='all')await q(`UPDATE market_data.hk_forecast_symbol_attempts SET status='failed',rows_count=0,
            error_code='incomplete_window',updated_at=clock_timestamp() WHERE status='running' AND run_date<=$1::date`,[x.runDate]);
          await q(`INSERT INTO market_data.hk_forecast_update_runs(run_date,universe_hash,tickers,window_start,window_end,status)
            VALUES($1,$2,$3,$4,$5,'running') ON CONFLICT(run_date,universe_hash) DO UPDATE SET status='running',summary='{}',error_code=NULL,updated_at=now()`,[x.runDate,x.universeHash,x.tickers,x.start,x.end]);
        };
        if(x.scope==='all')await transaction(client,start);else await start();
      },
      async saveSymbol(options) {
        if (!active()) throw invalid('港股预测更新锁已释放。');
        const x=identity(options), ticker=tickerCode(options.ticker); if (!x.tickers.includes(ticker)) throw invalid();
        const rows=validateHkForecastRows(options.rows,{ticker,startDate:x.windowStart,endDate:x.windowEnd});
        if(x.scope==='all')validateHkForecastCoverage(options.coverage,options.rows.length);
        return transaction(client,async()=>{
          if ((await getRun(options))?.status!=='running') throw invalid();
          // Replace only this daily snapshot. Empty successful pages must also
          // supersede yesterday's predictions rather than revive deleted rows.
          await q('DELETE FROM market_data.hk_sell_side_forecasts WHERE snapshot_date=$1 AND universe_hash=$2 AND ts_code=$3',[x.runDate,x.universeHash,ticker]);
          for (let offset=0;offset<rows.length;offset+=300) {
            const batch=rows.slice(offset,offset+300);
            const values=batch.map(row=>{
              const id=createHash('sha256').update(`${x.runDate}\n${x.universeHash}\n${canonical(row)}`).digest('hex');
              return [id,x.runDate,x.universeHash,ticker,row.source_record_id,normalizeTradeDate(row.report_date).iso,row.report_title,row.org_name,row.author_name,row.fiscal_year,row.fiscal_period,row.eps,row.currency,row.eps_basis,row.np,row.pe,row.rating,'etnet','etnet_hk_profit_forecast',row.source_url,JSON.stringify(row.raw_data)];
            });
            const placeholders=values.map((_,i)=>`(${COLUMNS.map((__,j)=>`$${i*COLUMNS.length+j+1}`).join(',')})`).join(',');
            await q(`INSERT INTO market_data.hk_sell_side_forecasts(${COLUMNS.join(',')}) VALUES ${placeholders} ON CONFLICT(forecast_id) DO NOTHING`,values.flat());
          }
          await q(`INSERT INTO market_data.hk_forecast_symbol_runs(run_date,universe_hash,ts_code,status,rows_count)
            VALUES($1,$2,$3,'succeeded',$4) ON CONFLICT(run_date,universe_hash,ts_code) DO UPDATE SET status='succeeded',rows_count=EXCLUDED.rows_count,fetched_at=now()`,[x.runDate,x.universeHash,ticker,rows.length]);
          if(x.scope==='all')await q(`INSERT INTO market_data.hk_forecast_symbol_attempts(run_date,ts_code,universe_hash,status,rows_count,error_code)
            VALUES($1,$2,$3,$4,$5,NULL) ON CONFLICT(run_date,ts_code) DO UPDATE SET universe_hash=EXCLUDED.universe_hash,
            status=EXCLUDED.status,rows_count=EXCLUDED.rows_count,error_code=NULL,updated_at=clock_timestamp()`,[x.runDate,ticker,x.universeHash,rows.length?'succeeded':'no_data',rows.length]);
          // A failed symbol elsewhere must not prevent a successfully observed
          // company from enforcing its own one-year snapshot retention.
          const pruned=x.scope==='all'?await q(`DELETE FROM market_data.hk_sell_side_forecasts WHERE snapshot_date < $1 AND ts_code=$2 AND source='etnet' AND source_api='etnet_hk_profit_forecast'`,[x.start,ticker]):null;
          return {rowsCount:rows.length,brokerCount:new Set(rows.map(row=>row.org_name)).size,fiscalPeriods:[...new Set(rows.map(row=>row.fiscal_period))].sort(),...(pruned?{deleted:pruned.rowCount}: {})};
        });
      },
      async finalize(options) {
        if (!active()) throw invalid('港股预测更新锁已释放。'); const x=identity(options);
        return transaction(client,async()=>{
          if ((await getRun(options))?.status!=='running') throw invalid();
          for (const ticker of x.tickers) if (!await symbolComplete({...options,ticker})) throw invalid('港股预测尚有未完成的股票。');
          const deleted=await q(x.scope==='all'
            ? `DELETE FROM market_data.hk_sell_side_forecasts WHERE snapshot_date < $1 AND source='etnet' AND source_api='etnet_hk_profit_forecast'`
            : `DELETE FROM market_data.hk_sell_side_forecasts WHERE snapshot_date < $1 AND ts_code=ANY($2::text[]) AND source='etnet' AND source_api='etnet_hk_profit_forecast'`,x.scope==='all'?[x.start]:[x.start,x.tickers]);
          await q('DELETE FROM market_data.hk_forecast_symbol_runs WHERE run_date < $1',[x.start]);
          if(x.scope==='all')await q('DELETE FROM market_data.hk_forecast_symbol_attempts WHERE run_date < $1',[x.start]);
          await q('DELETE FROM market_data.hk_forecast_update_runs WHERE run_date < $1',[x.start]);
          await q(`UPDATE market_data.hk_forecast_update_runs SET status='succeeded',summary=$3::jsonb,error_code=NULL,updated_at=now() WHERE run_date=$1 AND universe_hash=$2`,[x.runDate,x.universeHash,JSON.stringify(options.summary)]);
          return {deleted:deleted.rowCount};
        });
      },
      async failRun(options) {
        const x=identity(options), codes=new Set(['provider_error','network_error','database_error','validation_error','rate_limited','permission_denied','incomplete_window','observation_date_changed']);
        await q(`UPDATE market_data.hk_forecast_update_runs SET status=$3,summary=$4::jsonb,error_code=$5,updated_at=now() WHERE run_date=$1 AND universe_hash=$2 AND status<>'succeeded'`,[x.runDate,x.universeHash,options.partial?'partial':'failed',JSON.stringify(options.summary),codes.has(options.errorCode)?options.errorCode:'provider_error']);
        if(x.scope==='all')await q(`UPDATE market_data.hk_forecast_symbol_attempts SET status='failed',rows_count=0,error_code=$3,updated_at=clock_timestamp()
          WHERE run_date=$1 AND universe_hash=$2 AND status='running'`,[x.runDate,x.universeHash,codes.has(options.errorCode)?options.errorCode:'provider_error']);
      },
    };
  }
  return {
    async migrate() { await query(pool,await readFile(new URL('./hk-forecast-schema.sql',import.meta.url),'utf8')); },
    async withLock(operation) {
      let client;try { client=await pool.connect(); } catch { throw databaseError(); }
      let locked=false,live=true,broken=false;const onError=()=>{live=false;broken=true;};client.on?.('error',onError);
      try {
        locked=(await query(client,'SELECT pg_try_advisory_lock($1,$2) AS locked',HK_FORECAST_LOCK_KEYS)).rows[0]?.locked===true;
        if (!locked) return {status:'busy'};
        const result=await operation(scope(client,()=>live)); if (broken) throw databaseError(); return result;
      } finally {
        live=false;if (locked&&!broken) try {await query(client,'SELECT pg_advisory_unlock($1,$2)',HK_FORECAST_LOCK_KEYS);} catch {broken=true;}
        client.removeListener?.('error',onError);client.release(broken);
      }
    },
    async close() {try {await pool.end();} catch {throw databaseError();}},
  };
}
