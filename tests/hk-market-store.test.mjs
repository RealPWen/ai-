import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHkMarketStore, HK_MARKET_LOCK_KEYS } from '../backend/market-data/hk-market-store.mjs';

const tickers=['00700.HK','02513.HK'];
const universeHash=createHash('sha256').update([...tickers].sort().join('\n')).digest('hex');
const run={runDate:'2026-10-19',universeHash,windowStart:'20251019',windowEnd:'20261018',tickers};
const persisted={...run,windowStart:'2025-10-19',windowEnd:'2026-10-18',status:'running'};
const options={...run,ticker:'00700.HK',requestedStartDate:'20250919',requestedEndDate:'20261018'};
function row(date='20261016') {
  return {ts_code:'00700.HK',trade_date:date,open:'10.2',high:'10.4',low:'10.1',close:'10.3',pre_close:'10.1',change:'0.2',pct_chg:'1.98',vol:'1000200',amount:null};
}
function mockPool({locked=true,complete=true,baseline='2025-10-17',matchingRowsCount=245,failOn=()=>false}={}) {
  const calls=[],releases=[];
  const client=new EventEmitter();
  client.query=async (sql,values)=>{
    calls.push({sql,values});
    if(failOn(sql)) {const error=new Error('private-credential');error.code='23505';throw error;}
    if(sql.startsWith('SELECT pg_try')) return {rows:[{locked}]};
    if(sql.startsWith('SELECT pg_advisory_unlock')) return {rows:[{unlocked:true}]};
    if(sql.includes('FROM market_data.hk_market_update_runs')) return {rows:[persisted]};
    if(sql.includes('FROM market_data.hk_market_symbol_ranges AS coverage')) return {rows:complete?[{startDate:'20251019',endDate:'20261018',rowsCount:245}]:[]};
    if(sql.includes('FROM market_data.hk_market_symbol_attempts')) return {rows:[{status:'no_data',rowsCount:0,errorCode:'no_data',lastQuoteDate:null}]};
    if(sql.includes('SELECT to_char(max(trade_date)')&&sql.includes('trade_date<$4')) return {rows:[{date:baseline}]};
    if(sql.includes('SELECT to_char(max(trade_date)')) return {rows:[{date:'2026-10-16',annualRowsCount:245,matchingRowsCount}]};
    return {rows:[],rowCount:2};
  };
  client.release=error=>releases.push(error);
  return {calls,releases,client,connect:async()=>client,end:async()=>{}};
}

test('all-market schema is isolated and zero coverage requires explicit closed-day proof',async()=>{
  const schema=await readFile(new URL('../backend/market-data/hk-market-schema.sql',import.meta.url),'utf8');
  assert.match(schema,/CREATE TABLE IF NOT EXISTS market_data.hk_listed_universe/);
  assert.match(schema,/CREATE TABLE IF NOT EXISTS market_data.hk_market_symbol_attempts/);
  assert.match(schema,/rows_count>0 OR \(empty_proof IN \('weekends','hk_tradecal'\)\) IS TRUE/);
  assert.doesNotMatch(schema,/CREATE TABLE.*hk_pool|sync_days/);
  const pool=mockPool();await createHkMarketStore({pool}).migrate();
  assert.equal(pool.calls[0].sql,'BEGIN');assert.equal(pool.calls.at(-1).sql,'COMMIT');
});

