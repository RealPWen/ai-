import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptAttributions, adaptAttributionJob, assertAttributionsContext, attributionPeriods } from '../frontend/src/features/attribution-data.js';
import { createAttributionWorkflow } from '../frontend/src/features/attribution-workflow.js';
import { attributionPresentation, attributionSourceURL, renderAttribution } from '../frontend/src/views/attribution-view.js';
import { createResearchService } from '../frontend/src/services/research-service.js';
import { endpoints } from '../frontend/src/api/endpoints.js';
import { adapters } from '../frontend/src/services/adapters.js';

const context = { ticker: '00700.HK', asOf: '2026-10-20' };
const report = (period = '1m', changes = {}) => ({ ticker: context.ticker, period, companyName: '腾讯控股', requestedAsOf: context.asOf,
  from: '2026-09-21', to: '2026-10-19', stockReturn: 0.1, indexReturn: 0.04, excessPercentagePoints: 6,
  benchmark: { system: 'HSI', indexCode: 'HSI', industryName: '恒生指数', level: null }, adjustment: 'none', currency: 'HKD',
  coverage: { requestedFrom: '2026-09-20', actualFrom: '2026-09-21', actualTo: '2026-10-19', pointCount: 18, partial: false },
  generatedAt: '2026-10-20T01:30:00.000Z', provider: 'deepseek', model: 'deepseek-test', summary: '公司业绩改善，可能推动区间相对表现。',
  drivers: [{ title: '业绩增长', category: 'company', direction: 'positive', explanation: '公告披露增长，但无法量化对股价的具体贡献。', evidence: [{ sourceId: 's1', quote: '公司收入增长。' }] }],
  limitations: ['仅解释可能原因，不代表精确因果贡献。'], sources: [{ id: 's1', title: '业绩公告', url: 'https://example.com/report', publishedAt: '2026-10-10' }], ...changes });
const data = ({ reports = false, job = null, historical = false, asOf = context.asOf, freshness = reports ? 'fresh' : 'missing' } = {}) => ({
  ticker: context.ticker, requestedAsOf: asOf, historical, job,
  periods: Object.fromEntries(attributionPeriods.map(period => [period, { report: reports ? report(period) : null, freshness, reason: null, currentMetrics: report(period, { to: asOf < '2026-10-19' ? asOf : '2026-10-19' }) }])),
});
const job = (status = 'running', changes = {}) => ({ jobId: 'job-1', ticker: context.ticker, requestedAsOf: context.asOf, status, stage: 'searching',
  periods: Object.fromEntries(attributionPeriods.map(period => [period, { status: status === 'running' ? 'queued' : 'succeeded' }])), ...changes });
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  let active = { ...context }, reads = 0, posts = 0, pollReads = 0, callback, enabled = true, generateAllowed = true;
  let saved = data(options), currentJob = options.job;
  const calls = [];
  const workflow = createAttributionWorkflow({
    getContext: () => active, canRead: () => enabled, canGenerate: () => generateAllowed,
    loadReports: async (params, config) => { reads++; calls.push({ type: 'read', params, config }); return { data: saved }; },
    startResearch: async params => { posts++; calls.push({ type: 'post', params }); currentJob = job(); return currentJob; },
    loadJob: async params => { pollReads++; calls.push({ type: 'poll', params }); return currentJob; },
    schedule: next => { callback = next; return 1; }, unschedule: () => { callback = null; },
  });
  return { workflow, calls, get reads() { return reads; }, get posts() { return posts; }, get pollReads() { return pollReads; },
    set active(value) { active = value; }, set saved(value) { saved = value; }, set job(value) { currentJob = value; }, set enabled(value) { enabled = value; }, set generateAllowed(value) { generateAllowed = value; },
    tick: async () => { const next = callback; callback = null; next?.(); await flush(); },
  };
}

