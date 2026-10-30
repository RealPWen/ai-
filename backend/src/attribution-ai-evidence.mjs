import { createHash } from 'node:crypto';
import { canonicalUrl } from './source-audit.mjs';
import { todayShanghai, validDate } from './input.mjs';
import { validateShape } from './schema.mjs';
import { ResearchError } from './errors.mjs';

const TICKER = /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/;
const string = { type: 'string' };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const enumeration = values => ({ type: 'string', enum: values });
export const MAX_ATTRIBUTION_DRIVERS = 5;
export const attributionAISchema = object({
  summary: string,
  drivers: { type: 'array', maxItems: MAX_ATTRIBUTION_DRIVERS, items: object({
    title: string,
    category: enumeration(['company', 'industry', 'market', 'valuation', 'capital', 'corporate_action', 'other']),
    direction: enumeration(['positive', 'negative', 'mixed', 'uncertain']),
    explanation: string,
    sourceIds: { type: 'array', minItems: 1, maxItems: 5, items: string },
  }) },
  limitations: { type: 'array', maxItems: 20, items: string },
  corporateActionStatus: enumeration(['identified', 'not_identified', 'uncertain']),
});

const fail = (code, message, status = 502) => new ResearchError(code, message, status);
const clipped = (value, max) => typeof value === 'string' ? value.replaceAll('\u0000', '').slice(0, max) : '';
const text = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\u0000');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const newsWindow = snapshot => ({ from: snapshot.newsFrom ?? snapshot.coverage.requestedFrom, to: snapshot.newsTo ?? snapshot.to });
const sectorInfo = snapshot => snapshot.sector
  ? { name: clipped(snapshot.sector.name, 200).trim(), source: clipped(snapshot.sector.source, 200).trim(), known: snapshot.sector.known }
  : { name: '', source: 'unknown', known: false };

/** Return calculations remain immutable; news uses the full selected period. */
export function validateAttributionSnapshot(snapshot) {
  if (!snapshot || !TICKER.test(snapshot.ticker) || !text(snapshot.companyName, 200)
    || !['1m', '6m', '1y'].includes(snapshot.period)
    || !validDate(snapshot.requestedAsOf) || !validDate(snapshot.from) || !validDate(snapshot.to)
    || snapshot.from >= snapshot.to || snapshot.to > snapshot.requestedAsOf
    || ![snapshot.stockReturn, snapshot.indexReturn, snapshot.excessPercentagePoints].every(finite)
    || !snapshot.benchmark || !text(snapshot.benchmark.indexCode, 100) || !text(snapshot.benchmark.industryName, 200)
    || !['qfq', 'none'].includes(snapshot.adjustment) || !['CNY', 'HKD', 'USD'].includes(snapshot.currency)
    || !text(snapshot.inputHash, 200) || !Array.isArray(snapshot.series) || snapshot.series.length < 2 || snapshot.series.length > 400
    || !snapshot.coverage || !validDate(snapshot.coverage.requestedFrom) || snapshot.coverage.requestedFrom > snapshot.from
    || snapshot.coverage.actualFrom !== snapshot.from || snapshot.coverage.actualTo !== snapshot.to
    || snapshot.coverage.pointCount !== snapshot.series.length || typeof snapshot.coverage.partial !== 'boolean') {
    throw fail('INVALID_ATTRIBUTION_INPUT', '涨跌归因需要有效的股票、比较基准和共同交易日行情快照。', 400);
  }
  if (snapshot.series[0]?.date !== snapshot.from || snapshot.series.at(-1)?.date !== snapshot.to
    || snapshot.series.some((point, index) => !validDate(point?.date) || point.date < snapshot.from || point.date > snapshot.to
      || (index > 0 && point.date <= snapshot.series[index - 1].date)
      || !finite(point.stockClose) || point.stockClose <= 0 || !finite(point.indexClose) || point.indexClose <= 0)) {
    throw fail('INVALID_ATTRIBUTION_INPUT', '涨跌归因的行情必须按共同交易日对齐，且价格为正数。', 400);
  }
  if (snapshot.ticker.endsWith('.HK') ? snapshot.adjustment !== 'none' || !['HKD', 'USD'].includes(snapshot.currency) : snapshot.adjustment !== 'qfq' || snapshot.currency !== 'CNY') {
    throw fail('INVALID_ATTRIBUTION_INPUT', '港股归因使用港元或美元未复权价格，A 股使用人民币前复权价格。', 400);
  }
  if ((snapshot.newsFrom !== undefined && (!validDate(snapshot.newsFrom) || snapshot.newsFrom !== snapshot.coverage.requestedFrom))
    || (snapshot.newsTo !== undefined && snapshot.newsTo !== snapshot.to)
    || (snapshot.sector !== undefined && (!snapshot.sector || typeof snapshot.sector.known !== 'boolean'
      || typeof snapshot.sector.name !== 'string' || snapshot.sector.name.length > 200
      || !text(snapshot.sector.source, 200) || (snapshot.sector.known && !text(snapshot.sector.name, 200))))) {
    throw fail('INVALID_ATTRIBUTION_INPUT', '新闻窗口或板块资料无效，无法生成本周期归因。', 400);
  }
  return snapshot;
}

