import { canonicalUrl } from './source-audit.mjs';
import { todayShanghai, validDate } from './input.mjs';
import { validateShape } from './schema.mjs';
import { ResearchError } from './errors.mjs';

export const MAX_AI_RELATIONS = 10;
export const RELATIONS_EVIDENCE_MODE = 'relation_summary';
const TICKER = /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/;
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' };
const enumeration = values => ({ type: 'string', enum: values });
export const relationsAISchema = object({
  relations: { type: 'array', maxItems: MAX_AI_RELATIONS, items: object({
    relatedTicker: string,
    relationType: enumeration(['upstream', 'peer', 'downstream']),
    evidenceType: enumeration(['direct_business', 'technical_cooperation', 'industry_position', 'business_comparable']),
    rationale: string, actualEntity: string, listedMappingBasis: string, notes: string,
    sources: { type: 'array', minItems: 1, maxItems: 6, items: object({ sourceId: string }) },
  }) },
  gaps: { type: 'array', maxItems: 30, items: string },
});

const fail = (code, message, status = 502) => new ResearchError(code, message, status);
const clipped = (value, length) => typeof value === 'string' ? value.slice(0, length) : '';
const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max && !value.includes('\u0000') && (empty || value.trim());
const compactName = value => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s·•・()（）,，.。\-]/g, '');
function identityAliases(candidate) {
  const name = compactName(candidate.name).replace(/^(?:\*?st)/i, '').replace(/(?:sw|ss|w|s|r|b)$/i, '');
  const abbreviated = name.replace(/(?:集团)?(?:股份有限公司|有限责任公司|有限公司|控股|集团)$/u, '');
  return [...new Set([name, abbreviated].filter(value => value.length >= 2))];
}
function mentionsIdentity(excerpts, candidate) {
  const normalized = compactName(excerpts);
  if (identityAliases(candidate).some(alias => normalized.includes(alias))) return true;
  const code = candidate.ticker.split('.')[0];
  return normalized.includes(candidate.ticker.toLowerCase()) || new RegExp(`(^|[^0-9])${code}([^0-9]|$)`).test(excerpts);
}
function mentionsEntity(value, name) {
  const normalized = compactName(value);
  return identityAliases({ name }).some(alias => normalized.includes(alias));
}
// This is a broad floor for an explicit disclosure, not a word-for-word quote
// requirement. Relationship interpretation remains the model's stated summary.
function hasEvidenceLanguage(excerpt, evidenceType) {
  if (evidenceType === 'direct_business') return /供应|供货|客户|采购|销售|服务|订单|合同|交付|中标|合作|定点|授信|supplier|customer|procure|supply|suppli|purchase|deliver|contract|order|sales|client|service/i.test(excerpt);
  if (evidenceType === 'technical_cooperation') return /技术|研发|开发|联合|合作|科研|创新|techno|research|develop|collaborat|cooperat|partnership/i.test(excerpt);
  return /主营|业务|产品|生产|制造|研发|技术|设计|服务|经营|系统|平台|品牌|可比|竞争|同行|市场|供应|供货|客户|采购|销售|订单|合作|business|product|manufactur|develop|design|service|operat|platform|compet|peer|market|supplier|customer|supply|purchase|sales|order|cooperat/i.test(excerpt);
}
const listedIdentityName = value => compactName(value).replace(/^(?:\*?st)/i, '').replace(/(?:sw|ss|w|s|r|b)$/i, '')
  .replace(/(?:股份有限公司|有限责任公司|有限公司)$/u, '');