test('full catalog activation is atomic, validates membership, retains old security records',async()=>{
  const catalog={complete:true,universeHash,source:'hkex',apiName:'hkex_securities_list',securities:tickers.map(ticker=>({ticker,name:ticker,currency:'HKD'}))};
  const pool=mockPool(),store=createHkMarketStore({pool});
  await store.upsertCatalog(catalog);
  assert.equal(pool.calls[0].sql,'BEGIN');assert.equal(pool.calls.at(-1).sql,'COMMIT');
  assert.ok(pool.calls.some(call=>call.sql.includes('SET active=false')));
  assert.ok(pool.calls.some(call=>call.sql.includes('INSERT INTO market_data.securities')));
  assert.equal(pool.calls.some(call=>call.sql.startsWith('DELETE')),false);
  for(const invalid of [{...catalog,complete:false},{...catalog,universeHash:'a'.repeat(64)},{...catalog,securities:[catalog.securities[0],catalog.securities[0]]}]) {
    const count=pool.calls.length;await assert.rejects(store.upsertCatalog(invalid),{code:'VALIDATION_ERROR'});assert.equal(pool.calls.length,count);
  }
  const failed=mockPool({failOn:sql=>sql.includes('SET active=false')});
  await assert.rejects(createHkMarketStore({pool:failed}).upsertCatalog(catalog),error=>error.code==='DATABASE_ERROR'&&!error.message.includes('private'));
  assert.equal(failed.calls.at(-1).sql,'ROLLBACK');
});

test('independent lock handles busy, released scopes and lost sessions safely',async()=>{
  const pool=mockPool(),store=createHkMarketStore({pool});let scope;
  await store.withLock(value=>{scope=value;});
  assert.deepEqual(pool.calls[0].values,HK_MARKET_LOCK_KEYS);
  await assert.rejects(async()=>scope.getRun(run),{code:'VALIDATION_ERROR'});
  const busy=mockPool({locked:false});assert.deepEqual(await createHkMarketStore({pool:busy}).withLock(()=>assert.fail()),{status:'busy'});
  const lost=mockPool();await assert.rejects(createHkMarketStore({pool:lost}).withLock(()=>{lost.client.emit('error',new Error('password'));}),{code:'DATABASE_ERROR'});
  assert.equal(lost.releases[0].code,'DATABASE_ERROR');assert.equal(lost.client.listenerCount('error'),0);
});

test('buffered initial history stores annual prices plus only the latest preceding quote and compacts verified coverage',async()=>{
  const pool=mockPool();
  const result=await createHkMarketStore({pool}).withLock(scope=>scope.saveSymbol({...options,rows:[row('20250919'),row('20251016'),row('20251017'),row()]}));
  assert.equal(result.complete,true);assert.equal(result.rowsCount,2);assert.equal(result.annualRows,1);
  const insert=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.daily_prices'));
  assert.ok(insert.values.includes('2025-10-17'));assert.ok(insert.values.includes('2026-10-16'));
  assert.equal(insert.values.includes('2025-10-16'),false);assert.equal(insert.values.includes('2025-09-19'),false);
  assert.deepEqual(insert.values.slice(-6),['tencent','tencent_hk_daily','none','share','hkd','HKD']);
  const range=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_market_symbol_ranges'));
  assert.equal(range.values[3],'2025-10-19');assert.equal(range.values[4],'2026-10-18');
  const prune=pool.calls.find(call=>call.sql.startsWith('DELETE FROM market_data.daily_prices'));
  assert.deepEqual(prune.values,['00700.HK','tencent','tencent_hk_daily','2025-10-19','2025-10-17']);
  const compact=pool.calls.filter(call=>call.sql.startsWith('INSERT INTO market_data.hk_market_symbol_ranges')).at(-1);
  assert.match(compact.sql,/count\(\*\)/);assert.deepEqual(compact.values.slice(-2),['2025-10-19','2026-10-18']);
  const attempt=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_market_symbol_attempts'));
  assert.equal(attempt.values[4],245);
  assert.equal(pool.calls.some(call=>/hk_pool|daily_valuations|forecasts|sync_days/.test(call.sql)),false);
});

test('incomplete annual coverage and missing older-company baseline never prune existing prices',async()=>{
  for(const configuration of [{complete:false},{baseline:null}]) {
    const pool=mockPool(configuration);
    await createHkMarketStore({pool}).withLock(scope=>scope.saveSymbol({...options,rows:[row()]}));
    assert.equal(pool.calls.some(call=>call.sql.startsWith('DELETE FROM market_data.daily_prices')),false);
  }
  const ipo=mockPool({baseline:null});
  await createHkMarketStore({pool:ipo}).withLock(scope=>scope.saveSymbol({...options,listDate:'2026-01-08',rows:[row()]}));
  assert.ok(ipo.calls.some(call=>call.sql.startsWith('DELETE FROM market_data.daily_prices')));
});

