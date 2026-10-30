import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseEvidenceArgs, runEvidenceCommand } from '../scripts/relations-evidence.mjs';

const meta = { runId: 'cache-test', asOf: '2025-01-01', methodVersion: 'a-relations-v1' };
const token = '11111111-1111-4111-8111-111111111111';
const source = (suffix, excerpt = '示例业务正文。') => ({
  url: `https://example.com/${suffix}`, title: `Example ${suffix}`, publishedAt: '2024-12-31',
  excerpt, accessedAt: '2025-01-02T08:30:00+08:00', readingScope: 'partial_text',
});
const relation = (relatedTicker = '000002.SZ', relatedName = '乙公司') => ({
  relatedTicker, relatedName, relationType: 'peer', evidenceType: 'business_comparable',
  rationale: '两家公司披露的示例产品具有业务可比性。', actualEntity: relatedName,
  listedMappingBasis: '示例上市主体自身业务。', notes: '测试数据，不表示真实企业关系。',
});
async function json(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relations-evidence-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, meta.runId);
  for (const name of ['research', 'imports', 'claims']) await mkdir(join(directory, name), { recursive: true });
  await json(join(directory, 'universe.json'), { ...meta, securities: [
    { ts_code: '000001.SZ', name: '甲公司' }, { ts_code: '000002.SZ', name: '乙公司' }, { ts_code: '000003.SZ', name: '丙公司' },
  ] });
  const original = { ...meta, ticker: '000001.SZ', researchedAt: '2025-01-02T09:00:00+08:00',
    leaseToken: token, relations: [{ ...relation(), sources: [source('subject'), source('counterpart', '示例产品制造与服务。'.repeat(100))] }], gaps: ['尚未研究其余公司。'] };
  await json(join(directory, 'research', `${original.ticker}.json`), original);
  await json(join(directory, 'imports', `${original.ticker}.json`), { runId: meta.runId, ticker: original.ticker,
    status: 'partial', relationCount: 1, payloadHash: createHash('sha256').update(JSON.stringify(original)).digest('hex') });
  await json(join(directory, 'claims', 'original.json'), { runId: meta.runId, jobs: [
    { ...meta, ticker: '000002.SZ', name: '乙公司', leaseToken: token, leaseOwner: 'original-worker' },
  ] });
  const logs = [], errors = [];
  const run = argv => runEvidenceCommand({ storageRoot: root, argv, log: value => logs.push(value), errorLog: value => errors.push(value) });
  const args = (mode, extra = []) => ['--mode', mode, '--run-id', meta.runId, ...extra];
  return { root, directory, logs, errors, run, args, original };
}

async function draftFixture(t) {
  const f = await fixture(t);
  assert.equal(await f.run(f.args('index')), 0);
  const catalog = JSON.parse(await readFile(join(f.directory, 'evidence', 'catalog.json'), 'utf8'));
  const sourceId = Object.entries(catalog.sources).find(([, value]) => value.url.endsWith('/counterpart'))[0];
  const draft = { ...meta, ticker: '000002.SZ', researchedAt: '2025-01-03T09:00:00+08:00', leaseToken: token,
    subjectSourceIds: ['new-subject'], newSources: { 'new-subject': source('new-subject') },
    relations: [{ ...relation('000003.SZ', '丙公司'), sourceIds: [sourceId] }], gaps: ['尚未补齐十家。'] };
  await json(join(f.directory, 'compact.json'), draft);
  return { ...f, draft, composeArgs: f.args('compose', ['--file', 'compact.json', '--claim', 'claims/original.json']) };
}

test('index, bounded find, and compose operate on local files and preserve original evidence times', async t => {
  const f = await draftFixture(t);
  assert.deepEqual(f.logs[0], { type: 'relations_evidence_indexed', runId: meta.runId, evidenceCount: 2, indexedResearchCount: 1 });
  assert.equal(await f.run(f.args('find', ['--ticker', '000001.sz', '--query', 'counterpart', '--limit', '1'])), 0);
  const found = f.logs.at(-1);
  assert.equal(found.count, 1); assert.equal(found.hits.length, 1);
  assert.ok(Array.from(found.hits[0].excerpt).length <= 350);
  assert.match(found.message, /仍须核对/);
  assert.ok(JSON.stringify(found).length < 2000);
  assert.equal(found.sources, undefined);
  assert.equal(await f.run(f.composeArgs), 0);
  const output = join(f.directory, 'research', '000002.SZ.json');
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.researchedAt, f.draft.researchedAt);
  assert.equal(result.leaseToken, token);
  assert.equal(result.newSources, undefined); assert.equal(result.subjectSourceIds, undefined);
  assert.equal(result.relations[0].sourceIds, undefined);
  assert.equal(result.relations[0].sources.length, 2);
  assert.ok(result.relations[0].sources.every(item => item.accessedAt === source('x').accessedAt));
  assert.equal(f.logs.at(-1).output, output);
  assert.equal(f.logs.at(-1).relations, undefined);
  assert.equal(await readFile(join(f.directory, 'research', '000001.SZ.json'), 'utf8'), `${JSON.stringify(f.original, null, 2)}\n`);
  assert.ok((await readdir(join(f.directory, 'research'))).every(name => !name.endsWith('.tmp') && !name.endsWith('.lock')));
});