function unconfirmedMapping(row) {
  if (/无法核实|不能核实|无法确认|尚未确认|无法验证|不能验证/i.test(row.listedMappingBasis ?? '')) return true;
  const fields = [row.listedMappingBasis, row.rationale, row.notes].filter(value => typeof value === 'string');
  return fields.some(value => /无法映射|不能映射|无法确认映射|映射(?:关系)?(?:不明|未知|未证实|未确认)|未输出[^。；\n]{0,30}(?:代码|证券|上市)|unverified mapping|unproven ownership/i.test(value)
    || value.split(/[。；\n]/).some(sentence => /控股|持股|股权|归属|映射|证券(?:身份|代码)|上市主体|法人|身份/.test(sentence)
      && /(?:未|尚未|无法|不能|未经|没有)[^。；\n]{0,35}(?:证明|证实|核实|确认|核验|验证)|(?:需|需要|有待|待补充)[^。；\n]{0,25}(?:证明|证据|核实|确认|验证)|(?:缺乏|缺少|缺失|尚缺)[^。；\n]{0,30}(?:依据|证据)|缺证/.test(sentence)));
}
function identitySpans(value, names) {
  const normalized = compactName(value), spans = [];
  for (const name of names) {
    let offset = normalized.indexOf(name);
    while (offset !== -1 && spans.length < 80) { spans.push({ start: offset, end: offset + name.length }); offset = normalized.indexOf(name, offset + name.length); }
  }
  return spans;
}
function mappingParagraphs(texts) {
  return texts.flatMap(value => value.split(/\r?\n/).flatMap(paragraph => {
    if (paragraph.length <= 700) return [paragraph];
    // Long single-line pages and company tables are not one identity proof.
    return paragraph.split(/(?<=[。；!?！？])/).filter(part => part.length <= 700);
  })).filter(value => value.trim());
}
function explicitMappingProof(texts, candidate, actualEntity, kind) {
  if (kind === 'issuer') {
    const normalize = value => value.normalize('NFKC').toLocaleLowerCase().replace(/\s/gu, '');
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entity = escape(normalize(actualEntity));
    const name = escape(normalize(candidate.name).replace(/^(?:\*?st)/i, ''));
    const code = escape(candidate.ticker.split('.')[0]);
    const close = '(?=[”"「」『』)）;；,，。]|(?:证券|股票|公司|英文|中文|发行|注册|法定)|$)';
    const alias = new RegExp(`${entity}[(（]?(?:以下简称|下称|简称为?|中文简称)[:：]?[“"「『]?${name}${close}`, 'gu');
    const adjacentSecurity = new RegExp(`${entity}[(（]((?:证券简称|股票简称|证券代码|股票代码)[^()（）]{0,160})[)）]`, 'gu');
    const companyField = new RegExp(`(?<!子)(?:公司(?:的)?(?:中文名称|中文全称|全称|名称)|中文名称|中文全称|发行人(?:中文)?名称)[:：]?[“"]?${entity}[”"]?${close}`, 'gu');
    const securityField = new RegExp(`(?:证券简称|股票简称)[:：]?[“"]?${name}[”"]?${close}|(?:证券代码|股票代码)[:：]?[“"]?${code}(?![0-9])`, 'u');
    for (const value of texts) {
      const normalized = normalize(value);
      // Match an explicit definition or a company-name field followed by its
      // own security fields; an unrelated stock-code heading is insufficient.
      for (const match of normalized.matchAll(alias)) {
        const before = normalized.slice(0, match.index).split(/[。；;]/).at(-1).slice(-30);
        const statement = before + normalized.slice(match.index, match.index + match[0].length + 80).split(/[。；;]/)[0];
        if (!/并非|不是|不属于|不简称|not(?:the|a)?|(?:为|系|是|属于).{0,30}(?:全资|控股)?子公司/u.test(statement)) return true;
      }
      for (const match of normalized.matchAll(adjacentSecurity)) {
        const before = normalized.slice(0, match.index).split(/[。；;]/).at(-1).slice(-30);
        const statement = before + normalized.slice(match.index, match.index + match[0].length + 80).split(/[。；;]/)[0];
        if (!/并非|不是|不属于|(?:为|系|是|属于).{0,30}(?:全资|控股)?子公司/u.test(statement)
          && securityField.test(match[1])) return true;
      }
      for (const match of normalized.matchAll(companyField)) {
        const prefix = normalized.slice(Math.max(0, match.index - 16), match.index);
        if (/(?:子公司|控股股东|交易对方|关联方|供应商)(?:的)?$/u.test(prefix)) continue;
        const preceding = normalized.slice(Math.max(0, match.index - 220), match.index)
          .split(/(?:公司(?:的)?(?:中文名称|中文全称|全称|名称)|发行人(?:中文)?名称)[:：]/u).at(-1);
        const following = normalized.slice(match.index + match[0].length, match.index + match[0].length + 220)
          .split(/(?:公司(?:的)?(?:中文名称|中文全称|全称|名称)|发行人(?:中文)?名称)[:：]/u)[0];
        if (!/并非|不是|不属于|不简称|(?:为|系|是|属于).{0,30}(?:全资|控股)?子公司/u.test(following)
          && (securityField.test(following) || securityField.test(preceding))) return true;
      }
    }
    return false;
  }

  for (const paragraph of mappingParagraphs(texts)) {
    const candidateNames = [...identityAliases(candidate), candidate.ticker.toLowerCase(), candidate.ticker.split('.')[0]];
    const listed = identitySpans(paragraph, candidateNames), actual = identitySpans(paragraph, identityAliases({ name: actualEntity }));
    if (!listed.some(a => actual.some(b => (a.end <= b.start || b.end <= a.start) && Math.max(a.start, b.start) - Math.min(a.end, b.end) <= 220))) continue;
    if (kind !== 'ownership' || /并非|不是|不属于|非控股|未控股|没有控股|无控股|不持有|未持有|not (?:a |the )?(?:subsidiary|controlled)/i.test(paragraph)) continue;
    const normalized = compactName(paragraph);
    for (const parent of listed) for (const child of actual) {
      if (parent.end <= child.start && child.start - parent.end <= 100) {
        const between = normalized.slice(parent.end, child.start), after = normalized.slice(child.end, child.end + 80);
        if (/(?:全资|控股)?子公司|whollyownedsubsidiar|controlledsubsidiar/i.test(between)
          || (/(?:持有|持股|控制)/.test(between) && /^(?:的)?(?:[5-9]\d(?:\.\d+)?|100(?:\.0+)?)%.*(?:股权|股份)/.test(after))) return true;
      } else if (child.end <= parent.start && parent.start - child.end <= 100) {
        const between = normalized.slice(child.end, parent.start), after = normalized.slice(parent.end, parent.end + 100);
        if (/控股股东(?:为|是|系)|controllingshareholder/i.test(between)
          || (/(?:为|系|是|属于|隶属于|为其)/.test(between) && /^(?:的|之)?(?:全资|控股)?子公司/.test(after))
          || (/由/.test(between) && /^(?:直接|间接)?(?:持有|持股)(?:[5-9]\d(?:\.\d+)?|100(?:\.0+)?)%.*(?:股权|股份)/.test(after))) return true;
      }
    }
  }
  return false;
}

