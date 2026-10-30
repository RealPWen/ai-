import { readFile, writeFile, mkdir, rename, stat, unlink, open } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validDate } from '../backend/src/input.mjs';
import {
  buildEvidenceCatalog, searchEvidenceCatalog, composeResearchFromEvidence,
} from '../backend/market-data/relations-evidence.mjs';

const STORAGE = fileURLToPath(new URL('../backend/storage/company-relations/', import.meta.url));
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TICKER = /^(?:\d{6}\.(SH|SZ|BJ)|\d{5}\.HK)$/;
const ALLOWED = {
  index: ['run-id'], find: ['run-id', 'ticker', 'query', 'limit'],
  compose: ['run-id', 'ticker', 'file', 'claim', 'out'],
};
export const HELP = `用法：npm run data:relations:cache -- --mode index|find|compose --run-id ID [参数]
  index    从已成功导入的研究缓存建立 evidence/catalog.json，只显示计数
  find     [--ticker CODE] [--query TEXT] [--limit 8]，每条摘录最多350字符
  compose  --file compact.json --claim claims/原领取.json [--out research/CODE.json]
           草稿须显式提供researchedAt、leaseToken及sourceIds；支持newSources
所有相对文件路径均以backend/storage/company-relations/<run-id>/为基准。
compose默认保存research/<ticker>.json；旧版本或同时间不同内容不得覆盖。
此工具仅操作本地文件，不连接数据库、网络或模型API，不刷新研究或读取时间。`;

function failure(code = 'VALIDATION_ERROR') { return Object.assign(new Error('证据缓存参数或内容无效。'), { code }); }

export function parseEvidenceArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw failure();
    const name = key.slice(2);
    if (Object.hasOwn(raw, name)) throw failure();
    raw[name] = argv[++i];
  }
  if (!Object.hasOwn(ALLOWED, raw.mode) || !ID.test(raw['run-id'] ?? '')) throw failure();
  if (Object.keys(raw).some(key => key !== 'mode' && !ALLOWED[raw.mode].includes(key))) throw failure();
  const options = { mode: raw.mode, runId: raw['run-id'] };
  if (raw.ticker !== undefined) {
    options.ticker = raw.ticker.toUpperCase();
    if (!TICKER.test(options.ticker)) throw failure();
  }
  if (raw.mode === 'find') {
    options.limit = 8;
    if (raw.limit !== undefined) {
      if (!/^[1-9]\d*$/.test(raw.limit) || Number(raw.limit) > 50) throw failure();
      options.limit = Number(raw.limit);
    }
    if (raw.query !== undefined) {
      options.query = raw.query.trim();
      if (!options.query || options.query.length > 500) throw failure();
    }
  }
  if (raw.mode === 'compose') {
    if (!raw.file?.trim() || !raw.claim?.trim() || (raw.out !== undefined && !raw.out.trim())) throw failure();
    options.file = raw.file;
    options.claim = raw.claim;
    if (raw.out !== undefined) options.out = raw.out;
  }
  return options;
}

async function readJson(path, maximumBytes) {
  const info = await stat(path);
  if (!info.isFile() || info.size > maximumBytes) throw failure();
  return JSON.parse(await readFile(path, 'utf8'));
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function saveResearch(path, payload) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let lock;
  try {
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw failure('CACHE_BUSY'); throw error; }
    let existing;
    try { existing = await readJson(path, 5 * 1024 * 1024); }
    catch (error) { if (error.code !== 'ENOENT') throw failure('CACHE_CONFLICT'); }
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing, payload)) return false;
      const previous = Date.parse(existing?.researchedAt);
      const current = Date.parse(payload.researchedAt);
      if (!Number.isFinite(previous) || !Number.isFinite(current) || current <= previous) throw failure('STALE_CACHE');
      if (existing.runId !== payload.runId || existing.ticker !== payload.ticker
        || existing.asOf !== payload.asOf || existing.methodVersion !== payload.methodVersion) throw failure('CACHE_CONFLICT');
    }
    await atomicJson(path, payload);
    return true;
  } finally {
    if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}); }
  }
}

