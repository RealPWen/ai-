import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { clsPlainText, matchClsArticle, CLS_SOURCE_API, CLS_SOURCE_NAME } from './cls-news-sync.mjs';
import { createNewsMatcher } from './news-matching.mjs';
import { newsRange } from './news-sync.mjs';

export const CLS_CHANNEL_ID = '1003';
const ORIGIN = 'https://www.cls.cn';
const PARAMS = { app: 'CailianpressWeb', os: 'web', sv: '8.7.9' };
const MAX_JSON = 8 * 1024 * 1024;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const error = (kind, message) => Object.assign(new Error(message), { kind });
const fail = message => { throw error('validation', message); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const instant = value => new Date(value).toISOString();

/** Public client checksum, derived entirely from anonymous, non-secret query parameters. */
export function clsPublicChecksum(params) {
  const raw = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
  return createHash('md5').update(createHash('sha1').update(raw).digest('hex')).digest('hex');
}

export function clsPublicListUrl(cursor = null) {
  if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 946684800 || cursor > 4102444800)) fail('财联社公开列表时间游标无效。');
  const params = cursor === null ? { ...PARAMS } : { ...PARAMS, id: CLS_CHANNEL_ID, last_time: String(cursor), rn: '20' };
  return `${ORIGIN}/v3/depth/${cursor === null ? 'home/assembled' : 'list'}/${CLS_CHANNEL_ID}?${new URLSearchParams({ ...params, sign: clsPublicChecksum(params) })}`;
}

function published(row) {
  const seconds = typeof row?.ctime === 'number' ? row.ctime : /^\d{9,11}$/.test(String(row?.ctime)) ? Number(row.ctime) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 946684800 || seconds > 4102444800) throw error('invalid_response', '财联社列表文章时间无效。');
  return seconds;
}
function ad(row) { return row?.is_ad === true || row?.is_ad === 1 || row?.is_ad === '1'; }
function external(row) {
  if (!row?.external_link) return false;
  if (typeof row.external_link !== 'string') return true;
  try { const url = new URL(row.external_link, ORIGIN); return url.origin !== ORIGIN || url.username || url.password; } catch { return true; }
}

/** Briefs remain explicitly labelled summaries; list indexing never claims to have fetched full text. */
export function normalizeClsList(rows, { start, end, fetchedAt } = {}) {
  if (!Array.isArray(rows) || rows.length > 1000 || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || start >= end
    || !Number.isFinite(Date.parse(fetchedAt))) fail('财联社列表或采集范围无效。');
  const records = new Map(); let skipped = 0, outOfRange = 0;
  for (const row of rows) {
    if (ad(row) || external(row)) { skipped++; continue; }
    const id = String(row?.id ?? '');
    if (!/^[1-9]\d{0,11}$/.test(id) || typeof row?.title !== 'string' || typeof row.brief !== 'string' && row.brief != null) throw error('invalid_response', '财联社列表缺少有效文章 ID、标题或摘要。');
    const publishedAt = instant(published(row) * 1000), title = clsPlainText(row.title), brief = clsPlainText(row.brief ?? '');
    if (!title || title.length > 5000 || brief.length > 1000000) throw error('invalid_response', '财联社列表标题或摘要无效。');
    if (publishedAt < start || publishedAt >= end) { outOfRange++; continue; }
    const article = { id: sha256(JSON.stringify([CLS_SOURCE_API, id])), sourceApi: CLS_SOURCE_API, sourceName: CLS_SOURCE_NAME,
      title, content: brief, contentKind: brief ? 'summary' : 'none', publishedAt, fetchedAt: instant(fetchedAt), url: `${ORIGIN}/detail/${id}` };
    const stockIds = Array.isArray(row.stocks) ? row.stocks.map(stock => stock?.stockId).filter(value => typeof value === 'string' && value.length <= 30) : [];
    records.set(article.id, { article, stockIds, restricted: false });
  }
  return { records: [...records.values()], skipped, outOfRange };
}

