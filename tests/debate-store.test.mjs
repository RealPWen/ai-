import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,readdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDebateStore,migrateLegacyDebates,validateStoredDebateReport } from '../backend/src/debate-store.mjs';

const now=()=>new Date('2026-10-20T04:00:00Z');
const input={ticker:'002920.SZ'};
function report(overrides={}){
  return {company:{name:'德赛西威',ticker:'002920.SZ',identityStatus:'verified',description:'汽车电子企业。'},summary:'已审核的市场观点摘要。',
    debates:[{id:'d1',title:'业务增长持续性',summary:'待核验的增长判断。',status:'research_hypothesis',bull:{summary:'增长可能持续。',evidenceStatus:'model_inference',sourceIds:['s1']},bear:{summary:'增长仍需验证。',evidenceStatus:'model_inference',sourceIds:['s1']},metrics:['收入']}],
    sources:[{id:'s1',title:'业务报告',url:'https://www.hkexnews.hk/report.pdf',author:'研究机构',publishedAt:'2026-10-19',platform:'sell_side',readingScope:'partial_text',qualityLabel:'',citationVerified:true}],
    coverage:[],limitations:['资料有限。'],ticker:'002920.SZ',asOf:'2026-10-20',windowStart:'2026-07-23',generatedAt:'2026-10-20T01:00:00.000Z',
    updatedAt:'2026-10-20T01:00:00.000Z',provider:'deepseek',model:'deepseek-test',promptVersion:'prompt-1',cached:false,...overrides};
}
const invalid=error=>error?.code==='INVALID_DEBATE_REPORT'&&error.status===400;
function poolOf({failOn,failEnd=false}={}){
  const calls=[],rows=new Map();let ended=0;
  return {calls,rows,get ended(){return ended;},
    async query(sql,values){
      calls.push({sql,values});if(failOn?.(sql,values))throw new Error('postgres://user:secret@private-host/db');
      if(sql.startsWith('SELECT report,updated_at'))return {rows:rows.has(values[0])?[structuredClone(rows.get(values[0]))]:[]};
      if(sql.startsWith('INSERT INTO market_data.core_market_debates')){
        const old=rows.get(values[0]);if(old&&Date.parse(old.updated_at)>=Date.parse(values[2]))return {rows:[]};
        const value={report:JSON.parse(values[1]),updated_at:new Date(values[2])};rows.set(values[0],value);return {rows:[structuredClone(value)]};
      }
      return {rows:[]};
    },async end(){ended++;if(failEnd)throw new Error('secret private-host');},
  };
}

test('ticker is the sole identity across research dates, providers, models and prompt versions',async()=>{
  const pool=poolOf(),store=createDebateStore({pool,now});
  assert.equal(store.key({ticker:' 002920.sz ',asOf:'2026-10-19',model:'old'}),'002920.SZ');
  assert.equal(store.key({ticker:'002920.SZ',asOf:'2026-10-20',provider:'other'}),'002920.SZ');
  assert.equal(await store.get(input),null);
  const original=report(),saved=await store.set(input,original);assert.equal(saved.cached,false);
  assert.equal(saved.updatedAt,original.generatedAt);assert.equal(original.cached,false);
  const latest=await store.get({...input,asOf:'2026-10-01',model:'other'});
  assert.deepEqual(latest,{...saved,cached:true});assert.equal(pool.rows.size,1);
  const changed=report({generatedAt:'2026-10-20T02:00:00Z',updatedAt:'2026-10-20T02:00:00Z',model:'other-model',provider:'openai',promptVersion:'prompt-2'});
  await store.set(input,changed);
  assert.equal(pool.rows.size,1);assert.equal((await store.get(input)).model,'other-model');assert.equal((await store.get(input)).provider,'openai');
});

