import { canonicalUrl } from './source-audit.mjs';
import { validDate } from './input.mjs';

const REASONS = ['identity_error', 'relationship_ended', 'business_changed', 'stronger_business_relevance'];
export const relationChangesSchema = { type: 'array', maxItems: 10, items: {
  type: 'object', additionalProperties: false,
  required: ['oldTicker', 'newTicker', 'reasonCode', 'reason', 'sources'],
  properties: { oldTicker: { type: 'string' }, newTicker: { type: ['string', 'null'] },
    reasonCode: { type: 'string', enum: REASONS }, reason: { type: 'string' },
    sources: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false,
      required: ['sourceId'], properties: { sourceId: { type: 'string' } } } } },
} };
const strength = row => ({ manual: 100, direct_business: 3, technical_cooperation: 2,
  business_comparable: 1, industry_position: 0 })[row?.evidenceType] ?? 0;
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s·（）()\-]/gu, '');
function mentions(value, company) {
  const normalized = normalize(value), name = normalize(String(company?.relatedName ?? company?.name ?? '').replace(/-(?:sw|ss|w|s|r|b)$/i, ''));
  const ticker = company?.relatedTicker ?? company?.ticker;
  return Boolean(name && normalized.includes(name))
    || Boolean(ticker && normalized.includes(ticker.toLowerCase()));
}

/** The model's preference alone cannot remove a previously saved company. */
export function proposeCoverageChanges({previousRelations=[],proposedRelations=[],sources=[],asOf}={}) {
  if(previousRelations.length<10)return [];
  const counts={upstream:0,peer:0,downstream:0};
  previousRelations.forEach(row=>{if(Object.hasOwn(counts,row.relationType))counts[row.relationType]++;});
  const dominant=Object.keys(counts).find(type=>counts[type]/previousRelations.length>=0.7);
  if(!dominant)return [];
  const oldCodes=new Set(previousRelations.map(row=>row.relatedTicker));
  const fresh=new Map(proposedRelations.map(row=>[row.relatedTicker,row]));
  const dated=sources.filter(source=>validDate(source.publishedAt)&&source.publishedAt<=asOf);
  const oldPool=previousRelations.filter(row=>row.relationType===dominant && row.evidenceType==='industry_position'
    && row.origin!=='manual' && strength(fresh.get(row.relatedTicker))<2);
  const changes=[],used=new Set();
  for(const next of proposedRelations) {
    if(changes.length>=3)break;
    if(oldCodes.has(next.relatedTicker)||strength(next)<2||next.relationType===dominant||counts[next.relationType]>1)continue;
    const nextSources=dated.filter(source=>next.sources.some(item=>item.sourceId===source.id)&&mentions(`${source.title}\n${source.content}`,next));
    if(!nextSources.length)continue;
    const supportsOld=(source,row)=>mentions(`${source.title}\n${source.content}`.replaceAll(next.relatedName,'').replaceAll(next.relatedTicker,''),row);
    const old=oldPool.find(row=>!used.has(row.relatedTicker)&&dated.some(source=>supportsOld(source,row)));
    if(!old)continue;
    const oldSource=dated.find(source=>supportsOld(source,old));
    changes.push({oldTicker:old.relatedTicker,newTicker:next.relatedTicker,reasonCode:'stronger_business_relevance',
      reason:`${old.relatedName}当前保存的依据仅为产业链位置，未证实直接交易；${next.relatedName}本次资料明确：${next.rationale.slice(0,800).replace(/[。；;]+$/u,'')}。新项有更强的直接业务或技术合作依据，补充原名单遗漏或偏少的业务环节，保留其余已有公司。`,
      sources:[...new Set([oldSource.id,...nextSources.map(source=>source.id)])].slice(0,6).map(sourceId=>({sourceId}))});
    used.add(old.relatedTicker);
  }
  return changes;
}

