import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { normalizeTradeDate } from './postgres-store.mjs';
import { DAILY_FIELDS } from './sync.mjs';
import { normalizeHkPoolRange, missingHkPoolRanges, validateHkPoolRows } from './hk-pool-store.mjs';

export const HK_MARKET_LOCK_KEYS = Object.freeze([20261019, 631]);
const SOURCE = 'tencent', API = 'tencent_hk_daily';
const NUMERIC_FIELDS = DAILY_FIELDS.split(',').slice(2);
const PRICE_COLUMNS = ['ts_code','trade_date','market',...NUMERIC_FIELDS,'source','source_api','adjustment','volume_unit','amount_unit','currency'];
const SAFE_CODES = new Set(['provider_error','network_error','database_error','validation_error','permission_denied','authentication_error','rate_limited','no_data','incomplete_window']);
const RUN_COLUMNS = `to_char(run_date,'YYYY-MM-DD') AS "runDate",universe_hash AS "universeHash",tickers,
  to_char(window_start,'YYYY-MM-DD') AS "windowStart",to_char(window_end,'YYYY-MM-DD') AS "windowEnd",status,summary`;
function invalid(message='港股全市场存储参数无效。') { const error=new Error(message); error.kind='validation'; error.code='VALIDATION_ERROR'; return error; }
function dbError(original) { const error=new Error('港股全市场 PostgreSQL 操作失败。'); error.kind='database'; error.code='DATABASE_ERROR';
  if (typeof original?.code==='string' && /^[0-9A-Z]{5}$/.test(original.code)) error.sqlState=original.code; return error; }
function ticker(value) { if (typeof value!=='string' || !/^\d{5}\.HK$/.test(value)) throw invalid(); return value; }
function hash(value) { if (typeof value!=='string' || !/^[a-f0-9]{64}$/.test(value)) throw invalid(); return value; }
function members(tickers, universeHash) {
  if (!Array.isArray(tickers) || tickers.length<1 || tickers.length>10000) throw invalid();
  tickers.forEach(ticker);
  if (new Set(tickers).size!==tickers.length || createHash('sha256').update([...tickers].sort().join('\n')).digest('hex')!==hash(universeHash)) throw invalid();
  return tickers;
}
function runKey(options) { return [normalizeTradeDate(options.runDate).iso,hash(options.universeHash)]; }
function runWindow(options) {
  const run=normalizeTradeDate(options.runDate), {start,end}=normalizeHkPoolRange(options.windowStart,options.windowEnd);
  if (end.compact>=run.compact) throw invalid(); return {run,start,end};
}
function summaryJson(summary={}) {
  if (!summary || typeof summary!=='object' || Array.isArray(summary)) throw invalid();
  let result; try { result=JSON.stringify(summary); } catch { throw invalid(); }
  if (result.length>100000) throw invalid(); return result;
}
function weekends(start,end) {
  for (let cursor=Date.parse(start.iso);cursor<=Date.parse(end.iso);cursor+=86400000) if (![0,6].includes(new Date(cursor).getUTCDay())) return false;
  return true;
}
function closedCalendar(rows,start,end) {
  if (!Array.isArray(rows)||!rows.length||rows.length>400) throw invalid('港股休市证明缺少完整日历。');
  const dates=new Map();
  for(const row of rows) {
    const date=normalizeTradeDate(row?.cal_date).compact;
    if(date!==row.cal_date||dates.has(date)||![0,1,'0','1'].includes(row.is_open)) throw invalid('港股休市证明日历无效。');
    dates.set(date,Number(row.is_open));
  }
  for(let cursor=Date.parse(start.iso);cursor<=Date.parse(end.iso);cursor+=86400000) {
    const date=new Date(cursor).toISOString().slice(0,10).replaceAll('-','');
    if(dates.get(date)!==0) throw invalid('港股休市证明包含交易日或缺失日期。');
  }
  return true;
}
function normalizeCatalog(catalog) {
  const input=Array.isArray(catalog?.securities)?catalog.securities:Array.isArray(catalog?.rows)?catalog.rows:null;
  if (catalog?.complete!==true || !input?.length || input.length>10000) throw invalid('只接受经过完整性验证的在市公司名单。');
  const rows=input.map(row=>{
    const code=ticker(row?.ticker??row?.ts_code), name=typeof row?.name==='string'?row.name.trim():null, currency=row?.currency??'HKD';
    if (!name || !['HKD','USD'].includes(currency)) throw invalid();
    const date=row.listDate??row.list_date;
    return {ticker:code,name,currency,listDate:date===undefined||date===null||date===''?null:normalizeTradeDate(date).iso,
      board:row.board??null,isin:row.isin??null};
  });
  const universeHash=catalog.universeHash??createHash('sha256').update(rows.map(row=>row.ticker).sort().join('\n')).digest('hex');
  members(rows.map(row=>row.ticker),universeHash);
  const source=catalog.source,apiName=catalog.apiName??catalog.sourceApi??catalog.source_api;
  if (typeof source!=='string' || !/^[a-z][a-z0-9_]{0,63}$/.test(source) || typeof apiName!=='string' || !/^[a-z][a-z0-9_]{0,99}$/.test(apiName)) throw invalid();
  if (rows.some(row=>[row.board,row.isin].some(value=>value!==null&&(typeof value!=='string'||value.length>200)))) throw invalid();
  return {rows,universeHash,source,apiName};
}