test('归因数据适配校验股票、日期、周期、涨跌计算与引用，复制来源和指标', () => {
  const source = data({ reports: true }), result = adaptAttributions({ data: source });
  assert.deepEqual(result, source); assert.notEqual(result.periods['1m'].report.sources, source.periods['1m'].report.sources);
  assert.equal(assertAttributionsContext(result, context), result);
  assert.throws(() => assertAttributionsContext(result, { ...context, asOf: '2026-10-19' }));
  const futureMetrics = structuredClone(result); futureMetrics.periods['1m'].currentMetrics.to = '2026-10-21';
  assert.throws(() => assertAttributionsContext(futureMetrics, context));
  for (const mutate of [
    value => { value.periods['1m'].report.ticker = '02359.HK'; },
    value => { value.periods['1m'].report.period = '1y'; },
    value => { value.periods['1m'].report.excessPercentagePoints = 60; },
    value => { value.periods['1m'].report.from = value.periods['1m'].report.to; },
    value => { value.periods['1m'].report.benchmark.system = 'SW2021'; },
    value => { value.periods['1m'].report.sources.push(value.periods['1m'].report.sources[0]); },
    value => { value.periods['1m'].report.drivers[0].evidence[0].sourceId = 'invented'; },
    value => { value.periods['1m'].report.to = '2026-10-21'; },
    value => { value.periods['1m'].report.generatedAt = 'bad'; },
  ]) { const changed = structuredClone(source); mutate(changed); assert.throws(() => adaptAttributions(changed)); }
  assert.throws(() => adaptAttributionJob(job('running', { ticker: '02359.HK' }), context));
});

test('HTTP读取只发送ticker/asOf，点击POST一次发送三周期，轮询只GET任务', async () => {
  const calls = [], signal = new AbortController().signal;
  const service = createResearchService({ config: { enabled: true }, routes: endpoints, mappers: adapters, client: {
    async get(path, options) { calls.push({ method: 'GET', path, ...options }); return { data: path.includes('/jobs/') ? job() : data() }; },
    async post(path, options) { calls.push({ method: 'POST', path, ...options }); return { data: job() }; },
  } });
  await service.load('attributions', context, { signal });
  assert.deepEqual(calls[0], { method: 'GET', path: '/api/market/attribution', query: context, signal });
  await service.startAttribution({ ...context, periods: attributionPeriods, ignored: 'x' });
  assert.deepEqual(calls[1].body, { ticker: context.ticker, periods: attributionPeriods });
  await service.loadAttributionJob({ jobId: 'safe/id' }, { signal });
  assert.equal(calls[2].path, '/api/market/attribution/jobs/safe%2Fid'); assert.equal(calls[2].signal, signal);
});

test('首次打开、切换周期和读取已保存报告绝不提交生成，授权切换也不自动生成', async () => {
  const f = fixture({ reports: true }); f.workflow.sync(); await flush();
  assert.equal(f.reads, 1); assert.equal(f.posts, 0); assert.equal(f.workflow.snapshot.data.periods['1m'].report.summary, report().summary);
  f.workflow.sync(); f.generateAllowed = false; f.workflow.sync(); f.generateAllowed = true; f.workflow.sync(); await flush();
  assert.equal(f.reads, 1); assert.equal(f.posts, 0);
  await f.workflow.reload(); assert.equal(f.reads, 2); assert.equal(f.posts, 0); f.workflow.dispose();
});

test('手动生成一次三个周期，忙时重复点击无效，任务完成重新GET并保留旧结果直到成功', async () => {
  const f = fixture({ reports: true }); f.workflow.sync(); await flush();
  const old = f.workflow.snapshot.data.periods['1m'].report;
  assert.equal(await f.workflow.start(), true); assert.equal(f.posts, 1); assert.equal(f.workflow.snapshot.phase, 'running');
  assert.deepEqual(f.calls.find(call => call.type === 'post').params.periods, attributionPeriods);
  assert.equal(f.workflow.snapshot.data.periods['1m'].report, old);
  assert.equal(await f.workflow.start(), false); assert.equal(f.posts, 1);
  f.job = job('succeeded'); f.saved = data({ reports: true, job: job('succeeded') }); await f.tick();
  assert.equal(f.pollReads, 1); assert.equal(f.reads, 2); assert.equal(f.workflow.snapshot.phase, 'idle');
  assert.equal(f.workflow.snapshot.job.status, 'succeeded'); f.workflow.dispose();
});

test('部分周期失败保留旧报告并仅重试失败周期', async () => {
  const partial = job('partial', { periods: { '1m': { status: 'succeeded' }, '6m': { status: 'failed', error: { code: 'SEARCH_FAILED', message: '检索失败' } }, '1y': { status: 'succeeded' } } });
  const f = fixture({ reports: true, job: partial }); f.workflow.sync(); await flush();
  assert.equal(f.workflow.snapshot.data.periods['6m'].report.summary, report().summary);
  const presentation = attributionPresentation(f.workflow.snapshot, '6m'); assert.deepEqual(presentation.failedPeriods, ['6m']);
  await f.workflow.start({ retryFailed: true }); assert.deepEqual(f.calls.find(call => call.type === 'post').params.periods, ['6m']); f.workflow.dispose();
});

