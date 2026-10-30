import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { clsPublicChecksum, normalizeClsList } from './cls-news-list.mjs';
import { matchClsArticle, CLS_SOURCE_API, CLS_SOURCE_NAME } from './cls-news-sync.mjs';
import { createNewsMatcher } from './news-matching.mjs';
import { newsRange } from './news-sync.mjs';

export const CLS_SEARCH_TYPE = 'depth';
export const CLS_SEARCH_DEFAULT_KEYWORD = '财联社';
const PUBLIC_PARAMS = { app: 'CailianpressWeb', os: 'web', sv: '8.7.9' };
const MAX_JSON = 8 * 1024 * 1024;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const problem = (kind, message) => Object.assign(new Error(message), { kind });
const fail = message => { throw problem('validation', message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const iso = value => new Date(value).toISOString();
const rangeKey = range => `${range.start.replace(/[-:.]/g, '')}-${range.end.replace(/[-:.]/g, '')}`;
function keywordValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) fail('公开搜索关键词无效。');
  return value.trim();
}

export function clsPublicSearchRequest({ keyword = CLS_SEARCH_DEFAULT_KEYWORD, page = 0 } = {}) {
  keyword = keywordValue(keyword);
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000) fail('公开搜索页码无效。');
  return { url: `https://www.cls.cn/api/sw?${new URLSearchParams({ ...PUBLIC_PARAMS, sign: clsPublicChecksum(PUBLIC_PARAMS) })}`,
    body: { type: CLS_SEARCH_TYPE, keyword, rn: 20, page, ...PUBLIC_PARAMS } };
}

function responseRows(body) {
  if (!body || typeof body !== 'object' || body.errno == null || Number(body.errno) !== 0) {
    const message = String(body?.msg ?? body?.message ?? body?.errmsg ?? '');
    const kind = /验证码|captcha|人机|安全验证/i.test(message) ? 'captcha' : /权限|登录|授权|unauthor|permission/i.test(message) ? 'permission'
      : /频率|频繁|限流|rate.?limit/i.test(message) ? 'rate_limit' : 'provider';
    throw problem(kind, '财联社公开搜索未正常返回，已停止采集。');
  }
  const rows = body.data?.depth?.data;
  if (!Array.isArray(rows) || rows.length > 1000) throw problem('invalid_response', '财联社公开搜索返回结构变化。');
  return rows;
}
function excluded(row) {
  if (row?.is_ad === true || row?.is_ad === 1 || row?.is_ad === '1') return true;
  if (!row?.external_link) return false;
  try { const url = new URL(row.external_link, 'https://www.cls.cn'); return url.origin !== 'https://www.cls.cn' || url.username || url.password; } catch { return true; }
}
function searchTime(row) {
  const value = typeof row?.time === 'number' ? row.time : /^\d{9,11}$/.test(String(row?.time)) ? Number(row.time) : NaN;
  if (!Number.isSafeInteger(value) || value < 946684800 || value > 4102444800) throw problem('invalid_response', '搜索文章缺少有效发布时间。');
  return value;
}

