import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptRelationsResearchJob, createRelationsAIWorkflow, relationsAIPresentation, relationsRefreshPresentation } from '../frontend/src/features/relations-ai.js';
import { createResearchService } from '../frontend/src/services/research-service.js';
import { endpoints } from '../frontend/src/api/endpoints.js';
import { assertRelationsRevision } from '../frontend/src/features/relations-data.js';

const context = { ticker: '00700.HK', asOf: '2026-10-20', name: '腾讯控股' };
const job = (overrides = {}) => ({ jobId: 'research-1', ticker: context.ticker, asOf: context.asOf, status: 'running', stage: 'search', ...overrides });
const report = (target = context) => ({ status: 'ready', data: { ticker: target.ticker, asOf: target.asOf, relations: [], meta: { origin: 'ai' } } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function fixture(overrides = {}) {
  let selected = { ...context }, allowed = true, generationAllowed = true;
  const posts = [], requests = [], reads = [], saved = [], updates = [], timers = new Map(); let nextTimer = 0;
  const workflow = createRelationsAIWorkflow({
    getContext: () => selected, allowed: () => allowed, canGenerate: () => generationAllowed,
    startResearch: async params => { posts.push(params); return overrides.start ? overrides.start(params) : { data: job() }; },
    loadJob: async (params, options) => { requests.push({ params, options }); return overrides.get ? overrides.get(params, options) : { data: params.jobId ? job() : null }; },
    loadRelations: async (params, options) => { reads.push({ params, options }); return overrides.read ? overrides.read(params, options) : report(params); },
    onSaved: (result, target) => { overrides.onSaved?.(result, target); saved.push({ result, target }); }, onChange: snapshot => updates.push(snapshot),
    schedule: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, unschedule: id => timers.delete(id),
  });
  return { workflow, posts, requests, reads, saved, updates, timers, setContext: value => { selected = value; }, setAllowed: value => { allowed = value; },
    setGenerationAllowed: value => { generationAllowed = value; },
    async tick() { const item = timers.entries().next().value; if (!item) throw new Error('No poll scheduled'); timers.delete(item[0]); item[1](); await settle(); },
  };
}

test('初始化只读取已有任务，点击后才 POST；重复点击复用进程，成功须 GET 保存内容后应用', async () => {
  let completed = false;
  const read = deferred();
  const f = fixture({ get: params => ({ data: params.jobId ? job({ status: completed ? 'succeeded' : 'running', result: completed ? { relationCount: 2 } : undefined }) : null }), read: () => read.promise });
  f.workflow.sync(); f.workflow.sync(); await settle();
  assert.equal(f.requests.length, 1); assert.equal(f.posts.length, 0); assert.equal(f.workflow.snapshot.canStart, true);
  assert.equal(await f.workflow.start(), true); assert.equal(f.posts.length, 1); assert.equal(f.timers.size, 1);
  assert.equal(await f.workflow.start(), false); assert.equal(f.posts.length, 1);
  completed = true; await f.tick();
  assert.equal(f.reads.length, 1); assert.equal(f.saved.length, 0); assert.equal(f.workflow.snapshot.phase, 'reloading');
  assert.equal(await f.workflow.start(), false);
  read.resolve(report()); await settle();
  assert.equal(f.saved.length, 1); assert.equal(f.workflow.snapshot.phase, 'succeeded'); assert.equal(f.timers.size, 0);
  assert.equal(relationsAIPresentation(f.workflow.snapshot).title, '本次 AI 识别 2 家公司');
});

test('打开已有 running 任务会恢复轮询，不会产生新请求；服务失败可明确重新识别', async () => {
  let status = 'running';
  const f = fixture({ get: () => ({ data: job({ status, message: status === 'failed' ? '公开检索服务暂不可用' : '检索公告中' }) }) });
  f.workflow.sync(); await settle();
  assert.equal(f.posts.length, 0); assert.equal(f.workflow.snapshot.phase, 'running'); assert.equal(f.timers.size, 1);
  status = 'failed'; await f.tick();
  assert.equal(f.workflow.snapshot.phase, 'failed'); assert.equal(f.workflow.snapshot.needsResume, false);
  assert.match(f.workflow.snapshot.error, /检索服务暂不可用/); assert.equal(f.saved.length, 0);
  await f.workflow.start(); assert.equal(f.posts.length, 1);
});

test('轮询失败保持已有表格，重试只读取原 jobId，读取保存结果失败也不重复 POST', async () => {
  let networkFails = false, completed = false, readFails = false;
  const f = fixture({ get: params => {
    if (networkFails) throw Object.assign(new Error('连接断开'), { code: 'NETWORK_ERROR' });
    return { data: params.jobId ? job({ status: completed ? 'succeeded' : 'running' }) : null };
  }, read: params => { if (readFails) throw new Error('数据库暂不可读'); return report(params); } });
  f.workflow.sync(); await settle(); await f.workflow.start();
  networkFails = true; await f.tick();
  assert.equal(f.workflow.snapshot.phase, 'failed'); assert.equal(f.workflow.snapshot.needsResume, true); assert.equal(f.saved.length, 0);
  assert.match(relationsAIPresentation(f.workflow.snapshot).buttonText, /重试读取/);
  networkFails = false; await f.workflow.start();
  assert.equal(f.posts.length, 1); assert.deepEqual(f.requests.at(-1).params, { jobId: 'research-1' });
  completed = true; readFails = true; await f.tick();
  assert.equal(f.workflow.snapshot.needsResume, true); assert.equal(f.saved.length, 0); assert.match(f.workflow.snapshot.error, /读取保存结果失败/);
  readFails = false; assert.equal(await f.workflow.start(), true);
  assert.equal(f.posts.length, 1); assert.equal(f.saved.length, 1);
});

test('切股中止旧轮询并禁止迟到状态应用，回访原公司恢复服务器任务', async () => {
  const pending = deferred(); let pollStarted = false;
  const other = { ticker: '600000.SH', asOf: context.asOf, name: '浦发银行' };
  const f = fixture({ get: params => {
    if (params.jobId) { pollStarted = true; return pending.promise; }
    return { data: params.ticker === context.ticker && f.posts.length ? job() : null };
  } });
  f.workflow.sync(); await settle(); await f.workflow.start();
  const tick = f.tick(); await settle(); assert.equal(pollStarted, true);
  const oldSignal = f.requests.at(-1).options.signal;
  f.setContext(other); f.workflow.sync(); await settle();
  assert.equal(oldSignal.aborted, true); assert.equal(f.workflow.snapshot.context.ticker, other.ticker);
  pending.resolve({ data: job({ status: 'succeeded' }) }); await tick; await settle();
  assert.equal(f.saved.length, 0); assert.equal(f.reads.length, 0); assert.equal(f.workflow.snapshot.phase, 'idle');
  f.setContext({ ...context }); f.workflow.sync(); await settle();
  assert.equal(f.workflow.snapshot.phase, 'running'); assert.equal(f.posts.length, 1); assert.equal(f.saved.length, 0);
  assert.deepEqual(f.requests.at(-1).params, context);
});

test('回访读取最新任务，服务器有新 job 时不会继续显示旧 completed 任务的计数', async () => {
  let latest = job({ status: 'succeeded', result: { relationCount: 1 } });
  const f = fixture({ get: params => ({ data: params.ticker === context.ticker ? latest : null }) });
  f.workflow.sync(); await settle(); assert.equal(f.workflow.snapshot.phase, 'succeeded');
  f.setContext({ ticker: '600000.SH', asOf: context.asOf }); f.workflow.sync(); await settle();
  latest = job({ jobId: 'new-running-job', status: 'running' });
  f.setContext({ ...context }); f.workflow.sync(); await settle();
  assert.equal(f.workflow.snapshot.job.jobId, 'new-running-job'); assert.equal(f.workflow.snapshot.phase, 'running');
  assert.equal(f.posts.length, 0); assert.deepEqual(f.requests.at(-1).params, context);
});

test('AI 读取旧人工 revision 不得覆盖刚保存的人工关系，重试只重读最新保存结果', async () => {
  const pending = deferred(); let current = { ...report().data, meta: { manualRevision: '0' } }, readCount = 0;
  const f = fixture({ start: () => ({ data: job({ status: 'succeeded' }) }),
    read: () => ++readCount === 1 ? pending.promise : { status: 'ready', data: current },
    onSaved: result => { assertRelationsRevision(result.data, current); current = result.data; },
  });
  f.workflow.sync(); await settle(); const started = f.workflow.start(); await settle();
  current = { ...current, status: 'customized', meta: { manualRevision: '1', hasManualChanges: true }, relations: [{ relatedTicker: '600000.SH', rationale: '刚保存的人工备注' }] };
  pending.resolve({ status: 'ready', data: { ...report().data, meta: { manualRevision: '0' } } });
  assert.equal(await started, false); assert.equal(f.saved.length, 0); assert.equal(current.meta.manualRevision, '1');
  assert.match(f.workflow.snapshot.error, /已保留新修改/); assert.equal(f.workflow.snapshot.needsResume, true);
  assert.equal(await f.workflow.start(), true); assert.equal(f.posts.length, 1); assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].result.data.relations[0].rationale, '刚保存的人工备注');
});

