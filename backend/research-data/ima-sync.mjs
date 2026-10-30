import { readFile, writeFile, mkdir, chmod, open, stat, statfs, rename, unlink, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const LIBRARY = { id: 'ima_kb_LJNC7uye', name: '彭博社➕国际投行研报' };
const DEFAULT_ROOT = fileURLToPath(new URL('../storage/research-data/ima/', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class SyncError extends Error {
  constructor(code, { retryable = false, fatal = false } = {}) { super(code); this.code = code; this.retryable = retryable; this.fatal = fatal; }
}
const errorCode = e => e instanceof SyncError ? e.code : 'LOCAL_OR_NETWORK_ERROR';
const digest = value => createHash('sha256').update(value).digest('hex');

export function validateMediaURL(value) {
  let u; try { u = new URL(value); } catch { throw new SyncError('INVALID_MEDIA_URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !/(^|\.)myqcloud\.com$/.test(u.hostname)) throw new SyncError('EXTERNAL_OR_UNSUPPORTED_SOURCE');
  return u;
}
export function downloadHeaders(value = {}) {
  const h = new Headers();
  for (const [k, v] of Object.entries(value)) {
    if (/^(ima-openapi-|host$|cookie$|proxy-)/i.test(k) || /[\r\n]/.test(String(v))) throw new SyncError('INVALID_MEDIA_HEADERS');
    h.set(k, String(v));
  }
  return h;
}
export function nextCatalogPage(data, currentCursor) {
  if (!data || !Array.isArray(data.knowledge_list) || typeof data.is_end !== 'boolean') throw new SyncError('INVALID_CATALOG_RESPONSE');
  if (!data.is_end && (!data.knowledge_list.length || typeof data.next_cursor !== 'string' || !data.next_cursor || data.next_cursor === currentCursor)) throw new SyncError('NONADVANCING_CATALOG_CURSOR');
  for (const item of data.knowledge_list) if (!item || typeof item.media_id !== 'string' || !item.media_id || typeof item.title !== 'string' || !Number.isInteger(item.media_type)) throw new SyncError('INVALID_CATALOG_ITEM');
  return { items: data.knowledge_list, cursor: data.is_end ? '' : data.next_cursor, done: data.is_end };
}
export function validFilePrefix(type, prefix) {
  if (type === 1) return prefix.subarray(0, 5).toString() === '%PDF-';
  if (/^\s*(?:<!doctype html|<html)/i.test(prefix.toString('utf8'))) return false;
  return prefix.length > 0;
}
export function unwrapAPIResult(result) {
  if (result?.code === 0) return result.data;
  if (result?.code === 220021) throw new SyncError('IMA_DAILY_ACCESS_QUOTA', { fatal: true });
  throw new SyncError(`IMA_CODE_${Number.isInteger(result?.code) ? result.code : 'UNKNOWN'}`, {
    retryable: [110010, 110021].includes(result?.code),
    fatal: /api.?key|client.?id|鉴权|认证|密钥|令牌|登录失效/i.test(result?.msg ?? ''),
  });
}

export async function createImaAPI({ intervalMs = 2000, fetchImpl = fetch } = {}) {
  const dir = path.join(homedir(), '.config/ima');
  const client = (await readFile(path.join(dir, 'client_id'), 'utf8')).trim();
  const key = (await readFile(path.join(dir, 'api_key'), 'utf8')).trim();
  if (!client || !key) throw new SyncError('IMA_CREDENTIALS_MISSING', { fatal: true });
  let nextSlot = 0;
  return async (route, payload) => {
    if (!['get_knowledge_base', 'search_knowledge_base', 'get_knowledge_list', 'get_media_info'].includes(route)) throw new SyncError('READ_ONLY_API_ONLY');
    for (let attempt = 0; attempt < 3; attempt++) {
      const slot = Math.max(Date.now(), nextSlot); nextSlot = slot + intervalMs;
      await sleep(Math.max(0, slot - Date.now()));
      try {
        const response = await fetchImpl(`https://ima.qq.com/openapi/wiki/v1/${route}`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(35000),
          headers: { 'Content-Type': 'application/json', 'ima-openapi-clientid': client, 'ima-openapi-apikey': key },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          // A later identical catalog request succeeded after an HTTP 403.
          // Retain credentials/route, reduce load, and allow only bounded cooldown retries.
          // Explicit authentication/permission errors remain terminal.
          let errorBody = ''; try { errorBody = (await response.text()).slice(0, 2000); } catch {}
          const explicitAuth = /invalid.{0,20}(?:api.?key|client.?id)|无权限|权限不足|鉴权失败|认证失败|密钥.{0,8}(?:失效|无效)/i.test(errorBody);
          const canRetry = response.status === 429 || response.status >= 500 || (response.status === 403 && !explicitAuth);
          throw new SyncError(`IMA_HTTP_${response.status}`, { retryable: canRetry, fatal: response.status === 401 || (response.status === 403 && explicitAuth) });
        }
        const raw = await response.text();
        if (raw.length > 8 * 1024 * 1024) throw new SyncError('IMA_RESPONSE_TOO_LARGE');
        let result; try { result = JSON.parse(raw); } catch { throw new SyncError('IMA_INVALID_JSON', { retryable: true }); }
        return unwrapAPIResult(result);
      } catch (rawError) {
        const e = rawError instanceof SyncError ? rawError : new SyncError('IMA_NETWORK_ERROR', { retryable: true });
        if (!e.retryable || attempt === 2) { if (e.code === 'IMA_HTTP_403') e.fatal = true; throw e; }
        const delay = e.code === 'IMA_HTTP_403' ? 60000 : e.code.includes('429') || e.code.includes('110021') ? 30000 : (attempt + 1) * 3000;
        nextSlot = Math.max(nextSlot, Date.now() + delay);
        console.log(JSON.stringify({ time: new Date().toISOString(), event: 'api_cooldown', code: e.code, seconds: delay / 1000 }));
        await sleep(delay);
      }
    }
  };
}

export async function syncIma({ mode = 'sync', workers = 3, root = DEFAULT_ROOT, reserveBytes = 15 * 1024 ** 3, maxDownloads = Infinity, retryErrors = false } = {}) {
  if (!['sync', 'catalog', 'download', 'status'].includes(mode)) throw new SyncError('INVALID_MODE');
  if (!process.env.DATABASE_URL) throw new SyncError('DATABASE_CONFIGURATION_MISSING');
  process.umask(0o077);
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: workers + 4, connectionTimeoutMillis: 10000 });
  pool.on('error', () => {});
  const sql = (s, p) => pool.query(s, p);
  const lib = LIBRARY.id;
  let lock, runId, stopReason = null, stopped = false, catalogFinished = mode === 'download', completedHere = 0, timer, progressPromise = Promise.resolve();
  const stop = code => { stopped = true; stopReason ||= code; };
  const onTerm = () => stop('INTERRUPTED');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onTerm);
  const freeBytes = async () => { const s = await statfs(root); return s.bavail * s.bsize; };
  const requireSpace = async bytes => { if (await freeBytes() < reserveBytes + bytes) throw new SyncError('DISK_RESERVE_REACHED', { fatal: true }); };
  const log = value => console.log(JSON.stringify({ time: new Date().toISOString(), ...value }));

  async function snapshot() {
    const [folders, documents, library] = await Promise.all([
      sql('SELECT status,count(*)::int AS count FROM research_data.ima_folders WHERE library_id=$1 GROUP BY status', [lib]),
      sql('SELECT download_status AS status,count(*)::int AS count,coalesce(sum(bytes),0)::text AS bytes FROM research_data.ima_documents WHERE library_id=$1 GROUP BY download_status', [lib]),
      sql('SELECT name,reported_count,catalog_status,sync_status,last_error FROM research_data.ima_libraries WHERE library_id=$1', [lib]),
    ]);
    const status = { time: new Date().toISOString(), library: library.rows[0], folders: folders.rows, documents: documents.rows, freeBytes: await freeBytes(), reserveBytes, fileRoot: root, database: 'company_research', runId, stopReason };
    if (mode !== 'status') {
      const temporary = path.join(root, `status-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(status, null, 2), { mode: 0o600 });
      await rename(temporary, path.join(root, 'status.json'));
    }
    if (runId) await sql('UPDATE research_data.ima_sync_runs SET heartbeat_at=now() WHERE run_id=$1', [runId]);
    return status;
  }

  async function importSamples() {
    const dir = fileURLToPath(new URL('../../../../output/ima-local/2026-10-22/', import.meta.url));
    let samples; try { samples = JSON.parse(await readFile(path.join(dir, 'download-check.json'), 'utf8')); } catch { return; }
    for (const row of samples.filter(r => r.library === LIBRARY.name && r.status === 'downloaded')) {
      const exists = await sql('SELECT download_status FROM research_data.ima_documents WHERE library_id=$1 AND media_id=$2', [lib, row.media_id]);
      if (exists.rows[0]?.download_status === 'downloaded') continue;
      const b = await readFile(row.path); const hash = digest(b);
      if (hash !== row.sha256 || !validFilePrefix(row.media_type, b)) continue;
      const rel = path.join('files', hash.slice(0, 2), `${hash}.pdf`); const dest = path.join(root, rel);
      await requireSpace(b.length); await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 }); await copyFile(row.path, dest); await chmod(dest, 0o600);
      await sql(`INSERT INTO research_data.ima_documents(library_id,media_id,folder_id,title,media_type,download_status,local_path,bytes,sha256,source_host,downloaded_at)
        VALUES($1,$2,$1,$3,$4,'downloaded',$5,$6,$7,$8,now()) ON CONFLICT(library_id,media_id) DO UPDATE SET download_status='downloaded',local_path=EXCLUDED.local_path,bytes=EXCLUDED.bytes,sha256=EXCLUDED.sha256,downloaded_at=now()`, [lib, row.media_id, row.title, row.media_type, rel, b.length, hash, row.source_host]);
      let pages; try { pages = JSON.parse(await readFile(path.join(dir, 'extracted', row.library, `${path.parse(row.title).name}.pages.json`), 'utf8')); } catch { continue; }
      for (const p of pages) if (p.text?.trim()) await sql(`INSERT INTO research_data.ima_document_pages VALUES($1,$2,$3,$4,$5) ON CONFLICT(library_id,media_id,page_number) DO UPDATE SET content=EXCLUDED.content,extraction_method=EXCLUDED.extraction_method`, [lib, row.media_id, p.page, p.text, p.extraction_method ?? 'sample_ocr']);
      await sql("UPDATE research_data.ima_documents SET text_status='ocr_sample' WHERE library_id=$1 AND media_id=$2", [lib, row.media_id]);
    }
  }

  async function catalog(api) {
    try {
      await sql("UPDATE research_data.ima_libraries SET catalog_status='running' WHERE library_id=$1", [lib]);
      while (!stopped) {
        const result = await sql("SELECT * FROM research_data.ima_folders WHERE library_id=$1 AND status IN ('pending','listing') ORDER BY cardinality(path),path DESC LIMIT 1", [lib]);
        const folder = result.rows[0]; if (!folder) break;
        try {
          await requireSpace(1024 * 1024);
          const data = await api('get_knowledge_list', { knowledge_base_id: lib, ...(folder.folder_id === lib ? {} : { folder_id: folder.folder_id }), cursor: folder.cursor_value, limit: 50 });
          const page = nextCatalogPage(data, folder.cursor_value);
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            for (const item of page.items) {
              if (item.media_type === 99) {
                if (item.media_id === folder.folder_id || item.media_id === lib) throw new SyncError('CATALOG_CYCLE');
                await client.query(`INSERT INTO research_data.ima_folders(library_id,folder_id,parent_id,title,path) VALUES($1,$2,$3,$4,$5)
                  ON CONFLICT(library_id,folder_id) DO UPDATE SET title=EXCLUDED.title,parent_id=EXCLUDED.parent_id,path=EXCLUDED.path`, [lib, item.media_id, folder.folder_id, item.title, [...folder.path, item.title]]);
              } else await client.query(`INSERT INTO research_data.ima_documents(library_id,media_id,folder_id,title,media_type) VALUES($1,$2,$3,$4,$5)
                ON CONFLICT(library_id,media_id) DO UPDATE SET title=EXCLUDED.title,folder_id=EXCLUDED.folder_id,media_type=EXCLUDED.media_type,updated_at=now()`, [lib, item.media_id, folder.folder_id, item.title, item.media_type]);
            }
            await client.query('UPDATE research_data.ima_folders SET cursor_value=$3,status=$4,page_count=page_count+1,item_count=item_count+$5,last_error=NULL,updated_at=now() WHERE library_id=$1 AND folder_id=$2', [lib, folder.folder_id, page.cursor, page.done ? 'done' : 'listing', page.items.length]);
            await client.query('COMMIT');
          } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
        } catch (e) {
          if (e.fatal) { stop(errorCode(e)); break; }
          await sql("UPDATE research_data.ima_folders SET status='error',last_error=$3,updated_at=now() WHERE library_id=$1 AND folder_id=$2", [lib, folder.folder_id, errorCode(e)]);
          log({ event: 'catalog_error', folder: folder.title, code: errorCode(e) });
        }
      }
      const left = await sql("SELECT count(*)::int AS n FROM research_data.ima_folders WHERE library_id=$1 AND status<>'done'", [lib]);
      await sql('UPDATE research_data.ima_libraries SET catalog_status=$2,updated_at=now() WHERE library_id=$1', [lib, left.rows[0].n ? 'incomplete' : 'complete']);
    } finally { catalogFinished = true; }
  }

  async function downloadOne(api, item) {
    const data = await api('get_media_info', { media_id: item.media_id });
    if (!data?.url_info?.url) throw new SyncError(data?.media_type === 11 ? 'NOTE_REQUIRES_SEPARATE_ACCESS' : 'NO_ORIGINAL_URL');
    const u = validateMediaURL(data.url_info.url);
    const headers = downloadHeaders(data.url_info.headers);
    headers.set('Accept-Encoding', 'identity');
    await requireSpace(256 * 1024 * 1024);
    let response;
    try { response = await fetch(u, { headers, redirect: 'error', signal: AbortSignal.timeout(180000) }); } catch { throw new SyncError('FILE_NETWORK_ERROR', { retryable: true }); }
    if (!response.ok) { await response.body?.cancel(); throw new SyncError(`FILE_HTTP_${response.status}`, { retryable: response.status === 429 || response.status >= 500 }); }
    const length = Number(response.headers.get('content-length')) || null;
    try { await requireSpace(Math.max(length ?? 0, 8 * 1024 * 1024)); } catch (e) { await response.body?.cancel(); throw e; }
    const tmp = path.join(root, 'partial', `${digest(item.media_id)}.part`);
    const handle = await open(tmp, 'w', 0o600); let bytes = 0, prefix = Buffer.alloc(0), checkAt = 8 * 1024 * 1024;
    const hash = createHash('sha256');
    try {
      for await (const chunk of response.body) {
        if (stopped) throw new SyncError(stopReason ?? 'INTERRUPTED');
        if (prefix.length < 1024) prefix = Buffer.concat([prefix, chunk]).subarray(0, 1024);
        hash.update(chunk); bytes += chunk.length;
        await handle.writeFile(chunk);
        if (bytes >= checkAt) { await requireSpace(8 * 1024 * 1024); checkAt = bytes + 8 * 1024 * 1024; }
      }
      await handle.sync(); await handle.close();
      if (!bytes || (length && bytes !== length) || !validFilePrefix(item.media_type, prefix)) throw new SyncError('FILE_INTEGRITY_FAILED', { retryable: true });
      const sha = hash.digest('hex');
      const originalExt = path.extname(item.title).toLowerCase(); const ext = /^\.[a-z0-9]{1,8}$/.test(originalExt) ? originalExt : item.media_type === 1 ? '.pdf' : '.bin';
      const rel = path.join('files', sha.slice(0, 2), `${sha}${ext}`); const dest = path.join(root, rel);
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      let present = false; try { present = (await stat(dest)).size === bytes; } catch {}
      if (present) await unlink(tmp); else await rename(tmp, dest);
      await sql(`UPDATE research_data.ima_documents SET download_status='downloaded',local_path=$3,bytes=$4,sha256=$5,source_host=$6,content_type=$7,downloaded_at=now(),updated_at=now(),last_error=NULL WHERE library_id=$1 AND media_id=$2`, [lib, item.media_id, rel, bytes, sha, u.hostname, response.headers.get('content-type')]);
      if ([7, 13].includes(item.media_type) && bytes <= 10 * 1024 * 1024) {
        let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(dest)); } catch { text = null; }
        if (text?.trim()) {
          await sql('INSERT INTO research_data.ima_document_pages VALUES($1,$2,1,$3,$4) ON CONFLICT(library_id,media_id,page_number) DO UPDATE SET content=EXCLUDED.content,extraction_method=EXCLUDED.extraction_method', [lib, item.media_id, text, 'original_utf8']);
          await sql("UPDATE research_data.ima_documents SET text_status='extracted' WHERE library_id=$1 AND media_id=$2", [lib, item.media_id]);
        }
      }
    } catch (e) { try { await handle.close(); } catch {} try { await unlink(tmp); } catch {} throw e; }
  }

  async function worker(api) {
    while (!stopped) {
      const selected = await sql(`WITH candidate AS (SELECT library_id,media_id FROM research_data.ima_documents WHERE library_id=$1 AND download_status='pending' AND attempts<3 ORDER BY discovered_at DESC,media_id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE research_data.ima_documents d SET download_status='downloading',attempts=d.attempts+1,updated_at=now() FROM candidate c WHERE d.library_id=c.library_id AND d.media_id=c.media_id RETURNING d.*`, [lib]);
      const item = selected.rows[0];
      if (!item) { if (catalogFinished) return; await sleep(1000); continue; }
      try {
        await downloadOne(api, item); completedHere++;
        if (completedHere >= maxDownloads) stop('DOWNLOAD_BATCH_LIMIT');
      } catch (e) {
        if (!(e instanceof SyncError)) stop('LOCAL_WRITE_OR_DATABASE_ERROR');
        if (e.fatal) stop(errorCode(e));
        const status = stopped ? 'pending' : e.retryable && item.attempts < 3 ? 'pending' : e.retryable ? 'error' : 'unavailable';
        await sql('UPDATE research_data.ima_documents SET download_status=$3,last_error=$4,updated_at=now(),attempts=CASE WHEN $3=\'pending\' AND $5 THEN greatest(attempts-1,0) ELSE attempts END WHERE library_id=$1 AND media_id=$2', [lib, item.media_id, status, errorCode(e), stopped]);
        if (e.retryable && !stopped) await sleep(3000);
      }
    }
  }

  try {
    await sql(await readFile(new URL('./ima-schema.sql', import.meta.url), 'utf8'));
    if (mode === 'status') { const result = await snapshot(); log(result); return result; }
    lock = await pool.connect();
    const held = await lock.query('SELECT pg_try_advisory_lock(75221022, 1) AS locked');
    if (!held.rows[0].locked) throw new SyncError('IMA_SYNC_ALREADY_RUNNING');
    const api = await createImaAPI();
    const detail = await api('get_knowledge_base', { ids: [lib] });
    if (detail?.infos?.[lib]?.name !== LIBRARY.name) throw new SyncError('LIBRARY_IDENTITY_MISMATCH');
    const discovery = await api('search_knowledge_base', { query: LIBRARY.name, cursor: '', limit: 20 });
    const found = discovery?.info_list?.find(row => (row.kb_id ?? row.id) === lib);
    const count = /^\d+$/.test(String(found?.content_count)) ? Number(found.content_count) : null;
    await sql(`INSERT INTO research_data.ima_libraries(library_id,name,reported_count,sync_status,started_at) VALUES($1,$2,$3,'running',now()) ON CONFLICT(library_id) DO UPDATE SET reported_count=coalesce(EXCLUDED.reported_count,research_data.ima_libraries.reported_count),sync_status='running',updated_at=now(),last_error=NULL`, [lib, LIBRARY.name, count]);
    await sql("INSERT INTO research_data.ima_folders(library_id,folder_id,title) VALUES($1,$1,$2) ON CONFLICT DO NOTHING", [lib, LIBRARY.name]);
    await sql("UPDATE research_data.ima_documents SET download_status='pending' WHERE library_id=$1 AND download_status='downloading'", [lib]);
    if (retryErrors) {
      await sql("UPDATE research_data.ima_folders SET status='pending',last_error=NULL WHERE library_id=$1 AND status='error'", [lib]);
      await sql("UPDATE research_data.ima_documents SET download_status='pending',attempts=0,last_error=NULL WHERE library_id=$1 AND download_status='error'", [lib]);
    }
    await sql("UPDATE research_data.ima_sync_runs SET status='interrupted',finished_at=now() WHERE library_id=$1 AND status='running'", [lib]);
    runId = randomUUID(); await sql("INSERT INTO research_data.ima_sync_runs(run_id,library_id,status) VALUES($1,$2,'running')", [runId, lib]);
    await mkdir(path.join(root, 'partial'), { recursive: true, mode: 0o700 });
    await importSamples();
    let snapshotBusy = false;
    timer = setInterval(() => {
      if (snapshotBusy) return; snapshotBusy = true;
      progressPromise = (async () => { try { log({ event: 'progress', ...await snapshot() }); } catch { stop('STATUS_WRITE_FAILED'); } finally { snapshotBusy = false; } })();
    }, 30000);
    log({ event: 'started', mode, library: LIBRARY.name, reportedCount: count, workers, root, reserveBytes });
    const tasks = [];
    if (mode !== 'download') tasks.push(catalog(api));
    if (mode !== 'catalog') for (let i = 0; i < workers; i++) tasks.push(worker(api));
    const results = await Promise.allSettled(tasks);
    if (results.some(r => r.status === 'rejected')) stop('WORKER_FAILED');
    clearInterval(timer); timer = null;
    await progressPromise;
    const remaining = await sql("SELECT count(*)::int AS n FROM research_data.ima_documents WHERE library_id=$1 AND download_status IN ('pending','downloading','error')", [lib]);
    const folderErrors = await sql("SELECT count(*)::int AS n FROM research_data.ima_folders WHERE library_id=$1 AND status<>'done'", [lib]);
    const inaccessible = await sql("SELECT count(*)::int AS n FROM research_data.ima_documents WHERE library_id=$1 AND download_status='unavailable'", [lib]);
    const status = stopReason ? 'stopped' : mode === 'catalog' ? 'catalog_only' : remaining.rows[0].n || folderErrors.rows[0].n ? 'incomplete' : inaccessible.rows[0].n ? 'complete_with_unavailable' : 'complete';
    await sql('UPDATE research_data.ima_libraries SET sync_status=$2,last_error=$3,updated_at=now() WHERE library_id=$1', [lib, status, stopReason]);
    await sql('UPDATE research_data.ima_sync_runs SET status=$2,last_error=$3,finished_at=now(),heartbeat_at=now() WHERE run_id=$1', [runId, status, stopReason]);
    const result = await snapshot(); log({ event: 'finished', ...result }); return result;
  } catch (e) {
    if (runId) { try { await sql("UPDATE research_data.ima_sync_runs SET status='failed',last_error=$2,finished_at=now() WHERE run_id=$1", [runId, errorCode(e)]); await sql("UPDATE research_data.ima_libraries SET sync_status='failed',last_error=$2,updated_at=now() WHERE library_id=$1", [lib, errorCode(e)]); } catch {} }
    throw e;
  } finally {
    if (timer) clearInterval(timer);
    await progressPromise;
    process.off('SIGTERM', onTerm); process.off('SIGINT', onTerm);
    if (lock) { try { await lock.query('SELECT pg_advisory_unlock(75221022,1)'); } catch {} lock.release(); }
    await pool.end();
  }
}
