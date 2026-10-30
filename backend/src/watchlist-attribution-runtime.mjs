import pg from 'pg';
import { todayShanghai } from './input.mjs';
export function createWatchlistAttributionRuntime({ connectionString, watchlistStore, service, enabled=true, log=()=>{}, now=()=>new Date(), pollMs=60000, pool: injectedPool }) {
 const pool=injectedPool??new pg.Pool({connectionString,max:2,connectionTimeoutMillis:10000});let timer,inFlight,closing=false,lastResult=null;
 const emit=x=>{try{log(x)}catch{}};
 async function migrate(){await pool.query(`CREATE TABLE IF NOT EXISTS market_data.watchlist_attribution_runs (
 run_date date NOT NULL,ticker text NOT NULL,period text NOT NULL CHECK(period IN ('1m','6m','1y')),quote_date date NOT NULL,
 status text NOT NULL CHECK(status IN ('running','succeeded','failed')),attempts integer NOT NULL DEFAULT 1,
 job_id uuid,error_code text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(run_date,ticker,period,quote_date));`)}
 async function perform({force=false}={}){
  const runDate=todayShanghai(now()), summary={runDate,stocks:0,succeeded:0,failed:0,skipped:0,deferred:0};
  const lock=await pool.connect();let locked=false;
  try{
   locked=(await lock.query('SELECT pg_try_advisory_lock(786215,62) locked')).rows[0].locked;if(!locked)return{status:'busy'};
   for(const ticker of await watchlistStore.union()){
    if(closing)break; summary.stocks++;
    try{
     if(!force){
      const ready=ticker.endsWith('.HK')
       ? await pool.query("SELECT 1 FROM market_data.hk_market_symbol_attempts WHERE run_date=$1 AND ts_code=$2 AND status='completed'",[runDate,ticker])
       : await pool.query("SELECT 1 FROM market_data.daily_update_runs WHERE run_date=$1 AND status='succeeded'",[runDate]);
      if(!ready.rows.length){summary.deferred++;continue;}
     }
     const state=await service.get({ticker});
     if(state.job?.status==='running'){summary.deferred++;continue;}
     const periods=[], dates={};
     for(const period of ['1m','6m','1y']){
      const item=state.periods[period], to=item?.currentMetrics?.to;
      if(!to){summary.deferred++;continue;}
      if(item.report?.to>=to){
       await pool.query(`UPDATE market_data.watchlist_attribution_runs SET status='succeeded',error_code=NULL,updated_at=now() WHERE ticker=$1 AND period=$2 AND quote_date=$3 AND status='running'`,[ticker,period,to]);
       summary.skipped++;continue;
      }
      const r=await pool.query(`INSERT INTO market_data.watchlist_attribution_runs(run_date,ticker,period,quote_date,status)
       VALUES($1,$2,$3,$4,'running') ON CONFLICT(run_date,ticker,period,quote_date) DO UPDATE SET
       status='running',attempts=watchlist_attribution_runs.attempts+1,error_code=NULL,updated_at=now()
       WHERE watchlist_attribution_runs.status<>'succeeded' AND watchlist_attribution_runs.attempts<3
       AND ($5::boolean OR watchlist_attribution_runs.updated_at < now()-interval '15 minutes') RETURNING period`,[runDate,ticker,period,to,force]);
      if(r.rows.length){periods.push(period);dates[period]=to;}else summary.deferred++;
     }
     if(!periods.length)continue;
     let job;
     try{
      job=await service.start({ticker,periods});
      await pool.query(`UPDATE market_data.watchlist_attribution_runs SET job_id=$1 WHERE run_date=$2 AND ticker=$3 AND period=ANY($4::text[]) AND status='running'`,[job.jobId,runDate,ticker,periods]);
      while(job.status==='running') {
       await new Promise(resolve=>setTimeout(resolve,3000));job=await service.getJob(job.jobId);
       for(const period of periods) if(job.periods[period]?.status==='succeeded') await pool.query(`UPDATE market_data.watchlist_attribution_runs SET status='succeeded',error_code=NULL,updated_at=now() WHERE run_date=$1 AND ticker=$2 AND period=$3 AND quote_date=$4 AND status='running'`,[runDate,ticker,period,dates[period]]);
      }
      for(const period of periods){
       const p=job.periods[period],ok=p?.status==='succeeded';
       await pool.query(`UPDATE market_data.watchlist_attribution_runs SET status=$1,error_code=$2,updated_at=now() WHERE run_date=$3 AND ticker=$4 AND period=$5 AND quote_date=$6`,[ok?'succeeded':'failed',ok?null:p?.error?.code??'ATTRIBUTION_FAILED',runDate,ticker,period,dates[period]]);
       summary[ok?'succeeded':'failed']++;
       if(!ok && /INSUFFICIENT_BALANCE|AI_NOT_AVAILABLE|DATABASE_UNAVAILABLE/.test(p?.error?.code??''))summary.blocked=true;
      }
     }catch(error){
      await pool.query(`UPDATE market_data.watchlist_attribution_runs SET status='failed',error_code=$1,updated_at=now() WHERE run_date=$2 AND ticker=$3 AND period=ANY($4::text[]) AND status='running'`,[error.code??'ATTRIBUTION_FAILED',runDate,ticker,periods]);summary.failed+=periods.length;
     }
    }catch(error){summary.deferred++;emit({type:'watchlist_attribution_deferred',ticker,code:error.code??'unknown'});}
    if(summary.blocked)break;
   }
   return {status:summary.failed?'partial':summary.deferred?'waiting':'completed',...summary};
  }finally{if(locked)await lock.query('SELECT pg_advisory_unlock(786215,62)');lock.release();}
 }
 function runOnce(options={}){
  if(closing||(!enabled&&!options.force))return Promise.resolve({status:'disabled'});if(inFlight)return inFlight;
  inFlight=perform(options).then(result=>{lastResult=result;emit({type:'watchlist_attribution_update',...result});return result}).finally(()=>{inFlight=null});return inFlight;
 }
 return {migrate,runOnce,trigger(){const work=inFlight?inFlight.then(()=>runOnce({force:true})):runOnce({force:true});void work.catch(()=>{});},snapshot:()=>({enabled,running:!!inFlight,lastResult}),start(){if(timer||!enabled)return;const tick=()=>{const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(now()));if(hour>=6)void runOnce().catch(()=>{});};timer=setInterval(tick,pollMs);timer.unref?.();tick();},async close(){closing=true;clearInterval(timer);await inFlight;await pool.end();}};
}
