import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAttributionService, attributionFailure } from '../backend/src/attribution-service.mjs';
import { validateAttributionReport } from '../backend/src/attribution-store.mjs';
import { ATTRIBUTION_PERIODS, attributionWindow } from '../backend/src/attribution-snapshot.mjs';
import { ResearchError } from '../backend/src/errors.mjs';

const fixedNow = '2026-10-20T02:00:00.000Z';
const ticker = '00700.HK';
const clone = value => value == null ? value : structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate, message = '后台任务未按预期推进') {
  for (let count = 0; count < 100; count++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail(message);
}
const databaseError = () => new ResearchError('MARKET_DATABASE_UNAVAILABLE', 'Postgres unavailable', 503);
function prices(params, lastChange = 0, fixedDates = null) {
  const hk = params.ticker.endsWith('.HK');
  const dates = fixedDates ?? [attributionWindow(params.asOf, params.period), '2026-10-12', '2026-10-19'];
  const values = [100, 105, 110 + lastChange], indices = [2000, 2020, 2080];
  const points = dates.map((date, index) => ({ date, open: values[index], high: values[index], low: values[index], close: values[index], volume: 1000 }));
  return { ticker: params.ticker, points, meta: { requestedAsOf: params.asOf, period: params.period, adjustment: hk ? 'none' : 'qfq', adjustmentStatus: 'available', currency: hk ? 'HKD' : 'CNY' },
    benchmark: { status: 'available', system: hk ? 'HSI' : 'SW2021', level: hk ? null : 3, indexCode: hk ? 'HSI' : '850881.SI', industryName: hk ? '恒生指数' : '汽车电子',
      baseDate: dates[0], baseStockClose: 100, baseIndexClose: 2000, points: dates.map((date, index) => ({ date, close: indices[index], scaledClose: 100 * indices[index] / 2000 })) } };
}
function researchResult(snapshot, extras = {}) {
  const excerpt = `${snapshot.companyName}公告披露经营表现有所改善。`;
  const source = { id: 's1', title: '公司经营公告', url: `https://example.com/${snapshot.ticker}/disclosure`, publishedAt: snapshot.to, citationVerified: true };
  return { provider: 'deepseek', model: 'deepseek-mock', summary: '经营改善可能支持相对指数表现，但无法确定其贡献。',
    drivers: [{ title: '经营表现改善', category: 'company', direction: 'positive', explanation: '公告与区间相对走强同期发生，可能构成支持。', evidence: [{ sourceId: 's1', quote: excerpt, citationVerified: true }] }],
    sources: [source], limitations: ['公开资料相关性不代表因果已被证明。'], corporateActionStatus: 'uncertain',
    retrievalEvidence: { origin: 'deepseek-search', sources: [{ ...source, readingScope: 'partial_text', eligibleForDriver: true, contentLength: excerpt.length, contentSha256: createHash('sha256').update(excerpt).digest('hex') }] },
    ...extras };
}
function fixture(t, options = {}) {
  let nowValue = options.now ?? fixedNow, priceChange = 0, sequence = 0, activeResearch = 0, maximumResearch = 0;
  const calls = [], reads = [], saved = [], failures = [], logs = [], jobs = new Map(), snapshots = new Map(), reports = new Map(), events = [], heartbeats = [];
  const store = {
    async expireStaleJobs() { events.push('sweep'); if (options.sweepError) throw options.sweepError; return { expired: 0 }; },
    async listReports(symbol) { if (options.reportReadError) throw options.reportReadError; return clone(reports.get(symbol) ?? {}); },
    async getLatestJob(symbol) { if (options.jobReadError) throw options.jobReadError; return clone([...jobs.values()].reverse().find(job => job.ticker === symbol) ?? null); },
    async getJob(id) { const value = jobs.get(id); if (!value) throw new ResearchError('ATTRIBUTION_JOB_NOT_FOUND', '任务不存在', 404); return clone(value); },
    async createJob(params) {
      if (options.createError) throw options.createError;
      const active = [...jobs.values()].find(job => job.status === 'running');
      if (active) {
        if (active.ticker === params.ticker) return { created: false, job: clone(active) };
        throw new ResearchError('ATTRIBUTION_BUSY', '已有任务正在运行', 429);
      }
      const jobId = `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
      const job = { jobId, ticker: params.ticker, requestedAsOf: params.asOf, status: 'running', stage: 'queued',
        periods: Object.fromEntries(params.periods.map(period => [period, params.errors[period] ? { status: 'failed', stage: 'failed', error: params.errors[period] } : { status: 'queued', stage: 'queued' }])),
        createdAt: nowValue, updatedAt: nowValue, finishedAt: null };
      snapshots.set(jobId, clone(params.snapshots)); jobs.set(jobId, job); events.push(`create:${params.ticker}`);
      return { created: true, job: clone(job) };
    },
    async updateProgress({ jobId, period, stage }) {
      if (options.progressError) throw options.progressError;
      const job = jobs.get(jobId); job.stage = stage; job.periods[period] = { status: 'running', stage }; events.push(`${period}:${stage}`); return clone(job);
    },
    async heartbeat(jobId) { heartbeats.push(jobId); if (options.heartbeatError) throw options.heartbeatError; },
    async completePeriod({ jobId, period, report }) {
      const snapshot = snapshots.get(jobId)[period];
      const value = validateAttributionReport(report, snapshot, new Date(nowValue));
      if (options.completeError && (!options.completeErrorPeriod || options.completeErrorPeriod === period)) throw options.completeError;
      const existing = reports.get(snapshot.ticker) ?? {};
      reports.set(snapshot.ticker, { ...existing, [period]: value }); saved.push({ jobId, period, report: value }); events.push(`${period}:stored`);
      jobs.get(jobId).periods[period] = { status: 'succeeded', stage: 'completed' }; return clone(jobs.get(jobId));
    },
    async failPeriod(params) {
      failures.push(clone(params)); events.push(`${params.period}:failed`);
      if (options.failPeriodError) throw options.failPeriodError;
      jobs.get(params.jobId).periods[params.period] = { status: 'failed', stage: 'failed', error: clone(params.error) }; return clone(jobs.get(params.jobId));
    },
    async finishJob(id) {
      const job = jobs.get(id), states = Object.values(job.periods).map(period => period.status);
      assert.ok(states.every(status => ['succeeded', 'failed'].includes(status)));
      job.status = states.every(status => status === 'succeeded') ? 'succeeded' : states.some(status => status === 'succeeded') ? 'partial' : 'failed';
      job.stage = 'completed'; job.finishedAt = nowValue; events.push('finished'); return clone(job);
    },
  };
  const marketService = {
    async profile(params) { reads.push({ type: 'profile', params }); if (options.profileError) throw options.profileError; return options.unknown ? null : { ticker: params.ticker, name: params.ticker === ticker ? '腾讯控股' : '德赛西威' }; },
    async prices(params) { reads.push({ type: 'prices', params }); if (options.priceError && (!options.priceErrorPeriod || options.priceErrorPeriod === params.period)) throw options.priceError;
      return options.prices ? options.prices(params, priceChange) : prices(params, priceChange); },
  };
  const client = { async researchAttribution(snapshot, prompt, progress) {
    activeResearch++; maximumResearch = Math.max(maximumResearch, activeResearch); calls.push({ snapshot: clone(snapshot), prompt }); events.push(`${snapshot.period}:inference`);
    try { await progress.onProgress('analyzing'); if (options.gate) await options.gate.promise; return options.research ? await options.research(snapshot, progress) : researchResult(snapshot); }
    finally { activeResearch--; }
  } };
  const service = createAttributionService({ store, marketService, client, sectorResolver: options.sectorResolver, prompt: options.prompt ?? '联网核验区间原因，禁止伪造贡献。', configured: options.configured ?? true,
    provider: options.provider ?? 'deepseek', now: () => new Date(nowValue), heartbeatMs: options.heartbeatMs ?? 50, log: value => logs.push(value) });
  t.after(async () => { options.gate?.resolve(); await service.close(); });
  return { service, store, reports, jobs, snapshots, calls, reads, saved, failures, events, logs, heartbeats,
    get maximumResearch() { return maximumResearch; }, set now(value) { nowValue = value; }, set priceChange(value) { priceChange = value; },
  };
}
const completed = async (f, id) => { await until(() => f.jobs.get(id)?.status !== 'running'); await new Promise(resolve => setImmediate(resolve)); return f.jobs.get(id); };

// Mock only: these tests never connect to Postgres or call a paid provider.
test('读取仅比较本地行情与已保存报告，缺少AI配置也可读取且不生成任务', async t => {
  const f = fixture(t, { configured: false });
  const result = await f.service.get({ ticker, asOf: '2026-10-20' });
  assert.equal(result.ticker, ticker); assert.equal(result.historical, false); assert.equal(result.job, null);
  assert.deepEqual(Object.values(result.periods).map(item => item.freshness), ['missing', 'missing', 'missing']);
  assert.ok(Object.values(result.periods).every(item => item.report === null && item.currentMetrics?.from));
  assert.ok(Object.values(result.periods).every(item => !Object.hasOwn(item.currentMetrics, 'series') && !Object.hasOwn(item.currentMetrics, 'inputHash')));
  assert.equal(f.calls.length, 0); assert.equal(f.jobs.size, 0);
  await assert.rejects(f.service.start({ ticker }), { code: 'ATTRIBUTION_AI_NOT_CONFIGURED', status: 503 });
  assert.equal(f.calls.length, 0);
});

test('单次启动严格按1月6月1年顺序研究并独立保存，三个任务不并发', async t => {
  const f = fixture(t), started = await f.service.start({ ticker });
  assert.equal(started.status, 'running'); assert.equal(started.requestedAsOf, '2026-10-20');
  const finished = await completed(f, started.jobId);
  assert.equal(finished.status, 'succeeded'); assert.deepEqual(f.calls.map(call => call.snapshot.period), ATTRIBUTION_PERIODS);
  assert.deepEqual(f.saved.map(item => item.period), ATTRIBUTION_PERIODS); assert.equal(f.maximumResearch, 1);
  assert.ok(f.events.indexOf('1m:stored') < f.events.indexOf('6m:inference'));
  assert.ok(f.events.indexOf('6m:stored') < f.events.indexOf('1y:inference'));
  assert.deepEqual(f.reads.filter(call => call.type === 'prices').map(call => call.params), ATTRIBUTION_PERIODS.map(period => ({ ticker, asOf: '2026-10-20', period, adjustment: 'none', benchmark: 'hsi' })));
  const result = await f.service.get({ ticker }); assert.ok(Object.values(result.periods).every(item => item.freshness === 'fresh'));
  assert.equal(f.calls.length, 3); assert.equal(result.periods['1m'].report.provider, 'deepseek');
});

test('中间周期研究失败保留旧报告并继续一年，显式仅重试失败周期', async t => {
  let failSixMonth = false;
  const f = fixture(t, { research: async snapshot => { if (snapshot.period === '6m' && failSixMonth) throw new ResearchError('SEARCH_FAILED', '搜索失败', 502); return researchResult(snapshot); } });
  const initial = await f.service.start({ ticker }); await completed(f, initial.jobId);
  const previous = clone(f.reports.get(ticker)['6m']); failSixMonth = true; f.priceChange = 5;
  const next = await f.service.start({ ticker }); const partial = await completed(f, next.jobId);
  assert.equal(partial.status, 'partial'); assert.equal(partial.periods['6m'].status, 'failed');
  assert.deepEqual(f.reports.get(ticker)['6m'], previous); assert.equal(f.reports.get(ticker)['1y'].stockReturn, 0.1499999999999999);
  assert.deepEqual(f.calls.slice(3).map(call => call.snapshot.period), ATTRIBUTION_PERIODS);
  assert.equal(f.failures.at(-1).error.code, 'ATTRIBUTION_NEWS_SEARCH_FAILED');
  const read = await f.service.get({ ticker }); assert.equal(read.periods['6m'].freshness, 'stale');
  failSixMonth = false;
  const retry = await f.service.start({ ticker, periods: ['6m'] }); await completed(f, retry.jobId);
  assert.equal(f.calls.length, 7); assert.equal(f.calls.at(-1).snapshot.period, '6m'); assert.deepEqual(Object.keys(f.jobs.get(retry.jobId).periods), ['6m']);
  assert.notDeepEqual(f.reports.get(ticker)['6m'], previous);
});

test('提交事务失败不调用AI；数据库保存失败保留旧内容并停止后续付费研究', async t => {
  const f = fixture(t, { createError: databaseError() });
  await assert.rejects(f.service.start({ ticker }), { code: 'MARKET_DATABASE_UNAVAILABLE' }); assert.equal(f.calls.length, 0); assert.equal(f.jobs.size, 0);
  const invalid = fixture(t, { completeError: new ResearchError('ATTRIBUTION_DATABASE_UNAVAILABLE', '无法保存', 503), completeErrorPeriod: '6m' });
  invalid.reports.set(ticker, { '6m': { summary: '旧报告必须保留' } });
  const started = await invalid.service.start({ ticker }); const finished = await completed(invalid, started.jobId);
  assert.equal(finished.status, 'partial'); assert.equal(invalid.reports.get(ticker)['6m'].summary, '旧报告必须保留');
  assert.deepEqual(invalid.saved.map(item => item.period), ['1m']); assert.equal(invalid.calls.length, 2);
  assert.equal(finished.periods['1y'].error.code, 'ATTRIBUTION_DATABASE_UNAVAILABLE');
});

test('同股并发提交与任务运行中重复点击只创建一个任务，不同股票明确busy', async t => {
  const gate = deferred(), f = fixture(t, { gate });
  const [first, duplicate, third] = await Promise.all([f.service.start({ ticker }), f.service.start({ ticker }), f.service.start({ ticker })]);
  assert.equal(first.jobId, duplicate.jobId); assert.equal(first.jobId, third.jobId); assert.equal(f.jobs.size, 1);
  await until(() => f.calls.length === 1);
  assert.equal((await f.service.start({ ticker })).jobId, first.jobId); assert.equal(f.calls.length, 1);
  await assert.rejects(f.service.start({ ticker: '002920.SZ' }), { code: 'ATTRIBUTION_BUSY', status: 429 });
  assert.equal(f.jobs.size, 1); gate.resolve(); await completed(f, first.jobId);
  const other = await f.service.start({ ticker: '002920.SZ' }); await completed(f, other.jobId);
  assert.equal(f.calls.length, 6); assert.ok(f.calls.slice(3).every(call => call.snapshot.adjustment === 'qfq' && call.snapshot.benchmark.system === 'SW2021'));
});

test('后台任务状态只读，运行中GET不会重新研究；完成后报告按行情指纹变陈旧', async t => {
  const gate = deferred(), f = fixture(t, { gate }), started = await f.service.start({ ticker });
  await until(() => f.calls.length === 1);
  assert.equal((await f.service.getJob(started.jobId)).status, 'running');
  assert.equal((await f.service.get({ ticker })).job.jobId, started.jobId); assert.equal(f.calls.length, 1);
  gate.resolve(); await completed(f, started.jobId);
  const before = await f.service.get({ ticker }); assert.equal(before.periods['1m'].freshness, 'fresh');
  f.priceChange = 1; const after = await f.service.get({ ticker });
  assert.ok(Object.values(after.periods).every(item => item.freshness === 'stale'));
  assert.equal(after.periods['1m'].report.stockReturn, before.periods['1m'].report.stockReturn);
  assert.notEqual(after.periods['1m'].currentMetrics.stockReturn, before.periods['1m'].report.stockReturn); assert.equal(f.calls.length, 3);
});

test('周末asOf变化但实际共同日线未变时不反复标记待更新', async t => {
  const f = fixture(t, { now: '2026-10-24T02:00:00.000Z', prices: params => prices(params, 0, ['2026-10-01', '2026-10-15', '2026-10-23']) });
  const started = await f.service.start({ ticker }); await completed(f, started.jobId);
  const saturday = await f.service.get({ ticker }); assert.ok(Object.values(saturday.periods).every(item => item.freshness === 'fresh'));
  f.now = '2026-10-25T02:00:00.000Z';
  const sunday = await f.service.get({ ticker }); assert.equal(sunday.requestedAsOf, '2026-10-25');
  assert.ok(Object.values(sunday.periods).every(item => item.freshness === 'fresh'));
  assert.equal(sunday.periods['1m'].report.requestedAsOf, '2026-10-24'); assert.equal(sunday.periods['1m'].report.to, '2026-10-23'); assert.equal(f.calls.length, 3);
});

test('历史GET只比较历史行情并标记historical，保留报告真实截止日', async t => {
  const f = fixture(t, { prices: params => prices(params, 0, [attributionWindow(params.asOf, params.period), '2026-09-10', params.asOf < '2026-10-19' ? params.asOf : '2026-10-19']) });
  const started = await f.service.start({ ticker }); await completed(f, started.jobId);
  const historical = await f.service.get({ ticker, asOf: '2026-09-20' });
  assert.equal(historical.historical, true); assert.equal(historical.requestedAsOf, '2026-09-20');
  assert.ok(Object.values(historical.periods).every(item => item.currentMetrics.to <= '2026-09-20'));
  assert.equal(historical.periods['1m'].report.requestedAsOf, '2026-10-20'); assert.equal(f.calls.length, 3);
  await assert.rejects(f.service.start({ ticker, asOf: '2026-09-20' }), { code: 'INVALID_ATTRIBUTION_INPUT' });
  assert.equal(f.calls.length, 3);
});

test('无共同日线不付费，单个周期缺数据标记失败但其他周期可生成', async t => {
  const unavailable = fixture(t, { prices: params => ({ ...prices(params), benchmark: { status: 'missing_prices' } }) });
  const empty = await unavailable.service.get({ ticker }); assert.ok(Object.values(empty.periods).every(item => item.freshness === 'unavailable' && item.currentMetrics === null));
  await assert.rejects(unavailable.service.start({ ticker }), { code: 'ATTRIBUTION_DATA_NOT_READY', status: 409 }); assert.equal(unavailable.calls.length, 0); assert.equal(unavailable.jobs.size, 0);
  const partial = fixture(t, { priceError: new ResearchError('ATTRIBUTION_NO_COMMON_DATA', '数据不足', 409), priceErrorPeriod: '6m' });
  const started = await partial.service.start({ ticker }); const finished = await completed(partial, started.jobId);
  assert.equal(finished.status, 'partial'); assert.equal(finished.periods['6m'].status, 'failed'); assert.deepEqual(partial.calls.map(call => call.snapshot.period), ['1m', '1y']);
});

test('行情或研究数据库不可用，或证券未知时在推理前失败', async t => {
  for (const options of [
    { priceError: databaseError(), priceErrorPeriod: '6m' }, { profileError: databaseError() }, { sweepError: databaseError() },
  ]) {
    const f = fixture(t, options); await assert.rejects(f.service.start({ ticker })); assert.equal(f.calls.length, 0); assert.equal(f.jobs.size, 0);
  }
  const unknown = fixture(t, { unknown: true }); await assert.rejects(unknown.service.start({ ticker }), { code: 'UNKNOWN_SECURITY', status: 404 }); assert.equal(unknown.calls.length, 0);
  const readFailure = fixture(t, { reportReadError: databaseError() }); await assert.rejects(readFailure.service.get({ ticker })); assert.equal(readFailure.calls.length, 0);
});

test('heartbeat失败后停止后续周期的付费研究，旧报告不受影响', async t => {
  const gate = deferred(), f = fixture(t, { gate, heartbeatMs: 50, heartbeatError: databaseError() });
  f.reports.set(ticker, { '1m': { summary: '原始报告' } });
  const started = await f.service.start({ ticker }); await until(() => f.calls.length === 1);
  await new Promise(resolve => setTimeout(resolve, 80)); assert.ok(f.heartbeats.length >= 1);
  gate.resolve(); await until(() => f.logs.some(entry => entry.type === 'attribution_task_interrupted'));
  assert.equal(f.calls.length, 1); assert.equal(f.saved.length, 0); assert.equal(f.reports.get(ticker)['1m'].summary, '原始报告');
  assert.equal(f.failures[0].error.code, 'ATTRIBUTION_DATABASE_UNAVAILABLE');
  assert.equal(f.jobs.get(started.jobId).periods['1m'].status, 'failed');
});

test('模型伪造数值或身份不能覆盖可信快照，敏感原始异常不会进入任务错误', async t => {
  const f = fixture(t, { research: async snapshot => researchResult(snapshot, { ticker: '600519.SH', companyName: '伪造主体', period: 'fake', requestedAsOf: '2099-01-01', from: '2099-01-01', to: '2099-02-01',
    stockReturn: 999, indexReturn: -999, excessPercentagePoints: 199800, adjustment: 'raw', currency: 'USD', inputHash: 'invented', benchmark: { system: 'fake' }, provider: 'invented', generatedAt: '2099-01-01T00:00:00Z', promptVersion: 'invented' }) });
  const started = await f.service.start({ ticker }); await completed(f, started.jobId);
  assert.equal(f.saved.length, 3);
  for (const saved of f.saved) {
    const expected = f.snapshots.get(started.jobId)[saved.period];
    for (const key of ['ticker', 'companyName', 'period', 'requestedAsOf', 'from', 'to', 'stockReturn', 'indexReturn', 'excessPercentagePoints', 'adjustment', 'currency', 'inputHash', 'benchmark']) assert.deepEqual(saved.report[key], expected[key]);
    assert.equal(saved.report.provider, 'deepseek'); assert.equal(saved.report.generatedAt, fixedNow); assert.equal(saved.report.promptVersion, f.service.promptVersion); assert.equal(Object.hasOwn(saved.report, 'series'), false);
  }
  const safe = attributionFailure(new Error('authorization=secret-token raw SQL /Users/private/config'));
  assert.equal(safe.code, 'ATTRIBUTION_GENERATION_FAILED'); assert.doesNotMatch(safe.message, /secret|SQL|Users/);
});

test('服务关闭等待已接受任务完成并阻止新任务，读取不会重新启动AI', async t => {
  const gate = deferred(), f = fixture(t, { gate }), started = await f.service.start({ ticker });
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  await assert.rejects(f.service.start({ ticker: '002920.SZ' }), { code: 'ATTRIBUTION_CLOSING', status: 503 });
  gate.resolve(); await closing; assert.equal(f.jobs.get(started.jobId).status, 'succeeded'); assert.equal(f.calls.length, 3);
  await f.service.get({ ticker }); assert.equal(f.calls.length, 3);
});

test('余额不足或凭据不可用时只尝试首周期，明确记录原因并停止后续请求', async t => {
  for (const [code,expected] of [['DEEPSEEK_INSUFFICIENT_BALANCE','ATTRIBUTION_INSUFFICIENT_BALANCE'],['DEEPSEEK_AUTH_ERROR','ATTRIBUTION_AI_NOT_AVAILABLE']]) {
    const f=fixture(t,{research:async()=>{throw new ResearchError(code,'原始上游消息不展示',502);}});
    const started=await f.service.start({ticker});await completed(f,started.jobId);
    assert.equal(f.calls.length,1);assert.equal(f.saved.length,0);assert.equal(f.jobs.get(started.jobId).status,'failed');
    assert.equal(f.failures.length,3);for(const failure of f.failures)assert.equal(failure.error.code,expected);
  }
});

test('网页搜索超时、连接中断和证据缺失分别呈现，不混同为没有新闻',()=>{
  assert.equal(attributionFailure(new ResearchError('DEEPSEEK_SEARCH_TIMEOUT','')).code,'ATTRIBUTION_TIMEOUT');
  assert.equal(attributionFailure(new ResearchError('DEEPSEEK_SEARCH_CONNECTION_ERROR','')).code,'ATTRIBUTION_NETWORK_ERROR');
  assert.equal(attributionFailure(new ResearchError('ATTRIBUTION_SOURCES_UNVERIFIED','')).code,'ATTRIBUTION_NEWS_UNAVAILABLE');
});

test('仅手动生成时补行业资料，GET和轮询不访问外部分类接口，新闻窗口遵守选择周期',async t=>{
  const calls=[],resolver={async resolve(params){calls.push(params);return {name:'软件服务',source:'eastmoney',known:true};}};
  const f=fixture(t,{sectorResolver:resolver});
  await f.service.get({ticker});assert.equal(calls.length,0);
  const started=await f.service.start({ticker,periods:['1m']});await completed(f,started.jobId);
  assert.equal(calls.length,1);assert.equal(f.calls[0].snapshot.sector.name,'软件服务');
  assert.equal(f.calls[0].snapshot.newsFrom,'2026-09-20');assert.equal(f.calls[0].snapshot.newsTo,'2026-10-19');
  await f.service.get({ticker});await f.service.getJob(started.jobId);assert.equal(calls.length,1);
});
