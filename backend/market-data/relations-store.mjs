import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { normalizeTradeDate } from './postgres-store.mjs';

export const RELATIONS_METHOD_VERSION = 'a-relations-v1';
const A_TICKER = /^\d{6}\.(SH|SZ|BJ)$/;
const TICKER = /^(?:\d{6}\.(SH|SZ|BJ)|\d{5}\.HK)$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TYPES = new Set(['upstream', 'peer', 'downstream']);
const EVIDENCE = new Set(['direct_business', 'technical_cooperation', 'industry_position', 'business_comparable']);
const DOMAIN_CODES = new Set(['VALIDATION_ERROR', 'RUN_NOT_FOUND', 'STALE_RUN', 'STALE_IMPORT', 'LEASE_CONFLICT', 'JOB_NOT_FOUND']);
const FAILURE_CODES = new Set(['provider_error', 'network_error', 'database_error', 'validation_error', 'unknown_error', 'rate_limited', 'no_data', 'insufficient_evidence']);
function problem(message, code = 'VALIDATION_ERROR') { return Object.assign(new Error(message), { code }); }
function identifier(value, label = '任务标识') { if (typeof value !== 'string' || !ID.test(value)) throw problem(`${label}无效。`); return value; }
function ticker(value) { if (typeof value !== 'string' || !TICKER.test(value)) throw problem('证券代码无效，须为 A 股或五位港股代码。'); return value; }
function aTicker(value) { if (typeof value !== 'string' || !A_TICKER.test(value)) throw problem('关联证券须为 A 股代码。'); return value; }
function string(value, label, max = 10000, empty = false) { if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /\u0000/.test(value)) throw problem(`${label}无效。`); return value.trim(); }
function date(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw problem('研究日期须为 YYYY-MM-DD。'); return normalizeTradeDate(value).iso; }
function researchDate(value) { const result = date(value); const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); if (result > today) throw problem('研究截止日不能晚于上海当前日期。'); return result; }
function timestamp(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) || Number(value.slice(11, 13)) > 23) throw problem('来源读取时间须为含时区的 ISO 时间。'); date(value.slice(0, 10)); return new Date(value).toISOString(); }
function leaseToken(value) { if (value !== undefined && (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) throw problem('租约令牌无效。'); return value?.toLowerCase(); }
function verificationTime(value) { const result = timestamp(value); if (Date.parse(result) > Date.now() + 5 * 60 * 1000) throw problem('核验时间不能明显晚于当前时间。'); return result; }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function relationContent(row) { return Object.fromEntries(['relatedTicker', 'relatedName', 'relationType', 'evidenceType', 'rationale', 'actualEntity', 'listedMappingBasis', 'notes', 'sources'].map(key => [key, row[key]])); }
function publishedRelation(row) { return { relatedTicker: row.related_ticker, relatedName: row.related_name, relationType: row.relation_type, evidenceType: row.evidence_type, rationale: row.rationale, actualEntity: row.actual_entity, listedMappingBasis: row.listed_mapping_basis, notes: row.notes, sources: row.sources, rank: Number(row.rank), verifiedAt: new Date(row.verified_at).toISOString() }; }
function gaps(value = []) { if (!Array.isArray(value) || value.length > 100) throw problem('缺口说明数组无效。'); return value.map(item => string(item, '缺口说明', 2000)); }
function safeDatabaseError(original) { if (DOMAIN_CODES.has(original?.code)) return original; const error = problem('PostgreSQL 公司关系数据操作失败。', 'DATABASE_ERROR'); if (typeof original?.code === 'string' && /^[0-9A-Z]{5}$/.test(original.code)) error.sqlState = original.code; return error; }
function runResult(row) { return { runId: row.run_id, asOf: row.as_of, methodVersion: row.method_version, securitiesCount: Number(row.securities_count), createdAt: row.created_at }; }
const RUN_SELECT = `SELECT run_id, to_char(as_of, 'YYYY-MM-DD') AS as_of, method_version, securities_count, created_at, subject_scope FROM market_data.company_relation_runs WHERE run_id = $1`;

/** A scope is explicit, immutable and independent of the frozen A-share candidates. */
export function validateRelationSubjects(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10000) throw problem('研究主体清单须为非空数组。');
  const seen = new Set();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['ticker', 'name', 'industry'].includes(key))) throw problem('研究主体清单条目无效。');
    const code = ticker(row.ticker), name = string(row.name, '主体证券名称', 200);
    if (seen.has(code)) throw problem('研究主体代码不能重复。');
    seen.add(code);
    return { ticker: code, name, ...(row.industry !== undefined ? { industry: string(row.industry, '主体行业', 200) } : {}) };
  }).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** Validates structure and provenance fields; it cannot establish a source's truth. */