/** The model's preference alone cannot remove a previously saved company. */
export function auditRelationChanges(rawChanges, { input, candidates, sources, proposedRelations } = {}) {
  const existing = new Map((input.existingRelations ?? []).map(row => [row.relatedTicker, row]));
  const proposed = new Map((proposedRelations ?? []).map(row => [row.relatedTicker, row]));
  const lookup = new Map(sources.map(source => [source.id, source]));
  const changes = [], rejectedChanges = [], seen = new Set();
  const reject = (row, reason) => rejectedChanges.push({ oldTicker: row?.oldTicker ?? null, reason });
  for (const row of Array.isArray(rawChanges) ? rawChanges.slice(0, 10) : []) {
    const old = existing.get(row?.oldTicker), next = row?.newTicker ? proposed.get(row.newTicker) : null;
    if (!old || seen.has(row.oldTicker) || !REASONS.includes(row.reasonCode)
      || (row.newTicker !== null && (!next || !candidates.has(row.newTicker) || existing.has(row.newTicker)))) {
      reject(row, '调整对象无效、重复，或新公司没有通过本次业务与证券核验。'); continue;
    }
    seen.add(row.oldTicker);
    if (old.origin === 'manual' || old.evidenceType === 'manual') { reject(row, '人工指定的公司由人工修改，AI 不替换。'); continue; }
    if (typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 4000
      || !mentions(row.reason, old) || (next && !mentions(row.reason, next))) {
      reject(row, '需针对原公司和新公司说明具体调整事实，不能只写更合适或未检索到。'); continue;
    }
    const bindings = [...new Set((Array.isArray(row.sources) ? row.sources : []).map(item => item?.sourceId))]
      .map(id => lookup.get(id)).filter(source => source && canonicalUrl(source.url) && source.content?.trim()
        && validDate(source.publishedAt) && source.publishedAt <= input.asOf);
    if (!bindings.length || bindings.length > 6) { reject(row, '调整理由缺少本次取得、有日期且不晚于截止日的有效资料。'); continue; }
    const proof = bindings.map(source => `${source.title}\n${source.content}`).join('\n');
    const oldMentioned = mentions(proof, old), nextMentioned = next && mentions(proof, next);
    // A change affecting another company elsewhere in an article cannot be
    // used to remove this one. This restriction is for removals, not discovery.
    const oldStatements=bindings.flatMap(source=>[source.title,...source.content.split(/\n|(?<=[。！？;；])/u)])
      .filter(statement=>mentions(statement,old));
    let sufficient = false;
    if (row.reasonCode === 'identity_error') sufficient = oldStatements.some(statement=>
      /证券代码|股票代码|证券简称|上市|子公司|主体|归属|对应|ticker|subsidiar|issuer/i.test(statement)
      && /更正|误认|错误|并非|不属于|不对应|代码有误|correction|incorrect|misidentif/i.test(statement));
    if (row.reasonCode === 'relationship_ended') sufficient = oldStatements.some(statement=>mentions(statement, { name: input.companyName })
      && !/(?:未|不|没有|并未|不会|尚未).{0,8}(?:终止|解除|停止|取消)|并非.{0,8}(?:终止|解除)/u.test(statement)
      && /终止.{0,20}(?:合作|供货|合同|协议)|(?:合作|供货|合同|协议).{0,20}(?:终止|解除)|停止合作|不再供货|不再合作|取消.{0,15}供应商|end.{0,20}(?:contract|partnership)/i.test(statement));
    if (row.reasonCode === 'business_changed') sufficient = oldStatements.some(statement=>
      !/(?:未|不|没有|并未|不会|尚未).{0,8}(?:剥离|退出|停止|终止|转型|出售)/u.test(statement)
      && /(?:剥离|退出|停止|终止|出售|不再经营).{0,25}(?:主营|业务|产品线|产线|板块|部门)|(?:主营业务|产品线|产线|业务板块).{0,25}(?:变更|调整|剥离|退出|停止|终止|出售|转型)|divest.{0,25}business|discontinu.{0,25}product/i.test(statement));
    if (row.reasonCode === 'stronger_business_relevance') sufficient = Boolean(next && oldMentioned && nextMentioned
      && strength(next) >= 2 && strength(next) > strength(old)
      && /供货|采购|订单|客户|合同|交付|技术合作|联合研发|supplier|contract|deliver/i.test(row.reason));
    if (!sufficient || (next && !nextMentioned)) { reject(row, '资料尚不足以支持所述调整；普通相关性比较或未检索到旧公司不足以换股。'); continue; }
    changes.push({ oldTicker: row.oldTicker, oldName: old.relatedName, newTicker: next?.relatedTicker ?? null,
      newName: next?.relatedName ?? null, reasonCode: row.reasonCode, reason: row.reason.trim(),
      sources: bindings.map(({ id, content, ...source }) => ({ ...source, sourceId: id, evidenceSummary: row.reason.trim() })) });
  }
  return { changes, rejectedChanges };
}

