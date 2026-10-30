import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDebateWorkflow, debatePresentation, formatResearchTime } from '../frontend/src/features/debate-workflow.js';

const report = (version = '2026-10-14T03:00:00Z', ticker = '002920.SZ', asOf = '2026-10-14') => ({ ticker, asOf, generatedAt: version, company: { name: '德赛西威' }, model: 'test-model' });
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  let milliseconds = Date.parse('2026-10-14T03:10:00Z'), current;
  let context = { ticker: '002920.SZ', asOf: '2026-10-14', companyName: '德赛西威' };
  const events = [], calls = [];
  const load = pending(), generate = pending();
  const workflow = createDebateWorkflow({
    service: { load: (...args) => { calls.push(['load', args]); return load.promise; }, generateDebates: (...args) => { calls.push(['generate', args]); return generate.promise; } },
    beginRequest() { current?.abort(); const controller = new AbortController(); current = controller; return { signal: controller.signal, isCurrent: () => current === controller }; },
    getContext: () => context, onChange: value => events.push(value), now: () => milliseconds,
  });
  return { workflow, load, generate, events, calls, advance: n => { milliseconds += n; }, context: next => { context = next; } };
}

test('生成中明确保留上次结果，完成后替换版本并结束按钮等待', async () => {
  const f = fixture(); const old = report();
  const loading = f.workflow.load(); f.load.resolve({ data: old }); await loading;
  assert.equal(f.workflow.snapshot.origin, 'saved');
  const generation = f.workflow.generate(); f.advance(42000);
  let ui = debatePresentation(f.workflow.snapshot, { authorized: true });
  assert.equal(f.workflow.snapshot.report, old); assert.match(ui.originLabel, /上次内容.*正在更新/);
  assert.match(ui.note, /尚未完成.*上次内容/); assert.equal(ui.generateText, '更新中 · 00:42'); assert.equal(ui.generateDisabled, true);
  const latest = report('2026-10-14T03:12:07Z'); f.advance(85000); f.generate.resolve({ data: latest }); await generation;
  ui = debatePresentation(f.workflow.snapshot, { authorized: true });
  assert.equal(f.workflow.snapshot.report, latest); assert.equal(ui.originLabel, '本次更新内容');
  assert.match(ui.title, /分歧更新完成.*02:07/); assert.equal(ui.generateDisabled, false); assert.equal(ui.cancelHidden, true); assert.equal(ui.generateText, '更新分歧');
  assert.match(ui.resultTime, /11:12:07.*北京时间/);
});

test('失败保留可辨认的旧版本，取消后迟到的结果不能覆盖当前展示', async () => {
  const f = fixture(); const old = report();
  const loading = f.workflow.load(); f.load.resolve({ data: old }); await loading;
  const generation = f.workflow.generate(); f.generate.reject(new Error('连接中断')); await generation;
  const ui = debatePresentation(f.workflow.snapshot, { authorized: true });
  assert.equal(ui.generateText, '重试更新分歧'); assert.match(ui.originLabel, /本次更新失败/); assert.match(ui.note, /上次内容.*未被替换/); assert.equal(f.workflow.snapshot.report, old);
  const another = fixture(); const waiting = another.workflow.generate(); another.workflow.cancel();
  another.generate.resolve({ data: report() }); await waiting;
  assert.equal(another.workflow.snapshot.phase, 'cancelled'); assert.equal(another.workflow.snapshot.report, null);
  assert.equal(debatePresentation(another.workflow.snapshot, { authorized: true }).generateDisabled, false);
});

test('切换股票后旧生成响应不会混入新上下文；不匹配股票不会展示', async () => {
  const f = fixture(); const generation = f.workflow.generate();
  f.context({ ticker: '02313.HK', asOf: '2026-10-13', companyName: '申洲国际' }); f.workflow.reset();
  f.generate.resolve({ data: report() }); await generation;
  assert.equal(f.workflow.snapshot.report, null); assert.equal(f.workflow.snapshot.phase, 'idle');
  const loading = f.workflow.load(); f.load.resolve({ data: report() }); await loading;
  assert.equal(f.workflow.snapshot.phase, 'failed'); assert.match(f.workflow.snapshot.error, /不一致/); assert.equal(f.workflow.snapshot.report, null);
});

