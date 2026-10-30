import { assertRelationsContext } from './relations-data.js';

const keyOf = context => `${context?.ticker || ''}|${context?.asOf || ''}`;
const supported = ticker => typeof ticker === 'string' && /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/.test(ticker);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const messageOf = error => typeof error?.message === 'string' && error.message ? error.message : 'AI 识别暂时失败，请重试。';

export function adaptRelationsResearchJob(response, context) {
  const value = response && Object.hasOwn(response, 'data') ? response.data : response;
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.jobId !== 'string' || !value.jobId.trim()
    || !supported(value.ticker) || !validDate(value.asOf) || !['running', 'succeeded', 'failed'].includes(value.status)
    || (context && keyOf(value) !== keyOf(context))) throw new Error('AI 识别任务返回的标的、日期或状态无效。');
  return { ...value, message: typeof value.message === 'string' ? value.message : '', stage: typeof value.stage === 'string' ? value.stage : '' };
}

/** Jobs continue on the server when the reader changes company or research date. */
export function createRelationsAIWorkflow({ getContext, allowed, canGenerate = () => true, startResearch, loadJob, loadRelations, onSaved, onChange = () => {},
  schedule = callback => setTimeout(callback, 1500), unschedule = timer => clearTimeout(timer) }) {
  const entries = new Map();
  let activeKey = '', revision = 0, timer = null, readController = null, disposed = false, wasAvailable = false;
  const entryFor = context => {
    const key = keyOf(context);
    if (!entries.has(key)) entries.set(key, { context: { ...context }, phase: 'idle', job: null, error: '', needsResume: false, checked: false });
    return entries.get(key);
  };
  const available = () => !disposed && supported(getContext()?.ticker) && validDate(getContext()?.asOf) && allowed();
  const current = (entry, token) => !disposed && token === revision && keyOf(entry.context) === keyOf(getContext()) && available();
  function snapshot() {
    const context = { ...getContext() }, entry = entryFor(context);
    const busy = ['checking', 'starting', 'running', 'reloading'].includes(entry.phase);
    return { context, phase: entry.phase, job: entry.job, error: entry.error, needsResume: entry.needsResume, busy,
      generationAllowed: canGenerate(), canStart: available() && !busy && (entry.needsResume || canGenerate()) };
  }
  const emit = () => { if (!disposed) onChange(snapshot()); };
  function stopReading() {
    revision += 1; readController?.abort(); readController = null;
    if (timer !== null) unschedule(timer); timer = null;
  }
  function pollLater(entry, token) {
    if (!current(entry, token)) return;
    timer = schedule(() => { timer = null; void read(entry, token); });
  }
  async function readSaved(entry, token) {
    entry.phase = 'reloading'; entry.error = ''; entry.needsResume = false; emit();
    readController = new AbortController();
    try {
      const result = await loadRelations(entry.context, { signal: readController.signal });
      if (!current(entry, token)) return false;
      assertRelationsContext(result?.data, entry.context);
      if (!result?.data) throw new Error('未读取到保存后的关系。');
      const jobGaps = entry.job?.result?.relationCount === 0 && Array.isArray(entry.job.result.gaps) ? entry.job.result.gaps : [];
      const saved = jobGaps.length ? { ...result, data: { ...result.data, gaps: [...new Set([
        ...(Array.isArray(result.data.gaps) ? result.data.gaps : []), ...jobGaps,
      ].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))] } } : result;
      onSaved(saved, entry.context);
      entry.phase = 'succeeded'; entry.needsResume = false; emit(); return true;
    } catch (error) {
      if (!current(entry, token)) return false;
      entry.phase = 'failed'; entry.needsResume = true; entry.checked = true;
      entry.error = `AI 任务已完成，读取保存结果失败：${messageOf(error)} 请重试读取。`; emit(); return false;
    }
  }
  async function accept(entry, job, token) {
    entry.job = job; entry.checked = true; entry.needsResume = false; entry.error = '';
    if (!current(entry, token)) return false;
    if (!job) { entry.phase = 'idle'; emit(); return true; }
    if (job.status === 'succeeded') return readSaved(entry, token);
    if (job.status === 'failed') {
      entry.phase = 'failed'; entry.error = typeof job.error === 'string' ? job.error : job.error?.message || job.message || 'AI 识别失败，请重试。';
      emit(); return false;
    }
    entry.phase = 'running'; emit(); pollLater(entry, token); return true;
  }
  async function read(entry, token, { latest = false } = {}) {
    readController = new AbortController();
    try {
      const query = entry.job && !latest ? { jobId: entry.job.jobId } : entry.context;
      const job = adaptRelationsResearchJob(await loadJob(query, { signal: readController.signal }), entry.context);
      if (!current(entry, token)) return false;
      return accept(entry, job, token);
    } catch (error) {
      if (!current(entry, token)) return false;
      entry.phase = 'failed'; entry.needsResume = true; entry.checked = true;
      entry.error = `任务状态读取失败：${messageOf(error)} 后台任务可能仍在运行，请重试读取。`; emit(); return false;
    }
  }
  function resume(entry, { latest = false } = {}) {
    const token = revision;
    if (entry.job?.status === 'succeeded' && !latest) return readSaved(entry, token);
    entry.phase = entry.job && !latest ? 'running' : 'checking'; entry.error = ''; entry.needsResume = false; emit();
    return read(entry, token, { latest });
  }
  function sync() {
    const context = getContext(), key = keyOf(context), changed = key !== activeKey, enabled = available(), becameAvailable = enabled && !wasAvailable;
    wasAvailable = enabled;
    if (changed || !enabled) {
      stopReading(); activeKey = key;
      for (const [entryKey, entry] of entries) if ((entryKey !== key || !enabled) && ['checking', 'running', 'reloading'].includes(entry.phase)) {
        entry.phase = 'idle'; entry.needsResume = true;
      }
    }
    const entry = entryFor(context);
    emit();
    if (!enabled || ['checking', 'starting', 'running', 'reloading'].includes(entry.phase)) return;
    if (changed || becameAvailable || !entry.checked) void resume(entry, { latest: true });
  }
  return {
    get snapshot() { return snapshot(); }, sync,
    async start() {
      if (!available()) { emit(); return false; }
      const entry = entryFor(getContext());
      if (['checking', 'starting', 'running', 'reloading'].includes(entry.phase)) return false;
      if (entry.needsResume || !entry.checked) return resume(entry);
      if (!canGenerate()) { emit(); return false; }
      const token = revision;
      entry.phase = 'starting'; entry.job = null; entry.error = ''; entry.needsResume = false; emit();
      try {
        // Retain the accepted job ID even when navigation happens during POST.
        const job = adaptRelationsResearchJob(await startResearch(entry.context), entry.context);
        if (!job) throw new Error('后端未返回 AI 识别任务。');
        entry.job = job; entry.checked = true;
        if (!current(entry, token)) {
          entry.phase = 'idle'; entry.needsResume = true;
          if (keyOf(entry.context) === keyOf(getContext())) { emit(); if (available()) void resume(entry); }
          return false;
        }
        return accept(entry, job, token);
      } catch (error) {
        entry.phase = 'failed'; entry.needsResume = ['TIMEOUT', 'NETWORK_ERROR', 'ABORTED'].includes(error.code);
        entry.error = entry.needsResume ? `任务提交结果尚未确认：${messageOf(error)} 请重试读取任务状态。` : messageOf(error);
        if (keyOf(entry.context) === keyOf(getContext())) emit(); return false;
      }
    },
    dispose() { stopReading(); disposed = true; },
  };
}

