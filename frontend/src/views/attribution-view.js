import { attributionPeriods, attributionPeriodNames } from '../features/attribution-data.js';
import { createAttributionWorkflow } from '../features/attribution-workflow.js';

const labels = { queued: '等待生成', running: '生成中', succeeded: '已保存', failed: '失败' };
const stageLabel = stage => ({ searching: '联网检索个股与板块新闻', analyzing: '整理个股与板块新闻并总结原因', saving: '保存报告', queued: '准备生成' }[stage] || '正在生成归因');
const reasonLabel = reason => ({ missing_prices: '个股日线尚未齐备', missing_benchmark: '指数日线尚未齐备', missing_index: '指数日线尚未齐备', no_common_date: '个股与指数缺少共同交易日', insufficient_history: '有效历史行情不足', insufficient_data: '有效历史行情不足', unknown_ticker: '当前股票尚未入库', missing_classification: '当前股票行业分类缺失', ambiguous_membership: '行业归属存在冲突', unpublished: '所属行业尚未发布指数' }[reason] || (reason && /[\u3400-\u9fff]/.test(reason) ? reason : '比较行情暂不可用'));
const node = (tag, className = '', text = '') => { const element = document.createElement(tag); element.className = className; element.textContent = text; return element; };
const number = value => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : '—';
const signed = value => `${value > 0 ? '+' : ''}${number(value)}`;
const timestamp = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '未知' : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date); };
export function attributionSourceURL(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function attributionPresentation(snapshot, period = '1m', unavailableReason = '') {
  const item = snapshot.data?.periods?.[period], report = item?.report ?? null;
  const historical = snapshot.data?.historical === true || snapshot.generationAllowed === false && snapshot.context?.historical === true;
  const hasReports = attributionPeriods.some(key => snapshot.data?.periods?.[key]?.report);
  let status = '等待读取', note = '';
  if (snapshot.phase === 'loading' || snapshot.phase === 'reloading') status = '读取已保存归因…';
  else if (snapshot.phase === 'starting') status = '正在提交生成任务';
  else if (snapshot.phase === 'running') status = stageLabel(snapshot.job?.stage);
  else if (item?.freshness === 'stale') { status = '归因待更新'; note = '行情数据已有变化，点击更新三个周期；下方保留原报告及其原始比较区间。'; }
  else if (item?.freshness === 'fresh') status = '已保存最新归因';
  else if (item?.freshness === 'unavailable') { status = '暂不能生成比较归因'; note = reasonLabel(item.reason); }
  else if (item?.freshness === 'missing') { status = '尚未生成'; note = '点击后依次联网生成 1个月、6个月、1年三份报告。'; }
  if (historical) { status = '历史日期仅查看'; note = '归因基于最新行情生成。当前历史日期不生成新报告，也不将最新报告作为历史行情解释。'; }
  if (snapshot.error) { status = snapshot.needsResume ? '任务状态待确认' : '归因读取或生成未完成'; note = snapshot.error; }
  const failedPeriods = attributionPeriods.filter(key => snapshot.job?.periods?.[key]?.status === 'failed');
  const emptyText = historical ? report ? `已保存报告截止 ${report.to}，请切回今日查看完整归因。` : '该股票尚无可查看的归因。切回今日后可手动生成。'
    : item?.freshness === 'unavailable' ? `${reasonLabel(item.reason)}，补齐数据后可生成。`
      : snapshot.busy ? '正在处理，生成成功后将自动显示。已有报告会继续保留。' : '尚无已保存的涨跌归因。点击生成后，结果将保存到数据库。';
  return { item, report, historical, status, note, failedPeriods, emptyText,
    buttonText: snapshot.phase === 'starting' ? '提交中…' : snapshot.phase === 'running' ? '归因生成中…' : hasReports ? '更新三个周期归因' : '生成三个周期归因',
    disabled: !snapshot.canStart, buttonTitle: snapshot.busy ? '当前任务正在处理，请等待完成。' : snapshot.needsResume ? '请先重新读取任务状态，确认后台结果。' : snapshot.canStart ? '手动联网生成并保存 1个月、6个月、1年三份归因' : historical ? '请切回今日生成归因' : unavailableReason,
    showReport: Boolean(report) && !historical };
}
function metric(label, value, tone = '') { const element = node('div', `attribution-metric ${tone}`); element.append(node('span', '', label), node('strong', '', value)); return element; }
function linkFor(source) {
  const url = attributionSourceURL(source.url), element = node(url ? 'a' : 'span', '', source.title || source.id);
  if (url) { element.href = url; element.target = '_blank'; element.rel = 'noopener noreferrer'; }
  return element;
}
function sourceDescription(source) {
  const kinds = (source.newsKinds || []).map(kind => ({ stock: '个股新闻', sector: '板块新闻' }[kind])).filter(Boolean);
  const reading = { partial_text: '已读取部分正文', search_snippet: '搜索摘要' }[source.readingScope];
  return [source.publishedAt || '发布日期未知，仅作背景', ...kinds, reading].filter(Boolean).join(' · ');
}
function newsContext(report) {
  const context = node('div', 'attribution-news-context');
  if (report.newsWindow) context.append(node('span', '', `新闻窗口 ${report.newsWindow.from} — ${report.newsWindow.to}`));
  if (report.sector) context.append(node('span', '', report.sector.known ? `研究板块：${report.sector.name}` : '研究板块：尚未识别'));
  if (report.newsCoverage) {
    context.append(node('span', '', `个股新闻 ${report.newsCoverage.stock} 条 · 板块新闻 ${report.newsCoverage.sector} 条`));
    const missing = [['stock', '个股'], ['sector', '板块']].filter(([key]) => report.newsCoverage[key] === 0).map(([, name]) => name);
    if (missing.length) context.append(node('span', 'attribution-news-gap', `本窗口未取得${missing.join('、')}新闻。`));
  }
  return context;
}
export function renderAttribution(snapshot, { period = '1m', unavailableReason = '' } = {}) {
  const presentation = attributionPresentation(snapshot, period, unavailableReason), { report, historical } = presentation;
  const panel = document.getElementById('stock-attribution');
  const generatedTime = document.getElementById('attribution-generated-time');
  generatedTime.hidden = !report;
  generatedTime.textContent = report ? `生成时间：${timestamp(report.generatedAt)}（北京时间）` : '';
  panel.setAttribute('aria-busy', String(snapshot.busy));
  document.getElementById('attribution-period').textContent = attributionPeriodNames[period];
  const status = document.getElementById('attribution-status'); status.textContent = presentation.status;
  status.dataset.state = snapshot.error ? 'error' : presentation.item?.freshness || 'missing';
  const generate = document.getElementById('generate-attribution'); generate.disabled = presentation.disabled; generate.textContent = presentation.buttonText; generate.title = presentation.buttonTitle;
  const reload = document.getElementById('reload-attribution'); reload.disabled = snapshot.busy; reload.textContent = snapshot.needsResume ? '重新读取任务状态' : '读取已保存归因';
  const retry = document.getElementById('retry-attribution'); retry.hidden = !presentation.failedPeriods.length || historical; retry.disabled = !snapshot.canStart;
  retry.textContent = `重试失败周期（${presentation.failedPeriods.map(key => attributionPeriodNames[key]).join('、')}）`;
  const note = document.getElementById('attribution-note'); note.textContent = presentation.note; note.hidden = !presentation.note;
  const progress = document.getElementById('attribution-progress'); progress.replaceChildren();
  const completed = !snapshot.busy && attributionPeriods.every(key => snapshot.job?.periods?.[key]?.status === 'succeeded');
  progress.hidden = !snapshot.job || historical || completed;
  if (snapshot.job && !historical) {
    for (const key of attributionPeriods) {
      const item = snapshot.job.periods[key];
      if (!item) continue;
      const row = node('div', 'attribution-progress-item'); row.dataset.state = item.status;
      row.append(node('strong', '', attributionPeriodNames[key]), node('span', '', labels[item.status]));
      if (item.status === 'failed' && item.error?.message) row.append(node('small', '', item.error.message));
      progress.append(row);
    }
  }
  const body = document.getElementById('attribution-body'); body.replaceChildren();
  if (!presentation.showReport) {
    body.append(node('p', 'attribution-empty', presentation.emptyText));
    if (report) body.append(node('p', 'attribution-meta', `已保存报告区间 ${report.from} — ${report.to} · 最后生成 ${timestamp(report.generatedAt)}（北京时间）`));
    return;
  }
  const benchmarkName = report.benchmark.industryName || '比较指数';
  const meta = node('div', 'attribution-report-meta');
  meta.append(node('strong', '', `报告区间 ${report.from} — ${report.to}`), node('span', '', `最后生成 ${timestamp(report.generatedAt)}（北京时间）`));
  const researchDetails = node('details', 'attribution-research-details');
  researchDetails.append(node('summary', '', '展开本时段详细归因与证据'));
  const researchBody = node('div', 'attribution-research-body');
  researchBody.append(meta);
  if (report.newsWindow || report.sector || report.newsCoverage) researchBody.append(newsContext(report));
  const metrics = node('div', 'attribution-metrics');
  const excess = report.excessPercentagePoints, direction = Math.abs(excess) < 1e-9 ? '与指数持平' : excess > 0 ? '跑赢指数' : '跑输指数';
  metrics.append(metric('个股价格涨跌幅', `${signed(report.stockReturn * 100)}%`), metric(`${benchmarkName}涨跌幅`, `${signed(report.indexReturn * 100)}%`), metric(direction, `${number(Math.abs(excess))} 个百分点`, excess > 0 ? 'positive' : excess < 0 ? 'negative' : ''));
  body.append(metrics, node('p', 'attribution-summary', report.summary));
  const coverage = report.coverage;
  if (coverage?.partial) body.append(node('p', 'attribution-warning', `历史覆盖不足，使用实际区间 ${report.from} — ${report.to}${Number.isInteger(coverage.pointCount) ? `，共 ${coverage.pointCount} 个共同交易日` : ''}。不代表完整${attributionPeriodNames[period]}表现。`));
  const sources = new Map(report.sources.map(source => [source.id, source]));
  const drivers = node('div', 'attribution-drivers');
  for (const driver of report.drivers) {
    const card = node('article', 'attribution-driver');
    const category = { company: '公司因素', industry: '行业因素', market: '市场因素', company_specific: '公司因素', market_common: '市场共同因素', valuation: '估值因素', capital: '资金因素', corporate_action: '公司行动', other: '其他因素' }[driver.category] || '可能原因';
    const direction = { positive: '正向影响', negative: '负向影响', mixed: '影响双向', neutral: '背景信息', uncertain: '影响待核验' }[driver.direction] || '';
    const heading = node('div', 'attribution-driver-heading'); heading.append(node('span', '', [category, direction].filter(Boolean).join(' · ')), node('h4', '', driver.title));
    card.append(heading, node('p', '', driver.explanation));
    for (const evidence of driver.evidence) {
      const source = sources.get(evidence.sourceId); if (!source) continue;
      const cite = node('div', 'attribution-evidence');
      if (report.evidenceMode !== 'news_summary' && evidence.quote) cite.append(node('blockquote', '', evidence.quote));
      const origin = node('p'); origin.append(linkFor(source), node('span', '', ` · ${sourceDescription(source)}`)); cite.append(origin); card.append(cite);
    }
    drivers.append(card);
  }
  researchBody.append(drivers);
  const details = node('details', 'attribution-details'); details.append(node('summary', '', '数据口径、来源与研究限制'));
  const detailsBody = node('div');
  detailsBody.append(node('p', '', `${report.adjustment === 'qfq' ? '前复权价格' : '未复权价格'} · ${report.currency} · ${benchmarkName}${report.benchmark.indexCode ? `（${report.benchmark.indexCode}）` : ''}；价格涨跌不包含现金分红再投资，超额涨跌为个股与指数涨跌幅之差。`));
  if (report.ticker.endsWith('.HK')) {
    detailsBody.append(node('p', '', '港股使用未复权价格，拆并股、除权及特殊分派可能造成价格跳变；需要结合公告核验。'));
    const actionStatus = { identified: '公司行动核验：已找到相关资料，见上方原因与来源。', not_identified: '公司行动核验：本次未识别相关事件，不代表区间内不存在公司行动。', uncertain: '公司行动核验：影响尚未确认，不能将异常价格变化直接解释为经营变化。' }[report.corporateActionStatus];
    if (actionStatus) detailsBody.append(node('p', '', actionStatus));
  }
  for (const limitation of report.limitations) detailsBody.append(node('p', '', limitation));
  for (const source of report.sources) { const row = node('p', 'attribution-source'); row.append(linkFor(source), node('span', '', ` · ${sourceDescription(source)}`)); detailsBody.append(row); }
  detailsBody.append(node('p', 'attribution-meta', `${report.provider || 'AI'} · ${report.model || '模型未提供'} · 数据截止 ${report.requestedAsOf}`));
  details.append(detailsBody); researchBody.append(details);
  researchDetails.append(researchBody); body.append(researchDetails);
}
export function initAttribution(options) {
  const workflow = createAttributionWorkflow({ ...options, onChange(snapshot) {
    renderAttribution(snapshot, { period: options.getPeriod(), unavailableReason: options.unavailableReason?.() || '' });
    options.onChange?.(snapshot);
  } });
  document.getElementById('generate-attribution').addEventListener('click', () => { void workflow.start(); });
  document.getElementById('retry-attribution').addEventListener('click', () => { void workflow.start({ retryFailed: true }); });
  document.getElementById('reload-attribution').addEventListener('click', () => { void workflow.reload(); });
  workflow.sync(); return workflow;
}
