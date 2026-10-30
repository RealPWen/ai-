import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const run = args => spawnSync(process.execPath, ['scripts/sync-cls-news.mjs', ...args], { cwd, encoding: 'utf8', timeout: 3000,
  env: { ...process.env, TUSHARE_TOKEN: 'do-not-print-secret', DATABASE_URL: 'invalid-do-not-connect-secret' } });

test('CLS CLI help works without database or network and explains partial coverage and public HTML', () => {
  const result = run(['--help']); assert.equal(result.status, 0); assert.match(result.stdout, /公开 HTML/); assert.match(result.stdout, /partial/); assert.match(result.stdout, /3 个日历月/);
  assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-secret|invalid-do-not-connect/);
});
test('CLS CLI validates inputs before connecting to database or public website', () => {
  for (const args of [['--unknown'], ['--mode', 'bad'], ['--start', '20260230'], ['--max-articles', '0'], ['--max-articles', '1001'], ['--max-articles', '1.2'], ['--no-homepage', '--no-homepage'], ['--mode'], ['--urls-file', '/does/not/exist']]) {
    const result = run(args); assert.equal(result.status, 1, JSON.stringify(args)); assert.match(result.stderr, /configuration_or_runtime/);
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-secret|invalid-do-not-connect/);
  }
});