test('Tencent USD counters keep USD prices and null amount instead of relabeling them HKD',async()=>{
  const pool=mockPool();
  await createHkMarketStore({pool}).withLock(scope=>scope.saveSymbol({...options,currency:'USD',rows:[{...row(),amount:'10'}]}));
  const insert=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.daily_prices'));
  assert.deepEqual(insert.values.slice(-6),['tencent','tencent_hk_daily','none','share','usd','USD']);
  assert.equal(insert.values.at(-7),null);
  await assert.rejects(createHkMarketStore({pool:mockPool()}).withLock(scope=>scope.saveSymbol({...options,currency:'CNY',rows:[row()]})),{code:'VALIDATION_ERROR'});
});

test('weekday empty responses never write coverage or prune; failure attempts are safely resumable',async()=>{
  const pool=mockPool(),store=createHkMarketStore({pool});
  await store.withLock(async scope=>{
    await assert.rejects(scope.saveSymbol({...options,rows:[]}),{kind:'no_data'});
    await scope.markSymbol({...run,ticker:'00700.HK',status:'no_data',errorCode:'private token',lastQuoteDate:'2025-09-18'});
    const attempt=await scope.getSymbolAttempt({...run,ticker:'00700.HK'});assert.equal(attempt.status,'no_data');
  });
  assert.equal(pool.calls.some(call=>call.sql.startsWith('INSERT INTO market_data.daily_prices')||call.sql.startsWith('INSERT INTO market_data.hk_market_symbol_ranges')||call.sql.startsWith('DELETE')),false);
  const attempt=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_market_symbol_attempts'));
  assert.equal(attempt.values[5],'no_data');assert.equal(attempt.values[6],'2025-09-18');
});

test('weekend-only empty increments carry explicit closed proof and cannot certify a weekday',async()=>{
  const pool=mockPool({complete:false}),store=createHkMarketStore({pool});
  await store.withLock(scope=>scope.saveSymbol({...options,requestedStartDate:'20261017',requestedEndDate:'20261018',rows:[]}));
  const range=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_market_symbol_ranges'));
  assert.deepEqual(range.values.slice(3),['2026-10-17','2026-10-18',0,'weekends']);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('DELETE')),false);
});

test('weekday zero coverage requires a unique complete calendar proving every requested day closed',async()=>{
  const pool=mockPool({complete:false}),store=createHkMarketStore({pool});
  const holiday={...options,requestedStartDate:'20261001',requestedEndDate:'20261001',rows:[],emptyProof:'hk_tradecal'};
  await store.withLock(async scope=>{
    for(const calendarRows of [[],[{cal_date:'20261001',is_open:1}],[{cal_date:'20261002',is_open:0}],
      [{cal_date:'20261001',is_open:0},{cal_date:'20261001',is_open:0}]]) {
      await assert.rejects(scope.saveSymbol({...holiday,calendarRows}),{code:'VALIDATION_ERROR'});
    }
    await scope.saveSymbol({...holiday,calendarRows:[{cal_date:'20261001',is_open:0}]});
  });
  const ranges=pool.calls.filter(call=>call.sql.startsWith('INSERT INTO market_data.hk_market_symbol_ranges'));
  assert.equal(ranges.length,1);assert.deepEqual(ranges[0].values.slice(3),['2026-10-01','2026-10-01',0,'hk_tradecal']);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('DELETE')),false);
});