test('页面包含独立任务/版本栏，证据区使用默认关闭的原生折叠控件', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  for (const id of ['debate-activity']) assert.ok(html.includes(`id="${id}"`));
  for (const id of ['debate-coverage', 'debate-sources']) {
    const tag = html.match(new RegExp(`<details\\b[^>]*id="${id}"[^>]*>`))?.[0]; assert.ok(tag); assert.doesNotMatch(tag, /\bopen(?:\s|=|>)/);
  }
  assert.equal(formatResearchTime('invalid'), '更新时间未提供');
});

test('DeepSeek 生成状态和等待说明使用实际服务，未配置时保持生成禁用', () => {
  const state = { phase: 'idle', kind: null, report: null, context: { ticker: '002920.SZ', asOf: '2026-10-14' }, elapsedSeconds: 0 };
  const unavailable = debatePresentation(state, { provider: 'deepseek' });
  assert.equal(unavailable.generateText, '先配置 DeepSeek API'); assert.equal(unavailable.generateDisabled, true);
  const waiting = debatePresentation({ ...state, phase: 'running', kind: 'generate', elapsedSeconds: 12 }, { provider: 'deepseek', authorized: true });
  assert.equal(waiting.generateText, 'DeepSeek 生成中 · 00:12');
  assert.match(waiting.title, /DeepSeek/); assert.match(waiting.note, /DeepSeek.*后端取得的资料/);
  assert.doesNotMatch(`${waiting.title} ${waiting.note} ${waiting.generateText}`, /ChatGPT|套餐|登录/);
  assert.equal(waiting.generateDisabled, true);
});

test('每股单份分歧跨数据日期读取，按真实内容日期展示，不发送全局asOf', async () => {
  const f = fixture();
  f.context({ ticker: '002920.SZ', asOf: '2025-01-01', companyName: '德赛西威' });
  const loading = f.workflow.load();
  assert.deepEqual(f.calls[0][1][1], { ticker: '002920.SZ' });
  const saved = { ...report(), updatedAt: '2026-10-15T03:30:00Z' };
  f.load.resolve({ data: saved }); await loading;
  assert.equal(f.workflow.snapshot.report, saved); assert.equal(f.workflow.snapshot.phase, 'succeeded');
  const ui = debatePresentation(f.workflow.snapshot, { authorized: true, validDate: false });
  assert.match(ui.resultTime, /最后更新 2026-10-15 11:30:00/);
  assert.match(ui.resultDetail, /内容研究截止 2026-10-14/); assert.doesNotMatch(ui.resultDetail, /2025-01-01/);
  assert.equal(ui.generateDisabled, false); assert.equal(ui.reloadDisabled, false);
  const updating = f.workflow.generate();
  assert.deepEqual(f.calls[1][1][0], { ticker: '002920.SZ', companyName: '德赛西威' });
  f.context({ ticker: '002920.SZ', asOf: '2024-02-01', companyName: '德赛西威' });
  const latest = report('2026-10-15T04:00:00Z', '002920.SZ', '2026-10-15');
  f.generate.resolve({ data: latest }); await updating;
  assert.equal(f.workflow.snapshot.report, latest); assert.equal(f.calls.length, 2);
});

test('更新失败仍保留旧更新时间，数据日期控制独立于生成表单且不会重读或重置分歧', async () => {
  const f = fixture(), saved = { ...report(), updatedAt: '2026-10-14T03:00:00Z' };
  const load = f.workflow.load(); f.load.resolve({ data: saved }); await load;
  const update = f.workflow.generate(); f.generate.reject(new Error('API不可用')); await update;
  assert.equal(f.workflow.snapshot.report, saved);
  assert.match(debatePresentation(f.workflow.snapshot, { authorized: true }).resultTime, /最后更新 2026-10-14 11:00:00/);
  const main = await readFile(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  const handler = main.slice(main.indexOf("researchDateInput.addEventListener('change'"), main.indexOf('initAIStatus({'));
  assert.doesNotMatch(handler, /debateWorkflow\.reset|\['debates'|refresh\('debates'\)/);
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const form = html.match(/<form[^>]*id="debates-form"[^>]*>[\s\S]*?<\/form>/)?.[0];
  assert.ok(form); assert.doesNotMatch(form, /id="research-date"/); assert.match(html, /数据截止日期/);
  assert.doesNotMatch(html, /class="generation-note"/);
});
