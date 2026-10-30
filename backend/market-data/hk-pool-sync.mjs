import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { rollingWindowForDate } from './rolling-update.mjs';
import { expandPriceHistoryWindow, PRICE_HISTORY_EXTRA_TRADING_DAYS } from './price-history-window.mjs';
import { loadHongKongUniverse, validateHongKongUniverse } from './hk-pool-universe.mjs';
import { HK_POOL_PROVIDERS, missingHkPoolRanges, validateHkPoolRows, normalizeHkPoolRange } from './hk-pool-store.mjs';
import { DAILY_FIELDS } from './sync.mjs';
import { collectEastmoneyHkDaily } from './eastmoney-hk-client.mjs';
import { collectYahooHkDaily } from './yahoo-hk-client.mjs';
import { collectTencentHkDaily } from './tencent-hk-client.mjs';

const SAFE_CODES = new Set(['permission_denied', 'authentication_error', 'rate_limited', 'network_error', 'database_error', 'validation_error', 'provider_error', 'no_data', 'incomplete_window']);
function invalid() { const error = new Error('港股投资池更新参数或响应无效。'); error.kind = 'validation'; return error; }
function errorCode(error) {
  if (SAFE_CODES.has(error?.errorCode)) return error.errorCode;
  if (error?.code === 'DATABASE_ERROR') return 'database_error';
  if (error?.code === 'VALIDATION_ERROR') return 'validation_error';
  return { permission: 'permission_denied', authentication: 'authentication_error', rate_limit: 'rate_limited', network: 'network_error', timeout: 'network_error',
    database: 'database_error', validation: 'validation_error', no_data: 'no_data', incomplete_window: 'incomplete_window' }[error?.kind] ?? 'provider_error';
}
export async function collectTushareHkPoolDaily({ client, ticker, startDate, endDate }) {
  if (typeof client?.query !== 'function') throw invalid();
  return { rows: await client.query('hk_daily', { ts_code: ticker, start_date: startDate, end_date: endDate, limit: 5000 }, DAILY_FIELDS),
    ...HK_POOL_PROVIDERS.tushare };
}
function calendarDates(startDate, endDate) {
  const { start, end } = normalizeHkPoolRange(startDate, endDate), dates = [];
  for (let cursor = Date.parse(`${start.iso}T00:00:00Z`); cursor <= Date.parse(`${end.iso}T00:00:00Z`); cursor += 86400000) {
    const date = new Date(cursor); dates.push({ date: date.toISOString().slice(0, 10).replaceAll('-', ''), weekend: [0, 6].includes(date.getUTCDay()) });
  }
  return dates;
}
async function confirmClosedRange({ client, startDate, endDate }) {
  const dates = calendarDates(startDate, endDate);
  if (dates.every(day => day.weekend)) return 'weekends';
  if (typeof client?.query !== 'function') return null;
  const rows = await client.query('hk_tradecal', { start_date: startDate, end_date: endDate }, 'cal_date,is_open');
  if (!Array.isArray(rows) || rows.length !== dates.length) throw invalid();
  const expected = new Set(dates.map(day => day.date)), seen = new Set();
  for (const row of rows) {
    if (!row || !expected.has(row.cal_date) || seen.has(row.cal_date) || ![0, 1, '0', '1'].includes(row.is_open)) throw invalid();
    seen.add(row.cal_date);
  }
  return rows.every(row => Number(row.is_open) === 0) ? 'hk_tradecal' : null;
}
async function collectVerifiedRange(collect, options, identity, allowEmpty) {
  const empty = proof => ({ rows: [], source: identity.source, apiName: identity.apiName, raw: { closedRange: { proof, startDate: options.startDate, endDate: options.endDate } } });
  if (allowEmpty && calendarDates(options.startDate, options.endDate).every(day => day.weekend)) return empty('weekends');
  let response;
  try { response = await collect(options); }
  catch (error) {
    if (error?.kind !== 'no_data' || !allowEmpty) throw error;
    const proof = await confirmClosedRange(options); if (proof) return empty(proof); throw error;
  }
  const rows = Array.isArray(response) ? response : response?.rows;
  if (Array.isArray(rows) && !rows.length) {
    const proof = allowEmpty ? await confirmClosedRange(options) : null;
    if (proof) return empty(proof);
    const error = new Error('港股空行情范围尚未确认休市。'); error.kind = 'no_data'; throw error;
  }
  return response;
}
async function cachedOrCollect({ path, identity, collect, options, allowEmpty }) {
  let cached;
  try { cached = JSON.parse(gunzipSync(await readFile(path)).toString('utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw invalid(); }
  if (cached) {
    if (cached.version !== 1 || Object.entries(identity).some(([key, value]) => cached[key] !== value)) throw invalid();
    validateHkPoolRows(cached.rows, { ...options, allowEmpty });
    return { rows: cached.rows, cached: true };
  }
  const response = await collect(options);
  const value = Array.isArray(response) ? { rows: response, source: identity.source, apiName: identity.apiName } : response;
  if (!value || value.source !== identity.source || value.apiName !== identity.apiName
    || (value.adjustment !== undefined && value.adjustment !== 'none')
    || (value.volumeUnit !== undefined && value.volumeUnit !== 'share')
    || (value.amountUnit !== undefined && value.amountUnit !== 'hkd')
    || (value.currency !== undefined && value.currency !== 'HKD')) throw invalid();
  validateHkPoolRows(value.rows, { ...options, allowEmpty });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, gzipSync(Buffer.from(`${JSON.stringify({ version: 1, ...identity, rows: value.rows,
    ...(value.raw ? { raw: value.raw } : {}), fetchedAt: new Date().toISOString() })}\n`)), { mode: 0o600 });
  await rename(temporary, path);
  return { rows: value.rows, cached: false };
}

/** Only the workbook membership is queried; a symbol is committed with its range.
 * Provider failures stop immediately and leave completed symbols resumable. */
export async function updateRollingHongKongPool({ client, store, cacheDir, runDate, provider = 'eastmoney', universe, universePath, collector, log = () => {} } = {}) {
  let window, pool, identity;
  const summary = { priceHistoryExtraTradingDays: PRICE_HISTORY_EXTRA_TRADING_DAYS,
    plannedTickers: 0, completedTickers: 0, skippedTickers: 0, downloadedRanges: 0, cachedRanges: 0, rows: 0, tickers: [] };
  const safeLog = value => { try { log(value); } catch {} };
  try {
    window = rollingWindowForDate(runDate);
    if (!Object.hasOwn(HK_POOL_PROVIDERS, provider) || typeof store?.withLock !== 'function' || typeof store?.migrate !== 'function'
      || typeof cacheDir !== 'string' || !cacheDir.trim()) throw invalid();
    pool = universe ? validateHongKongUniverse(universe) : await loadHongKongUniverse(universePath);
    identity = { universeHash: pool.universeHash, ...HK_POOL_PROVIDERS[provider] };
    const run = { ...window, ...identity, tickers: pool.tickers };
    summary.plannedTickers = pool.tickers.length;
    const collect = collector ?? { tushare: collectTushareHkPoolDaily, eastmoney: collectEastmoneyHkDaily, yahoo: collectYahooHkDaily, tencent: collectTencentHkDaily }[provider];
    if (typeof collect !== 'function' || (provider === 'tushare' && typeof client?.query !== 'function')) throw invalid();
    await store.migrate();
    const result = await store.withLock(async scope => {
      const previous = await scope.getRun(run);
      if (previous?.status === 'succeeded') {
        let complete = true;
        for (const ticker of pool.tickers) {
          const ranges = await scope.getRanges({ ...identity, ticker, startDate: window.windowStart, endDate: window.windowEnd });
          if (missingHkPoolRanges(ranges, window.windowStart, window.windowEnd).length || !await scope.getBaseline({ ...run, ticker })) { complete = false; break; }
        }
        if (complete) return { status: 'already_completed', ...window, ...identity, summary: previous.summary ?? {} };
      }
      let began = false, savedRanges = 0;
      try {
        await scope.beginRun({ ...run, reopen: previous?.status === 'succeeded' }); began = true;
        safeLog({ type: 'hk_pool_update_started', ...window, ...identity, plannedTickers: pool.tickers.length });
        for (const security of pool.securities) {
          const ticker = security.ticker;
          const completed = await scope.getRanges({ ...identity, ticker, startDate: window.windowStart, endDate: window.windowEnd });
          const missing = missingHkPoolRanges(completed, window.windowStart, window.windowEnd);
          const needsBaseline = !await scope.getBaseline({ ...run, ticker });
          const detail = { ticker, status: 'running', ranges: missing.length, rows: 0 };
          summary.tickers.push(detail);
          if (!missing.length && !needsBaseline) summary.skippedTickers++;
          for (const range of missing) {
            const directory = join(cacheDir, 'HK-pool', pool.universeHash, provider, ticker);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const rangeIdentity = { ...identity, ticker, ...range };
            const data = await cachedOrCollect({ path: join(directory, `${range.startDate}-${range.endDate}.json.gz`), identity: rangeIdentity,
              collect: options => collectVerifiedRange(collect, options, identity, completed.length > 0),
              options: { client, ticker, ...range }, allowEmpty: completed.length > 0 });
            await scope.saveRange({ ...run, ticker, ...range, rows: data.rows }); savedRanges++;
            if (data.cached) summary.cachedRanges++; else summary.downloadedRanges++;
            detail.rows += data.rows.length; summary.rows += data.rows.length;
          }
          if (needsBaseline) {
            // Look back to find one real preceding quote; these lookup dates
            // are never recorded as complete annual price coverage or retained.
            const lookup = expandPriceHistoryWindow(window);
            const prior = new Date(Date.parse(`${window.windowStart.slice(0, 4)}-${window.windowStart.slice(4, 6)}-${window.windowStart.slice(6, 8)}T00:00:00Z`) - 86400000);
            const range = { startDate: lookup.windowStart, endDate: prior.toISOString().slice(0, 10).replaceAll('-', '') };
            const directory = join(cacheDir, 'HK-pool', pool.universeHash, provider, ticker);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const rangeIdentity = { ...identity, ticker, ...range };
            const data = await cachedOrCollect({ path: join(directory, `baseline-${range.startDate}-${range.endDate}.json.gz`), identity: rangeIdentity,
              collect: async options => {
                try { return await collect(options); }
                catch (error) {
                  if (error?.kind !== 'no_data') throw error;
                  return { ...identity, rows: [], raw: { baselineLookup: 'no_data', ...range } };
                }
              }, options: { client, ticker, ...range }, allowEmpty: true });
            const latest = data.rows.filter(row => row.close !== null && Number(row.close) > 0).sort((a, b) => a.trade_date.localeCompare(b.trade_date)).at(-1);
            const rows = latest ? [latest] : [];
            await scope.saveBaseline({ ...run, ticker, ...range, rows }); savedRanges++;
            if (data.cached) summary.cachedRanges++; else summary.downloadedRanges++;
            detail.rows += rows.length; summary.rows += rows.length;
          }
          detail.status = missing.length || needsBaseline ? 'completed' : 'skipped'; summary.completedTickers++;
          safeLog({ type: 'hk_pool_ticker_completed', ticker, completedTickers: summary.completedTickers, plannedTickers: summary.plannedTickers,
            source: identity.source, rows: detail.rows });
        }
        const finalized = await scope.finalize({ ...run, summary });
        const resultSummary = { ...summary, ...(finalized?.deleted ? { deleted: finalized.deleted } : {}) };
        safeLog({ type: 'hk_pool_update_succeeded', ...window, ...identity, completedTickers: summary.completedTickers });
        return { status: 'succeeded', ...window, ...identity, summary: resultSummary };
      } catch (error) {
        let code = errorCode(error);
        const partial = summary.completedTickers > 0 || savedRanges > 0;
        const current = summary.tickers.find(detail => detail.status === 'running');
        if (current) { current.status = 'failed'; current.errorCode = code; }
        if (began) try { await scope.failRun({ ...run, errorCode: code, partial, summary }); } catch { code = 'database_error'; }
        safeLog({ type: 'hk_pool_update_failed', ...window, ...identity, errorCode: code, completedTickers: summary.completedTickers });
        return { status: partial ? 'partial' : 'failed', ...window, ...identity, summary, errorCode: code };
      }
    });
    return !result || result.status === 'busy' ? { status: 'busy', ...window, ...identity, summary } : result;
  } catch (error) {
    const code = errorCode(error);
    safeLog({ type: 'hk_pool_update_failed', ...(window ?? {}), ...(identity ?? {}), errorCode: code });
    return { status: 'failed', ...(window ?? { runDate: null, windowStart: null, windowEnd: null }), ...(identity ?? {}), summary, errorCode: code };
  }
}
