import { createHash } from 'node:crypto';
import { ResearchError } from './errors.mjs';
import { ATTRIBUTION_PERIODS, attributionInput, buildAttributionSnapshot, publicAttributionMetrics } from './attribution-snapshot.mjs';
import { todayShanghai } from './input.mjs';

export function attributionFailure(error) {
  const code = error instanceof ResearchError ? error.code : '';
  if (/INSUFFICIENT_BALANCE/.test(code)) return { code:'ATTRIBUTION_INSUFFICIENT_BALANCE',message:'DeepSeek API 余额不足，未能生成归因。充值后可手动重试，已有报告仍保留。' };
  if (/AUTH_ERROR|PERMISSION_ERROR|CONFIG_ERROR|API_KEY_MISSING/.test(code)) return { code:'ATTRIBUTION_AI_NOT_AVAILABLE',message:'DeepSeek API 密钥、权限或模型配置不可用，请检查后端配置后重试。' };
  if (/DATABASE/.test(code)) return { code:'ATTRIBUTION_DATABASE_UNAVAILABLE',message:'归因数据库暂不可用，已保存报告仍保留。' };
  if (/BENCHMARK_MISSING/.test(code)) return { code:'ATTRIBUTION_BENCHMARK_MISSING',message:'该周期的指数对照尚未就绪，原有报告仍保留。' };
  if (/NO_COMMON_DATA|DATA_MISMATCH/.test(code)) return { code:'ATTRIBUTION_NO_COMMON_DATA',message:'该周期缺少足够且一致的股票与指数共同行情。' };
  if (/TIMEOUT/.test(code)) return { code:'ATTRIBUTION_TIMEOUT',message:'本周期研究超时，请手动重试；原有报告仍保留。' };
  if (/RATE_LIMIT/.test(code)) return { code:'ATTRIBUTION_RATE_LIMITED',message:'AI 接口暂时限流，请稍后重试。' };
  if (/NETWORK|CONNECTION/.test(code)) return { code:'ATTRIBUTION_NETWORK_ERROR',message:'联网检索或 AI 连接中断，请稍后手动重试；原有报告仍保留。' };
  if (/SOURCES_UNVERIFIED/.test(code)) return { code:'ATTRIBUTION_NEWS_UNAVAILABLE',message:'本周期暂未检索到有日期的个股或板块新闻，原有报告仍保留。' };
  if (/EVIDENCE|SOURCES|SEARCH/.test(code)) return { code:'ATTRIBUTION_NEWS_SEARCH_FAILED',message:'本次个股与板块新闻检索或整理未完成，原有报告仍保留。' };
  if (/INVALID/.test(code)) return { code:'INVALID_ATTRIBUTION_REPORT',message:'本次归因未通过校验，原有报告仍保留。' };
  return { code:'ATTRIBUTION_GENERATION_FAILED',message:'本周期归因未完成，请稍后重试；原有报告仍保留。' };
}
/** GETs only compare local data; inference starts exclusively through start(). */
export function createAttributionService({ store,marketService,client,prompt,sectorResolver,provider='deepseek',configured=false,now=()=>new Date(),heartbeatMs=15000,log=()=>{} }={}) {
  if (!store || !marketService || typeof prompt!=='string' || !prompt.trim() || !Number.isInteger(heartbeatMs) || heartbeatMs<50) throw new TypeError('归因服务配置无效。');
  const promptVersion=`return-attribution-v1-${createHash('sha256').update(prompt).digest('hex').slice(0,12)}`;
  const starts=new Map(),running=new Map(); let closing=false,lastSweep=-Infinity;
  const safeLog=value=>{try{log(value);}catch{}};
  async function sweep(){if(now().getTime()-lastSweep<30000)return; await store.expireStaleJobs(); lastSweep=now().getTime();}
  async function snapshotsFor({ticker,asOf,periods},{resolveSector=false}={}) {
    const profile=await marketService.profile({ticker});
    if (!profile || profile.ticker!==ticker) throw new ResearchError('UNKNOWN_SECURITY','该证券不在当前上市公司数据库中。',404);
    const snapshots={},errors={};
    const outcomes=await Promise.allSettled(periods.map(async period=>{
      const prices=await marketService.prices({ticker,asOf,period,adjustment:ticker.endsWith('.HK')?'none':'qfq',benchmark:ticker.endsWith('.HK')?'hsi':'sw2021_l3'});
      const sector=resolveSector?await sectorResolver?.resolve({ticker,profile,benchmark:prices.benchmark}):undefined;
      return buildAttributionSnapshot({ticker,period,asOf,profile,prices,sector});
    }));
    outcomes.forEach((outcome,index)=>{const period=periods[index]; if(outcome.status==='fulfilled')snapshots[period]=outcome.value;else errors[period]=attributionFailure(outcome.reason);});
    // An unavailable database must stop before starting a paid task.
    if(Object.values(errors).some(error=>error.code==='ATTRIBUTION_DATABASE_UNAVAILABLE'))throw new ResearchError('ATTRIBUTION_DATABASE_UNAVAILABLE','行情数据库暂不可用，请稍后重试。',503);
    return {snapshots,errors};
  }
  async function run(job,snapshots){
    let heartbeatFailure=null;
    const heartbeat=setInterval(()=>{void store.heartbeat(job.jobId).catch(error=>{heartbeatFailure=error;});},heartbeatMs); heartbeat.unref?.();
    try{
      for(const period of ATTRIBUTION_PERIODS){
        const snapshot=snapshots[period]; if(!snapshot)continue;
        let progress=Promise.resolve();
        const onProgress=stage=>{progress=progress.then(()=>{if(heartbeatFailure)throw heartbeatFailure; return store.updateProgress({jobId:job.jobId,period,stage});});progress.catch(()=>{});return progress;};
        try{
          await onProgress('searching');
          const result=await client.researchAttribution(snapshot,prompt,{onProgress});
          await onProgress('validating');
          if(heartbeatFailure)throw heartbeatFailure;
          const {series,...metrics}=snapshot;
          const report={...result,...metrics,generatedAt:now().toISOString(),provider,model:result.model,promptVersion};
          if(report.adjustment==='none'&&report.currency==='USD')report.limitations=[...report.limitations,'美元柜台个股与港元恒生指数的价格回报未进行汇率调整。'];
          await onProgress('saving');
          await store.completePeriod({jobId:job.jobId,period,report});
          safeLog({type:'attribution_period_saved',jobId:job.jobId,ticker:job.ticker,period,from:snapshot.from,to:snapshot.to});
        }catch(error){
          try{await progress;}catch{}
          await store.failPeriod({jobId:job.jobId,period,error:attributionFailure(error)});
          safeLog({type:'attribution_period_failed',jobId:job.jobId,ticker:job.ticker,period,code:error instanceof ResearchError?error.code:'unknown'});
          if(heartbeatFailure)throw heartbeatFailure;
          if(error instanceof ResearchError && /INSUFFICIENT_BALANCE|AUTH_ERROR|PERMISSION_ERROR|CONFIG_ERROR|API_KEY_MISSING|DATABASE/.test(error.code)){
            // A shared billing/configuration/database failure cannot be fixed
            // by sending two more paid requests for this same stock.
            for(const remaining of ATTRIBUTION_PERIODS.slice(ATTRIBUTION_PERIODS.indexOf(period)+1))if(snapshots[remaining])await store.failPeriod({jobId:job.jobId,period:remaining,error:attributionFailure(error)});
            break;
          }
        }
      }
      await store.finishJob(job.jobId);
    }finally{clearInterval(heartbeat);}
  }
  async function begin(params){
    if(closing)throw new ResearchError('ATTRIBUTION_CLOSING','服务正在关闭，请稍后重试。',503);
    if(!configured||provider!=='deepseek'||typeof client?.researchAttribution!=='function')throw new ResearchError('ATTRIBUTION_AI_NOT_CONFIGURED','请配置 DeepSeek API 后使用联网归因。',503);
    await sweep();
    const existing=await store.getLatestJob(params.ticker); if(existing?.status==='running')return existing;
    if(running.size)throw new ResearchError('ATTRIBUTION_BUSY','已有股票正在生成归因，请等待完成后再试。',429);
    const {snapshots,errors}=await snapshotsFor(params,{resolveSector:true});
    if(!Object.keys(snapshots).length)throw new ResearchError('ATTRIBUTION_DATA_NOT_READY','股票或指数的共同历史行情尚未就绪，未调用 AI。',409);
    const {created,job}=await store.createJob({...params,snapshots,errors});
    if(created){
      const pending=run(job,snapshots).catch(error=>{safeLog({type:'attribution_task_interrupted',jobId:job.jobId,ticker:job.ticker,code:attributionFailure(error).code});}).finally(()=>running.delete(job.jobId));
      running.set(job.jobId,pending);
    }
    return job;
  }
  return {
    promptVersion,
    async get(raw){
      const params=attributionInput(raw,{now:now()}); await sweep();
      const [reports,job,{snapshots,errors}]=await Promise.all([store.listReports(params.ticker),store.getLatestJob(params.ticker),snapshotsFor(params)]);
      const periods=Object.fromEntries(ATTRIBUTION_PERIODS.map(period=>{
        const snapshot=snapshots[period],report=reports[period]??null;
        const freshness=!snapshot?'unavailable':!report?'missing':report.inputHash===snapshot.inputHash&&report.promptVersion===promptVersion?'fresh':'stale';
        return [period,{report,freshness,reason:errors[period]?.message??(freshness==='stale'?'行情或分析口径已有变化，请点击更新归因。':null),currentMetrics:publicAttributionMetrics(snapshot)}];
      }));
      return {ticker:params.ticker,requestedAsOf:params.asOf,periods,job,historical:params.asOf!==todayShanghai(now())};
    },
    async start(raw){
      const params=attributionInput(raw,{now:now(),generate:true});
      const pending=starts.get(params.ticker);if(pending)return pending;
      const work=begin(params);starts.set(params.ticker,work);try{return await work;}finally{starts.delete(params.ticker);}
    },
    async getJob(id){await sweep();return store.getJob(id);},
    async close(){closing=true;await Promise.allSettled([...starts.values()]);await Promise.allSettled([...running.values()]);},
  };
}
