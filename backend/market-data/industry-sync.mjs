import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { normalizeTradeDate } from './postgres-store.mjs';
import {
  INDUSTRY_FIELDS, MEMBER_FIELDS, INDEX_DAILY_FIELDS, ADJUSTMENT_FIELDS,
  validateIndustries, validateMembers, validateClassification, validateL2Membership, validateL2Members, validateL2MembersSnapshot, validateIndexDailyRows, validateAdjustmentRows, isHistoricalMemberAlias,
} from './industry-store.mjs';

export { INDUSTRY_FIELDS, MEMBER_FIELDS, INDEX_DAILY_FIELDS, ADJUSTMENT_FIELDS };
const KINDS = new Set(['permission', 'authentication', 'rate_limit', 'network', 'timeout', 'validation', 'invalid_response', 'database']);
const ERROR_CODES = { permission: 'permission_denied', authentication: 'authentication_error', rate_limit: 'rate_limited', database: 'database_error', validation: 'validation_error', network: 'network_error', timeout: 'network_error' };
function invalid(message) { const error = new Error(message); error.kind = 'validation'; return error; }
function kindOf(error) { return error?.code === 'DATABASE_ERROR' ? 'database' : KINDS.has(error?.kind) ? error.kind : error?.code === 'VALIDATION_ERROR' ? 'validation' : 'unknown'; }
async function readJson(path, compressed = false) {
  try { const bytes = await readFile(path); return JSON.parse((compressed ? gunzipSync(bytes) : bytes).toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw invalid('本地行业或复权缓存损坏，请检查对应文件。'); }
}
async function atomicJson(path, value, compressed = false) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`), temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, compressed ? gzipSync(bytes) : bytes, { mode: 0o600 }); await rename(temporary, path);
}
function validTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validCalendar(value, start, end) {
  if (!value || value.version !== 1 || value.market !== 'A' || value.startDate !== start || value.endDate !== end || !Array.isArray(value.dates) || !value.dates.length) return false;
  const unique = new Set();
  try { for (const date of value.dates) { if (normalizeTradeDate(date).compact !== date || date < start || date > end || unique.has(date)) return false; unique.add(date); } }
  catch { return false; }
  return true;
}
async function calendarFor({ client, cacheDir, start, end, mode }) {
  const directory = join(cacheDir, 'A'), path = join(directory, `calendar-${start}-${end}.json`);
  let calendar = await readJson(path);
  if (!validCalendar(calendar, start, end)) {
    if (mode === 'import') throw invalid('缺少有效的 A 股交易日历，不能确认行业或复权导入范围。');
    const rows = await client.query('trade_cal', { exchange: 'SSE', start_date: start, end_date: end, is_open: '1' }, 'cal_date,is_open');
    calendar = { version: 1, market: 'A', startDate: start, endDate: end, dates: rows.filter(row => row.is_open === 1 || row.is_open === '1').map(row => row.cal_date).sort(), fetchedAt: new Date().toISOString() };
    if (!validCalendar(calendar, start, end)) throw invalid('A 股交易日历为空、重复或超出请求范围。');
    await mkdir(directory, { recursive: true, mode: 0o700 }); await atomicJson(path, calendar);
  }
  return calendar;
}
function validateSnapshot(value) {
  if (!value || value.version !== 1 || value.source !== 'tushare' || value.src !== 'SW2021' || value.status !== 'completed' || typeof value.snapshotId !== 'string' || !value.snapshotId) throw invalid('分类缓存尚未完整采集或来源不匹配。');
  const normalized = validateClassification(value);
  if ((value.unsupportedHistoricalAliases !== undefined && (!Number.isInteger(value.unsupportedHistoricalAliases) || value.unsupportedHistoricalAliases < 0))
    || (value.sourceMembers !== undefined && (!Number.isInteger(value.sourceMembers) || value.sourceMembers !== normalized.members.length + (value.unsupportedHistoricalAliases ?? 0)))) throw invalid('分类快照源成员及历史别名计数不一致。');
  return { ...value, ...normalized };
}

function validateL2Snapshot(value) {
  if (!value || value.version !== 1 || value.source !== 'tushare' || value.src !== 'SW2021' || value.level !== 'L2' || value.status !== 'completed' || typeof value.snapshotId !== 'string' || !value.snapshotId || !validTimestamp(value.fetchedAt)) throw invalid('二级分类缓存尚未完整采集或来源不匹配。');
  return { ...value, industries: validateIndustries(value.industries, { level: 'L2' }) };
}

/** The full L2 directory is one endpoint response; raw day caches already contain all levels. */
export async function collectL2Classification({ client, cacheDir, mode = 'sync', refresh = false, log = () => {} }) {
  if (!['download', 'import', 'sync'].includes(mode) || typeof cacheDir !== 'string' || !cacheDir || typeof refresh !== 'boolean') throw invalid('二级分类下载方式或缓存位置无效。');
  const directory = join(cacheDir, 'industries', 'SW2021'), path = join(directory, 'snapshot-l2.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (mode === 'import' || !refresh) {
    const cached = await readJson(path);
    if (cached) return validateL2Snapshot(cached);
    if (mode === 'import') throw invalid('缺少完整申万二级目录缓存。');
  }
  if (!client) throw invalid('下载二级分类需要 Tushare 客户端。');
  const fetchedAt = new Date().toISOString();
  const industries = validateIndustries(await client.query('index_classify', { level: 'L2', src: 'SW2021' }, INDUSTRY_FIELDS), { level: 'L2' });
  const snapshot = validateL2Snapshot({ version: 1, source: 'tushare', src: 'SW2021', level: 'L2', status: 'completed', snapshotId: randomUUID(), fetchedAt, industries: industries.map(row => ({ ...row, fetched_at: fetchedAt })) });
  await atomicJson(path, snapshot);
  log({ type: 'industry_l2_classification', industries: industries.length, publishedIndustries: industries.filter(row => row.is_pub).length });
  return snapshot;
}

function validateL2MemberCache(value, classification) {
  if (!value || value.version !== 1 || value.source !== 'tushare' || value.src !== 'SW2021' || value.level !== 'L2' || value.status !== 'completed' || typeof value.snapshotId !== 'string' || !value.snapshotId || value.industrySnapshotId !== classification.snapshotId) throw invalid('二级成员缓存未完成或与目录快照不一致。');
  const normalized = validateL2MembersSnapshot(value);
  const expectedCodes = classification.industries.map(row => row.index_code).sort();
  if (JSON.stringify(normalized.industries.map(row => row.index_code).sort()) !== JSON.stringify(expectedCodes)) throw invalid('二级成员缓存与完整目录不一致。');
  validateL2Membership(classification.industries, normalized.members);
  if (!Number.isInteger(value.unsupportedHistoricalAliases) || value.unsupportedHistoricalAliases < 0 || value.sourceMembers !== normalized.members.length + value.unsupportedHistoricalAliases) throw invalid('二级成员源记录与历史别名计数不一致。');
  return { ...value, ...normalized };
}

/** Independent L2 requests cover source rows whose L3 code differs from index_classify. */
export async function collectL2Members({ client, cacheDir, mode = 'sync', refresh = false, classification, log = () => {} }) {
  if (!['download', 'import', 'sync'].includes(mode) || typeof cacheDir !== 'string' || !cacheDir || typeof refresh !== 'boolean') throw invalid('二级成员下载方式或缓存位置无效。');
  const l2 = validateL2Snapshot(classification ?? await collectL2Classification({ client, cacheDir, mode, refresh, log }));
  const directory = join(cacheDir, 'industries', 'SW2021'), snapshotPath = join(directory, 'snapshot-l2-members.json'), pendingPath = join(directory, 'snapshot-l2-members-pending.json');
  await mkdir(join(directory, 'members-l2'), { recursive: true, mode: 0o700 });
  if (mode === 'import' || !refresh) {
    const complete = await readJson(snapshotPath);
    if (complete && complete.industrySnapshotId === l2.snapshotId) return validateL2MemberCache(complete, l2);
    if (mode === 'import') throw invalid('缺少与二级目录一致的完整二级成员快照。');
  }
  if (!client) throw invalid('下载二级成员需要 Tushare 客户端。');
  let pending = await readJson(pendingPath);
  if (pending && pending.industrySnapshotId !== l2.snapshotId) pending = null;
  if (!pending) {
    pending = { version: 1, source: 'tushare', src: 'SW2021', level: 'L2', status: 'pending', snapshotId: randomUUID(), industrySnapshotId: l2.snapshotId, fetchedAt: new Date().toISOString(), industries: l2.industries };
    await atomicJson(pendingPath, pending);
  } else if (pending.version !== 1 || pending.source !== 'tushare' || pending.src !== 'SW2021' || pending.level !== 'L2' || pending.status !== 'pending' || typeof pending.snapshotId !== 'string' || !pending.snapshotId || !validTimestamp(pending.fetchedAt)) throw invalid('二级成员采集断点无效。');
  const members = [], completedCodes = [], excludedByIndustry = [];
  let unsupportedHistoricalAliases = 0, sourceMembers = 0;
  log({ type: 'industry_l2_members_start', industries: l2.industries.length });
  for (const industry of l2.industries) {
    const l2Code = industry.index_code, path = join(directory, 'members-l2', `${l2Code}.json.gz`);
    let cached = await readJson(path, true);
    if (cached && cached.snapshotId !== pending.snapshotId) cached = null;
    if (!cached) {
      const rows = await client.queryAll('index_member_all', { l2_code: l2Code, is_new: 'Y' }, MEMBER_FIELDS, { pageSize: 2000, maxPages: 100, maxRows: 100000, primaryKey: ['ts_code', 'l2_code', 'l3_code'] });
      validateL2Members(rows, l2Code, { allowHistoricalAliases: true });
      validateL2Membership(l2.industries, rows);
      cached = { version: 1, source: 'tushare', apiName: 'index_member_all', snapshotId: pending.snapshotId, l2Code, fetchedAt: new Date().toISOString(), rows, unsupportedHistoricalAliases: rows.filter(row => isHistoricalMemberAlias(row.ts_code)).length };
      await atomicJson(path, cached, true);
    }
    if (cached.version !== 1 || cached.source !== 'tushare' || cached.apiName !== 'index_member_all' || cached.l2Code !== l2Code || !validTimestamp(cached.fetchedAt)) throw invalid('二级成员缓存来源或归属不匹配。');
    validateL2Members(cached.rows, l2Code, { allowHistoricalAliases: true }); validateL2Membership(l2.industries, cached.rows);
    const excluded = cached.rows.filter(row => isHistoricalMemberAlias(row.ts_code)).length;
    if (cached.unsupportedHistoricalAliases !== excluded) throw invalid('二级成员缓存历史别名计数不一致。');
    sourceMembers += cached.rows.length; unsupportedHistoricalAliases += excluded;
    if (excluded) excludedByIndustry.push({ l2Code, count: excluded });
    members.push(...cached.rows.filter(row => !isHistoricalMemberAlias(row.ts_code)).map(row => ({ ...row, fetched_at: cached.fetchedAt }))); completedCodes.push(l2Code);
    if (completedCodes.length === 1 || completedCodes.length % 10 === 0 || completedCodes.length === l2.industries.length) log({ type: 'industry_l2_members_progress', completedIndustries: completedCodes.length, plannedIndustries: l2.industries.length, members: members.length, sourceMembers, unsupportedHistoricalAliases });
  }
  const snapshot = validateL2MemberCache({ ...pending, status: 'completed', industries: l2.industries, completedCodes, members, sourceMembers, unsupportedHistoricalAliases, excludedByIndustry, completedAt: new Date().toISOString() }, l2);
  await atomicJson(snapshotPath, snapshot); await unlink(pendingPath); return snapshot;
}

/** Publish only after every L3 member response has passed pagination and validation. */
export async function collectClassification({ client, cacheDir, mode = 'sync', refresh = false, log = () => {} }) {
  const directory = join(cacheDir, 'industries', 'SW2021'), snapshotPath = join(directory, 'snapshot.json'), pendingPath = join(directory, 'snapshot-pending.json');
  await mkdir(join(directory, 'members'), { recursive: true, mode: 0o700 });
  if (mode === 'import' || !refresh) {
    const complete = await readJson(snapshotPath);
    if (complete) return validateSnapshot(complete);
    if (mode === 'import') throw invalid('缺少完整分类快照，不能从部分成员缓存导入。');
  }
  let pending = await readJson(pendingPath);
  if (!pending) {
    const industries = validateIndustries(await client.query('index_classify', { level: 'L3', src: 'SW2021' }, INDUSTRY_FIELDS));
    pending = { version: 1, source: 'tushare', src: 'SW2021', status: 'pending', snapshotId: randomUUID(), fetchedAt: new Date().toISOString(), industries };
    await atomicJson(pendingPath, pending);
  } else {
    if (pending.version !== 1 || pending.source !== 'tushare' || pending.src !== 'SW2021' || pending.status !== 'pending' || typeof pending.snapshotId !== 'string' || !pending.snapshotId || !validTimestamp(pending.fetchedAt)) throw invalid('分类采集断点标识无效。');
    validateIndustries(pending.industries);
  }
  const members = [], completedCodes = [], excludedByIndustry = [];
  let unsupportedHistoricalAliases = 0, sourceMembers = 0;
  log({ type: 'industry_classification_start', industries: pending.industries.length });
  for (const industry of pending.industries) {
    const l3Code = industry.index_code, path = join(directory, 'members', `${l3Code}.json.gz`);
    let cached = await readJson(path, true);
    if (cached && cached.snapshotId !== pending.snapshotId) cached = null;
    if (!cached) {
      const rows = await client.queryAll('index_member_all', { l3_code: l3Code, is_new: 'Y' }, MEMBER_FIELDS, { pageSize: 2000, maxPages: 100, maxRows: 100000, primaryKey: ['ts_code', 'l3_code'] });
      // Narrow, known source aliases remain in the raw audit cache. Every other
      // field, source key and hierarchy still undergoes the same strict checks.
      validateMembers(rows, l3Code, { allowHistoricalAliases: true });
      cached = { version: 1, source: 'tushare', apiName: 'index_member_all', snapshotId: pending.snapshotId, l3Code, fetchedAt: new Date().toISOString(), unsupportedHistoricalAliases: rows.filter(row => isHistoricalMemberAlias(row.ts_code)).length, rows };
      await atomicJson(path, cached, true);
    }
    if (cached.version !== 1 || cached.source !== 'tushare' || cached.apiName !== 'index_member_all' || cached.l3Code !== l3Code || !validTimestamp(cached.fetchedAt)) throw invalid('三级成员缓存来源或代码不匹配。');
    validateMembers(cached.rows, l3Code, { allowHistoricalAliases: true });
    const excluded = cached.rows.filter(row => isHistoricalMemberAlias(row.ts_code)).length;
    if (cached.unsupportedHistoricalAliases !== undefined && cached.unsupportedHistoricalAliases !== excluded) throw invalid('三级成员缓存历史别名计数不一致。');
    sourceMembers += cached.rows.length; unsupportedHistoricalAliases += excluded;
    if (excluded) { excludedByIndustry.push({ l3Code, count: excluded }); log({ type: 'industry_historical_aliases_excluded', l3Code, unsupportedHistoricalAliases: excluded }); }
    members.push(...cached.rows.filter(row => !isHistoricalMemberAlias(row.ts_code)).map(row => ({ ...row, fetched_at: cached.fetchedAt }))); completedCodes.push(l3Code);
    if (completedCodes.length === 1 || completedCodes.length % 10 === 0 || completedCodes.length === pending.industries.length) log({ type: 'industry_classification_progress', completedIndustries: completedCodes.length, plannedIndustries: pending.industries.length, members: members.length, sourceMembers, unsupportedHistoricalAliases });
  }
  const snapshot = validateSnapshot({ ...pending, industries: pending.industries.map(row => ({ ...row, fetched_at: pending.fetchedAt })), status: 'completed', completedCodes, members, sourceMembers, unsupportedHistoricalAliases, excludedByIndustry, completedAt: new Date().toISOString() });
  await atomicJson(snapshotPath, snapshot); await unlink(pendingPath);
  return snapshot;
}

async function syncObservations({ client, store, cacheDir, startDate, endDate, mode = 'sync', refresh = false, reimport = false, log = () => {}, apiName }) {
  const start = normalizeTradeDate(startDate).compact, end = normalizeTradeDate(endDate).compact;
  if (start > end || !['download', 'import', 'sync'].includes(mode) || typeof cacheDir !== 'string' || !cacheDir || typeof refresh !== 'boolean' || typeof reimport !== 'boolean') throw invalid('行业或复权下载范围、方式或缓存位置无效。');
  if (mode !== 'import' && !client) throw invalid('下载需要 Tushare 客户端。');
  if (mode !== 'download' && !store) throw invalid('入库需要 PostgreSQL 连接。');
  const industries = apiName === 'sw_daily', fields = industries ? INDEX_DAILY_FIELDS : ADJUSTMENT_FIELDS, validateRows = industries ? validateIndexDailyRows : validateAdjustmentRows;
  const directory = industries ? join(cacheDir, 'industries', 'SW2021', 'daily') : join(cacheDir, 'adjustments', 'A');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { version: 1, source: 'tushare', apiName, market: 'A', startDate: start, endDate: end, mode, refresh, reimport, startedAt: new Date().toISOString(), status: 'running', plannedDays: 0, completedDays: 0, downloadedDays: 0, importedDays: 0, cachedDays: 0, skippedDays: 0, rows: 0, days: [], failedDates: [] };
  const statusPath = join(directory, `status-${start}-${end}-${mode}.json`), event = industries ? 'industry' : 'adjustment';
  await atomicJson(statusPath, report);
  try {
    if (mode !== 'download') await store.migrate();
    let published;
    if (industries) {
      const snapshot = await collectClassification({ client, cacheDir, mode, refresh, log });
      const l2 = await collectL2Classification({ client, cacheDir, mode, refresh, log });
      validateL2Membership(l2.industries, snapshot.members);
      const l2Members = await collectL2Members({ client, cacheDir, mode, refresh, classification: l2, log });
      const l3Published = snapshot.industries.filter(row => row.is_pub), l2Published = l2.industries.filter(row => row.is_pub);
      published = new Set([...l3Published, ...l2Published].map(row => row.index_code));
      if (!published.size) throw invalid('申万二、三级目录没有已发布指数。');
      if (mode !== 'download') {
        await store.replaceL2Classification(l2);
        await store.replaceL2Members(l2Members);
        await store.replaceClassification(snapshot);
      }
      report.classification = { snapshotId: snapshot.snapshotId, status: 'completed', fetchedAt: snapshot.fetchedAt, industries: snapshot.industries.length, publishedIndustries: l3Published.length, l2SnapshotId: l2.snapshotId, l2FetchedAt: l2.fetchedAt, l2Industries: l2.industries.length, publishedL2Industries: l2Published.length, totalPublishedIndustries: published.size, l2MemberSnapshotId: l2Members.snapshotId, l2Members: l2Members.members.length, l2SourceMembers: l2Members.sourceMembers, l2UnsupportedHistoricalAliases: l2Members.unsupportedHistoricalAliases, members: snapshot.members.length, sourceMembers: snapshot.sourceMembers ?? snapshot.members.length, unsupportedHistoricalAliases: snapshot.unsupportedHistoricalAliases ?? 0 };
    }
    const calendar = await calendarFor({ client, cacheDir, start, end, mode }); report.plannedDays = calendar.dates.length;
    // reimport upgrades an existing L3-only partition from the all-level audit cache;
    // unlike refresh it deliberately makes no replacement requests for cached days.
    const completed = mode === 'download' || refresh || reimport ? new Set() : await store.getCompletedDays({ market: 'A', apiName, startDate: start, endDate: end });
    log({ type: `${event}_start`, market: 'A', apiName, plannedDays: report.plannedDays, existingDays: completed.size });
    for (const tradeDate of [...calendar.dates].sort().reverse()) {
      const day = { date: tradeDate, status: 'pending' }; report.days.push(day);
      try {
        if (completed.has(tradeDate)) { report.skippedDays++; report.completedDays++; day.status = 'database_completed'; }
        else {
          const path = join(directory, `${tradeDate}.json.gz`);
          let cached = refresh && mode !== 'import' ? null : await readJson(path, true);
          if (cached && (cached.version !== 1 || cached.source !== 'tushare' || cached.market !== 'A' || cached.apiName !== apiName || cached.tradeDate !== tradeDate || !validTimestamp(cached.fetchedAt))) throw invalid('行业或复权日缓存版本、来源或日期不匹配。');
          if (!cached) {
            if (mode === 'import') throw invalid('交易日行业或复权缓存尚未下载。');
            const rows = await client.queryAll(apiName, { trade_date: tradeDate }, fields, { pageSize: industries ? 4000 : 6000, maxPages: 100, maxRows: 100000, primaryKey: ['ts_code', 'trade_date'] });
            validateRows(rows, tradeDate);
            cached = { version: 1, source: 'tushare', market: 'A', apiName, tradeDate, fetchedAt: new Date().toISOString(), rows };
            await atomicJson(path, cached, true); report.downloadedDays++; day.downloaded = true;
          } else { report.cachedDays++; day.cached = true; }
          validateRows(cached.rows, tradeDate);
          // Each replacement partition includes both published L2 and L3 indices.
          // Never filter a cached all-level day back to L3 after L2 has been enabled.
          const rows = industries ? cached.rows.filter(row => published.has(row.ts_code)) : cached.rows;
          if (!rows.length) throw invalid('开市日没有所选已发布二、三级行业指数数据。');
          if (mode !== 'download') { await store.saveDay({ market: 'A', apiName, tradeDate, rows, fetchedAt: cached.fetchedAt, runId: `${apiName}-${start}-${end}` }); report.importedDays++; }
          report.completedDays++; report.rows += rows.length; day.status = mode === 'download' ? 'downloaded' : 'imported'; day.rowsCount = rows.length;
        }
        if (report.completedDays === 1 || report.completedDays % 10 === 0 || report.completedDays === report.plannedDays) log({ type: `${event}_progress`, date: tradeDate, completedDays: report.completedDays, plannedDays: report.plannedDays, rows: report.rows });
      } catch (error) {
        let kind = kindOf(error); day.status = 'failed'; day.kind = kind;
        if (store && mode !== 'download') try { await store.markFailedDay({ market: 'A', apiName, tradeDate, errorCode: ERROR_CODES[kind] ?? 'provider_error' }); } catch { kind = 'database'; day.kind = kind; }
        report.failedDates.push({ date: tradeDate, kind }); log({ type: `${event}_day_failed`, date: tradeDate, kind });
        if (['permission', 'authentication', 'rate_limit', 'database'].includes(kind)) { report.blockedBy = kind; await atomicJson(statusPath, report); break; }
      }
      await atomicJson(statusPath, report);
    }
    report.status = report.completedDays === report.plannedDays && !report.failedDates.length ? 'completed' : 'incomplete';
    if (mode !== 'download') report.database = await store.summary({ apiName, startDate: start, endDate: end });
  } catch (error) { report.status = 'incomplete'; report.blockedBy = kindOf(error); log({ type: `${event}_failed`, kind: report.blockedBy }); }
  report.finishedAt = new Date().toISOString(); await atomicJson(statusPath, report); return report;
}

export function syncIndustries(options) { return syncObservations({ ...options, apiName: 'sw_daily' }); }
export function syncAdjustments(options) { return syncObservations({ ...options, apiName: 'adj_factor' }); }
