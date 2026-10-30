import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildEvidenceCatalog, searchEvidenceCatalog, composeResearchFromEvidence } from '../backend/market-data/relations-evidence.mjs';

const identity = { runId: 'evidence-test', asOf: '2026-10-15', methodVersion: 'a-relations-v1' };
const token = '966238d3-3a8e-4f3d-af73-4d85d19597ab';
const source = (overrides = {}) => ({ url: 'https://example.com/report.pdf', title: '上市公司年报', publishedAt: '2026-04-12', excerpt: '公司从事冰箱与冷柜研发、制造和销售。', accessedAt: '2026-10-14T11:00:00+08:00', readingScope: 'partial_text', ...overrides });
const relation = (overrides = {}) => ({ relatedTicker: '000002.SZ', relatedName: '公司二', relationType: 'peer', evidenceType: 'business_comparable', rationale: '双方披露的冰箱产品制造业务可比。', actualEntity: '公司二', listedMappingBasis: '上市公司本体业务。', notes: '仅比较冰箱业务。', sources: [source()], ...overrides });
const research = (overrides = {}) => ({ ...identity, ticker: '000001.SZ', researchedAt: '2026-10-14T12:00:00+08:00', leaseToken: token, relations: [relation()], gaps: [], ...overrides });
const universe = { ...identity, securities: [{ ts_code: '000001.SZ', name: '公司一' }, { ts_code: '000002.SZ', name: '公司二' }, { ts_code: '000003.SZ', name: '公司三' }] };
const claim = { runId: identity.runId, jobs: [{ ...identity, ticker: '000001.SZ', name: '公司一', leaseToken: token }] };
const digest = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relations-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const researchDirectory = join(root, 'research'), importsDirectory = join(root, 'imports');
  await Promise.all([mkdir(researchDirectory), mkdir(importsDirectory)]);
  return { ...identity, researchDirectory, importsDirectory };
}
async function cache(paths, payload, receipt = true) {
  await writeFile(join(paths.researchDirectory, `${payload.ticker}.json`), JSON.stringify(payload, null, 2));
  if (receipt) await writeFile(join(paths.importsDirectory, `${payload.ticker}.json`), JSON.stringify({ runId: payload.runId, ticker: payload.ticker, status: 'partial', relationCount: payload.relations.length, payloadHash: digest(payload), ...(typeof receipt === 'object' ? receipt : {}) }));
}
function draft(ids, overrides = {}) {
  const { sources, ...fields } = relation();
  return research({ subjectSourceIds: [ids[0]], relations: [{ ...fields, sourceIds: ids }], ...overrides });
}
async function oneCatalog(t) {
  const paths = await fixture(t);
  await cache(paths, research());
  const catalog = await buildEvidenceCatalog(paths);
  return { paths, catalog, ids: Object.keys(catalog.sources) };
}

test('catalog indexes only original payloads with matching successful import receipts', async t => {
  const paths = await fixture(t);
  await cache(paths, research());
  await cache(paths, research({ ticker: '000003.SZ' }), false);
  const changed = research({ ticker: '000004.SZ' });
  await cache(paths, changed);
  changed.relations[0].rationale = '导入后已变更，不能信任旧回执。';
  await writeFile(join(paths.researchDirectory, '000004.SZ.json'), JSON.stringify(changed));
  await cache(paths, research({ ticker: '000005.SZ' }), { status: 'failed' });
  await cache(paths, research({ ticker: '000006.SZ', runId: 'another-run' }));
  await cache(paths, research({ ticker: '000007.SZ' }), { ticker: '000008.SZ' });
  await cache(paths, research({ ticker: '000009.SZ', relations: [relation({ sources: [source({ publishedAt: '2026-10-16' })] })] }));
  const overlongTime = `2026-10-14T03:00:00.${'1'.repeat(100000)}Z`;
  await cache(paths, research({ ticker: '000011.SZ', relations: [relation({ sources: [source({ accessedAt: overlongTime })] })] }));
  await writeFile(join(paths.researchDirectory, '000010.SZ.json'), '{broken');
  const catalog = await buildEvidenceCatalog(paths);
  assert.equal(catalog.version, 1);
  assert.equal(catalog.indexedResearchCount, 1);
  assert.equal(Object.keys(catalog.sources).length, 1);
  const item = Object.values(catalog.sources)[0];
  assert.deepEqual(item.provenance, { ticker: '000001.SZ', relatedTicker: '000002.SZ', payloadHash: digest(research()) });
  assert.equal(item.accessedAt, source().accessedAt);
});

