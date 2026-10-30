import { PLATFORMS, validateShape } from './schema.mjs';
import { validDate } from './input.mjs';
import { ResearchError } from './errors.mjs';
import { imaEvidenceKey, IMA_LIBRARY } from './ima-evidence.mjs';

export const AUDIT_VERSION = 'source-audit-v4-ima';
const trustedRetrieval = evidence => ['deepseek-search', 'ima-deepseek'].includes(evidence?.origin);
const sourceKey = value => imaEvidenceKey(value) || canonicalUrl(value);

export function authorGroup(author) {
  // Prompt requires institution first when known. Remove analyst suffixes.
  const normalized = author.trim().toLowerCase().replace(/\s+/g, '');
  for (const [name, pattern] of [['goldman', /高盛|goldmansachs/], ['bofa', /美银|bankofamerica|bofasecurities/], ['morganstanley', /摩根士丹利|morganstanley/], ['jpmorgan', /摩根大通|jpmorgan/], ['ubs', /瑞银|^ubs/], ['nomura', /野村|nomura/]]) if (pattern.test(normalized)) return name;
  const organization = normalized.match(/^(.+?(?:证券|银行|资本|基金|咨询|研究院|研究所))/);
  return organization ? organization[1] : normalized.split(/[\/／|｜·:：]/)[0];
}

export function canonicalUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|gclid$|fbclid$)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}
export function searchEvidence(response, retrievalEvidence) {
  const seen = new Map(), opened = new Set();
  const add = value => {
    const url = typeof value === 'string' ? value : value?.url;
    const key = sourceKey(url); if (key) seen.set(key, url);
  };
  for (const item of trustedRetrieval(retrievalEvidence) ? [] : response.output ?? []) {
    if (item.type === 'web_search_call' && item.status === 'completed') {
      const action = item.action ?? {};
      for (const source of action.sources ?? []) add(source);
      if (action.type === 'open_page' || action.type === 'find_in_page') {
        for (const url of [action.url, ...(action.urls ?? [])].filter(Boolean)) { add(url); opened.add(canonicalUrl(url)); }
      }
    }
    if (item.type === 'message') for (const content of item.content ?? []) for (const annotation of content.annotations ?? []) if (annotation.type === 'url_citation') add(annotation);
  }
  // Supplied separately by the backend's Search API client, never read from
  // generated report JSON or model response properties.
  if (trustedRetrieval(retrievalEvidence) && Array.isArray(retrievalEvidence.sources)) {
    for (const source of retrievalEvidence.sources) {
      const key = sourceKey(source?.url);
      if (!key) continue;
      if (imaEvidenceKey(key) && !(retrievalEvidence.origin === 'ima-deepseek' && source.sourceKind === 'ima' && source.content?.length >= 200)) continue;
      add(source);
      if (source.readingScope === 'partial_text') opened.add(key);
    }
  }
  return { seen, opened };
}

