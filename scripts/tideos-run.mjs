import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMarketUpdateRuntime } from '../backend/market-data/update-runtime.mjs';
import { marketRuntimeOptions, dataRoot } from '../backend/src/runtime-config.mjs';
import { checkDatabase, createAttributionBatch } from '../backend/src/tideos-batch.mjs';

export const STAGES = Object.freeze(['check', 'update', 'watchlist-attribution', 'relation-attribution']);
const usage = 'node scripts/tideos-run.mjs --stage check|update|watchlist-attribution|relation-attribution\n--check-only 等同 --stage check；不执行采集、迁移或 AI。';

export function parseStage(argv) {
  if (argv.length === 1 && argv[0] === '--help') return 'help';
  if (argv.length === 1 && argv[0] === '--check-only') return 'check';
  if (argv.length === 2 && argv[0] === '--stage' && STAGES.includes(argv[1])) return argv[1];
  throw Object.assign(new Error('Invalid stage'), { code: 'INVALID_STAGE' });
}

export function exitCodeFor(result) {
  if (['succeeded', 'completed', 'already_completed'].includes(result?.status)) return 0;
  if (['busy', 'waiting'].includes(result?.status)) return 3;
  if (['partial', 'failed', 'incomplete'].includes(result?.status)) return 2;
  return 1;
}

export async function runTideOS({ argv = process.argv.slice(2), env = process.env,
  log = value => console.log(JSON.stringify(value)),
  dependencies = {}, } = {}) {
  let runtime, stage;
  try {
    stage = parseStage(argv);
    if (stage === 'help') { log({ type: 'help', usage, exitCodes: { 0: 'completed', 1: 'configuration_or_runtime', 2: 'incomplete_or_failed', 3: 'busy_or_waiting', 130: 'interrupted' } }); return 0; }
    const required = ['DATABASE_URL', ...(stage === 'update' ? ['TUSHARE_TOKEN'] : stage === 'check' ? [] : ['DEEPSEEK_API_KEY'])];
    const missing = required.filter(key => !env[key]?.trim());
    if (missing.length) { log({ type: 'stage_failed', stage, code: 'MISSING_CONFIGURATION', missing }); return 1; }
    if (stage.endsWith('attribution') && (env.AI_PROVIDER && env.AI_PROVIDER !== 'deepseek')) {
      log({ type: 'stage_failed', stage, code: 'BATCH_REQUIRES_DEEPSEEK' }); return 1;
    }
    if (env.BACKEND_HTTP_TRANSPORT && !['native', 'curl'].includes(env.BACKEND_HTTP_TRANSPORT)
      || process.platform === 'win32' && env.BACKEND_HTTP_TRANSPORT === 'curl') {
      log({ type: 'stage_failed', stage, code: 'USE_NATIVE_TRANSPORT' }); return 1;
    }
    log({ type: 'stage_started', stage, dataRoot: dataRoot(env) });
    let result;
    if (stage === 'check') result = await (dependencies.checkDatabase ?? checkDatabase)(env);
    else if (stage === 'update') {
      runtime = (dependencies.createMarketUpdateRuntime ?? createMarketUpdateRuntime)({ ...marketRuntimeOptions(env), enabled: true, log });
      result = await runtime.runOnce();
    } else {
      runtime = await (dependencies.createAttributionBatch ?? createAttributionBatch)({ stage, env, log });
      result = await runtime.run();
    }
    const exitCode = exitCodeFor(result);
    log({ type: 'stage_finished', stage, ...result, exitCode });
    return exitCode;
  } catch (error) {
    // Never print a raw upstream error, DSN, access token or provider response.
    const code = /^[A-Z_0-9]{1,80}$/.test(error.code ?? '') ? error.code : 'CONFIGURATION_OR_RUNTIME';
    log({ type: 'stage_failed', stage, code }); return 1;
  } finally { await runtime?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    console.log(JSON.stringify({ type: 'stage_interrupted', signal, exitCode: 130 })); process.exit(130);
  });
  try { process.exitCode = await runTideOS(); }
  catch { console.log(JSON.stringify({ type: 'stage_failed', code: 'CLEANUP_FAILED' })); process.exitCode = 1; }
}