test('newer writes atomically replace one row while older and equal-time writes return the actual saved latest report',async()=>{
  const pool=poolOf(),store=createDebateStore({pool,now});
  const newer=report({generatedAt:'2026-10-20T03:00:00Z',updatedAt:'2026-10-20T03:00:00Z',summary:'真正最新的报告'});
  await store.set(input,newer);
  const stale=await store.set(input,report());assert.equal(stale.summary,newer.summary);assert.equal(stale.cached,true);
  const tie=await store.set(input,{...newer,summary:'同时间不同内容不能覆盖'});assert.equal(tie.summary,newer.summary);assert.equal(tie.cached,true);
  const write=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.core_market_debates'));
  assert.match(write.sql,/ON CONFLICT\(ticker\) DO UPDATE/);assert.match(write.sql,/WHERE current_report\.updated_at<EXCLUDED\.updated_at/);
  assert.ok(write.values[1].includes('真正最新'));assert.ok(!write.sql.includes('真正最新'));
});

test('validation rejects wrong-stock, uncertain or empty-shell reports and preserves extra audit metadata',()=>{
  const good=report();good.sources[0].audit={observedUrl:true};good.auditVersion='extra-audit-v1';good.company.verifiedBy='source_audit';
  const validated=validateStoredDebateReport(input,good,{now});
  assert.deepEqual(validated.sources[0].audit,{observedUrl:true});assert.equal(validated.auditVersion,'extra-audit-v1');
  assert.equal(validateStoredDebateReport(input,report({debates:[]}),{now}).debates.length,0);
  for(const value of [report({ticker:'00700.HK'}),report({company:{...good.company,ticker:'00700.HK'}}),
    report({company:{...good.company,identityStatus:'uncertain'}}),report({summary:' '}),report({sources:[]}),
    report({sources:[{...good.sources[0],citationVerified:false}]}),report({sources:[{...good.sources[0],url:'https://user:secret@example.com/report'}]}),
    report({sources:[{...good.sources[0],publishedAt:'2026-10-21'}]}),report({model:''}),report({provider:'unknown'}),report({promptVersion:''}),
    report({generatedAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z'}),report({windowStart:'2026-07-22'}),
    report({asOf:'2026-02-30'}),report({updatedAt:'2026-10-20T02:00:00Z'}),report({cached:'yes'}),report({summary:'bad\u0000text'})]){
    assert.throws(()=>validateStoredDebateReport(input,value,{now}),invalid);
  }
  const refs=report();refs.debates[0].bull.sourceIds=['unknown'];assert.throws(()=>validateStoredDebateReport(input,refs,{now}),invalid);
});

test('invalid reports make no SQL writes, DB errors hide credentials, and a failed update preserves the old report',async()=>{
  let fail=false;const pool=poolOf({failOn:sql=>fail&&sql.startsWith('INSERT INTO')}),store=createDebateStore({pool,now});
  await assert.rejects(store.set(input,report({summary:''})),invalid);assert.equal(pool.calls.length,0);
  await store.set(input,report());fail=true;
  await assert.rejects(store.set(input,report({generatedAt:'2026-10-20T03:00:00Z',updatedAt:'2026-10-20T03:00:00Z'})),error=>error.code==='DEBATE_DATABASE_UNAVAILABLE'&&!/postgres|secret|private-host/i.test(error.message));
  assert.equal((await store.get(input)).generatedAt,'2026-10-20T01:00:00.000Z');
  pool.rows.get(input.ticker).report.company.ticker='00700.HK';
  await assert.rejects(store.get(input),error=>error.code==='INVALID_SAVED_DEBATE_REPORT');
});

test('migration is additive and creates exactly one ticker-primary-key report table; close sanitizes errors',async()=>{
  const pool=poolOf(),store=createDebateStore({pool,now});await store.migrate();
  const sql=pool.calls[0].sql;assert.match(sql,/CREATE TABLE IF NOT EXISTS market_data\.core_market_debates/);assert.match(sql,/ticker text PRIMARY KEY/);
  assert.equal((sql.match(/CREATE TABLE/g)??[]).length,1);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g,''),/(?:^|[;\n])\s*(?:ALTER|DROP|DELETE|TRUNCATE|UPDATE)\b/i);
  await store.close();assert.equal(pool.ended,1);
  await assert.rejects(createDebateStore({pool:poolOf({failEnd:true}),now}).close(),error=>error.code==='DEBATE_DATABASE_UNAVAILABLE'&&!/secret/.test(error.message));
});

