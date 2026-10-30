import { ResearchError } from './errors.mjs';
import { todayShanghai, validDate } from './input.mjs';

const TICKER = /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = new Set(['queued', 'searching', 'fetching', 'analyzing', 'validating', 'saving']);
const messages = { queued: '识别任务已创建。', searching: '正在联网查找公司公告、年报和新闻…', fetching: '正在读取公开资料正文…',
  analyzing: '正在根据正文识别上游、同行和下游…', validating: '正在校验上市证券与来源依据…', saving: '正在保存识别结果…' };
const invalid = message => new ResearchError('INVALID_RELATIONS_RESEARCH', message, 400);
function input(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['ticker', 'asOf'].includes(key))) throw invalid('识别请求只接受 ticker 和 asOf。');
  const ticker = typeof raw.ticker === 'string' ? raw.ticker.trim().toUpperCase() : '';
  if (!TICKER.test(ticker)) throw invalid('AI 识别仅支持 A 股及五位港股公司代码。');
  const asOf = raw.asOf ?? todayShanghai(now());
  if (!validDate(asOf) || asOf > todayShanghai(now())) throw invalid('研究日期无效或晚于今日。');
  return { ticker, asOf };
}
function failureCode(error) {
  const code = error instanceof ResearchError ? error.code : '';
  if (code === 'DEEPSEEK_INSUFFICIENT_BALANCE') return 'RELATIONS_AI_INSUFFICIENT_BALANCE';
  if (/TIMEOUT/.test(code)) return 'RELATIONS_AI_TIMEOUT';
  if (/RATE_LIMIT/.test(code)) return 'RELATIONS_AI_RATE_LIMITED';
  if (/SEARCH|SOURCES_UNVERIFIED/.test(code)) return 'RELATIONS_AI_SEARCH_ERROR';
  if (/CONNECTION|NETWORK/.test(code)) return 'RELATIONS_AI_NETWORK_ERROR';
  if (/DATABASE/.test(code)) return 'RELATIONS_AI_DATABASE_ERROR';
  if (/INVALID|CONFLICT/.test(code)) return 'RELATIONS_AI_INVALID_RESULT';
  return 'RELATIONS_AI_PROVIDER_ERROR';
}
function present(job) {
  if (!job) return null;
  const relations = Array.isArray(job.relations) ? job.relations : [], gaps = Array.isArray(job.gaps) ? job.gaps : [];
  const relationCount = job.relationCount ?? relations.length;
  return { jobId: job.jobId, ticker: job.ticker, asOf: job.asOf, status: job.status, stage: job.stage,
    provider: job.provider, model: job.model, createdAt: job.createdAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt,
    message: job.status === 'succeeded' ? relationCount ? `已更新并保存 ${relationCount} 家关联公司，优先保留已有公司。`
      : '本次未找到有充分证据的关联公司，未改动已有关系。'
      : job.status === 'failed' ? job.errorMessage || 'AI 识别失败，请重试。' : messages[job.stage] || messages.queued,
    ...(job.status === 'succeeded' ? { result: { relationCount, gaps, retainedPrevious: relationCount === 0,
      ...(job.refreshSummary ? {refreshSummary:job.refreshSummary} : {}) } } : {}),
    ...(job.status === 'failed' ? { error: { code: job.errorCode || 'RELATIONS_AI_FAILED', message: job.errorMessage || 'AI 识别失败，请重试。' } } : {}) };
}

