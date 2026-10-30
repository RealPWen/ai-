export const eventCategories = ['全部', '公司', '同行', '上游', '下游', '政策'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const ticker = value => typeof value === 'string' && /^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(value);
const integer = value => Number.isInteger(value) && value >= 0;
const fail = () => { throw new Error('资讯数据格式或研究日期不符'); };
export function eventSourceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

// News timestamps are compared in the market's timezone, including on historical research dates.
export function eventChinaDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !date(value.slice(0, 10)) || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return '';
  const time = Date.parse(value); return Number.isNaN(time) ? '' : new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function adaptCoverage(value) {
  if (value == null) return null;
  if (!object(value) || !['complete', 'partial', 'not_synced'].includes(value.status) || typeof value.complete !== 'boolean'
    || !integer(value.coveredSeconds) || !integer(value.totalSeconds) || value.totalSeconds <= 0 || value.coveredSeconds > value.totalSeconds
    || (value.status === 'complete') !== value.complete) fail();
  for (const key of ['requestedFrom', 'requestedThrough']) if (!eventChinaDate(value[key])) fail();
  if (Date.parse(value.requestedFrom) >= Date.parse(value.requestedThrough)) fail();
  for (const key of ['coveredFrom', 'coveredThrough', 'latestCoveredAt']) if (value[key] != null && !eventChinaDate(value[key])) fail();
  if (!Array.isArray(value.sourceApis ?? [])) fail();
  return { ...value, sourceApis: (value.sourceApis ?? []).filter(source => typeof source === 'string') };
}

export function adaptEvents(response) {
  const data = response && Object.hasOwn(response, 'data') ? response.data : response;
  if (data == null) return null;
  if (!object(data) || !ticker(data.ticker) || !date(data.asOf) || !date(data.from) || data.from > data.asOf || !eventCategories.includes(data.category)) fail();
  if (!integer(data.total) || !integer(data.offset) || !integer(data.limit) || data.limit < 1 || data.limit > 100 || typeof data.hasMore !== 'boolean' || !Array.isArray(data.items) || data.items.length > data.limit) fail();
  if (data.offset + data.items.length > data.total || data.hasMore !== (data.offset + data.items.length < data.total) || (data.hasMore && !data.items.length)) fail();
  const seen = new Set();
  const items = data.items.map(item => {
    if (!object(item) || !text(item.id).trim() || seen.has(item.id) || !text(item.title).trim() || !eventCategories.slice(1).includes(item.category)) fail();
    const publishedDate = eventChinaDate(item.publishedAt);
    if (!publishedDate || publishedDate < data.from || publishedDate > data.asOf || (data.category !== '全部' && item.category !== data.category)) fail();
    if (!text(item.sourceApi).trim() || !text(item.sourceName).trim() || !Array.isArray(item.relatedCompanies ?? [])) fail();
    seen.add(item.id);
    const relatedCompanies = (item.relatedCompanies ?? []).map(company => {
      if (!object(company) || !ticker(company.ticker) || !text(company.name).trim()) fail();
      return { ticker: company.ticker, name: company.name, relationType: text(company.relationType) };
    });
    const content = text(item.content), contentKind = item.contentKind ?? (content ? 'fulltext' : 'none');
    if (!['fulltext', 'summary', 'none'].includes(contentKind) || (contentKind === 'none') !== (content === '')) fail();
    return { id: item.id, title: item.title.trim(), content, contentKind, publishedAt: item.publishedAt, sourceApi: item.sourceApi, sourceName: item.sourceApi === 'cls_web' ? '财联社官网' : item.sourceName, url: eventSourceUrl(item.url), category: item.category, relatedCompanies };
  });
  const meta = object(data.meta) ? data.meta : {};
  if (!Array.isArray(meta.sources ?? [])) fail();
  const sources = (meta.sources ?? []).map(source => {
    if (!object(source) || !text(source.sourceApi) || !['available', 'permission_denied', 'failed', 'not_synced', 'empty'].includes(source.status)) fail();
    if (source.articleCount != null && !integer(source.articleCount)) fail();
    return { sourceApi: source.sourceApi, status: source.status, updatedAt: text(source.updatedAt) || null,
      articleCount: source.articleCount ?? 0, firstPublishedAt: text(source.firstPublishedAt) || null, latestPublishedAt: text(source.latestPublishedAt) || null, coverage: adaptCoverage(source.coverage) };
  });
  return { ticker: data.ticker, asOf: data.asOf, from: data.from, category: data.category, items, total: data.total, offset: data.offset, limit: data.limit, hasMore: data.hasMore, meta: { ...meta, sources, coverage: adaptCoverage(meta.coverage) } };
}

export function assertEventsContext(data, { ticker: selected, asOf, category = '公司', offset = 0 }) {
  if (data && (data.ticker !== selected || data.asOf !== asOf || data.category !== category || data.offset !== offset)) throw new Error('资讯接口返回的股票、日期、分类或页码与当前选择不一致');
  return data;
}
