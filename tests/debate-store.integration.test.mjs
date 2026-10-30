import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createDebateStore} from '../backend/src/debate-store.mjs';

// Opt-in only. Every SQL reference is rewritten to a fresh isolated schema.
const enabled=process.env.DEBATE_DATABASE_TESTS==='1'&&Boolean(process.env.DATABASE_URL);
test('PostgreSQL latest debates: atomic single-row replacement, concurrent stale-write guard, validation and failure preservation', {skip:!enabled},async()=>{
  const schema=`debate_test_${randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^debate_test_[a-f0-9]{32}$/);
  const raw=new pg.Pool({connectionString:process.env.DATABASE_URL,max:4});
  const rewrite=sql=>sql.replaceAll('market_data.',`${schema}.`).replaceAll('CREATE SCHEMA IF NOT EXISTS market_data',`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  let failWrite=false;
  const pool={async query(sql,values){if(failWrite&&sql.startsWith('INSERT INTO market_data.core_market_debates'))throw new Error('postgres://private:secret@private-host/db');return raw.query(rewrite(sql),values);},async end(){}};
  const now=()=>new Date('2026-10-20T04:00:00Z'),store=createDebateStore({pool,now}),input={ticker:'002920.SZ'};
  const report=(generatedAt,extra={})=>({company:{name:'德赛西威',ticker:input.ticker,identityStatus:'verified',description:'隔离集成测试。'},summary:'已核验来源的研究摘要。',debates:[],
    sources:[{id:'s1',title:'测试来源',url:'https://www.hkexnews.hk/report.pdf',author:'测试研究员',publishedAt:'2026-10-19',platform:'sell_side',readingScope:'partial_text',qualityLabel:'',citationVerified:true}],
    coverage:[],limitations:['隔离测试'],ticker:input.ticker,asOf:'2026-10-20',windowStart:'2026-07-23',generatedAt,provider:'deepseek',model:'test-model',promptVersion:'test-prompt',...extra});
  try{
    await store.migrate();await store.migrate();assert.equal(await store.get(input),null);
    await store.set(input,report('2026-10-20T01:00:00Z'));
    await Promise.all([store.set(input,report('2026-10-20T03:00:00Z',{summary:'最新已完成报告',model:'new-model',promptVersion:'new-prompt'})),
      store.set(input,report('2026-10-20T02:00:00Z',{summary:'较旧生成晚写时不能覆盖'}))]);
    let latest=await store.get({...input,asOf:'2026-10-01',model:'different'});
    assert.equal(latest.generatedAt,'2026-10-20T03:00:00.000Z');assert.equal(latest.updatedAt,latest.generatedAt);assert.equal(latest.summary,'最新已完成报告');assert.equal(latest.cached,true);
    const tie=await store.set(input,report('2026-10-20T03:00:00Z',{summary:'相同时间不覆盖'}));assert.equal(tie.cached,true);assert.equal(tie.summary,'最新已完成报告');
    await assert.rejects(store.set(input,report('2026-10-20T03:30:00Z',{summary:''})),error=>error.code==='INVALID_DEBATE_REPORT');
    failWrite=true;
    await assert.rejects(store.set(input,report('2026-10-20T03:30:00Z')),error=>error.code==='DEBATE_DATABASE_UNAVAILABLE'&&!/private|secret|postgres/.test(error.message));
    failWrite=false;
    latest=await createDebateStore({pool,now}).get(input);assert.equal(latest.summary,'最新已完成报告');
    const rows=await raw.query(`SELECT ticker,provider,model,prompt_version,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at FROM ${schema}.core_market_debates`);
    assert.deepEqual(rows.rows,[{ticker:input.ticker,provider:'deepseek',model:'new-model',prompt_version:'new-prompt',updated_at:'2026-10-20T03:00:00.000Z'}]);
    await assert.rejects(raw.query(`INSERT INTO ${schema}.core_market_debates(ticker,report,updated_at,provider,model,prompt_version)
      VALUES('00700.HK','{}'::jsonb,now(),'deepseek','test','test')`),error=>error.code==='23514');
  }finally{try{await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await raw.end();}}
});
