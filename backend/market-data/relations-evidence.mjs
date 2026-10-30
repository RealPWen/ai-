import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateResearch } from './relations-store.mjs';

const SOURCE_FIELDS = ['url', 'title', 'publishedAt', 'excerpt', 'accessedAt', 'readingScope'];
const MAX_TIMESTAMP_CHARS = 64;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message) { throw Object.assign(new Error(message), { code: 'VALIDATION_ERROR' }); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(value).digest('hex');
function timestampLength(value, label) {
  if (typeof value !== 'string' || value.length > MAX_TIMESTAMP_CHARS) fail(`${label}须为不超过 ${MAX_TIMESTAMP_CHARS} 字符的原始 ISO 时间。`);
}
function sourceOnly(source) {
  if (!object(source)) fail('来源对象无效。');
  timestampLength(source.accessedAt, '来源读取时间');
  return Object.fromEntries(SOURCE_FIELDS.filter(key => own(source, key)).map(key => [key, source[key]]));
}
function sourceId(source) {
  const content = sourceOnly(source);
  delete content.accessedAt;
  return `src_${hash(stable(content))}`;
}
function metadata(value) {
  if (!object(value)) fail('证据目录或研究元数据无效。');
  // Reuse the existing run/date validation without creating a verification time.
  const { runId, asOf, methodVersion } = validateResearch({ runId: value.runId, asOf: value.asOf, methodVersion: value.methodVersion, ticker: '000001.SZ', relations: [] });
  return { runId, asOf, methodVersion };
}
function sameRun(value, expected, label) {
  for (const key of ['runId', 'asOf', 'methodVersion']) if (value[key] !== expected[key]) fail(`${label}与证据目录的任务、截止日或方法版本不符。`);
}
function requireCatalog(catalog) {
  if (!object(catalog) || catalog.version !== 1 || !object(catalog.sources)) fail('证据目录版本或来源字典无效。');
  return metadata(catalog);
}
async function jsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    fail('无法读取证据缓存或导入回执。');
  }
}