export function validateResearch(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw problem('研究结果对象无效。');
  const runId = identifier(payload.runId), subject = ticker(payload.ticker), asOf = researchDate(payload.asOf), methodVersion = identifier(payload.methodVersion, '方法版本');
  if (!Array.isArray(payload.relations) || payload.relations.length > 10) throw problem('每股一次提交最多 10 家关联公司。');
  const seen = new Set();
  const relations = payload.relations.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw problem('关联公司对象无效。');
    const relatedTicker = aTicker(row.relatedTicker);
    if (subject === relatedTicker || seen.has(relatedTicker)) throw problem('禁止自关联或重复关联公司。');
    seen.add(relatedTicker);
    if (!TYPES.has(row.relationType) || !EVIDENCE.has(row.evidenceType)) throw problem('关系或证据分类无效。');
    if ((row.relationType === 'peer') !== (row.evidenceType === 'business_comparable')) throw problem('同行关系须使用业务可比证据，业务可比证据不能作为上下游依据。');
    if (!Array.isArray(row.sources) || !row.sources.length || row.sources.length > 20) throw problem('关联关系必须有可复核的来源。');
    const sources = row.sources.map(source => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw problem('来源对象无效。');
      let parsed;
      try { if (typeof source.url !== 'string' || !source.url.trim()) throw new Error(); parsed = new URL(source.url); } catch { throw problem('来源 URL 无效。'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || source.url.length > 4096) throw problem('来源须为不含登录信息的 HTTP(S) URL。');
      const publishedAt = source.publishedAt == null ? null : date(source.publishedAt);
      if (publishedAt && publishedAt > asOf) throw problem('来源发布日期不能晚于研究截止日。');
      if (!['full_text', 'partial_text'].includes(source.readingScope)) throw problem('来源阅读范围无效。');
      return { url: parsed.href, title: string(source.title, '来源标题', 1000), publishedAt, excerpt: string(source.excerpt, '原文摘录', 10000), accessedAt: timestamp(source.accessedAt), readingScope: source.readingScope };
    });
    return { relatedTicker, relatedName: string(row.relatedName, '关联证券名称', 200), relationType: row.relationType, evidenceType: row.evidenceType, rationale: string(row.rationale, '关系理由'), actualEntity: string(row.actualEntity, '实际业务法人', 2000), listedMappingBasis: string(row.listedMappingBasis, '上市主体映射依据'), notes: string(row.notes ?? '', '补充说明', 10000, true), sources };
  });
  const sourceTimes = relations.flatMap(row => row.sources.map(source => source.accessedAt));
  const researchedAt = payload.researchedAt !== undefined ? verificationTime(payload.researchedAt) : sourceTimes.length ? verificationTime(sourceTimes.reduce((latest, value) => value > latest ? value : latest)) : null;
  return { runId, ticker: subject, asOf, methodVersion, researchedAt, relations, gaps: gaps(payload.gaps) };
}

