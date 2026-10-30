import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createNewsMatcher } from './news-matching.mjs';

export const NEWS_FIELDS = 'title,content,pub_time,src';
export const NEWS_API = 'major_news';
const DAY = 86400000, SECOND = 1000, SHANGHAI_OFFSET = 8 * 3600000;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const BLOCKING = new Set(['permission', 'authentication', 'rate_limit', 'database', 'network', 'timeout']);
const ERROR_CODES = { permission: 'permission_denied', authentication: 'authentication_error', rate_limit: 'rate_limited', database: 'database_error', network: 'network_error', timeout: 'network_error', validation: 'validation_error', invalid_response: 'validation_error', incomplete: 'incomplete_window', unknown: 'unknown_error' };
export function newsValidationError(message) { return Object.assign(new Error(message), { code: 'VALIDATION_ERROR', kind: 'validation' }); }
const fail = message => { throw newsValidationError(message); };
const errorKind = error => error?.code === 'DATABASE_ERROR' ? 'database' : ['permission', 'authentication', 'rate_limit', 'database', 'network', 'timeout', 'validation', 'invalid_response', 'incomplete'].includes(error?.kind) ? error.kind : 'unknown';
const upstreamDiagnostic = error => {
  const code = error?.upstreamCode ?? error?.code;
  return Number.isSafeInteger(code) && Math.abs(code) <= 1000000 ? { upstreamCode: code } : {};
};
const iso = value => new Date(value).toISOString();
const keyOf = ({ start, end }) => `${iso(start)}|${iso(end)}`;
const localDate = value => iso(new Date(value).getTime() + SHANGHAI_OFFSET).slice(0, 10);
export const shanghaiNewsTime = value => iso(new Date(value).getTime() + SHANGHAI_OFFSET).slice(0, 19).replace('T', ' ');

/** Independent conservative news pacing; these defaults do not establish account entitlement. */
export function createNewsClient(client, {
  intervalMs = 122000, rateLimitBackoffMs = 3600000, networkRetryBaseMs = 5000, maxNetworkRetryMs = 300000,
  maxRetries = 3, sleep = wait, now = Date.now, log = () => {},
} = {}) {
  if (typeof client?.query !== 'function' || typeof sleep !== 'function' || typeof now !== 'function' || typeof log !== 'function'
    || ![intervalMs, rateLimitBackoffMs, networkRetryBaseMs, maxNetworkRetryMs].every(value => Number.isInteger(value) && value >= 0 && value <= DAY)
    || rateLimitBackoffMs === 0 || networkRetryBaseMs === 0 || maxNetworkRetryMs < networkRetryBaseMs
    || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) fail('资讯限速和退避参数无效。');
  let queue = Promise.resolve(), lastStarted = -Infinity;
  const stats = { attempts: 0, rateLimitRetries: 0, networkRetries: 0 };
  const windowOf = params => ({ start: params?.start_date ?? null, end: params?.end_date ?? null });
  async function request(api, params, fields) {
    let retries = 0, networkRetries = 0;
    for (;;) {
      const pause = Math.max(0, lastStarted + intervalMs - now());
      if (pause) { log({ type: 'news_wait', kind: 'throttle', retrySeconds: Math.ceil(pause / 1000), retryAt: iso(now() + pause), window: windowOf(params) }); await sleep(pause); }
      lastStarted = now(); stats.attempts++;
      try { return await client.query(api, params, fields); }
      catch (error) {
        const kind = errorKind(error), network = ['network', 'timeout'].includes(kind) || kind === 'unknown' && error?.retryable === true;
        if (!(kind === 'rate_limit' || network) || retries >= maxRetries) throw error;
        retries++;
        const delay = kind === 'rate_limit' ? rateLimitBackoffMs : Math.min(maxNetworkRetryMs, networkRetryBaseMs * 2 ** Math.min(networkRetries++, 16));
        if (kind === 'rate_limit') stats.rateLimitRetries++; else stats.networkRetries++;
        log({ type: 'news_retry', kind: kind === 'rate_limit' ? kind : 'network', ...upstreamDiagnostic(error), retrySeconds: Math.ceil(delay / 1000), retryAt: iso(now() + delay), window: windowOf(params) });
        await sleep(delay);
      }
    }
  }
  return {
    query(api, params = {}, fields = '') {
      const copy = { ...params }, pending = queue.then(() => request(api, copy, fields)); queue = pending.catch(() => {}); return pending;
    },
    stats() { return { ...stats }; },
  };
}