/** Index only the exact original JSON payload accepted by the existing import CLI. */
export async function buildEvidenceCatalog({ runId, asOf, methodVersion, researchDirectory, importsDirectory } = {}) {
  const identity = metadata({ runId, asOf, methodVersion });
  if (typeof researchDirectory !== 'string' || typeof importsDirectory !== 'string') fail('研究缓存和导入回执目录必须显式指定。');
  const catalog = { version: 1, ...identity, indexedResearchCount: 0, sources: {} };
  let files;
  try { files = await readdir(researchDirectory, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return catalog;
    fail('无法读取研究缓存目录。');
  }
  for (const file of files.filter(file => file.isFile() && /^(?:\d{6}\.(SH|SZ|BJ)|\d{5}\.HK)\.json$/.test(file.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const [payload, receipt] = await Promise.all([jsonFile(join(researchDirectory, file.name)), jsonFile(join(importsDirectory, file.name))]);
    if (!object(payload) || !object(receipt)) continue;
    // sync-relations hashes JSON.stringify(parsedPayload), before normalization.
    const payloadHash = hash(JSON.stringify(payload));
    if (receipt.payloadHash !== payloadHash || payload.ticker !== file.name.slice(0, -5)) continue;
    if (receipt.status !== undefined && !['completed', 'partial', 'pending'].includes(receipt.status)) continue;
    if ((receipt.runId !== undefined && receipt.runId !== runId) || (receipt.ticker !== undefined && receipt.ticker !== payload.ticker)) continue;
    try {
      sameRun(payload, identity, '缓存');
      for (const row of payload.relations) for (const source of row.sources) timestampLength(source.accessedAt, '来源读取时间');
      validateResearch(payload);
    } catch { continue; }
    catalog.indexedResearchCount++;
    for (const relation of payload.relations) for (const rawSource of relation.sources) {
      const source = sourceOnly(rawSource), id = sourceId(source);
      const occurrence = { ticker: payload.ticker, relatedTicker: relation.relatedTicker, payloadHash };
      const current = catalog.sources[id];
      if (!current) catalog.sources[id] = { ...source, provenance: { ...occurrence }, occurrences: [occurrence] };
      else {
        if (Date.parse(source.accessedAt) < Date.parse(current.accessedAt)) {
          current.accessedAt = source.accessedAt;
          current.provenance = { ...occurrence };
        }
        if (!current.occurrences.some(item => stable(item) === stable(occurrence))) current.occurrences.push(occurrence);
      }
    }
  }
  return catalog;
}

/** Occurrences are discovery hints, never an assertion about source ownership. */
export function searchEvidenceCatalog(catalog, { ticker, query, limit = 8, maxExcerptChars = 350 } = {}) {
  requireCatalog(catalog);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(maxExcerptChars) || maxExcerptChars < 1 || maxExcerptChars > 10000) fail('检索数量或摘录长度无效。');
  if (ticker !== undefined && (typeof ticker !== 'string' || !/^(?:\d{6}\.(SH|SZ|BJ)|\d{5}\.HK)$/.test(ticker))) fail('检索证券代码无效。');
  if (query !== undefined && typeof query !== 'string') fail('检索文本无效。');
  const terms = (query ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  const entries = Object.entries(catalog.sources).sort(([, a], [, b]) => {
    if (a.publishedAt === b.publishedAt) return 0;
    if (a.publishedAt == null) return 1;
    if (b.publishedAt == null) return -1;
    return b.publishedAt.localeCompare(a.publishedAt);
  });
  for (const [id, source] of entries) {
    const occurrences = source.occurrences ?? (source.provenance ? [source.provenance] : []);
    if (ticker && !occurrences.some(item => item.ticker === ticker || item.relatedTicker === ticker)) continue;
    const text = [source.url, source.title, source.excerpt, ...occurrences.flatMap(item => [item.ticker, item.relatedTicker])].join(' ').toLocaleLowerCase();
    if (!terms.every(term => text.includes(term))) continue;
    hits.push({ sourceId: id, ...sourceOnly(source), excerpt: source.excerpt.slice(0, maxExcerptChars), occurrences: occurrences.map(item => ({ ...item })) });
    if (hits.length === limit) break;
  }
  return hits;
}

function refs(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !id.trim())) fail(`${label}必须是来源引用数组。`);
  return value;
}
function checkUniverse(universe, payload) {
  if (universe === undefined) return;
  if (!Array.isArray(universe)) {
    if (!object(universe)) fail('冻结证券清单无效。');
    for (const key of ['runId', 'asOf', 'methodVersion']) if (universe[key] !== undefined && universe[key] !== payload[key]) fail('冻结证券清单与研究任务不符。');
  }
  const securities = Array.isArray(universe) ? universe : universe.securities;
  if (!Array.isArray(securities)) fail('冻结证券清单无效。');
  const names = new Map();
  for (const row of securities) {
    if (!object(row) || typeof (row.ts_code ?? row.ticker) !== 'string' || typeof row.name !== 'string' || names.has(row.ts_code ?? row.ticker)) fail('冻结证券清单条目无效或重复。');
    names.set(row.ts_code ?? row.ticker, row.name);
  }
  if (!names.has(payload.ticker)) fail('主体证券不在冻结清单中。');
  if (securities.find(row => (row.ts_code ?? row.ticker) === payload.ticker)?.isSubject === false) fail('证券只是关联候选，不是本次研究主体。');
  if (payload.name !== undefined && payload.name !== names.get(payload.ticker)) fail('主体证券名称与冻结清单不符。');
  for (const row of payload.relations) if (names.get(row.relatedTicker) !== row.relatedName) fail('关联证券不在冻结清单中，或名称与清单不符。');
}
function checkClaim(claim, payload) {
  if (claim === undefined) return;
  if (!object(claim) && !Array.isArray(claim)) fail('原领取记录无效。');
  if (claim.runId !== undefined && claim.runId !== payload.runId) fail('领取记录与研究任务不符。');
  const jobs = Array.isArray(claim) ? claim : claim.jobs ?? [claim];
  if (!Array.isArray(jobs)) fail('原领取记录无效。');
  const matches = jobs.filter(job => job?.ticker === payload.ticker);
  if (matches.length !== 1) fail('主体证券未匹配唯一原领取记录。');
  const job = matches[0];
  for (const key of ['runId', 'asOf', 'methodVersion']) if (job[key] !== undefined && job[key] !== payload[key]) fail('领取记录与研究任务不符。');
  if (job.leaseToken !== payload.leaseToken) fail('研究租约代次与原领取记录不符。');
}

/** Expand explicit references only; no facts, relationships or times are inferred. */
export function composeResearchFromEvidence(draft, catalog, { universe, claim } = {}) {
  const identity = requireCatalog(catalog);
  if (!object(draft)) fail('紧凑研究草稿对象无效。');
  sameRun(draft, identity, '草稿');
  if (typeof draft.researchedAt !== 'string' || !draft.researchedAt.trim()) fail('草稿必须显式保留实际核验时间 researchedAt。');
  timestampLength(draft.researchedAt, '草稿核验时间');
  if (typeof draft.leaseToken !== 'string' || !TOKEN.test(draft.leaseToken)) fail('草稿必须显式保留原 leaseToken，不能借用领取记录补齐。');
  if (!Array.isArray(draft.relations)) fail('草稿关联公司数组无效。');
  const available = new Map(Object.entries(catalog.sources).map(([id, source]) => [id, sourceOnly(source)]));
  if (draft.newSources !== undefined && !object(draft.newSources)) fail('新增来源必须为引用字典。');
  for (const [id, source] of Object.entries(draft.newSources ?? {})) {
    if (!id.trim() || !object(source) || SOURCE_FIELDS.some(key => !own(source, key))) fail('新增来源须显式提供完整来源字段及原读取时间。');
    if (source.publishedAt !== null && typeof source.publishedAt !== 'string') fail('新增来源须显式提供发布日期或 null。');
    const value = sourceOnly(source);
    if (available.has(id) && stable(available.get(id)) !== stable(value)) fail('新增来源引用与目录中已有来源冲突。');
    available.set(id, value);
  }
  const subjectRefs = refs(draft.subjectSourceIds, '主体来源');
  const resolve = id => { if (!available.has(id)) fail('草稿引用了未知来源。'); return available.get(id); };
  // Reject unknown subject references even if there are no relations yet.
  subjectRefs.forEach(resolve);
  const { subjectSourceIds, newSources, ...rest } = draft;
  const checkedSources = new Set();
  const relations = draft.relations.map(row => {
    if (!object(row)) fail('草稿关联公司对象无效。');
    if (own(row, 'sources')) fail('紧凑草稿请用 sourceIds 引用来源，完整新来源请放入 newSources。');
    const { sourceIds, ...fields } = row;
    const sources = [], seen = new Set();
    for (const id of [...subjectRefs, ...refs(sourceIds, '关联来源')]) {
      const source = resolve(id), key = sourceId(source);
      const exact = stable(source);
      // Validate before deduplication: an invalid time must not disappear when
      // another reference points at the same otherwise-identical evidence.
      if (!checkedSources.has(exact)) {
        validateResearch({ ...rest, relations: [{ ...fields, sources: [source] }] });
        checkedSources.add(exact);
      }
      if (!seen.has(key)) { seen.add(key); sources.push({ ...source }); }
      else {
        const current = sources.find(item => sourceId(item) === key);
        if (Date.parse(source.accessedAt) < Date.parse(current.accessedAt)) current.accessedAt = source.accessedAt;
      }
    }
    return { ...fields, sources };
  });
  const expanded = { ...rest, relations };
  const validated = validateResearch(expanded);
  // validateResearch normalizes ISO representations; preserve the actual input
  // timestamps verbatim while retaining its structure/content checks.
  const result = { ...expanded, ...validated, researchedAt: draft.researchedAt, leaseToken: draft.leaseToken,
    relations: validated.relations.map((row, index) => ({ ...relations[index], ...row, sources: relations[index].sources })) };
  checkUniverse(universe, result);
  checkClaim(claim, result);
  if (universe && claim) {
    const jobs = Array.isArray(claim) ? claim : claim.jobs ?? [claim];
    const job = jobs.find(item => item.ticker === result.ticker);
    const securities = Array.isArray(universe) ? universe : universe.securities;
    if (job.name !== undefined && job.name !== securities.find(item => (item.ts_code ?? item.ticker) === result.ticker)?.name) fail('领取记录证券名称与冻结清单不符。');
  }
  return result;
}