test('stable source IDs ignore reading time and dedup keeps the earliest original time and all occurrences', async t => {
  const paths = await fixture(t);
  await cache(paths, research({ relations: [relation({ sources: [source({ accessedAt: '2026-10-15T03:00:00Z' })] })] }));
  const first = await buildEvidenceCatalog(paths), id = Object.keys(first.sources)[0];
  const older = source({ accessedAt: '2026-10-13T10:00:00+08:00' });
  await cache(paths, research({ ticker: '000003.SZ', relations: [relation({ sources: [older, older] })] }));
  const catalog = await buildEvidenceCatalog(paths);
  assert.deepEqual(Object.keys(catalog.sources), [id]);
  assert.equal(catalog.sources[id].accessedAt, older.accessedAt);
  assert.equal(catalog.sources[id].occurrences.length, 2);
  assert.equal(catalog.sources[id].provenance.ticker, '000003.SZ');
  assert.equal(catalog.indexedResearchCount, 2);
  assert.deepEqual(await buildEvidenceCatalog(paths), catalog);
});

test('search is bounded and returns actual truncated text, original scope and discovery occurrences', async t => {
  const paths = await fixture(t);
  const sources = Array.from({ length: 12 }, (_, i) => source({ url: `https://example.com/${i}`, excerpt: `冰箱制造业务第${i}项的实际原文摘录。` }));
  await cache(paths, research({ relations: [relation({ sources })] }));
  const catalog = await buildEvidenceCatalog(paths);
  assert.equal(searchEvidenceCatalog(catalog).length, 8);
  const hits = searchEvidenceCatalog(catalog, { ticker: '000002.SZ', query: '冰箱 制造', limit: 2, maxExcerptChars: 6 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].excerpt, sources[0].excerpt.slice(0, 6));
  assert.equal(hits[0].readingScope, 'partial_text');
  assert.equal(hits[0].accessedAt, sources[0].accessedAt);
  assert.equal(hits[0].occurrences[0].ticker, '000001.SZ');
  assert.deepEqual(searchEvidenceCatalog(catalog, { ticker: '000003.SZ' }), []);
  assert.deepEqual(searchEvidenceCatalog(catalog, { query: '不存在的产品' }), []);
  for (const options of [{ limit: 0 }, { limit: 101 }, { maxExcerptChars: 0 }, { query: {} }]) assert.throws(() => searchEvidenceCatalog(catalog, options), { code: 'VALIDATION_ERROR' });
  hits[0].occurrences[0].ticker = 'edited';
  assert.equal(Object.values(catalog.sources)[0].occurrences[0].ticker, '000001.SZ');
  const dates = [null, '2026-04-12', '2026-08-28', '2026-08-28', null];
  const orderedSources = dates.map((publishedAt, index) => source({ url: `https://example.com/date-${index}`, publishedAt }));
  await cache(paths, research({ relations: [relation({ sources: orderedSources })] }));
  const dated = await buildEvidenceCatalog(paths);
  assert.deepEqual(searchEvidenceCatalog(dated, { limit: 1 }).map(hit => hit.url), [orderedSources[2].url]);
  assert.deepEqual(searchEvidenceCatalog(dated, { limit: 5 }).map(hit => hit.url), [2, 3, 1, 0, 4].map(index => orderedSources[index].url));
});