async function directoryFor(t){const directory=await mkdtemp(join(tmpdir(),'debate-migration-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
const filename=value=>`${createHash('sha256').update(value).digest('hex')}.json`;
async function legacy(directory,name,value){await writeFile(join(directory,filename(name)),JSON.stringify(value));}

test('legacy migration refuses unproven partition origins by default and never deletes source files',async t=>{
  const directory=await directoryFor(t);await legacy(directory,'a',report());const pool=poolOf(),store=createDebateStore({pool,now});
  const summary=await migrateLegacyDebates({directory,store,now});assert.equal(summary.rejectedFiles,1);assert.equal(summary.importedTickers,0);assert.equal(pool.calls.length,0);
  assert.equal((await readdir(directory)).length,1);
});

test('legacy migration selects the latest valid generation per ticker across dates/models and preserves provenance and generation time',async t=>{
  const directory=await directoryFor(t),old=report({asOf:'2026-10-19',windowStart:'2026-07-22',generatedAt:'2026-10-19T01:00:00Z',updatedAt:undefined,provider:undefined,model:'older-model'});
  const current=report({provider:undefined,model:'latest-model'}),hk=report({ticker:'00700.HK',company:{...current.company,ticker:'00700.HK',name:'腾讯控股'}});
  await legacy(directory,'older',old);await legacy(directory,'newer',current);await legacy(directory,'hk',hk);await legacy(directory,'private',report({provider:undefined,model:'private-subscription'}));
  await legacy(directory,'invalid-newer',report({summary:'',generatedAt:'2026-10-20T03:00:00Z',updatedAt:undefined}));
  await writeFile(join(directory,filename('corrupt')),'not JSON');
  const pool=poolOf(),store=createDebateStore({pool,now});
  const acceptReport=(value,{filename:file})=>file===filename('private')?false:{provider:'deepseek'};
  const first=await migrateLegacyDebates({directory,store,acceptReport,now});
  assert.equal(first.acceptedFiles,3);assert.equal(first.selectedTickers,2);assert.equal(first.importedTickers,2);assert.equal(first.rejectedFiles,1);assert.equal(first.invalidFiles,2);
  const saved=await store.get(input);assert.equal(saved.model,'latest-model');assert.equal(saved.provider,'deepseek');assert.equal(saved.generatedAt,current.generatedAt);assert.equal(saved.updatedAt,current.generatedAt);
  assert.equal((await readdir(directory)).length,6);
  const second=await migrateLegacyDebates({directory,store,acceptReport,now});assert.equal(second.importedTickers,0);assert.equal(second.skippedOlderTickers,2);
  await store.set(input,report({generatedAt:'2026-10-20T03:30:00Z',updatedAt:undefined,model:'database-newer'}));
  await migrateLegacyDebates({directory,store,acceptReport,now});assert.equal((await store.get(input)).model,'database-newer');
});

test('legacy authorization failures abort before database writes and missing providers are not guessed from model names',async t=>{
  const directory=await directoryFor(t);await legacy(directory,'a',report({provider:undefined}));
  const pool=poolOf(),store=createDebateStore({pool,now});
  const unknown=await migrateLegacyDebates({directory,store,acceptReport:()=>true,now});assert.equal(unknown.invalidFiles,1);assert.equal(pool.calls.length,0);
  await assert.rejects(migrateLegacyDebates({directory,store,acceptReport:()=>{throw new Error('private token');},now}),error=>error.code==='DEBATE_MIGRATION_AUTHORIZATION_FAILED'&&!/private|token/.test(error.message));
  assert.equal(pool.calls.length,0);
});
