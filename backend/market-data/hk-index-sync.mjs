import { rollingWindowForDate } from './rolling-update.mjs';
import { normalizeTradeDate } from './postgres-store.mjs';
import { createTencentHkIndexClient, validateHkIndexRows, HkIndexError } from './hk-index-client.mjs';

const offset = (date, days) => new Date(Date.parse(`${normalizeTradeDate(date).iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10).replaceAll('-', '');
const codeFor = error => ({ validation: 'validation_error', database: 'database_error', network: 'network_error', incomplete_window: 'incomplete_window' })[error?.kind] ?? 'provider_error';

/** One request initially fills the annual window; later runs refresh a 10-day overlap. */
export async function updateRollingHkIndex({ store, runDate, client = createTencentHkIndexClient(), log = () => {} } = {}) {
  const safeLog = value => { try { log(value); } catch {} };
  let window;
  try {
    window = rollingWindowForDate(runDate);
    if (!store || typeof store.withLock !== 'function' || typeof client?.getDaily !== 'function') throw new HkIndexError('恒生指数更新配置无效。');
    await store.migrate();
    return await store.withLock(async scope => {
      const previous = await scope.getRun(window.runDate);
      if (previous?.status === 'succeeded') return { status: 'already_completed', ...window, source: 'tencent', apiName: 'tencent_hsi_daily', summary: previous.summary ?? {} };
      let began = false;
      try {
        await scope.beginRun(window); began = true;
        const existing = await scope.get({ startDate: window.windowStart, endDate: window.windowEnd });
        const dates = existing.map(row => row.trade_date).sort();
        // HSI predates the window. A tiny first/last-only response is not a
        // year's history and must never authorize pruning or an annual report.
        const fullBackfill = dates.length < 180 || dates[0] > offset(window.windowStart, 14);
        const startDate = fullBackfill ? window.windowStart : [window.windowStart, offset(dates.at(-1), -10)].sort().at(-1);
        const result = await client.getDaily({ indexCode: 'HSI', startDate, endDate: window.windowEnd });
        validateHkIndexRows(result?.rows, { startDate, endDate: window.windowEnd });
        const receivedDates = result.rows.map(row => row.trade_date).sort();
        if (receivedDates.at(-1) < offset(window.windowEnd, -14) || fullBackfill && (receivedDates[0] > offset(window.windowStart, 14) || receivedDates.length < 180)) throw new HkIndexError('恒生指数来源未覆盖目标区间。', 'incomplete_window');
        const summary = { indexCode: 'HSI', fullBackfill, requestedStart: startDate, sourceThrough: receivedDates.at(-1), downloadedRows: result.rows.length };
        const saved = await scope.finalize({ ...window, rows: result.rows, startDate, summary });
        const final = { status: 'succeeded', ...window, source: 'tencent', apiName: 'tencent_hsi_daily', summary: { ...summary, ...saved } };
        safeLog({ type: 'hk_index_update_result', ...final }); return final;
      } catch (error) {
        let errorCode = codeFor(error);
        if (began) try { await scope.failRun({ runDate: window.runDate, errorCode }); } catch { errorCode = 'database_error'; }
        const failed = { status: 'failed', ...window, source: 'tencent', apiName: 'tencent_hsi_daily', errorCode, summary: {} };
        safeLog({ type: 'hk_index_update_result', ...failed }); return failed;
      }
    });
  } catch (error) {
    const failed = { status: 'failed', ...(window ?? { runDate }), source: 'tencent', apiName: 'tencent_hsi_daily', errorCode: codeFor(error), summary: {} };
    safeLog({ type: 'hk_index_update_result', ...failed }); return failed;
  }
}