export function createHkMarketStore({connectionString,pool:injectedPool}={}) {
  if (!injectedPool && (typeof connectionString!=='string'||!connectionString.trim())) throw invalid();
  const pool=injectedPool??new pg.Pool({connectionString,max:2,connectionTimeoutMillis:10000});
  if (!injectedPool) pool.on('error',()=>{});
  async function connect() { try {return await pool.connect();} catch(error) {throw dbError(error);} }
  async function query(client,sql,values) { try {return await client.query(sql,values);} catch(error) {throw dbError(error);} }
  async function transaction(client,operation) {
    let began=false;
    try {await query(client,'BEGIN');began=true;const value=await operation();await query(client,'COMMIT');return value;}
    catch(error) {if(began) try {await query(client,'ROLLBACK');} catch{} throw error;}
  }
  function scopeFor(client,isActive) {
    const sql=(text,values)=>{if(!isActive()) throw invalid('港股全市场更新锁已释放。');return query(client,text,values);};
    const lockedTransaction=operation=>{if(!isActive()) throw invalid('港股全市场更新锁已释放。');return transaction(client,operation);};
    async function getRun(options,forUpdate=false) {
      const result=await sql(`SELECT ${RUN_COLUMNS} FROM market_data.hk_market_update_runs WHERE run_date=$1 AND universe_hash=$2${forUpdate?' FOR UPDATE':''}`,runKey(options));
      return result.rows[0]??null;
    }
    async function assertRun(options) {
      const value=await getRun(options,true), code=ticker(options.ticker), {start,end}=runWindow(options);
      if(value?.status!=='running'||value.windowStart!==start.iso||value.windowEnd!==end.iso||!value.tickers?.includes(code)) throw invalid();
      return {code,start,end};
    }
    async function getRanges(options) {
      const code=ticker(options.ticker), {start,end}=normalizeHkPoolRange(options.startDate,options.endDate);
      const result=await sql(`SELECT to_char(range_start,'YYYYMMDD') AS "startDate",to_char(range_end,'YYYYMMDD') AS "endDate",rows_count AS "rowsCount"
        FROM market_data.hk_market_symbol_ranges AS coverage WHERE ts_code=$1 AND source=$2 AND source_api=$3
        AND range_start<=$5::date AND range_end>=$4::date
        AND (rows_count>0 OR empty_proof IN ('weekends','hk_tradecal'))
        AND rows_count=(SELECT count(*) FROM market_data.daily_prices AS prices WHERE prices.market='HK'
          AND prices.ts_code=coverage.ts_code AND prices.source=coverage.source AND prices.source_api=coverage.source_api
          AND prices.trade_date BETWEEN coverage.range_start AND coverage.range_end) ORDER BY range_start,range_end`,[code,SOURCE,API,start.iso,end.iso]);
      return result.rows;
    }
    async function attempt(options,status,rowsCount,lastQuoteDate,errorCode=null) {
      await sql(`INSERT INTO market_data.hk_market_symbol_attempts (run_date,ts_code,universe_hash,status,rows_count,error_code,last_quote_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (run_date,ts_code) DO UPDATE SET universe_hash=EXCLUDED.universe_hash,
        status=EXCLUDED.status,rows_count=EXCLUDED.rows_count,error_code=EXCLUDED.error_code,last_quote_date=EXCLUDED.last_quote_date,updated_at=now()`,
      [normalizeTradeDate(options.runDate).iso,ticker(options.ticker),hash(options.universeHash),status,rowsCount,errorCode,lastQuoteDate]);
    }
    return {getRun,getRanges,
      async getSymbolAttempt(options) {
        const result=await sql(`SELECT status,rows_count AS "rowsCount",error_code AS "errorCode",
          to_char(last_quote_date,'YYYY-MM-DD') AS "lastQuoteDate" FROM market_data.hk_market_symbol_attempts
          WHERE run_date=$1 AND ts_code=$2 AND universe_hash=$3`,[normalizeTradeDate(options.runDate).iso,ticker(options.ticker),hash(options.universeHash)]);
        return result.rows[0]??null;
      },
      async confirmSymbol(options) {
        const currency=options.currency??'HKD';
        if(!['HKD','USD'].includes(currency)) throw invalid();
        return lockedTransaction(async()=>{
          const {code,start,end}=await assertRun(options);
          const ranges=await getRanges({ticker:code,startDate:start.compact,endDate:end.compact});
          if(missingHkPoolRanges(ranges,start.compact,end.compact).length) {
            const error=new Error('港股年度覆盖尚未完整。');error.kind='incomplete_window';throw error;
          }
          const actual=await sql(`SELECT to_char(max(trade_date),'YYYY-MM-DD') AS date,
            count(*)::integer AS "annualRowsCount",
            count(*) FILTER (WHERE currency=$6 AND amount_unit=$7 AND volume_unit='share' AND adjustment='none')::integer AS "matchingRowsCount"
            FROM market_data.daily_prices WHERE market='HK' AND ts_code=$1 AND source=$2 AND source_api=$3
            AND trade_date BETWEEN $4::date AND $5::date`,[code,SOURCE,API,start.iso,end.iso,currency,currency==='USD'?'usd':'hkd']);
          const value=actual.rows[0];
          if(!Number.isSafeInteger(value?.annualRowsCount)||value.annualRowsCount<1||value.matchingRowsCount!==value.annualRowsCount) throw invalid('港股已存行情来源或币种不一致。');
          await attempt(options,'completed',value.annualRowsCount,value.date);
          return {ticker:code,complete:true,rowsCount:value.annualRowsCount,lastQuoteDate:value.date};
        });
      },
      async beginRun(options) {
        const {start,end}=runWindow(options),codes=members(options.tickers,options.universeHash);
        return lockedTransaction(async()=>{
          // The shared market lock proves no older process still owns these
          // frozen memberships. Preserve their progress as a superseded run.
          await sql(`UPDATE market_data.hk_market_update_runs SET status='partial',finished_at=now(),updated_at=now(),
            summary=summary||jsonb_build_object('supersededByUniverseHash',$2::text)
            WHERE run_date=$1 AND universe_hash<>$2 AND status='running'`,runKey(options));
          await sql(`INSERT INTO market_data.hk_market_update_runs (run_date,universe_hash,tickers,window_start,window_end,status)
            VALUES ($1,$2,$3,$4,$5,'running') ON CONFLICT (run_date,universe_hash) DO UPDATE SET tickers=EXCLUDED.tickers,
            window_start=EXCLUDED.window_start,window_end=EXCLUDED.window_end,status='running',summary='{}'::jsonb,
            started_at=now(),finished_at=NULL,updated_at=now()`,[...runKey(options),codes,start.iso,end.iso]);
        });
      },
      async saveSymbol(options) {
        const code=ticker(options.ticker), {start,end}=runWindow(options);
        const currency=options.currency??'HKD';
        if(!['HKD','USD'].includes(currency)) throw invalid('港股报价币种无效。');
        const amountUnit=currency==='USD'?'usd':'hkd';
        const requested=normalizeHkPoolRange(options.requestedStartDate,options.requestedEndDate);
        if (requested.end.compact>end.compact || requested.end.compact<start.compact || requested.start.compact>end.compact) throw invalid();
        const lower=new Date(Date.parse(start.iso)-30*86400000).toISOString().slice(0,10);
        if (requested.start.iso<lower) throw invalid();
        const coverStart=normalizeTradeDate(requested.start.compact<start.compact?start.compact:requested.start.compact),coverEnd=requested.end;
        if(options.emptyProof!==undefined&&!['weekends','hk_tradecal'].includes(options.emptyProof)) throw invalid();
        const emptyProof=options.emptyProof==='hk_tradecal'
          ?(closedCalendar(options.calendarRows,coverStart,coverEnd)?'hk_tradecal':null)
          :weekends(coverStart,coverEnd)?'weekends':null;
        const rows=validateHkPoolRows(options.rows,{ticker:code,startDate:requested.start.compact,endDate:requested.end.compact,allowEmpty:emptyProof!==null});
        const annualRows=rows.filter(row=>row.trade_date>=start.compact&&row.trade_date<=end.compact);
        if (!annualRows.length&&!emptyProof) {const error=new Error('没有可确认的港股年度行情。');error.kind='no_data';throw error;}
        const prior=rows.filter(row=>row.trade_date<start.compact&&row.close!==null&&Number(row.close)>0).sort((a,b)=>a.trade_date.localeCompare(b.trade_date)).at(-1);
        const saved=[...annualRows,...(prior?[prior]:[])];
        return lockedTransaction(async()=>{
          await assertRun(options);
          if(saved.length) {
            const values=saved.map(row=>[code,normalizeTradeDate(row.trade_date).iso,'HK',...NUMERIC_FIELDS.map(field=>field==='amount'?null:row[field]),SOURCE,API,'none','share',amountUnit,currency]);
            const placeholders=values.map((_,index)=>`(${PRICE_COLUMNS.map((__,column)=>`$${index*PRICE_COLUMNS.length+column+1}`).join(',')})`).join(',');
            await sql(`INSERT INTO market_data.daily_prices (${PRICE_COLUMNS.join(',')}) VALUES ${placeholders}
              ON CONFLICT (ts_code,trade_date) DO UPDATE SET ${PRICE_COLUMNS.slice(2).map(column=>`${column}=EXCLUDED.${column}`).join(',')},fetched_at=now()`,values.flat());
          }
          await sql(`INSERT INTO market_data.hk_market_symbol_ranges (ts_code,source,source_api,range_start,range_end,rows_count,empty_proof)
            VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (ts_code,source,source_api,range_start,range_end)
            DO UPDATE SET rows_count=EXCLUDED.rows_count,empty_proof=EXCLUDED.empty_proof,fetched_at=now()`,
          [code,SOURCE,API,coverStart.iso,coverEnd.iso,annualRows.length,annualRows.length?null:emptyProof]);
          const ranges=await getRanges({ticker:code,startDate:start.compact,endDate:end.compact});
          const complete=missingHkPoolRanges(ranges,start.compact,end.compact).length===0;
          let deleted=0,baselineDate=null;
          if(complete) {
            const baseline=await sql(`SELECT to_char(max(trade_date),'YYYY-MM-DD') AS date FROM market_data.daily_prices
              WHERE market='HK' AND ts_code=$1 AND source=$2 AND source_api=$3 AND trade_date<$4::date AND close>0`,[code,SOURCE,API,start.iso]);
            baselineDate=baseline.rows[0]?.date??null;
            const listDate=options.listDate===undefined||options.listDate===null?null:normalizeTradeDate(options.listDate).iso;
            if(baselineDate || (listDate!==null&&listDate>=start.iso)) {
              const result=await sql(`DELETE FROM market_data.daily_prices WHERE market='HK' AND ts_code=$1 AND source=$2 AND source_api=$3
                AND trade_date<$4::date AND trade_date IS DISTINCT FROM $5::date`,[code,SOURCE,API,start.iso,baselineDate]);
              deleted=result.rowCount;
            }
            await sql(`DELETE FROM market_data.hk_market_symbol_ranges WHERE ts_code=$1 AND source=$2 AND source_api=$3`,[code,SOURCE,API]);
            await sql(`INSERT INTO market_data.hk_market_symbol_ranges (ts_code,source,source_api,range_start,range_end,rows_count)
              SELECT $1,$2,$3,$4::date,$5::date,count(*) FROM market_data.daily_prices WHERE market='HK' AND ts_code=$1 AND source=$2 AND source_api=$3
              AND trade_date BETWEEN $4::date AND $5::date`,[code,SOURCE,API,start.iso,end.iso]);
          }
          const latest=await sql(`SELECT to_char(max(trade_date),'YYYY-MM-DD') AS date,
            count(*) FILTER (WHERE trade_date BETWEEN $4::date AND $5::date)::integer AS "annualRowsCount" FROM market_data.daily_prices
            WHERE market='HK' AND ts_code=$1 AND source=$2 AND source_api=$3 AND close>0`,[code,SOURCE,API,start.iso,end.iso]);
          const lastQuoteDate=latest.rows[0]?.date??null;
          if(complete) await attempt(options,'completed',latest.rows[0]?.annualRowsCount??annualRows.length,lastQuoteDate);
          return {ticker:code,rowsCount:saved.length,annualRows:annualRows.length,complete,deleted,baselineDate,lastQuoteDate};
        });
      },
      async markSymbol(options) {
        if(!['no_data','failed'].includes(options.status)) throw invalid();
        const code=SAFE_CODES.has(options.errorCode)?options.errorCode:options.status==='no_data'?'no_data':'provider_error';
        const date=options.lastQuoteDate===null||options.lastQuoteDate===undefined?null:normalizeTradeDate(options.lastQuoteDate).iso;
        return lockedTransaction(async()=>{await assertRun(options);await attempt(options,options.status,0,date,code);});
      },
      async finishRun(options) {
        if(!['succeeded','partial','failed'].includes(options.status)) throw invalid();
        const data=summaryJson(options.summary??{});
        return lockedTransaction(async()=>{
          const current=await getRun(options,true),{start,end}=runWindow(options);
          if(current?.status!=='running'||current.windowStart!==start.iso||current.windowEnd!==end.iso) throw invalid();
          await sql(`UPDATE market_data.hk_market_update_runs SET status=$3,summary=$4::jsonb,finished_at=now(),updated_at=now()
            WHERE run_date=$1 AND universe_hash=$2 AND status='running'`,[...runKey(options),options.status,data]);
          return {status:options.status};
        });
      },
    };
  }
  return {
    async migrate() {
      const [base,schema]=await Promise.all([readFile(new URL('./schema.sql',import.meta.url),'utf8'),readFile(new URL('./hk-market-schema.sql',import.meta.url),'utf8')]);
      const client=await connect();try{await transaction(client,async()=>{await query(client,base);await query(client,schema);});}finally{client.release();}
    },
    async upsertCatalog(catalog) {
      const normalized=normalizeCatalog(catalog),{rows,source,apiName}=normalized,client=await connect();
      try {await transaction(client,async()=>{
        for(let offset=0;offset<rows.length;offset+=500) {
          const batch=rows.slice(offset,offset+500),values=batch.flatMap(row=>[row.ticker,row.name,row.currency,row.listDate,row.board,row.isin,source,apiName]);
          const placeholders=batch.map((_,index)=>`(${Array.from({length:8},(__,column)=>`$${index*8+column+1}`).join(',')})`).join(',');
          await query(client,`INSERT INTO market_data.hk_listed_universe (ts_code,name,currency,list_date,board,isin,source,source_api) VALUES ${placeholders}
            ON CONFLICT (ts_code) DO UPDATE SET name=EXCLUDED.name,active=true,currency=EXCLUDED.currency,list_date=EXCLUDED.list_date,
            board=EXCLUDED.board,isin=EXCLUDED.isin,source=EXCLUDED.source,source_api=EXCLUDED.source_api,updated_at=now()`,values);
          const securityValues=batch.flatMap(row=>[row.ticker,row.name,row.listDate,source]);
          const securityPlaceholders=batch.map((_,index)=>`($${index*4+1},$${index*4+2},'HK',$${index*4+3},'L',$${index*4+4})`).join(',');
          await query(client,`INSERT INTO market_data.securities (ts_code,name,market,list_date,list_status,source) VALUES ${securityPlaceholders}
            ON CONFLICT (ts_code) DO UPDATE SET name=EXCLUDED.name,market='HK',list_date=COALESCE(EXCLUDED.list_date,market_data.securities.list_date),
            list_status='L',delist_date=NULL,source=EXCLUDED.source,fetched_at=now()`,securityValues);
        }
        await query(client,`UPDATE market_data.hk_listed_universe SET active=false,updated_at=now() WHERE active=true AND NOT (ts_code=ANY($1::text[]))`,[rows.map(row=>row.ticker)]);
      });return {rowsCount:rows.length,universeHash:normalized.universeHash};} finally {client.release();}
    },
    async withLock(operation) {
      if(typeof operation!=='function') throw invalid();
      const client=await connect();let active=true,locked=false,sessionError,discard,operationError;
      const onError=()=>{sessionError??=dbError();active=false;discard=sessionError;};client.on?.('error',onError);
      const isActive=()=>{if(sessionError) throw sessionError;return active;};
      try {
        const result=await query(client,'SELECT pg_try_advisory_lock($1,$2) AS locked',HK_MARKET_LOCK_KEYS);isActive();
        locked=result.rows[0]?.locked===true;if(!locked) return {status:'busy'};
        const value=await operation(scopeFor(client,isActive));isActive();return value;
      }catch(error){operationError=error;if(error?.code==='DATABASE_ERROR')discard=error;throw error;}
      finally {
        active=false;
        if(locked&&!sessionError)try{const result=await query(client,'SELECT pg_advisory_unlock($1,$2) AS unlocked',HK_MARKET_LOCK_KEYS);if(result.rows[0]?.unlocked!==true)throw dbError();}catch(error){discard=error;}
        try{client.release(discard);}finally{client.off?.('error',onError);}
        if(discard&&!operationError)throw discard;
      }
    },
    async close(){try{await pool.end();}catch(error){throw dbError(error);}},
  };
}