/** A nearby company name is not a mapping of a different business legal entity. */
export function auditRelationListedMapping(row, candidate, { texts = [] } = {}) {
  if (unconfirmedMapping(row)) return { ok: false, reason: '模型明确表示上市主体映射尚未核实或缺少证据，该候选只能保留为缺口。' };
  const sameIdentity = listedIdentityName(row.actualEntity) === listedIdentityName(candidate.name);
  const selfClaim = /上市主体自身|上市公司自身|上市主体本身|上市公司本身|issuer itself/i.test(row.listedMappingBasis);
  const issuerProof = !sameIdentity && explicitMappingProof(texts, candidate, row.actualEntity, 'issuer');
  if (selfClaim && !sameIdentity && !issuerProof) return { ok: false, reason: '声明为上市主体自身，但实际法人名称不一致且引用正文未证明其证券身份。' };
  if (!sameIdentity && !issuerProof && !explicitMappingProof(texts, candidate, row.actualEntity, 'ownership')) {
    return { ok: false, reason: '实际业务法人不同，引用同段正文未明确证明其与候选上市公司的控股归属。' };
  }
  return { ok: true };
}

/** The caller supplies an authoritative, currently listed A/HK security catalog. */
export function relationCandidates(input) {
  if (!input || !TICKER.test(input.ticker) || !validDate(input.asOf) || !text(input.companyName, 200)
    || !Array.isArray(input.candidates) || !input.candidates.length || input.candidates.length > 10000) {
    throw fail('INVALID_RELATIONS_INPUT', 'AI 关系识别需要有效的 A 股或港股主体、截止日及在市证券清单。', 400);
  }
  const candidates = new Map();
  for (const row of input.candidates) {
    const ticker = row?.ticker ?? row?.ts_code;
    if (!TICKER.test(ticker) || !text(row?.name, 200)) throw fail('INVALID_RELATIONS_INPUT', 'AI 关系识别证券清单无效。', 400);
    if (row.active === false || (row.list_status != null && row.list_status !== 'L')) continue;
    if (row.market != null && row.market !== (ticker.endsWith('.HK') ? 'HK' : 'A')) continue;
    if (candidates.has(ticker)) throw fail('INVALID_RELATIONS_INPUT', 'AI 关系识别证券清单代码重复。', 400);
    candidates.set(ticker, { ticker, name: row.name.trim() });
  }
  if (candidates.get(input.ticker)?.name !== input.companyName.trim()) throw fail('INVALID_RELATIONS_INPUT', 'AI 关系识别主体与在市证券清单不符。', 400);
  return candidates;
}

