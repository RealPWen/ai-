import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import pg from 'pg';
import { ResearchError } from '../src/errors.mjs';
import { todayShanghai, validDate } from '../src/input.mjs';
import { migrateRelationsCurrent } from './relations-current-migration.mjs';
import { mergeManualRelations } from './relations-manual-store.mjs';
import { applyRelationsRetention } from '../src/relations-retention.mjs';

export const RELATIONS_AI_METHOD_VERSION = 'ah-relations-ai-v6-coverage-retain10';
const TICKER = /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const TYPES = ['upstream', 'peer', 'downstream'];
const EVIDENCE = ['direct_business', 'technical_cooperation', 'industry_position', 'business_comparable'];
const STAGES = ['queued', 'searching', 'fetching', 'analyzing', 'validating', 'saving', 'completed', 'failed'];
const SAFE_ERRORS = new Map([
  ['RELATIONS_AI_INSUFFICIENT_BALANCE', 'DeepSeek API 余额不足，请充值后重新识别。'],
  ['RELATIONS_AI_INTERRUPTED', '识别任务长时间未更新，已标记中断，可重新识别。'],
  ['RELATIONS_AI_NOT_CONFIGURED', 'AI 识别服务尚未配置。'],
  ['RELATIONS_AI_PROVIDER_ERROR', 'AI 服务暂不可用，请稍后重试。'],
  ['RELATIONS_AI_SEARCH_ERROR', '联网检索暂不可用，请稍后重试。'],
  ['RELATIONS_AI_NETWORK_ERROR', '公开资料读取失败，请稍后重试。'],
  ['RELATIONS_AI_RATE_LIMITED', 'AI 服务请求频率受限，请稍后重试。'],
  ['RELATIONS_AI_TIMEOUT', 'AI 识别超时，请重新识别。'],
  ['RELATIONS_AI_INVALID_RESULT', '识别结果未通过证据校验，已有关系已保留。'],
  ['RELATIONS_AI_DATABASE_ERROR', '识别结果保存失败，请稍后重试。'],
  ['RELATIONS_AI_FAILED', 'AI 识别失败，请稍后重试。'],
]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => new ResearchError('INVALID_AI_RELATIONS', message, 400);
const unavailable = () => new ResearchError('RELATIONS_DATABASE_UNAVAILABLE', '公司关系数据库暂不可用，请稍后重试。', 503);
const conflict = () => new ResearchError('RELATIONS_AI_JOB_CONFLICT', '识别任务已结束或证券清单已变化，请重新识别。', 409);
function exact(value, fields, label) {
  if (!record(value) || Object.keys(value).some(key => !fields.includes(key))) throw invalid(`${label}含有不支持的字段。`);
}
function text(value, label, max = 4000, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\u0000')) throw invalid(`${label}无效。`);
  return value.trim();
}
function ticker(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!TICKER.test(code)) throw invalid('请输入有效的 A 股或五位港股代码。');
  return code;
}
function jobId(value) { if (typeof value !== 'string' || !UUID.test(value)) throw invalid('识别任务标识无效。'); return value.toLowerCase(); }
function timestamp(value, label) {
  if (typeof value !== 'string' || value.length > 64
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    || !validDate(value.slice(0, 10)) || +value.slice(11, 13) > 23 || !Number.isFinite(Date.parse(value))) throw invalid(`${label}须为含时区的 ISO 时间。`);
  return new Date(value).toISOString();
}
function safeUrl(value) {
  text(value, '来源地址', 4096);
  let url; try { url = new URL(value); } catch { throw invalid('来源地址无效。'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !host.includes('.')
    || isIP(host.replace(/^\[|\]$/g, '')) || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)
    || /^(?:0x[\da-f]+|\d+)$/.test(host)) throw invalid('来源须为可公开访问且不含登录信息的 HTTP(S) 地址。');
  return url.href;
}
function referenceIds(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20 || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) || new Set(value).size !== value.length) throw invalid(`${label}无效。`);
  return [...value];
}
function parseInput(params, now) {
  exact(params, ['ticker', 'asOf'], '识别请求');
  const code = ticker(params.ticker), asOf = params.asOf ?? todayShanghai(now());
  if (!validDate(asOf) || asOf > todayShanghai(now())) throw invalid('识别日期须为有效的 YYYY-MM-DD，且不能晚于上海时区今日。');
  return { ticker: code, asOf };
}
const candidateHash = (subject, candidates) => createHash('sha256').update(JSON.stringify({ subject, candidates })).digest('hex');