export function createRelationsStore({ connectionString, pool: injectedPool } = {}) {
  if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw problem('请提供 PostgreSQL 连接配置。');
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10000 });
  if (!injectedPool) pool.on('error', () => {});
  async function query(sql, values) { try { return await pool.query(sql, values); } catch (error) { throw safeDatabaseError(error); } }
  async function transaction(operation) {
    let client, began = false;
    try { client = await pool.connect(); await client.query('BEGIN'); began = true; const value = await operation(client); await client.query('COMMIT'); return value; }
    catch (error) { if (began) try { await client.query('ROLLBACK'); } catch {} throw safeDatabaseError(error); }
    finally { client?.release(); }
  }
  async function requireRun(client, runId) { const result = await client.query(RUN_SELECT, [runId]); if (!result.rows.length) throw problem('公司关系研究任务不存在。', 'RUN_NOT_FOUND'); return result.rows[0]; }
  async function assertCurrent(client, run, subject) {
    const result = await client.query(`SELECT newer.run_id FROM market_data.company_relation_runs newer
      JOIN market_data.company_relation_jobs j ON j.run_id = newer.run_id AND j.ticker = $2 AND j.is_subject
      CROSS JOIN market_data.company_relation_runs current
      WHERE current.run_id = $1 AND (newer.as_of > current.as_of OR (newer.as_of = current.as_of AND newer.created_at > current.created_at))
      ORDER BY newer.as_of DESC, newer.created_at DESC LIMIT 1`, [run.run_id, subject]);
    if (result.rows.length) throw problem('已有更新截止日或更新研究任务，拒绝过期结果覆盖。', 'STALE_RUN');
  }
  async function lockJob(client, runId, subject, workerId, token) {
    const result = await client.query(`SELECT *, (lease_until > clock_timestamp()) AS lease_active FROM market_data.company_relation_jobs WHERE run_id = $1 AND ticker = $2 AND is_subject FOR UPDATE`, [runId, subject]);
    if (!result.rows.length) throw problem('证券不是本次研究主体。', 'JOB_NOT_FOUND');
    const job = result.rows[0];
    if (job.lease_active && job.lease_owner !== workerId) throw problem('该证券有其他研究任务持有有效租约。', 'LEASE_CONFLICT');
    if (workerId && (job.lease_owner !== workerId || !job.lease_active)) throw problem('研究任务租约已到期或不匹配。', 'LEASE_CONFLICT');
    if (job.lease_active && job.lease_token != null && job.lease_token !== token) throw problem('研究任务租约令牌已过期或不匹配。', 'LEASE_CONFLICT');
    return job;
  }
  const store = {
    async migrate() { const schema = await readFile(new URL('./relations-schema.sql', import.meta.url), 'utf8'); await transaction(client => client.query(schema)); },
    async initRun({ runId, asOf, methodVersion = RELATIONS_METHOD_VERSION, subjects }) {
      identifier(runId); const cutoff = researchDate(asOf); identifier(methodVersion, '方法版本');
      const scope = subjects === undefined ? null : validateRelationSubjects(subjects);
      return transaction(async client => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('company-relations:init'))`);
        const existing = await client.query(RUN_SELECT, [runId]);
        if (existing.rows.length) {
          const run = existing.rows[0];
          if (run.as_of !== cutoff || run.method_version !== methodVersion) throw problem('同一任务标识不能改变截止日或方法版本。');
          if (stableJson(run.subject_scope ?? null) !== stableJson(scope)) throw problem('同一任务标识不能改变研究主体清单。');
          return { ...runResult(run), created: false };
        }
        const hasIndustry = await client.query(`SELECT to_regclass('market_data.sw_industry_members') IS NOT NULL AS available`);
        const industrySelection = hasIndustry.rows[0]?.available ? `(SELECT coalesce(jsonb_agg(jsonb_build_object('l1Code', m.l1_code, 'l1Name', m.l1_name, 'l2Code', m.l2_code, 'l2Name', m.l2_name, 'l3Code', m.l3_code, 'l3Name', m.l3_name) ORDER BY m.l3_code), '[]'::jsonb) FROM market_data.sw_industry_members m WHERE m.ts_code = s.ts_code AND m.is_new = 'Y')` : `'[]'::jsonb`;
        const securities = await client.query(`SELECT s.ts_code, s.name, s.industry, ${industrySelection} AS industry_classifications FROM market_data.securities s WHERE s.market = 'A' AND s.list_status = 'L' AND s.ts_code ~ '^[0-9]{6}\\.(SH|SZ|BJ)$' ORDER BY s.ts_code`);
        if (!securities.rows.length) throw problem('数据库没有可冻结的在市 A 股证券。');
        for (const security of securities.rows) { aTicker(security.ts_code); string(security.name, '证券名称', 200); }
        let frozen = securities.rows;
        if (scope) {
          const names = new Map(securities.rows.map(row => [row.ts_code, row.name]));
          for (const subject of scope) if (A_TICKER.test(subject.ticker) && names.get(subject.ticker) !== subject.name) throw problem('A 股主体不在在市清单中，或名称与数据库不符。');
          const selected = new Set(scope.map(row => row.ticker));
          frozen = securities.rows.map(row => ({ ...row, is_subject: selected.has(row.ts_code) }));
          for (const subject of scope.filter(row => !A_TICKER.test(row.ticker))) frozen.push({ ts_code: subject.ticker, name: subject.name, industry: subject.industry ?? null, industry_classifications: [], is_subject: true });
          frozen.sort((a, b) => a.ts_code.localeCompare(b.ts_code));
        }
        const result = await client.query(`INSERT INTO market_data.company_relation_runs (run_id, as_of, method_version, securities_count, subject_scope) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING run_id, to_char(as_of, 'YYYY-MM-DD') AS as_of, method_version, securities_count, created_at`, [runId, cutoff, methodVersion, frozen.length, scope === null ? null : JSON.stringify(scope)]);
        await client.query(`INSERT INTO market_data.company_relation_jobs (run_id, ticker, name, industry, industry_classifications, is_subject)
          SELECT $1, x.ts_code, x.name, x.industry, x.industry_classifications, coalesce(x.is_subject, true) FROM jsonb_to_recordset($2::jsonb) AS x(ts_code text, name text, industry text, industry_classifications jsonb, is_subject boolean)`, [runId, JSON.stringify(frozen)]);
        return { ...runResult(result.rows[0]), created: true };
      });
    },
    async listSecurities({ runId }) {
      identifier(runId); await requireRun({ query }, runId);
      const result = await query(`SELECT ticker, name, industry, industry_classifications, is_subject FROM market_data.company_relation_jobs WHERE run_id = $1 ORDER BY ticker`, [runId]);
      return result.rows.map(row => ({ ts_code: row.ticker, name: row.name, industry: row.industry, industryClassifications: row.industry_classifications, isSubject: row.is_subject ?? true }));
    },
    async claimJobs({ runId, workerId, limit = 10, leaseMinutes = 30, tickers } = {}) {
      identifier(runId); identifier(workerId, '工作进程标识');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(leaseMinutes) || leaseMinutes < 1 || leaseMinutes > 1440) throw problem('批次大小或租约时长无效。');
      if (tickers !== undefined && (!Array.isArray(tickers) || !tickers.length || new Set(tickers).size !== tickers.length)) throw problem('指定证券列表无效。');
      tickers?.forEach(ticker);
      return transaction(async client => {
        const token = randomUUID();
        const run = await requireRun(client, runId);
        if (tickers) {
          const selected = await client.query(`SELECT ticker FROM market_data.company_relation_jobs WHERE run_id = $1 AND is_subject AND ticker = ANY($2::text[])`, [runId, tickers]);
          if (selected.rows.length !== tickers.length) throw problem('指定证券不是本次研究主体。', 'JOB_NOT_FOUND');
        }
        if (tickers) for (const subject of tickers) await assertCurrent(client, run, subject);
        const result = await client.query(`WITH candidates AS (
          SELECT j.run_id, j.ticker FROM market_data.company_relation_jobs j
          WHERE j.run_id = $1 AND j.is_subject AND ($5::text[] IS NULL OR j.ticker = ANY($5::text[]))
            AND NOT EXISTS (
              SELECT 1 FROM market_data.company_relation_runs newer
              JOIN market_data.company_relation_jobs next_job ON next_job.run_id = newer.run_id AND next_job.ticker = j.ticker AND next_job.is_subject
              CROSS JOIN market_data.company_relation_runs current
              WHERE current.run_id = j.run_id AND (newer.as_of > current.as_of OR (newer.as_of = current.as_of AND newer.created_at > current.created_at)))
            AND (j.lease_until IS NULL OR j.lease_until <= clock_timestamp())
            AND (SELECT count(*) FROM market_data.company_relations r WHERE r.run_id = j.run_id AND r.subject_ticker = j.ticker) < 10
          ORDER BY CASE WHEN j.attempts = 0 THEN 0 ELSE 1 END, j.attempts, j.ticker
          FOR UPDATE OF j SKIP LOCKED LIMIT $3)
          UPDATE market_data.company_relation_jobs j SET status = 'running', lease_owner = $2, lease_token = $6::uuid,
            lease_until = clock_timestamp() + $4 * interval '1 minute', attempts = j.attempts + 1, error_code = NULL, updated_at = now()
          FROM candidates c WHERE j.run_id = c.run_id AND j.ticker = c.ticker
          RETURNING j.ticker, j.name, j.industry, j.industry_classifications, j.attempts, j.lease_owner, j.lease_until, j.lease_token`, [runId, workerId, limit, leaseMinutes, tickers ?? null, token]);
        return result.rows.sort((a, b) => a.ticker.localeCompare(b.ticker)).map(row => ({ runId, ticker: row.ticker, name: row.name, asOf: run.as_of, methodVersion: run.method_version, industry: row.industry, industryClassifications: row.industry_classifications, attempts: Number(row.attempts), leaseOwner: row.lease_owner, leaseUntil: row.lease_until, leaseToken: row.lease_token }));
      });
    },
    async importResearch(payload, { workerId, leaseToken: token, replace = false } = {}) {
      const data = validateResearch(payload); if (workerId !== undefined) identifier(workerId, '工作进程标识');
      token = leaseToken(token);
      if (typeof replace !== 'boolean' || (replace && data.relations.length !== 10)) throw problem('显式替换须提供完整 10 家已核实公司。');
      return transaction(async client => {
        // Also serializes publication from different runs, whose job rows differ.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('company-relations:subject'), hashtext($1))`, [data.ticker]);
        const run = await requireRun(client, data.runId);
        if (run.as_of !== data.asOf || run.method_version !== data.methodVersion) throw problem('研究结果与冻结任务的截止日或方法版本不符。');
        await assertCurrent(client, run, data.ticker);
        const job = await lockJob(client, data.runId, data.ticker, workerId, token);
        const counterparties = await client.query(`SELECT ticker, name FROM market_data.company_relation_jobs WHERE run_id = $1 AND ticker = ANY($2::text[])`, [data.runId, data.relations.map(row => row.relatedTicker)]);
        const names = new Map(counterparties.rows.map(row => [row.ticker, row.name]));
        for (const row of data.relations) if (names.get(row.relatedTicker) !== row.relatedName) throw problem('关联证券不在冻结清单中，或名称与清单不符。');
        const current = await client.query(`SELECT * FROM market_data.company_relations WHERE subject_ticker = $1 ORDER BY rank FOR UPDATE`, [data.ticker]);
        const previous = new Map(current.rows.filter(row => row.run_id === data.runId).map(row => [row.related_ticker, publishedRelation(row)]));
        for (const row of job.draft_relations ?? []) previous.set(row.relatedTicker, row);
        const merged = replace ? new Map() : new Map(previous);
        for (const row of data.relations) {
          const prior = previous.get(row.relatedTicker);
          if (prior && stableJson(relationContent(prior)) === stableJson(relationContent(row))) merged.set(row.relatedTicker, prior);
          else {
            if (prior && Date.parse(data.researchedAt) <= Date.parse(prior.verifiedAt)) throw problem('同一关系已有较新或同时间的不同研究结果。', 'STALE_IMPORT');
            merged.set(row.relatedTicker, { ...row, verifiedAt: data.researchedAt });
          }
        }
        // Replacing the selection also removes evidence, so its version must be newer.
        if (replace) for (const [code, prior] of previous) if (!merged.has(code) && Date.parse(data.researchedAt) <= Date.parse(prior.verifiedAt)) throw problem('替换选择不能移除较新或同时间的已有研究结果。', 'STALE_IMPORT');
        if (merged.size > 10) throw problem('增量合并后超过 10 家；请修订研究结果后再提交。');
        const olderPublication = current.rows.filter(row => row.run_id !== data.runId);
        const keepDraft = olderPublication.length > 0 && merged.size < 10;
        // Keep every nonempty prior publication until its replacement is complete.
        // An empty attempt likewise never removes prior published evidence.
        if (data.relations.length && !keepDraft) {
          const archives = new Map();
          for (const row of olderPublication) {
            if (!archives.has(row.run_id)) archives.set(row.run_id, []);
            archives.get(row.run_id).push(publishedRelation(row));
          }
          for (const [oldRunId, rows] of archives) await client.query(`UPDATE market_data.company_relation_jobs SET archived_relations = $3::jsonb, updated_at = now() WHERE run_id = $1 AND ticker = $2`, [oldRunId, data.ticker, JSON.stringify(rows)]);
          await client.query(`DELETE FROM market_data.company_relations WHERE subject_ticker = $1`, [data.ticker]);
          let rank = 0;
          for (const row of merged.values()) await client.query(`INSERT INTO market_data.company_relations
            (subject_ticker, subject_name, related_ticker, related_name, relation_type, rank, evidence_type, rationale, actual_entity, listed_mapping_basis, notes, sources, verified_at, run_id, as_of, method_version)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)`, [data.ticker, job.name, row.relatedTicker, row.relatedName, row.relationType, ++rank, row.evidenceType, row.rationale, row.actualEntity, row.listedMappingBasis, row.notes, JSON.stringify(row.sources), row.verifiedAt, data.runId, data.asOf, data.methodVersion]);
        }
        const relationCount = merged.size, publishedRelationCount = keepDraft ? 0 : merged.size, state = publishedRelationCount === 10 ? 'completed' : relationCount > 0 ? 'partial' : 'pending';
        const draft = keepDraft ? [...merged.values()] : [];
        const remainingGaps = relationCount === 10 ? data.gaps : data.gaps.length ? data.gaps : [`尚缺 ${10 - relationCount} 家有可复核依据的关联公司。`];
        await client.query(`UPDATE market_data.company_relation_jobs SET status = $3, gaps = $4::jsonb, draft_relations = $5::jsonb, lease_owner = NULL, lease_until = NULL, lease_token = NULL, error_code = NULL, updated_at = now() WHERE run_id = $1 AND ticker = $2`, [data.runId, data.ticker, state, JSON.stringify(remainingGaps), JSON.stringify(draft)]);
        return { runId: data.runId, ticker: data.ticker, relationCount, status: state, gaps: remainingGaps, published: !keepDraft && relationCount > 0, publishedRelationCount, draftCount: draft.length, preservedPreviousCount: keepDraft ? current.rows.length : 0 };
      });
    },
    async getResearch({ runId, ticker: subject }) {
      identifier(runId); ticker(subject); const run = await requireRun({ query }, runId);
      const job = await query(`SELECT name, gaps, draft_relations, archived_relations FROM market_data.company_relation_jobs WHERE run_id = $1 AND ticker = $2 AND is_subject`, [runId, subject]);
      if (!job.rows.length) throw problem('证券不是本次研究主体。', 'JOB_NOT_FOUND');
      const result = await query(`SELECT * FROM market_data.company_relations WHERE run_id = $1 AND subject_ticker = $2 ORDER BY rank`, [runId, subject]);
      const drafts = job.rows[0].draft_relations ?? [];
      const archived = job.rows[0].archived_relations ?? [];
      return { runId, ticker: subject, name: job.rows[0].name, asOf: run.as_of, methodVersion: run.method_version, gaps: job.rows[0].gaps, draftCount: drafts.length, archivedCount: archived.length, publishedRelationCount: result.rows.length, relationSource: drafts.length ? 'draft' : result.rows.length ? 'published' : archived.length ? 'archive' : 'none', relations: drafts.length ? drafts : result.rows.length ? result.rows.map(publishedRelation) : archived };
    },
    async markFailed({ runId, ticker: subject, workerId, leaseToken: token, errorCode = 'unknown_error', gaps: reasons = [] }) {
      identifier(runId); ticker(subject); if (workerId !== undefined) identifier(workerId, '工作进程标识'); const missing = gaps(reasons), code = FAILURE_CODES.has(errorCode) ? errorCode : 'unknown_error';
      token = leaseToken(token);
      return transaction(async client => {
        await requireRun(client, runId); await lockJob(client, runId, subject, workerId, token);
        const result = await client.query(`UPDATE market_data.company_relation_jobs j SET status = CASE WHEN (SELECT count(*) FROM market_data.company_relations r WHERE r.run_id = j.run_id AND r.subject_ticker = j.ticker) = 10 THEN 'completed' WHEN EXISTS (SELECT 1 FROM market_data.company_relations r WHERE r.run_id = j.run_id AND r.subject_ticker = j.ticker) OR jsonb_array_length(j.draft_relations) > 0 THEN 'partial' ELSE 'failed' END,
          gaps = $3::jsonb, error_code = $4, lease_owner = NULL, lease_until = NULL, lease_token = NULL, updated_at = now() WHERE run_id = $1 AND ticker = $2 RETURNING status`, [runId, subject, JSON.stringify(missing), code]);
        return { runId, ticker: subject, status: result.rows[0].status, errorCode: code, gaps: missing };
      });
    },
    async releaseJobs({ runId, workerId, leaseToken: token, tickers } = {}) {
      identifier(runId); identifier(workerId, '工作进程标识');
      token = leaseToken(token);
      if (tickers !== undefined && (!Array.isArray(tickers) || !tickers.length)) throw problem('指定证券列表无效。'); tickers?.forEach(ticker);
      const result = await query(`UPDATE market_data.company_relation_jobs j SET status = CASE WHEN (SELECT count(*) FROM market_data.company_relations r WHERE r.run_id = j.run_id AND r.subject_ticker = j.ticker) = 10 THEN 'completed' WHEN EXISTS (SELECT 1 FROM market_data.company_relations r WHERE r.run_id = j.run_id AND r.subject_ticker = j.ticker) OR jsonb_array_length(j.draft_relations) > 0 THEN 'partial' ELSE 'pending' END,
        lease_owner = NULL, lease_until = NULL, lease_token = NULL, updated_at = now() WHERE run_id = $1 AND is_subject AND lease_owner = $2 AND ($3::text[] IS NULL OR ticker = ANY($3::text[])) AND (lease_token IS NULL OR lease_token = $4::uuid) RETURNING ticker`, [runId, workerId, tickers ?? null, token ?? null]);
      return { runId, released: result.rows.length, tickers: result.rows.map(row => row.ticker).sort() };
    },
    async status({ runId, includeStocks = false } = {}) {
      identifier(runId); const run = await requireRun({ query }, runId);
      const result = await query(`SELECT j.ticker, j.name, j.gaps, j.attempts, j.error_code, j.lease_owner, j.lease_until, j.lease_token, jsonb_array_length(j.draft_relations) AS draft_count, count(r.related_ticker)::integer AS relation_count,
        CASE WHEN count(r.related_ticker) = 10 THEN 'completed' WHEN j.lease_until > clock_timestamp() THEN 'running' WHEN count(r.related_ticker) > 0 OR jsonb_array_length(j.draft_relations) > 0 THEN 'partial' WHEN j.status = 'failed' THEN 'failed' ELSE 'pending' END AS effective_status
        FROM market_data.company_relation_jobs j LEFT JOIN market_data.company_relations r ON r.run_id = j.run_id AND r.subject_ticker = j.ticker
        WHERE j.run_id = $1 AND j.is_subject GROUP BY j.run_id, j.ticker ORDER BY j.ticker`, [runId]);
      const totals = { stocks: result.rows.length, completed: 0, partial: 0, running: 0, pending: 0, failed: 0, relations: 0, draftRelations: 0, researchedRelations: 0, researchMissing: 0, target: result.rows.length * 10, missing: 0, remainingStocks: 0 };
      const stocks = result.rows.map(row => { const count = Number(row.relation_count), draftCount = Number(row.draft_count ?? 0), researchCount = Math.max(count, draftCount); totals[row.effective_status]++; totals.relations += count; totals.draftRelations += draftCount; totals.researchedRelations += researchCount; return { ticker: row.ticker, name: row.name, status: row.effective_status, relationCount: count, draftCount, researchCount, missing: 10 - researchCount, publicationMissing: 10 - count, gaps: row.gaps, attempts: Number(row.attempts), errorCode: row.error_code, leaseOwner: row.lease_owner, leaseUntil: row.lease_until, leaseToken: row.lease_token }; });
      totals.missing = totals.target - totals.relations; totals.researchMissing = totals.target - totals.researchedRelations; totals.remainingStocks = totals.stocks - totals.completed;
      return { ...runResult(run), totals, ...(includeStocks ? { stocks } : {}), gaps: stocks.filter(row => row.gaps?.length && row.status !== 'completed').map(({ ticker, name, gaps, missing }) => ({ ticker, name, gaps, missing })) };
    },
    async close() { try { await pool.end(); } catch (error) { throw safeDatabaseError(error); } },
  };
  return store;
}