export function relationsSearchQueries(input) {
  // Stock codes and market labels steer Search toward quote pages instead of
  // customer/supplier news. Listing eligibility is checked against the catalog.
  const subject = clipped(input.companyName, 50);
  const followingDay = new Date(`${input.asOf}T00:00:00Z`);
  followingDay.setUTCDate(followingDay.getUTCDate() + 1);
  const cutoff = `before:${followingDay.toISOString().slice(0, 10)}`;
  return [
    `${subject} 主营产品 业务 年报 公司介绍 ${cutoff}`,
    `${subject} 上游 供应链 主要供应商 原材料 采购 公告 ${cutoff}`,
    `${subject} 同行 竞争对手 可比上市公司 产品业务 ${cutoff}`,
    `${subject} 下游 客户 战略合作 供货 新闻 ${cutoff}`,
  ].map(query => Array.from(query).slice(0, 128).join(''));
}

/** Preserve exactly what Search returned and label summaries as summaries. */
export function relationsSearchContext(batches, input, accessedAt = new Date().toISOString()) {
  const unique = new Map();
  let rejectedFutureCount = 0, rejectedWithoutTextCount = 0;
  // Round-robin by query: product, upstream, peer and downstream results all
  // retain space even when earlier queries fill the source budget.
  const ordered = [];
  for (let index = 0; index < Math.max(0, ...batches.map(batch => batch.length)); index++) {
    for (const batch of batches) if (index < batch.length) ordered.push(batch[index]);
  }
  for (const result of ordered) {
    const url = clipped(result?.url, 2049), key = canonicalUrl(url);
    if (!key || url.length > 2048 || !clipped(result?.title, 300).trim()) continue;
    const dateOnly = typeof result.date === 'string' && validDate(result.date) ? result.date : null;
    const rawDate = typeof result.date === 'string' && validDate(result.date.slice(0, 10)) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(result.date) ? new Date(result.date) : null;
    const publishedAt = dateOnly ?? (rawDate && Number.isFinite(rawDate.getTime()) ? todayShanghai(rawDate) : null);
    if (publishedAt && publishedAt > input.asOf) { rejectedFutureCount++; continue; }
    const pageText = clipped(result.content, 7500).trim();
    const content = pageText || clipped(result.summary ?? result.snippet ?? result.description, 7500).trim();
    if (!content.trim()) { rejectedWithoutTextCount++; continue; }
    const source = { url, title: clipped(result.title, 300).trim(), publishedAt, accessedAt,
      readingScope: pageText ? 'partial_text' : 'search_snippet', sourceKind: pageText ? 'page_text' : 'search_summary', content };
    const previous = unique.get(key);
    if (!previous || (source.readingScope === 'partial_text' && previous.readingScope === 'search_snippet')
      || (source.readingScope === previous.readingScope && source.content.length > previous.content.length)) unique.set(key, source);
  }
  const sources = [];
  let contextChars = 0;
  for (const source of unique.values()) {
    const size = JSON.stringify(source).length;
    if (contextChars + size > 120000) continue;
    sources.push({ id: `s${sources.length + 1}`, ...source }); contextChars += size;
    if (sources.length === 24) break;
  }
  return { sources, rejectedFutureCount, rejectedWithoutTextCount };
}