test('刷新恢复后台active任务只查询进度；历史日期不轮询、不生成，也不展示最新报告正文', async () => {
  const running = fixture({ reports: true, job: job() }); running.workflow.sync(); await flush();
  assert.equal(running.workflow.snapshot.phase, 'running'); assert.equal(running.posts, 0); await running.tick(); assert.equal(running.pollReads, 1); running.workflow.dispose();
  const f = fixture({ reports: true, historical: true, asOf: '2026-10-18', job: job() }); f.active = { ...context, asOf: '2026-10-18' }; f.workflow.sync(); await flush();
  assert.equal(f.workflow.snapshot.canStart, false); assert.equal(f.workflow.snapshot.job, null); assert.equal(await f.workflow.start(), false); await f.tick();
  assert.equal(f.posts, 0); assert.equal(f.pollReads, 0);
  const presentation = attributionPresentation(f.workflow.snapshot); assert.equal(presentation.showReport, false); assert.match(presentation.emptyText, /截止 2026-10-19/); f.workflow.dispose();
});

test('切股或切日期后迟到读取不能串报告，恢复有效日期可以再次读取', async () => {
  let contextNow = { ...context }, resolveOld, currentRead;
  const workflow = createAttributionWorkflow({ getContext: () => contextNow, canRead: () => true, canGenerate: () => true,
    loadReports: params => params.asOf === context.asOf ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ data: data({ asOf: params.asOf, historical: true }) }),
    startResearch: async () => { throw new Error('must not generate'); }, loadJob: async () => null,
    onChange: state => { currentRead = state; },
  });
  workflow.sync(); await flush(); contextNow = { ...context, asOf: '2026-10-18' }; workflow.sync(); await flush();
  assert.equal(currentRead.data.requestedAsOf, '2026-10-18'); resolveOld({ data: data({ reports: true }) }); await flush();
  assert.equal(workflow.snapshot.data.requestedAsOf, '2026-10-18'); workflow.dispose();
  const f = fixture(); f.workflow.sync(); await flush(); f.enabled = false; f.workflow.sync(); f.enabled = true; await f.workflow.reload(); assert.equal(f.reads, 2); f.workflow.dispose();
});

test('提交网络不确定或轮询失败只允许重新读取，不立即重复生成', async () => {
  let posts = 0, failPoll = false;
  const workflow = createAttributionWorkflow({ getContext: () => context, canRead: () => true, canGenerate: () => true,
    loadReports: async () => ({ data: data() }), startResearch: async () => { posts++; throw Object.assign(new Error('网络中断'), { code: 'NETWORK_ERROR' }); },
    loadJob: async () => { if (failPoll) throw new Error('连接失败'); return job(); },
  });
  workflow.sync(); await flush(); await workflow.start(); assert.equal(posts, 1); assert.equal(workflow.snapshot.needsResume, true);
  await workflow.start(); assert.equal(posts, 1); await workflow.reload(); assert.equal(workflow.snapshot.needsResume, false); assert.equal(workflow.snapshot.data.periods['1m'].report, null); workflow.dispose();
});

test('归因链接只接受无凭据HTTP(S)，拒绝脚本与本地协议', () => {
  assert.equal(attributionSourceURL('https://example.com/report'), 'https://example.com/report');
  for (const url of ['javascript:alert(1)', 'file:///tmp/x', 'data:text/html,x', 'https://user:password@example.com', 'invalid']) assert.equal(attributionSourceURL(url), null);
});

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = new Map(); this.className = ''; this._text = ''; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = [...children]; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
function dom(t) {
  const ids = ['stock-attribution', 'attribution-generated-time', 'attribution-period', 'attribution-status', 'generate-attribution', 'reload-attribution', 'retry-attribution', 'attribution-note', 'attribution-progress', 'attribution-body'];
  const elements = new Map(ids.map(id => [id, new Element()])), previous = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag), getElementById: id => elements.get(id) };
  t.after(() => { globalThis.document = previous; }); return elements;
}
const snapshot = overrides => ({ context, data: adaptAttributions(data({ reports: true })), phase: 'idle', job: null, error: '', busy: false, canStart: true, generationAllowed: true, ...overrides });