function adjacentDate(value, offset) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** Company and sector searches are independent, so sector results are not
 * accidentally restricted to news that also names the current company. */
export function attributionSearchPlan(snapshot) {
  validateAttributionSnapshot(snapshot);
  const window = newsWindow(snapshot), sector = sectorInfo(snapshot);
  const dates = `after:${adjacentDate(window.from, -1)} before:${adjacentDate(window.to, 1)}`;
  const subject = `${snapshot.ticker} ${clipped(snapshot.companyName, 32)}`;
  // HSI is a return benchmark, never a company's industry classification.
  const industry = sector.known ? clipped(sector.name, 32) : `${snapshot.ticker.endsWith('.HK') ? '港股' : 'A股'} 主营业务 行业 板块`;
  const plan = [
    { kind: 'stock', query: `${dates} ${subject} 公司新闻 公告 财报 业绩 经营` },
    { kind: 'stock', query: `${dates} ${subject} 订单 产品 风险 回购 减持 新闻` },
    { kind: 'sector', query: `${dates} ${industry} 行业新闻 政策 景气 需求 竞争` },
    { kind: 'sector', query: `${dates} ${industry} 板块新闻 业绩 估值 市场 表现` },
  ];
  if (snapshot.ticker.endsWith('.HK')) plan.push({ kind: 'stock', query: `${dates} ${subject} 港交所 拆股 合股 股息 特别分派 除权 dividend` });
  return plan.map(({ kind, query }) => ({ kind, query: Array.from(query).slice(0, 128).join('') }));
}
export const attributionSearchQueries = snapshot => attributionSearchPlan(snapshot).map(({ query }) => query);