export function relationsCoverage(relations = []) {
  const counts = { upstream: 0, peer: 0, downstream: 0 };
  for (const row of relations) if (Object.hasOwn(counts,row.relationType)) counts[row.relationType]++;
  const total=Object.values(counts).reduce((sum,count)=>sum+count,0);
  const dominantType=Object.keys(counts).find(type=>total>=6 && counts[type]/total>=0.7) ?? null;
  return { counts,total,missingTypes:Object.keys(counts).filter(type=>counts[type]===0),dominantType,
    coveredTypes:Object.values(counts).filter(count=>count>0).length };
}

/** Missing categories warrant one bounded check, not a mandatory quota. */
export function relationsCoverageQueries(relations, input) {
  const coverage=relationsCoverage(relations);
  const types=Object.keys(coverage.counts).filter(type=>coverage.counts[type]===0
    || (coverage.dominantType && type!==coverage.dominantType && coverage.counts[type]<=1));
  const searches=relationsSearchQueries(input);
  return types.map(type=>({relationType:type,query:searches[{upstream:1,peer:2,downstream:3}[type]]
    .replace('下游 客户 战略合作 供货 新闻','客户 战略合作 供货 新闻')
    .replace('同行 竞争对手 可比上市公司 产品业务','同类产品制造商 业务竞争对手 可比上市公司')}));
}

/** Rejected identities need evidence, not a weaker identity check. */
export function relationsSupplementQueries(raw, { input, candidates, acceptedRelations = [] } = {}) {
  const accepted = new Set(acceptedRelations.map(row => row.relatedTicker));
  const seen = new Set(), queries = [];
  const followingDay = new Date(`${input.asOf}T00:00:00Z`);
  followingDay.setUTCDate(followingDay.getUTCDate() + 1);
  const cutoff = `before:${followingDay.toISOString().slice(0, 10)}`;
  for (const row of raw?.relations ?? []) {
    const candidate = candidates.get(row?.relatedTicker);
    if (!candidate || candidate.ticker === input.ticker || accepted.has(candidate.ticker) || seen.has(candidate.ticker)) continue;
    seen.add(candidate.ticker);
    const identity = `${candidate.name} ${candidate.ticker} ${clipped(row.actualEntity, 50)}`;
    const terms = `${clipped(input.companyName, 40)} ${identity} 公司全称 主营产品 供应 合作 公告`;
    const query = `${Array.from(terms).slice(0, 127 - cutoff.length).join('').trim()} ${cutoff}`;
    queries.push({ ticker: candidate.ticker, query });
    if (queries.length === 8) break;
  }
  return queries;
}

