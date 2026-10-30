import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptRelations, assertRelationsContext } from '../frontend/src/features/relations-data.js';
import { createResearchService } from '../frontend/src/services/research-service.js';
import { endpoints } from '../frontend/src/api/endpoints.js';
import { adapters } from '../frontend/src/services/adapters.js';

const report = () => ({ ticker: '002920.SZ', asOf: '2026-10-15', relationAsOf: '2026-10-15', status: 'partial', subject: { name: '德赛西威', market: { close: 100, changePct: 0, tradeDate: '2026-10-14', valuationAsOf: '2026-10-14', peTtm: -2, pb: null, returns: { w1: 0 } } }, relations: [{ relatedTicker: '002906.SZ', relatedName: '华阳集团', relationType: 'peer', evidenceType: 'business_comparable', rationale: '汽车智能座舱业务可比', sources: [{ url: 'https://example.com/report.pdf', title: '公司报告', publishedAt: '2026-08-20', excerpt: '汽车电子业务相关段落', accessedAt: '2026-10-15T03:00:00Z', readingScope: 'partial_text' }], market: null }], gaps: ['上游待核实'] });

test('关系适配保留零收益、负PE及缺行情，计数按有效关系计算', () => {
  const raw = report(); raw.counts = { total: 10 };
  const data = adaptRelations({ data: raw });
  assert.deepEqual(data.counts, { upstream: 0, peer: 1, downstream: 0, total: 1 });
  assert.equal(data.missing, 0); assert.equal(data.meta.targetCount, 10); assert.equal(data.subject.market.returns.w1, 0); assert.equal(data.subject.market.peTtm, -2);
  assert.equal(data.relations[0].market, null); assert.equal(data.subject.market.returns.y3, null);
});

test('港股subject可读取有原文的A股和港股关系，subject无行情不借用同行价格', () => {
  const raw = report(); raw.ticker = '00700.HK'; raw.subject = { name: '腾讯控股', market: null };
  raw.relations[0].market = { close: 10, currency: 'CNY', tradeDate: '2026-10-14', returns: {} };
  const data = adaptRelations(raw);
  assert.equal(assertRelationsContext(data, { ticker: '00700.HK', asOf: raw.asOf }).ticker, '00700.HK');
  assert.equal(data.subject.market, null); assert.equal(data.relations[0].market.close, 10); assert.equal(data.relations[0].market.currency, 'CNY');
  raw.relations[0].relatedTicker = '02313.HK'; assert.equal(adaptRelations(raw).relations[0].relatedTicker, '02313.HK');
  raw.relations[0].relatedTicker = 'AAPL'; assert.throws(() => adaptRelations(raw));
  raw.relations[0].relatedTicker = '02313.HK';
  raw.ticker = '0700.HK'; assert.throws(() => adaptRelations(raw));
});

test('切公司及日期的异步结果必须与当前上下文相符', () => {
  const data = adaptRelations(report());
  assert.equal(assertRelationsContext(data, { ticker: '002920.SZ', asOf: '2026-10-15' }), data);
  assert.throws(() => assertRelationsContext(data, { ticker: '002906.SZ', asOf: '2026-10-15' }));
  assert.throws(() => assertRelationsContext(data, { ticker: '002920.SZ', asOf: '2026-10-14' }));
});

test('拒绝重复、自关联与角色错误；旧complete状态不再要求恰好10家', () => {
  for (const mutate of [p => p.relations.push(p.relations[0]), p => { p.relations[0].relatedTicker = p.ticker; }, p => { p.relations[0].evidenceType = 'direct_business'; }]) {
    const data = report(); mutate(data); assert.throws(() => adaptRelations(data));
  }
  const legacy = report(); legacy.status = 'complete';
  assert.equal(adaptRelations(legacy).counts.total, 1);
});

test('每股一份最多10家公司，按真实类别计数，拒绝超过10家的AI和人工结果', () => {
  const raw = report(), sample = raw.relations[0];
  raw.status = 'complete'; raw.meta = { relationSource: 'ai', targetCount: 10, manualRevision: '2' };
  raw.relations = Array.from({ length: 10 }, (_, index) => ({ ...sample, relatedTicker: `${600001 + index}.SH`,
    relationType: index < 4 ? 'upstream' : index < 7 ? 'peer' : 'downstream', evidenceType: index >= 4 && index < 7 ? 'business_comparable' : 'direct_business' }));
  const data = adaptRelations(raw);
  assert.deepEqual(data.counts, { upstream: 4, peer: 3, downstream: 3, total: 10 });
  assert.equal(data.missing, 0); assert.equal(data.meta.targetCount, 10); assert.equal(data.meta.relationSource, 'ai');
  raw.relations.push({ ...sample, relatedTicker: '601000.SH' });
  assert.throws(() => adaptRelations(raw));
  raw.status = 'customized'; assert.throws(() => adaptRelations(raw));
});

test('资料摘要与检索摘要可作为来源，A/H多代码归并后只计一家公司，重复别名仍被拒绝', () => {
  const raw = report();
  Object.assign(raw.relations[0], { relatedTicker: '601633.SH', relatedName: '长城汽车', alternateTickers: ['02333.HK'],
    verifiedAt: '2026-10-15T06:00:00Z', sources: [{ sourceId: 's1', url: 'https://example.com/gwm', title: '长城汽车业务资料',
      evidenceSummary: '公开资料显示相关智能汽车业务可比。', publishedAt: null, accessedAt: '2026-10-15T03:00:00Z', readingScope: 'search_snippet' }] });
  const data = adaptRelations(raw);
  assert.equal(data.counts.total, 1); assert.deepEqual(data.relations[0].alternateTickers, ['02333.HK']);
  assert.equal(data.relations[0].sources[0].excerpt, ''); assert.match(data.relations[0].sources[0].evidenceSummary, /业务可比/);
  const duplicate = structuredClone(raw); duplicate.relations.push({ ...raw.relations[0], relatedTicker: '02333.HK', alternateTickers: [] });
  assert.throws(() => adaptRelations(duplicate));
  const emptySource = structuredClone(raw); delete emptySource.relations[0].sources[0].evidenceSummary;
  assert.throws(() => adaptRelations(emptySource));
});

