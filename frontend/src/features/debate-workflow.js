// The displayed report and the current operation have separate lifetimes.
export function createDebateWorkflow({ service, beginRequest, getContext, allowed = () => true, onChange = () => {}, now = () => Date.now() }) {
  let active = null;
  let state = { phase: 'idle', kind: null, report: null, origin: null, startedAt: null, finishedAt: null, error: '' };
  const snapshot = () => ({ ...state, context: { ...getContext() }, elapsedSeconds: state.startedAt == null ? 0 : Math.max(0, Math.floor(((state.finishedAt ?? now()) - state.startedAt) / 1000)) });
  const emit = () => onChange(snapshot());
  async function run(kind) {
    if (active || (kind === 'generate' && !allowed())) return;
    const context = { ...getContext() };
    const request = beginRequest();
    const operation = { request, context };
    active = operation;
    state = { ...state, phase: 'running', kind, startedAt: now(), finishedAt: null, error: '' };
    emit();
    try {
      const result = kind === 'generate'
        ? await service.generateDebates({ ticker: context.ticker, companyName: context.companyName }, { signal: request.signal })
        : await service.load('debates', { ticker: context.ticker }, { signal: request.signal });
      if (active !== operation || !request.isCurrent()) return;
      const report = result.data;
      if (kind === 'generate' && !report) throw new Error('本次生成未返回研究报告');
      if (report && report.ticker.toUpperCase() !== context.ticker) throw new Error('返回报告的证券代码与当前股票不一致');
      state = { ...state, phase: 'succeeded', report, origin: report ? kind === 'generate' ? 'generated' : 'saved' : null, finishedAt: now(), error: '' };
    } catch (error) {
      if (active !== operation || !request.isCurrent()) return;
      state = { ...state, phase: error.code === 'ABORTED' ? 'cancelled' : 'failed', finishedAt: now(), error: error.code === 'ABORTED' ? '' : error.message };
    } finally {
      if (active === operation) { active = null; emit(); }
    }
  }
  return {
    get snapshot() { return snapshot(); },
    load: () => run('load'), generate: () => run('generate'),
    cancel() {
      if (!active) return;
      beginRequest(); active = null;
      state = { ...state, phase: 'cancelled', finishedAt: now(), error: '' }; emit();
    },
    reset() {
      beginRequest(); active = null;
      state = { phase: 'idle', kind: null, report: null, origin: null, startedAt: null, finishedAt: null, error: '' }; emit();
    },
  };
}

export function formatResearchTime(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '更新时间未提供';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date).replaceAll('/', '-');
}

export function debatePresentation(state, { authorized = false, provider, authBusy = false } = {}) {
  const running = state.phase === 'running';
  const generating = running && state.kind === 'generate';
  const loading = running && state.kind === 'load';
  const duration = `${String(Math.floor(state.elapsedSeconds / 60)).padStart(2, '0')}:${String(state.elapsedSeconds % 60).padStart(2, '0')}`;
  let title = '准备读取核心分歧', note = '每家公司保留一份最新内容，仅在手动更新成功后覆盖。';
  if (generating) { title = `${provider === 'deepseek' ? 'DeepSeek ' : ''}正在${state.report ? '更新' : '生成'}分歧 · ${duration}`; note = state.report ? '本次更新尚未完成，下方仍显示上次内容；成功保存后会自动替换。' : provider === 'deepseek' ? '本次内容尚未完成。DeepSeek 正在根据后端取得的资料整理分歧，最多等待 6 分钟。' : '本次内容尚未完成。正在检索公开资料并整理分歧，最多等待 6 分钟。'; }
  else if (loading) { title = '正在读取已保存内容'; note = state.report ? '读取完成前，下方保持当前展示的内容。' : '正在读取当前股票保存的最新核心分歧，不受数据截止日期影响。'; }
  else if (state.phase === 'succeeded') {
    title = state.kind === 'generate' ? `分歧更新完成 · 用时 ${duration}` : state.report ? '已读取保存内容' : '暂无已保存内容';
    note = state.report ? state.kind === 'generate' ? '当前股票的核心分歧已更新并保存，下次打开仅读取。' : '下方展示当前股票保存的最新内容，最后更新时间见内容栏。' : '该股票还没有保存的核心分歧，可手动生成。';
  } else if (state.phase === 'failed') { title = state.kind === 'generate' ? '本次更新失败' : '读取保存内容失败'; note = `${state.error || '请稍后重试'}${state.report ? '。下方仍显示上次内容，未被替换。' : ''}${state.kind === 'generate' ? ' 可先读取已保存内容确认结果。' : ''}`; }
  else if (state.phase === 'cancelled') { title = '已停止等待'; note = `后端任务可能继续完成，可稍后读取已保存内容。${state.report ? '下方仍显示上次内容。' : ''}`; }
  let originLabel = state.origin === 'generated' ? '本次更新内容' : '最新已保存内容';
  if (state.report && generating) originLabel = '上次内容 · 正在更新';
  else if (state.report && state.phase === 'failed' && state.kind === 'generate') originLabel = '上次内容 · 本次更新失败';
  else if (state.report && state.phase === 'cancelled') originLabel = '当前保留的上次内容';
  return {
    title, note, originLabel, tone: state.phase === 'failed' ? 'error' : generating || loading ? 'running' : state.phase === 'succeeded' && state.report ? 'success' : 'neutral',
    generateText: generating ? `${provider === 'deepseek' ? 'DeepSeek ' : ''}${state.report ? '更新中' : '生成中'} · ${duration}` : !authorized ? provider === 'deepseek' ? '先配置 DeepSeek API' : provider === 'chatgpt' ? '先登录 ChatGPT' : '等待 AI 连接状态' : state.phase === 'failed' && state.kind === 'generate' ? state.report ? '重试更新分歧' : '重试生成分歧' : state.report ? '更新分歧' : '生成分歧',
    generateDisabled: running || authBusy || !authorized,
    reloadText: loading ? '正在读取…' : '重新读取', reloadDisabled: running, cancelHidden: !generating,
    resultTime: state.report ? `最后更新 ${formatResearchTime(state.report.updatedAt || state.report.generatedAt)}（北京时间）` : '',
    resultDetail: state.report ? `${state.report.company?.name || state.context.companyName || state.context.ticker} · ${state.report.ticker}　|　内容研究截止 ${state.report.asOf}　|　${state.report.model || '模型未提供'}` : '',
  };
}
