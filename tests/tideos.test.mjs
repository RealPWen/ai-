import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { dataRoot, PROJECT_ROOT, automaticUpdatesEnabled } from '../backend/src/runtime-config.mjs';
import { replaceFile } from '../backend/src/replace-file.mjs';
import { extractionEnvironment } from '../backend/src/ima-retriever.mjs';
import { createWatchlistAttributionRuntime } from '../backend/src/watchlist-attribution-runtime.mjs';
import { parseStage, runTideOS, exitCodeFor } from '../scripts/tideos-run.mjs';

test('TideOS overrides all automatic flags while local defaults remain enabled', () => {
  for (const key of ['MARKET_AUTO_UPDATE_ENABLED', 'WATCHLIST_ATTRIBUTION_AUTO_UPDATE_ENABLED', 'RELATION_ATTRIBUTION_AUTO_UPDATE_ENABLED']) {
    assert.equal(automaticUpdatesEnabled(key, {}), true);
    assert.equal(automaticUpdatesEnabled(key, { [key]: 'false' }), false);
    for (const mode of ['true', '1']) assert.equal(automaticUpdatesEnabled(key, { COMPANY_RESEARCH_TIDEOS: mode, [key]: 'true' }), false);
  }
});
test('data roots use a stable project base and accept external absolute directories', () => {
  assert.equal(dataRoot({}), resolve(PROJECT_ROOT, 'backend/storage'));
  assert.equal(dataRoot({ COMPANY_RESEARCH_DATA_ROOT: '../data_hub/company' }), resolve(PROJECT_ROOT, '../data_hub/company'));
  assert.equal(dataRoot({ COMPANY_RESEARCH_DATA_ROOT: ' /tmp/tideos-test ' }), resolve('/tmp/tideos-test'));
});
test('stage input is an exact whitelist with no extra commands or destructive init', () => {
  assert.equal(parseStage(['--check-only']), 'check');
  assert.equal(parseStage(['--stage', 'update']), 'update');
  for (const argv of [[], ['--stage', 'init'], ['--stage', 'update;echo secret'], ['--stage', 'update', '--fresh'], ['--check-only', '--stage', 'update']]) assert.throws(() => parseStage(argv));
});
test('check-only performs only the injected read-only database check', async () => {
  const logs = []; let checks = 0;
  const code = await runTideOS({ argv: ['--check-only'], env: { DATABASE_URL: 'mock-secret-dsn' }, log: row => logs.push(row), dependencies: {
    checkDatabase: async () => { checks++; return { status: 'succeeded' }; },
    createMarketUpdateRuntime: () => assert.fail('check must not collect'), createAttributionBatch: () => assert.fail('check must not invoke AI'),
  } });
  assert.equal(code, 0); assert.equal(checks, 1); assert.equal(logs.at(-1).type, 'stage_finished');
  assert.ok(!JSON.stringify(logs).includes('mock-secret-dsn'));
});
test('update runs once with closed resources even when automatic schedules are disabled', async () => {
  let runs = 0, closed = 0;
  const code = await runTideOS({ argv: ['--stage', 'update'], env: { DATABASE_URL: 'fake', TUSHARE_TOKEN: 'fake', COMPANY_RESEARCH_TIDEOS: 'true', MARKET_AUTO_UPDATE_ENABLED: 'false' }, log: () => {}, dependencies: {
    createMarketUpdateRuntime: options => {
      assert.equal(options.enabled, true);
      return { start: () => assert.fail('no scheduler'), runOnce: async () => { runs++; return { status: 'partial' }; }, close: async () => { closed++; } };
    },
  } });
  assert.equal(code, 2); assert.equal(runs, 1); assert.equal(closed, 1);
});
test('both AI stages await completion, preserve waiting status and close resources', async () => {
  for (const stage of ['watchlist-attribution', 'relation-attribution']) {
    let finished = false, closed = false;
    const code = await runTideOS({ argv: ['--stage', stage], env: { DATABASE_URL: 'fake', DEEPSEEK_API_KEY: 'fake' }, log: () => {}, dependencies: {
      createAttributionBatch: async options => {
        assert.equal(options.stage, stage);
        return { run: async () => { await Promise.resolve(); finished = true; return { status: 'waiting' }; }, close: async () => { assert.equal(finished, true); closed = true; } };
      },
    } });
    assert.equal(code, 3); assert.equal(closed, true);
  }
});
test('CLI errors never reveal upstream secrets and still close the runtime', async () => {
  const logs = []; let closed = false;
  const code = await runTideOS({ argv: ['--stage', 'update'], env: { DATABASE_URL: 'private-dsn', TUSHARE_TOKEN: 'private-token' }, log: row => logs.push(row), dependencies: {
    createMarketUpdateRuntime: () => ({ runOnce: async () => { throw new Error('private-token'); }, close: async () => { closed = true; } }),
  } });
  assert.equal(code, 1); assert.equal(closed, true); assert.doesNotMatch(JSON.stringify(logs), /private-/);
});
test('documented exit codes distinguish completion, failure, waiting and configuration', () => {
  for (const status of ['succeeded', 'completed', 'already_completed']) assert.equal(exitCodeFor({ status }), 0);
  for (const status of ['partial', 'failed', 'incomplete']) assert.equal(exitCodeFor({ status }), 2);
  for (const status of ['busy', 'waiting']) assert.equal(exitCodeFor({ status }), 3);
  assert.equal(exitCodeFor({ status: 'disabled' }), 1);
});
test('disabling the watchlist scheduler preserves explicitly requested manual batches', async () => {
  let reads = 0;
  const query = async sql => ({ rows: sql.includes('pg_try') ? [{ locked: true }] : [] });
  const runtime = createWatchlistAttributionRuntime({ enabled: false, service: {},
    watchlistStore: { union: async () => { reads++; return []; } },
    pool: { query, connect: async () => ({ query, release() {} }), end: async () => {} },
  });
  assert.equal((await runtime.runOnce()).status, 'disabled'); assert.equal(reads, 0);
  assert.equal((await runtime.runOnce({ force: true })).status, 'completed'); assert.equal(reads, 1);
  await runtime.close();
});
test('missing configuration is visible on stdout and the real CLI exits promptly', () => {
  const result = spawnSync(process.execPath, ['scripts/tideos-run.mjs', '--check-only'], {
    cwd: PROJECT_ROOT, env: { PATH: process.env.PATH, DATABASE_URL: '' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1); assert.match(result.stdout, /MISSING_CONFIGURATION/); assert.equal(result.stderr, '');
});
test('Windows locked-file replacements retry without deleting the destination', async () => {
  let calls = 0; const delays = [];
  await replaceFile('tmp', 'target', { platform: 'win32', renameImpl: async (from, to) => {
    assert.equal(from, 'tmp'); assert.equal(to, 'target'); if (++calls < 4) throw Object.assign(new Error(), { code: 'EPERM' });
  }, sleep: async delay => delays.push(delay) });
  assert.equal(calls, 4); assert.deepEqual(delays, [200, 400, 600]);
});
test('replacement retries are bounded and unrelated failures remain immediate', async () => {
  let calls = 0;
  await assert.rejects(replaceFile('a', 'b', { platform: 'win32', renameImpl: async () => { calls++; throw Object.assign(new Error(), { code: 'EACCES' }); }, sleep: async () => {} }));
  assert.equal(calls, 10);
  await assert.rejects(replaceFile('a', 'b', { platform: 'win32', renameImpl: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }, sleep: async () => assert.fail() }));
});
test('PDF subprocess keeps Windows paths and UTF-8 but never provider credentials', () => {
  const env = extractionEnvironment({ Path: 'C:/Python', SystemRoot: 'C:/Windows', TEMP: 'C:/Temp', DEEPSEEK_API_KEY: 'secret', DATABASE_URL: 'private', IMA_TESSERACT: 'C:/OCR/tesseract.exe' });
  assert.equal(env.SystemRoot, 'C:/Windows'); assert.equal(env.Path, 'C:/Python'); assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.IMA_TESSERACT, 'C:/OCR/tesseract.exe'); assert.equal(env.DEEPSEEK_API_KEY, undefined); assert.equal(env.DATABASE_URL, undefined);
});
test('frontend derives the complete API prefix from its own mounted module URL', async () => {
  const source = await readFile(new URL('../frontend/config.js', import.meta.url), 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(source.replaceAll('import.meta.url', JSON.stringify('https://tideos.example.com/tools/research/config.js'))).toString('base64')}`);
  assert.equal(module.apiPath('/api/watchlist?owner=a'), '/tools/research/api/watchlist?owner=a');
  assert.equal(module.apiConfig.baseUrl, '/tools/research'); assert.equal(module.apiConfig.credentials, 'same-origin');
});