test('range ledger failure rolls price writes back, and verified coverage is independent of membership hash',async()=>{
  const failed=mockPool({failOn:sql=>sql.startsWith('INSERT INTO market_data.hk_market_symbol_ranges')});
  await assert.rejects(createHkMarketStore({pool:failed}).withLock(scope=>scope.saveSymbol({...options,rows:[row()]})),{code:'DATABASE_ERROR'});
  assert.ok(failed.calls.some(call=>call.sql.startsWith('INSERT INTO market_data.daily_prices')));
  assert.equal(failed.calls.some(call=>call.sql==='COMMIT'),false);assert.ok(failed.calls.some(call=>call.sql==='ROLLBACK'));
  const pool=mockPool();await createHkMarketStore({pool}).withLock(scope=>scope.getRanges({ticker:'00700.HK',startDate:'20251019',endDate:'20261018'}));
  const lookup=pool.calls.find(call=>call.sql.includes('AS coverage'));
  assert.doesNotMatch(lookup.sql,/universe_hash/);assert.match(lookup.sql,/prices.source=coverage.source AND prices.source_api=coverage.source_api/);
});

test('run identity rejects forged membership and finishing persists bounded aggregate summaries without global pruning',async()=>{
  const pool=mockPool(),store=createHkMarketStore({pool});
  await store.withLock(async scope=>{
    await assert.rejects(scope.beginRun({...run,tickers:['00700.HK']}),{code:'VALIDATION_ERROR'});
    await scope.beginRun(run);
    await scope.finishRun({...run,status:'partial',summary:{plannedTickers:2,completedTickers:1,noDataTickers:1}});
    await assert.rejects(scope.finishRun({...run,status:'succeeded',summary:{value:'x'.repeat(100001)}}),{code:'VALIDATION_ERROR'});
  });
  assert.ok(pool.calls.some(call=>call.sql.startsWith('UPDATE market_data.hk_market_update_runs')));
  assert.equal(pool.calls.some(call=>call.sql.startsWith('DELETE')),false);
});

test('starting a changed frozen universe marks old same-day running ledgers partial atomically without touching attempts',async()=>{
  const pool=mockPool();await createHkMarketStore({pool}).withLock(scope=>scope.beginRun(run));
  const supersede=pool.calls.find(call=>call.sql.includes("jsonb_build_object('supersededByUniverseHash'"));
  const insert=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_market_update_runs'));
  assert.ok(supersede);assert.deepEqual(supersede.values,['2026-10-19',universeHash]);
  assert.match(supersede.sql,/WHERE run_date=\$1 AND universe_hash<>\$2 AND status='running'/);
  assert.match(supersede.sql,/status='partial',finished_at=now\(\)/);
  assert.ok(pool.calls.findIndex(call=>call.sql==='BEGIN')<pool.calls.indexOf(supersede));
  assert.ok(pool.calls.indexOf(supersede)<pool.calls.indexOf(insert));
  assert.ok(pool.calls.indexOf(insert)<pool.calls.findIndex(call=>call.sql==='COMMIT'));
  assert.equal(pool.calls.some(call=>call.sql.includes('hk_market_symbol_attempts')),false);
});

test('confirming existing complete history updates only current-universe attempt and rejects missing coverage or mismatched currency',async()=>{
  const pool=mockPool();
  const result=await createHkMarketStore({pool}).withLock(scope=>scope.confirmSymbol({...run,ticker:'00700.HK',currency:'HKD'}));
  assert.equal(result.complete,true);assert.equal(result.rowsCount,245);
  const attempt=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_market_symbol_attempts'));
  assert.equal(attempt.values[2],universeHash);assert.equal(attempt.values[3],'completed');assert.equal(attempt.values[4],245);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('INSERT INTO market_data.daily_prices')||call.sql.startsWith('DELETE')),false);
  await assert.rejects(createHkMarketStore({pool:mockPool({complete:false})}).withLock(scope=>scope.confirmSymbol({...run,ticker:'00700.HK'})),{kind:'incomplete_window'});
  await assert.rejects(createHkMarketStore({pool:mockPool({matchingRowsCount:0})}).withLock(scope=>scope.confirmSymbol({...run,ticker:'00700.HK',currency:'USD'})),{code:'VALIDATION_ERROR'});
});
