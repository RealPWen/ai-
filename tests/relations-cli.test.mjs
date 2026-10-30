import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRelationArgs, runRelationsCommand } from '../scripts/sync-relations.mjs';

const today = '2026-10-15';
test('relations CLI locks mode-specific arguments and uses Shanghai cutoff defaults', () => {
  const options = parseRelationArgs(['--mode', 'init'], today);
  assert.equal(options.runId, 'relations-a-20261015-v1');
  assert.equal(options.asOf, today);
  const claim = parseRelationArgs(['--mode', 'claim', '--run-id', 'r1', '--worker', 'worker-1', '--tickers', '000001.sz,600519.sh'], today);
  assert.deepEqual(claim.tickers, ['000001.SZ', '600519.SH']);
  assert.equal(claim.limit, 10); assert.equal(claim.leaseMinutes, 30);
  for (const args of [[], ['--mode', 'init', '--as-of', '2026-10-16'], ['--mode', 'init', '--as-of', '2026-02-30'],
    ['--mode', 'status', '--run-id', '../../secrets'], ['--mode', 'status', '--run-id', 'r1', '--file', 'x'],
    ['--mode', 'claim', '--run-id', 'r1'], ['--mode', 'claim', '--run-id', 'r1', '--worker', 'w', '--limit', '0'],
    ['--mode', 'claim', '--run-id', 'r1', '--worker', 'w', '--tickers', '700.HK'],
    ['--mode', 'claim', '--run-id', 'r1', '--worker', 'w', '--tickers', '000001.SZ,000001.SZ'],
    ['--mode', 'import'], ['--mode', 'status', '--run-id', 'r1', '--run-id', 'r2']]) {
    assert.throws(() => parseRelationArgs(args, today), { code: 'VALIDATION_ERROR' });
  }
});

test('help and invalid arguments do not open a database or invoke a model', async () => {
  const logs = [], errors = [];
  const storeFactory = () => { throw new Error('must not run'); };
  assert.equal(await runRelationsCommand({ argv: ['--help'], storeFactory, log: v => logs.push(v), errorLog: v => errors.push(v), today }), 0);
  assert.match(logs[0].message, /不会调用模型/);
  assert.equal(await runRelationsCommand({ argv: ['--mode', 'bad'], storeFactory, errorLog: v => errors.push(v), today }), 1);
  assert.equal(errors[0].stage, 'arguments');
});