test('拒绝未来研究、未来来源、跨日估值和字符串数值', () => {
  for (const mutate of [p => { p.relationAsOf = '2026-10-16'; }, p => { p.relations[0].sources[0].publishedAt = '2026-10-16'; }, p => { p.subject.market.valuationAsOf = '2026-10-13'; }, p => { p.subject.market.close = '100'; }]) {
    const data = report(); mutate(data); assert.throws(() => adaptRelations(data));
  }
});

test('空关系保留未研究和截止日前不可用的真实状态；GET仅读取保存内容', async () => {
  const requests = [];
  const empty = { ...report(), relationAsOf: null, status: 'not_available_as_of', relations: [] };
  const service = createResearchService({ config: { enabled: true }, routes: endpoints, mappers: adapters, client: { get: async (path, options) => { requests.push({ path, query: options.query }); return { data: empty }; } } });
  const result = await service.load('relations', { ticker: '002920.SZ', asOf: '2026-10-15' });
  assert.equal(result.status, 'empty'); assert.equal(result.data.status, 'not_available_as_of');
  assert.deepEqual(requests, [{ path: '/api/relations', query: { ticker: '002920.SZ', asOf: '2026-10-15' } }]);
});

test('人工关系可为 A 股或港股、空备注和无原文，自定义列表可为空但仍最多10家', () => {
  const raw = report(); raw.status = 'customized';
  const manual = { relatedTicker: '02313.HK', relatedName: '申洲国际', relationType: 'upstream', evidenceType: 'manual', origin: 'manual', rationale: '',
    manualUpdatedAt: '2026-10-19T06:00:00Z', manualEffectiveDate: '2026-10-15', sources: [], market: null };
  raw.relations = [manual]; raw.meta = { manualRevision: '4', hasManualChanges: true, removedRelations: [] };
  let data = adaptRelations(raw);
  assert.equal(data.relations[0].rationale, ''); assert.equal(data.relations[0].evidenceType, 'manual'); assert.equal(data.meta.manualRevision, '4');
  raw.relations = Array.from({ length: 10 }, (_, index) => ({ ...manual, relatedTicker: `${String(600000 + index)}.SH`, relatedName: `人工公司 ${index}` }));
  data = adaptRelations(raw); assert.equal(data.counts.total, 10); assert.equal(data.missing, 0);
  raw.relations = []; data = adaptRelations(raw); assert.equal(data.counts.total, 0); assert.equal(data.status, 'customized');
  raw.meta.removedRelations = [{ relatedTicker: '02313.HK', relatedName: '申洲国际', relationType: null }];
  assert.equal(adaptRelations(raw).meta.removedRelations[0].relationType, null);
});

test('人工修改标志必须与真实时间、无原文一致，拒绝重复和自关联移除记录', () => {
  const raw = report(); raw.status = 'customized';
  raw.relations[0] = { ...raw.relations[0], evidenceType: 'manual', origin: 'manual', sources: [], manualUpdatedAt: '2026-10-19T06:00:00Z', manualEffectiveDate: '2026-10-15' };
  assert.equal(adaptRelations(raw).relations[0].manualEffectiveDate, '2026-10-15');
  for (const change of [item => { item.origin = 'ai'; }, item => { item.manualUpdatedAt = 'invalid'; }, item => { item.sources = report().relations[0].sources; }, item => { item.manualEffectiveDate = '2026-10-16'; }, item => { item.manualEffectiveDate = 'invalid'; }]) {
    const copy = structuredClone(raw); change(copy.relations[0]); assert.throws(() => adaptRelations(copy));
  }
  assert.throws(() => adaptRelations({ ...raw, meta: { manualRevision: 'not-a-revision' } }));
  for (const removed of [[{ relatedTicker: raw.ticker }], [{ relatedTicker: raw.relations[0].relatedTicker }], [{ relatedTicker: '02313.HK' }, { relatedTicker: '02313.HK' }]]) {
    assert.throws(() => adaptRelations({ ...raw, meta: { removedRelations: removed, manualRevision: '2' } }));
  }
});

test('人工保存通过专用 POST 路径提交数据库变更与 revision，不携带伪造来源和公司名称', async () => {
  const calls = [];
  const service = createResearchService({ config: { enabled: true }, routes: endpoints, mappers: adapters, client: { post: async (path, options) => { calls.push({ path, body: options.body }); return { data: { revision: '3' } }; } } });
  await service.saveRelationsManual({ ticker: '002920.SZ', asOf: '2026-10-15', expectedRevision: '2', changes: [
    { action: 'upsert', relatedTicker: '02313.HK', relationType: 'peer', rationale: '人工备注', relatedName: '不应传输', sources: ['fake'] },
    { action: 'remove', relatedTicker: '002906.SZ', relationType: 'upstream' },
    { action: 'restore', relatedTicker: '600000.SH' },
  ] });
  assert.deepEqual(calls, [{ path: '/api/relations/manual', body: { ticker: '002920.SZ', asOf: '2026-10-15', expectedRevision: '2', changes: [
    { action: 'upsert', relatedTicker: '02313.HK', relationType: 'peer', rationale: '人工备注' }, { action: 'remove', relatedTicker: '002906.SZ' }, { action: 'restore', relatedTicker: '600000.SH' },
  ] } }]);
});