/** Append new evidence without changing the IDs referenced by the first pass. */
export function extendRelationsSearchContext(context, batches, input, accessedAt = new Date().toISOString()) {
  const supplement = relationsSearchContext(batches, input, accessedAt);
  const sources = [...context.sources], seen = new Set(sources.map(source => canonicalUrl(source.url)));
  let contextChars = sources.reduce((sum, source) => sum + JSON.stringify(source).length, 0);
  for (const source of supplement.sources) {
    const key = canonicalUrl(source.url), size = JSON.stringify(source).length;
    if (seen.has(key) || sources.length >= 40 || contextChars + size > 120000) continue;
    sources.push({ ...source, id: `s${sources.length + 1}` }); seen.add(key); contextChars += size;
  }
  return { sources, rejectedFutureCount: context.rejectedFutureCount + supplement.rejectedFutureCount,
    rejectedWithoutTextCount: context.rejectedWithoutTextCount + supplement.rejectedWithoutTextCount };
}

/** Hints narrow the prompt; acceptance still uses the complete caller's catalog. */
export function relevantRelationCandidates(candidates, sources, subjectTicker) {
  const matches = [];
  const subjectName = compactName(candidates.get(subjectTicker)?.name ?? '');
  const mentionsHint = (value, candidate) => {
    const normalized = compactName(value);
    // Short fragments such as “时代” and “不同” are ordinary prose, not a
    // reason to suggest 时代集团控股 or 不同集团 as a business counterparty.
    const aliases = identityAliases(candidate).filter((alias, index) => index === 0
      || (alias.length >= 3 && !subjectName.includes(alias)));
    const code = candidate.ticker.split('.')[0];
    return aliases.some(alias => normalized.includes(alias)) || normalized.includes(candidate.ticker.toLowerCase())
      || new RegExp(`(^|[^0-9])${code}([^0-9]|$)`).test(value);
  };
  for (const candidate of candidates.values()) {
    if (candidate.ticker === subjectTicker) continue;
    let score = 0;
    for (const source of sources) {
      // General quotation/finance tables introduce many unrelated companies.
      if (/股票行情|资金流向|公司一览|公司列表|股票一览|融资融券|龙虎榜/.test(source.title ?? '')) continue;
      const title = (source.title ?? '').split(/[_|｜]/u)[0];
      if (mentionsHint(title, candidate)) score += 8;
      const paragraphs = (source.content ?? '').split(/\n|(?<=[。！？])/u);
      if (paragraphs.some(paragraph => paragraph.length < 1000 && mentionsHint(paragraph, candidate)
        && hasEvidenceLanguage(paragraph, 'industry_position'))) score += 2;
    }
    if (score) matches.push({ candidate, score });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, 100).map(({ candidate }) => candidate);
}

