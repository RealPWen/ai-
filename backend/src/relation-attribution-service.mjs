import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { ResearchError } from './errors.mjs';
import { todayShanghai, validDate } from './input.mjs';
import { buildRelationAttributionSnapshot } from './relation-attribution-evidence.mjs';
export function createRelationAttributionService({connectionString,relationsService,watchlistStore,client,prompt,enabled=true,now=()=>new Date(),log=()=>{},pool:injectedPool}){
 const pool=injectedPool??new pg.Pool({connectionString,max:4,connectionTimeoutMillis:10000});let pending=null,timer,closing=false,allPending=null,lastResult=null;
 const emit=x=>{try{log(x)}catch{}};if(!injectedPool)pool.on('error',()=>emit({type:'relation_attribution_database_error'}));
 const invalid=()=>new ResearchError('RELATIVE_INVALID_INPUT','仅支持A股和港股代码及有效研究日期。',400);
 function input(raw,generate=false){if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['ticker',...(generate?[]:['asOf'])].includes(k)))throw invalid();const ticker=typeof raw.ticker==='string'?raw.ticker.trim().toUpperCase():'';const asOf=raw.asOf??todayShanghai(now());if(!/^(?:\d{6}\.(SH|SZ|BJ)|\d{5}\.HK)$/.test(ticker)||!validDate(asOf)||asOf>todayShanghai(now()))throw invalid();return{ticker,asOf};}
 const snapshot=async p=>buildRelationAttributionSnapshot(await relationsService.get(p),p.asOf);
 const publicJob=r=>r?{jobId:r.job_id,ticker:r.ticker,status:r.status,stage:r.stage,errorCode:r.error_code,attempts:r.attempts,updatedAt:r.updated_at}:null;
 async function sweep(){await pool.query(`UPDATE market_data.company_relation_attribution_jobs SET status='failed',stage='interrupted',error_code='RELATIVE_INTERRUPTED',updated_at=now() WHERE status='running' AND updated_at<now()-interval '12 minutes'`)}
 async function current(ticker){return (await pool.query('SELECT * FROM market_data.company_relation_attributions WHERE ticker=$1',[ticker])).rows[0]??null;}
 async function latest(ticker){return publicJob((await pool.query('SELECT * FROM market_data.company_relation_attribution_jobs WHERE ticker=$1 ORDER BY updated_at DESC,created_at DESC LIMIT 1',[ticker])).rows[0]);}
 async function run(job,snap){
  const beat=setInterval(()=>void pool.query("UPDATE market_data.company_relation_attribution_jobs SET updated_at=now() WHERE job_id=$1 AND status='running'",[job.jobId]).catch(()=>{}),15000);beat.unref?.();
  try{
   const onProgress=async stage=>{await pool.query('UPDATE market_data.company_relation_attribution_jobs SET stage=$2,updated_at=now() WHERE job_id=$1 AND status=\'running\'',[job.jobId,stage]);};
   const result=await client.researchRelationAttribution(snap,prompt,{onProgress});
   const fresh=await snapshot({ticker:snap.ticker,asOf:todayShanghai(now())});
   if(fresh.relationHash!==snap.relationHash)throw new ResearchError('RELATIVE_RELATIONS_CHANGED','关联名单已变化，本次旧名单分析未覆盖当前结果。',409);
   const report={...result,ticker:snap.ticker,inputHash:snap.inputHash,relationHash:snap.relationHash,snapshot:snap,generatedAt:now().toISOString()};
   const c=await pool.connect();try{await c.query('BEGIN');
    const exists=await c.query("SELECT job_id FROM market_data.company_relation_attribution_jobs WHERE job_id=$1 AND status='running' FOR UPDATE",[job.jobId]);if(!exists.rows.length)throw new Error('interrupted');
    await c.query(`INSERT INTO market_data.company_relation_attributions(ticker,input_hash,relation_hash,quote_date,report,generated_at) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(ticker) DO UPDATE SET input_hash=EXCLUDED.input_hash,relation_hash=EXCLUDED.relation_hash,quote_date=EXCLUDED.quote_date,report=EXCLUDED.report,generated_at=EXCLUDED.generated_at`,[snap.ticker,snap.inputHash,snap.relationHash,snap.quoteDate,JSON.stringify(report),report.generatedAt]);
    await c.query("UPDATE market_data.company_relation_attribution_jobs SET status='succeeded',stage='completed',snapshot='{}'::jsonb,updated_at=now() WHERE job_id=$1",[job.jobId]);await c.query('COMMIT');
   }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
   emit({type:'relation_attribution_saved',ticker:snap.ticker,jobId:job.jobId});
  }catch(e){const code=e instanceof ResearchError?e.code:'RELATIVE_GENERATION_FAILED';await pool.query("UPDATE market_data.company_relation_attribution_jobs SET status='failed',stage='failed',error_code=$2,snapshot='{}'::jsonb,updated_at=now() WHERE job_id=$1 AND status='running'",[job.jobId,code]);emit({type:'relation_attribution_failed',ticker:snap.ticker,code,reason:e instanceof ResearchError?e.message:'generation_failed'});}
  finally{clearInterval(beat)}
 }
 async function start(raw,{automatic=false}={}){
  const p=input(raw,true);if(typeof client?.researchRelationAttribution!=='function')throw new ResearchError('DEEPSEEK_CONFIG_ERROR','请配置DeepSeek联网分析接口后重试。',503);if(closing)throw new ResearchError('RELATIVE_CLOSING','服务正在关闭',503);await sweep();
  const existing=await latest(p.ticker);if(existing?.status==='running')return existing;
  if(pending)throw new ResearchError('RELATIVE_BUSY','已有公司正在分析，请稍候。',429);
  const snap=await snapshot(p),saved=await current(p.ticker);
  if(automatic&&saved){const old=saved.report.snapshot;if(saved.input_hash===snap.inputHash||(old.version===snap.version&&old.quoteDate===snap.quoteDate&&old.relationHash===snap.relationHash&&old.coverageHash===snap.coverageHash))return {status:'skipped'};}
  const c=await pool.connect();let job;
  try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(786215,63)");
   const active=await c.query("SELECT job_id FROM market_data.company_relation_attribution_jobs WHERE status='running' LIMIT 1");if(active.rows.length)throw new ResearchError('RELATIVE_BUSY','已有公司正在分析，请稍候。',429);
   const prev=(await c.query('SELECT * FROM market_data.company_relation_attribution_jobs WHERE ticker=$1 AND run_date=$2 AND input_hash=$3 FOR UPDATE',[p.ticker,p.asOf,snap.inputHash])).rows[0];
   if(prev?.attempts>=3)throw new ResearchError('RELATIVE_RETRY_LIMIT','同一输入当天已尝试3次，旧报告仍保留。',429);
   if(automatic&&prev&&(prev.status==='succeeded'||now().getTime()-new Date(prev.updated_at).getTime()<900000))return await c.query('ROLLBACK').then(()=>({status:'skipped'}));
   const n=Number((await c.query("SELECT count(*) n FROM market_data.company_relation_attribution_jobs WHERE ticker=$1 AND run_date=$2 AND status='succeeded'",[p.ticker,p.asOf])).rows[0].n);
   if(automatic&&n>=2)return await c.query('ROLLBACK').then(()=>({status:'skipped'}));
   const id=prev?.job_id??randomUUID();
   const r=await c.query(`INSERT INTO market_data.company_relation_attribution_jobs(job_id,ticker,run_date,input_hash,status,stage,attempts,snapshot) VALUES($1,$2,$3,$4,'running','queued',1,$5)
    ON CONFLICT(ticker,run_date,input_hash) DO UPDATE SET status='running',stage='queued',attempts=company_relation_attribution_jobs.attempts+1,error_code=NULL,snapshot=EXCLUDED.snapshot,updated_at=now() RETURNING *`,[id,p.ticker,p.asOf,snap.inputHash,JSON.stringify(snap)]);job=publicJob(r.rows[0]);await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  pending=run(job,snap).catch(()=>{}).finally(()=>{pending=null});return job;
 }
 async function ready(snap){
  const date=todayShanghai(now()),tickers=[snap.ticker,...snap.relations.map(r=>r.ticker)];
  if(tickers.some(t=>!t.endsWith('.HK'))&&!(await pool.query("SELECT 1 FROM market_data.daily_update_runs WHERE run_date=$1 AND status='succeeded'",[date])).rows.length)return false;
  const hk=tickers.filter(t=>t.endsWith('.HK'));if(!hk.length)return true;
  const r=await pool.query(`SELECT count(*)::integer n FROM market_data.hk_listed_universe u WHERE active AND ts_code=ANY($2::text[]) AND NOT EXISTS(SELECT 1 FROM market_data.hk_market_symbol_attempts a WHERE a.run_date=$1 AND a.ts_code=u.ts_code AND a.status IN ('completed','no_data','failed'))`,[date,hk]);return r.rows[0].n===0;
 }
 async function updateAll({manual=false}={}){
  if(closing||(!manual&&!enabled))return{status:'disabled'};if(allPending)return allPending;
  allPending=(async()=>{const result={succeeded:0,failed:0,skipped:0,deferred:0};
   for(const ticker of await watchlistStore.union()){
    if(closing)break;
    try{const snap=await snapshot({ticker,asOf:todayShanghai(now())});if(!manual&&!await ready(snap)){result.deferred++;continue;}
     // Manual batch also reuses already-current successful reports.
     const saved=await current(ticker);if(saved?.input_hash===snap.inputHash){result.skipped++;continue;}
     const job=await start({ticker},{automatic:!manual});if(job.status==='skipped'){result.skipped++;continue;}
     if(pending)await pending;else if(job.status==='running'){result.deferred++;continue;}
     const done=await latest(ticker);result[done?.status==='succeeded'?'succeeded':'failed']++;
     if(/BALANCE|AUTH|PERMISSION|CONFIG|API_KEY/.test(done?.errorCode||''))break;
    }catch(e){if(e.code==='RELATIVE_BUSY'){result.deferred++;continue;}if(['RELATIVE_NO_RELATIONS','RELATIVE_NO_COMPARISON','RELATIVE_RETRY_LIMIT'].includes(e.code)){result.skipped++;continue;}result.failed++;emit({type:'relation_attribution_batch_failed',ticker,code:e.code??'unknown'});if(/BALANCE|AUTH|PERMISSION|CONFIG|API_KEY/.test(e.code||''))break;}
   }
   lastResult=result;emit({type:'relation_attribution_batch',...result});return result;
  })().finally(()=>{allPending=null});return allPending;
 }
 return {
  async migrate(){await pool.query(`CREATE TABLE IF NOT EXISTS market_data.company_relation_attributions(ticker text PRIMARY KEY,input_hash text NOT NULL,relation_hash text NOT NULL,quote_date date NOT NULL,report jsonb NOT NULL,generated_at timestamptz NOT NULL);
   CREATE TABLE IF NOT EXISTS market_data.company_relation_attribution_jobs(job_id uuid PRIMARY KEY,ticker text NOT NULL,run_date date NOT NULL,input_hash text NOT NULL,status text NOT NULL CHECK(status IN ('running','succeeded','failed')),stage text NOT NULL,attempts integer NOT NULL DEFAULT 1,snapshot jsonb NOT NULL,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(ticker,run_date,input_hash));
   CREATE UNIQUE INDEX IF NOT EXISTS relation_attribution_one_running ON market_data.company_relation_attribution_jobs((true)) WHERE status='running';`);},
  async get(raw){const p=input(raw);await sweep();const [saved,job]=await Promise.all([current(p.ticker),latest(p.ticker)]);let snap=null,error=null;try{snap=await snapshot(p)}catch(e){error=e.message;}
   const report=saved?.report??null;const visible=report&&report.snapshot.quoteDate<=p.asOf&&todayShanghai(new Date(report.generatedAt))<=p.asOf?report:null;
   return {ticker:p.ticker,report:visible,job,freshness:!snap?'unavailable':!visible?'missing':visible.snapshot.relationHash!==snap.relationHash?'relations_changed':visible.inputHash===snap.inputHash?'fresh':'stale',reason:error,currentSnapshot:snap,historical:p.asOf!==todayShanghai(now())};},
  start,updateAll,
  async getJob(id){if(!/^[a-f0-9-]{36}$/.test(id))throw invalid();await sweep();return publicJob((await pool.query('SELECT * FROM market_data.company_relation_attribution_jobs WHERE job_id=$1',[id])).rows[0]);},
  status:()=>({enabled,running:!!allPending||!!pending,lastResult}),
  triggerAll(){const work=allPending?allPending.then(()=>updateAll({manual:true})):updateAll({manual:true});void work.catch(()=>{});},
  startDaily(){if(timer||!enabled)return;const tick=()=>{const h=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(now()));if(h>=6)void updateAll().catch(()=>{});};timer=setInterval(tick,60000);timer.unref?.();tick();},
  async close(){closing=true;clearInterval(timer);await allPending;await pending;await pool.end();}
 };
}
