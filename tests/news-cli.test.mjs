import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const run = (args, env = {}) => spawnSync(process.execPath, ['scripts/sync-news.mjs', ...args], { cwd, encoding: 'utf8', timeout: 2000,
  env: { ...process.env, TUSHARE_TOKEN: 'do-not-print-secret', DATABASE_URL: 'invalid-do-not-connect-secret', ...env } });
test('news CLI help explains calendar months and can run without opening database or provider connections', () => {
  const result = run(['--help']); assert.equal(result.status, 0); assert.match(result.stdout, /3 个日历月/); assert.match(result.stdout, /左闭右开/); assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-secret|invalid-do-not-connect/);
});
test('news CLI rejects invalid retry budgets before opening provider or database connections', () => {
  for (const value of ['-1', '11', '0.5', 'Infinity', 'NaN', 'token=secret']) {
    const result = run(['--no-probe'], { NEWS_MAX_RETRIES: value });
    assert.equal(result.status, 1, value); assert.match(result.stderr, /configuration_or_runtime/);
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-secret|invalid-do-not-connect|token=secret/);
  }
});
test('news CLI rejects unknown flags, bad dates and unsafe source names before connecting', () => {
  for (const args of [['--unknown'], ['--start', '20260230'], ['--mode', 'invalid'], ['--source', '../../other'], ['--mode', 'import', '--refresh']]) {
    const result = run(args); assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /configuration_or_runtime/); assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-secret|invalid-do-not-connect/);
  }
});
