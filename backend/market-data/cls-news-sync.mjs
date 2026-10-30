import { replaceFile } from '../src/replace-file.mjs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createNewsMatcher } from './news-matching.mjs';
import { newsRange } from './news-sync.mjs';

export const CLS_SOURCE_API = 'cls_web';
export const CLS_SOURCE_NAME = '财联社官网';
const ORIGIN = 'https://www.cls.cn';
const MAX_HTML = 8 * 1024 * 1024;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const problem = (kind, message) => Object.assign(new Error(message), { kind });
const fail = message => { throw problem('validation', message); };
const ARTICLE_PATH = /^\/detail\/([1-9]\d{0,11})$/;
const iso = value => new Date(value).toISOString();
const hashId = id => createHash('sha256').update(JSON.stringify([CLS_SOURCE_API, String(id)])).digest('hex');

/** Only canonical public article pages. No credentials, custom ports, query strings or redirects. */
export function clsArticleUrl(value) {
  if (typeof value !== 'string' || value.length > 300 || /[\s\\%]/.test(value) || value.includes('..')) fail('财联社文章链接无效。');
  let url; try { url = new URL(value, ORIGIN); } catch { fail('财联社文章链接无效。'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || !ARTICLE_PATH.test(url.pathname)) fail('仅支持财联社官网公开文章链接。');
  return url.href;
}

export function discoverClsArticleUrls(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_HTML) fail('财联社首页内容无效。');
  const urls = new Set();
  for (const match of html.matchAll(/\bhref\s*=\s*(["'])([^"']+)\1/gi)) {
    try { urls.add(clsArticleUrl(match[2])); } catch {}
  }
  return [...urls];
}

function entityText(value) {
  return value.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, number) => {
    const point = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : ' ';
  }).replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, name) => ({ nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[name.toLowerCase()]);
}

/** Returned content is plain text, including entity-encoded markup. */
export function clsPlainText(value) {
  if (typeof value !== 'string') return '';
  return entityText(entityText(value)).replace(/<(script|style|iframe|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])\s*>/gi, '\n').replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function restrictedArticle(detail, content) {
  return detail.isFree === false || detail.isFree === 0 || detail.isFree === '0'
    || ['isPaid', 'needPay', 'needLogin', 'loginRequired', 'isLocked'].some(key => detail[key] === true || detail[key] === 1 || detail[key] === '1')
    || /(?:付费|订阅|购买|登录|登陆)后(?:可)?(?:阅读|查看)(?:全文|完整内容)|(?:全文|完整内容)(?:需|请)(?:付费|订阅|购买|登录)/.test(content);
}

export function parseClsArticle(html, { url, start, end, fetchedAt = new Date().toISOString() } = {}) {
  const canonical = clsArticleUrl(url), requestedId = new URL(canonical).pathname.match(ARTICLE_PATH)[1];
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_HTML) throw problem('invalid_response', '财联社文章内容无效。');
  const script = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .find(match => /\bid\s*=\s*(["'])__NEXT_DATA__\1/.test(match[1]));
  let detail; try { detail = JSON.parse(script?.[2] ?? '').props.pageProps.articleDetail; } catch { throw problem('invalid_response', '公开页面未提供可校验的文章数据。'); }
  if (!detail || typeof detail !== 'object' || String(detail.id) !== requestedId) throw problem('invalid_response', '文章 ID 与请求链接不一致。');
  const title = clsPlainText(detail.title), rawContent = typeof detail.content === 'string' ? detail.content : '';
  const timestamp = typeof detail.ctime === 'number' ? detail.ctime : /^\d{9,11}$/.test(String(detail.ctime)) ? Number(detail.ctime) : NaN;
  if (!title || title.length > 5000 || rawContent.length > 4000000 || !Number.isSafeInteger(timestamp) || timestamp < 946684800 || timestamp > 4102444800
    || !Number.isFinite(Date.parse(fetchedAt))) throw problem('invalid_response', '文章标题、日期或正文无效。');
  const publishedAt = iso(timestamp * 1000);
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || start >= end) fail('财联社采集范围无效。');
  if (publishedAt < start || publishedAt >= end) return null;
  const content = clsPlainText(rawContent), restricted = restrictedArticle(detail, content);
  const stockIds = Array.isArray(detail.stocks) ? [...new Set(detail.stocks.map(stock => stock?.stockId).filter(value => typeof value === 'string' && value.length <= 30))] : [];
  return { article: { id: hashId(requestedId), sourceApi: CLS_SOURCE_API, sourceName: CLS_SOURCE_NAME,
    title, content: restricted ? '' : content, publishedAt, url: canonical, fetchedAt: iso(fetchedAt) }, stockIds, restricted };
}

export function matchClsArticle(record, securities, matcher = createNewsMatcher(securities)) {
  const valid = new Set(securities.map(row => String(row.ticker ?? row.ts_code ?? '').toUpperCase()));
  const links = new Map(matcher(record.article).map(link => [link.ticker, link]));
  for (const stockId of record.stockIds ?? []) {
    const code = String(stockId).toUpperCase();
    const normalized = /^(SH|SZ|BJ)(\d{6})$/.exec(code);
    const ticker = normalized ? `${normalized[2]}.${normalized[1]}` : /^\d{6}\.(SH|SZ|BJ)$/.test(code) ? code : null;
    if (!ticker || !valid.has(ticker)) continue;
    const prior = links.get(ticker);
    links.set(ticker, { ticker, articleId: record.article.id, matchType: 'source_tag', matchedTerms: [...new Set([...(prior?.matchedTerms ?? []), stockId])].slice(0, 20) });
  }
  return [...links.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

async function atomicJson(path, data) {
  const temporary = `${path}.tmp-${process.pid}`; await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 }); await replaceFile(temporary, path);
}

function validCache(value, url) {
  const article = value?.record?.article;
  return value?.version === 1 && value.sourceApi === CLS_SOURCE_API && value.url === url && article?.url === url
    && article.id === hashId(new URL(url).pathname.match(ARTICLE_PATH)[1]) && article.sourceApi === CLS_SOURCE_API && article.sourceName === CLS_SOURCE_NAME
    && typeof article.title === 'string' && article.title.length > 0 && article.title.length <= 5000
    && typeof article.content === 'string' && article.content.length <= 4000000 && article.content === clsPlainText(article.content)
    && Number.isFinite(Date.parse(article.publishedAt)) && iso(article.publishedAt) === article.publishedAt && Number.isFinite(Date.parse(article.fetchedAt))
    && Array.isArray(value.record.stockIds) && value.record.stockIds.every(id => typeof id === 'string' && id.length <= 30)
    && typeof value.record.restricted === 'boolean' && (!value.record.restricted || article.content === '');
}

/** Public HTML discovery cannot establish exhaustive historical coverage; every report remains partial. */
export async function syncClsNews({ store, cacheDir, urls = [], includeHomepage = true, mode = 'sync', startDate, endDate,
  now = new Date(), maxArticles = 200, intervalMs = 2000, timeoutMs = 15000, maxRetries = 1,
  fetchImpl = globalThis.fetch, sleep = pause, clock = Date.now, log = () => {} } = {}) {
  const range = newsRange({ startDate, endDate, now });
  if (!['sync', 'download', 'import'].includes(mode) || typeof cacheDir !== 'string' || !cacheDir || !Array.isArray(urls) || urls.length > 10000
    || !Number.isInteger(maxArticles) || maxArticles < 1 || maxArticles > 1000 || !Number.isInteger(intervalMs) || intervalMs < 2000 || intervalMs > 60000
    || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3
    || typeof includeHomepage !== 'boolean' || typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof clock !== 'function' || typeof log !== 'function'
    || mode !== 'download' && !store) fail('财联社采集参数无效。');
  const seeds = new Set(urls.map(clsArticleUrl));
  const directory = join(cacheDir, 'news', CLS_SOURCE_API), articlesDir = join(directory, 'articles');
  await mkdir(articlesDir, { recursive: true, mode: 0o700 });
  const statusFile = join(directory, `status-${range.start.replace(/[-:.]/g, '')}-${range.end.replace(/[-:.]/g, '')}-${mode}.json`);
  const report = { version: 1, sourceApi: CLS_SOURCE_API, sourceName: CLS_SOURCE_NAME, ...range, mode,
    status: 'partial', coverageVerified: false, startedAt: new Date().toISOString(), finishedAt: null,
    discovered: 0, attempted: 0, fetched: 0, newArticlesRequested: 0, cached: 0, saved: 0, links: 0, outOfRange: 0, restricted: 0, failed: 0, requests: 0, stopReason: null,
    discovery: 'public_homepage_and_explicit_urls', failures: [] };
  let lastRequest = -Infinity, stop = false;
  async function request(url) {
    for (let retry = 0; retry <= maxRetries; retry++) {
      const delay = Math.max(0, lastRequest + intervalMs - clock()); if (delay) await sleep(delay);
      lastRequest = clock(); report.requests++;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'text/html', 'User-Agent': 'CompanyResearchNewsIndex/1.0 (public HTML; low frequency)' } });
        if (response.status === 403 || response.status === 429) throw problem(response.status === 429 ? 'rate_limit' : 'permission', '官网拒绝请求，采集已停止。');
        if (response.status >= 300 && response.status < 400 || response.url && response.url !== url) throw problem('invalid_response', '公开文章发生重定向，未继续请求。');
        if (!response.ok) throw problem(response.status >= 500 ? 'network' : 'invalid_response', '公开页面请求失败。');
        const type = response.headers?.get?.('content-type');
        if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) throw problem('invalid_response', '返回内容不是公开网页。');
        const length = Number(response.headers?.get?.('content-length') ?? 0);
        if (length > MAX_HTML) throw problem('invalid_response', '公开页面超过采集大小限制。');
        const text = await response.text();
        if (Buffer.byteLength(text) > MAX_HTML) throw problem('invalid_response', '公开页面超过采集大小限制。');
        return text;
      } catch (error) {
        const kind = error?.kind ?? (controller.signal.aborted ? 'timeout' : 'network');
        if (['permission', 'rate_limit', 'invalid_response'].includes(kind) || retry >= maxRetries) throw problem(kind, '财联社公开页面请求未完成。');
      } finally { clearTimeout(timer); }
    }
  }
  async function recordFailure(error, url = null) {
    const kind = ['permission', 'rate_limit', 'network', 'timeout', 'invalid_response', 'validation', 'database'].includes(error?.kind) ? error.kind : 'unknown';
    report.failed++; report.failures.push({ url, kind });
    if (['permission', 'rate_limit', 'database'].includes(kind)) { stop = true; report.stopReason = kind; }
    log({ type: 'cls_news_error', kind, url });
  }
  try {
    const securities = store ? await store.getSecurities() : [], matcher = createNewsMatcher(securities);
    if (mode === 'import' && !seeds.size) {
      for (const file of (await readdir(articlesDir)).sort()) if (/^[1-9]\d{0,11}\.json$/.test(file)) seeds.add(`${ORIGIN}/detail/${file.slice(0, -5)}`);
    }
    if (mode !== 'import' && includeHomepage) {
      try { for (const url of discoverClsArticleUrls(await request(`${ORIGIN}/`))) seeds.add(url); }
      catch (error) { await recordFailure(error); }
    }
    report.discovered = seeds.size;
    for (const url of seeds) {
      if (stop) break;
      if (mode === 'import' && report.attempted >= maxArticles) { report.stopReason = 'article_limit'; break; }
      report.attempted++;
      const id = new URL(url).pathname.match(ARTICLE_PATH)[1], cachePath = join(articlesDir, `${id}.json`);
      try {
        let record, cached = false;
        try {
          const envelope = JSON.parse(await readFile(cachePath, 'utf8'));
          if (!validCache(envelope, url)) throw problem('invalid_response', '文章缓存校验失败。');
          record = envelope.record; cached = true;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (cached) {
          report.cached++;
          if (record.article.publishedAt < range.start || record.article.publishedAt >= range.end) { report.outOfRange++; continue; }
        } else {
          if (mode === 'import') { report.failed++; report.failures.push({ url, kind: 'missing_cache' }); continue; }
          // Cached seeds must not consume the next run's download budget, or repeated
          // runs would permanently stop at the same first N article URLs.
          if (report.newArticlesRequested >= maxArticles) { report.attempted--; report.stopReason = 'article_limit'; break; }
          report.newArticlesRequested++;
          record = parseClsArticle(await request(url), { url, ...range, fetchedAt: new Date().toISOString() }); report.fetched++;
          if (!record) { report.outOfRange++; continue; }
          await atomicJson(cachePath, { version: 1, sourceApi: CLS_SOURCE_API, url, record });
        }
        if (record.restricted) report.restricted++;
        const links = matchClsArticle(record, securities, matcher);
        if (store) {
          const result = await store.saveArticles({ sourceApi: CLS_SOURCE_API, sourceName: CLS_SOURCE_NAME, articles: [record.article], links, fetchedAt: record.article.fetchedAt });
          report.saved += result.rowsCount; report.links += result.matchedCount;
        }
        log({ type: 'cls_news_article', url, cached, restricted: record.restricted, matched: links.length });
      } catch (error) { await recordFailure(error, url); }
      await atomicJson(statusFile, report);
    }
    report.stopReason ??= 'public_discovery_exhausted';
    if (store) await store.setSourceStatus({ sourceApi: CLS_SOURCE_API, status: report.saved > 0 && !stop ? 'available' : 'failed',
      errorCode: report.stopReason === 'rate_limit' ? 'rate_limited' : report.stopReason === 'permission' ? 'permission_denied' : 'provider_error' });
  } catch (error) { await recordFailure(error); report.stopReason ??= 'runtime_failure'; }
  report.finishedAt = new Date().toISOString(); await atomicJson(statusFile, report);
  return report;
}