function listRows(body, bootstrap) {
  if (!body || typeof body !== 'object' || Number(body.errno) !== 0 || body.errno == null) {
    const message = String(body?.msg ?? body?.message ?? body?.errmsg ?? '');
    const kind = /验证码|captcha|人机|安全验证/i.test(message) ? 'captcha' : /登录|权限|授权|permission|unauthor/i.test(message) ? 'permission'
      : /频率|频繁|限流|rate.?limit/i.test(message) ? 'rate_limit' : 'provider';
    throw error(kind, '财联社公开列表未正常返回，已停止采集。');
  }
  const rows = bootstrap ? body.data?.depth_list : body.data;
  if (!Array.isArray(rows) || rows.length > 1000) throw error('invalid_response', '财联社公开列表结构发生变化。');
  return rows;
}

async function jsonFile(path, value) {
  const temporary = `${path}.tmp-${process.pid}`; await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(temporary, path);
}
const rangeKey = range => `${range.start.replace(/[-:.]/g, '')}-${range.end.replace(/[-:.]/g, '')}`;
const validRange = range => range && Number.isFinite(Date.parse(range.start)) && Number.isFinite(Date.parse(range.end))
  && instant(range.start) === range.start && instant(range.end) === range.end && range.start < range.end;
function validCheckpoint(checkpoint) {
  return checkpoint?.version === 1 && checkpoint.sourceApi === CLS_SOURCE_API && checkpoint.channelId === CLS_CHANNEL_ID && validRange(checkpoint)
    && [null, 'number'].includes(checkpoint.cursor === null ? null : typeof checkpoint.cursor)
    && (checkpoint.cursor === null || Number.isSafeInteger(checkpoint.cursor)) && ['bootstrap', 'list'].includes(checkpoint.stage)
    && Number.isSafeInteger(checkpoint.completedPages) && checkpoint.completedPages >= 0 && checkpoint.completedPages <= 100000
    && Number.isSafeInteger(checkpoint.saved) && checkpoint.saved >= 0 && Number.isSafeInteger(checkpoint.links) && checkpoint.links >= 0
    && typeof checkpoint.rangeCrossedStart === 'boolean' && typeof checkpoint.rangeReachedStart === 'boolean'
    && checkpoint.coverageVerified === false && Array.isArray(checkpoint.fingerprints) && checkpoint.fingerprints.every(value => /^[a-f0-9]{64}$/.test(value));
}

