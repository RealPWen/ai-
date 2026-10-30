const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_HEARTBEAT_MS = 60_000;
const ERROR_KINDS = new Set(['authentication', 'permission', 'rate_limit', 'network', 'timeout', 'validation', 'database', 'unavailable']);

function timestamp(value) {
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError('调度时间无效');
  return milliseconds;
}

function validateHour(hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError('执行小时必须为 0 至 23 的整数');
}

function shanghaiDay(milliseconds, hour) {
  const shifted = new Date(milliseconds + SHANGHAI_OFFSET_MS);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - SHANGHAI_OFFSET_MS;
  return { runDate: shifted.toISOString().slice(0, 10), scheduledAt: midnight + hour * 60 * 60 * 1000 };
}

/** The next Asia/Shanghai daily boundary, independent of the host time zone. */
export function nextDailyRunAt(now = new Date(), hour = 6) {
  validateHour(hour);
  const milliseconds = timestamp(now);
  const { scheduledAt } = shanghaiDay(milliseconds, hour);
  return new Date(milliseconds <= scheduledAt ? scheduledAt : scheduledAt + DAY_MS).toISOString();
}

/** In-process scheduler. Persistent completion and cross-process locking belong to run(). */
export function createDailyScheduler({
  run,
  now = () => new Date(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  hour = 6,
  log = () => {},
  catchUp = true,
  heartbeatMs = MAX_HEARTBEAT_MS,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('缺少数据更新函数');
  validateHour(hour);
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > MAX_HEARTBEAT_MS) {
    throw new RangeError('时间检测间隔必须在 1 至 60000 毫秒之间');
  }

  const handledDays = new Set();
  let active = false;
  let running = false;
  let timer = null;

  function safeLog(value) {
    try { log(value); } catch { /* Logging must not interrupt scheduling. */ }
  }

  function execute(runDate, trigger) {
    // Mark the date before invoking user code, including synchronous failures.
    handledDays.add(runDate);
    running = true;
    safeLog({ event: 'daily_update_started', runDate, trigger });
    function failed(error) {
      running = false;
      safeLog({ event: 'daily_update_failed', runDate, kind: ERROR_KINDS.has(error?.kind) ? error.kind : 'unknown' });
    }
    let result;
    try { result = run({ runDate, trigger }); } catch (error) { failed(error); return; }
    Promise.resolve(result).then(() => {
      running = false;
      safeLog({ event: 'daily_update_finished', runDate });
    }, failed);
  }

  function tick(initial = false) {
    if (!active) return;
    timer = null;
    const milliseconds = timestamp(now());
    const { runDate, scheduledAt } = shanghaiDay(milliseconds, hour);
    if (initial && !catchUp && milliseconds > scheduledAt) handledDays.add(runDate);
    if (milliseconds >= scheduledAt && !handledDays.has(runDate) && !running) {
      execute(runDate, initial && milliseconds > scheduledAt ? 'catch_up' : 'scheduled');
    }
    if (!active) return;
    // A bounded heartbeat notices clock changes and sleep/wake without a 24-hour timeout.
    const nextBoundary = handledDays.has(runDate) || milliseconds > scheduledAt ? scheduledAt + DAY_MS : scheduledAt;
    timer = setTimeoutImpl(() => tick(), Math.max(1, Math.min(heartbeatMs, nextBoundary - milliseconds)));
  }

  return {
    start() {
      if (active) return;
      active = true;
      tick(true);
    },
    stop() {
      active = false;
      if (timer !== null) clearTimeoutImpl(timer);
      timer = null;
    },
    get nextRunAt() {
      if (!active) return null;
      const milliseconds = timestamp(now());
      const { runDate, scheduledAt } = shanghaiDay(milliseconds, hour);
      return new Date(handledDays.has(runDate) || milliseconds > scheduledAt ? scheduledAt + DAY_MS : scheduledAt).toISOString();
    },
    get running() { return running; },
  };
}