/** Only bound, server-audited decisions can free an occupied position. */
export function applyRelationsRetention({ previousRelations = [], proposedRelations = [], changes = [],
  candidates, protectedTickers = [], excludedNewTickers = [], hiddenTickers = [], reservedManualCount = 0, rejectedChangeCount = 0 } = {}) {
  const catalog = candidates instanceof Map ? candidates : new Map((candidates ?? []).map(row => [row.ticker, row]));
  const proposed = new Map(proposedRelations.map(row => [row.relatedTicker, row]));
  const oldCodes = new Set(previousRelations.map(row => row.relatedTicker));
  const protectedCodes = new Set(protectedTickers), decisions = new Map(changes.map(row => [row.oldTicker, row]));
  const excluded = new Set(excludedNewTickers);
  const hidden = new Set(hiddenTickers);
  const result = [], used = new Set(), applied = [];
  let blockedCount = rejectedChangeCount;
  for (const old of previousRelations) {
    const candidate = catalog.get(old.relatedTicker), fresh = proposed.get(old.relatedTicker), decision = decisions.get(old.relatedTicker);
    if (!candidate) {
      applied.push({ oldTicker: old.relatedTicker, oldName: old.relatedName, newTicker: null, newName: null,
        reasonCode: 'not_listed', reason: '该证券已不在当前在市 A 股或港股目录中，按证券目录移除。', sources: [] }); continue;
    }
    if (decision && !protectedCodes.has(old.relatedTicker)) {
      const replacement = decision.newTicker ? proposed.get(decision.newTicker) : null;
      if (!decision.newTicker || (replacement && !oldCodes.has(decision.newTicker) && !used.has(decision.newTicker) && !excluded.has(decision.newTicker))) {
        if (replacement) { result.push(replacement); used.add(replacement.relatedTicker); }
        applied.push(decision); continue;
      }
      blockedCount++;
    }
    // Do not overwrite an established disclosure with weaker classification or
    // mark an omitted company as freshly verified. Existing sources keep dates.
    const retained = fresh && !protectedCodes.has(old.relatedTicker) && strength(fresh) >= strength(old) ? fresh : old;
    result.push({ ...retained, relatedName: candidate.name }); used.add(old.relatedTicker);
  }
  for (const row of proposedRelations) {
    if (used.has(row.relatedTicker) || oldCodes.has(row.relatedTicker) || !catalog.has(row.relatedTicker) || excluded.has(row.relatedTicker)) continue;
    const visibleCount=result.filter(item=>!hidden.has(item.relatedTicker)).length;
    if (visibleCount+reservedManualCount<10) {
      // A human-removed item may still be in the base for Restore. Only release
      // that hidden position when an actual visible vacancy is being filled.
      if (result.length>=10) {
        const hiddenIndex=result.findIndex(item=>hidden.has(item.relatedTicker));
        if (hiddenIndex<0) {blockedCount++;continue;}
        used.delete(result[hiddenIndex].relatedTicker);result.splice(hiddenIndex,1);
      }
      result.push(row); used.add(row.relatedTicker);
    } else blockedCount++;
  }
  const retainedCount = result.filter(row => oldCodes.has(row.relatedTicker)).length;
  return { relations: result.map((row, index) => ({ ...row, rank: index + 1 })),
    refreshSummary: { retainedCount, addedCount: result.length - retainedCount,
      removedCount: previousRelations.length - retainedCount, blockedCount, changes: applied } };
}
