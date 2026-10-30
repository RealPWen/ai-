import { spawn } from 'node:child_process';
import { PROJECT_ROOT } from '../backend/src/runtime-config.mjs';

// This is the separate persistent board service, never a TideOS batch stage.
const env = { ...process.env, COMPANY_RESEARCH_TIDEOS: 'true',
  MARKET_AUTO_UPDATE_ENABLED: 'false', WATCHLIST_ATTRIBUTION_AUTO_UPDATE_ENABLED: 'false',
  RELATION_ATTRIBUTION_AUTO_UPDATE_ENABLED: 'false',
  COMPANY_RESEARCH_BASE_PATH: process.env.COMPANY_RESEARCH_BASE_PATH || '/company-research',
  FRONTEND_BACKEND_PORT: process.env.BACKEND_PORT || '8000',
  FRONTEND_HOST: '127.0.0.1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }, 10000);
  timer.unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(0));
for (const entry of ['backend/server.mjs', 'scripts/serve-frontend.mjs']) {
  const child = spawn(process.execPath, [entry], { cwd: PROJECT_ROOT, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stdout, { end: false });
  child.on('error', () => { console.log(JSON.stringify({ type: 'board_failed', entry })); stop(1); });
  child.on('exit', (code, signal) => {
    if (!stopping) { console.log(JSON.stringify({ type: 'board_stopped', entry, code, signal })); stop(code || 1); }
  });
}