test('POST 期间切股保留后台 jobId，原公司成功返回时不修改新公司', async () => {
  const pending = deferred(), f = fixture({ start: () => pending.promise });
  f.workflow.sync(); await settle(); const started = f.workflow.start();
  f.setContext({ ticker: '600000.SH', asOf: context.asOf }); f.workflow.sync(); await settle();
  pending.resolve({ data: job({ status: 'succeeded', result: { relationCount: 3 } }) });
  assert.equal(await started, false); assert.equal(f.saved.length, 0); assert.equal(f.reads.length, 0);
  assert.equal(f.workflow.snapshot.context.ticker, '600000.SH');
});

test('改研究日期不能应用旧结果；返回其他日期的任务/保存数据均不能冒充成功', async () => {
  const pending = deferred(), f = fixture({ start: () => ({ data: job({ status: 'succeeded' }) }), read: () => pending.promise });
  f.workflow.sync(); await settle(); const started = f.workflow.start(); await settle();
  const signal = f.reads[0].options.signal;
  f.setContext({ ...context, asOf: '2026-10-19' }); f.workflow.sync(); await settle();
  assert.equal(signal.aborted, true);
  pending.resolve(report()); assert.equal(await started, false); assert.equal(f.saved.length, 0);
  const mismatch = fixture({ start: () => ({ data: job({ ticker: '600000.SH' }) }) });
  mismatch.workflow.sync(); await settle(); assert.equal(await mismatch.workflow.start(), false);
  assert.equal(mismatch.saved.length, 0); assert.match(mismatch.workflow.snapshot.error, /标的、日期或状态无效/);
});