const stageLabel = stage => ({ queued: '正在准备联网识别', search: '联网检索公告与新闻', searching: '联网检索公告与新闻', fetch: '联网检索公告与新闻', fetching: '正在读取公告与新闻原文',
  evidence: '核验证据', verify: '核验证据', validating: '核验证据', analyze: '核验证据', analyzing: '核验证据',
  save: '保存结果', saving: '保存结果' }[stage] || '联网检索公告与新闻');

export function relationsRefreshPresentation(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)
    || !['retainedCount', 'addedCount', 'removedCount', 'blockedCount'].every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0)
    || !Array.isArray(summary.changes)) return null;
  const changes = summary.changes.filter(change => change && typeof change === 'object' && !Array.isArray(change)
    && typeof change.oldTicker === 'string' && change.oldTicker.trim() && typeof change.reason === 'string' && change.reason.trim()
    && (change.newTicker == null || (typeof change.newTicker === 'string' && change.newTicker.trim())));
  const replacements = changes.filter(change => change.newTicker != null).length;
  const additions = Math.max(0, summary.addedCount - replacements);
  const removals = Math.max(0, summary.removedCount - replacements);
  return { changes, text: `保留 ${summary.retainedCount} 家，新增 ${additions} 家，替换 ${replacements} 家${removals ? `，移除 ${removals} 家` : ''}。${summary.blockedCount ? `另有 ${summary.blockedCount} 项候选调整未采用。` : ''}` };
}