function short(value, maximum) { return typeof value === 'string' ? Array.from(value).slice(0, maximum).join('') : null; }
function compactHit(hit) {
  const occurrences = Array.isArray(hit.occurrences) ? hit.occurrences : [];
  const url = short(hit.url, 240), title = short(hit.title, 160);
  return {
    sourceId: short(hit.sourceId, 128), url, title,
    urlTruncated: url !== hit.url, titleTruncated: title !== hit.title,
    publishedAt: short(hit.publishedAt, 10), excerpt: short(hit.excerpt, 350), accessedAt: short(hit.accessedAt, 64),
    readingScope: short(hit.readingScope, 12), occurrenceCount: occurrences.length,
    occurrences: occurrences.slice(0, 2).map(item => ({ ticker: short(item.ticker, 16), relatedTicker: short(item.relatedTicker, 16) })),
  };
}

export async function runEvidenceCommand({ argv = process.argv.slice(2), storageRoot = STORAGE,
  log = value => console.log(JSON.stringify(value)), errorLog = value => console.error(JSON.stringify(value)) } = {}) {
  let stage = 'arguments';
  try {
    const options = parseEvidenceArgs(argv);
    if (options.help) { log({ type: 'relations_evidence_help', message: HELP }); return 0; }
    const directory = join(storageRoot, options.runId);
    stage = 'read_universe';
    const universe = await readJson(join(directory, 'universe.json'), 16 * 1024 * 1024);
    if (!universe || Array.isArray(universe) || universe.runId !== options.runId || !validDate(universe.asOf)
      || typeof universe.methodVersion !== 'string' || !universe.methodVersion.trim() || !Array.isArray(universe.securities)) throw failure();
    const catalogPath = join(directory, 'evidence', 'catalog.json');
    if (options.mode === 'index') {
      stage = 'build_index';
      const catalog = await buildEvidenceCatalog({ runId: options.runId, asOf: universe.asOf,
        methodVersion: universe.methodVersion, researchDirectory: join(directory, 'research'), importsDirectory: join(directory, 'imports') });
      await mkdir(dirname(catalogPath), { recursive: true, mode: 0o700 });
      await atomicJson(catalogPath, catalog);
      log({ type: 'relations_evidence_indexed', runId: options.runId,
        evidenceCount: Object.keys(catalog.sources).length, indexedResearchCount: catalog.indexedResearchCount });
    } else {
      stage = 'read_index';
      const catalog = await readJson(catalogPath, 256 * 1024 * 1024);
      if (catalog.runId !== universe.runId || catalog.asOf !== universe.asOf || catalog.methodVersion !== universe.methodVersion) throw failure();
      if (options.mode === 'find') {
        stage = 'find';
        const hits = searchEvidenceCatalog(catalog, { ticker: options.ticker, query: options.query,
          limit: options.limit, maxExcerptChars: 350 });
        log({ type: 'relations_evidence_candidates', runId: options.runId, count: Math.min(hits.length, options.limit),
          message: '候选证据的主体、法人和关系方向仍须核对。', hits: hits.slice(0, options.limit).map(compactHit) });
      } else {
        stage = 'read_draft';
        const draft = await readJson(resolve(directory, options.file), 5 * 1024 * 1024);
        const claim = await readJson(resolve(directory, options.claim), 2 * 1024 * 1024);
        if (!draft || draft.runId !== universe.runId || draft.asOf !== universe.asOf || draft.methodVersion !== universe.methodVersion
          || typeof draft.researchedAt !== 'string' || typeof draft.leaseToken !== 'string' || !draft.leaseToken.trim()
          || (options.ticker && draft.ticker !== options.ticker)) throw failure();
        stage = 'compose';
        const payload = composeResearchFromEvidence(draft, catalog, { universe, claim });
        if (payload.researchedAt !== draft.researchedAt || payload.leaseToken !== draft.leaseToken || !TICKER.test(payload.ticker ?? '')) throw failure();
        const output = options.out ? resolve(directory, options.out) : join(directory, 'research', `${payload.ticker}.json`);
        stage = 'save_research';
        const written = await saveResearch(output, payload);
        log({ type: 'relations_evidence_composed', runId: payload.runId, ticker: payload.ticker,
          relationCount: payload.relations.length, researchedAt: payload.researchedAt, output, written });
      }
    }
    return 0;
  } catch (error) {
    const codes = new Set(['VALIDATION_ERROR', 'RELATIONS_VALIDATION_ERROR', 'EVIDENCE_VALIDATION_ERROR',
      'STALE_CACHE', 'CACHE_CONFLICT', 'CACHE_BUSY', 'ENOENT', 'EACCES']);
    errorLog({ type: 'relations_evidence_failed', stage, code: codes.has(error.code) ? error.code : 'COMMAND_FAILED',
      message: '证据缓存操作失败，请检查参数、冻结清单、原领取记录及文件版本。' });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runEvidenceCommand();
}
