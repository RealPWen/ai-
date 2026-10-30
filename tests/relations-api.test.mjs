import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchServer } from '../backend/app.mjs';
import { createRelationsReadService } from '../backend/market-data/relations-read-service.mjs';
import { ResearchError } from '../backend/src/errors.mjs';

async function fixture(t, relationsService) {
  let inferenceCalls = 0, authCalls = 0;
  const forbidden = () => { inferenceCalls += 1; throw new Error('unexpected inference'); };
  const server = createResearchServer({
    relationsService, health: { status: 'ok' }, service: { generate: forbidden, get: forbidden },
    chatClient: { probe: forbidden }, auth: { status() { authCalls += 1; throw new Error('unexpected auth'); } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, get inferenceCalls() { return inferenceCalls; }, get authCalls() { return authCalls; } };
}

test('relations GET forwards query parameters and needs neither ChatGPT nor login', async t => {
  const calls = [];
  const data = { ticker: '002920.SZ', name: '德赛西威', relations: [], meta: { relationCount: 0 } };
  const f = await fixture(t, { get: async params => { calls.push(params); return data; } });
  const response = await fetch(`${f.base}/api/relations?ticker=002920.SZ&asOf=2026-10-14`, { headers: { Origin: 'http://127.0.0.1:8765' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:8765');
  assert.deepEqual(await response.json(), { data });
  assert.deepEqual(calls, [{ ticker: '002920.SZ', asOf: '2026-10-14' }]);
  assert.equal(f.inferenceCalls, 0);
  assert.equal(f.authCalls, 0);
});

test('relations GET exposes verified partial database drafts with real counts instead of waiting for ten', async t => {
  let queries = 0;
  const relations = Array.from({ length: 7 }, (_, index) => ({
    relatedTicker: `${String(index + 1).padStart(6, '0')}.SZ`, relatedName: `供应链公司${index + 1}`,
    relationType: 'upstream', evidenceType: 'direct_business', rationale: '已核实供应关系',
    actualEntity: `供应链公司${index + 1}`, listedMappingBasis: '上市公司本体',
    verifiedAt: '2026-10-15T03:00:00Z',
    sources: [{ url: 'https://example.com/report', title: '公司公告', publishedAt: '2026-10-14' }],
  }));
  const relationsService = createRelationsReadService({ now: () => new Date('2026-10-15T05:00:00Z'), pool: {
    async query() {
      queries += 1;
      return { rows: queries === 1 ? [{
        subject_ticker: '601127.SH', subject_name: '赛力斯', known_ticker: '601127.SH',
        run_id: 'partial-20261015', relation_as_of: '2026-10-15', method_version: 'a-relations-v1',
        job_status: 'partial', published_relations: [], archived_relations: [], draft_relations: relations,
        gaps: ['同行和下游待补齐'], available_from: '2026-10-15', database_through: '2026-10-15',
      }] : [] };
    },
  } });
  const f = await fixture(t, relationsService);
  const response = await fetch(`${f.base}/api/relations?ticker=601127.SH&asOf=2026-10-15`);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.subject.name, '赛力斯');
  assert.equal(data.status, 'complete');
  assert.equal(data.meta.relationSource, 'draft');
  assert.deepEqual(data.counts, { upstream: 7, peer: 0, downstream: 0, total: 7 });
  assert.equal(data.missing, 0);
  assert.equal(data.meta.targetCount, null);
  assert.deepEqual(data.gaps, ['同行和下游待补齐']);
  assert.deepEqual(data.relations.map(row => row.relatedTicker), relations.map(row => row.relatedTicker));
  assert.equal(data.relations[0].market.close, null);
  assert.equal(queries, 2);
  assert.equal(f.inferenceCalls, 0);
  assert.equal(f.authCalls, 0);
});

test('relations CORS preflight allows GET without reading the database', async t => {
  let calls = 0;
  const f = await fixture(t, { get: async () => { calls += 1; throw new Error('unexpected database read'); } });
  const response = await fetch(`${f.base}/api/relations`, { method: 'OPTIONS', headers: {
    Origin: 'http://127.0.0.1:8765', 'Access-Control-Request-Method': 'GET',
  } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:8765');
  assert.match(response.headers.get('Access-Control-Allow-Methods'), /\bGET\b/);
  assert.equal(calls, 0);
  assert.equal(f.inferenceCalls, 0);
  assert.equal(f.authCalls, 0);
});

test('relations GET reports missing configuration as a safe 503', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/api/relations?ticker=002920.SZ`);
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json()).error, {
    code: 'RELATIONS_DATABASE_NOT_CONFIGURED', message: '公司关系数据库尚未配置',
  });
  assert.equal(f.inferenceCalls, 0);
  assert.equal(f.authCalls, 0);
});

test('relations GET preserves input and business error codes, messages, and statuses', async t => {
  for (const [code, message, status, ticker] of [
    ['INVALID_TICKER', '证券代码无效', 400, 'invalid'],
    ['MARKET_NOT_SUPPORTED', '港股关系暂未入库', 400, '02313.HK'],
    ['RELATIONS_NOT_FOUND', '该证券尚无关系研究', 404, '002920.SZ'],
  ]) {
    const f = await fixture(t, { get: async () => { throw new ResearchError(code, message, status); } });
    const response = await fetch(`${f.base}/api/relations?ticker=${ticker}`);
    assert.equal(response.status, status);
    assert.deepEqual((await response.json()).error, { code, message });
    assert.equal(f.inferenceCalls, 0);
    assert.equal(f.authCalls, 0);
  }
});

test('relations GET rejects invalid input before SQL and sanitizes database failures', async t => {
  let calls = 0;
  const relationsService = createRelationsReadService({ now: () => new Date('2026-10-14T01:00:00Z'), pool: {
    async query() { calls += 1; throw new Error('relation market_data.company_relation_jobs missing; postgresql://user:secret@localhost/research'); },
  } });
  const f = await fixture(t, relationsService);
  const invalid = await fetch(`${f.base}/api/relations?ticker=invalid`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_TICKER');
  assert.equal(calls, 0);
  const failed = await fetch(`${f.base}/api/relations?ticker=002920.SZ`);
  assert.equal(failed.status, 503);
  const body = await failed.text();
  assert.equal(JSON.parse(body).error.code, 'RELATIONS_DATABASE_UNAVAILABLE');
  assert.ok(!body.includes('postgresql'));
  assert.ok(!body.includes('company_relation_jobs'));
  assert.ok(!body.includes('secret'));
  assert.equal(calls, 1);
  assert.equal(f.inferenceCalls, 0);
  assert.equal(f.authCalls, 0);
});


test('relations GET serves local HK subject price changes and a verified A-share relation without inference', async t => {
  const calls = [];
  const relationsService = createRelationsReadService({ now: () => new Date('2026-10-19T05:00:00Z'), pool: {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: calls.length === 1 ? [{
        subject_ticker: '00700.HK', subject_name: '腾讯控股', known_ticker: null,
        run_id: 'scope-hk', relation_as_of: '2026-10-19', method_version: 'a-relations-v1',
        available_from: '2026-10-19', database_through: '2026-10-19', job_status: 'partial', gaps: [],
        published_relations: [{ relatedTicker: '002230.SZ', relatedName: '科大讯飞', relationType: 'peer', evidenceType: 'business_comparable', rationale: '测试业务比较', actualEntity: '科大讯飞', listedMappingBasis: '上市公司本体', verifiedAt: '2026-10-19T03:00:00Z', sources: [{ url: 'https://example.com/report', title: '正文', publishedAt: '2026-10-18' }] }],
      }] : [{
        ts_code: '00700.HK', market: 'HK', trade_date: '2026-10-16', close: '37.34', pct_chg: '-0.32',
        source: 'tencent', source_api: 'tencent_hk_daily', adj_factor: null,
        pe_ttm: '10.7', pb: '1.31', valuation_as_of: '2026-10-16', valuation_source: 'baidu', valuation_source_api: 'baidu_hk_valuation',
        period: 'w1', base_date: '2026-10-09', base_close: '40', base_factor: null,
      }] };
    },
  } });
  const f = await fixture(t, relationsService);
  const response = await fetch(`${f.base}/api/relations?ticker=00700.HK&asOf=2026-10-19`);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.subject.name, '腾讯控股');
  assert.equal(data.subject.market.currency, 'HKD');
  assert.equal(data.subject.market.close, 37.34);
  assert.equal(data.subject.market.tradeDate, '2026-10-16');
  assert.equal(data.subject.market.peTtm, 10.7);
  assert.equal(data.subject.market.pb, 1.31);
  assert.ok(Math.abs(data.subject.market.returns.w1 + 6.65) < 1e-10);
  assert.equal(data.subject.market.returnStatus.w1, 'available');
  assert.equal(data.subject.market.returnAdjustment, 'none');
  assert.match(data.subject.market.returnBasis, /未复权.*非投资总回报/);
  assert.equal(data.relations[0].relatedTicker, '002230.SZ');
  assert.deepEqual(calls[1].params[0], ['00700.HK', '002230.SZ']);
  assert.equal(f.inferenceCalls, 0);
  assert.equal(f.authCalls, 0);
});

test('relations GET returns only the one canonical current report without appending legacy companies', async t => {
  let queries = 0;
  const relation = (relatedTicker, relatedName) => ({
    relatedTicker, relatedName, relationType: 'downstream', evidenceType: 'direct_business',
    rationale: '已保存客户关系', verifiedAt: '2026-10-15T03:00:00Z',
    sources: [{ url: 'https://example.com/current', title: '公告', publishedAt: '2026-10-14' }],
  });
  const current = relation('000625.SZ', '长安汽车');
  const relationsService = createRelationsReadService({ now: () => new Date('2026-10-15T05:00:00Z'), pool: {
    async query() {
      queries += 1;
      return { rows: queries === 1 ? [{
        known_ticker: '002920.SZ', subject_name: '德赛西威', subject_ticker: '002920.SZ',
        run_id: 'old-research', relation_as_of: '2026-10-15', published_relations: [relation('002594.SZ', '比亚迪')],
        current_ticker: '002920.SZ', current_subject_name: '德赛西威', current_as_of: '2026-10-15',
        current_run_id: 'saved-current', current_source: 'ai', current_method_version: 'ah-relations-ai-v3',
        current_updated_at: '2026-10-15T03:00:00Z', current_relations: [current], current_gaps: [],
      }] : [] };
    },
  } });
  const f = await fixture(t, relationsService);
  const response = await fetch(`${f.base}/api/relations?ticker=002920.SZ&asOf=2026-10-15`);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.relations.map(row => row.relatedTicker), ['000625.SZ']);
  assert.equal(data.runId, 'saved-current');
  assert.equal(data.meta.storageMode, 'single_current');
  assert.equal(data.meta.updatedAt, '2026-10-15T03:00:00Z');
  assert.equal(queries, 2);
  assert.equal(f.inferenceCalls, 0);
  assert.equal(f.authCalls, 0);
});