export function relationsAIPresentation(snapshot, unavailableReason = '') {
  const { phase, job, error } = snapshot;
  const busyText = { checking: '读取任务中…', starting: '开始识别中…', running: 'AI识别中…', reloading: '读取结果中…' };
  let title = '', note = '', tone = 'info';
  if (phase === 'idle' && snapshot.generationAllowed === false) { title = '历史日期仅查看已保存关系'; note = '切回今日可启动联网识别。'; }
  if (phase === 'checking') title = '正在读取 AI 任务状态';
  if (phase === 'starting') { title = '正在启动 AI 识别'; note = '将联网检索公司公告与新闻，优先保留已有公司并更新依据，有空位再补充，最多 10 家；替换公司须有充分理由及来源，人工可直接修改，失败保留原内容。'; }
  if (phase === 'running') { title = stageLabel(job?.stage); note = job?.message || '正在查找上游、同行与下游的公开依据，可继续浏览其他公司。'; }
  if (phase === 'reloading') { title = '正在读取已保存关系'; note = 'AI 任务已完成，正在确认数据库中的结果。'; }
  if (phase === 'failed') { title = snapshot.needsResume ? '任务状态待确认' : 'AI 识别未完成'; note = [error, '未覆盖原有关系。'].filter(Boolean).join(' '); tone = 'error'; }
  if (phase === 'succeeded') {
    const count = job?.result?.relationCount;
    const refresh = relationsRefreshPresentation(job?.result?.refreshSummary);
    title = count === 0 ? '本次未找到足够公开依据' : typeof count === 'number' ? `本次 AI 识别 ${count} 家公司` : 'AI 识别结果已保存';
    note = refresh ? `${refresh.text}可点击各公司查看资料摘要及来源${refresh.changes.length ? '，公司调整理由见“研究说明”' : ''}。`
      : count === 0 ? job?.result?.retainedPrevious ? '已保留现有关系。可稍后重试，或手动补充。' : '未添加缺少证据的公司。可稍后重试，或手动补充。'
        : `已保存当前关系，可点击各公司查看资料摘要及来源。${typeof count === 'number' && count < 10 ? '本次资料不足以支持 10 家，不为凑数补充公司。' : ''}`;
    tone = count === 0 ? 'info' : 'success';
  }
  return { disabled: !snapshot.canStart, buttonText: busyText[phase] || (snapshot.needsResume ? '重试读取任务' : phase === 'failed' ? '重新AI识别上下游及同行' : 'AI识别上下游及同行'),
    buttonTitle: !snapshot.canStart && !snapshot.busy ? unavailableReason : '', hidden: !title, title, note, tone };
}

export function initRelationsAI(options) {
  const button = document.getElementById('research-relations'), activity = document.getElementById('relations-ai-activity');
  const workflow = createRelationsAIWorkflow({ ...options, onChange(snapshot) {
    const presentation = relationsAIPresentation(snapshot, options.unavailableReason?.() || 'AI 服务尚未连接。');
    button.disabled = presentation.disabled; button.textContent = presentation.buttonText; button.title = presentation.buttonTitle;
    activity.hidden = presentation.hidden; activity.dataset.tone = presentation.tone; activity.setAttribute('aria-busy', String(snapshot.busy));
    document.getElementById('relations-ai-title').textContent = presentation.title;
    document.getElementById('relations-ai-context').textContent = `${snapshot.context.name || snapshot.context.ticker} · ${snapshot.context.asOf}`;
    document.getElementById('relations-ai-note').textContent = presentation.note;
    document.getElementById('relations-ai-note').hidden = !presentation.note;
    options.onChange?.(snapshot);
  } });
  button.addEventListener('click', () => { void workflow.start(); });
  workflow.sync(); return workflow;
}