/** Validate saved security identities and provenance. New summary-mode sources
 * bind to retrieved material; legacy reports retain their original excerpts. */
export function validateRelationsAiResult(payload, { ticker: subjectTicker, asOf, candidates, now = () => new Date() } = {}) {
  exact(payload, ['relations', 'gaps', 'researchedAt', 'audit'], '识别结果');
  const subject = ticker(subjectTicker);
  if (!validDate(asOf) || !Array.isArray(candidates)) throw invalid('冻结证券清单无效。');
  const researchedAt = timestamp(payload.researchedAt, '核验时间');
  const summaryMode=payload.audit?.evidenceMode==='relation_summary';
  if (Date.parse(researchedAt) > now().getTime() + 300_000 || todayShanghai(new Date(researchedAt)) > asOf) throw invalid('核验时间不能晚于研究截止日或当前时间。');
  const names = new Map(candidates.map(row => [row.ticker, row.name]));
  if (!Array.isArray(payload.relations) || payload.relations.length > 10) throw invalid('每只股票当前最多保存 10 家关联公司。');
  const seen = new Set();
  const relations = payload.relations.map((row, index) => {
    exact(row, ['relatedTicker', 'relatedName', 'relationType', 'evidenceType', 'rank', 'rationale', 'actualEntity', 'listedMappingBasis', 'notes', 'verifiedAt', 'sources', 'evidenceIds', 'sourceIds'], '关联公司');
    const relatedTicker = ticker(row.relatedTicker);
    if (relatedTicker === subject || seen.has(relatedTicker) || !names.has(relatedTicker)) throw invalid('关联公司须来自冻结的在市 A 股或港股清单，不能自关联或重复。');
    seen.add(relatedTicker);
    const relatedName = text(row.relatedName, '关联证券名称', 200);
    if (relatedName !== names.get(relatedTicker)) throw invalid('关联证券名称与冻结清单不符。');
    if (!TYPES.includes(row.relationType) || !EVIDENCE.includes(row.evidenceType)
      || (row.relationType === 'peer') !== (row.evidenceType === 'business_comparable')) throw invalid('关系或证据分类无效。同行须为业务可比证据，上下游须有相应业务证据。');
    if (row.rank !== undefined && row.rank !== index + 1) throw invalid('关系排序须与结果顺序一致。');
    if (row.verifiedAt !== undefined && timestamp(row.verifiedAt, '关系核验时间') !== researchedAt) throw invalid('关系核验时间须与本次实际核验时间一致。');
    if (!Array.isArray(row.sources) || !row.sources.length || row.sources.length > 20) throw invalid('每项关系须附 1 至 20 条已读取的来源。');
    const sources = row.sources.map(source => {
      exact(source, summaryMode?['url', 'title', 'publishedAt', 'excerpt', 'accessedAt', 'readingScope', 'sourceId','sourceKind','evidenceSummary']:['url', 'title', 'publishedAt', 'excerpt', 'accessedAt', 'readingScope', 'sourceId'], '来源');
      const publishedAt = source.publishedAt ?? null;
      if (publishedAt !== null && (!validDate(publishedAt) || publishedAt > asOf)) throw invalid('来源发布日期不能晚于研究截止日。');
      const accessedAt = timestamp(source.accessedAt, '来源读取时间');
      if (Date.parse(accessedAt) > Date.parse(researchedAt)) throw invalid('来源读取时间不能晚于实际核验时间。');
      if (!(summaryMode?['full_text','partial_text','search_snippet']:['full_text','partial_text']).includes(source.readingScope)) throw invalid('来源阅读范围无效。');
      const sourceId = source.sourceId === undefined ? undefined : referenceIds([source.sourceId], '来源标识')[0];
      if(summaryMode){
        if(!sourceId||!['page_text','search_summary'].includes(source.sourceKind)
          ||source.sourceKind==='search_summary'&&source.readingScope!=='search_snippet'
          ||source.sourceKind==='page_text'&&source.readingScope==='search_snippet')throw invalid('资料来源类型与阅读范围不一致。');
        const original=payload.audit?.retrievalEvidence?.sources?.find(item=>item.id===sourceId);
        if(!original||original.url!==source.url||original.title!==source.title||original.publishedAt!==publishedAt
          ||original.readingScope!==source.readingScope)throw invalid('关系引用须来自本次取得的真实资料。');
        return {url:safeUrl(source.url),title:text(source.title,'来源标题',1000),publishedAt,accessedAt,readingScope:source.readingScope,sourceId,
          sourceKind:source.sourceKind,evidenceSummary:text(source.evidenceSummary,'资料摘要',4000)};
      }
      return { url: safeUrl(source.url), title: text(source.title, '来源标题', 1000), publishedAt,
        excerpt: text(source.excerpt, '原文摘录', 10000), accessedAt, readingScope: source.readingScope,
        ...(sourceId === undefined ? {} : { sourceId }) };
    });
    const evidenceIds = referenceIds(row.evidenceIds, '证据引用'), sourceIds = referenceIds(row.sourceIds, '来源引用');
    return { relatedTicker, relatedName, relationType: row.relationType, evidenceType: row.evidenceType,
      rank: index + 1, rationale: text(row.rationale, '关系理由'), actualEntity: text(row.actualEntity, '实际业务主体', 2000),
      listedMappingBasis: text(row.listedMappingBasis, '上市主体映射依据'), notes: text(row.notes ?? '', '补充说明', 10000, true),
      verifiedAt: researchedAt, sources, ...(evidenceIds ? { evidenceIds } : {}), ...(sourceIds ? { sourceIds } : {}) };
  });
  const gaps = payload.gaps ?? [];
  if (!Array.isArray(gaps) || gaps.length > 100) throw invalid('缺口说明无效。');
  const checkedGaps = gaps.map(value => text(value, '缺口说明', 2000));
  const audit = payload.audit ?? {};
  if (!record(audit)) throw invalid('研究审计信息无效。');
  let auditJson; try { auditJson = JSON.stringify(audit); } catch { throw invalid('研究审计信息无效。'); }
  if (auditJson.length > 2_000_000 || auditJson.includes('\\u0000')) throw invalid('研究审计信息过长或含非法字符。');
  return { relations, gaps: checkedGaps, researchedAt, audit: JSON.parse(auditJson) };
}