function publishedDate(value) {
  if (validDate(value)) return value;
  if (typeof value !== 'string' || !validDate(value.slice(0, 10))
    || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? todayShanghai(date) : null;
}
const primarySource = url => {
  const host = new URL(url).hostname;
  return ['cninfo.com.cn', 'hkexnews.hk', 'hkex.com.hk', 'sse.com.cn', 'szse.cn', 'bse.cn'].some(domain => host === domain || host.endsWith(`.${domain}`));
};

/** Prefer retrieved body text. Dated search snippets are usable bounded news
 * material, without pretending the full article has been read. */
export function attributionSearchContext(batches, snapshot, accessedAt = new Date().toISOString()) {
  validateAttributionSnapshot(snapshot);
  const window = newsWindow(snapshot), plan = attributionSearchPlan(snapshot);
  const grouped = batches.map((batch, index) => Array.isArray(batch)
    ? { kind: plan[index]?.kind ?? 'stock', results: batch }
    : { kind: batch?.kind === 'sector' ? 'sector' : 'stock', results: Array.isArray(batch?.results) ? batch.results : [] });
  const unique = new Map();
  let rejectedFutureCount = 0, rejectedBeforeWindowCount = 0, rejectedWithoutTextCount = 0;
  const ordered = [];
  for (let index = 0; index < Math.max(0, ...grouped.map(batch => batch.results.length)); index++) {
    for (const batch of grouped) if (index < batch.results.length) ordered.push({ result: batch.results[index], kind: batch.kind });
  }
  for (const { result, kind } of ordered) {
    const url = clipped(result?.url, 2049), key = canonicalUrl(url);
    if (!key || url.length > 2048 || !clipped(result?.title, 300).trim()) continue;
    const publishedAt = publishedDate(result.date);
    if (publishedAt && publishedAt > window.to) { rejectedFutureCount++; continue; }
    if (publishedAt && publishedAt < window.from) { rejectedBeforeWindowCount++; continue; }
    const body = clipped(result.content, 7500).trim();
    const snippet = [result.summary, result.snippet, result.description].map(value => clipped(value, 1800).trim()).find(Boolean) ?? '';
    const content = body || snippet;
    if (content.length < 8) { rejectedWithoutTextCount++; continue; }
    const source = { url, title: clipped(result.title, 300).trim(), publishedAt, accessedAt,
      readingScope: body ? 'partial_text' : 'search_snippet', eligibleForDriver: publishedAt !== null, content, newsKinds: [kind] };
    const previous = unique.get(key), newsKinds = [...new Set([...(previous?.newsKinds ?? []), kind])];
    if (!previous || (source.eligibleForDriver && !previous.eligibleForDriver)
      || (source.eligibleForDriver === previous.eligibleForDriver && (source.readingScope === 'partial_text' && previous.readingScope !== 'partial_text'
        || source.readingScope === previous.readingScope && source.content.length > previous.content.length))) unique.set(key, { ...source, newsKinds });
    else previous.newsKinds = newsKinds;
  }
  const ranked = [...unique.values()].sort((a, b) => Number(b.eligibleForDriver) - Number(a.eligibleForDriver)
    || Number(primarySource(b.url)) - Number(primarySource(a.url)));
  const sources = [];
  let contextChars = 0, backgroundCount = 0;
  for (const source of ranked) {
    if (!source.eligibleForDriver && backgroundCount >= 4) continue;
    const size = JSON.stringify(source).length;
    if (contextChars + size > 120000) continue;
    sources.push({ id: `s${sources.length + 1}`, ...source }); contextChars += size;
    if (!source.eligibleForDriver) backgroundCount++;
    if (sources.length === 24) break;
  }
  return { sources, rejectedFutureCount, rejectedBeforeWindowCount, rejectedWithoutTextCount };
}

const normalizeIdentity = value => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s·•・()（）,，.。\-]/g, '');
function mentionsCompany(content, snapshot) {
  const name = normalizeIdentity(snapshot.companyName).replace(/(?:sw|ss|w|s|r|b)$/i, '');
  const abbreviated = name.replace(/(?:集团)?(?:股份有限公司|有限责任公司|有限公司|控股|集团)$/u, '');
  const normalized = normalizeIdentity(content), code = snapshot.ticker.split('.')[0];
  return [name, abbreviated].filter(value => value.length >= 2).some(value => normalized.includes(value))
    || content.toUpperCase().includes(snapshot.ticker)
    || new RegExp(`(^|[^0-9])${code}([^0-9]|$)`).test(content);
}
const corporateLanguage = value => /拆股|拆细|拆細|合股|股份合并|股份合併|除权|除權|除息|特别(?:股息|分派)|特別(?:股息|分派)|股息|分红|分紅|派息|split|consolidat|dividend|distribution/i.test(value);
const uniqueTexts = (items, max = 20) => [...new Set(items.map(item => clipped(item, 2000).trim()).filter(Boolean))].slice(0, max);

/** IDs bind conclusions to retrieved news. A bad citation removes only that
 * citation or driver; it does not discard other useful, sourced conclusions. */
