import { replaceFile } from '../src/replace-file.mjs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HK_SECURITY_FIELDS, HK_LIST_STATUSES, validateHkSecurities, isHistoricalHkSecurityAlias } from './hk-securities-store.mjs';

export { HK_SECURITY_FIELDS };

function invalid(message) { const error = new Error(message); error.code = 'VALIDATION_ERROR'; error.kind = 'validation'; return error; }
async function readSnapshot(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw invalid('港股基础资料缓存损坏，请检查对应文件。'); }
}
async function writeSnapshot(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await replaceFile(temporary, path); }
  finally { try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 2 || snapshot.source !== 'tushare' || snapshot.apiName !== 'hk_basic'
    || snapshot.market !== 'HK' || snapshot.status !== 'completed'
    || typeof snapshot.fetchedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.fetchedAt))
    || JSON.stringify(snapshot.completedStatuses) !== JSON.stringify(HK_LIST_STATUSES)) throw invalid('缺少完整且来源匹配的港股基础资料快照。');
  const sourceRows = validateHkSecurities(snapshot.sourceRows, { allowHistoricalAliases: true });
  const canonicalRows = sourceRows.filter(row => !isHistoricalHkSecurityAlias(row.ts_code));
  const rows = validateHkSecurities(snapshot.rows);
  const excluded = sourceRows.length - canonicalRows.length;
  if (JSON.stringify(rows) !== JSON.stringify(canonicalRows) || snapshot.sourceRecords !== sourceRows.length
    || !Number.isInteger(snapshot.unsupportedHistoricalAliases) || snapshot.unsupportedHistoricalAliases !== excluded) throw invalid('港股基础资料源记录、历史别名计数与可查询股票列表不一致。');
  const counts = Object.fromEntries(HK_LIST_STATUSES.map(status => [status, sourceRows.filter(row => row.list_status === status).length]));
  if (!counts.L || !snapshot.statusCounts || HK_LIST_STATUSES.some(status => snapshot.statusCounts[status] !== counts[status])) throw invalid('港股基础资料快照状态数量不一致或在市列表为空。');
  return { ...snapshot, rows };
}

/** All three statuses must finish before a snapshot is published or imported. */
export async function syncHkSecurities({ client, store, cacheDir, mode = 'sync', refresh = false, log = () => {} }) {
  if (!['sync', 'download', 'import'].includes(mode) || typeof refresh !== 'boolean'
    || typeof cacheDir !== 'string' || !cacheDir.trim() || typeof log !== 'function') throw invalid('港股基础资料同步方式或缓存位置无效。');
  if (mode !== 'download' && (!store || typeof store.migrate !== 'function' || typeof store.upsertSecurities !== 'function')) throw invalid('港股基础资料入库需要 PostgreSQL 连接。');
  const directory = join(cacheDir, 'securities', 'HK'), path = join(directory, 'snapshot.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let snapshot, cached = false;
  if (mode === 'import' || !refresh) {
    snapshot = await readSnapshot(path);
    if (snapshot) { snapshot = validateSnapshot(snapshot); cached = true; }
    else if (mode === 'import') throw invalid('缺少完整港股基础资料缓存，请先下载。');
  }
  if (!snapshot) {
    if (!client || typeof client.queryAll !== 'function') throw invalid('下载港股基础资料需要 Tushare 客户端。');
    const sourceRows = [], statusCounts = {};
    for (const listStatus of HK_LIST_STATUSES) {
      const records = await client.queryAll('hk_basic', { list_status: listStatus }, HK_SECURITY_FIELDS,
        { pageSize: 6000, maxPages: 20, maxRows: 100000, primaryKey: ['ts_code'] });
      validateHkSecurities(records, { listStatus, allowHistoricalAliases: true });
      statusCounts[listStatus] = records.length; sourceRows.push(...records);
      log({ type: 'hk_securities_status', listStatus, records: records.length });
    }
    const normalized = validateHkSecurities(sourceRows, { allowHistoricalAliases: true });
    const rows = normalized.filter(row => !isHistoricalHkSecurityAlias(row.ts_code));
    snapshot = validateSnapshot({ version: 2, source: 'tushare', apiName: 'hk_basic', market: 'HK', status: 'completed',
      completedStatuses: [...HK_LIST_STATUSES], statusCounts, fetchedAt: new Date().toISOString(), rows, sourceRows,
      sourceRecords: sourceRows.length, unsupportedHistoricalAliases: sourceRows.length - rows.length });
    await writeSnapshot(path, snapshot);
  }
  if (mode !== 'download') {
    await store.migrate();
    await store.upsertSecurities({ rows: snapshot.rows, fetchedAt: snapshot.fetchedAt });
  }
  const report = { status: 'completed', market: 'HK', apiName: 'hk_basic', mode, cached, referenceRecords: snapshot.rows.length,
    sourceRecords: snapshot.sourceRecords, unsupportedHistoricalAliases: snapshot.unsupportedHistoricalAliases,
    statusCounts: snapshot.statusCounts, fetchedAt: snapshot.fetchedAt, importedRecords: mode === 'download' ? 0 : snapshot.rows.length };
  log({ type: 'hk_securities_completed', ...report });
  return report;
}
