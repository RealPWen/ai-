import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { rollingWindowForDate } from './rolling-update.mjs';
import { loadHongKongUniverse, validateHongKongUniverse } from './hk-pool-universe.mjs';
import { HK_VALUATION_SOURCE, validateHkValuationRows } from './hk-valuation-store.mjs';
import { createBaiduHkValuationClient } from './baidu-hk-valuation-client.mjs';
import { loadHkListedCatalog, syncHkListedCatalog } from './hk-listed-catalog.mjs';
import { normalizeTradeDate } from './postgres-store.mjs';

function invalid(){const error=new Error('港股估值同步参数或缓存无效。');error.kind='validation';return error;}
function safeCode(error){return {network:'network_error',timeout:'network_error',rate_limit:'rate_limited',permission:'permission_denied',http:'permission_denied',database:'database_error',validation:'validation_error',invalid_response:'validation_error',incomplete_window:'incomplete_window',no_data:'no_data'}[error?.kind]??'provider_error';}
async function quarantine(path) {
  try { await rename(path, `${path}.rejected-${randomUUID()}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function validatePayload(value,identity,all){
  if(value?.source!==identity.source||value?.apiName!==identity.apiName)throw invalid();
  validateHkValuationRows(value.rows,{...identity,allowEmpty:all});
  if(all){
    const coverage=value.coverage,status=coverage?.metricStatus;
    if(!coverage||!['available','partial_metrics','no_data'].includes(coverage.kind)
      ||!status||!['available','no_data'].includes(status.pe_ttm)||!['available','no_data'].includes(status.pb))throw invalid();
    if(!value.rows.length){
      if(coverage.kind!=='no_data'||status.pe_ttm!=='no_data'||status.pb!=='no_data'
        ||coverage.noDataEvidence!=='both_metric_charts_explicitly_empty_in_requested_window')throw invalid();
    }else{
      if(coverage.kind==='no_data')throw invalid();
      for(const metric of ['pe_ttm','pb'])if(status[metric]==='no_data'&&value.rows.some(row=>row[metric]!==null))throw invalid();
    }
  }
}
async function cachedOrCollect({path,identity,collector,all,retryNoData}){
  let cached;
  try{cached=JSON.parse(gunzipSync(await readFile(path)).toString('utf8'));}catch(error){if(error.code!=='ENOENT')await quarantine(path);}
  if(cached){
    try {
      if(cached.version!==1||Object.entries(identity).some(([key,value])=>cached[key]!==value))throw invalid();
      validatePayload(cached,identity,all);if(!retryNoData||cached.rows.length)return {...cached,cached:true};
    } catch { await quarantine(path); }
  }
  const result=await collector(identity);
  validatePayload(result,identity,all);
  const value={version:1,...identity,rows:result.rows,coverage:result.coverage??null,raw:result.raw??null,fetchedAt:new Date().toISOString()};
  const temp=`${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp,gzipSync(Buffer.from(JSON.stringify(value)+'\n')),{mode:0o600});await rename(temp,path);
  return {...value,cached:false};
}
function validateCatalog(catalog,runDate){
  if(catalog?.version!==1||catalog.complete!==true||catalog.source!=='hkex_tushare'||catalog.apiName!=='hkex_listed_equities'
    ||catalog.asOf!==runDate||catalog.audit?.pendingRecords!==0||!Array.isArray(catalog.securities)||!catalog.securities.length
    ||catalog.securities.length>10000||catalog.audit?.confirmedRecords!==catalog.securities.length
    ||!Array.isArray(catalog.audit?.tushareOnly)||catalog.audit.tushareOnly.some(row=>row.reason==='absent_from_hkex'))throw invalid();
  for(const row of catalog.securities)if(!/^\d{5}\.HK$/.test(row.ticker)||!row.name||!['main','gem'].includes(row.board)
    ||!['HKD','USD'].includes(row.currency)||!row.listDate||normalizeTradeDate(row.listDate).iso>runDate)throw invalid();
  const tickers=catalog.securities.map(row=>row.ticker).sort();
  if(new Set(tickers).size!==tickers.length||catalog.universeHash!==createHash('sha256').update(tickers.join('\n')).digest('hex'))throw invalid();
  normalizeTradeDate(catalog.sourceDate);return {tickers,universeHash:catalog.universeHash};
}
async function marketUniverse({catalog,catalogPath,catalogSync,client,cacheDir,runDate,log}){
  if(!catalog){
    try{catalog=await loadHkListedCatalog(catalogPath??join(cacheDir,'hk-market','catalog',`snapshot-${runDate}.json`));}
    catch(error){if(catalogPath||error.code!=='ENOENT')throw error;catalog=await catalogSync({client,cacheDir,asOf:runDate,log});}
  }
  return validateCatalog(catalog,runDate);
}

/** Independently locked HK valuations; completed symbols are resumable. Pruning
 * is authorized only after every pool symbol covers its actual stored price dates. */
export async function updateRollingHkValuations({store,cacheDir,runDate,universe,universePath,collector,scope:valuationScope='pool',
  catalog,catalogPath,catalogSync=syncHkListedCatalog,client,concurrency=1,retryNoData=false,log=()=>{}}={}){
  let window;
  const summary={plannedTickers:0,completedTickers:0,skippedTickers:0,downloadedTickers:0,cachedTickers:0,noDataTickers:0,noPriceTickers:0,failedTickers:0,rows:0,deleted:0,tickers:[]};
  const emit=value=>{try{log(value);}catch{}};
  const report=(status,extra={})=>({status,...window,...HK_VALUATION_SOURCE,valuationScope,...extra});
  try{
    window=rollingWindowForDate(runDate);
    if(typeof store?.migrate!=='function'||typeof store?.withLock!=='function'||typeof cacheDir!=='string'||!cacheDir.trim()
      ||!['pool','all'].includes(valuationScope)||!Number.isInteger(concurrency)||concurrency<1||concurrency>3||typeof retryNoData!=='boolean')throw invalid();
    const pool=valuationScope==='all'?await marketUniverse({catalog,catalogPath,catalogSync,client,cacheDir,runDate:window.runDate,log:emit})
      :universe?validateHongKongUniverse(universe):await loadHongKongUniverse(universePath);
    const run={...window,scope:valuationScope,universeHash:pool.universeHash,tickers:pool.tickers};summary.plannedTickers=pool.tickers.length;
    const sourceClient=collector?null:createBaiduHkValuationClient({concurrency});
    const collect=collector??(options=>sourceClient.collect(options));
    await store.migrate();
    const result=await store.withLock(async rawScope=>{
      let databaseQueue=Promise.resolve();
      const scope=Object.fromEntries(Object.entries(rawScope).map(([name,method])=>[name,(...args)=>{
        const pending=databaseQueue.then(()=>method(...args));databaseQueue=pending.catch(()=>{});return pending;
      }]));
      let began=false;
      try{
        const previous=await scope.getRun(run);
        if(previous?.status==='succeeded'){
          let complete=true;
          for(const ticker of pool.tickers)if(!await scope.symbolComplete({...run,ticker})){complete=false;break;}
          if(complete)return report('already_completed',{summary:previous.summary});
        }
        await scope.beginRun(run);began=true;
        let nextTicker=0,fatal=null,firstFailure=null;
        const worker=async()=>{while(!fatal&&nextTicker<pool.tickers.length){
          const ticker=pool.tickers[nextTicker++],detail={ticker,status:'running'};
          if(valuationScope==='pool')summary.tickers.push(detail);
          let cachePath,currentPriceDatesHash;
          try{
            const checkpoint=valuationScope==='all'&&scope.getSymbolCheckpoint?await scope.getSymbolCheckpoint({...run,ticker}):null;
            if(checkpoint||await scope.symbolComplete({...run,ticker})){
              if(valuationScope==='all'&&scope.confirmSymbol)await scope.confirmSymbol({...run,ticker});
              detail.status='skipped';summary.skippedTickers++;summary.completedTickers++;if(checkpoint)summary.rows+=checkpoint.rowsCount;continue;
            }
            if(valuationScope==='all'){
              const dates=await scope.priceDates({...run,ticker}),attempt=await scope.getSymbolAttempt({...run,ticker});
              currentPriceDatesHash=createHash('sha256').update([...dates].sort().join('\n')).digest('hex');
              if(!dates.length){
                if(attempt?.status==='no_price_data')summary.skippedTickers++;
                else await scope.markSymbol({...run,ticker,status:'no_price_data',coverage:{kind:'no_price_data',expectedPriceRows:0}});
                summary.noPriceTickers++;emit({type:'hk_valuation_ticker_no_price_data',ticker,...summary});continue;
              }
              if(!retryNoData&&attempt?.status==='no_data'&&attempt.expectedCount===dates.length&&attempt.coverage?.priceDatesHash===currentPriceDatesHash){summary.noDataTickers++;summary.skippedTickers++;continue;}
              await scope.markSymbol({...run,ticker,status:'running'});
            }
            const identity={...(valuationScope==='pool'?{universeHash:pool.universeHash}:{}),...HK_VALUATION_SOURCE,ticker,startDate:window.windowStart,endDate:window.windowEnd,
              ...(valuationScope==='all'?{allowPartialMetrics:true,allowEmpty:true}:{})};
            if(valuationScope==='all')identity.priceDatesHash=currentPriceDatesHash;
            const dir=join(cacheDir,'HK-valuations',valuationScope==='all'?'all':pool.universeHash,window.runDate);
            await mkdir(dir,{recursive:true,mode:0o700});
            cachePath = join(dir,`${ticker}.json.gz`);
            const data=await cachedOrCollect({path:cachePath,identity,collector:collect,all:valuationScope==='all',retryNoData});
            if(data.cached)summary.cachedTickers++;else summary.downloadedTickers++;
            const coverage={...(data.coverage??{}),...(data.raw?.metricDateCoverage?{metricDateCoverage:data.raw.metricDateCoverage}:{})};
            if(valuationScope==='all'&&!data.rows.length){
              await scope.markSymbol({...run,ticker,status:'no_data',noDataEvidence:data.coverage.noDataEvidence,coverage});
              summary.noDataTickers++;emit({type:'hk_valuation_ticker_no_data',ticker,...summary});continue;
            }
            const saved=await scope.saveSymbol({...run,ticker,rows:data.rows,coverage});
            Object.assign(detail,{status:'completed',...saved});summary.rows+=saved.rowsCount;summary.deleted+=saved.deleted??0;summary.completedTickers++;
            emit({type:'hk_valuation_ticker_completed',...detail,completedTickers:summary.completedTickers,plannedTickers:summary.plannedTickers});
          }catch(error){
            detail.status='failed';detail.errorCode=safeCode(error);
            summary.failedTickers++;firstFailure??=detail.errorCode;
            if(['rate_limited','permission_denied','database_error'].includes(detail.errorCode))fatal=detail.errorCode;
            if (cachePath && ['incomplete_window','validation_error'].includes(detail.errorCode)) await quarantine(cachePath);
            // Stale/partial payloads may be retried later; successful source
            // payloads survive a database failure without another network call.
            if(valuationScope==='all'&&detail.errorCode!=='database_error')await scope.markSymbol({...run,ticker,status:'failed',errorCode:detail.errorCode});
            emit({type:'hk_valuation_ticker_failed',ticker,errorCode:detail.errorCode,...summary});
          }
        }};
        const workers=await Promise.allSettled(Array.from({length:concurrency},()=>worker()));
        const rejected=workers.find(value=>value.status==='rejected');if(rejected)throw rejected.reason;
        if(firstFailure||summary.completedTickers!==summary.plannedTickers){
          const errorCode=fatal??firstFailure??(summary.noDataTickers?'no_data':summary.noPriceTickers?'no_price_data':'incomplete_window');
          const partial=summary.completedTickers+summary.noDataTickers+summary.noPriceTickers>0;
          await scope.failRun({...run,summary,errorCode,partial});
          return report(partial?'partial':'failed',{errorCode,summary});
        }
        const saved=await scope.finalize({...run,summary});
        return report('succeeded',{summary:{...summary,deleted:summary.deleted+(saved.deleted??0)}});
      }catch(error){
        const errorCode=safeCode(error);if(began)try{await scope.failRun({...run,summary,errorCode,partial:summary.completedTickers>0});}catch{}
        return report(summary.completedTickers?'partial':'failed',{errorCode,summary});
      }
    });
    const final=result?.status==='busy'?report('busy',{summary}):result;
    emit({type:'hk_valuation_update_result',...final});return final;
  }catch(error){const final=report('failed',{errorCode:safeCode(error),summary});emit({type:'hk_valuation_update_result',...final});return final;}
}
