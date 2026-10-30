import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const run = args => spawnSync(process.execPath, ['scripts/sync-cls-news-search.mjs', ...args], { cwd, encoding: 'utf8', timeout: 3000,
  env: { ...process.env, TUSHARE_TOKEN: 'do-not-print-secret', DATABASE_URL: 'invalid-do-not-connect-secret' } });
test('CLS public search help works without database credentials and explains scope and summaries', () => {
  const result = run(['--help']); assert.equal(result.status, 0); assert.match(result.stdout, /摘要/); assert.match(result.stdout, /关键词/); assert.match(result.stdout, /coverageVerified=false/); assert.match(result.stdout, /--resume/);
  assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-secret|invalid-do-not-connect/);
});
test('CLS public search CLI validates dates, budgets, keywords and resume arguments before connecting', () => {
  for (const args of [['--unknown'], ['--max-pages', '0'], ['--max-pages', '5001'], ['--max-pages', '1.5'], ['--start', '20260230'], ['--keyword', ' '], ['--resume', '--end', '20261019'], ['--resume', '--resume']]) {
    const result = run(args); assert.equal(result.status, 1, JSON.stringify(args)); assert.match(result.stderr, /configuration_or_runtime/); assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-secret|invalid-do-not-connect/);
  }
});
