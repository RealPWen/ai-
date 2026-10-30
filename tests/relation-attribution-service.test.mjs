import test from 'node:test';import assert from 'node:assert/strict';
import {createRelationAttributionService} from '../backend/src/relation-attribution-service.mjs';
const market=(n)=>({tradeDate:'2026-10-28',returns:{w1:n,m6:n*2},returnBaseDates:{w1:'2026-10-21',m6:'2026-04-28'}});
function fixture({fail=false,empty=false,staleRelation=false,ready=true,cap=false}={}){
 let job=null,saved=null,calls=0,reads=0;const sql=[];
 const query=async(q,v=[])=>{
  sql.push([q,v]);
  if(q.includes('SELECT * FROM market_data.company_relation_attributions'))return {rows:saved?[saved]:[]};
  if(q.includes('SELECT * FROM market_data.company_relation_attribution_jobs'))return {rows:job?[job]:[]};
  if(q.includes('SELECT job_id')&&q.includes('FOR UPDATE'))return {rows:job?.status==='running'?[job]:[]};
  if(q.includes('SELECT job_id'))return {rows:[]};
  if(q.includes('SELECT count(*) n'))return {rows:[{n:cap?2:0}]};
  if(q.startsWith('SELECT 1'))return{rows:ready?[{}]:[]};
  if(q.includes('INSERT INTO market_data.company_relation_attribution_jobs')){job={job_id:v[0],ticker:v[1],status:'running',stage:'queued',attempts:1,updated_at:new Date(),created_at:new Date()};return{rows:[job]};}
  if(q.includes('INSERT INTO market_data.company_relation_attributions(')){saved={ticker:v[0],input_hash:v[1],relation_hash:v[2],quote_date:v[3],report:JSON.parse(v[4])};}
  if(q.includes("SET status='succeeded'")){job.status='succeeded';}
  if(q.includes("SET status='failed',stage='failed'")){job.status='failed';job.error_code=v[1];}
  return{rows:[]};
 };
 const pool={query,connect:async()=>({query,release(){}}),end:async()=>{}};
 const service=createRelationAttributionService({pool,watchlistStore:{union:async()=>['002920.SZ']},relationsService:{get:async()=>{reads++;return{subject:{ticker:'002920.SZ',name:'德赛西威',market:market(3)},relations:empty?[]:[{relatedTicker:'002906.SZ',relatedName:'华阳集团',relationType:staleRelation&&reads>2?'upstream':'peer',market:market(1)}]}}},client:{researchRelationAttribution:async()=>{calls++;if(fail)throw new Error('private raw error');return{analyses:{},sources:[]}}},prompt:'prompt',now:()=>new Date('2026-10-29T01:00:00Z')});
 return{service,get calls(){return calls},get saved(){return saved},get job(){return job},sql};
}
test('batch saves one latest report and unchanged input skips after service restart semantics',async()=>{const f=fixture();await f.service.updateAll({manual:true});assert.equal(f.calls,1);assert.ok(f.saved);assert.equal(f.job.status,'succeeded');const r=await f.service.updateAll({manual:true});assert.equal(r.skipped,1);assert.equal(f.calls,1);await f.service.close()});
test('failed generation preserves report and stores only safe error code',async()=>{const f=fixture({fail:true});await f.service.updateAll({manual:true});assert.equal(f.saved,null);assert.equal(f.job.status,'failed');assert.equal(f.job.error_code,'RELATIVE_GENERATION_FAILED');await f.service.close()});
test('no relations avoids AI and automatic jobs wait for prices',async()=>{const f=fixture({empty:true});await f.service.updateAll({manual:true});assert.equal(f.calls,0);await f.service.close();const g=fixture({ready:false});assert.equal((await g.service.updateAll()).deferred,1);assert.equal(g.calls,0);await g.service.close()});
test('concurrent manual relation change prevents saving superseded analysis',async()=>{const f=fixture({staleRelation:true});await f.service.updateAll({manual:true});assert.equal(f.saved,null);assert.equal(f.job.error_code,'RELATIVE_RELATIONS_CHANGED');await f.service.close()});
test('automatic generation allows at most initial and one additional success per day',async()=>{const f=fixture({cap:true});const r=await f.service.updateAll();assert.equal(r.skipped,1);assert.equal(f.calls,0);await f.service.close()});
