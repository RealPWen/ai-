import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { IMA_LIBRARY, makeImaSource, titleDate } from './ima-evidence.mjs';
import { validateMediaURL, downloadHeaders } from '../research-data/ima-sync.mjs';
const run = promisify(execFile);
const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const messages = {
  disabled: '本次未使用 ima 资料：ima 接入未启用。',
  unconfigured: '本次未使用 ima 资料：后端未配置 ima 凭证。',
  quota: 'ima 今日资料获取额度已用尽，本次未使用 ima 资料，继续联网研究。',
  unavailable: '本次未取得可读取的 ima 正文，继续联网研究。',
  no_matches: '本次 ima 搜索未找到匹配研报，继续联网研究。',
  used: '已读取 ima 研报的部分正文，作为联网核验的参考资料。',
};

async function boundedBytes(response, limit) {
  if (!response.ok) { await response.body?.cancel(); throw fail(`IMA_HTTP_${response.status}`); }
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw fail('IMA_SIZE_LIMIT'); }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > limit) throw fail('IMA_SIZE_LIMIT');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function extractImaPdf(bytes, { signal, python = process.env.IMA_PYTHON } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ima-research-'));
  try {
    if (!python) {
      const bundled = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
      try { await access(bundled); python = bundled; } catch { python = 'python3'; }
    }
    const file = path.join(dir, 'report.pdf');
    await writeFile(file, bytes, { mode: 0o600 });
    const { stdout } = await run(python, [fileURLToPath(new URL('../research-data/extract-ima-pdf.py', import.meta.url)), file],
      { signal, timeout: 50000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: homedir(), IMA_TESSERACT: process.env.IMA_TESSERACT || '/opt/homebrew/bin/tesseract' } });
    const result = JSON.parse(stdout);
    if (!Array.isArray(result.pages)) throw fail('IMA_EXTRACTION_FAILED');
    return result.pages;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function createImaRetriever({ enabled = true, credentials, fetchImpl = globalThis.fetch,
  extractPdf = extractImaPdf, now = () => new Date(), intervalMs = 1500, budgetMs = 90000, maxDocuments = 3 } = {}) {
  if (!credentials) {
    try {
      credentials = { clientId: process.env.IMA_OPENAPI_CLIENTID?.trim() || (await readFile(path.join(homedir(), '.config/ima/client_id'), 'utf8')).trim(),
        apiKey: process.env.IMA_OPENAPI_APIKEY?.trim() || (await readFile(path.join(homedir(), '.config/ima/api_key'), 'utf8')).trim() };
    } catch { credentials = {}; }
  }
  const configured = Boolean(credentials.clientId && credentials.apiKey);
  let nextSlot = 0, quotaUntil = 0;
  const cache = new Map();
  async function api(route, payload, signal) {
    if (now().getTime() < quotaUntil) throw fail('IMA_DAILY_ACCESS_QUOTA');
    const slot = Math.max(Date.now(), nextSlot); nextSlot = slot + intervalMs;
    await sleep(Math.max(0, slot - Date.now()), undefined, { signal });
    const response = await fetchImpl(`https://ima.qq.com/openapi/wiki/v1/${route}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      headers: { 'Content-Type': 'application/json', 'ima-openapi-clientid': credentials.clientId, 'ima-openapi-apikey': credentials.apiKey },
      body: JSON.stringify(payload),
    });
    const data = JSON.parse((await boundedBytes(response, 2 * 1024 * 1024)).toString('utf8'));
    if (data.code === 220021) {
      // Suppress repeated requests until the next Shanghai date, then probe
      // only on a new user request. This is not a claim about vendor reset time.
      const t = now().getTime(), day = 86400000, offset = 8 * 3600000;
      quotaUntil = Math.floor((t + offset) / day) * day + day - offset;
      throw fail('IMA_DAILY_ACCESS_QUOTA');
    }
    if (data.code !== 0) throw fail(`IMA_CODE_${Number.isInteger(data.code) ? data.code : 'INVALID'}`);
    return data.data;
  }
  return { configured, enabled,
    async retrieve(input, { signal: parentSignal } = {}) {
      const checkedAt = now().toISOString();
      const outcome = (status, sources = [], extra = {}) => ({ status, message: messages[status], libraryName: IMA_LIBRARY.name, checkedAt, sources, ...extra });
      if (!enabled) return outcome('disabled');
      if (!configured) return outcome('unconfigured');
      const key = JSON.stringify([input.ticker, input.companyName, input.asOf]);
      const cached = cache.get(key);
      if (cached && now().getTime() - cached.time < 30 * 60000) return { ...structuredClone(cached.value), cacheHit: true };
      if (now().getTime() < quotaUntil) return outcome('quota');
      const signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(budgetMs)]);
      const queries = [...new Set([input.companyName, input.ticker.split('.')[0]].filter(Boolean))].slice(0, 2);
      const items = new Map(), sources = [], hashes = new Set();
      let failureCode = null, attemptedDocuments = 0;
      try {
        for (const query of queries) {
          const data = await api('search_knowledge', { query, knowledge_base_id: IMA_LIBRARY.id, cursor: '' }, signal);
          if (!Array.isArray(data?.info_list) || data.info_list.length > 200) throw fail('IMA_INVALID_SEARCH');
          for (const item of data.info_list) {
            if (!item || typeof item.media_id !== 'string' || !/^[A-Za-z0-9_-]{1,240}$/.test(item.media_id) || typeof item.title !== 'string') continue;
            if (!/\.(pdf|txt|md)$/i.test(item.title)) continue;
            if (![input.companyName, input.ticker.split('.')[0]].filter(Boolean).some(term => item.title.toLowerCase().includes(term.toLowerCase()))) continue;
            const date = titleDate(item.title);
            if (date && date > input.asOf) continue;
            items.set(item.media_id, item);
          }
        }
        const sorted = [...items.values()].sort((a, b) => (titleDate(b.title) || '').localeCompare(titleDate(a.title) || ''));
        for (const item of sorted) {
          if (attemptedDocuments >= Math.min(5, maxDocuments) || signal.aborted) break;
          attemptedDocuments++;
          try {
            const data = await api('get_media_info', { media_id: item.media_id }, signal);
            if (![1, 15].includes(data?.media_type) || !data.url_info?.url) continue;
            const url = validateMediaURL(data.url_info.url), headers = downloadHeaders(data.url_info.headers);
            const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
            const bytes = await boundedBytes(response, 24 * 1024 * 1024), hash = sha(bytes);
            if (hashes.has(hash)) continue;
            hashes.add(hash);
            const pdf = data.media_type === 1;
            if (pdf && bytes.subarray(0, 5).toString() !== '%PDF-') continue;
            if (!pdf && /^\s*(?:<!doctype|<html)/i.test(bytes.subarray(0, 100).toString())) continue;
            const pages = pdf ? await extractPdf(bytes, { signal }) : [{ page: 1, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), method: 'text' }];
            const source = makeImaSource(item, pages, { index: sources.length, retrievedAt: now().toISOString(), contentSha256: hash });
            if (source.content.length < 200 || (source.publishedAt && source.publishedAt > input.asOf)) continue;
            // Reposted reports from the same institution/date are one source.
            if (source.publishedAt && source.author !== '未披露' && sources.some(s => s.author === source.author && s.publishedAt === source.publishedAt)) continue;
            sources.push(source);
          } catch (error) {
            failureCode = error.code === 'IMA_DAILY_ACCESS_QUOTA' ? error.code : 'IMA_DOCUMENT_UNAVAILABLE';
            if (error.code === 'IMA_DAILY_ACCESS_QUOTA' || signal.aborted) break;
          }
        }
      } catch (error) { failureCode = error.code === 'IMA_DAILY_ACCESS_QUOTA' ? error.code : 'IMA_RETRIEVAL_UNAVAILABLE'; }
      if (parentSignal?.aborted) throw fail('IMA_RESEARCH_ABORTED');
      const status = sources.length ? 'used' : failureCode === 'IMA_DAILY_ACCESS_QUOTA' ? 'quota' : failureCode || items.size ? 'unavailable' : 'no_matches';
      const value = outcome(status, sources, { queries, attemptedDocuments, partial: Boolean(failureCode), failureCode,
        scope: 'bounded_keyword_search_and_partial_text' });
      if (sources.length) {
        if (cache.size >= 16) cache.delete(cache.keys().next().value);
        cache.set(key, { time: now().getTime(), value: structuredClone(value) });
      }
      return value;
    },
  };
}