test('compose expands subject and relation refs as a union without refreshing evidence, research time or lease', async t => {
  const { catalog, ids } = await oneCatalog(t);
  const input = draft([ids[0], ids[0]]), before = structuredClone(input), catBefore = structuredClone(catalog);
  const result = composeResearchFromEvidence(input, catalog, { universe, claim });
  assert.deepEqual(result.relations[0].sources, [source()]);
  assert.equal(result.researchedAt, input.researchedAt);
  assert.equal(result.leaseToken, token);
  assert.equal(result.relations[0].rationale, input.relations[0].rationale);
  assert.ok(!Object.hasOwn(result, 'subjectSourceIds'));
  assert.ok(!Object.hasOwn(result.relations[0], 'sourceIds'));
  assert.ok(!Object.hasOwn(result.relations[0].sources[0], 'occurrences'));
  assert.deepEqual(input, before);
  assert.deepEqual(catalog, catBefore);
  assert.deepEqual(composeResearchFromEvidence(input, catalog, { universe: universe.securities, claim: claim.jobs[0] }), result);
});

test('new source dictionary is explicit, shared across relations and removed after expansion', async t => {
  const { catalog, ids } = await oneCatalog(t);
  const newSource = source({ url: 'https://example.com/new-company', title: '本轮新读的主体业务', accessedAt: '2026-10-14T11:30:00+08:00' });
  const input = draft(ids, { subjectSourceIds: ['subject'], newSources: { subject: newSource } });
  const result = composeResearchFromEvidence(input, catalog, { universe, claim });
  assert.deepEqual(result.relations[0].sources, [newSource, source()]);
  assert.ok(!Object.hasOwn(result, 'newSources'));
  assert.equal(Object.keys(catalog.sources).length, 1);
  assert.equal(composeResearchFromEvidence(draft(ids, { newSources: { [ids[0]]: source() } }), catalog).relations[0].sources.length, 1);
  assert.throws(() => composeResearchFromEvidence(draft(ids, { newSources: { [ids[0]]: newSource } }), catalog), /冲突/);
  for (const field of ['publishedAt', 'accessedAt', 'readingScope']) {
    const incomplete = { ...newSource }; delete incomplete[field];
    assert.throws(() => composeResearchFromEvidence(draft(['subject'], { newSources: { subject: incomplete } }), catalog), /显式提供/);
  }
  assert.throws(() => composeResearchFromEvidence(draft([...ids, 'bad-time'], { newSources: { 'bad-time': source({ accessedAt: 'bad' }) } }), catalog), /ISO 时间/);
  assert.throws(() => composeResearchFromEvidence(draft(['new'], { newSources: { new: source({ publishedAt: undefined }) } }), catalog), /发布日期或 null/);
  const overlongTime = `2026-10-14T03:00:00.${'1'.repeat(100000)}Z`;
  assert.throws(() => composeResearchFromEvidence(draft(['new'], { newSources: { new: source({ accessedAt: overlongTime }) } }), catalog), /不超过 64 字符/);
  assert.throws(() => composeResearchFromEvidence(draft(ids, { researchedAt: overlongTime }), catalog), /不超过 64 字符/);
  const tamperedCatalog = structuredClone(catalog);
  tamperedCatalog.sources[ids[0]].accessedAt = overlongTime;
  assert.throws(() => searchEvidenceCatalog(tamperedCatalog), /不超过 64 字符/);
  assert.throws(() => composeResearchFromEvidence(draft(ids), tamperedCatalog), /不超过 64 字符/);
});