test('未知提交结果先按 ticker/asOf 找回，不会误读上一次失败任务并重复生成', async () => {
  let submitted = false;
  const f = fixture({ get: params => ({ data: submitted ? job() : null }), start: () => { submitted = true; throw Object.assign(new Error('请求超时'), { code: 'TIMEOUT' }); } });
  f.workflow.sync(); await settle(); assert.equal(await f.workflow.start(), false);
  assert.equal(f.workflow.snapshot.needsResume, true); assert.equal(await f.workflow.start(), true);
  assert.equal(f.posts.length, 1); assert.deepEqual(f.requests.at(-1).params, context);
  assert.equal(f.workflow.snapshot.phase, 'running');
});

test('只读与不支持的证券禁止启动，权限恢复后可恢复轮询，不依赖 ChatGPT 登录字段', async () => {
  const f = fixture({ get: () => ({ data: f.posts.length ? job() : null }) }); f.setAllowed(false); f.workflow.sync();
  assert.equal(await f.workflow.start(), false); assert.equal(f.requests.length, 0);
  f.setAllowed(true); f.workflow.sync(); await settle(); await f.workflow.start();
  f.setAllowed(false); f.workflow.sync(); assert.equal(f.timers.size, 0); assert.equal(f.workflow.snapshot.canStart, false);
  f.setAllowed(true); f.workflow.sync(); await settle(); assert.equal(f.workflow.snapshot.phase, 'running');
  f.setContext({ ticker: 'AAPL', asOf: context.asOf }); f.workflow.sync();
  assert.equal(await f.workflow.start(), false); assert.equal(f.posts.length, 1);
});