/** Bind each summary to actual Search sources without pretending it is a quote. */
export function auditRelationsAI(raw, { input, candidates, sources } = {}) {
  if (!raw || !Array.isArray(raw.relations) || !Array.isArray(raw.gaps)
    || raw.relations.length > MAX_AI_RELATIONS || raw.gaps.length > 30 || raw.gaps.some(item => !text(item, 2000))) {
    throw fail('INVALID_RELATIONS_AI_SHAPE', 'AI 返回的上下游识别项目超出约定。');
  }
  const lookup = new Map(sources.map(source => [source.id, source]));
  const relations = [], seen = new Set(), gaps = [...raw.gaps.map(item => item.trim())];
  const reject = (code, reason) => gaps.push(`已排除${TICKER.test(code) ? ` ${code}` : '一项候选关系'}：${reason}`);
  for (const row of raw.relations) {
    const code = row?.relatedTicker, candidate = candidates.get(code);
    if (!candidate || code === input.ticker || seen.has(code)) { reject(code, '证券不在本次在市 A 股/港股清单中，或为自关联/重复候选。'); continue; }
    try { validateShape(row, relationsAISchema.properties.relations.items, 'relation'); }
    catch { reject(code, '关系字段不完整或包含未约定内容。'); continue; }
    if (!text(row.rationale, 4000) || !text(row.actualEntity, 2000) || !text(row.listedMappingBasis, 4000) || !text(row.notes, 4000, true)
      || (row.relationType === 'peer') !== (row.evidenceType === 'business_comparable') || !row.sources.length || row.sources.length > 6) {
      reject(code, '关系方向、依据或上市主体映射说明不完整。'); continue;
    }
    const resolved = [], bindings = [], sourceKeys = new Set();
    let invalidSourceCount = 0;
    for (const citation of row.sources) {
      const source = lookup.get(citation.sourceId);
      if (!source || !canonicalUrl(source.url) || !source.content?.trim() || (source.publishedAt && source.publishedAt > input.asOf)) { invalidSourceCount++; continue; }
      if (!sourceKeys.has(citation.sourceId)) {
        const { id, content, ...metadata } = source;
        resolved.push({ ...metadata, sourceId: id,
          evidenceSummary: `AI 综合本条所列材料归纳：${row.rationale.trim()}` }); sourceKeys.add(id);
        bindings.push(source);
      }
    }
    if (!resolved.length) { reject(code, '没有对应本次检索材料的有效来源。'); continue; }
    if (unconfirmedMapping(row)) { reject(code, '上市主体映射尚未核实，作为待核实候选保留在缺口中。'); continue; }
    const subject = candidates.get(input.ticker);
    const sourceText = source => `${source.title}\n${source.content}`;
    const subjectBusiness = bindings.some(source => mentionsIdentity(sourceText(source), subject) && hasEvidenceLanguage(source.content, 'industry_position'));
    const actualBusiness = bindings.some(source => (mentionsIdentity(sourceText(source), candidate) || mentionsEntity(sourceText(source), row.actualEntity))
      && hasEvidenceLanguage(source.content, 'industry_position'));
    if (!actualBusiness || !subjectBusiness) { reject(code, '材料未提供双方可归纳的产品、业务或合作依据。'); continue; }
    // Legal names and ownership can be summarized across cited materials. Do
    // not demand a specific word order, an exact quote, or 300-character proximity.
    if (listedIdentityName(row.actualEntity) !== listedIdentityName(candidate.name)
      && (!bindings.some(source => mentionsEntity(sourceText(source), row.actualEntity))
        || !bindings.some(source => mentionsIdentity(sourceText(source), candidate)))) {
      reject(code, '实际业务主体及其上市公司对应关系未在所列材料中出现。'); continue;
    }
    let evidenceType = row.evidenceType;
    const direct = ['direct_business', 'technical_cooperation'].includes(evidenceType);
    const explicitDisclosure = bindings.some(source => source.publishedAt && mentionsIdentity(sourceText(source), subject)
      && (mentionsIdentity(sourceText(source), candidate) || mentionsEntity(sourceText(source), row.actualEntity))
      && hasEvidenceLanguage(source.content, evidenceType));
    const notes = [row.notes.trim()];
    if (direct && !explicitDisclosure) {
      evidenceType = 'industry_position';
      notes.push('材料未明确披露双方在该日期的直接交易或技术合作，仅按产品、业务可衔接归纳。');
    }
    if (evidenceType === 'industry_position') notes.push('产业链位置关联，未证实直接供客或直接交易。');
    if (evidenceType === 'direct_business' && bindings.some(source => /供应商.{0,30}(?:奖|荣誉)|(?:优秀|卓越|最佳).{0,10}供应商|supplier.{0,40}award|award.{0,40}supplier/i.test(source.content))) {
      notes.push('该奖项仅支持披露时的供应商身份，不代表当前合同或交易金额。');
    }
    if (invalidSourceCount) notes.push(`已忽略 ${invalidSourceCount} 条无法对应本次材料的引用，其余有效来源已保留。`);
    if (resolved.some(source => source.readingScope === 'search_snippet')) notes.push('部分依据为搜索摘要，未读取对应网页完整正文。');
    if (resolved.some(source => source.publishedAt === null)) notes.push('部分来源发布日期未知，仅作业务背景，无法确认其在研究截止日前已公开。');
    seen.add(code);
    relations.push({ relatedTicker: code, relatedName: candidate.name, relationType: row.relationType, evidenceType,
      rationale: row.rationale.trim(), actualEntity: row.actualEntity.trim(), listedMappingBasis: row.listedMappingBasis.trim(),
      notes: [...new Set(notes.filter(Boolean))].join(' '), sources: resolved });
  }
  gaps.push('本次识别依据有限次公开网页检索，可能遗漏未公开或未检索到的关系；产业链位置关联不代表直接交易。');
  if (sources.some(source => source.publishedAt === null)) gaps.push('部分检索材料未取得可靠发布日期，无法严格重建历史时点信息。');
  return { evidenceMode: RELATIONS_EVIDENCE_MODE, relations, gaps: [...new Set(gaps)].slice(0, 60) };
}