/** Index one public column with a descending time cursor; this does not prove whole-site coverage. */
export async function syncClsNewsList({ store, cacheDir, startDate, endDate, now = new Date(), resume = false, maxPages = 1000,
  intervalMs = 2000, timeoutMs = 15000, maxRetries = 1, fetchImpl = globalThis.fetch, sleep = wait, clock = Date.now, log = () => {} } = {}) {
  if (!store || typeof store.getSecurities !== 'function' || typeof store.saveArticles !== 'function' || typeof store.setSourceStatus !== 'function'
    || typeof cacheDir !== 'string' || !cacheDir || typeof resume !== 'boolean' || resume && (startDate !== undefined || endDate !== undefined)
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5000 || !Number.isInteger(intervalMs) || intervalMs < 2000 || intervalMs > 60000
    || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3
    || typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof clock !== 'function' || typeof log !== 'function') fail('财联社历史列表采集参数无效。');
  const base = join(cacheDir, 'news', CLS_SOURCE_API, `channel-${CLS_CHANNEL_ID}`), latestPath = join(base, 'latest.json');
  await mkdir(base, { recursive: true, mode: 0o700 });
  let checkpoint;
  if (resume) {
    let latest;
    try { latest = JSON.parse(await readFile(latestPath, 'utf8')); } catch { fail('未找到可恢复的财联社栏目采集范围。'); }
    if (typeof latest?.rangeKey !== 'string' || !/^\d{8}T\d{9}Z-\d{8}T\d{9}Z$/.test(latest.rangeKey)) fail('财联社续传范围记录无效。');
    try { checkpoint = JSON.parse(await readFile(join(base, latest.rangeKey, 'checkpoint.json'), 'utf8')); } catch { fail('财联社续传进度无法读取。'); }
    if (!validCheckpoint(checkpoint) || rangeKey(checkpoint) !== latest.rangeKey) fail('财联社续传进度校验失败。');
  } else {
    const range = newsRange({ startDate, endDate, now });
    checkpoint = { version: 1, sourceApi: CLS_SOURCE_API, sourceName: CLS_SOURCE_NAME, channelId: CLS_CHANNEL_ID, ...range,
      status: 'partial', coverageVerified: false, rangeCrossedStart: false, rangeReachedStart: false, stage: 'bootstrap', cursor: null,
      completedPages: 0, saved: 0, links: 0, fingerprints: [], warnings: [], stopReason: null };
  }
  const directory = join(base, rangeKey(checkpoint)), pagesDir = join(directory, 'pages'), checkpointPath = join(directory, 'checkpoint.json');
  await mkdir(pagesDir, { recursive: true, mode: 0o700 });
  const report = { ...checkpoint, warnings: Array.isArray(checkpoint.warnings) ? checkpoint.warnings : [], startedAt: new Date().toISOString(), finishedAt: null, runPages: 0, requests: 0, cachedPages: 0,
    runSaved: 0, runLinks: 0, skipped: 0, outOfRange: 0, scope: '财联社深度栏目1003', stopReason: null };
  let lastRequest = -Infinity;
  async function persist() {
    await jsonFile(checkpointPath, report);
    await jsonFile(latestPath, { version: 1, channelId: CLS_CHANNEL_ID, rangeKey: rangeKey(report) });
  }
  async function request(url) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const delay = Math.max(0, lastRequest + intervalMs - clock()); if (delay) await sleep(delay);
      lastRequest = clock(); report.requests++;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'application/json', 'User-Agent': 'CompanyResearchNewsIndex/1.0 (public column; low frequency)' } });
        if ([403, 429].includes(response.status)) throw error(response.status === 403 ? 'permission' : 'rate_limit', '财联社官网拒绝请求。');
        if (response.status >= 300 && response.status < 400 || response.url && response.url !== url) throw error('invalid_response', '财联社列表发生重定向。');
        if (!response.ok) throw error(response.status >= 500 ? 'network' : 'invalid_response', '财联社公开列表请求失败。');
        const length = Number(response.headers?.get?.('content-length') ?? 0); if (length > MAX_JSON) throw error('invalid_response', '财联社列表超过大小限制。');
        const text = await response.text(); if (Buffer.byteLength(text) > MAX_JSON) throw error('invalid_response', '财联社列表超过大小限制。');
        try { return JSON.parse(text); } catch { throw error(/验证码|captcha|安全验证/i.test(text) ? 'captcha' : 'invalid_response', '财联社列表未返回正常 JSON。'); }
      } catch (original) {
        const kind = original.kind ?? (controller.signal.aborted ? 'timeout' : 'network');
        if (!['network', 'timeout'].includes(kind) || attempt === maxRetries) throw error(kind, '财联社列表请求未完成。');
      } finally { clearTimeout(timer); }
    }
  }
  await persist();
  if (report.rangeReachedStart) { report.status = 'range_reached'; report.stopReason = 'range_already_reached'; report.finishedAt = new Date().toISOString(); await persist(); return report; }
  try {
    const securities = await store.getSecurities(), matcher = createNewsMatcher(securities);
    for (let page = 0; page < maxPages; page++) {
      const bootstrap = report.stage === 'bootstrap', requestedCursor = bootstrap ? null : report.cursor, url = clsPublicListUrl(requestedCursor);
      const cachePath = join(pagesDir, bootstrap ? 'bootstrap.json' : `cursor-${requestedCursor}.json`);
      let body, fetchedAt, cached = false;
      try {
        const envelope = JSON.parse(await readFile(cachePath, 'utf8'));
        if (envelope.version !== 1 || envelope.channelId !== CLS_CHANNEL_ID || envelope.url !== url || envelope.requestedCursor !== requestedCursor
          || envelope.start !== report.start || envelope.end !== report.end || !Number.isFinite(Date.parse(envelope.fetchedAt))) throw error('invalid_response', '财联社列表缓存校验失败。');
        body = envelope.body; fetchedAt = envelope.fetchedAt; cached = true; report.cachedPages++;
      } catch (original) { if (original.code !== 'ENOENT') throw error(original.kind ?? 'invalid_response', '财联社列表缓存无法安全恢复。'); }
      if (!cached) {
        body = await request(url); fetchedAt = new Date().toISOString();
        listRows(body, bootstrap);
        await jsonFile(cachePath, { version: 1, channelId: CLS_CHANNEL_ID, start: report.start, end: report.end, requestedCursor, url, fetchedAt, body });
      }
      const rows = listRows(body, bootstrap);
      if (!rows.length) { report.stopReason = 'empty_page'; break; }
      const articleRows = rows.filter(row => !ad(row) && !external(row));
      if (!articleRows.length) { report.stopReason = 'no_article_rows'; break; }
      const times = articleRows.map(published), nextCursor = times.at(-1);
      const fingerprint = sha256(JSON.stringify(rows.map(row => [String(row.id), row.ctime])));
      if (report.fingerprints.includes(fingerprint)) { report.stopReason = 'repeated_page'; break; }
      if (requestedCursor !== null && nextCursor >= requestedCursor) { report.stopReason = 'cursor_not_descending'; break; }
      const ordered = times.every((value, index) => index === 0 || value <= times[index - 1]);
      if (!ordered) { report.stopReason = 'non_monotonic_page'; break; }
      if (times.filter(value => value === nextCursor).length > 1) {
        const warning = { kind: 'cursor_second_tie', cursor: nextCursor, completenessUnverified: true };
        report.warnings.push(warning); log({ type: 'cls_list_warning', ...warning, coverageVerified: false });
      }
      const normalized = normalizeClsList(rows, { start: report.start, end: report.end, fetchedAt });
      const articles = normalized.records.map(record => record.article), links = normalized.records.flatMap(record => matchClsArticle(record, securities, matcher));
      // Store completion precedes cursor persistence. Repeating an interrupted write is idempotent.
      const result = await store.saveArticles({ sourceApi: CLS_SOURCE_API, sourceName: CLS_SOURCE_NAME, articles, links, fetchedAt });
      const beforeStart = value => value * 1000 < Date.parse(report.start);
      const confirmed = report.rangeCrossedStart && ordered && times.every(beforeStart);
      report.rangeCrossedStart ||= times.some(beforeStart); report.rangeReachedStart ||= confirmed;
      report.completedPages++; report.runPages++; report.saved += result.rowsCount; report.links += result.matchedCount;
      report.runSaved += result.rowsCount; report.runLinks += result.matchedCount; report.skipped += normalized.skipped; report.outOfRange += normalized.outOfRange;
      report.fingerprints.push(fingerprint); report.stage = 'list'; report.cursor = nextCursor;
      if (confirmed) { report.status = 'range_reached'; report.stopReason = 'range_start_confirmed'; }
      await persist();
      log({ type: 'cls_list_page', channelId: CLS_CHANNEL_ID, completedPages: report.completedPages, cached, saved: result.rowsCount,
        links: result.matchedCount, cursor: nextCursor, oldestAt: instant(nextCursor * 1000), rangeReachedStart: report.rangeReachedStart, coverageVerified: false });
      if (confirmed) break;
    }
    report.stopReason ??= 'page_limit';
    const unhealthy = ['cursor_not_descending', 'repeated_page', 'non_monotonic_page'].includes(report.stopReason);
    await store.setSourceStatus({ sourceApi: CLS_SOURCE_API, status: unhealthy ? 'failed' : 'available', errorCode: unhealthy ? 'provider_error' : null });
  } catch (original) {
    const kind = ['permission', 'captcha', 'rate_limit', 'network', 'timeout', 'provider', 'invalid_response', 'database', 'validation'].includes(original.kind) ? original.kind : 'unknown';
    report.status = 'partial'; report.stopReason = kind;
    log({ type: 'cls_list_error', kind, channelId: CLS_CHANNEL_ID, cursor: report.cursor, completedPages: report.completedPages });
    try { await store.setSourceStatus({ sourceApi: CLS_SOURCE_API, status: kind === 'permission' ? 'permission_denied' : 'failed',
      errorCode: kind === 'permission' ? 'permission_denied' : kind === 'rate_limit' ? 'rate_limited' : kind === 'database' ? 'database_error' : 'provider_error' }); } catch {}
  }
  report.finishedAt = new Date().toISOString(); await persist(); return report;
}