test('报告DOM显示实际区间、北京时间、超额表现、覆盖不足与可核验原文，动态文字安全', t => {
  const elements = dom(t), source = data({ reports: true });
  source.periods['1m'].report.drivers[0].title = '<img src=x onerror=alert(1)>';
  source.periods['1m'].report.sources[0].url = 'javascript:alert(1)';
  source.periods['1m'].report.coverage.partial = true;
  renderAttribution(snapshot({ data: adaptAttributions(source) }));
  const body = elements.get('attribution-body'), all = descendants(body);
  assert.match(body.textContent, /报告区间 2026-09-21 — 2026-10-19/);
  assert.match(body.textContent, /最后生成 2026-10-20 09:30:00（北京时间）/);
  assert.match(body.textContent, /个股价格涨跌幅\+10.00%恒生指数涨跌幅\+4.00%跑赢指数6.00 个百分点/);
  assert.match(body.textContent, /不代表完整1个月表现/);
  assert.match(body.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(all.some(item => item.tagName === 'IMG' || item.tagName === 'SCRIPT'), false);
  assert.equal(all.some(item => item.tagName === 'A'), false);
  assert.match(body.textContent, /业绩公告.*2026-10-10/);
  assert.equal(elements.get('generate-attribution').textContent, '更新三个周期归因');
  assert.equal(all.filter(item => item.tagName === 'BLOCKQUOTE').length, 1);
  assert.match(all.find(item => item.tagName === 'BLOCKQUOTE').textContent, /公司收入增长。/);
});

function newsReport(changes = {}) {
  return report('1m', { evidenceMode: 'news_summary', newsWindow: { from: '2026-09-20', to: '2026-10-19' },
    sector: { name: '互联网服务', source: 'company_profile', known: true }, newsCoverage: { stock: 1, sector: 1 },
    drivers: [{ title: '业绩和板块动态', category: 'company', direction: 'positive', explanation: '综合报道，公司收入增长、行业需求改善，可能有助相对表现。',
      evidence: [{ sourceId: 's1', citationVerified: true }, { sourceId: 's2', citationVerified: true }] }],
    sources: [{ id: 's1', title: '腾讯季度业绩', url: 'https://example.com/tencent', publishedAt: '2026-10-10', newsKinds: ['stock'], readingScope: 'partial_text' },
      { id: 's2', title: '互联网板块需求动态', url: 'https://example.com/sector', publishedAt: '2026-10-09', newsKinds: ['sector'], readingScope: 'search_snippet' }], ...changes });
}
function withNewsReport(changes) {
  const source = data({ reports: true }); source.periods['1m'].report = newsReport(changes); return source;
}

test('新闻总结模式允许改写说明及无逐字引文，保留来源并复制新闻窗口、板块与分类', () => {
  const source = withNewsReport(), adapted = adaptAttributions(source).periods['1m'].report;
  assert.equal(adapted.evidenceMode, 'news_summary');
  assert.match(adapted.drivers[0].explanation, /综合报道/);
  assert.deepEqual(adapted.drivers[0].evidence, [{ sourceId: 's1', citationVerified: true }, { sourceId: 's2', citationVerified: true }]);
  assert.notEqual(adapted.newsWindow, source.periods['1m'].report.newsWindow);
  assert.notEqual(adapted.sector, source.periods['1m'].report.sector);
  assert.notEqual(adapted.newsCoverage, source.periods['1m'].report.newsCoverage);
  assert.notEqual(adapted.sources[0].newsKinds, source.periods['1m'].report.sources[0].newsKinds);
  for (const mutate of [
    value => { value.drivers[0].evidence[0].sourceId = 'unknown'; },
    value => { value.drivers[0].evidence[0].citationVerified = false; },
    value => { value.newsWindow.to = '2026-10-21'; },
    value => { value.newsWindow.from = '2026-11-01'; },
    value => { value.sector.name = ''; },
    value => { value.newsCoverage.stock = -1; },
    value => { value.sources[0].newsKinds = ['invented']; },
  ]) { const changed = withNewsReport(); mutate(changed.periods['1m'].report); assert.throws(() => adaptAttributions(changed)); }
  const old = data({ reports: true }); delete old.periods['1m'].report.drivers[0].evidence[0].quote;
  assert.throws(() => adaptAttributions(old));
});

test('新闻总结DOM显示独立板块、窗口、新闻分类和阅读范围，解释不作为逐字原文', t => {
  const elements = dom(t), source = withNewsReport();
  source.periods['1m'].report.drivers[0].evidence[0].quote = 'AI 改写文字不可当作逐字原文';
  renderAttribution(snapshot({ data: adaptAttributions(source) }));
  const body = elements.get('attribution-body'), all = descendants(body);
  assert.match(body.textContent, /新闻窗口 2026-09-20 — 2026-10-19/);
  assert.match(body.textContent, /研究板块：互联网服务/);
  assert.match(body.textContent, /个股新闻 1 条 · 板块新闻 1 条/);
  assert.match(body.textContent, /恒生指数涨跌幅/);
  assert.doesNotMatch(body.textContent, /研究板块：恒生指数/);
  assert.match(body.textContent, /腾讯季度业绩 · 2026-10-10 · 个股新闻 · 已读取部分正文/);
  assert.match(body.textContent, /互联网板块需求动态 · 2026-10-09 · 板块新闻 · 搜索摘要/);
  assert.match(body.textContent, /综合报道，公司收入增长、行业需求改善/);
  assert.equal(all.some(item => item.tagName === 'BLOCKQUOTE'), false);
  assert.doesNotMatch(body.textContent, /AI 改写文字不可当作逐字原文/);
});

test('单类新闻缺失和未识别板块如实标注，缺少新metadata的旧报告照常读取', t => {
  const elements = dom(t), source = withNewsReport({ sector: { name: null, source: 'unavailable', known: false }, newsCoverage: { stock: 1, sector: 0 } });
  renderAttribution(snapshot({ data: adaptAttributions(source) }));
  assert.match(elements.get('attribution-body').textContent, /研究板块：尚未识别/);
  assert.match(elements.get('attribution-body').textContent, /本窗口未取得板块新闻/);
  const stockMissing = withNewsReport({ newsCoverage: { stock: 0, sector: 1 } });
  renderAttribution(snapshot({ data: adaptAttributions(stockMissing) }));
  assert.match(elements.get('attribution-body').textContent, /本窗口未取得个股新闻/);
  renderAttribution(snapshot());
  assert.doesNotMatch(elements.get('attribution-body').textContent, /新闻窗口|研究板块：|本窗口未取得/);
  assert.equal(descendants(elements.get('attribution-body')).filter(item => item.tagName === 'BLOCKQUOTE').length, 1);
});

test('正在生成的阶段明确先检索个股与板块新闻再总结', () => {
  assert.equal(attributionPresentation(snapshot({ phase: 'running', job: job('running', { stage: 'searching' }) })).status, '联网检索个股与板块新闻');
  assert.equal(attributionPresentation(snapshot({ phase: 'running', job: job('running', { stage: 'analyzing' }) })).status, '整理个股与板块新闻并总结原因');
});

test('历史与缺失空态清除旧正文，周期切换只显示对应保存报告，进度各周期独立', t => {
  const elements = dom(t), source = data({ reports: true });
  source.periods['6m'].report.summary = '六个月的独立解释';
  renderAttribution(snapshot({ data: adaptAttributions(source) }), { period: '6m' });
  assert.match(elements.get('attribution-body').textContent, /六个月的独立解释/);
  assert.equal(elements.get('attribution-period').textContent, '6个月');
  renderAttribution(snapshot({ data: adaptAttributions(data({ reports: true, historical: true })), canStart: false }));
  assert.doesNotMatch(elements.get('attribution-body').textContent, /公司业绩改善/);
  assert.match(elements.get('attribution-body').textContent, /切回今日/);
  const partial = job('partial', { periods: { '1m': { status: 'succeeded' }, '6m': { status: 'failed', error: { message: '缺少证据' } }, '1y': { status: 'running' } } });
  renderAttribution(snapshot({ data: adaptAttributions(data()), job: partial }));
  assert.doesNotMatch(elements.get('attribution-body').textContent, /六个月的独立解释/);
  assert.match(elements.get('attribution-progress').textContent, /1个月已保存6个月失败缺少证据1年生成中/);
  assert.equal(elements.get('retry-attribution').hidden, false);
  assert.match(elements.get('retry-attribution').textContent, /6个月/);
});

test('A股前复权申万基准可适配且不能混入恒指，行情变化显示待更新并保留原区间', () => {
  const source = data({ reports: true, freshness: 'stale' }); source.ticker = '002920.SZ';
  for (const period of attributionPeriods) for (const item of [source.periods[period].report, source.periods[period].currentMetrics]) {
    item.ticker = source.ticker; item.adjustment = 'qfq'; item.currency = 'CNY'; item.benchmark = { system: 'SW2021', level: 3, indexCode: '850881.SI', industryName: '汽车电子' };
  }
  const mapped = adaptAttributions(source);
  assert.equal(mapped.periods['1m'].report.benchmark.system, 'SW2021');
  const presentation = attributionPresentation(snapshot({ context: { ...context, ticker: source.ticker }, data: mapped }));
  assert.equal(presentation.status, '归因待更新'); assert.equal(presentation.showReport, true); assert.equal(presentation.report.from, '2026-09-21');
  source.periods['1m'].currentMetrics.benchmark.system = 'HSI'; assert.throws(() => adaptAttributions(source));
});

test('轮询失败保留旧报告，停止轮询且只读重试恢复后台任务', async () => {
  let callback, pollCount = 0, posts = 0;
  const workflow = createAttributionWorkflow({ getContext: () => context, canRead: () => true, canGenerate: () => true,
    loadReports: async () => ({ data: data({ reports: true, job: job() }) }), startResearch: async () => { posts++; return job(); },
    loadJob: async () => { pollCount++; throw new Error('网络失败'); }, schedule: next => { callback = next; return 1; }, unschedule: () => { callback = null; },
  });
  workflow.sync(); await flush(); callback(); await flush();
  assert.equal(workflow.snapshot.needsResume, true); assert.equal(workflow.snapshot.phase, 'failed');
  assert.equal(workflow.snapshot.data.periods['1m'].report.summary, report().summary);
  assert.equal(await workflow.start(), false); assert.equal(posts, 0); assert.equal(pollCount, 1);
  await workflow.reload(); assert.equal(workflow.snapshot.phase, 'running'); assert.equal(workflow.snapshot.needsResume, false); workflow.dispose();
});

test('任务提交期间切股，旧任务被记录但不能覆盖新股票页面，返回原股票通过GET恢复', async () => {
  let active = { ...context }, resolvePost;
  const workflow = createAttributionWorkflow({ getContext: () => active, canRead: () => true, canGenerate: () => true,
    loadReports: async params => ({ data: { ...data(), ticker: params.ticker } }),
    startResearch: () => new Promise(resolve => { resolvePost = resolve; }), loadJob: async () => job(),
  });
  workflow.sync(); await flush(); const pending = workflow.start();
  active = { ...context, ticker: '02359.HK' }; workflow.sync(); await flush(); resolvePost(job()); await pending;
  assert.equal(workflow.snapshot.data.ticker, '02359.HK'); assert.equal(workflow.snapshot.job, null); workflow.dispose();
});

test('相同股票和日期的后续行情刷新重新GET归因状态，首次行情和忙碌期间避免重复读取', async () => {
  const f = fixture({ reports: true }); f.workflow.sync(); await flush();
  assert.equal(f.workflow.snapshot.data.periods['1m'].freshness, 'fresh');
  assert.equal(await f.workflow.onMarketData(context), false); assert.equal(f.reads, 1);
  f.saved = data({ reports: true, freshness: 'stale' });
  assert.equal(await f.workflow.onMarketData(context), true);
  assert.equal(f.reads, 2); assert.equal(f.workflow.snapshot.data.periods['1m'].freshness, 'stale');
  assert.equal(f.posts, 0); assert.equal(f.workflow.snapshot.context.asOf, context.asOf);
  await f.workflow.start(); assert.equal(f.workflow.snapshot.phase, 'running');
  assert.equal(await f.workflow.onMarketData(context), false); assert.equal(f.reads, 2); assert.equal(f.posts, 1);
  assert.equal(await f.workflow.onMarketData({ ...context, ticker: '02359.HK' }), false); assert.equal(f.reads, 2);
  f.workflow.dispose();
});


test('已全部保存的归因任务收起进度，失败或运行中仍保留状态', t => {
  const elements = dom(t);
  const completed = job('succeeded', { periods: Object.fromEntries(['1m', '6m', '1y'].map(key => [key, { status: 'succeeded' }])) });
  renderAttribution(snapshot({ job: completed }));
  assert.equal(elements.get('attribution-progress').hidden, true);
  assert.match(elements.get('attribution-body').textContent, /公司业绩改善/);
  renderAttribution(snapshot({ job: completed, busy: true }));
  assert.equal(elements.get('attribution-progress').hidden, false);
  completed.periods['6m'] = { status: 'failed', error: { message: '缺少证据' } };
  renderAttribution(snapshot({ job: completed }));
  assert.equal(elements.get('attribution-progress').hidden, false);
  assert.match(elements.get('attribution-progress').textContent, /缺少证据/);
});