test('compose permits identical replay and explicit output, blocks stale or equal-time changes, and accepts newer research', async t => {
  const f = await draftFixture(t);
  const args = [...f.composeArgs, '--out', 'review/selected.json'];
  assert.equal(await f.run(args), 0);
  const path = join(f.directory, 'review', 'selected.json');
  const saved = await readFile(path, 'utf8');
  assert.equal(await f.run(args), 0); assert.equal(f.logs.at(-1).written, false);
  for (const researchedAt of ['2025-01-02T09:00:00+08:00', f.draft.researchedAt]) {
    const changed = structuredClone(f.draft); changed.researchedAt = researchedAt;
    changed.relations[0].rationale = '不同的示例业务理由。';
    await json(join(f.directory, 'compact.json'), changed);
    assert.equal(await f.run(args), 1); assert.equal(f.errors.at(-1).code, 'STALE_CACHE');
    assert.equal(await readFile(path, 'utf8'), saved);
  }
  const newer = structuredClone(f.draft); newer.researchedAt = '2025-01-04T09:00:00+08:00';
  newer.relations[0].rationale = '较新的示例核验结果。';
  await json(join(f.directory, 'compact.json'), newer);
  assert.equal(await f.run(args), 0);
  const result = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(result.researchedAt, newer.researchedAt);
  assert.equal(result.relations[0].rationale, newer.relations[0].rationale);
  assert.equal(result.relations[0].sources[0].accessedAt, source('x').accessedAt);
});

test('bad mode arguments and missing or mismatched original leases fail without borrowing metadata', async t => {
  const f = await draftFixture(t);
  for (const args of [[], ['--mode', 'index', '--run-id', '../other'],
    f.args('find', ['--limit', '0']), f.args('index', ['--out', 'bad.json']),
    f.args('compose', ['--file', 'compact.json']), f.args('index', ['--run-id', 'duplicate'])]) {
    assert.throws(() => parseEvidenceArgs(args), { code: 'VALIDATION_ERROR' });
    assert.equal(await f.run(args), 1); assert.equal(f.errors.at(-1).stage, 'arguments');
  }
  const withoutToken = structuredClone(f.draft); delete withoutToken.leaseToken;
  await json(join(f.directory, 'compact.json'), withoutToken);
  assert.equal(await f.run(f.composeArgs), 1);
  const mismatched = structuredClone(f.draft); mismatched.leaseToken = '22222222-2222-4222-8222-222222222222';
  await json(join(f.directory, 'compact.json'), mismatched);
  assert.equal(await f.run(f.composeArgs), 1);
  await assert.rejects(readFile(join(f.directory, 'research', '000002.SZ.json')), { code: 'ENOENT' });
});

test('errors stay compact and do not expose malformed input or environment-style secrets', async t => {
  const f = await draftFixture(t);
  await writeFile(join(f.directory, 'compact.json'), '{"private":"postgres://private-user:private-password@host", bad json');
  assert.equal(await f.run(f.composeArgs), 1);
  const printed = JSON.stringify(f.errors);
  assert.doesNotMatch(printed, /private-password|private-user|postgres:\/\//);
  assert.ok(printed.length < 500);
});

test('find bounds metadata and occurrence hints without changing complete catalog evidence', async t => {
  const f = await draftFixture(t);
  const path = join(f.directory, 'evidence', 'catalog.json');
  const catalog = JSON.parse(await readFile(path, 'utf8'));
  const id = Object.keys(catalog.sources)[0], item = catalog.sources[id];
  item.url = `https://example.com/${'long-path/'.repeat(50)}`;
  item.title = '示例证据标题'.repeat(50);
  item.occurrences = Array.from({ length: 30 }, (_, i) => ({ ticker: '000001.SZ', relatedTicker: '000002.SZ', payloadHash: String(i).padStart(64, '0') }));
  await json(path, catalog);
  const original = await readFile(path, 'utf8');
  assert.equal(await f.run(f.args('find', ['--query', 'long-path', '--limit', '1'])), 0);
  const hit = f.logs.at(-1).hits[0];
  assert.equal(Array.from(hit.url).length, 240); assert.equal(hit.urlTruncated, true);
  assert.equal(Array.from(hit.title).length, 160); assert.equal(hit.titleTruncated, true);
  assert.equal(hit.occurrenceCount, 30); assert.equal(hit.occurrences.length, 2);
  assert.deepEqual(Object.keys(hit.occurrences[0]).sort(), ['relatedTicker', 'ticker']);
  assert.equal(hit.sourceId, id);
  assert.ok(JSON.stringify(hit).length < 1500);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(catalog.sources[id].occurrences.length, 30);
  assert.ok(catalog.sources[id].occurrences[0].payloadHash);
});


test('evidence CLI accepts HK subject lookup and composition with its original lease', async t => {
  const f = await draftFixture(t);
  const manifest = JSON.parse(await readFile(join(f.directory, 'universe.json'), 'utf8'));
  manifest.securities.push({ ts_code: '00700.HK', name: '腾讯控股', isSubject: true });
  await json(join(f.directory, 'universe.json'), manifest);
  const draft = { ...f.draft, ticker: '00700.HK' };
  await json(join(f.directory, 'compact.json'), draft);
  await json(join(f.directory, 'claims', 'original.json'), { runId: meta.runId, jobs: [{ ...meta, ticker: '00700.HK', name: '腾讯控股', leaseToken: token }] });
  assert.deepEqual(parseEvidenceArgs(f.args('find', ['--ticker', '00700.hk'])).ticker, '00700.HK');
  assert.equal(await f.run(f.composeArgs), 0);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'research', '00700.HK.json'), 'utf8')).ticker, '00700.HK');
});
