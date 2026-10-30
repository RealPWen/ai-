import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createRelationsStore, validateRelationSubjects } from '../backend/market-data/relations-store.mjs';
import { todayShanghai, validDate } from '../backend/src/input.mjs';

const STORAGE = fileURLToPath(new URL('../backend/storage/company-relations/', import.meta.url));
const MODES = new Set(['init', 'claim', 'import', 'status', 'release', 'fail']);
const VALUES = new Set(['mode', 'run-id', 'as-of', 'worker', 'lease-token', 'limit', 'lease-minutes', 'tickers', 'file', 'error-code', 'subjects-file']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const HELP = `用法：npm run data:relations -- --mode init|claim|import|status|release|fail [参数]
  init    [--run-id ID] [--as-of YYYY-MM-DD] [--subjects-file PATH]
          冻结全部在市A股候选；subjects-file为[{ticker,name,industry?}]，仅清单内A/港股为任务
  claim   --run-id ID --worker NAME [--limit 10] [--lease-minutes 30] [--tickers CODE,...]
  import  --file PATH [--run-id ID] [--worker NAME] [--lease-token TOKEN] [--replace]
          增量导入；新领取的租约需JSON携带leaseToken或显式传入，replace须为完整10家复核结果
  status  --run-id ID [--details]  按真实关系行数统计；details显示全部任务
  release --run-id ID --worker NAME [--lease-token TOKEN] [--tickers CODE,...]  只释放匹配代次
  fail    --run-id ID --worker NAME [--lease-token TOKEN] --tickers CODE --error-code CODE
联网检索由Codex会话完成；此命令不会调用模型或自行搜索。缓存位于backend/storage/company-relations/。`;

function invalid() { return Object.assign(new Error('关系任务参数无效。'), { code: 'VALIDATION_ERROR' }); }
export function parseRelationArgs(argv, today = todayShanghai()) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) throw invalid();
    const name = key.slice(2);
    if (Object.hasOwn(raw, name)) throw invalid();
    if (['details', 'replace'].includes(name)) { raw[name] = true; continue; }
    if (!VALUES.has(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw invalid();
    raw[name] = argv[++i];
  }
  if (!MODES.has(raw.mode)) throw invalid();
  const allowed = {
    init: ['run-id', 'as-of', 'subjects-file'], claim: ['run-id', 'worker', 'limit', 'lease-minutes', 'tickers'],
    import: ['run-id', 'file', 'worker', 'lease-token', 'replace'], status: ['run-id', 'details'],
    release: ['run-id', 'worker', 'lease-token', 'tickers'], fail: ['run-id', 'worker', 'lease-token', 'tickers', 'error-code'],
  };
  if (Object.keys(raw).some(key => key !== 'mode' && !allowed[raw.mode].includes(key))) throw invalid();
  const options = { mode: raw.mode, runId: raw['run-id'], workerId: raw.worker };
  if (raw.mode === 'init') {
    options.asOf = raw['as-of'] ?? today;
    if (!validDate(options.asOf) || options.asOf > today) throw invalid();
    options.runId ??= `relations-${raw['subjects-file'] ? 'scoped' : 'a'}-${options.asOf.replaceAll('-', '')}-v1`;
    if (raw['subjects-file']) options.subjectsFile = resolve(raw['subjects-file']);
  }
  if (options.runId && !IDENTIFIER.test(options.runId)) throw invalid();
  if (raw.mode !== 'import' && !options.runId) throw invalid();
  if (options.workerId && !IDENTIFIER.test(options.workerId)) throw invalid();
  if (raw['lease-token']) {
    if (!IDENTIFIER.test(raw['lease-token'])) throw invalid();
    options.leaseToken = raw['lease-token'];
  }
  if (['claim', 'release', 'fail'].includes(raw.mode) && !options.workerId) throw invalid();
  if (raw.tickers) {
    options.tickers = raw.tickers.split(',').map(value => value.trim().toUpperCase());
    if (options.tickers.some(value => !/^(?:\d{6}\.(SH|SZ|BJ)|\d{5}\.HK)$/.test(value)) || new Set(options.tickers).size !== options.tickers.length) throw invalid();
  }
  if (raw.mode === 'claim') {
    for (const [field, key, fallback, maximum] of [['limit', 'limit', 10, 50], ['leaseMinutes', 'lease-minutes', 30, 240]]) {
      const value = raw[key] ?? String(fallback);
      if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) throw invalid();
      options[field] = Number(value);
    }
  }
  if (raw.mode === 'import') {
    if (!raw.file) throw invalid();
    options.file = resolve(raw.file);
  }
  if (raw.mode === 'fail') {
    if (options.tickers?.length !== 1 || !raw['error-code'] || !/^[a-z_]{1,64}$/.test(raw['error-code'])) throw invalid();
    options.errorCode = raw['error-code'];
  }
  options.details = raw.details === true;
  if (raw.replace) options.replace = true;
  return options;
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function runRelationsCommand({ argv = process.argv.slice(2), env = process.env,
  storeFactory = createRelationsStore, storageRoot = STORAGE, log = value => console.log(JSON.stringify(value)),
  errorLog = value => console.error(JSON.stringify(value)), today = todayShanghai() } = {}) {
  let store, stage = 'arguments';
  try {
    const options = parseRelationArgs(argv, today);
    if (options.help) { log({ type: 'relations_help', message: HELP }); return 0; }
    let payload, subjects;
    if (options.subjectsFile) {
      stage = 'read_subjects';
      if ((await stat(options.subjectsFile)).size > 5 * 1024 * 1024) throw invalid();
      subjects = validateRelationSubjects(JSON.parse(await readFile(options.subjectsFile, 'utf8')));
    }
    if (options.mode === 'import') {
      stage = 'read_cache';
      if ((await stat(options.file)).size > 5 * 1024 * 1024) throw invalid();
      payload = JSON.parse(await readFile(options.file, 'utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !IDENTIFIER.test(payload.runId ?? '')
        || !/^(?:\d{6}\.(SH|SZ|BJ)|\d{5}\.HK)$/.test(payload.ticker ?? '') || (options.runId && options.runId !== payload.runId)) throw invalid();
      if (payload.leaseToken !== undefined && (typeof payload.leaseToken !== 'string' || !IDENTIFIER.test(payload.leaseToken))) throw invalid();
      if (options.leaseToken && payload.leaseToken && options.leaseToken !== payload.leaseToken) throw invalid();
      options.leaseToken ??= payload.leaseToken;
      options.runId = payload.runId;
    }
    stage = 'database';
    store = storeFactory({ connectionString: env.DATABASE_URL });
    // Read-only status never performs DDL. Other modes use the same additive migration.
    if (options.mode !== 'status') await store.migrate();
    const directory = join(storageRoot, options.runId);
    if (options.mode === 'init') {
      const report = await store.initRun({ runId: options.runId, asOf: options.asOf, methodVersion: 'a-relations-v1', ...(subjects ? { subjects } : {}) });
      const securities = await store.listSecurities({ runId: options.runId });
      await mkdir(join(directory, 'research'), { recursive: true, mode: 0o700 });
      const universeHash = createHash('sha256').update(JSON.stringify(securities.map(row => [row.ts_code, row.name]))).digest('hex');
      await atomicJson(join(directory, 'universe.json'), {
        runId: options.runId, asOf: options.asOf, methodVersion: 'a-relations-v1',
        capturedAt: new Date().toISOString(), universeHash, securities,
        ...(subjects ? { subjects } : {}),
      });
      log({ type: 'relations_initialized', ...report, universeHash, manifest: join(directory, 'universe.json') });
    } else if (options.mode === 'claim') {
      const jobs = await store.claimJobs(options);
      await mkdir(join(directory, 'claims'), { recursive: true, mode: 0o700 });
      await atomicJson(join(directory, 'claims', `${options.workerId}.json`), { runId: options.runId, jobs });
      log({ type: 'relations_claimed', runId: options.runId, workerId: options.workerId, count: jobs.length, jobs });
    } else if (options.mode === 'import') {
      const report = await store.importResearch(payload, { workerId: options.workerId,
        ...(options.leaseToken ? { leaseToken: options.leaseToken } : {}), ...(options.replace ? { replace: true } : {}) });
      await mkdir(join(directory, 'imports'), { recursive: true, mode: 0o700 });
      await atomicJson(join(directory, 'imports', `${payload.ticker}.json`), {
        ...report, importedAt: new Date().toISOString(), payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      });
      log({ type: 'relations_imported', ...report });
    } else if (options.mode === 'status') {
      const report = await store.status({ runId: options.runId, includeStocks: true });
      const { stocks = [], gaps = [], ...summary } = report;
      const actionable = stocks.filter(row => row.status === 'partial' || row.status === 'failed' || row.gaps?.length);
      log({ type: 'relations_status', ...summary, gaps: options.details ? gaps : gaps.slice(0, 10),
        stocks: options.details ? stocks : actionable.slice(0, 10),
        stockDetailsTruncated: options.details ? false : stocks.length > Math.min(actionable.length, 10) });
    } else if (options.mode === 'release') {
      const report = await store.releaseJobs(options);
      log({ type: 'relations_released', runId: options.runId, ...report });
    } else {
      const report = await store.markFailed({ ...options, ticker: options.tickers[0] });
      log({ type: 'relations_failed_job', runId: options.runId, ticker: options.tickers[0], ...report });
    }
    return 0;
  } catch (error) {
    const safeCodes = new Set(['VALIDATION_ERROR', 'DATABASE_ERROR', 'RUN_NOT_FOUND', 'RUN_CONFLICT', 'LEASE_CONFLICT',
      'STALE_RUN', 'JOB_NOT_FOUND', 'STALE_IMPORT', 'ENOENT', 'EACCES', 'RELATIONS_VALIDATION_ERROR', 'RELATIONS_DATABASE_ERROR']);
    errorLog({ type: 'relations_command_failed', stage, code: safeCodes.has(error.code) ? error.code : 'COMMAND_FAILED',
      message: '关系任务执行失败，请检查参数、冻结清单、缓存格式及数据库配置。' });
    return 1;
  } finally {
    if (store) { try { await store.close(); } catch { errorLog({ type: 'relations_command_failed', stage: 'close', code: 'DATABASE_ERROR' }); return 1; } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runRelationsCommand();
}