test('compose rejects unknown refs, generation mismatches and missing verification metadata without borrowing a claim', async t => {
  const { catalog, ids } = await oneCatalog(t);
  assert.throws(() => composeResearchFromEvidence(draft(['unknown']), catalog), /未知来源/);
  for (const overrides of [{ runId: 'other' }, { asOf: '2026-10-14' }, { methodVersion: 'other' }]) assert.throws(() => composeResearchFromEvidence(draft(ids, overrides), catalog), /任务、截止日或方法版本/);
  for (const overrides of [{ researchedAt: undefined }, { leaseToken: undefined }, { leaseToken: 'new-generation' }]) assert.throws(() => composeResearchFromEvidence(draft(ids, overrides), catalog, { claim }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => composeResearchFromEvidence(draft(ids), catalog, { claim: { jobs: [{ ...claim.jobs[0], leaseToken: '00000000-0000-4000-8000-000000000000' }] } }), /代次/);
  assert.throws(() => composeResearchFromEvidence(draft(ids), catalog, { claim: { jobs: [{ ...claim.jobs[0], ticker: '000003.SZ' }] } }), /领取记录/);
  const secret = 'https://private:password@example.com';
  assert.throws(() => composeResearchFromEvidence(draft([secret]), catalog), error => error.code === 'VALIDATION_ERROR' && !error.message.includes(secret));
});

test('compose checks frozen membership/names and delegates future-date, self-link and duplicate validation', async t => {
  const { catalog, ids } = await oneCatalog(t);
  const input = draft(ids), row = input.relations[0];
  for (const change of [{ relatedName: '错误名称' }, { relatedTicker: '000099.SZ' }]) assert.throws(() => composeResearchFromEvidence({ ...input, relations: [{ ...row, ...change }] }, catalog, { universe }), /冻结清单|清单不符/);
  assert.throws(() => composeResearchFromEvidence(input, catalog, { universe: universe.securities.slice(1) }), /主体证券/);
  assert.throws(() => composeResearchFromEvidence(input, catalog, { universe: { ...universe, methodVersion: 'other' } }), /证券清单与研究任务/);
  assert.throws(() => composeResearchFromEvidence({ ...input, relations: [{ ...row, relatedTicker: input.ticker }] }, catalog), /自关联/);
  assert.throws(() => composeResearchFromEvidence({ ...input, relations: [row, row] }, catalog), /重复/);
  const future = source({ publishedAt: '2026-10-16' });
  assert.throws(() => composeResearchFromEvidence(draft(['new'], { subjectSourceIds: [], newSources: { new: future } }), catalog), /晚于研究截止日/);
  assert.throws(() => composeResearchFromEvidence(draft(['new'], { subjectSourceIds: [], newSources: { new: source({ accessedAt: 'bad' }) } }), catalog), /ISO 时间/);
});

test('missing research directory produces an empty generation-specific catalog', async t => {
  const paths = await fixture(t);
  const result = await buildEvidenceCatalog({ ...paths, researchDirectory: join(paths.researchDirectory, 'missing') });
  assert.deepEqual(result, { version: 1, ...identity, indexedResearchCount: 0, sources: {} });
});


test('HK imported caches can be indexed, found and composed without admitting HK counterparties', async t => {
  const paths = await fixture(t);
  await cache(paths, research({ ticker: '00700.HK' }));
  const catalog = await buildEvidenceCatalog(paths), ids = Object.keys(catalog.sources);
  assert.equal(catalog.indexedResearchCount, 1);
  assert.equal(searchEvidenceCatalog(catalog, { ticker: '00700.HK' }).length, 1);
  const input = draft(ids, { ticker: '00700.HK' });
  const hkUniverse = { ...universe, securities: [...universe.securities, { ts_code: '00700.HK', name: '腾讯控股', isSubject: true }] };
  const hkClaim = { ...claim, jobs: [{ ...claim.jobs[0], ticker: '00700.HK', name: '腾讯控股' }] };
  assert.equal(composeResearchFromEvidence(input, catalog, { universe: hkUniverse, claim: hkClaim }).ticker, '00700.HK');
  assert.throws(() => composeResearchFromEvidence({ ...input, relations: [{ ...input.relations[0], relatedTicker: '02313.HK' }] }, catalog), { code: 'VALIDATION_ERROR' });
  const candidateUniverse = { ...hkUniverse, securities: hkUniverse.securities.map(row => ({ ...row, isSubject: false })) };
  assert.throws(() => composeResearchFromEvidence(input, catalog, { universe: candidateUniverse, claim: hkClaim }), /不是本次研究主体/);
});
