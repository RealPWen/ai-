const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const ticker = value => typeof value === 'string' && /^\d{6}\.(SH|SZ|BJ)$/.test(value);
const subjectTicker = value => ticker(value) || (typeof value === 'string' && /^\d{5}\.HK$/.test(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('关联公司数据格式或研究日期不符'); };
const number = value => { if (value == null) return null; if (typeof value !== 'number' || !Number.isFinite(value)) fail(); return value; };
const text = value => typeof value === 'string' ? value : '';
const periods = ['w1', 'm1', 'm6', 'y1', 'y3'];

function market(value, asOf) {
  if (value == null) return null;
  if (!object(value)) fail();
  for (const key of ['tradeDate', 'valuationAsOf']) if (value[key] != null && (!date(value[key]) || value[key] > asOf)) fail();
  const result = { ...value, close: number(value.close), changePct: number(value.changePct), peTtm: number(value.peTtm), pb: number(value.pb), returns: {}, returnStatus: {} };
  if (result.close != null && result.close <= 0) fail();
  if (value.valuationAsOf != null && value.valuationAsOf !== value.tradeDate) fail();
  for (const key of periods) { result.returns[key] = number(value.returns?.[key]); result.returnStatus[key] = text(value.returnStatus?.[key]); }
  return result;
}

export function adaptRelations(response) {
  const data = response && Object.hasOwn(response, 'data') ? response.data : response;
  if (data == null) return null;
  if (!object(data) || !subjectTicker(data.ticker) || !date(data.asOf) || !['complete', 'partial', 'not_researched', 'not_available_as_of', 'customized'].includes(data.status)) fail();
  if (data.relationAsOf != null && (!date(data.relationAsOf) || data.relationAsOf > data.asOf)) fail();
  if (!Array.isArray(data.relations) || data.relations.length > 10) fail();
  const seen = new Set(), counts = { upstream: 0, peer: 0, downstream: 0, total: data.relations.length };
  const relations = data.relations.map(item => {
    const manual = item?.evidenceType === 'manual';
    if (!object(item) || !subjectTicker(item.relatedTicker) || item.relatedTicker === data.ticker || seen.has(item.relatedTicker)) fail();
    const alternateTickers = item.alternateTickers ?? [];
    if (!Array.isArray(alternateTickers) || alternateTickers.some(code => !subjectTicker(code) || code === data.ticker || code === item.relatedTicker)
      || new Set(alternateTickers).size !== alternateTickers.length || alternateTickers.some(code => seen.has(code))) fail();
    for (const code of [item.relatedTicker, ...alternateTickers]) seen.add(code);
    if (!['upstream', 'peer', 'downstream'].includes(item.relationType) || !['direct_business', 'technical_cooperation', 'industry_position', 'business_comparable', 'manual'].includes(item.evidenceType)) fail();
    if (!manual && (item.relationType === 'peer') !== (item.evidenceType === 'business_comparable')) fail();
    if (!text(item.relatedName).trim() || (!manual && !text(item.rationale).trim()) || !Array.isArray(item.sources) || (!manual && !item.sources.length)) fail();
    if (manual && (item.origin !== 'manual' || typeof item.manualUpdatedAt !== 'string' || Number.isNaN(Date.parse(item.manualUpdatedAt))
      || !date(item.manualEffectiveDate) || item.manualEffectiveDate > data.asOf || item.sources.length)) fail();
    counts[item.relationType]++;
    const sources = item.sources.map(source => {
      if (!object(source) || !text(source.url) || !text(source.title) || (!text(source.excerpt).trim() && !text(source.evidenceSummary).trim())
        || !['full_text', 'partial_text', 'search_snippet'].includes(source.readingScope)) fail();
      if (source.publishedAt != null && (!date(source.publishedAt) || source.publishedAt > data.asOf)) fail();
      if (!text(source.accessedAt) || Number.isNaN(Date.parse(source.accessedAt))) fail();
      return { ...source, excerpt: text(source.excerpt), evidenceSummary: text(source.evidenceSummary) };
    });
    if (item.verifiedAt != null && (!text(item.verifiedAt) || Number.isNaN(Date.parse(item.verifiedAt)))) fail();
    return { ...item, alternateTickers, rationale: text(item.rationale), notes: text(item.notes), actualEntity: text(item.actualEntity), listedMappingBasis: text(item.listedMappingBasis), sources, market: market(item.market, data.asOf) };
  });
  if (data.status === 'complete' && !relations.length) fail();
  if (['not_researched', 'not_available_as_of'].includes(data.status) && relations.length) fail();
  const meta = { ...data.meta, targetCount: 10, manualRevision: data.meta?.manualRevision ?? '0', hasManualChanges: data.meta?.hasManualChanges === true };
  if (typeof meta.manualRevision !== 'string' || !/^\d+$/.test(meta.manualRevision)) fail();
  const removed = data.meta?.removedRelations ?? [];
  if (!Array.isArray(removed)) fail();
  const removedTickers = new Set();
  meta.removedRelations = removed.map(item => {
    if (!object(item) || !subjectTicker(item.relatedTicker) || item.relatedTicker === data.ticker || seen.has(item.relatedTicker) || removedTickers.has(item.relatedTicker)) fail();
    if (item.relationType != null && !['upstream', 'peer', 'downstream'].includes(item.relationType)) fail();
    removedTickers.add(item.relatedTicker);
    return { ...item, relatedName: text(item.relatedName) || item.relatedTicker, rationale: text(item.rationale) };
  });
  return { ...data, meta, counts, missing: 0, subject: { ...data.subject, ticker: data.ticker, name: text(data.subject?.name) || data.ticker, market: market(data.subject?.market, data.asOf) }, relations, gaps: Array.isArray(data.gaps) ? data.gaps.filter(value => typeof value === 'string') : [] };
}

export function assertRelationsContext(data, { ticker: selected, asOf }) {
  if (data && (data.ticker !== selected || data.asOf !== asOf)) throw new Error('关联公司接口返回的标的或截止日期与当前选择不一致');
  return data;
}

// Independent AI and manual reads may finish in either order for the same page.
export function assertRelationsRevision(data, previous) {
  if (!data || !previous || data.ticker !== previous.ticker || data.asOf !== previous.asOf) return data;
  const next = data.meta?.manualRevision ?? '0', current = previous.meta?.manualRevision ?? '0';
  if (typeof next !== 'string' || !/^\d+$/.test(next) || typeof current !== 'string' || !/^\d+$/.test(current)) fail();
  if (BigInt(next) < BigInt(current)) throw new Error('关系已被人工修改，当前页面已保留新修改。请重新读取最新结果。');
  return data;
}

export const relationLabels = { upstream: '上游', peer: '同行', downstream: '下游' };
export const evidenceLabels = { direct_business: '直接业务', technical_cooperation: '技术合作', industry_position: '产业链位置', business_comparable: '业务可比', manual: '人工修改' };
