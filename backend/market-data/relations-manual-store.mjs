import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { ResearchError } from '../src/errors.mjs';
import { todayShanghai, validDate } from '../src/input.mjs';

const TICKER = /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/;
const TYPES = ['upstream', 'peer', 'downstream'];
const REVISION = /^(?:0|[1-9]\d*)$/;
const MAX_REVISION = 9223372036854775807n;
const invalid = message => new ResearchError('INVALID_MANUAL_RELATIONS', message, 400);
const unavailable = () => new ResearchError('RELATIONS_DATABASE_UNAVAILABLE', '公司关系数据库暂不可用，请稍后重试。', 503);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const revision = value => typeof value === 'string' && value.length <= 19 && REVISION.test(value) && BigInt(value) <= MAX_REVISION;
function ticker(value) {
  const result = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!TICKER.test(result)) throw invalid('请输入有效的 A 股或五位港股代码。');
  return result;
}

export function validateManualRelationChanges(payload, now = () => new Date()) {
  if (!record(payload) || Object.keys(payload).some(key => !['ticker', 'asOf', 'expectedRevision', 'changes'].includes(key))) throw invalid('人工关系请求含有不支持的参数。');
  const subject = ticker(payload.ticker), asOf = payload.asOf;
  if (!validDate(asOf) || asOf > todayShanghai(typeof now === 'function' ? now() : now)) throw invalid('人工关系生效日期须为有效的 YYYY-MM-DD，且不能晚于上海时区今日。');
  if (!revision(payload.expectedRevision)) throw invalid('请提供有效的关系版本号。');
  if (!Array.isArray(payload.changes) || !payload.changes.length || payload.changes.length > 200) throw invalid('每次请提交 1 至 200 项关系调整。');
  const seen = new Set();
  const changes = payload.changes.map(change => {
    if (!record(change) || Object.keys(change).some(key => !['action', 'relatedTicker', 'relationType', 'rationale'].includes(key))) throw invalid('关系调整含有不支持的字段。');
    if (!['upsert', 'remove', 'restore'].includes(change.action)) throw invalid('关系操作无效。');
    const relatedTicker = ticker(change.relatedTicker);
    if (relatedTicker === subject) throw invalid('不能将当前公司关联到自身。');
    if (seen.has(relatedTicker)) throw invalid('同一批调整不能重复包含相同证券。');
    seen.add(relatedTicker);
    if ((change.action === 'upsert' || change.relationType != null) && !TYPES.includes(change.relationType)) throw invalid('关系类别须为上游、同行或下游。');
    const rationale = change.rationale === undefined ? '' : change.rationale;
    if (typeof rationale !== 'string' || rationale.length > 4000 || rationale.includes('\u0000')) throw invalid('关系备注须为不超过 4000 字的文本。');
    return { action: change.action, relatedTicker, relationType: change.action === 'upsert' ? change.relationType : null, rationale: rationale.trim() };
  });
  return { ticker: subject, asOf, expectedRevision: payload.expectedRevision, changes };
}

// Both read services include these fields in their existing research query.
// $1/$2 are the already validated subject and request cutoff in both callers.
export const MANUAL_RELATION_FIELDS = `coalesce(manual_head.revision, 0)::text AS manual_revision,
    coalesce(manual_state.events, '[]'::jsonb) AS manual_events`;
export const MANUAL_RELATION_JOINS = `LEFT JOIN market_data.company_relation_manual_subjects manual_head ON manual_head.subject_ticker = $1
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('relatedTicker', e.related_ticker, 'relatedName', e.related_name,
      'revision', e.revision::text, 'effectiveDate', to_char(e.effective_date, 'YYYY-MM-DD'),
      'action', e.action, 'relationType', e.relation_type, 'rationale', e.rationale,
      'manualUpdatedAt', e.updated_at) ORDER BY e.related_ticker) AS events
    FROM (
      SELECT DISTINCT ON (related_ticker) related_ticker, related_name, revision, effective_date, action, relation_type, rationale, updated_at
      FROM market_data.company_relation_manual_events
      WHERE subject_ticker = $1 AND effective_date <= $2::date
      ORDER BY related_ticker, effective_date DESC, revision DESC
    ) e
  ) manual_state ON true`;