test('0 家可信结果明确保留已有关系，无伪造满额成功提示；非法任务与未来格式日期被拒绝', () => {
  const presentation = relationsAIPresentation({ phase: 'succeeded', canStart: true, job: job({ status: 'succeeded', result: { relationCount: 0, retainedPrevious: true } }) });
  assert.match(presentation.title, /未找到足够公开依据/); assert.match(presentation.note, /保留现有关系/);
  assert.equal(presentation.buttonText, 'AI识别上下游及同行');
  assert.equal(relationsAIPresentation({ phase: 'failed', canStart: true }).buttonText, '重新AI识别上下游及同行');
  for (const overrides of [{ ticker: '0700.HK' }, { asOf: '2026-02-30' }, { jobId: '' }, { status: 'complete' }]) assert.throws(() => adaptRelationsResearchJob({ data: job(overrides) }, context));
  assert.equal(adaptRelationsResearchJob({ data: null }, context), null);
});

test('兼容旧任务的成功提示，资料不足不强凑；失败明确不覆盖原有内容', () => {
  const presentation = relationsAIPresentation({ phase: 'succeeded', canStart: true,
    job: job({ status: 'succeeded', result: { relationCount: 1, retainedPrevious: true } }) });
  assert.equal(presentation.title, '本次 AI 识别 1 家公司');
  assert.match(presentation.note, /已保存当前关系.*资料摘要及来源.*资料不足以支持 10 家.*不为凑数/);
  assert.doesNotMatch(presentation.note, /合并|累计/);
  assert.match(relationsAIPresentation({ phase: 'failed', canStart: true, error: '检索失败' }).note, /检索失败.*未覆盖原有关系/);
});

test('AI刷新说明优先保留并要求换股依据，成功按实际调整统计，拒绝畸形摘要', () => {
  const start = relationsAIPresentation({ phase: 'starting', canStart: false });
  assert.match(start.note, /优先保留已有公司.*空位再补充.*替换公司须有充分理由及来源.*人工可直接修改/);
  const refreshSummary = { retainedCount: 7, addedCount: 3, removedCount: 2, blockedCount: 1, changes: [
    { oldTicker: '600000.SH', newTicker: '600001.SH', reason: '原业务已剥离，新公司业务及来源更匹配。' },
    { oldTicker: '600002.SH', newTicker: '600003.SH', reason: '原公司已退出相关业务。' },
  ] };
  const result = relationsAIPresentation({ phase: 'succeeded', canStart: true, job: job({ status: 'succeeded', result: { relationCount: 10, refreshSummary } }) });
  assert.match(result.note, /保留 7 家，新增 1 家，替换 2 家。另有 1 项候选调整未采用。.*研究说明/);
  assert.doesNotMatch(result.note, /整份替换/);
  const removal = relationsRefreshPresentation({ retainedCount: 1, addedCount: 0, removedCount: 1, blockedCount: 0,
    changes: [{ oldTicker: '600000.SH', newTicker: null, reason: '已退市。' }] });
  assert.match(removal.text, /保留 1 家，新增 0 家，替换 0 家，移除 1 家/);
  const unchanged = relationsRefreshPresentation({ retainedCount: 10, addedCount: 0, removedCount: 0, blockedCount: 2, changes: [] });
  assert.match(unchanged.text, /保留 10 家，新增 0 家，替换 0 家.*2 项候选调整未采用/);
  for (const bad of [null, [], {}, { ...refreshSummary, addedCount: -1 }, { ...refreshSummary, retainedCount: '7' }, { ...refreshSummary, changes: null }]) {
    assert.equal(relationsRefreshPresentation(bad), null);
  }
});