export function auditReport(raw, response, input, retrievalEvidence) {
  try { validateShape(raw); } catch { throw new ResearchError('INVALID_RESEARCH_SHAPE', '模型返回的研究字段不完整，请重试', 502); }
  if (raw.company.ticker.trim().toUpperCase() !== input.ticker) throw new ResearchError('TICKER_MISMATCH', '模型识别的证券代码与请求不一致，本次结果未保存', 502);
  if (raw.debates.length > 3 || raw.sources.length > 40 || raw.coverage.length > 20) throw new ResearchError('RESEARCH_LIMIT_EXCEEDED', '模型返回的研究项目数量超出约定', 502);
  const report = structuredClone(raw), evidence = searchEvidence(response, retrievalEvidence), warnings = [...report.limitations];
  const retrievedSources = new Map(trustedRetrieval(retrievalEvidence) && Array.isArray(retrievalEvidence.sources)
    ? retrievalEvidence.sources.map(source => [sourceKey(source?.url), source]) : []);
  const sourceIds = new Set();
  report.sources = report.sources.filter(source => {
    if (!source.id || sourceIds.has(source.id)) throw new ResearchError('INVALID_SOURCE_ID', '研究来源编号重复或缺失', 502);
    sourceIds.add(source.id);
    const key = sourceKey(source.url);
    if (!key || !evidence.seen.has(key)) { warnings.push(`已移除未出现在本次搜索记录中的来源：${source.title}`); return false; }
    if (source.publishedAt !== null && (!validDate(source.publishedAt) || source.publishedAt > input.asOf)) { warnings.push(`已移除日期无效或晚于截止日的来源：${source.title}`); return false; }
    source.url = evidence.seen.get(key);
    const retrieved = retrievedSources.get(key);
    if (imaEvidenceKey(key)) {
      if (retrieved?.sourceKind !== 'ima' || source.id !== retrieved.id) return false;
      Object.assign(source, { sourceKind: 'ima', title: retrieved.title, author: retrieved.author, platform: 'sell_side',
        libraryName: IMA_LIBRARY.name, mediaId: retrieved.mediaId, retrievedAt: retrieved.retrievedAt,
        dateBasis: retrieved.dateBasis, excerpts: retrieved.excerpts, contentSha256: retrieved.contentSha256,
        qualityLabel: retrieved.excerpts?.some(p => p.method === 'ocr') ? '含文字识别内容，数字需核对' : '' });
    }
    // A search-provider timestamp is used only when explicitly a publication
    // date. A generated date cannot fill a missing publication date.
    if (retrieved) {
      source.publishedAt = validDate(retrieved.publishedAt) && retrieved.publishedAt <= input.asOf ? retrieved.publishedAt : null;
      if (retrieved.publishedAt && validDate(retrieved.publishedAt) && retrieved.publishedAt > input.asOf) return false;
    }
    // An opened page is not proof that the entire document was read.
    source.readingScope = evidence.opened.has(key) && source.readingScope !== 'search_snippet' ? 'partial_text' : 'search_snippet';
    const host = new URL(source.url).hostname;
    if (/(^|\.)xueqiu\.com$/.test(host)) source.platform = 'xueqiu';
    else if (/(^|\.)tradingview\.com$/.test(host)) source.platform = 'tradingview';
    else if (/(^|\.)(x|twitter)\.com$/.test(host)) source.platform = 'x';
    else if (/(^|\.)(cninfo\.com\.cn|sse\.com\.cn|szse\.cn|hkexnews\.hk|hkex\.com\.hk)$/.test(host)) source.platform = 'company';
    if (source.author.trim() === report.company.name.trim()) source.platform = 'company';
    source.qualityLabel = source.platform === 'xueqiu' ? '低质量引用' : source.qualityLabel;
    source.citationVerified = true; // URL observed, never a truth/reliability score.
    return true;
  });
  const sources = new Map(report.sources.map(source => [source.id, source]));
  const eligible = source => source.publishedAt && source.publishedAt >= input.windowStart && source.platform !== 'company' && source.author.trim() && !/未知|未提供|未披露|未署名|不详|不明|匿名|unknown|not available/i.test(source.author);
  const debateIds = new Set();
  for (const debate of report.debates) {
    if (!debate.id || debateIds.has(debate.id)) throw new ResearchError('INVALID_DEBATE_ID', '分歧编号重复或缺失', 502);
    debateIds.add(debate.id);
    for (const side of [debate.bull, debate.bear]) {
      const originalStatus = side.evidenceStatus;
      const requested = side.sourceIds.length;
      side.sourceIds = [...new Set(side.sourceIds)].filter(id => sources.has(id));
      if (requested !== side.sourceIds.length) {
        warnings.push(`“${debate.title}”有引用无法对应，已移除并降低证据等级。`);
        if (side.evidenceStatus === 'source_view') side.evidenceStatus = side.sourceIds.length ? 'model_inference' : 'insufficient';
      }
      if (side.evidenceStatus === 'source_view' && (!side.sourceIds.length || !side.sourceIds.some(id => eligible(sources.get(id))))) side.evidenceStatus = side.sourceIds.length ? 'model_inference' : 'insufficient';
      if (!side.sourceIds.length) side.evidenceStatus = 'insufficient';
      if (side.evidenceStatus !== originalStatus) {
        side.summary = side.evidenceStatus === 'insufficient' ? '未取得可追溯且符合截止日期的这一方观点，需补充证据。' : `研究假设（尚未确认有独立作者明确提出；仅供核验）：${side.summary}`;
      }
      if (!side.summary.trim()) { side.summary = '尚未取得这一方的可靠观点，需补充来源。'; side.evidenceStatus = 'insufficient'; }
    }
    const bullAuthors = debate.bull.sourceIds.map(id => sources.get(id)).filter(eligible).map(source => authorGroup(source.author));
    const bearAuthors = debate.bear.sourceIds.map(id => sources.get(id)).filter(eligible).map(source => authorGroup(source.author));
    const independent = bullAuthors.some(bull => bearAuthors.some(bear => bull !== bear));
    const distinctSources = debate.bull.sourceIds.some(bull => debate.bear.sourceIds.some(bear => sourceKey(sources.get(bull).url) !== sourceKey(sources.get(bear).url)));
    if (debate.bull.evidenceStatus === 'insufficient' || debate.bear.evidenceStatus === 'insufficient') debate.status = 'insufficient_evidence';
    else if (debate.status === 'documented_disagreement' && !(debate.bull.evidenceStatus === 'source_view' && debate.bear.evidenceStatus === 'source_view' && independent && distinctSources)) debate.status = 'research_hypothesis';
  }
  if (report.company.identityStatus !== 'verified' || !report.sources.length) {
    report.company.identityStatus = 'uncertain'; report.debates = [];
    warnings.push('未能以可追溯公开资料确认证券身份，未展示正反方观点。');
  }
  report.company.ticker = input.ticker;
  report.coverage = PLATFORMS.map(platform => {
    const entries = report.sources.filter(source => source.platform === platform);
    const item = report.coverage.find(item => item.platform === platform) ?? { platform, status: 'not_searched', note: '未取得该平台的检索情况。' };
    if (entries.length) return { ...item, status: entries.every(source => source.readingScope === 'search_snippet') ? 'limited' : 'found', note: item.note || '检索到可追溯来源，读取范围见具体引用。' };
    if (item.status === 'found') return { ...item, status: 'limited', note: '模型声称有资料，但未保留与搜索记录对应的有效来源。' };
    return item;
  });
  if (retrievalEvidence?.origin === 'ima-deepseek') {
    const count = [...retrievedSources.values()].filter(source => source.sourceKind === 'ima').length;
    report.coverage.push({ platform: 'ima', status: count ? 'limited' : 'not_found', note: count
      ? `${IMA_LIBRARY.name}：读取 ${count} 份研报的部分正文，检索不代表全库覆盖。` : '本次未取得 ima 正文，具体原因见生成状态。' });
  }
  if (report.sources.some(source => source.publishedAt === null)) warnings.push('部分来源未取得可靠发布日期，仅作背景，不能确认其在研究截止日前已公开。');
  warnings.push('当前公开网页搜索不能严格重建历史时点信息；发布日期、作者与观点内容仍需人工核验。');
  warnings.push('引用校验仅确认 URL 出现在本次搜索元数据中，不证明观点真实、资料完整或已阅读全文。');
  if (retrievalEvidence?.origin === 'deepseek-search') warnings.push('本次由后端执行固定次数的 DeepSeek Search 检索，再由模型整理；未执行所有平台的完整覆盖检索。');
  report.limitations = [...new Set(warnings)];
  return report;
}