export function normalizeClsSearchRows(rows, range) {
  if (!Array.isArray(rows)) fail('公开搜索文章列表无效。');
  // Search highlights may wrap each Chinese character separately; removing only
  // those inline markers avoids breaking stock names into disconnected letters.
  const unhighlight = value => typeof value === 'string' ? value.replace(/<\/?em\b[^>]*>/gi, '') : value;
  return normalizeClsList(rows.map(row => ({ ...row, title: unhighlight(row.title), ctime: excluded(row) ? row.time : searchTime(row), brief: unhighlight(row.descr ?? ''),
    stocks: Array.isArray(row.stocks) ? row.stocks.map(stock => ({ stockId: typeof stock === 'string' ? stock : stock?.stockId ?? stock?.stock_id })) : [],
  })), range);
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}`; await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(temporary, path);
}
function checkpointValid(value, keyword) {
  return value?.version === 1 && value.sourceApi === CLS_SOURCE_API && value.searchType === CLS_SEARCH_TYPE && value.searchKeyword === keyword
    && typeof value.start === 'string' && typeof value.end === 'string' && Number.isFinite(Date.parse(value.start)) && Number.isFinite(Date.parse(value.end))
    && iso(value.start) === value.start && iso(value.end) === value.end && value.start < value.end
    && Number.isSafeInteger(value.nextPage) && value.nextPage >= 0 && value.nextPage <= 100000
    && Number.isSafeInteger(value.completedPages) && value.completedPages >= 0
    && Number.isSafeInteger(value.saved) && value.saved >= 0 && Number.isSafeInteger(value.links) && value.links >= 0
    && (value.oldestTime === null || Number.isSafeInteger(value.oldestTime))
    && typeof value.rangeCrossedStart === 'boolean' && typeof value.rangeReachedStart === 'boolean'
    && value.coverageVerified === false && value.historicalPointInTime === false
    && Array.isArray(value.fingerprints) && value.fingerprints.every(fingerprint => /^[a-f0-9]{64}$/.test(fingerprint));
}

/** Public keyword search is a moving index, so date traversal is never a point-in-time completeness claim. */
export async function syncClsNewsSearch({ store, cacheDir, keyword = CLS_SEARCH_DEFAULT_KEYWORD, startDate, endDate, now = new Date(), resume = false,
  maxPages = 1000, intervalMs = 2000, timeoutMs = 15000, maxRetries = 1, fetchImpl = globalThis.fetch,
  sleep = wait, clock = Date.now, log = () => {} } = {}) {
  keyword = keywordValue(keyword);
  if (!store || typeof store.getSecurities !== 'function' || typeof store.saveArticles !== 'function' || typeof store.setSourceStatus !== 'function'
    || typeof cacheDir !== 'string' || !cacheDir || typeof resume !== 'boolean' || resume && (startDate !== undefined || endDate !== undefined)
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5000 || !Number.isInteger(intervalMs) || intervalMs < 2000 || intervalMs > 60000
    || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3
    || typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof clock !== 'function' || typeof log !== 'function') fail('财联社公开搜索采集参数无效。');
  const base = join(cacheDir, 'news', CLS_SOURCE_API, `search-${hash(keyword).slice(0, 24)}`), latestPath = join(base, 'latest.json');
  await mkdir(base, { recursive: true, mode: 0o700 });
  let checkpoint;
  if (resume) {
    let latest;
    try { latest = JSON.parse(await readFile(latestPath, 'utf8')); } catch { fail('没有可恢复的公开搜索采集范围。'); }
    if (!/^\d{8}T\d{9}Z-\d{8}T\d{9}Z$/.test(String(latest.rangeKey))) fail('公开搜索续传范围记录无效。');
    try { checkpoint = JSON.parse(await readFile(join(base, latest.rangeKey, 'checkpoint.json'), 'utf8')); } catch { fail('公开搜索续传进度无法读取。'); }
    if (!checkpointValid(checkpoint, keyword) || rangeKey(checkpoint) !== latest.rangeKey) fail('公开搜索续传进度校验失败。');
  } else {
    checkpoint = { version: 1, sourceApi: CLS_SOURCE_API, sourceName: CLS_SOURCE_NAME, searchType: CLS_SEARCH_TYPE, searchKeyword: keyword,
      ...newsRange({ startDate, endDate, now }), status: 'partial', coverageVerified: false, historicalPointInTime: false,
      nextPage: 0, oldestTime: null, completedPages: 0, saved: 0, links: 0, rangeCrossedStart: false, rangeReachedStart: false, fingerprints: [], warnings: [] };
  }
  const directory = join(base, rangeKey(checkpoint)), pagesDir = join(directory, 'pages'), checkpointPath = join(directory, 'checkpoint.json');
  await mkdir(pagesDir, { recursive: true, mode: 0o700 });
  const report = { ...checkpoint, warnings: Array.isArray(checkpoint.warnings) ? checkpoint.warnings : [], scope: { provider: '财联社', type: CLS_SEARCH_TYPE, keyword },
    startedAt: new Date().toISOString(), finishedAt: null, runPages: 0, requests: 0, cachedPages: 0, runSaved: 0, runLinks: 0, skipped: 0, outOfRange: 0, stopReason: null };
  async function persist() {
    await atomicJson(checkpointPath, report);
    await atomicJson(latestPath, { version: 1, searchType: CLS_SEARCH_TYPE, searchKeyword: keyword, rangeKey: rangeKey(report) });
  }
  let lastRequested = -Infinity;
  async function request(descriptor) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const delay = Math.max(0, lastRequested + intervalMs - clock()); if (delay) await sleep(delay);
      lastRequested = clock(); report.requests++;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await fetchImpl(descriptor.url, { method: 'POST', redirect: 'manual', signal: controller.signal, body: JSON.stringify(descriptor.body),
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'CompanyResearchNewsIndex/1.0 (public search; low frequency)' } });
        if ([403, 429].includes(result.status)) throw problem(result.status === 403 ? 'permission' : 'rate_limit', '官网拒绝公开搜索请求。');
        if (result.status >= 300 && result.status < 400 || result.url && result.url !== descriptor.url) throw problem('invalid_response', '公开搜索出现重定向。');
        if (!result.ok) throw problem(result.status >= 500 ? 'network' : 'invalid_response', '公开搜索请求失败。');
        if (Number(result.headers?.get?.('content-length') ?? 0) > MAX_JSON) throw problem('invalid_response', '公开搜索内容超过大小限制。');
        const text = await result.text(); if (Buffer.byteLength(text) > MAX_JSON) throw problem('invalid_response', '公开搜索内容超过大小限制。');
        try { return JSON.parse(text); } catch { throw problem(/验证码|captcha|安全验证/i.test(text) ? 'captcha' : 'invalid_response', '公开搜索未返回正常 JSON。'); }
      } catch (original) {
        const kind = original.kind ?? (controller.signal.aborted ? 'timeout' : 'network');
        if (!['network', 'timeout'].includes(kind) || attempt >= maxRetries) throw problem(kind, '公开搜索请求未完成。');
      } finally { clearTimeout(timer); }
    }
  }
  await persist();
  if (report.rangeReachedStart) { report.stopReason = 'range_already_reached'; report.finishedAt = new Date().toISOString(); await persist(); return report; }
  try {
    const securities = await store.getSecurities(), matcher = createNewsMatcher(securities);
    for (let count = 0; count < maxPages; count++) {
      const page = report.nextPage, descriptor = clsPublicSearchRequest({ keyword, page }), cachePath = join(pagesDir, `page-${page}.json`);
      let body, fetchedAt, cached = false;
      try {
        const envelope = JSON.parse(await readFile(cachePath, 'utf8'));
        if (envelope.version !== 1 || envelope.page !== page || envelope.searchType !== CLS_SEARCH_TYPE || envelope.searchKeyword !== keyword
          || envelope.start !== report.start || envelope.end !== report.end || !Number.isFinite(Date.parse(envelope.fetchedAt))) throw problem('invalid_response', '公开搜索页缓存校验失败。');
        body = envelope.body; fetchedAt = envelope.fetchedAt; cached = true; report.cachedPages++;
      } catch (original) { if (original.code !== 'ENOENT') throw problem(original.kind ?? 'invalid_response', '公开搜索缓存无法安全读取。'); }
      if (!cached) {
        body = await request(descriptor); fetchedAt = new Date().toISOString(); responseRows(body);
        await atomicJson(cachePath, { version: 1, page, searchType: CLS_SEARCH_TYPE, searchKeyword: keyword, start: report.start, end: report.end, fetchedAt, body });
      }
      const rows = responseRows(body), articleRows = rows.filter(row => !excluded(row));
      if (!rows.length) {
        if (report.rangeCrossedStart) { report.rangeReachedStart = true; report.status = 'range_reached'; report.stopReason = 'search_exhausted_after_start'; }
        else report.stopReason = 'search_index_exhausted';
        break;
      }
      if (!articleRows.length) { report.stopReason = 'no_article_rows'; break; }
      const times = articleRows.map(searchTime), oldest = times.at(-1), newest = times[0];
      const fingerprint = hash(JSON.stringify(articleRows.map(row => [String(row.id), row.time])));
      if (report.fingerprints.includes(fingerprint)) { report.stopReason = 'repeated_page'; break; }
      if (!times.every((value, index) => index === 0 || value <= times[index - 1])) { report.stopReason = 'non_monotonic_page'; break; }
      if (report.oldestTime !== null && oldest > report.oldestTime) { report.stopReason = 'oldest_time_not_descending'; break; }
      if (report.oldestTime !== null && oldest === report.oldestTime) {
        const warning = { kind: 'same_timestamp_boundary', page, oldestTime: oldest, completenessUnverified: true };
        report.warnings.push(warning); log({ type: 'cls_search_warning', ...warning, coverageVerified: false });
      }
      if (report.oldestTime !== null && newest > report.oldestTime) {
        const warning = { kind: 'live_index_overlap', page, previousOldestTime: report.oldestTime, newestTime: newest, historicalPointInTime: false };
        report.warnings.push(warning); log({ type: 'cls_search_warning', ...warning, coverageVerified: false });
      }
      const normalized = normalizeClsSearchRows(rows, { start: report.start, end: report.end, fetchedAt });
      const articles = normalized.records.map(record => record.article), links = normalized.records.flatMap(record => matchClsArticle(record, securities, matcher));
      const saved = await store.saveArticles({ sourceApi: CLS_SOURCE_API, sourceName: CLS_SOURCE_NAME, articles, links, fetchedAt });
      const beforeStart = value => value * 1000 < Date.parse(report.start), confirmed = report.rangeCrossedStart && times.every(beforeStart);
      report.rangeCrossedStart ||= times.some(beforeStart); report.rangeReachedStart ||= confirmed;
      report.completedPages++; report.runPages++; report.nextPage = page + 1; report.oldestTime = oldest; report.fingerprints.push(fingerprint);
      report.saved += saved.rowsCount; report.links += saved.matchedCount; report.runSaved += saved.rowsCount; report.runLinks += saved.matchedCount;
      report.skipped += normalized.skipped; report.outOfRange += normalized.outOfRange;
      if (confirmed) { report.status = 'range_reached'; report.stopReason = 'range_start_confirmed'; }
      await persist();
      log({ type: 'cls_search_page', page, nextPage: report.nextPage, completedPages: report.completedPages, cached, saved: saved.rowsCount, links: saved.matchedCount,
        oldestAt: iso(oldest * 1000), rangeReachedStart: report.rangeReachedStart, coverageVerified: false, historicalPointInTime: false });
      if (confirmed) break;
    }
    report.stopReason ??= 'page_limit';
    const unhealthy = ['repeated_page', 'non_monotonic_page', 'oldest_time_not_descending'].includes(report.stopReason);
    await store.setSourceStatus({ sourceApi: CLS_SOURCE_API, status: unhealthy ? 'failed' : 'available', errorCode: unhealthy ? 'provider_error' : null });
  } catch (original) {
    const kind = ['permission', 'captcha', 'rate_limit', 'network', 'timeout', 'provider', 'invalid_response', 'database', 'validation'].includes(original.kind) ? original.kind : 'unknown';
    report.status = 'partial'; report.stopReason = kind;
    log({ type: 'cls_search_error', kind, page: report.nextPage, completedPages: report.completedPages });
    try { await store.setSourceStatus({ sourceApi: CLS_SOURCE_API, status: kind === 'permission' ? 'permission_denied' : 'failed',
      errorCode: kind === 'permission' ? 'permission_denied' : kind === 'rate_limit' ? 'rate_limited' : kind === 'database' ? 'database_error' : 'provider_error' }); } catch {}
  }
  report.finishedAt = new Date().toISOString(); await persist(); return report;
}
