import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { normalizeTradeDate } from './postgres-store.mjs';
import { normalizeHkPoolRange } from './hk-pool-store.mjs';
import { rollingWindowForDate } from './rolling-update.mjs';

export const HK_VALUATION_SOURCE = Object.freeze({ source: 'baidu', apiName: 'baidu_hk_valuation' });
export const HK_VALUATION_LOCK_KEYS = Object.freeze([20261019, 629]);
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function invalid(message = '港股估值更新参数或响应无效。') { const error = new Error(message); error.kind = 'validation'; error.code = 'VALIDATION_ERROR'; return error; }
function incomplete() { const error = new Error('港股历史估值尚未覆盖已存交易日。'); error.kind = 'incomplete_window'; return error; }
function databaseError() { const error = new Error('港股估值 PostgreSQL 操作失败。'); error.kind = 'database'; error.code = 'DATABASE_ERROR'; return error; }
function tickerCode(ticker) { if (typeof ticker !== 'string' || !/^\d{5}\.HK$/.test(ticker)) throw invalid(); return ticker; }
export function validateHkValuationRows(rows, { ticker, startDate, endDate, allowEmpty=false }) {
  tickerCode(ticker); const { start, end } = normalizeHkPoolRange(startDate, endDate), seen = new Set();
  if (!Array.isArray(rows) || (!allowEmpty&&!rows.length) || rows.length > 366) throw invalid('港股估值日期数组为空或超出一自然年。');
  for (const row of rows) {
    if (!row || row.ts_code !== ticker || !Object.hasOwn(row, 'pe_ttm') || !Object.hasOwn(row, 'pb')) throw invalid();
    const date = normalizeTradeDate(row.trade_date).compact;
    if (row.trade_date !== date || date < start.compact || date > end.compact || seen.has(date)) throw invalid();
    seen.add(date);
    for (const field of ['pe_ttm', 'pb']) {
      const value = row[field];
      if (value !== null && (!(typeof value === 'number' || typeof value === 'string' && DECIMAL.test(value)) || !Number.isFinite(Number(value)))) throw invalid();
    }
  }
  return rows;
}
function identity(options) {
  const run = normalizeTradeDate(options.runDate), { start, end } = normalizeHkPoolRange(options.windowStart, options.windowEnd);
  const expectedWindow = rollingWindowForDate(run.iso);
  const { tickers, universeHash } = options, scope=options.scope??'pool';
  if (start.compact !== expectedWindow.windowStart || end.compact !== expectedWindow.windowEnd || !Array.isArray(tickers) || !tickers.length
    ||!['pool','all'].includes(scope)||tickers.length > (scope==='all'?10000:1000) || new Set(tickers).size !== tickers.length) throw invalid();
  tickers.forEach(tickerCode);
  if (createHash('sha256').update([...tickers].sort().join('\n')).digest('hex') !== universeHash) throw invalid();
  return { run, start, end, tickers, universeHash, scope };
}
function coverageValue(value={}) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
  let json;try{json=JSON.stringify(value);}catch{throw invalid();}
  if(json.length>100000||json.includes('\\u0000'))throw invalid();
  return JSON.parse(json);
}
const priceDatesHash=dates=>createHash('sha256').update([...dates].sort().join('\n')).digest('hex');
export function createHkValuationStore({ connectionString, pool: injectedPool } = {}) {
  if (!injectedPool && !connectionString?.trim()) throw invalid();
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000 });
  if (!injectedPool) pool.on('error', () => {});
  async function query(client, sql, values) { try { return await client.query(sql, values); } catch { throw databaseError(); } }
  async function transaction(client, operation) {
    await query(client, 'BEGIN');
    try { const result = await operation(); await query(client, 'COMMIT'); return result; }
    catch (error) { try { await query(client, 'ROLLBACK'); } catch {} throw error; }
  }
  function scope(client, active) {
    const q = (sql, values) => { if (!active()) throw invalid('港股估值更新锁已释放。'); return query(client, sql, values); };
    async function getRun(options) {
      const x = identity(options);
      const result = await q('SELECT status, summary FROM market_data.hk_valuation_update_runs WHERE run_date=$1 AND universe_hash=$2', [x.run.iso,x.universeHash]);
      return result.rows[0] ?? null;
    }
    async function priceDates(options) {
      const x = identity(options), ticker = tickerCode(options.ticker);
      if (!x.tickers.includes(ticker)) throw invalid();
      const result = await q(`SELECT to_char(trade_date,'YYYYMMDD') AS trade_date FROM market_data.daily_prices
        WHERE market='HK' AND ts_code=$1 AND trade_date BETWEEN $2 AND $3 ORDER BY trade_date`, [ticker,x.start.iso,x.end.iso]);
      return result.rows.map(row => row.trade_date);
    }
    async function getSymbolCheckpoint(options) {
      const x=identity(options), ticker=tickerCode(options.ticker);
      if (!x.tickers.includes(ticker)) throw invalid();
      const result=await q(`SELECT s.rows_count,${x.scope==='all'?'s.universe_hash,':''}
          (SELECT count(*) FROM market_data.daily_prices p WHERE p.market='HK' AND p.ts_code=$3 AND p.trade_date BETWEEN $4 AND $5) AS expected_count,
          (SELECT count(*) FROM market_data.hk_daily_valuations v JOIN market_data.daily_prices p USING(ts_code,trade_date)
            WHERE p.market='HK' AND v.ts_code=$3 AND v.trade_date BETWEEN $4 AND $5 AND v.source='baidu' AND v.source_api='baidu_hk_valuation') AS stored_count
        FROM market_data.hk_valuation_symbol_runs s WHERE s.run_date=$1 ${x.scope==='all'?'':'AND s.universe_hash=$2'} AND s.ts_code=$3
        ${x.scope==='all'?'ORDER BY (s.universe_hash=$2::text) DESC,s.updated_at DESC,s.universe_hash':''}`,
        [x.run.iso,x.universeHash,ticker,x.start.iso,x.end.iso]);
      const row=result.rows.find(row=>Number(row.rows_count)>0&&Number(row.rows_count)===Number(row.expected_count)&&Number(row.stored_count)===Number(row.expected_count));
      return row?{rowsCount:Number(row.rows_count),expectedCount:Number(row.expected_count),universeHash:row.universe_hash??x.universeHash}:null;
    }
    async function symbolComplete(options){return !!await getSymbolCheckpoint(options);}
    async function getSymbolAttempt(options){
      const x=identity(options),ticker=tickerCode(options.ticker);if(x.scope!=='all'||!x.tickers.includes(ticker))throw invalid();
      const result=await q(`SELECT status,rows_count,expected_count,error_code,coverage,universe_hash,updated_at
        FROM market_data.hk_valuation_symbol_attempts WHERE run_date=$1 AND ts_code=$2`,[x.run.iso,ticker]);
      const row=result.rows[0];return row?{status:row.status,rowsCount:Number(row.rows_count),expectedCount:Number(row.expected_count),errorCode:row.error_code,
        coverage:row.coverage??{},universeHash:row.universe_hash,updatedAt:row.updated_at}:null;
    }
    async function recordAttempt(x,ticker,{status,rowsCount=0,expectedCount=0,errorCode=null,coverage={},universeHash=x.universeHash}){
      await q(`INSERT INTO market_data.hk_valuation_symbol_attempts(run_date,ts_code,universe_hash,status,rows_count,expected_count,error_code,coverage)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(run_date,ts_code) DO UPDATE SET universe_hash=EXCLUDED.universe_hash,status=EXCLUDED.status,
        rows_count=EXCLUDED.rows_count,expected_count=EXCLUDED.expected_count,error_code=EXCLUDED.error_code,coverage=EXCLUDED.coverage,updated_at=clock_timestamp()`,
      [x.run.iso,ticker,universeHash,status,rowsCount,expectedCount,errorCode,JSON.stringify(coverageValue(coverage))]);
    }
    async function markSymbol(options){
      const x=identity(options),ticker=tickerCode(options.ticker);
      if(x.scope!=='all'||!x.tickers.includes(ticker)||!['running','failed','no_data','no_price_data'].includes(options.status)||(await getRun(options))?.status!=='running')throw invalid();
      const dates=await priceDates(options),coverage=coverageValue(options.coverage??{});
      coverage.priceDatesHash=priceDatesHash(dates);
      coverage.expectedPriceRows=dates.length;
      if(options.status==='no_price_data'&&dates.length)throw incomplete();
      if(options.status==='no_data'&&(!dates.length||typeof options.noDataEvidence!=='string'||!options.noDataEvidence.trim()))throw invalid('源无估值记录须保留明确无数据证据。');
      if(options.status==='no_data')coverage.noDataEvidence=options.noDataEvidence;
      const codes=new Set(['provider_error','network_error','database_error','validation_error','rate_limited','permission_denied','incomplete_window','no_data','no_price_data']);
      await recordAttempt(x,ticker,{status:options.status,expectedCount:dates.length,coverage,
        errorCode:options.status==='running'?null:['no_data','no_price_data'].includes(options.status)?options.status:codes.has(options.errorCode)?options.errorCode:'provider_error'});
    }
    async function confirmSymbol(options){
      const x=identity(options),ticker=tickerCode(options.ticker);
      if(x.scope!=='all'||(await getRun(options))?.status!=='running')throw invalid();
      const checkpoint=await getSymbolCheckpoint(options);if(!checkpoint)throw incomplete();
      const previous=await getSymbolAttempt(options);
      await recordAttempt(x,ticker,{status:'succeeded',rowsCount:checkpoint.rowsCount,expectedCount:checkpoint.expectedCount,universeHash:checkpoint.universeHash,
        coverage:previous?.status==='succeeded'?previous.coverage:{reusedVerifiedPriceCoverage:true}});
      return checkpoint;
    }
    return {
      getRun, priceDates, symbolComplete,getSymbolCheckpoint,getSymbolAttempt,markSymbol,confirmSymbol,
      async beginRun(options) {
        if(!active())throw invalid('港股估值更新锁已释放。');
        const x=identity(options);
        const start=async()=>{
          if(x.scope==='all')await q(`UPDATE market_data.hk_valuation_symbol_attempts SET status='failed',rows_count=0,error_code='incomplete_window',updated_at=clock_timestamp()
            WHERE status='running' AND run_date<=$1::date`,[x.run.iso]);
          await q(`INSERT INTO market_data.hk_valuation_update_runs (run_date,universe_hash,tickers,window_start,window_end,status)
            VALUES($1,$2,$3,$4,$5,'running') ON CONFLICT(run_date,universe_hash) DO UPDATE SET status='running',summary='{}',error_code=NULL,updated_at=now()`,
            [x.run.iso,x.universeHash,x.tickers,x.start.iso,x.end.iso]);
        };
        if(x.scope==='all')await transaction(client,start);else await start();
      },
      async saveSymbol(options) {
        if (!active()) throw invalid('港股估值更新锁已释放。');
        const x=identity(options), ticker=tickerCode(options.ticker);
        validateHkValuationRows(options.rows,{ticker,startDate:x.start.compact,endDate:x.end.compact});
        return transaction(client,async()=>{
          const run=await getRun(options); if(run?.status!=='running') throw invalid();
          const dates=await priceDates(options), byDate=new Map(options.rows.map(row=>[row.trade_date,row]));
          // Baidu publishes calendar-day carry-forwards. Only real price dates
          // become samples; an absent source trading date is never forward-filled.
          if(!dates.length || dates.some(date=>!byDate.has(date))) throw incomplete();
          const rows=dates.map(date=>byDate.get(date));
          const columns=['ts_code','trade_date','pe_ttm','pb','source','source_api'];
          const placeholders=rows.map((_,i)=>`(${columns.map((__,j)=>`$${i*columns.length+j+1}`).join(',')})`).join(',');
          await q(`INSERT INTO market_data.hk_daily_valuations (${columns.join(',')}) VALUES ${placeholders}
            ON CONFLICT(ts_code,trade_date) DO UPDATE SET pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,source=EXCLUDED.source,source_api=EXCLUDED.source_api,fetched_at=now()`,
            rows.flatMap(row=>[ticker,normalizeTradeDate(row.trade_date).iso,row.pe_ttm,row.pb,'baidu','baidu_hk_valuation']));
          const sourceThrough=normalizeTradeDate([...byDate.keys()].sort().at(-1)).iso;
          await q(`INSERT INTO market_data.hk_valuation_symbol_runs(run_date,universe_hash,ts_code,rows_count,source_through)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_date,universe_hash,ts_code) DO UPDATE SET rows_count=EXCLUDED.rows_count,source_through=EXCLUDED.source_through,updated_at=now()`,
            [x.run.iso,x.universeHash,ticker,rows.length,sourceThrough]);
          let deleted;
          if(x.scope==='all'){
            await recordAttempt(x,ticker,{status:'succeeded',rowsCount:rows.length,expectedCount:dates.length,
              coverage:{...coverageValue(options.coverage??{}),priceDatesHash:priceDatesHash(dates),expectedPriceRows:dates.length}});
            deleted=await q(`DELETE FROM market_data.hk_daily_valuations WHERE trade_date < $1 AND ts_code=$2 AND source='baidu' AND source_api='baidu_hk_valuation'`,[x.start.iso,ticker]);
          }
          return { rowsCount:rows.length,sourceRowsCount:options.rows.length,firstDate:dates[0],lastDate:dates.at(-1),...(deleted?{deleted:deleted.rowCount}:{}) };
        });
      },
      async finalize(options) {
        if (!active()) throw invalid('港股估值更新锁已释放。');
        const x=identity(options);
        return transaction(client,async()=>{
          if((await getRun(options))?.status!=='running') throw invalid();
          for(const ticker of x.tickers) if(!await symbolComplete({...options,ticker})) throw incomplete();
          const deleted=await q(`DELETE FROM market_data.hk_daily_valuations WHERE trade_date < $1 AND ts_code = ANY($2::text[]) AND source='baidu' AND source_api='baidu_hk_valuation'`,[x.start.iso,x.tickers]);
          await q(`UPDATE market_data.hk_valuation_update_runs SET status='succeeded',summary=$3::jsonb,error_code=NULL,updated_at=now() WHERE run_date=$1 AND universe_hash=$2`,[x.run.iso,x.universeHash,JSON.stringify(options.summary)]);
          await q('DELETE FROM market_data.hk_valuation_symbol_runs WHERE run_date < $1',[x.start.iso]);
          if(x.scope==='all')await q('DELETE FROM market_data.hk_valuation_symbol_attempts WHERE run_date < $1',[x.start.iso]);
          await q('DELETE FROM market_data.hk_valuation_update_runs WHERE run_date < $1',[x.start.iso]);
          return {deleted:deleted.rowCount};
        });
      },
      async failRun(options) {
        const x=identity(options), codes=new Set(['provider_error','network_error','database_error','validation_error','rate_limited','permission_denied','incomplete_window','no_data','no_price_data']);
        await q(`UPDATE market_data.hk_valuation_update_runs SET status=$3,summary=$4::jsonb,error_code=$5,updated_at=now() WHERE run_date=$1 AND universe_hash=$2 AND status<>'succeeded'`,
          [x.run.iso,x.universeHash,options.partial?'partial':'failed',JSON.stringify(options.summary),codes.has(options.errorCode)?options.errorCode:'provider_error']);
        if(x.scope==='all')await q(`UPDATE market_data.hk_valuation_symbol_attempts SET status='failed',rows_count=0,error_code=$3,updated_at=clock_timestamp()
          WHERE run_date=$1 AND universe_hash=$2 AND status='running'`,[x.run.iso,x.universeHash,codes.has(options.errorCode)?options.errorCode:'provider_error']);
      },
    };
  }
  return {
    async migrate(){await query(pool,await readFile(new URL('./hk-valuation-schema.sql',import.meta.url),'utf8'));},
    async withLock(operation){
      let client;try{client=await pool.connect();}catch{throw databaseError();}
      let locked=false,live=true,broken=false;
      const onError=()=>{live=false;broken=true;}; client.on?.('error',onError);
      try{
        locked=(await query(client,'SELECT pg_try_advisory_lock($1,$2) AS locked',HK_VALUATION_LOCK_KEYS)).rows[0]?.locked===true;
        if(!locked)return {status:'busy'};
        const result = await operation(scope(client,()=>live));
        if (broken) throw databaseError();
        return result;
      }finally{
        live=false;
        if(locked&&!broken)try{await query(client,'SELECT pg_advisory_unlock($1,$2)',HK_VALUATION_LOCK_KEYS);}catch{broken=true;}
        client.removeListener?.('error',onError);client.release(broken);
      }
    },
    async close(){try{await pool.end();}catch{throw databaseError();}},
  };
}