function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** Human rows bypass the AI source requirement; they never acquire AI citations. */
export function mergeManualRelations(base, events, { ticker: subject, asOf } = {}) {
  const latest = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!record(event) || !TICKER.test(event.relatedTicker) || event.relatedTicker === subject
      || typeof event.relatedName !== 'string' || !event.relatedName.trim()
      || !['upsert', 'remove', 'restore'].includes(event.action)
      || !validDate(event.effectiveDate) || event.effectiveDate > asOf || !revision(event.revision)
      || !validTimestamp(event.manualUpdatedAt) || (event.action === 'upsert' && !TYPES.includes(event.relationType))) continue;
    const prior = latest.get(event.relatedTicker);
    if (!prior || event.effectiveDate > prior.effectiveDate || (event.effectiveDate === prior.effectiveDate && BigInt(event.revision) > BigInt(prior.revision))) latest.set(event.relatedTicker, event);
  }
  const original = new Map(base.map(row => [row.relatedTicker, row]));
  const merged = new Map(original), removedRelations = [];
  let upsert = 0, remove = 0;
  for (const event of latest.values()) {
    if (event.action === 'restore') continue;
    const updatedAt = validTimestamp(event.manualUpdatedAt);
    if (event.action === 'remove') {
      remove++; merged.delete(event.relatedTicker);
      removedRelations.push({ relatedTicker: event.relatedTicker, relatedName: event.relatedName,
        relationType: original.get(event.relatedTicker)?.relationType ?? null,
        rationale: typeof event.rationale === 'string' ? event.rationale : '',
        manualUpdatedAt: updatedAt, effectiveDate: event.effectiveDate, origin: 'manual' });
      continue;
    }
    upsert++;
    const previous = original.get(event.relatedTicker);
    merged.set(event.relatedTicker, { relatedTicker: event.relatedTicker, relatedName: event.relatedName.trim(),
      relationType: event.relationType, evidenceType: 'manual', origin: 'manual',
      rank: previous?.rank ?? merged.size + 1, rationale: typeof event.rationale === 'string' ? event.rationale : '',
      actualEntity: null, listedMappingBasis: null, notes: '', verifiedAt: null, sources: [],
      manualUpdatedAt: updatedAt, manualEffectiveDate: event.effectiveDate });
  }
  const hasManualChanges = upsert + remove > 0;
  return { relations: hasManualChanges ? [...merged.values()].map((row, index) => ({ ...row, rank: index + 1 })) : [...merged.values()],
    hasManualChanges, manualCounts: { upsert, remove, total: upsert + remove },
    removedRelations: removedRelations.sort((a, b) => a.relatedTicker.localeCompare(b.relatedTicker)) };
}

export function manualRelationRevision(value) { return revision(value) ? value : '0'; }

