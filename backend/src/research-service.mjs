import { auditReport } from './source-audit.mjs';
import { parseInput } from './input.mjs';
import { ResearchError } from './errors.mjs';
// asOf is accepted for legacy callers but deliberately ignored: saved reports
// are read by ticker, and a new web research always uses today's Shanghai date.
export function latestResearchInput(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ResearchError('INVALID_INPUT', '请求应为 JSON 对象', 400);
  return parseInput({ ticker: raw.ticker, companyName: raw.companyName }, now);
}

export function createDebatesService({ client, cache, store, prompt, promptVersion, model, provider = 'openai', now = () => new Date(), maxConcurrent = 2 }) {
  const storage = store ?? cache;
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function'
    || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2) throw new TypeError('核心分歧研究服务配置无效。');
  const inflight = new Map();
  let closing = false;
  return {
    async get(raw) {
      const input = latestResearchInput(raw, now()), report = await storage.get({ ticker: input.ticker });
      return report ? { ...report, cached: true } : null;
    },
    async generate(raw) {
      const input = latestResearchInput(raw, now()), key = input.ticker;
      if (closing) throw new ResearchError('RESEARCH_CLOSING', '服务正在关闭，请稍后重试', 503);
      if (inflight.has(key)) return inflight.get(key);
      if (inflight.size >= maxConcurrent) throw new ResearchError('RESEARCH_BUSY', '当前研究任务较多，请等待已有任务完成', 429);
      const job = (async () => {
        const { report: rawReport, response, retrievalEvidence, pipeline } = await client.research(input, prompt);
        const audited = auditReport(rawReport, response, input, retrievalEvidence);
        if (audited.company.identityStatus !== 'verified' || !audited.sources.some(source => source.citationVerified)
          || ![audited.company.name, audited.company.description, audited.summary].every(value => typeof value === 'string' && value.trim())) {
          throw new ResearchError('INVALID_RESEARCH_EVIDENCE', '本次研究未能核实公司身份或取得可追溯来源，已有报告已保留', 502);
        }
        const generatedAt = now().toISOString(), selectedModel = typeof response.model === 'string' && response.model.trim() ? response.model : model;
        if (typeof selectedModel !== 'string' || !selectedModel.trim()) throw new ResearchError('INVALID_RESEARCH_RESULT', '本次研究缺少有效模型信息，已有报告已保留', 502);
        const report = { ...audited, ticker: input.ticker, asOf: input.asOf, windowStart: input.windowStart,
          generatedAt, updatedAt: generatedAt, provider, model: selectedModel, promptVersion, cached: false,
          ...(pipeline ? { pipeline: { ...pipeline, ima: { ...pipeline.ima, citedCount: audited.sources.filter(source => source.sourceKind === 'ima').length } } } : {}) };
        if (pipeline) report.limitations = [...new Set([...report.limitations, pipeline.ima.message,
          ...(pipeline.ima.partial ? ['ima 资料读取未全部完成，本次只使用已取得的证据。'] : [])])];
        const saved = await storage.set({ ticker: input.ticker }, report);
        // A store may reject an older concurrent write and return its newer
        // report. Preserve that report's provider, dates and cached flag.
        return saved && typeof saved === 'object' && saved.ticker === input.ticker ? saved : report;
      })();
      inflight.set(key, job);
      try { return await job; } finally { inflight.delete(key); }
    },
    async close() { closing = true; await Promise.allSettled([...inflight.values()]); },
  };
}