/** Existing hashes cannot reconstruct old page text. This function only removes
 * unsafe saved mappings; it never invents evidence or claims a fresh retrieval. */
export function revalidateStoredRelationsAI({ relations, gaps = [] } = {}, { input, candidates, retrievalEvidence } = {}) {
  const catalog = candidates ?? relationCandidates(input);
  if (!(catalog instanceof Map) || !Array.isArray(relations) || relations.length > MAX_AI_RELATIONS || !Array.isArray(gaps)
    || retrievalEvidence?.origin !== 'deepseek-search' || !Array.isArray(retrievalEvidence.sources)) throw fail('INVALID_RELATIONS_AI_SHAPE', '旧关系复核需要原始检索审计与在市证券清单。');
  const lookup = new Map(retrievalEvidence.sources.map(source => [source.id, source]));
  const retained = [], rejected = [], seen = new Set();
  for (const row of relations) {
    const candidate = catalog.get(row?.relatedTicker);
    let reason = '';
    if (!candidate || row.relatedTicker === input.ticker || seen.has(row.relatedTicker) || row.relatedName !== candidate.name || !text(row.actualEntity, 2000)) reason = '证券身份与当前清单不符或重复。';
    else if (!Array.isArray(row.sources) || !row.sources.length || row.sources.some(source => {
      const retrieved = lookup.get(source?.sourceId);
      return !retrieved || !/^[a-f0-9]{64}$/.test(retrieved.contentSha256 ?? '') || canonicalUrl(retrieved.url) !== canonicalUrl(source.url)
        || retrieved.publishedAt !== source.publishedAt || (source.publishedAt && source.publishedAt > input.asOf) || !text(source.excerpt, 500);
    })) reason = '旧摘录缺少可对应的原始检索ID、URL、日期或正文hash审计。';
    else {
      const mapping = auditRelationListedMapping(row, candidate, { texts: row.sources.map(source => source.excerpt) });
      if (!mapping.ok) reason = mapping.reason;
      else if (!row.sources.some(source => mentionsIdentity(source.excerpt, candidate) && mentionsEntity(source.excerpt, row.actualEntity)
        && hasEvidenceLanguage(source.excerpt, row.evidenceType))) reason = '没有原正文，旧摘录自身不足以保守确认候选与实际业务法人的关系语境。';
    }
    if (reason) rejected.push({ relatedTicker: TICKER.test(row?.relatedTicker) ? row.relatedTicker : null, reason });
    else { retained.push(structuredClone(row)); seen.add(row.relatedTicker); }
  }
  return { relations: retained, gaps: [...new Set([...gaps, ...rejected.map(row => `复核排除 ${row.relatedTicker ?? '候选'}：${row.reason}`),
    '本次仅依据旧任务保存的精确摘录与检索hash审计复核证券映射，未重新抓取网页，也未重新验证原正文。'])],
    revalidation: { mode: 'stored-excerpt-mapping-only', originalTextReverified: false, rejected } };
}