test('0 家任务的实际缺口随已保存结果传给页面，去重且不修改原响应或人工关系', async () => {
  const saved = report(); saved.data.gaps = ['既有研究缺口', '重复缺口'];
  saved.data.meta = { manualRevision: '3', hasManualChanges: true };
  const task = job({ status: 'succeeded', result: { relationCount: 0, retainedPrevious: true,
    gaps: [' 已排除 601377.SH：引用未对应本次取得的正文原句。 ', '重复缺口', null, ''] } });
  const f = fixture({ get: () => ({ data: task }), read: () => saved });
  f.workflow.sync(); await settle();
  assert.equal(f.workflow.snapshot.phase, 'succeeded');
  assert.equal(f.saved.length, 1);
  assert.deepEqual(f.saved[0].result.data.gaps, ['既有研究缺口', '重复缺口', '已排除 601377.SH：引用未对应本次取得的正文原句。']);
  assert.deepEqual(saved.data.gaps, ['既有研究缺口', '重复缺口']);
  assert.equal(f.saved[0].result.data.meta.manualRevision, '3');
  assert.equal(f.saved[0].result.data.relations, saved.data.relations);
  const noSavedGaps = fixture({ get: () => ({ data: task }) });
  noSavedGaps.workflow.sync(); await settle();
  assert.deepEqual(noSavedGaps.saved[0].result.data.gaps, ['已排除 601377.SH：引用未对应本次取得的正文原句。', '重复缺口']);
});

test('历史日期禁用新识别并说明切回今日，仍允许 GET 恢复已保存结果', async () => {
  const f = fixture(); f.setGenerationAllowed(false); f.workflow.sync(); await settle();
  assert.equal(f.workflow.snapshot.canStart, false); assert.equal(await f.workflow.start(), false);
  assert.equal(f.posts.length, 0); assert.equal(f.requests.length, 1);
  const presentation = relationsAIPresentation(f.workflow.snapshot);
  assert.match(presentation.title, /历史日期仅查看/); assert.match(presentation.note, /切回今日/);
  const saved = fixture({ get: () => ({ data: job({ status: 'succeeded', result: { relationCount: 1 } }) }) });
  saved.setGenerationAllowed(false); saved.workflow.sync(); await settle();
  assert.equal(saved.posts.length, 0); assert.equal(saved.saved.length, 1); assert.equal(saved.workflow.snapshot.phase, 'succeeded');
  assert.equal(saved.workflow.snapshot.canStart, false);
});

test('服务端完整阶段名称映射为检索、读取原文、核验证据与保存', () => {
  for (const [stage, expected] of [['queued', '准备联网识别'], ['searching', '联网检索公告与新闻'], ['fetching', '公告与新闻原文'], ['analyzing', '核验证据'], ['validating', '核验证据'], ['saving', '保存结果']]) {
    assert.ok(relationsAIPresentation({ phase: 'running', canStart: false, job: job({ stage }) }).title.includes(expected));
  }
});

test('关系 AI 服务的启动使用明确 POST，恢复只 GET，不携带名称、证据与 API 密钥', async () => {
  const calls = [], service = createResearchService({ config: { enabled: true }, routes: endpoints, mappers: {}, client: {
    post: async (path, options) => { calls.push({ method: 'POST', path, options }); return { data: job() }; },
    get: async (path, options) => { calls.push({ method: 'GET', path, options }); return { data: job() }; },
  } });
  await service.startRelationsResearch({ ...context, apiKey: 'must-not-send', sources: [] });
  await service.loadRelationsResearch({ jobId: 'research-1', ...context });
  await service.loadRelationsResearch(context);
  assert.deepEqual(calls.map(({ method, path, options }) => ({ method, path, body: options.body, query: options.query })), [
    { method: 'POST', path: '/api/relations/research', body: { ticker: context.ticker, asOf: context.asOf }, query: undefined },
    { method: 'GET', path: '/api/relations/research', body: undefined, query: { jobId: 'research-1' } },
    { method: 'GET', path: '/api/relations/research', body: undefined, query: { ticker: context.ticker, asOf: context.asOf } },
  ]);
});
