import { adaptAttributionJob, assertAttributionsContext, attributionPeriods } from './attribution-data.js';

const keyOf = context => `${context?.ticker || ''}|${context?.asOf || ''}`;
const busyPhases = ['loading', 'starting', 'running', 'reloading'];
const messageOf = error => error?.code === 'LOCAL_ONLY_OPERATION' ? '暂时无法读取已保存归因，请刷新页面重试。' : error?.message || '归因读取失败，请稍后重试。';

/** Reading and polling never generate; POST is only reachable from start/retry. */
export function createAttributionWorkflow({ getContext, canRead = () => true, canGenerate = () => false, loadReports, startResearch, loadJob,
  onChange = () => {}, schedule = callback => setTimeout(callback, 3000), unschedule = timer => clearTimeout(timer) }) {
  const entries = new Map();
  let activeKey = '', marketObservedKey = '', revision = 0, timer = null, readController = null, disposed = false;
  const entryFor = context => {
    const key = keyOf(context);
    if (!entries.has(key)) entries.set(key, { context: { ...context }, phase: 'idle', data: null, job: null, error: '', checked: false, needsResume: false });
    return entries.get(key);
  };
  const isCurrent = (entry, token) => !disposed && canRead() && token === revision && keyOf(entry.context) === keyOf(getContext());
  function snapshot() {
    const context = { ...getContext() }, entry = entryFor(context), busy = busyPhases.includes(entry.phase);
    const historical = entry.data?.historical === true;
    const unavailable = entry.data && attributionPeriods.every(period => entry.data.periods[period].freshness === 'unavailable');
    return { ...entry, context, busy, generationAllowed: canGenerate() && !historical,
      canStart: canRead() && !busy && !entry.needsResume && entry.checked && canGenerate() && !historical && !unavailable };
  }
  function emit() { if (!disposed) onChange(snapshot()); }
  function stopReading() { revision += 1; readController?.abort(); readController = null; if (timer != null) unschedule(timer); timer = null; }
  function pollLater(entry, token) {
    if (isCurrent(entry, token)) timer = schedule(() => { timer = null; void poll(entry, token); });
  }
  async function reload(entry, token, { completed = false } = {}) {
    entry.phase = completed ? 'reloading' : 'loading'; entry.error = ''; emit();
    readController = new AbortController();
    try {
      const response = await loadReports(entry.context, { signal: readController.signal });
      if (!isCurrent(entry, token)) return false;
      const data = assertAttributionsContext(response?.data ?? response, entry.context);
      entry.data = data; entry.checked = true; entry.needsResume = false;
      // A historical screen can show saved metadata, but never resumes today's job.
      entry.job = data.historical ? null : data.job ?? (completed ? entry.job : null);
      if (entry.job?.status === 'running') { entry.phase = 'running'; emit(); pollLater(entry, token); }
      else { entry.phase = 'idle'; emit(); }
      return true;
    } catch (error) {
      if (!isCurrent(entry, token)) return false;
      entry.phase = 'failed'; entry.checked = true; entry.needsResume = completed || Boolean(entry.job?.status === 'running'); entry.error = messageOf(error); emit(); return false;
    }
  }
  async function poll(entry, token) {
    readController = new AbortController();
    try {
      const job = adaptAttributionJob(await loadJob({ jobId: entry.job.jobId }, { signal: readController.signal }), entry.context);
      if (!isCurrent(entry, token)) return false;
      if (!job || job.jobId !== entry.job.jobId || job.requestedAsOf !== entry.job.requestedAsOf) throw new Error('后端返回的归因任务不匹配。');
      entry.job = job; entry.needsResume = false; entry.error = '';
      if (job.status === 'running') { entry.phase = 'running'; emit(); pollLater(entry, token); return true; }
      return reload(entry, token, { completed: true });
    } catch (error) {
      if (!isCurrent(entry, token)) return false;
      entry.phase = 'failed'; entry.needsResume = true; entry.error = `任务状态待确认：${messageOf(error)} 可重新读取，后台任务会继续运行。`; emit(); return false;
    }
  }
  function sync() {
    const context = getContext(), key = keyOf(context), changed = key !== activeKey;
    if (changed || !canRead()) {
      stopReading(); activeKey = key; if (changed) marketObservedKey = '';
      for (const entry of entries.values()) if (busyPhases.includes(entry.phase)) { entry.phase = 'idle'; entry.needsResume = true; }
    }
    const entry = entryFor(context);
    if (changed && busyPhases.includes(entry.phase)) entry.phase = 'idle';
    emit();
    if (!canRead() || busyPhases.includes(entry.phase)) return;
    if (changed || !entry.checked || entry.needsResume) void reload(entry, revision);
  }
  return {
    get snapshot() { return snapshot(); }, sync,
    async onMarketData(context) {
      const key = keyOf(context);
      if (!canRead() || key !== keyOf(getContext())) return false;
      // The initial prices request and initial reports GET read the same local
      // market state. Further successful price refreshes may arrive after an
      // ingestion update without changing ticker or asOf, so compare again.
      if (marketObservedKey !== key) { marketObservedKey = key; return false; }
      const entry = entryFor(getContext());
      if (!entry.checked || busyPhases.includes(entry.phase)) return false;
      stopReading(); return reload(entry, revision);
    },
    async reload() { if (!canRead()) return false; stopReading(); return reload(entryFor(getContext()), revision); },
    async start({ retryFailed = false } = {}) {
      const entry = entryFor(getContext());
      if (!snapshot().canStart) return false;
      const failedPeriods = attributionPeriods.filter(period => entry.job?.periods?.[period]?.status === 'failed');
      const periods = retryFailed && failedPeriods.length ? failedPeriods : attributionPeriods;
      const token = revision;
      entry.phase = 'starting'; entry.error = ''; emit();
      try {
        // Do not abort a submitted job when the reader changes stock; the server persists it.
        const job = adaptAttributionJob(await startResearch({ ...entry.context, periods }), entry.context);
        if (!job) throw new Error('后端未返回涨跌归因任务。');
        entry.job = job; entry.checked = true;
        if (!isCurrent(entry, token)) { entry.phase = 'idle'; entry.needsResume = true; return false; }
        if (job.status === 'running') { entry.phase = 'running'; emit(); pollLater(entry, token); return true; }
        return reload(entry, token, { completed: true });
      } catch (error) {
        entry.phase = 'failed'; entry.needsResume = ['TIMEOUT', 'NETWORK_ERROR', 'ABORTED'].includes(error.code);
        entry.error = entry.needsResume ? `提交结果待确认：${messageOf(error)} 请先重新读取已保存状态。` : messageOf(error);
        if (isCurrent(entry, token)) emit(); return false;
      }
    },
    dispose() { stopReading(); disposed = true; },
  };
}