const CANDIDATES_SQL = `SELECT s.ts_code, s.name, s.market, s.industry, to_char(s.list_date, 'YYYY-MM-DD') AS list_date,
    s.source, 'stock_basic'::text AS source_api
  FROM market_data.securities s WHERE s.market = 'A' AND s.list_status = 'L'
    AND s.ts_code ~ '^[0-9]{6}\\.(SH|SZ|BJ)$' AND (s.list_date IS NULL OR s.list_date <= $1::date)
    AND (s.delist_date IS NULL OR s.delist_date > $1::date)
  UNION ALL SELECT h.ts_code, h.name, 'HK' AS market, s.industry, to_char(h.list_date, 'YYYY-MM-DD') AS list_date,
    h.source, h.source_api
  FROM market_data.hk_listed_universe h LEFT JOIN market_data.securities s ON s.ts_code = h.ts_code
  WHERE h.active AND h.ts_code ~ '^[0-9]{5}\\.HK$' AND (h.list_date IS NULL OR h.list_date <= $1::date)
  ORDER BY ts_code`;
const JOB_FIELDS = `job_id::text, subject_ticker, subject_name, to_char(as_of, 'YYYY-MM-DD') AS as_of,
  status, stage, provider, model, method_version, candidate_hash, candidate_count, relations, gaps,
  researched_at, result_count, error_code, error_message, created_at, updated_at, finished_at, audit->'refreshSummary' AS refresh_summary`;
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function publicJob(row) {
  if (!row) return null;
  return { id: row.job_id, jobId: row.job_id, ticker: row.subject_ticker, name: row.subject_name, asOf: row.as_of,
    status: row.status, stage: row.stage, provider: row.provider, model: row.model, methodVersion: row.method_version,
    candidateHash: row.candidate_hash, candidateCount: Number(row.candidate_count), relations: row.relations ?? [],
    relationCount: Number(row.result_count ?? row.relations?.length ?? 0), gaps: row.gaps ?? [],
    ...(row.refresh_summary && typeof row.refresh_summary === 'object' ? {refreshSummary:row.refresh_summary} : {}),
    ...(typeof row.is_current === 'boolean' ? {isCurrent:row.is_current} : {}),
    researchedAt: iso(row.researched_at), errorCode: row.error_code ?? null, errorMessage: row.error_message ?? null,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), finishedAt: iso(row.finished_at) };
}