test('init writes frozen manifest and claim persists only the returned lease batch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relations-cli-'));
  const logs = [], calls = [];
  const securities = [{ ts_code: '000001.SZ', name: '平安银行', industry: '银行' }];
  const store = { async migrate() { calls.push('migrate'); }, async initRun(options) { calls.push(options); return { securitiesCount: 1 }; },
    async listSecurities() { return securities; }, async claimJobs(options) { calls.push(options); return [{ ticker: '000001.SZ', leaseOwner: options.workerId }]; }, async close() { calls.push('close'); } };
  try {
    const deps = { storeFactory: () => store, storageRoot: directory, log: v => logs.push(v), today };
    assert.equal(await runRelationsCommand({ ...deps, argv: ['--mode', 'init', '--run-id', 'r1'] }), 0);
    const manifest = JSON.parse(await readFile(join(directory, 'r1', 'universe.json'), 'utf8'));
    assert.deepEqual(manifest.securities, securities); assert.match(manifest.universeHash, /^[a-f0-9]{64}$/);
    assert.equal(await runRelationsCommand({ ...deps, argv: ['--mode', 'claim', '--run-id', 'r1', '--worker', 'w'] }), 0);
    const claim = JSON.parse(await readFile(join(directory, 'r1', 'claims', 'w.json'), 'utf8'));
    assert.deepEqual(claim.jobs, [{ ticker: '000001.SZ', leaseOwner: 'w' }]);
    assert.equal(calls.filter(c => c === 'close').length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('import checks cache identity before database access and records the imported result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relations-cli-'));
  const file = join(directory, 'research.json'); const payload = { runId: 'r1', ticker: '000001.SZ', relations: [] };
  const calls = [], errors = [];
  const store = { async migrate() {}, async importResearch(value, options) { calls.push({ value, options }); return { ticker: value.ticker, relationCount: 3, status: 'partial' }; }, async close() {} };
  try {
    await writeFile(file, JSON.stringify(payload));
    const deps = { storageRoot: directory, errorLog: v => errors.push(v), log() {}, today };
    assert.equal(await runRelationsCommand({ ...deps, argv: ['--mode', 'import', '--file', file, '--run-id', 'wrong'], storeFactory() { throw new Error('must not run'); } }), 1);
    assert.equal(errors[0].stage, 'read_cache');
    assert.equal(await runRelationsCommand({ ...deps, argv: ['--mode', 'import', '--file', file, '--worker', 'w'], storeFactory: () => store }), 0);
    assert.deepEqual(calls[0], { value: payload, options: { workerId: 'w' } });
    const receipt = JSON.parse(await readFile(join(directory, 'r1', 'imports', '000001.SZ.json'), 'utf8'));
    assert.equal(receipt.relationCount, 3); assert.match(receipt.payloadHash, /^[a-f0-9]{64}$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('status is read only and limits detail output; raw database diagnostics never enter logs', async () => {
  const logs = [], errors = [];
  const stocks = Array.from({ length: 25 }, (_, i) => ({ ticker: String(i), status: 'partial', gaps: ['不足'] }));
  const store = { async migrate() { throw new Error('read-only status must not migrate'); }, async status(options) { assert.equal(options.includeStocks, true); return { totals: { stocks: 25 }, stocks, gaps: stocks }; }, async close() {} };
  assert.equal(await runRelationsCommand({ argv: ['--mode', 'status', '--run-id', 'r1'], storeFactory: () => store, log: v => logs.push(v), today }), 0);
  assert.equal(logs[0].stocks.length, 10); assert.equal(logs[0].gaps.length, 10); assert.equal(logs[0].stockDetailsTruncated, true);
  const badStore = { async status() { throw Object.assign(new Error('postgres://user:private-password@host'), { code: '08006' }); }, async close() {} };
  assert.equal(await runRelationsCommand({ argv: ['--mode', 'status', '--run-id', 'r1'], storeFactory: () => badStore, errorLog: v => errors.push(v), today }), 1);
  assert.doesNotMatch(JSON.stringify(errors), /private-password|postgres:\/\//);
});

test('import preserves the original research timestamp and lease generation instead of borrowing a newer claim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relations-cli-'));
  const file = join(directory, 'research.json');
  const payload = { runId: 'r1', ticker: '000001.SZ', researchedAt: '2026-10-15T03:00:00Z', leaseToken: 'original-generation', relations: [] };
  const calls = [], errors = [];
  const store = { async migrate() {}, async importResearch(value, options) { calls.push({ value, options }); return { ticker: value.ticker, relationCount: 0, status: 'pending' }; }, async close() {} };
  try {
    await writeFile(file, JSON.stringify(payload));
    const deps = { storageRoot: directory, storeFactory: () => store, log() {}, errorLog: v => errors.push(v), today };
    assert.equal(await runRelationsCommand({ ...deps, argv: ['--mode', 'import', '--file', file, '--worker', 'w'] }), 0);
    assert.equal(calls[0].value.researchedAt, payload.researchedAt);
    assert.equal(calls[0].options.leaseToken, 'original-generation');
    assert.equal(await runRelationsCommand({ ...deps, argv: ['--mode', 'import', '--file', file, '--worker', 'w', '--lease-token', 'new-generation'] }), 1);
    assert.equal(calls.length, 1); assert.equal(errors[0].stage, 'read_cache');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('scoped init reads validated subjects before DB access and writes their frozen manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relations-scope-cli-'));
  const file = join(directory, 'subjects.json'), calls = [], errors = [];
  const subjects = [{ ticker: '00700.HK', name: '腾讯控股' }, { ticker: '000001.SZ', name: '平安银行' }];
  const store = { async migrate() {}, async initRun(options) { calls.push(options); return { securitiesCount: 3 }; }, async listSecurities() { return [{ ts_code: '00700.HK', name: '腾讯控股', isSubject: true }]; }, async close() {} };
  try {
    await writeFile(file, JSON.stringify(subjects));
    const deps = { storageRoot: directory, today, log() {}, errorLog: value => errors.push(value) };
    assert.equal(await runRelationsCommand({ ...deps, argv: ['--mode', 'init', '--run-id', 'scope1', '--subjects-file', file], storeFactory: () => store }), 0);
    assert.deepEqual(calls[0].subjects, [...subjects].reverse());
    const manifest = JSON.parse(await readFile(join(directory, 'scope1', 'universe.json'), 'utf8'));
    assert.deepEqual(manifest.subjects, calls[0].subjects);
    await writeFile(file, JSON.stringify([subjects[0], subjects[0]]));
    assert.equal(await runRelationsCommand({ ...deps, argv: ['--mode', 'init', '--subjects-file', file], storeFactory() { throw new Error('must not open DB'); } }), 1);
    assert.equal(errors[0].stage, 'read_subjects');
    assert.deepEqual(parseRelationArgs(['--mode', 'claim', '--run-id', 'scope1', '--worker', 'w', '--tickers', '00700.hk'], today).tickers, ['00700.HK']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
