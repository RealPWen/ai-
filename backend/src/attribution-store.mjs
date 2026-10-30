import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { ResearchError } from './errors.mjs';
import { validDate } from './input.mjs';
import { ATTRIBUTION_PERIODS } from './attribution-snapshot.mjs';
import { validateAttributionSnapshot } from './attribution-ai-evidence.mjs';
import { canonicalUrl } from './source-audit.mjs';

const unavailable = () => new ResearchError('ATTRIBUTION_DATABASE_UNAVAILABLE', '涨跌归因数据库暂不可用，请稍后重试。', 503);
const invalid = () => new ResearchError('INVALID_ATTRIBUTION_REPORT', '本次归因结果未通过校验，原有报告已保留。', 502);
const conflict = () => new ResearchError('ATTRIBUTION_JOB_CONFLICT', '归因任务已结束或被更新，请重新读取结果。', 409);
const safeTicker = value => typeof value === 'string' && /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value, max = 12000) => typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0');
const iso = value => value == null ? null : new Date(value).toISOString();
function webUrl(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }
export function validateAttributionReport(report, snapshot, now = new Date()) {
  if (!object(report) || !object(snapshot)) throw invalid();
  const newsMode=report.evidenceMode==='news_summary';
  const newsWindow={from:snapshot.newsFrom??snapshot.coverage?.requestedFrom??snapshot.from,to:snapshot.newsTo??snapshot.to};
  if(newsMode&&(!isDeepStrictEqual(report.newsWindow,newsWindow)||!object(report.newsCoverage)
    ||!['stock','sector'].every(kind=>Number.isInteger(report.newsCoverage[kind])&&report.newsCoverage[kind]>=0)
    ||report.newsCoverage.stock+report.newsCoverage.sector<1||!isDeepStrictEqual(report.sector,snapshot.sector)))throw invalid();
  for (const key of ['ticker','period','inputHash','from','to','requestedAsOf','companyName','adjustment','currency']) if (report[key] !== snapshot[key]) throw invalid();
  for (const key of ['stockReturn','indexReturn','excessPercentagePoints']) if (!Number.isFinite(report[key]) || report[key] !== snapshot[key]) throw invalid();
  if (!isDeepStrictEqual(report.benchmark,snapshot.benchmark) || !isDeepStrictEqual(report.coverage,snapshot.coverage)) throw invalid();
  if (!nonempty(report.summary) || !nonempty(report.model,200) || !nonempty(report.promptVersion,200) || report.provider !== 'deepseek'
    || !nonempty(report.generatedAt,64) || !Number.isFinite(Date.parse(report.generatedAt)) || Date.parse(report.generatedAt) > now.getTime() + 300000
    || !Array.isArray(report.drivers) || report.drivers.length > 5 || !Array.isArray(report.sources) || !report.sources.length || report.sources.length > 32
    || !Array.isArray(report.limitations) || report.limitations.length > 20 || report.limitations.some(item => !nonempty(item))
    || !['identified','not_identified','uncertain'].includes(report.corporateActionStatus)
    || report.retrievalEvidence?.origin !== 'deepseek-search') throw invalid();
  const sources = new Map();
  if (!Array.isArray(report.retrievalEvidence.sources)) throw invalid();
  const retrieved = new Map();
  for (const source of report.retrievalEvidence.sources) {
    if (!object(source) || !nonempty(source.id,100) || retrieved.has(source.id)) throw invalid();
    retrieved.set(source.id,source);
  }
  for (const source of report.sources) {
    const original = retrieved.get(source?.id);
    if (!object(source) || !nonempty(source.id,100) || sources.has(source.id) || !nonempty(source.title,1000) || !webUrl(source.url) || source.citationVerified !== true
      || !validDate(source.publishedAt) || source.publishedAt < (newsMode?newsWindow.from:snapshot.from) || source.publishedAt > (newsMode?newsWindow.to:snapshot.to)
      || !original || canonicalUrl(original.url) !== canonicalUrl(source.url) || original.publishedAt !== source.publishedAt
      || original.title !== source.title || !(newsMode?['partial_text','search_snippet']:['partial_text']).includes(original.readingScope) || original.eligibleForDriver !== true
      || !Number.isInteger(original.contentLength) || original.contentLength < 8 || !/^[a-f0-9]{64}$/.test(original.contentSha256 ?? '')) throw invalid();
    if(newsMode&&(!Array.isArray(source.newsKinds)||!source.newsKinds.length||new Set(source.newsKinds).size!==source.newsKinds.length||source.newsKinds.some(kind=>!['stock','sector'].includes(kind))
      ||!isDeepStrictEqual(source.newsKinds,original.newsKinds)||source.readingScope!==original.readingScope))throw invalid();
    sources.set(source.id,source);
  }
  if(newsMode)for(const kind of ['stock','sector'])if(report.newsCoverage[kind]!==[...sources.values()].filter(source=>source.newsKinds.includes(kind)).length)throw invalid();
  for (const driver of report.drivers) {
    if (!object(driver) || !nonempty(driver.title,1000) || !nonempty(driver.explanation) || !['company','industry','market','valuation','capital','corporate_action','other'].includes(driver.category)
      || !['positive','negative','mixed','uncertain'].includes(driver.direction) || !Array.isArray(driver.evidence) || !driver.evidence.length || driver.evidence.length > 8) throw invalid();
    for (const evidence of driver.evidence) if (!object(evidence) || !sources.has(evidence.sourceId) || (!newsMode&&!nonempty(evidence.quote,2000)) || evidence.citationVerified !== true) throw invalid();
  }
  let encoded; try { encoded = JSON.stringify(report); } catch { throw invalid(); }
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024 || encoded.includes('\\u0000')) throw invalid();
  return JSON.parse(encoded);
}
function job(row) {
  return row ? { jobId: row.job_id, ticker: row.ticker, requestedAsOf: typeof row.as_of === 'string' ? row.as_of.slice(0,10) : iso(row.as_of).slice(0,10), status: row.status, stage: row.stage,
    periods: row.periods, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), finishedAt: iso(row.finished_at) } : null;
}
const FIELDS = "job_id::text,ticker,to_char(as_of,'YYYY-MM-DD') AS as_of,status,stage,periods,created_at,updated_at,finished_at";
export function createAttributionStore({ connectionString, pool: injectedPool, now = () => new Date() } = {}) {
  if (!injectedPool && !connectionString?.trim()) throw unavailable();
  const pool = injectedPool ?? new pg.Pool({ connectionString, max:4, connectionTimeoutMillis:10000, query_timeout:20000 });
  if (!injectedPool) pool.on('error',() => {});
  async function query(sql,values) { try { return await pool.query(sql,values); } catch { throw unavailable(); } }
  async function transaction(operation) {
    let client; try { client = await pool.connect(); await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
    catch (error) { if (client) try { await client.query('ROLLBACK'); } catch {} throw error instanceof ResearchError ? error : unavailable(); }
    finally { client?.release(); }
  }
  return {
    async migrate() { await query(await readFile(new URL('./attribution-schema.sql',import.meta.url),'utf8')); },
    async listReports(ticker) {
      if (!safeTicker(ticker)) throw invalid();
      const result = await query('SELECT period,report FROM market_data.stock_return_attributions WHERE ticker=$1',[ticker]);
      return Object.fromEntries(result.rows.map(row => [row.period,row.report]));
    },
    async getLatestJob(ticker) {
      if (!safeTicker(ticker)) throw invalid();
      const result = await query(`SELECT ${FIELDS} FROM market_data.stock_return_attribution_jobs WHERE ticker=$1 ORDER BY created_at DESC,job_id DESC LIMIT 1`,[ticker]); return job(result.rows[0]);
    },
    async getJob(id) {
      if (!uuid(id)) throw new ResearchError('INVALID_ATTRIBUTION_JOB','归因任务编号无效。',400);
      const result = await query(`SELECT ${FIELDS} FROM market_data.stock_return_attribution_jobs WHERE job_id=$1::uuid`,[id]);
      if (!result.rows.length) throw new ResearchError('ATTRIBUTION_JOB_NOT_FOUND','归因任务不存在。',404); return job(result.rows[0]);
    },
    async createJob({ ticker, asOf, periods, snapshots, errors = {} }) {
      if (!safeTicker(ticker) || !validDate(asOf) || !Array.isArray(periods) || !periods.length || periods.length > 3 || new Set(periods).size !== periods.length
        || periods.some(period => !ATTRIBUTION_PERIODS.includes(period)) || !object(snapshots) || !object(errors)
        || Object.keys(snapshots).some(period => !periods.includes(period)) || Object.keys(errors).some(period => !periods.includes(period))) throw invalid();
      for (const period of periods) {
        if (errors[period]) {
          if (!nonempty(errors[period].code,100) || !nonempty(errors[period].message,1000)) throw invalid();
          continue;
        }
        const snapshot = snapshots[period];
        try { validateAttributionSnapshot(snapshot); } catch { throw invalid(); }
        if (snapshot.ticker !== ticker || snapshot.period !== period || snapshot.requestedAsOf !== asOf || !/^[a-f0-9]{64}$/.test(snapshot.inputHash)) throw invalid();
      }
      return transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('stock-return-attribution:create'))");
        const existing = await client.query(`SELECT ${FIELDS} FROM market_data.stock_return_attribution_jobs WHERE status='running' LIMIT 1`);
        if (existing.rows.length) {
          if (existing.rows[0].ticker === ticker) return { created:false,job:job(existing.rows[0]) };
          throw new ResearchError('ATTRIBUTION_BUSY','已有股票正在生成归因，请等待完成后再试。',429);
        }
        const states = Object.fromEntries(periods.map(period => [period,errors[period] ? { status:'failed',stage:'failed',error:errors[period] } : { status:'queued',stage:'queued' }]));
        const result = await client.query(`INSERT INTO market_data.stock_return_attribution_jobs(job_id,ticker,as_of,status,stage,periods,snapshots)
          VALUES($1::uuid,$2,$3::date,'running','queued',$4::jsonb,$5::jsonb) RETURNING ${FIELDS}`,[randomUUID(),ticker,asOf,JSON.stringify(states),JSON.stringify(snapshots)]);
        return { created:true,job:job(result.rows[0]) };
      });
    },
    async updateProgress({ jobId, period, stage }) {
      if (!uuid(jobId) || !ATTRIBUTION_PERIODS.includes(period) || !['queued','searching','fetching','analyzing','validating','saving'].includes(stage)) throw invalid();
      const result = await query(`UPDATE market_data.stock_return_attribution_jobs SET stage=$3,
        periods=jsonb_set(periods,ARRAY[$2::text],jsonb_build_object('status','running','stage',$3::text)),updated_at=clock_timestamp()
        WHERE job_id=$1::uuid AND status='running' AND periods ? $2 RETURNING ${FIELDS}`,[jobId,period,stage]);
      if (!result.rows.length) throw conflict(); return job(result.rows[0]);
    },
    async heartbeat(jobId) { if (!uuid(jobId)) throw invalid(); const result = await query("UPDATE market_data.stock_return_attribution_jobs SET updated_at=clock_timestamp() WHERE job_id=$1::uuid AND status='running' RETURNING job_id",[jobId]); if (!result.rows.length) throw conflict(); },
    async completePeriod({ jobId, period, report }) {
      if (!uuid(jobId) || !ATTRIBUTION_PERIODS.includes(period)) throw invalid();
      return transaction(async client => {
        const locked = await client.query(`SELECT ${FIELDS},snapshots FROM market_data.stock_return_attribution_jobs WHERE job_id=$1::uuid FOR UPDATE`,[jobId]);
        const row = locked.rows[0]; if (!row || row.status !== 'running' || !row.snapshots?.[period]
          || !row.periods?.[period] || !['queued','running'].includes(row.periods[period].status)) throw conflict();
        const value = validateAttributionReport(report,row.snapshots[period],now());
        await client.query(`INSERT INTO market_data.stock_return_attributions AS current_report(ticker,period,report,input_hash,generated_at,generation_started_at)
          VALUES($1,$2,$3::jsonb,$4,$5::timestamptz,$6::timestamptz) ON CONFLICT(ticker,period) DO UPDATE
          SET report=EXCLUDED.report,input_hash=EXCLUDED.input_hash,generated_at=EXCLUDED.generated_at,generation_started_at=EXCLUDED.generation_started_at,saved_at=clock_timestamp()
          WHERE current_report.generation_started_at<=EXCLUDED.generation_started_at`,[row.ticker,period,JSON.stringify(value),value.inputHash,value.generatedAt,iso(row.created_at)]);
        const states = { ...row.periods,[period]:{ status:'succeeded',stage:'completed' } };
        const result = await client.query(`UPDATE market_data.stock_return_attribution_jobs SET periods=$2::jsonb,updated_at=clock_timestamp() WHERE job_id=$1::uuid RETURNING ${FIELDS}`,[jobId,JSON.stringify(states)]);
        return job(result.rows[0]);
      });
    },
    async failPeriod({ jobId, period, error }) {
      if (!uuid(jobId) || !ATTRIBUTION_PERIODS.includes(period) || !nonempty(error?.code,100) || !nonempty(error?.message,1000)) throw invalid();
      const result = await query(`UPDATE market_data.stock_return_attribution_jobs SET periods=jsonb_set(periods,ARRAY[$2::text],$3::jsonb),updated_at=clock_timestamp()
        WHERE job_id=$1::uuid AND status='running' AND periods ? $2 RETURNING ${FIELDS}`,[jobId,period,JSON.stringify({status:'failed',stage:'failed',error})]);
      if (!result.rows.length) throw conflict(); return job(result.rows[0]);
    },
    async finishJob(jobId) {
      if (!uuid(jobId)) throw invalid();
      return transaction(async client => {
        const result = await client.query(`SELECT ${FIELDS} FROM market_data.stock_return_attribution_jobs WHERE job_id=$1::uuid FOR UPDATE`,[jobId]);
        const row=result.rows[0]; if (!row) throw conflict(); if (row.status!=='running') return job(row);
        const values=Object.values(row.periods); if (values.some(state=>!['succeeded','failed'].includes(state.status))) throw conflict();
        const status=values.every(state=>state.status==='succeeded')?'succeeded':values.some(state=>state.status==='succeeded')?'partial':'failed';
        const saved=await client.query(`UPDATE market_data.stock_return_attribution_jobs SET status=$2,stage='completed',updated_at=clock_timestamp(),finished_at=clock_timestamp() WHERE job_id=$1::uuid RETURNING ${FIELDS}`,[jobId,status]); return job(saved.rows[0]);
      });
    },
    async expireStaleJobs({ olderThanMs=90000 }={}) {
      if (!Number.isInteger(olderThanMs) || olderThanMs<1000) throw invalid();
      return transaction(async client=>{
        const result=await client.query(`SELECT ${FIELDS} FROM market_data.stock_return_attribution_jobs WHERE status='running' AND updated_at<clock_timestamp()-$1*interval '1 millisecond' FOR UPDATE`,[olderThanMs]);
        for(const row of result.rows){
          const states=Object.fromEntries(Object.entries(row.periods).map(([period,state])=>[period,['queued','running'].includes(state.status)?{status:'failed',stage:'failed',error:{code:'ATTRIBUTION_INTERRUPTED',message:'任务已中断，请手动重试；已保存报告仍保留。'}}:state]));
          const status=Object.values(states).some(state=>state.status==='succeeded')?'partial':'failed';
          await client.query("UPDATE market_data.stock_return_attribution_jobs SET status=$2,stage='interrupted',periods=$3::jsonb,updated_at=clock_timestamp(),finished_at=clock_timestamp() WHERE job_id=$1::uuid",[row.job_id,status,JSON.stringify(states)]);
        }
        return {expired:result.rows.length};
      });
    },
    async close() { try { await pool.end(); } catch { throw unavailable(); } },
  };
}
