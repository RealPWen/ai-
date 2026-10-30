import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRelationsAiStore, validateRelationsAiResult } from '../backend/market-data/relations-ai-store.mjs';

const asOf = '2026-10-20', now = () => new Date('2026-10-20T03:05:00.000Z');
const researchedAt = '2026-10-20T03:04:05.000Z';
const candidates = [
  { ticker: '300750.SZ', name: '宁德时代', market: 'A' },
  { ticker: '00700.HK', name: '腾讯控股', market: 'HK' },
];
const source = overrides => ({ url: 'https://www.hkexnews.hk/listedco/listconews/sehk/2026/report.pdf', title: '公司公告',
  publishedAt: '2026-10-19', excerpt: '公司与相关企业开展业务合作。', accessedAt: '2026-10-20T03:00:00.000Z', readingScope: 'partial_text', ...overrides });
const relation = overrides => ({ relatedTicker: '00700.HK', relatedName: '腾讯控股', relationType: 'peer', evidenceType: 'business_comparable',
  rationale: '公开业务资料显示两公司在同类产品领域经营。', actualEntity: '腾讯控股有限公司', listedMappingBasis: '上市公司本体。', notes: '', sources: [source()], ...overrides });
const payload = overrides => ({ relations: [relation()], gaps: [], researchedAt, audit: { evidenceIds: ['evidence_1'] }, ...overrides });
const validate = value => validateRelationsAiResult(value, { ticker: '002920.SZ', asOf, candidates, now });
const invalid = error => error?.code === 'INVALID_AI_RELATIONS' && error.status === 400;

test('AI results accept current A/HK counterparts with canonical names and preserve auditable source fields', () => {
  const result = validate(payload({ relations: [relation({ sourceIds: ['evidence_1'], sources: [source({ sourceId: 'evidence_1' })] }),
    relation({ relatedTicker: '300750.SZ', relatedName: '宁德时代', relationType: 'upstream', evidenceType: 'direct_business' })] }));
  assert.deepEqual(result.relations.map(row => row.relatedTicker), ['00700.HK', '300750.SZ']);
  assert.deepEqual(result.relations.map(row => row.rank), [1, 2]);
  assert.ok(result.relations.every(row => row.verifiedAt === researchedAt));
  assert.equal(result.relations[0].sources[0].readingScope, 'partial_text');
  assert.equal(result.relations[0].sources[0].sourceId, 'evidence_1');
  assert.deepEqual(result.audit, { evidenceIds: ['evidence_1'] });
  assert.deepEqual(validate(payload({ relations: [], gaps: ['未找到可核验的业务关系。'] })).relations, []);
});

test('新闻归纳模式可保存检索摘要，无须伪造逐字摘录，来源仍绑定本次检索',()=>{
  const item=source({sourceId:'s1',readingScope:'search_snippet',sourceKind:'search_summary',evidenceSummary:'双方公开业务存在产品交集。'});delete item.excerpt;
  const audit={evidenceMode:'relation_summary',retrievalEvidence:{origin:'deepseek-search',evidenceMode:'relation_summary',sources:[{id:'s1',url:item.url,title:item.title,publishedAt:item.publishedAt,readingScope:item.readingScope}]}};
  const value=payload({relations:[relation({sources:[item]})],audit});
  const saved=validate(value);assert.equal(saved.relations[0].sources[0].evidenceSummary,item.evidenceSummary);assert.equal(saved.relations[0].sources[0].excerpt,undefined);
  for(const mutate of [v=>{v.relations[0].sources[0].url='https://www.hkexnews.hk/forged';},v=>{v.audit.retrievalEvidence.sources=[];},v=>{v.relations[0].sources[0].readingScope='partial_text';}]){
    const bad=structuredClone(value);mutate(bad);assert.throws(()=>validate(bad),invalid);
  }
});

test('每股当前报告最多10家，超过10家不能入库',()=>{
  const listed=Array.from({length:11},(_,i)=>({ticker:`${String(100000+i).padStart(6,'0')}.SZ`,name:`测试公司${i}`}));
  const entries=listed.map(row=>relation({relatedTicker:row.ticker,relatedName:row.name}));
  const context={ticker:'002920.SZ',asOf,candidates:listed,now};
  assert.equal(validateRelationsAiResult(payload({relations:entries.slice(0,10)}),context).relations.length,10);
  assert.throws(()=>validateRelationsAiResult(payload({relations:entries}),context),invalid);
});

test('AI result validation rejects non-listed markets, self-links, duplicates and invented security names', () => {
  for (const relations of [
    [relation({ relatedTicker: 'AAPL.US' })], [relation({ relatedTicker: '700.HK' })],
    [relation({ relatedTicker: '002920.SZ', relatedName: '德赛西威' })], [relation(), relation()],
    [relation({ relatedTicker: '09999.HK', relatedName: '无清单公司' })], [relation({ relatedName: '未经核对的集团名称' })],
    Array.from({ length: 11 }, () => relation()),
  ]) assert.throws(() => validate(payload({ relations })), invalid);
});