export function createRelationsAiStore({ connectionString, pool: injectedPool, now = () => new Date() } = {}) {
  if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw unavailable();
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 10_000, query_timeout: 20_000 });
  if (!injectedPool) pool.on('error', () => {});
  async function query(sql, values) { try { return await pool.query(sql, values); } catch { throw unavailable(); } }
  async function transaction(operation) {
    let client, began = false;
    try { client = await pool.connect(); await client.query('BEGIN'); began = true; const result = await operation(client); await client.query('COMMIT'); return result; }
    catch (error) { if (began) try { await client.query('ROLLBACK'); } catch {} throw error instanceof ResearchError ? error : unavailable(); }
    finally { client?.release(); }
  }
  async function listCandidates(input, client = { query }) {
    const { ticker: code, asOf } = parseInput(input, now);
    const result = await client.query(CANDIDATES_SQL, [asOf]);
    const securities = result.rows.map(row => ({ ticker: ticker(row.ts_code), name: text(row.name, '证券名称', 200),
      market: row.market, industry: row.industry ?? null, listDate: row.list_date ?? null,
      source: row.source ?? null, sourceApi: row.source_api ?? null }));
    if (securities.length > 20001 || new Set(securities.map(row => row.ticker)).size !== securities.length) throw unavailable();
    const subject = securities.find(row => row.ticker === code);
    if (!subject) throw new ResearchError('UNKNOWN_SECURITY', '该证券不在当前上市的 A 股或港股公司清单中。', 404);
    const candidates = securities.filter(row => row.ticker !== code);
    return { ticker: code, asOf, subject, candidates, candidateHash: candidateHash(subject, candidates) };
  }
  async function manualEvents(input, client = { query }) {
    const table = await client.query(`SELECT to_regclass('market_data.company_relation_manual_events') AS manual_table`);
    if (!table.rows[0]?.manual_table) return [];
    const events = await client.query(`SELECT related_ticker AS "relatedTicker",related_name AS "relatedName",revision::text,
      to_char(effective_date,'YYYY-MM-DD') AS "effectiveDate",action,relation_type AS "relationType",rationale,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "manualUpdatedAt"
      FROM market_data.company_relation_manual_events WHERE subject_ticker=$1 AND effective_date<=$2::date`,[input.ticker,input.asOf]);
    return events.rows;
  }
  return {
    async migrate() {
      const schema = await readFile(new URL('./relations-ai-schema.sql', import.meta.url), 'utf8');
      const currentSchema = await readFile(new URL('./relations-current-schema.sql', import.meta.url), 'utf8');
      await transaction(async client => { await client.query(currentSchema); await client.query(schema); await migrateRelationsCurrent(client, now); });
    },
    listCandidates,
    async getExistingRelations(payload) {
      const input = parseInput(payload, now);
      const current = await query(`SELECT relations FROM market_data.company_relation_current WHERE subject_ticker=$1 AND as_of<=$2::date`,[input.ticker,input.asOf]);
      return mergeManualRelations(current.rows[0]?.relations ?? [], await manualEvents(input),input).relations;
    },
    async createJob(payload) {
      exact(payload, ['ticker', 'asOf', 'provider', 'model', 'candidateHash', 'candidateCount'], '识别任务');
      const input = parseInput({ ticker: payload.ticker, asOf: payload.asOf }, now);
      const provider = text(payload.provider, 'AI 服务', 100), model = text(payload.model, 'AI 模型', 200);
      if (payload.candidateHash !== undefined && (typeof payload.candidateHash !== 'string' || !HASH.test(payload.candidateHash))) throw invalid('冻结证券清单摘要无效。');
      return transaction(async client => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('company-relations-ai:create'), hashtext($1))`, [`${input.ticker}:${input.asOf}`]);
        const running = await client.query(`SELECT ${JOB_FIELDS} FROM market_data.company_relation_ai_jobs WHERE subject_ticker = $1 AND as_of = $2::date AND status = 'running' ORDER BY created_at DESC LIMIT 1`, [input.ticker, input.asOf]);
        if (running.rows.length) return { created: false, job: publicJob(running.rows[0]) };
        const frozen = await listCandidates(input, client);
        if ((payload.candidateHash !== undefined && payload.candidateHash !== frozen.candidateHash)
          || (payload.candidateCount !== undefined && payload.candidateCount !== frozen.candidates.length)) throw conflict();
        const result = await client.query(`INSERT INTO market_data.company_relation_ai_jobs
          (job_id, subject_ticker, subject_name, as_of, status, stage, provider, model, method_version, candidate_hash, candidate_count, candidate_securities)
          VALUES ($1::uuid, $2, $3, $4::date, 'running', 'queued', $5, $6, $7, $8, $9, $10::jsonb) RETURNING ${JOB_FIELDS}`,
        [randomUUID(), input.ticker, frozen.subject.name, input.asOf, provider, model, RELATIONS_AI_METHOD_VERSION,
          frozen.candidateHash, frozen.candidates.length, JSON.stringify(frozen.candidates)]);
        return { created: true, job: publicJob(result.rows[0]) };
      });
    },
    async updateProgress({ jobId: id, stage }) {
      jobId(id);
      if (!STAGES.includes(stage) || ['completed', 'failed'].includes(stage)) throw invalid('识别进度无效。');
      const result = await query(`UPDATE market_data.company_relation_ai_jobs SET stage = $2, updated_at = clock_timestamp()
        WHERE job_id = $1::uuid AND status = 'running' RETURNING ${JOB_FIELDS}`, [id, stage]);
      if (!result.rows.length) throw conflict();
      return publicJob(result.rows[0]);
    },
    async completeJob(payload) {
      exact(payload, ['jobId', 'relations', 'gaps', 'researchedAt', 'audit'], '识别结果');
      const id = jobId(payload.jobId);
      return transaction(async client => {
        const locked = await client.query(`SELECT ${JOB_FIELDS}, candidate_securities FROM market_data.company_relation_ai_jobs WHERE job_id = $1::uuid FOR UPDATE`, [id]);
        const job = locked.rows[0];
        if (!job || job.status !== 'running') throw conflict();
        const result = validateRelationsAiResult({ relations: payload.relations, gaps: payload.gaps,
          researchedAt: payload.researchedAt, audit: payload.audit }, { ticker: job.subject_ticker, asOf: job.as_of, candidates: job.candidate_securities, now });
        // A source frozen earlier in the request cannot admit a subsequently
        // delisted code or a renamed security under another company's identity.
        const current = await listCandidates({ ticker: job.subject_ticker, asOf: job.as_of }, client);
        const names = new Map(current.candidates.map(row => [row.ticker, row.name]));
        if (current.subject.name !== job.subject_name || result.relations.some(row => names.get(row.relatedTicker) !== row.relatedName)) throw conflict();
        if (result.relations.length) {
          await client.query(`SELECT pg_advisory_xact_lock(hashtext('company-relations-current'),hashtext($1))`, [job.subject_ticker]);
          // Read the live report and human edits under the same lock used by
          // manual saves. An inference started earlier cannot evict a new edit.
          const previous = await client.query(`SELECT relations FROM market_data.company_relation_current WHERE subject_ticker=$1 FOR UPDATE`,[job.subject_ticker]);
          const oldRelations = previous.rows[0]?.relations ?? [];
          const context = {ticker:job.subject_ticker,asOf:job.as_of};
          const events = await manualEvents(context,client);
          const before = mergeManualRelations(oldRelations,events,context);
          const manual = before.relations.filter(row=>row.origin==='manual');
          const oldCodes = new Set(oldRelations.map(row=>row.relatedTicker));
          const decisions = Array.isArray(result.audit.approvedChanges) ? result.audit.approvedChanges : [];
          const checkedChanges = decisions.slice(0,10).filter(change=>{
            if (!change || !oldCodes.has(change.oldTicker) || typeof change.reason!=='string' || !change.reason.trim()
              || !['identity_error','relationship_ended','business_changed','stronger_business_relevance'].includes(change.reasonCode)
              || (change.newTicker!==null && !result.relations.some(row=>row.relatedTicker===change.newTicker))
              || !Array.isArray(change.sources) || !change.sources.length || change.sources.length>6) return false;
            return change.sources.every(source=>{
              const original=result.audit.retrievalEvidence?.sources?.find(item=>item.id===source.sourceId);
              return original && original.url===source.url && original.title===source.title
                && original.publishedAt===source.publishedAt && validDate(source.publishedAt) && source.publishedAt<=job.as_of;
            });
          });
          const retained=applyRelationsRetention({previousRelations:oldRelations,proposedRelations:result.relations,
            changes:checkedChanges,candidates:current.candidates,
            protectedTickers:[...manual.map(row=>row.relatedTicker),...before.removedRelations.map(row=>row.relatedTicker)],
            excludedNewTickers:[...manual.map(row=>row.relatedTicker),...before.removedRelations.map(row=>row.relatedTicker)],
            hiddenTickers:before.removedRelations.map(row=>row.relatedTicker),
            reservedManualCount:manual.filter(row=>!oldCodes.has(row.relatedTicker)).length,
            rejectedChangeCount:decisions.length-checkedChanges.length+(result.audit.rejectedChangeCount??0)});
          if (!retained.relations.length && oldRelations.length) throw invalid('AI 调整不能清空全部已有关系，请人工确认后修改。');
          const after=mergeManualRelations(retained.relations,events,context);
          if (after.relations.length>10 || retained.relations.length>10)
            throw invalid('识别结果与已保存的人工关系合计超过 10 家，请先调整人工关系后重试。');
          const beforeCodes=new Set(before.relations.map(row=>row.relatedTicker));
          const afterCodes=new Set(after.relations.map(row=>row.relatedTicker));
          const retainedCount=after.relations.filter(row=>beforeCodes.has(row.relatedTicker)).length;
          result.audit.refreshSummary={...retained.refreshSummary,retainedCount,
            addedCount:after.relations.length-retainedCount,removedCount:before.relations.length-retainedCount,
            changes:retained.refreshSummary.changes.filter(change=>beforeCodes.has(change.oldTicker)&&!afterCodes.has(change.oldTicker))};
          // The current row is the only report copy. Job audit keeps decisions
          // and counts, without a second proposed/previous relationship array.
          delete result.audit.approvedChanges;
          result.relations=retained.relations;
          if (retained.relations.length) {
            const replaced = await client.query(`INSERT INTO market_data.company_relation_current
            (subject_ticker,subject_name,as_of,relations,gaps,researched_at,method_version,source,run_id,refresh_summary)
            VALUES($1,$2,$3::date,$4::jsonb,$5::jsonb,$6::timestamptz,$7,'ai',$8,$9::jsonb)
            ON CONFLICT(subject_ticker) DO UPDATE SET subject_name=EXCLUDED.subject_name,as_of=EXCLUDED.as_of,
              relations=EXCLUDED.relations,gaps=EXCLUDED.gaps,researched_at=EXCLUDED.researched_at,
              method_version=EXCLUDED.method_version,source=EXCLUDED.source,run_id=EXCLUDED.run_id,
              refresh_summary=EXCLUDED.refresh_summary,updated_at=clock_timestamp()
            WHERE market_data.company_relation_current.researched_at<=EXCLUDED.researched_at RETURNING subject_ticker`,
          [job.subject_ticker,job.subject_name,job.as_of,JSON.stringify(result.relations),JSON.stringify(result.gaps),
            result.researchedAt,job.method_version,id,JSON.stringify(result.audit.refreshSummary)]);
            if (!replaced.rows.length) throw conflict();
          }
        }
        const saved = await client.query(`UPDATE market_data.company_relation_ai_jobs SET status = 'succeeded', stage = 'completed',
          relations = '[]'::jsonb, result_count = $2, gaps = $3::jsonb, researched_at = $4::timestamptz, audit = $5::jsonb,
          finished_at = clock_timestamp(), updated_at = clock_timestamp() WHERE job_id = $1::uuid AND status = 'running' RETURNING ${JOB_FIELDS}`,
        [id, result.audit.refreshSummary ? result.audit.refreshSummary.retainedCount+result.audit.refreshSummary.addedCount : result.relations.length,
          JSON.stringify(result.gaps), result.researchedAt, JSON.stringify(result.audit)]);
        if (!saved.rows.length) throw conflict();
        return { ...publicJob(saved.rows[0]), relations: result.relations };
      });
    },
    async failJob({ jobId: id, errorCode = 'RELATIONS_AI_FAILED' } = {}) {
      jobId(id);
      // No provider error text, response body, SQL, or credential is persisted
      // into a response-visible message.
      const code = SAFE_ERRORS.has(errorCode) ? errorCode : 'RELATIONS_AI_FAILED';
      const result = await query(`UPDATE market_data.company_relation_ai_jobs SET status = 'failed', stage = 'failed',
        error_code = $2, error_message = $3, finished_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE job_id = $1::uuid AND status = 'running' RETURNING ${JOB_FIELDS}`, [id, code, SAFE_ERRORS.get(code)]);
      return publicJob(result.rows[0]) ?? this.getJob(id);
    },
    async getJob(id) {
      jobId(id);
      const result = await query(`SELECT ${JOB_FIELDS} FROM market_data.company_relation_ai_jobs WHERE job_id = $1::uuid`, [id]);
      if (!result.rows.length) throw new ResearchError('RELATIONS_AI_JOB_NOT_FOUND', '识别任务不存在。', 404);
      return publicJob(result.rows[0]);
    },
    async getLatestJob(payload) {
      const input = parseInput(payload, now);
      const result = await query(`SELECT ${JOB_FIELDS}, NOT EXISTS(SELECT 1 FROM market_data.company_relation_current current_report
        WHERE current_report.subject_ticker=company_relation_ai_jobs.subject_ticker AND current_report.run_id<>company_relation_ai_jobs.job_id::text) AS is_current
        FROM market_data.company_relation_ai_jobs WHERE subject_ticker = $1 AND as_of <= $2::date
        ORDER BY as_of DESC, created_at DESC, job_id DESC LIMIT 1`, [input.ticker, input.asOf]);
      return publicJob(result.rows[0]);
    },
    async expireStaleJobs({ olderThanMs = 1_800_000 } = {}) {
      if (!Number.isInteger(olderThanMs) || olderThanMs < 300_000 || olderThanMs > 86_400_000) throw invalid('识别任务过期时长无效。');
      const result = await query(`UPDATE market_data.company_relation_ai_jobs SET status = 'failed', stage = 'failed',
        error_code = 'RELATIONS_AI_INTERRUPTED', error_message = $2, finished_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE status = 'running' AND updated_at < clock_timestamp() - $1 * interval '1 millisecond' RETURNING job_id::text`,
      [olderThanMs, SAFE_ERRORS.get('RELATIONS_AI_INTERRUPTED')]);
      return { expired: result.rows.length };
    },
    async close() { try { await pool.end(); } catch { throw unavailable(); } },
  };
}
