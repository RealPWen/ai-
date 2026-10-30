import { normalizeTradeDate } from './postgres-store.mjs';

export const PRICE_HISTORY_LOOKBACK_DAYS = 30;
export const PRICE_HISTORY_EXTRA_TRADING_DAYS = 1;

/** Without a baseline, return the calendar lookup range; retention keeps one prior trading day. */
export function expandPriceHistoryWindow(window, baselineDate) {
  const start = normalizeTradeDate(window.windowStart);
  if (baselineDate !== undefined) {
    const baseline = normalizeTradeDate(baselineDate);
    if (baseline.compact >= start.compact) throw new RangeError('价格基准日须早于一年窗口起点。');
    return { ...window, windowStart: baseline.compact };
  }
  const bufferedStart = new Date(Date.parse(`${start.iso}T00:00:00Z`) - PRICE_HISTORY_LOOKBACK_DAYS * 86_400_000);
  return { ...window, windowStart: normalizeTradeDate(bufferedStart.toISOString().slice(0, 10)).compact };
}