test('AI source validation enforces date cutoff, actual read scope and public credential-free URLs', () => {
  for (const change of [
    { publishedAt: '2026-10-21' }, { publishedAt: '2026-02-30' }, { readingScope: 'search_snippet' },
    { readingScope: undefined }, { excerpt: '' }, { accessedAt: '2026-10-20T04:00:00Z' },
    { url: 'http://localhost/private' }, { url: 'http://127.0.0.1/private' }, { url: 'http://2130706433/private' },
    { url: 'http://[::1]/private' }, { url: 'http://192.168.1.1/private' }, { url: 'https://foo.local/report' },
    { url: 'https://user:secret@www.hkexnews.hk/report' }, { url: 'file:///private/report' },
    { url: 'https://www.hkexnews.hk/report', injected: true },
  ]) assert.throws(() => validate(payload({ relations: [relation({ sources: [source(change)] })] })), invalid);
  assert.equal(validate(payload({ relations: [relation({ sources: [source({ publishedAt: null })] })] })).relations[0].sources[0].publishedAt, null);
});

test('AI result validation rejects mismatched classifications, fabricated timestamps and unsupported fields', () => {
  for (const change of [
    { relationType: 'peer', evidenceType: 'direct_business' }, { relationType: 'upstream', evidenceType: 'business_comparable' },
    { relationType: 'supplier' }, { verifiedAt: '2026-10-19T00:00:00Z' }, { rank: 9 },
    { sources: [] }, { rationale: '' }, { actualEntity: '' }, { listedMappingBasis: '' },
    { evidenceIds: ['e1', 'e1'] }, { confidence: 0.9 },
  ]) assert.throws(() => validate(payload({ relations: [relation(change)] })), invalid);
  for (const value of [payload({ researchedAt: '2026-10-21T00:00:00Z' }), payload({ researchedAt: '2026-10-20T24:00:00Z' }),
    payload({ researchedAt: '2026-02-30T00:00:00Z' }), payload({ gaps: [null] }), payload({ audit: [] }),
    payload({ surprise: true })]) assert.throws(() => validate(value), invalid);
});

test('AI store sanitizes driver errors before exposing responses and rejects input before DB access', async () => {
  const calls = [];
  const pool = { async query(sql, values) { calls.push({ sql, values }); throw new Error('postgres://user:secret@private-host/db'); }, async end() {} };
  const store = createRelationsAiStore({ pool, now });
  await assert.rejects(store.listCandidates({ ticker: '00700.HK', asOf }), error => error.code === 'RELATIONS_DATABASE_UNAVAILABLE' && !/secret|private-host|postgres/i.test(error.message));
  assert.equal(calls.length, 1);
  for (const input of [{ ticker: 'AAPL.US', asOf }, { ticker: '00700.HK', asOf: '2026-10-21' }, { ticker: '00700.HK', asOf, extra: true }]) {
    await assert.rejects(store.listCandidates(input), invalid);
  }
  assert.equal(calls.length, 1);
  await assert.rejects(store.expireStaleJobs({ olderThanMs: 1 }), invalid);
});

test('AI failure writes only fixed safe messages and migration never mutates old research or manual rows', async () => {
  const calls = [], id = '7a903e22-73cb-4862-9adf-a119ff5e1fca';
  const pool = { async query(sql, values) { calls.push({ sql, values }); return { rows: [{ job_id: id, as_of: asOf, status: 'failed' }] }; }, async end() {} };
  const store = createRelationsAiStore({ pool, now });
  await store.failJob({ jobId: id, errorCode: 'provider-response-with-secret', errorMessage: 'Bearer secret' });
  assert.equal(calls[0].values[1], 'RELATIONS_AI_FAILED');
  assert.equal(calls[0].values[2], 'AI 识别失败，请稍后重试。');
  assert.ok(!JSON.stringify(calls).includes('Bearer secret'));
  const sql = await readFile(new URL('../backend/market-data/relations-ai-schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /UNIQUE INDEX[\s\S]*WHERE status = 'running'/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ''), /(?:^|[;\n])\s*(?:DELETE|UPDATE|TRUNCATE|DROP TABLE)\b/i);
  const currentSql=await readFile(new URL('../backend/market-data/relations-current-schema.sql',import.meta.url),'utf8');
  assert.match(currentSql,/subject_ticker text PRIMARY KEY/);
  assert.match(currentSql,/jsonb_array_length\(relations\) BETWEEN 1 AND 10/);
  assert.doesNotMatch(sql, /REFERENCES market_data\.company_relation(?:s|_jobs|_runs|_manual)/);
});