function parseDay(value) {
  const compact = /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(compact)) return null;
  const time = Date.parse(`${compact}T00:00:00+08:00`);
  if (!Number.isFinite(time) || localDate(time) !== compact) fail('资讯日期无效。');
  return time;
}
function instant(value) {
  if (value instanceof Date || typeof value === 'number') {
    const time = new Date(value).getTime(); if (Number.isFinite(time) && time % SECOND === 0) return time;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) {
    const [year, month, day, hour, minute, second] = value.match(/\d+/g).map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) fail('资讯时间包含无效的日历日期。');
    const normalized = value.replace(' ', 'T'), qualified = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`;
    const time = Date.parse(qualified); if (Number.isFinite(time)) return time;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)) return instant(value.replace('.000Z', 'Z'));
  fail('资讯时间须为精确到秒的上海时间或带时区 ISO 时间。');
}
function subtractMonths(day, count) {
  const year = Number(day.slice(0, 4)), month = Number(day.slice(5, 7)), date = Number(day.slice(8, 10));
  const previous = new Date(Date.UTC(year, month - 1 - count, 1));
  const last = new Date(Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth() + 1, 0)).getUTCDate();
  previous.setUTCDate(Math.min(date, last)); return previous.toISOString().slice(0, 10);
}

/** Dates are inclusive Shanghai calendar dates. Timestamp bounds are [start, end), in whole seconds. */
export function newsRange({ startDate, endDate, now = new Date() } = {}) {
  const current = Math.floor(new Date(now).getTime() / SECOND) * SECOND;
  if (!Number.isFinite(current)) fail('资讯研究时间无效。');
  const defaultStart = subtractMonths(localDate(current), 3);
  const start = startDate === undefined ? parseDay(defaultStart) : parseDay(String(startDate)) ?? instant(startDate);
  let end;
  if (endDate === undefined) end = current;
  else { const day = parseDay(String(endDate)); end = day === null ? instant(endDate) : day + DAY; }
  end = Math.min(end, current);
  if (start >= end || start % SECOND || end % SECOND || end - start > 366 * DAY) fail('资讯起止范围无效，单次最多支持一年。');
  return { start: iso(start), end: iso(end) };
}

export function partitionNewsRange(start, end) {
  let cursor = instant(start); const until = instant(end), result = [];
  if (cursor >= until) fail('资讯分区范围无效。');
  while (cursor < until) {
    const nextDay = parseDay(localDate(cursor)) + DAY, next = Math.min(until, nextDay);
    result.push({ start: iso(cursor), end: iso(next) }); cursor = next;
  }
  return result.reverse();
}

export function normalizeNewsRows(rows, { start, end, sourceApi = NEWS_API, sourceName = '', fetchedAt }) {
  const from = instant(start), to = instant(end), collected = new Map();
  if (!Array.isArray(rows) || rows.length > 100000 || !Number.isFinite(Date.parse(fetchedAt))) fail('资讯返回格式或采集时间无效。');
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 5000
      || (row.content !== null && row.content !== undefined && typeof row.content !== 'string') || String(row.content ?? '').length > 4000000
      || typeof row.pub_time !== 'string' || (row.src !== undefined && row.src !== null && typeof row.src !== 'string')) fail('资讯缺少有效标题、正文或来源。');
    const published = instant(row.pub_time);
    if (published < from || published >= to) fail('Tushare 返回的资讯时间超出请求窗口，不能确认完整性。');
    const actualSource = String(row.src || sourceName || 'Tushare').trim().slice(0, 200), title = row.title.trim();
    const id = createHash('sha256').update(JSON.stringify([sourceApi, actualSource, iso(published), title])).digest('hex');
    // Same identity may occur twice in the provider response; the latest content replaces it.
    collected.set(id, { id, sourceApi, sourceName: actualSource, title, content: row.content ?? '', publishedAt: iso(published), url: null, fetchedAt });
  }
  return [...collected.values()];
}

async function atomicJson(path, value, compressed = false) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`), temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, compressed ? gzipSync(bytes) : bytes, { mode: 0o600 }); await rename(temporary, path);
}
const filePart = value => iso(value).replace(/[-:.]/g, '');
async function readWindowCache(path, expected) {
  let value;
  try { value = JSON.parse(gunzipSync(await readFile(path), { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('资讯原始缓存损坏，未将对应窗口标为完成。'); }
  if (!value || value.version !== 1 || value.source !== 'tushare' || value.sourceApi !== expected.sourceApi || value.sourceName !== expected.sourceName
    || value.start !== expected.start || value.end !== expected.end || value.fields !== NEWS_FIELDS || !Number.isFinite(Date.parse(value.fetchedAt))) fail('资讯缓存来源、字段、采集时间或窗口不一致。');
  if (value.split === true) {
    const split = instant(value.splitAt);
    const limitUsed = value.limitUsed ?? 400;
    if (value.complete !== false || split <= instant(value.start) || split >= instant(value.end) || !Number.isInteger(value.returnedRows)
      || !Number.isInteger(limitUsed) || limitUsed < 1 || limitUsed > 800 || value.returnedRows < limitUsed && value.overflowDetected !== true) fail('资讯分片缓存无效。');
  } else if (value.complete !== true || value.split !== false || !Array.isArray(value.rows)) fail('资讯缓存尚未完整下载。');
  return value;
}

/** Only complete leaf windows are committed. No offset pagination: major_news may ignore offsets and silently cap rows. */
export async function syncNews({ client, store, cacheDir, startDate, endDate, mode = 'sync', refresh = false, sourceName = '', now = new Date(), saturationLimit = 800, maxRequests = 20000, log = () => {} } = {}) {
  const range = newsRange({ startDate, endDate, now });
  if (!['sync', 'download', 'import'].includes(mode) || typeof refresh !== 'boolean' || (mode === 'import' && refresh)
    || typeof cacheDir !== 'string' || !cacheDir || typeof sourceName !== 'string' || !/^[\p{L}\p{N}_-]{0,80}$/u.test(sourceName)
    || !Number.isInteger(saturationLimit) || saturationLimit < 1 || saturationLimit > 800 || !Number.isInteger(maxRequests) || maxRequests < 1) fail('资讯下载参数无效。');
  if (mode !== 'import' && typeof client?.query !== 'function') fail('资讯下载需要 Tushare 客户端。');
  if (mode !== 'download' && !store) fail('资讯入库需要 PostgreSQL。');
  const sourceApi = NEWS_API, directory = join(cacheDir, 'news', sourceApi, sourceName || 'all');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const partitions = partitionNewsRange(range.start, range.end);
  const report = { version: 1, source: 'tushare', sourceApi, sourceName, ...range, mode, refresh, status: 'running', startedAt: new Date().toISOString(),
    plannedDays: partitions.length, completedDays: 0, completedWindows: 0, skippedWindows: 0, cachedWindows: 0, downloadedWindows: 0,
    requests: 0, rows: 0, rawRows: 0, links: 0, failedWindows: [] };
  const statusPath = join(directory, `status-${filePart(range.start)}-${filePart(range.end)}-${mode}.json`);
  await atomicJson(statusPath, report);
  let completed = new Set(), matcher = () => [];
  try {
    if (mode !== 'download') {
      await store.migrate();
      if (!refresh) completed = await store.getCompletedWindows({ sourceApi, sourceName, from: range.start, to: range.end });
      matcher = createNewsMatcher(await store.getSecurities());
    }
    const visit = async window => {
      const identity = { sourceApi, sourceName, ...window }, key = keyOf(window);
      if (!refresh && completed.has(key)) { report.skippedWindows++; report.completedWindows++; return true; }
      const path = join(directory, `${filePart(window.start)}_${filePart(window.end)}.json.gz`);
      try {
        let cached = refresh ? null : await readWindowCache(path, { ...identity, saturationLimit });
        if (!cached) {
          if (mode === 'import') fail('资讯窗口没有完整原始缓存，请先下载。');
          const query = async params => {
            if (report.requests >= maxRequests) throw Object.assign(new Error('资讯请求数达到上限，剩余窗口尚未完成。'), { kind: 'incomplete' });
            report.requests++; return client.query(sourceApi, params, NEWS_FIELDS);
          };
          const params = { start_date: shanghaiNewsTime(window.start), end_date: shanghaiNewsTime(instant(window.end) - SECOND), limit: saturationLimit };
          if (sourceName) params.src = sourceName;
          const rows = await query(params), fetchedAt = new Date().toISOString();
          normalizeNewsRows(rows, { ...identity, fetchedAt });
          let saturated = rows.length >= saturationLimit, overflowDetected = false;
          // Actual account responses cap at 800 although the public docs say 400. An empty overflow probe
          // confirms a shorter response is complete even if the provider lowers its cap. Its rows are never
          // concatenated, because source ordering inside the same publication second can change across pages.
          if (!saturated && rows.length) {
            const overflow = await query({ ...params, limit: 1, offset: rows.length });
            normalizeNewsRows(overflow, { ...identity, fetchedAt }); saturated = overflow.length > 0; overflowDetected = saturated;
          }
          if (saturated) {
            const seconds = (instant(window.end) - instant(window.start)) / SECOND;
            if (seconds <= 1) throw Object.assign(new Error('同一秒资讯达到接口上限，无法确认完整性。'), { kind: 'incomplete' });
            const splitAt = iso(instant(window.start) + Math.floor(seconds / 2) * SECOND);
            cached = { version: 1, source: 'tushare', ...identity, fields: NEWS_FIELDS, fetchedAt, complete: false, split: true, splitAt, returnedRows: rows.length, limitUsed: saturationLimit, overflowDetected };
          } else {
            cached = { version: 1, source: 'tushare', ...identity, fields: NEWS_FIELDS, fetchedAt, complete: true, split: false, rows, limitUsed: saturationLimit, endVerified: true };
            report.downloadedWindows++;
          }
          await atomicJson(path, cached, true);
        } else if (!cached.split) report.cachedWindows++;
        if (cached.split) {
          const left = await visit({ start: window.start, end: cached.splitAt });
          const right = await visit({ start: cached.splitAt, end: window.end });
          return left && right;
        }
        if (cached.rows.length >= (cached.limitUsed ?? 400)) fail('资讯缓存达到返回上限，尚不能确认完整性。');
        const articles = normalizeNewsRows(cached.rows, { ...identity, fetchedAt: cached.fetchedAt });
        const links = articles.flatMap(matcher);
        if (mode !== 'download') await store.saveWindow({ ...identity, articles, links, fetchedAt: cached.fetchedAt });
        report.completedWindows++; report.rawRows += cached.rows.length; report.rows += articles.length; report.links += links.length;
        log({ type: 'news_window_completed', ...window, rows: articles.length, links: links.length, requests: report.requests, completedDays: report.completedDays, plannedDays: report.plannedDays });
        return true;
      } catch (error) {
        const kind = errorKind(error);
        // A blocking error already recorded by a child must not create a misleading parent failure.
        if (error?.newsRecorded) throw error;
        const failure = { ...window, kind, ...upstreamDiagnostic(error) }; report.failedWindows.push(failure);
        if (mode !== 'download') await store.markFailedWindow({ ...identity, errorCode: ERROR_CODES[kind] });
        log({ type: 'news_window_failed', ...failure });
        if (BLOCKING.has(kind)) throw Object.assign(new Error('资讯同步被阻止。'), { kind, newsRecorded: true, ...upstreamDiagnostic(error) });
        return false;
      }
    };
    log({ type: 'news_start', sourceApi, sourceName, ...range, plannedDays: partitions.length, existingWindows: completed.size });
    for (const window of partitions) {
      if (await visit(window)) report.completedDays++;
      await atomicJson(statusPath, report);
    }
    report.status = report.completedDays === report.plannedDays && report.failedWindows.length === 0 ? 'completed' : 'incomplete';
    if (mode !== 'download') report.database = await store.summary({ from: range.start, to: range.end });
  } catch (error) { report.status = 'incomplete'; report.blockedBy = errorKind(error); Object.assign(report, upstreamDiagnostic(error)); log({ type: 'news_failed', kind: report.blockedBy, ...upstreamDiagnostic(error) }); }
  if (typeof client?.stats === 'function') report.provider = client.stats();
  report.finishedAt = new Date().toISOString(); await atomicJson(statusPath, report); return report;
}

/** Probe availability only; these small responses are not treated as complete downloaded history. */
export async function probeNewsSources(client, { now = new Date() } = {}) {
  const to = Math.floor(new Date(now).getTime() / SECOND) * SECOND, from = to - 3600000, results = [];
  for (const sourceApi of ['major_news', 'news', 'anns_d']) {
    try {
      const params = sourceApi === 'anns_d' ? { start_date: localDate(to).replaceAll('-', ''), end_date: localDate(to).replaceAll('-', '') }
        : { start_date: shanghaiNewsTime(from), end_date: shanghaiNewsTime(to), ...(sourceApi === 'news' ? { src: 'cls' } : {}) };
      const rows = await client.query(sourceApi, params, sourceApi === NEWS_API ? NEWS_FIELDS : '');
      results.push({ sourceApi, status: 'available', sampleRows: rows.length });
    } catch (error) { results.push({ sourceApi, status: errorKind(error) === 'permission' ? 'permission_denied' : 'failed', errorCode: ERROR_CODES[errorKind(error)] }); }
  }
  return results;
}
