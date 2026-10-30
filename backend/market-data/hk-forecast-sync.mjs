import { replaceFile } from '../src/replace-file.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { todayShanghai } from '../src/input.mjs';
import { loadHongKongUniverse, validateHongKongUniverse } from './hk-pool-universe.mjs';
import { HK_FORECAST_SOURCE, hkForecastWindow, validateHkForecastRows, validateHkForecastCoverage } from './hk-forecast-store.mjs';
import { createEtnetHkForecastClient } from './etnet-hk-forecast-client.mjs';
import { loadHkListedCatalog, syncHkListedCatalog } from './hk-listed-catalog.mjs';
import { normalizeTradeDate } from './postgres-store.mjs';

function invalid() { const error=new Error('港股预测同步参数、日期或缓存无效。'); error.kind='validation'; return error; }
function safeCode(error) {
  if (error?.code === 'VALIDATION_ERROR') return 'validation_error';
  if (error?.code === 'DATABASE_ERROR') return 'database_error';
  return {network:'network_error',timeout:'network_error',rate_limit:'rate_limited',permission:'permission_denied',http:'permission_denied',database:'database_error',validation:'validation_error',invalid_response:'validation_error',incomplete_window:'incomplete_window',observation_date_changed:'observation_date_changed'}[error?.kind]??'provider_error';
}
async function quarantine(path) {
  try { await replaceFile(path,`${path}.rejected-${randomUUID()}`); } catch(error) { if(error.code!=='ENOENT')throw error; }
}
function validatePayload(value,identity) {
  if(value?.source!==identity.source || value?.apiName!==identity.apiName)throw invalid();
  const rows=validateHkForecastRows(value.rows,identity);
  validateHkForecastCoverage(value.coverage,value.rows.length);
  return rows;
}
async function cachedOrCollect({path,identity,collector,now,strictObservationDate=false}) {
  let cached;
  try { cached=JSON.parse(gunzipSync(await readFile(path)).toString('utf8')); }
  catch(error) { if(error.code!=='ENOENT')await quarantine(path); }
  if(cached) {
    try {
      if(cached.version!==1 || Object.entries(identity).some(([key,value])=>cached[key]!==value))throw invalid();
      if(strictObservationDate&&(!Number.isFinite(Date.parse(cached.fetchedAt))||todayShanghai(new Date(cached.fetchedAt))!==identity.snapshotDate))throw invalid();
      validatePayload(cached,identity); return {...cached,cached:true};
    } catch { await quarantine(path); }
  }
  const value=await collector(identity); validatePayload(value,identity);
  const payload={version:1,...identity,rows:value.rows,coverage:value.coverage,raw:value.raw??null,fetchedAt:now().toISOString()};
  const temporary=`${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary,gzipSync(Buffer.from(JSON.stringify(payload)+'\n')),{mode:0o600}); await replaceFile(temporary,path);
  return {...payload,cached:false};
}

function validateCatalog(catalog,runDate) {
  if(catalog?.version!==1||catalog.complete!==true||catalog.source!=='hkex_tushare'||catalog.apiName!=='hkex_listed_equities'
    ||catalog.asOf!==runDate||catalog.audit?.pendingRecords!==0||!Array.isArray(catalog.securities)||!catalog.securities.length
    ||catalog.securities.length>10000||catalog.audit?.confirmedRecords!==catalog.securities.length
    ||!Array.isArray(catalog.audit?.tushareOnly)||catalog.audit.tushareOnly.some(row=>row.reason==='absent_from_hkex'))throw invalid();
  for(const row of catalog.securities)if(!/^\d{5}\.HK$/.test(row.ticker)||!row.name||!['main','gem'].includes(row.board)
    ||!['HKD','USD'].includes(row.currency)||!row.listDate||normalizeTradeDate(row.listDate).iso>runDate)throw invalid();
  const tickers=catalog.securities.map(row=>row.ticker).sort();
  if(new Set(tickers).size!==tickers.length||catalog.universeHash!==createHash('sha256').update(tickers.join('\n')).digest('hex'))throw invalid();
  normalizeTradeDate(catalog.sourceDate);
  return {tickers,universeHash:catalog.universeHash};
}

async function marketUniverse({catalog,catalogPath,catalogSync,client,cacheDir,runDate,log}) {
  if(!catalog) {
    try {catalog=await loadHkListedCatalog(catalogPath??join(cacheDir,'hk-market','catalog',`snapshot-${runDate}.json`));}
    catch(error) {if(catalogPath||error.code!=='ENOENT')throw error;catalog=await catalogSync({client,cacheDir,asOf:runDate,log});}
  }
  return validateCatalog(catalog,runDate);
}

/** Archive current broker snapshots from the first actual collection onward.
 * Source update dates cannot be used to backdate observations of today's page. */
export async function updateRollingHkForecasts({store,cacheDir,runDate,universe,universePath,collector,scope:forecastScope='pool',
  catalog,catalogPath,catalogSync=syncHkListedCatalog,client,concurrency=1,now=()=>new Date(),log=()=>{}}={}) {
  let window;
  const summary={plannedTickers:0,completedTickers:0,skippedTickers:0,downloadedTickers:0,cachedTickers:0,emptyTickers:0,noDataTickers:0,failedTickers:0,rows:0,deleted:0,tickers:[]};
  const emit=value=>{try{log(value);}catch{}};
  const clock=()=>typeof now==='function'?now():now;
  const report=(status,extra={})=>({status,...window,...HK_FORECAST_SOURCE,forecastScope,...extra});
  const assertObservationDay=()=>{if(window.runDate!==todayShanghai(clock())){const error=invalid();error.kind='observation_date_changed';throw error;}};
  try {
    window=hkForecastWindow(runDate);
    if(window.runDate!==todayShanghai(clock()) || typeof store?.migrate!=='function'
      ||typeof store?.withLock!=='function'||typeof cacheDir!=='string'||!cacheDir.trim()||!['pool','all'].includes(forecastScope)
      ||!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw invalid();
    const pool=forecastScope==='all'?await marketUniverse({catalog,catalogPath,catalogSync,client,cacheDir,runDate:window.runDate,log:emit})
      :universe?validateHongKongUniverse(universe):await loadHongKongUniverse(universePath);
    const run={...window,scope:forecastScope,universeHash:pool.universeHash,tickers:pool.tickers}; summary.plannedTickers=pool.tickers.length;
    // One client owns the global request-start budget, including its retries.
    const forecastClient=collector?null:createEtnetHkForecastClient({concurrency}),collect=collector??(options=>forecastClient.collect(options));
    await store.migrate();
    const result=await store.withLock(async rawScope=>{
      // The advisory lock belongs to one pg client. Serialize whole store
      // methods so worker transactions cannot interleave on that connection.
      let databaseQueue=Promise.resolve();
      const scope=Object.fromEntries(Object.entries(rawScope).map(([name,method])=>[name,(...args)=>{
        const pending=databaseQueue.then(()=>method(...args));databaseQueue=pending.catch(()=>{});return pending;
      }]));
      let began=false;
      try {
        const previous=await scope.getRun(run);
        if(previous?.status==='succeeded') {
          let complete=true;
          for(const ticker of pool.tickers)if(!await scope.symbolComplete({...run,ticker})){complete=false;break;}
          if(complete)return report('already_completed',{summary:previous.summary});
        }
        await scope.beginRun(run); began=true;
        let nextTicker=0,fatal=null,firstFailure=null;
        const worker=async()=>{while(!fatal&&nextTicker<pool.tickers.length) {
          const ticker=pool.tickers[nextTicker++],detail={ticker,status:'running'};
          if(forecastScope==='pool')summary.tickers.push(detail);
          let path;
          try {
            assertObservationDay();
            const checkpoint=forecastScope==='all'&&scope.getSymbolCheckpoint?await scope.getSymbolCheckpoint({...run,ticker}):null;
            if(checkpoint||await scope.symbolComplete({...run,ticker})) {
              if(forecastScope==='all'&&scope.confirmSymbol)await scope.confirmSymbol({...run,ticker});
              detail.status='skipped';summary.skippedTickers++;summary.completedTickers++;
              if(checkpoint){summary.rows+=checkpoint.rowsCount;if(!checkpoint.rowsCount){summary.emptyTickers++;summary.noDataTickers++;}}
              continue;
            }
            if(forecastScope==='all')await scope.markSymbol({...run,ticker,status:'running'});
            const identity={...(forecastScope==='pool'?{universeHash:pool.universeHash}:{}),...HK_FORECAST_SOURCE,ticker,snapshotDate:window.runDate,startDate:window.windowStart,endDate:window.windowEnd};
            const directory=join(cacheDir,'HK-forecasts',forecastScope==='all'?'all':pool.universeHash,window.runDate); await mkdir(directory,{recursive:true,mode:0o700});
            path=join(directory,`${ticker}.json.gz`);
            const data=await cachedOrCollect({path,identity,collector:collect,now:clock,strictObservationDate:forecastScope==='all'});
            assertObservationDay();
            const saved=await scope.saveSymbol({...run,ticker,rows:data.rows,coverage:data.coverage});
            Object.assign(detail,{status:saved.rowsCount?'completed':'no_data',...saved,sourceRows:data.coverage.sourceRows});
            summary.rows+=saved.rowsCount;summary.deleted+=saved.deleted??0;summary.completedTickers++;if(!saved.rowsCount){summary.emptyTickers++;summary.noDataTickers++;}
            if(data.cached)summary.cachedTickers++; else summary.downloadedTickers++;
            emit({type:'hk_forecast_ticker_completed',...detail,completedTickers:summary.completedTickers,plannedTickers:summary.plannedTickers});
          } catch(error) {
            detail.status='failed'; detail.errorCode=safeCode(error);
            firstFailure??=detail.errorCode;summary.failedTickers++;
            if(['rate_limited','permission_denied','database_error','observation_date_changed'].includes(detail.errorCode))fatal=detail.errorCode;
            if(path && ['validation_error','incomplete_window'].includes(detail.errorCode))await quarantine(path);
            if(forecastScope==='all'&&detail.errorCode!=='database_error')await scope.markSymbol({...run,ticker,status:'failed',errorCode:detail.errorCode});
            emit({type:'hk_forecast_ticker_failed',ticker,errorCode:detail.errorCode});
          }
        }};
        const workers=await Promise.allSettled(Array.from({length:concurrency},()=>worker()));
        const rejected=workers.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
        if(firstFailure || summary.completedTickers!==summary.plannedTickers) {
          const errorCode=fatal??firstFailure??'incomplete_window'; await scope.failRun({...run,summary,errorCode,partial:summary.completedTickers>0});
          return report(summary.completedTickers?'partial':'failed',{errorCode,summary});
        }
        const saved=await scope.finalize({...run,summary});
        return report('succeeded',{summary:{...summary,deleted:summary.deleted+(saved.deleted??0)}});
      } catch(error) {
        let errorCode=safeCode(error);
        if(began)try{await scope.failRun({...run,summary,errorCode,partial:summary.completedTickers>0});}catch{errorCode='database_error';}
        return report(summary.completedTickers?'partial':'failed',{errorCode,summary});
      }
    });
    const final=result?.status==='busy'?report('busy',{summary}):result;
    emit({type:'hk_forecast_update_result',...final}); return final;
  } catch(error) {
    const final=report('failed',{errorCode:safeCode(error),summary});emit({type:'hk_forecast_update_result',...final});return final;
  }
}
