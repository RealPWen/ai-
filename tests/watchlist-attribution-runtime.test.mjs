import test from 'node:test';import assert from 'node:assert/strict';
import {createWatchlistAttributionRuntime} from '../backend/src/watchlist-attribution-runtime.mjs';
function fixture({fresh=false,ready=true,locked=true,failure=false,allowClaim=true}={}){
 const calls=[],sql=[];const query=async(s,v)=>{sql.push([s,v]);return {rows:s.includes('pg_try')?[{locked}]:s.startsWith('SELECT 1')?(ready?[{}]:[]):s.includes('RETURNING period')?(allowClaim?[{period:v[2]}]:[]):[]}};
 const pool={query,connect:async()=>({query,release(){}}),end:async()=>{}};
 const service={get:async()=>({periods:Object.fromEntries(['1m','6m','1y'].map(p=>[p,{currentMetrics:{to:'2026-10-28'},report:(Array.isArray(fresh)?fresh.includes(p):fresh)?{to:'2026-10-28'}:null}]))}),start:async p=>{calls.push(p);return {jobId:'job',status:failure?'failed':'succeeded',periods:Object.fromEntries(p.periods.map(p=>[p,{status:failure?'failed':'succeeded',error:{code:'ATTRIBUTION_INSUFFICIENT_BALANCE'}}]))}}};
 const runtime=createWatchlistAttributionRuntime({pool,watchlistStore:{union:async()=>['002920.SZ','02313.HK']},service,now:()=>new Date('2026-10-29T02:00:00Z')});return{runtime,calls,sql};
}
test('daily union generates three periods per stock and persists individual success',async()=>{const f=fixture();const r=await f.runtime.runOnce();assert.equal(r.succeeded,6);assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0].periods,['1m','6m','1y']);assert.equal(f.sql.filter(([s])=>s.includes('SET status=$1')).length,6);await f.runtime.close()});
test('no newer quote avoids calls even when calendar window rolls',async()=>{const f=fixture({fresh:true});const r=await f.runtime.runOnce();assert.equal(r.skipped,6);assert.equal(f.calls.length,0);await f.runtime.close()});
test('waits for each market price completion instead of paying for stale data',async()=>{const f=fixture({ready:false});const r=await f.runtime.runOnce();assert.equal(r.deferred,2);assert.equal(f.calls.length,0);await f.runtime.close()});
test('cross process lock prevents duplicate workers',async()=>{const f=fixture({locked:false});assert.equal((await f.runtime.runOnce()).status,'busy');assert.equal(f.calls.length,0);await f.runtime.close()});
test('billing failure stops remaining stocks and records failed periods',async()=>{const f=fixture({failure:true});const r=await f.runtime.runOnce({force:true});assert.equal(r.failed,3);assert.equal(f.calls.length,1);assert.equal(r.blocked,true);await f.runtime.close()});

test('only unsuccessful periods are retried and manual trigger can bypass cooldown',async()=>{const f=fixture({fresh:['1m','6m']});const r=await f.runtime.runOnce({force:true});assert.equal(r.succeeded,2);assert.deepEqual(f.calls[0].periods,['1y']);assert.equal(f.sql.find(([s])=>s.includes('RETURNING period'))[1][4],true);await f.runtime.close()});
test('persisted attempt limit or successful claim blocks repeated paid jobs',async()=>{const f=fixture({allowClaim:false});await f.runtime.runOnce();assert.equal(f.calls.length,0);await f.runtime.close()});
test('same process simultaneous runs share one operation',async()=>{const f=fixture();const a=f.runtime.runOnce(),b=f.runtime.runOnce();assert.equal(a,b);await a;assert.equal(f.calls.length,2);await f.runtime.close()});