/** A click starts one durable job; polling never starts or repeats inference. */
export function createRelationsAiService({ store, client, prompt, configured = false, provider = 'deepseek', model,
  now = () => new Date(), maxConcurrent = 2, heartbeatMs = 15000, log = () => {} } = {}) {
  if (!store || typeof store.createJob !== 'function' || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4
    || !Number.isInteger(heartbeatMs) || heartbeatMs < 50) throw new TypeError('AI 关系识别服务配置无效。');
  const starts = new Map(), running = new Map();
  let starting = 0, closing = false, lastSweep = -Infinity;
  const safeLog = value => { try { log(value); } catch {} };
  async function sweep() {
    const current = now().getTime();
    if (current - lastSweep < 30000) return;
    lastSweep = current;
    await store.expireStaleJobs({ olderThanMs: 600000 });
  }
  async function run(job, frozen) {
    let stage = 'queued', progress = Promise.resolve();
    const setStage = next => {
      if (!STAGES.has(next)) return progress;
      stage = next;
      const savedStage = stage;
      progress = progress.then(() => store.updateProgress({ jobId: job.jobId, stage: savedStage }));
      // A heartbeat failure is surfaced before completion; avoid an unhandled
      // rejection while a network request is still waiting for its response.
      progress.catch(() => {});
      return progress;
    };
    const heartbeat = setInterval(() => { void setStage(stage).catch(() => {}); }, heartbeatMs);
    heartbeat.unref?.();
    try {
      const existing = typeof store.getExistingRelations==='function' ? await store.getExistingRelations({ticker:job.ticker,asOf:job.asOf}) : [];
      const active = new Set(frozen.candidates.map(row=>row.ticker));
      const report = await client.researchRelations({ ...frozen.subject, ticker: frozen.subject.ticker,
        companyName: frozen.subject.name, asOf: job.asOf, candidates: [frozen.subject, ...frozen.candidates],
        existingRelations:existing.filter(row=>active.has(row.relatedTicker)) }, prompt, { onProgress: setStage });
      await setStage('validating');
      if (!report || report.provider !== provider || !Array.isArray(report.relations) || !Array.isArray(report.gaps)
        || report.retrievalEvidence?.origin !== 'deepseek-search' || !Array.isArray(report.retrievalEvidence.sources)
        || !report.retrievalEvidence.sources.length) throw new ResearchError('INVALID_RELATIONS_AI_RESULT', '识别结果缺少本次联网来源。', 502);
      await setStage('saving');
      clearInterval(heartbeat);
      await progress;
      const saved = await store.completeJob({ jobId: job.jobId, relations: report.relations,
        gaps:[...new Set([...report.gaps,...(report.changeGaps??[])])].slice(0,100),
        researchedAt: now().toISOString(), audit: { provider, model: report.model || model, ...(report.evidenceMode?{evidenceMode:report.evidenceMode}:{}),
          candidateHash: frozen.candidateHash, retrievalEvidence: report.retrievalEvidence,
          approvedChanges:report.changes??[],rejectedChangeCount:report.changeGaps?.length??0 } });
      safeLog({ type: 'relations_ai_completed', jobId: job.jobId, ticker: job.ticker, asOf: job.asOf, relationCount: saved.relations.length });
    } catch (error) {
      clearInterval(heartbeat);
      try { await progress; } catch {}
      const errorCode = failureCode(error);
      await store.failJob({ jobId: job.jobId, errorCode });
      safeLog({ type: 'relations_ai_failed', jobId: job.jobId, ticker: job.ticker, errorCode });
    } finally { clearInterval(heartbeat); }
  }
  async function begin(params) {
    if (closing) throw new ResearchError('RELATIONS_AI_CLOSING', '服务正在重启，请稍后重试。', 503);
    if (!configured || provider !== 'deepseek' || typeof client?.researchRelations !== 'function' || typeof prompt !== 'string' || !prompt.trim()) {
      throw new ResearchError('RELATIONS_AI_NOT_CONFIGURED', '请在后端配置 DeepSeek API 后使用联网识别。', 503);
    }
    if (params.asOf !== todayShanghai(now())) throw new ResearchError('RELATIONS_AI_HISTORICAL_READ_ONLY', '历史日期可查看已保存的关系；联网识别请先将研究截止日期切回今日。', 400);
    await sweep();
    const existing = await store.getLatestJob(params);
    if (existing?.status === 'running' && existing.asOf === params.asOf) return present(existing);
    if (running.size + starting >= maxConcurrent) throw new ResearchError('RELATIONS_AI_BUSY', '当前 AI 识别任务较多，请等待已有任务完成。', 429);
    starting++;
    try {
      const frozen = await store.listCandidates(params);
      const { created, job } = await store.createJob({ ...params, provider, model,
        candidateHash: frozen.candidateHash, candidateCount: frozen.candidates.length });
      if (created) {
        const pending = run(job, frozen).catch(() => {
          safeLog({ type: 'relations_ai_persistence_failed', jobId: job.jobId, errorCode: 'RELATIONS_AI_DATABASE_ERROR' });
        }).finally(() => { running.delete(job.jobId); });
        running.set(job.jobId, pending);
      }
      return present(job);
    } finally { starting--; }
  }
  return {
    async start(raw) {
      const params = input(raw, now), key = `${params.ticker}:${params.asOf}`;
      if (starts.has(key)) return starts.get(key);
      const pending = begin(params); starts.set(key, pending);
      try { return await pending; } finally { starts.delete(key); }
    },
    async get(raw = {}) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('识别任务查询无效。');
      await sweep();
      if (Object.hasOwn(raw, 'jobId')) {
        if (Object.keys(raw).length !== 1 || typeof raw.jobId !== 'string' || !UUID.test(raw.jobId)) throw invalid('识别任务标识无效。');
        return present(await store.getJob(raw.jobId));
      }
      const params = input(raw, now), job = await store.getLatestJob(params);
      if (job?.status === 'succeeded' && (job.relationCount ?? job.relations?.length ?? 0)>0 && job.isCurrent === false) return null;
      return present(job?.asOf === params.asOf ? job : null);
    },
    async close() { closing = true; await Promise.allSettled([...starts.values()]); await Promise.allSettled([...running.values()]); },
  };
}
