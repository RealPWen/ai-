import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateRelationsCurrent } from '../backend/market-data/relations-current-migration.mjs';

const now=()=>new Date('2026-10-20T04:00:00Z');
const relation=(i)=>({relatedTicker:`${100000+i}.SZ`,relatedName:`公司${i}`,relationType:i<2?'upstream':i<5?'peer':'downstream',
  verifiedAt:'2026-10-19T03:00:00Z',sources:[{publishedAt:'2026-10-18'}],rank:i+1});
const snapshot=(overrides={})=>({ticker:'002920.SZ',name:'德赛西威',as_of:'2026-10-19',run_id:'old-complete',
  method_version:'old',source:'published',created_at:'2026-10-19T03:00:00Z',relations:Array.from({length:10},(_,i)=>relation(i)),gaps:[],...overrides});

test('one-time conversion chooses a single full saved report, never unions ten old companies with four new ones',async()=>{
  const saved=new Map(),calls=[];
  const ai=snapshot({run_id:'new-partial',source:'ai',as_of:'2026-10-20',relations:[relation(7),relation(8),relation(9),relation(11)]});
  const client={async query(sql,values){
    calls.push({sql,values});
    if(sql.includes('to_regclass'))return{rows:[{published:true,jobs:true,runs:true}]};
    if(sql.includes("'ai'::text AS source"))return{rows:[ai]};
    if(sql.includes("'published'::text AS source"))return{rows:[snapshot()]};
    if(sql.includes('j.archived_relations'))return{rows:[snapshot({draft_relations:[],archived_relations:Array.from({length:10},(_,i)=>relation(i))})]};
    if(sql.startsWith('INSERT INTO')){
      if(!saved.has(values[0]))saved.set(values[0],{runId:values[8],relations:JSON.parse(values[3])});
    }
    return{rows:[]};
  }};
  await migrateRelationsCurrent(client,now);
  assert.equal(saved.size,1);assert.equal(saved.get('002920.SZ').relations.length,10);
  assert.equal(saved.get('002920.SZ').runId,'old-complete');
  assert.ok(!saved.get('002920.SZ').relations.some(row=>row.relatedTicker==='100011.SZ'));
  saved.set('002920.SZ',{runId:'latest-user-generation',relations:[relation(3)]});
  await migrateRelationsCurrent(client,now);
  assert.equal(saved.get('002920.SZ').runId,'latest-user-generation');
  assert.equal(saved.get('002920.SZ').relations.length,1);
  assert.ok(calls.some(call=>call.sql.includes("result_count=least(10,jsonb_array_length(relations)),relations='[]'")));
});