export function createRelationsManualStore({ connectionString, pool: injectedPool, now = () => new Date() } = {}) {
  let pool;
  try {
    if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw unavailable();
    pool = injectedPool ?? new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 10_000, query_timeout: 20_000 });
    if (!injectedPool) pool.on('error', () => {});
  } catch { throw unavailable(); }
  async function transaction(operation) {
    let client, began = false;
    try {
      client = await pool.connect(); await client.query('BEGIN'); began = true;
      const result = await operation(client); await client.query('COMMIT'); return result;
    } catch (error) {
      if (began) try { await client.query('ROLLBACK'); } catch {}
      throw error instanceof ResearchError ? error : unavailable();
    } finally { client?.release(); }
  }
  return {
    async migrate() {
      const currentSchema = await readFile(new URL('./relations-current-schema.sql', import.meta.url), 'utf8');
      const manualSchema = await readFile(new URL('./relations-manual-schema.sql', import.meta.url), 'utf8');
      await transaction(async client => { await client.query(currentSchema); await client.query(manualSchema); });
    },
    async save(payload) {
      const input = validateManualRelationChanges(payload, now);
      return transaction(async client => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('company-relations-current'), hashtext($1))`, [input.ticker]);
        const tickers = [input.ticker, ...input.changes.map(change => change.relatedTicker)].sort();
        const securities = await client.query(`SELECT ts_code, name, market FROM market_data.securities
          WHERE ts_code = ANY($1::text[]) AND market = CASE WHEN ts_code LIKE '%.HK' THEN 'HK' ELSE 'A' END
          ORDER BY ts_code FOR SHARE`, [tickers]);
        const names = new Map(securities.rows.filter(row => TICKER.test(row.ts_code)
          && row.market === (row.ts_code.endsWith('.HK') ? 'HK' : 'A') && typeof row.name === 'string' && row.name.trim()).map(row => [row.ts_code, row.name.trim()]));
        if (tickers.some(code => !names.has(code))) throw new ResearchError('UNKNOWN_SECURITY', '证券代码尚未在本地证券库取得有效名称，请先同步证券资料。', 404);
        await client.query(`INSERT INTO market_data.company_relation_manual_subjects (subject_ticker) VALUES ($1)
          ON CONFLICT (subject_ticker) DO NOTHING`, [input.ticker]);
        const locked = await client.query(`SELECT revision::text AS revision FROM market_data.company_relation_manual_subjects
          WHERE subject_ticker = $1 FOR UPDATE`, [input.ticker]);
        const current = locked.rows[0]?.revision;
        if (!revision(current)) throw unavailable();
        if (current !== input.expectedRevision) throw new ResearchError('RELATIONS_REVISION_CONFLICT', '关系已被其他修改更新，请刷新后重试。', 409);
        if (BigInt(current) >= MAX_REVISION) throw unavailable();
        const next = String(BigInt(current) + 1n), updatedAt = new Date(typeof now === 'function' ? now() : now).toISOString();
        const saved = await client.query(`SELECT relations, to_char(as_of, 'YYYY-MM-DD') AS as_of
          FROM market_data.company_relation_current WHERE subject_ticker = $1 FOR UPDATE`, [input.ticker]);
        const history = await client.query(`SELECT related_ticker AS "relatedTicker", related_name AS "relatedName",
          revision::text AS revision, to_char(effective_date, 'YYYY-MM-DD') AS "effectiveDate",
          action, relation_type AS "relationType", rationale, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "manualUpdatedAt"
          FROM market_data.company_relation_manual_events WHERE subject_ticker = $1 ORDER BY effective_date, revision`, [input.ticker]);
        const proposed = [...history.rows, ...input.changes.map(change => ({ ...change,
          relatedName: names.get(change.relatedTicker), revision: next, effectiveDate: input.asOf, manualUpdatedAt: updatedAt }))];
        const base = Array.isArray(saved.rows[0]?.relations) ? saved.rows[0].relations : [];
        const today = todayShanghai(new Date(updatedAt));
        const cutoffs = new Set([input.asOf, today, ...proposed.map(event => event.effectiveDate)
          .filter(date => validDate(date) && date >= input.asOf && date <= today)]);
        for (const asOf of cutoffs) {
          if (saved.rows[0]?.as_of > asOf) continue;
          if (mergeManualRelations(base, proposed, { ticker: input.ticker, asOf }).relations.length > 10) {
            throw invalid('每只股票最多保存10家关联公司，请先移除部分公司后再保存。');
          }
        }
        for (const change of input.changes) await client.query(`INSERT INTO market_data.company_relation_manual_events
          (subject_ticker, related_ticker, related_name, revision, effective_date, action, relation_type, rationale, updated_at)
          VALUES ($1, $2, $3, $4::bigint, $5::date, $6, $7, $8, $9::timestamptz)`,
        [input.ticker, change.relatedTicker, names.get(change.relatedTicker), next, input.asOf, change.action, change.relationType, change.rationale, updatedAt]);
        await client.query(`UPDATE market_data.company_relation_manual_subjects SET revision = $2::bigint, updated_at = $3::timestamptz
          WHERE subject_ticker = $1`, [input.ticker, next, updatedAt]);
        return { ticker: input.ticker, asOf: input.asOf, revision: next, changedCount: input.changes.length };
      });
    },
    async close() { try { await pool.end(); } catch { throw unavailable(); } },
  };
}
