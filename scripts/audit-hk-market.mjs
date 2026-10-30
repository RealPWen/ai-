import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { todayShanghai } from '../backend/src/input.mjs';
import { normalizeTradeDate } from '../backend/market-data/postgres-store.mjs';
import { rollingWindowForDate } from '../backend/market-data/rolling-update.mjs';
import { missingHkPoolRanges } from '../backend/market-data/hk-pool-store.mjs';
import { loadHongKongUniverse } from '../backend/market-data/hk-pool-universe.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const SOURCE='tencent',API='tencent_hk_daily';
const count=value=>Number(value??0);
const hash=tickers=>createHash('sha256').update([...tickers].sort().join('\n')).digest('hex');
const invalid=()=>Object.assign(new Error('港股数据库审计配置或目录无效。'),{code:'AUDIT_CONFIGURATION_ERROR'});
function weekendRange(startDate,endDate) {
  for(let date=Date.parse(startDate);date<=Date.parse(endDate);date+=86400000) if(![0,6].includes(new Date(date).getUTCDay())) return false;
  return true;
}

/** Read-only, repeatable-read database snapshot; the JSON audit is the only write. */
export async function auditHkMarket({connectionString,runDate=todayShanghai(),catalogPath,outputPath}={}) {
  if(typeof connectionString!=='string'||!connectionString.trim()) throw invalid();
  const window=rollingWindowForDate(runDate),start=normalizeTradeDate(window.windowStart).iso,end=normalizeTradeDate(window.windowEnd).iso;
  const selectedCatalog=resolve(catalogPath??join(root,'backend/storage/market-data/hk-market/catalog',`snapshot-${window.runDate}.json`));
  const catalog=JSON.parse(await readFile(selectedCatalog,'utf8'));
  if(catalog?.complete!==true||catalog.asOf!==window.runDate||!Array.isArray(catalog.securities)||!catalog.securities.length
    ||catalog.securities.some(row=>!/^\d{5}\.HK$/.test(row?.ticker)||!['HKD','USD'].includes(row.currency))) throw invalid();
  const catalogTickers=catalog.securities.map(row=>row.ticker);
  if(new Set(catalogTickers).size!==catalogTickers.length||hash(catalogTickers)!==catalog.universeHash) throw invalid();
  const researchPool=await loadHongKongUniverse();
  const pool=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:10000,query_timeout:120000});
  pool.on('error',()=>{});
  const client=await pool.connect();
  let report;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot=await client.query('SELECT transaction_timestamp()::text AS snapshot');
    const active=(await client.query(`SELECT ts_code AS ticker,name,currency,to_char(list_date,'YYYY-MM-DD') AS "listDate",source,source_api AS "sourceApi"
      FROM market_data.hk_listed_universe WHERE active ORDER BY ts_code`)).rows;
    const run=(await client.query(`SELECT status,summary,to_char(started_at,'YYYY-MM-DD HH24:MI:SSOF') AS "startedAt",
      to_char(finished_at,'YYYY-MM-DD HH24:MI:SSOF') AS "finishedAt"
      FROM market_data.hk_market_update_runs WHERE run_date=$1 AND universe_hash=$2`,[window.runDate,catalog.universeHash])).rows[0]??null;
    const priceRows=(await client.query(`SELECT p.ts_code AS ticker,count(*)::integer AS "totalRows",
      count(*) FILTER (WHERE trade_date BETWEEN $1::date AND $2::date)::integer AS "annualRows",
      count(*) FILTER (WHERE trade_date BETWEEN $1::date AND $2::date AND p.source=$3 AND p.source_api=$4)::integer AS "sourceAnnualRows",
      count(*) FILTER (WHERE trade_date<$1::date)::integer AS "priorRows",
      to_char(max(trade_date) FILTER (WHERE trade_date<$1::date AND close>0 AND p.source=$3 AND p.source_api=$4),'YYYY-MM-DD') AS "baselineDate",
      to_char(min(trade_date),'YYYY-MM-DD') AS "firstDate",to_char(max(trade_date),'YYYY-MM-DD') AS "lastDate",
      to_char(min(trade_date) FILTER (WHERE trade_date BETWEEN $1::date AND $2::date),'YYYY-MM-DD') AS "firstAnnualDate",
      to_char(max(trade_date) FILTER (WHERE trade_date BETWEEN $1::date AND $2::date),'YYYY-MM-DD') AS "lastAnnualDate",
      count(*) FILTER (WHERE p.source<>$3 OR p.source_api<>$4)::integer AS "sourceErrors",
      count(*) FILTER (WHERE c.currency IS NOT NULL AND p.currency<>c.currency)::integer AS "currencyErrors",
      count(*) FILTER (WHERE amount IS NOT NULL)::integer AS "amountNotNullErrors",
      count(*) FILTER (WHERE adjustment<>'none')::integer AS "adjustmentErrors",
      count(*) FILTER (WHERE volume_unit<>'share' OR (p.currency='HKD' AND amount_unit<>'hkd')
        OR (p.currency='USD' AND amount_unit<>'usd') OR p.currency NOT IN ('HKD','USD'))::integer AS "unitErrors",
      count(*) FILTER (WHERE trade_date>$2::date)::integer AS "futureRows",
      array_agg(DISTINCT p.currency ORDER BY p.currency) AS currencies,
      jsonb_agg(DISTINCT jsonb_build_object('source',p.source,'apiName',p.source_api)) AS sources
      FROM market_data.daily_prices p LEFT JOIN market_data.hk_listed_universe c ON c.ts_code=p.ts_code AND c.active
      WHERE p.market='HK' GROUP BY p.ts_code ORDER BY p.ts_code`,[start,end,SOURCE,API])).rows;
    const ranges=(await client.query(`SELECT coverage.ts_code AS ticker,coverage.source,coverage.source_api AS "apiName",
      to_char(range_start,'YYYY-MM-DD') AS "startDate",to_char(range_end,'YYYY-MM-DD') AS "endDate",
      rows_count AS "rowsCount",empty_proof AS "emptyProof",actual."actualRows",actual."matchingUnitRows"
      FROM market_data.hk_market_symbol_ranges coverage
      JOIN market_data.hk_listed_universe c ON c.ts_code=coverage.ts_code AND c.active
      CROSS JOIN LATERAL (SELECT count(*)::integer AS "actualRows",
        count(*) FILTER (WHERE p.currency=c.currency AND p.volume_unit='share' AND p.adjustment='none'
          AND p.amount_unit=CASE WHEN c.currency='USD' THEN 'usd' ELSE 'hkd' END)::integer AS "matchingUnitRows"
        FROM market_data.daily_prices p WHERE p.market='HK' AND p.ts_code=coverage.ts_code
        AND p.source=coverage.source AND p.source_api=coverage.source_api
        AND p.trade_date BETWEEN coverage.range_start AND coverage.range_end) actual
      WHERE range_start<=$2::date AND range_end>=$1::date ORDER BY coverage.ts_code,range_start,range_end`,[start,end])).rows;
    const attempts=(await client.query(`SELECT ts_code AS ticker,universe_hash AS "universeHash",status,rows_count AS "rowsCount",
      error_code AS "errorCode",to_char(last_quote_date,'YYYY-MM-DD') AS "lastQuoteDate",updated_at::text AS "updatedAt"
      FROM market_data.hk_market_symbol_attempts WHERE run_date=$1`,[window.runDate])).rows;
    const duplicates=(await client.query(`SELECT ts_code AS ticker,trade_date::text AS date,count(*)::integer AS count FROM market_data.daily_prices
      WHERE market='HK' GROUP BY ts_code,trade_date HAVING count(*)>1`)).rows;
    const aShares=(await client.query(`SELECT count(*)::integer AS rows,count(DISTINCT ts_code)::integer AS stocks,
      to_char(min(trade_date),'YYYY-MM-DD') AS "firstDate",to_char(max(trade_date),'YYYY-MM-DD') AS "lastDate"
      FROM market_data.daily_prices WHERE market='A'`)).rows[0];
    const valuation=(await client.query(`SELECT count(*)::integer AS rows,count(DISTINCT ts_code)::integer AS stocks,
      count(*) FILTER (WHERE NOT (ts_code=ANY($1::text[])))::integer AS "outsidePoolRows",
      coalesce(array_agg(DISTINCT ts_code) FILTER (WHERE NOT (ts_code=ANY($1::text[]))),'{}'::text[]) AS "outsidePoolTickers"
      FROM market_data.hk_daily_valuations`,[researchPool.tickers])).rows[0];
    const forecasts=(await client.query(`SELECT count(*)::integer AS rows,count(DISTINCT ts_code)::integer AS stocks,
      count(*) FILTER (WHERE NOT (ts_code=ANY($1::text[])))::integer AS "outsidePoolRows",
      coalesce(array_agg(DISTINCT ts_code) FILTER (WHERE NOT (ts_code=ANY($1::text[]))),'{}'::text[]) AS "outsidePoolTickers"
      FROM market_data.hk_sell_side_forecasts`,[researchPool.tickers])).rows[0];
    await client.query('COMMIT');
    const activeSet=new Set(active.map(row=>row.ticker)),catalogSet=new Set(catalogTickers),catalogMap=new Map(catalog.securities.map(row=>[row.ticker,row]));
    const priceMap=new Map(priceRows.map(row=>[row.ticker,row])),attemptMap=new Map(attempts.map(row=>[row.ticker,row]));
    const rangeMap=new Map();
    for(const row of ranges) {
      const reasons=[];
      if(row.source!==SOURCE||row.apiName!==API) reasons.push('unexpected_source');
      if(row.rowsCount!==row.actualRows) reasons.push('actual_source_count_mismatch');
      if(row.actualRows!==row.matchingUnitRows) reasons.push('currency_or_unit_mismatch');
      if(row.rowsCount===0&&(!['weekends','hk_tradecal'].includes(row.emptyProof)
        ||(row.emptyProof==='weekends'&&!weekendRange(row.startDate,row.endDate)))) reasons.push('invalid_empty_proof');
      const list=rangeMap.get(row.ticker)??[];list.push({...row,verified:reasons.length===0,errors:reasons});rangeMap.set(row.ticker,list);
    }
    const securities=active.map(security=>{
      const stored=priceMap.get(security.ticker)??{totalRows:0,annualRows:0,sourceAnnualRows:0,priorRows:0,baselineDate:null,firstDate:null,lastDate:null,
        firstAnnualDate:null,lastAnnualDate:null,sourceErrors:0,currencyErrors:0,amountNotNullErrors:0,adjustmentErrors:0,unitErrors:0,futureRows:0,currencies:[],sources:[]};
      const coverage=rangeMap.get(security.ticker)??[],verifiedRanges=coverage.filter(row=>row.verified);
      const missingRanges=missingHkPoolRanges(verifiedRanges,start,end),coverageComplete=missingRanges.length===0&&stored.sourceAnnualRows>0;
      const rawAttempt=attemptMap.get(security.ticker)??null,attempt=rawAttempt?.universeHash===catalog.universeHash?rawAttempt:null;
      // A later rolling run compacts the ledger to its newer window. A
      // historical audit may still find stored prices while the old query
      // interval is no longer provable; that is not a provider failure.
      const status=coverageComplete?'covered':attempt?.status==='no_data'?'no_data':attempt?.status==='failed'?'failed'
        :stored.sourceAnnualRows>0||attempt?.status==='completed'?'coverage_unverified':'not_attempted';
      const baselineRows=stored.baselineDate?1:0,excessOlderRows=Math.max(0,stored.priorRows-baselineRows);
      const retentionEligible=coverageComplete&&(stored.baselineDate!==null||(security.listDate!==null&&security.listDate>=start));
      const attemptCountError=attempt?.status==='completed'&&attempt.rowsCount!==stored.sourceAnnualRows;
      return {...security,...stored,status,coverageComplete,missingRanges,baselineRows,excessOlderRows,retentionEligible,
        unexpectedOlderRows:retentionEligible?excessOlderRows:0,attempt,previousUniverseAttempt:rawAttempt&&!attempt?rawAttempt:null,
        attemptCountError:Boolean(attemptCountError),needsCurrentAttempt:coverageComplete&&attempt?.status!=='completed',
        catalogCurrencyMismatch:catalogMap.get(security.ticker)?.currency!==security.currency,coverage};
    });
    const sum=key=>securities.reduce((total,row)=>total+count(row[key]),0);
    const catalogDifferences={activeAbsentFromCatalog:active.filter(row=>!catalogSet.has(row.ticker)).map(row=>row.ticker),
      catalogAbsentFromActive:catalogTickers.filter(ticker=>!activeSet.has(ticker)),currencyMismatches:securities.filter(row=>row.catalogCurrencyMismatch).map(row=>row.ticker)};
    const integrity={sourceErrors:sum('sourceErrors'),currencyErrors:sum('currencyErrors'),amountNotNullErrors:sum('amountNotNullErrors'),
      adjustmentErrors:sum('adjustmentErrors'),unitErrors:sum('unitErrors'),futureRows:sum('futureRows'),duplicateRows:duplicates.reduce((total,row)=>total+row.count-1,0),
      unexpectedOlderRows:sum('unexpectedOlderRows'),attemptCountErrors:securities.filter(row=>row.attemptCountError).length,
      invalidCoverageRecords:ranges.length-securities.reduce((total,row)=>total+row.coverage.filter(range=>range.verified).length,0),
      catalogMembershipErrors:catalogDifferences.activeAbsentFromCatalog.length+catalogDifferences.catalogAbsentFromActive.length+catalogDifferences.currencyMismatches.length,
      valuationOutsidePoolRows:valuation.outsidePoolRows,forecastOutsidePoolRows:forecasts.outsidePoolRows};
    const integrityErrors=Object.values(integrity).reduce((total,value)=>total+value,0);
    const totals={active:active.length,catalog:catalogTickers.length,covered:securities.filter(row=>row.status==='covered').length,
      noData:securities.filter(row=>row.status==='no_data').length,failed:securities.filter(row=>row.status==='failed').length,
      coverageUnverified:securities.filter(row=>row.status==='coverage_unverified').length,
      notAttempted:securities.filter(row=>row.status==='not_attempted').length,withAnnualPrices:securities.filter(row=>row.annualRows>0).length,
      annualRows:sum('annualRows'),sourceAnnualRows:sum('sourceAnnualRows'),baselineRows:sum('baselineRows'),totalRows:sum('totalRows'),
      excessOlderRows:sum('excessOlderRows'),retentionDeferredStocks:securities.filter(row=>row.excessOlderRows>0&&!row.retentionEligible).length,
      needsCurrentAttempt:securities.filter(row=>row.needsCurrentAttempt).length};
    report={version:1,generatedAt:new Date().toISOString(),databaseSnapshotAt:snapshot.rows[0].snapshot,readOnly:true,...window,
      catalog:{path:selectedCatalog,universeHash:catalog.universeHash,asOf:catalog.asOf,sourceDate:catalog.sourceDate,source:catalog.source,apiName:catalog.apiName,...catalogDifferences},
      run,totals,integrity,integrityPassed:integrityErrors===0,priceCoverageComplete:totals.covered===totals.active&&totals.active>0,
      status:integrityErrors?'issues_found':run?.status==='running'?'in_progress':totals.covered===totals.active&&totals.active>0?'complete':'partial',
      aSharesReference:aShares,researchPool:{plannedStocks:researchPool.tickers.length,valuations:valuation,forecasts},
      duplicateRows:duplicates,pricesOutsideActive:priceRows.filter(row=>!activeSet.has(row.ticker)),securities,
      notes:['覆盖只由实际来源行数、单位验证通过的逐股区间并集判断，不以有日线或已尝试下载代替完整覆盖。',
        '较晚的滚动任务会压缩覆盖账本；旧窗口无法再由现账本证明时标记 coverage_unverified，不视为供应商下载失败。',
        'no_data、failed及未处理股票不会因审计生成价格、覆盖或清理记录。',
        '无完整覆盖或无前置真实基准的旧行保留为延后清理；unexpectedOlderRows只统计满足逐股清理条件仍多余的记录。',
        'hk_tradecal休市证明依据数据库中经写入校验的证明类型，本审计不请求供应商重取交易日历。',
        '读取使用同一只读可重复读快照，回填继续进行时本报告仅描述该快照。']};
  } catch(error) {
    try {await client.query('ROLLBACK');} catch{}
    throw error;
  } finally {client.release();await pool.end();}
  const output=resolve(outputPath??join(root,'backend/storage/market-data/audits',`hk-market-${window.runDate.replaceAll('-','')}`,'database-verification.json'));
  await mkdir(dirname(output),{recursive:true,mode:0o700});
  const temporary=`${output}.tmp-${randomUUID()}`;
  await writeFile(temporary,`${JSON.stringify(report,null,2)}\n`,{mode:0o600});await rename(temporary,output);
  return {path:output,status:report.status,integrityPassed:report.integrityPassed,priceCoverageComplete:report.priceCoverageComplete,totals:report.totals,integrity:report.integrity,
    aSharesReference:report.aSharesReference,researchPool:report.researchPool};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args=process.argv.slice(2),options={};
    if(args.includes('--help')) console.log('用法：node --env-file=.env scripts/audit-hk-market.mjs [--run-date YYYY-MM-DD] [--catalog PATH] [--output PATH]；只读数据库，输出逐股年度覆盖及完整性审计JSON。');
    else {
      for(let index=0;index<args.length;index+=2) {
        if(!['--run-date','--catalog','--output'].includes(args[index])||!args[index+1]||Object.hasOwn(options,args[index])) throw invalid();
        options[args[index]]=args[index+1];
      }
      const result=await auditHkMarket({connectionString:process.env.DATABASE_URL,runDate:options['--run-date'],catalogPath:options['--catalog'],outputPath:options['--output']});
      console.log(JSON.stringify(result));process.exitCode=result.integrityPassed?0:2;
    }
  } catch(error) {console.error(JSON.stringify({status:'failed',errorCode:error?.code==='AUDIT_CONFIGURATION_ERROR'?'configuration_error':'audit_error'}));process.exitCode=1;}
}