export function auditAttributionAI(raw, { snapshot, sources } = {}) {
  validateAttributionSnapshot(snapshot);
  try { validateShape(raw, attributionAISchema, 'attribution'); }
  catch { throw fail('INVALID_ATTRIBUTION_AI_SHAPE', 'AI 返回的涨跌归因字段不完整，请重试。'); }
  if (!clipped(raw.summary, 4000).trim()) throw fail('INVALID_ATTRIBUTION_AI_SHAPE', 'AI 没有返回可用的新闻归纳结论，请重试。');
  const window = newsWindow(snapshot), sector = sectorInfo(snapshot);
  const lookup = new Map((Array.isArray(sources) ? sources : []).map(source => [source.id, source]));
  const eligible = source => source && canonicalUrl(source.url) && validDate(source.publishedAt)
    && source.publishedAt >= window.from && source.publishedAt <= window.to && text(source.content, 50000)
    && source.content.length >= 8 && ['partial_text', 'search_snippet'].includes(source.readingScope);
  const usable = [...lookup.values()].filter(eligible);
  if (!usable.length) throw fail('ATTRIBUTION_SOURCES_UNVERIFIED', '搜索未取得所选时间窗口内有日期的个股或板块新闻正文、摘要，原归因仍保留。');
  const newsCoverage = {
    stock: usable.filter(source => source.newsKinds?.includes('stock')).length,
    sector: usable.filter(source => source.newsKinds?.includes('sector')).length,
  };
  const drivers = [], limitations = [];
  let discarded = 0;
  for (const row of raw.drivers.slice(0, MAX_ATTRIBUTION_DRIVERS)) {
    const title = clipped(row.title, 300).trim(), explanation = clipped(row.explanation, 5000).trim();
    const bindings = [...new Set(row.sourceIds)].map(id => lookup.get(id)).filter(eligible).slice(0, 5);
    if (!title || !explanation || !bindings.length) { discarded++; continue; }
    if (['company', 'valuation', 'capital', 'corporate_action'].includes(row.category)
      && !bindings.some(source => mentionsCompany(`${source.title}\n${source.content}`, snapshot))) { discarded++; continue; }
    if (row.category === 'corporate_action' && !bindings.some(source => mentionsCompany(`${source.title}\n${source.content}`, snapshot)
      && corporateLanguage(`${source.title}\n${source.content}`))) { discarded++; continue; }
    drivers.push({ title, category: row.category, direction: row.direction, explanation,
      evidence: bindings.map(source => ({ sourceId: source.id, citationVerified: true })) });
  }
  if (discarded) limitations.push(`已略去 ${discarded} 项没有可用新闻来源支持的原因，其余结论按有效材料保留。`);
  if (!newsCoverage.stock) limitations.push('本次未取得所选窗口内可用的个股新闻，只能结合板块新闻提供有限背景，不能据此确认公司自身驱动。');
  if (!newsCoverage.sector) limitations.push('本次未取得所选窗口内可用的板块新闻，板块因素分析存在缺口。');
  if (!sector.known) limitations.push('公司所属板块尚未核实，行业检索仅为一般背景；未把收益基准指数当作公司所属板块。');
  if (usable.some(source => source.readingScope === 'search_snippet')) limitations.push('部分新闻仅取得搜索摘要或片段，尚未阅读全文，相应归纳依据有限。');
  if ((sources ?? []).some(source => source.publishedAt === null)) limitations.push('没有可靠发布日期的材料仅用于背景理解，未作为本窗口内发生事件的依据。');
  if (snapshot.coverage.partial) limitations.push(`历史行情不足所选完整周期，价格实际比较区间为 ${snapshot.from} 至 ${snapshot.to}；新闻仍检索所选窗口 ${window.from} 至 ${window.to}。`);
  let corporateActionStatus = raw.corporateActionStatus;
  const actionEvidence = drivers.some(driver => driver.category === 'corporate_action');
  if (actionEvidence) corporateActionStatus = 'identified';
  else if (corporateActionStatus === 'identified' || snapshot.adjustment === 'none') corporateActionStatus = 'uncertain';
  if (snapshot.adjustment === 'none') {
    limitations.push(`港股采用${snapshot.currency === 'USD' ? '美元' : '港元'}未复权收盘价，与恒生指数比较的是价格涨跌，不含股息再投资；拆合股、除息及特别分派可能影响价格。`);
    if (snapshot.currency === 'USD') limitations.push('美元柜台原币股价与港元恒生指数直接比较，尚未进行汇率换算，不能把差异单独归因于公司经营。');
    if (!actionEvidence) limitations.push('本次未取得足以核实区间内公司行动影响的新闻，公司行动尚未排除，不应把异常价格变化直接解释成经营变化。');
  }
  limitations.push('新闻与股价变化的同期出现不等于已证明因果，以下是公开材料支持的可能解释，未估算各事件的涨跌贡献百分点。');
  if (!drivers.length) limitations.push('已取得新闻材料，但现有材料不足以确认可靠驱动，暂不提供确定性原因。');
  // Required disclosures precede optional model wording so clipping cannot
  // remove a missing-coverage or price-basis disclosure.
  const finalLimitations = uniqueTexts([...limitations, ...raw.limitations]);
  return {
    summary: drivers.length ? clipped(raw.summary, 4000).trim() : '已核实区间价格表现并取得新闻材料，但现有资料不足以可靠解释相对指数强弱，暂不作确定性归因。',
    drivers, limitations: finalLimitations,
    sources: usable.slice(0, 24).map(({ id, title, url, publishedAt, readingScope, newsKinds }) => ({ id, title, url, publishedAt, readingScope, newsKinds, citationVerified: true })),
    corporateActionStatus, evidenceMode: 'news_summary', newsWindow: window, newsCoverage, sector,
  };
}

export function attributionRetrievalEvidence(context, queries) {
  return { origin: 'deepseek-search', queries, rejectedFutureCount: context.rejectedFutureCount,
    rejectedBeforeWindowCount: context.rejectedBeforeWindowCount, rejectedWithoutTextCount: context.rejectedWithoutTextCount,
    searchFailureCount: context.searchFailureCount ?? 0,
    sources: context.sources.map(({ content, ...source }) => ({ ...source, contentLength: content.length,
      contentSha256: createHash('sha256').update(content, 'utf8').digest('hex') })) };
}
