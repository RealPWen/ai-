import { rollingWindowForDate } from './rolling-update.mjs';
import { syncForecasts } from './forecast-sync.mjs';

/** Independent of price completion: retry missing months and refresh late reports. */
export async function updateRollingForecasts({ store, client, cacheDir, runDate, log = () => {}, sync = syncForecasts }) {
  const window = rollingWindowForDate(runDate);
  return store.withDailyLock(async () => {
    const history = await sync({ store, client, cacheDir, startDate: window.windowStart, endDate: window.windowEnd, log });
    if (history.status !== 'completed') {
      const result = { status: 'failed', runDate, sourceApi: 'report_rc', errorCode: history.blockedBy ?? 'incomplete_window' };
      log({ type: 'a_forecast_update_result', ...result }); return result;
    }
    const end = new Date(`${window.runDate}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() - 7);
    const recent = await sync({ store, client, cacheDir, startDate: end.toISOString().slice(0, 10), endDate: window.windowEnd, refresh: true, log });
    const result = { status: recent.status === 'completed' ? 'succeeded' : 'failed', runDate, sourceApi: 'report_rc', windowStart: window.windowStart, windowEnd: window.windowEnd,
      ...(recent.status === 'completed' ? { deleted: await store.pruneBefore(window.windowStart), database: recent.database } : { errorCode: recent.blockedBy ?? 'incomplete_window' }) };
    log({ type: 'a_forecast_update_result', ...result }); return result;
  });
}
