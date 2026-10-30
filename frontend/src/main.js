import { initRelationAttribution } from './features/relation-attribution.js';
import { apiConfig, companyConfig } from '../config.js';
import { researchService } from './services/research-service.js';
import { assertPricesContext, assertQuoteContext, assertForecastsContext } from './services/adapters.js';
import { assertBandsContext } from './features/valuation-band-data.js';
import { assertRelationsContext, assertRelationsRevision } from './features/relations-data.js';
import { initRelations, renderRelations } from './views/relations-view.js';
import { initRelationsEditor } from './features/relations-editor.js';
import { initAttribution } from './views/attribution-view.js';
import { initRelationsAI } from './features/relations-ai.js';
import { initEvents, renderEvents } from './views/events-view.js';
import { assertEventsContext } from './features/events-data.js';
import { companyOptions, createCompany } from './data/companies.js';
import { createCompanySession } from './features/company-session.js';
import { initCompanyPicker } from './features/company-picker.js';
import { initWatchlist } from './features/watchlist.js';
import { initSidebar } from './features/sidebar.js';
import { initPageNavigation, initTableColumns } from './features/workspace-navigation.js';
import { initNotes } from './features/notes.js';
import { researchToday, validResearchDate } from './features/research-date.js';
import { authService, canUseAIResearch } from './services/auth.js';
import { initAIStatus } from './features/ai-status.js';
import { createDebateWorkflow, debatePresentation } from './features/debate-workflow.js';
import * as view from './views/research-view.js';

const query = new URL(location.href).searchParams;
const sidebar = initSidebar();
initTableColumns();
initPageNavigation();
let initialCompany;
try { initialCompany = createCompany({ ticker: query.get('ticker') || companyConfig.defaultTicker, name: query.get('company') }); }
catch { initialCompany = createCompany({ ticker: companyConfig.defaultTicker }); }
const session = createCompanySession(initialCompany);
const state = { period: '1m', bandPeriod: '1y', category: '公司', asOf: researchToday(), modules: {}, profile: initialCompany };
const resetModules = view.createModuleReset();
const notes = initNotes(initialCompany);
const renderers = { profile: view.renderProfile, quote: view.renderQuote, prices: data => view.renderPrices(data, { adjustment: session.company.ticker.endsWith('.HK') ? 'none' : 'qfq' }), debates: data => view.renderDebates(data, { ticker: session.company.ticker }), forecasts: view.renderForecasts, bands: view.renderBands, events: renderEvents, relations: (data, options) => { renderRelations(data, options); relativeAttribution?.sync(); } };
let debateWorkflow;
let watchlist;
let debateTimer = null;
let renderedDebateReport;
let renderedDebateContext = '';
let authStatus = null;
let authBusy = null;
let authError = '';
let relationsEditor;
let relationsAI;
let relativeAttribution;
let attribution;
const researchDateInput = document.getElementById('research-date');
researchDateInput.value = state.asOf; researchDateInput.max = researchToday();
function updateDebateControls() {
  if (!debateWorkflow) return;
  const snapshot = debateWorkflow.snapshot;
  document.getElementById('masthead-date').textContent = `数据日期 ${state.asOf.replaceAll('-', '.')}`;
  const presentation = debatePresentation(snapshot, { authorized: canUseAIResearch(authStatus), provider: authStatus?.provider, authBusy: Boolean(authBusy) });
  const button = document.getElementById('generate-debates');
  const shared = authStatus?.sharedReadOnly === true;
  const serviceError = document.getElementById('ai-service-error');
  serviceError.textContent = shared ? '' : authError;
  serviceError.hidden = !serviceError.textContent;
  button.disabled = shared || presentation.generateDisabled; button.textContent = shared ? '只读浏览' : presentation.generateText;
  const reload = document.getElementById('reload-debates'); reload.disabled = presentation.reloadDisabled; reload.textContent = presentation.reloadText;
  document.getElementById('cancel-debates').hidden = presentation.cancelHidden;
  document.getElementById('debate-activity').dataset.tone = presentation.tone;
  document.getElementById('debate-activity').hidden = snapshot.phase === 'idle' || snapshot.phase === 'succeeded';
  document.getElementById('debate-activity-title').textContent = presentation.title;
  document.getElementById('debate-activity-context').textContent = `${state.profile.name} · ${snapshot.context.ticker} · 每股一份最新内容`;
  document.getElementById('debate-activity-note').textContent = presentation.note;
  document.getElementById('debate-activity-note').hidden = snapshot.phase === 'idle' || snapshot.phase === 'succeeded' || (snapshot.phase === 'running' && snapshot.kind === 'load');
  if (shared && !snapshot.report && snapshot.phase === 'succeeded') {
    const empty = document.querySelector('.debate-grid .empty-message');
    if (empty) empty.textContent = '该股票暂无已保存的核心分歧，可在本机生成后查看。';
  }
}

function updateConnectionStatus() {
  const statuses = Object.values(state.modules);
  const configured = statuses.filter(item => item.status !== 'not_configured').length;
  const hasPrices = ['quote', 'prices'].some(module => state.modules[module]?.status === 'ready');
  document.getElementById('connection-status').textContent = !apiConfig.enabled || !configured ? '数据服务未连接' : authStatus?.sharedReadOnly === true ? '局域网只读' : hasPrices ? '日线行情 · 非实时' : '读取中…';
  document.querySelector('#source-dialog .dialog-intro').textContent = '当前标的的数据来源与接入状态。';
}

async function refresh(module, options = {}) {
  if (module === 'debates') return debateWorkflow.load();
  const { offset = 0, append = false } = options && typeof options === 'object' ? options : {};
  const request = session.begin(module);
  const asOf = state.asOf;
  if (request.ticker.endsWith('.HK') && module === 'events') {
    state.modules[module] = { status: 'not_supported', data: null };
    renderers[module](null, { status: 'not_supported', ticker: request.ticker, asOf, period: state.bandPeriod, category: state.category, append: false });
    view.renderModuleStatus(module, 'ready');
    updateConnectionStatus(); return;
  }
  if (['quote', 'prices'].includes(module)) renderers[module](null);
  if (module === 'forecasts') { state.modules.forecasts = { status: 'loading', data: null }; renderers.forecasts(null, { status: 'loading' }); }
  if (module === 'bands') renderers.bands(null, { status: 'loading', period: state.bandPeriod });
  if (module === 'relations') { state.modules.relations = { status: 'loading', data: null }; renderers.relations(null, { status: 'loading', ticker: request.ticker, asOf }); relationsEditor?.sync(); }
  if (module === 'events') renderers.events(null, { status: 'loading', ticker: request.ticker, asOf, category: state.category, append });
  if (module !== 'events') view.renderModuleStatus(module, 'loading');
  const params = { ticker: request.ticker, asOf, period: module === 'bands' ? state.bandPeriod : state.period, category: state.category, ...(module === 'prices' ? request.ticker.endsWith('.HK') ? { adjustment: 'none', benchmark: 'hsi' } : { adjustment: 'qfq', benchmark: 'sw2021_l3' } : {}), ...(module === 'events' ? { limit: 20, offset } : {}) };
  try {
    const result = await researchService.load(module, params, { signal: request.signal });
    if (!request.isCurrent()) return; // Ignore superseded results.
    if (module === 'prices' && result.data) assertPricesContext(result.data, params);
    if (module === 'quote' && result.data) assertQuoteContext(result.data, params);
    if (module === 'bands' && result.data) assertBandsContext(result.data, params);
    if (module === 'relations' && result.data) assertRelationsContext(result.data, params);
    if (module === 'events' && result.data) assertEventsContext(result.data, params);
    if (module === 'forecasts' && result.data) assertForecastsContext(result.data, params);
    if (module === 'profile' && result.data) {
      if (result.data.ticker && result.data.ticker.toUpperCase() !== request.ticker) throw new Error('接口返回的证券代码与当前标的不一致');
      state.profile = { ...state.profile, ...Object.fromEntries(Object.entries(result.data).filter(([, value]) => value !== undefined)), ticker: request.ticker };
      result.data = state.profile;
      notes.updateCompany(state.profile);
      watchlist?.refresh();
    }
    state.modules[module] = result;
    if (module === 'events') renderers.events(result.data, { status: result.status, ticker: request.ticker, asOf, category: params.category, append });
    else if (module === 'relations') renderers.relations(result.data, { status: result.status, ticker: request.ticker, asOf });
    else if (module === 'bands') renderers.bands(result.data, { status: result.status, period: state.bandPeriod });
    else if (module === 'forecasts') renderers.forecasts(result.data, { status: result.status });
    else if (result.status !== 'not_configured') renderers[module](result.data ?? (module === 'prices' ? [] : null));
    if (module !== 'events') view.renderModuleStatus(module, result.status);
    if (module === 'prices' && result.status === 'ready') void attribution?.onMarketData({ ticker: request.ticker, asOf });
  } catch (error) {
    if (!request.isCurrent() || error.code === 'ABORTED') return;
    state.modules[module] = { status: 'error', data: null };
    if (['quote', 'prices'].includes(module)) renderers[module](null);
    if (module === 'forecasts') renderers.forecasts(null, { status: 'error' });
    if (module === 'bands') renderers.bands(null, { status: 'error', period: state.bandPeriod });
    if (module === 'relations') renderers.relations(null, { status: 'error', ticker: request.ticker, asOf, error: error.message });
    if (module === 'events') renderers.events(null, { status: 'error', ticker: request.ticker, asOf, category: params.category, append, error: error.message });
    if (module !== 'events') view.renderModuleStatus(module, 'error', error.message);
  } finally {
    if (request.isCurrent()) { updateConnectionStatus(); updateDebateControls(); relationsEditor?.sync(); relationsAI?.sync(); }
  }
}

view.renderProfile(initialCompany); renderers.debates(null);

debateWorkflow = createDebateWorkflow({
  service: { ...researchService, async load(module, ...args) {
    try { return await researchService.load(module, ...args); }
    catch (error) {
      if (module === 'debates' && error.code === 'LOCAL_ONLY_OPERATION') throw new Error('暂时无法读取已保存研究报告，请刷新页面重试。');
      throw error;
    }
  } }, beginRequest: () => session.begin('debates'),
  getContext: () => ({ ticker: session.company.ticker, companyName: state.profile.name === session.company.ticker ? undefined : state.profile.name }),
  allowed: () => !authBusy && canUseAIResearch(authStatus),
  onChange(snapshot) {
    state.modules.debates = { status: snapshot.phase === 'running' ? 'loading' : snapshot.phase === 'failed' ? 'error' : snapshot.report ? 'ready' : 'empty', data: snapshot.report };
    const reportContext = snapshot.context.ticker;
    if (renderedDebateReport !== snapshot.report || renderedDebateContext !== reportContext) { renderedDebateReport = snapshot.report; renderedDebateContext = reportContext; renderers.debates(snapshot.report); }
    view.renderModuleStatus('debates', 'ready');
    if (snapshot.phase === 'running' && debateTimer === null) debateTimer = window.setInterval(updateDebateControls, 1000);
    else if (snapshot.phase !== 'running' && debateTimer !== null) { window.clearInterval(debateTimer); debateTimer = null; }
    updateDebateControls(); updateConnectionStatus();
  },
});
updateDebateControls();
document.getElementById('debates-form').addEventListener('submit', event => { event.preventDefault(); void debateWorkflow.generate(); });
document.getElementById('reload-debates').addEventListener('click', () => { void refresh('debates'); });
document.getElementById('cancel-debates').addEventListener('click', () => debateWorkflow.cancel());
researchDateInput.addEventListener('change', () => {
  const dateError = document.getElementById('data-date-error');
  dateError.hidden = validResearchDate(researchDateInput.value);
  dateError.textContent = dateError.hidden ? '' : '请选择有效的数据截止日期，不能晚于今天。';
  if (!dateError.hidden) { relationsAI?.sync(); attribution?.sync(); return; }
  state.asOf = researchDateInput.value; relationsEditor?.sync(); relationsAI?.sync(); attribution?.sync(); updateDebateControls();
  watchlist?.refresh();
  void Promise.allSettled(['quote', 'prices', 'forecasts', 'bands', 'relations', 'events'].map(refresh));
});

initAIStatus({ service: authService, onChange: (status, { busy, error }) => {
  authStatus = status; authBusy = busy; authError = error;
  if (!canUseAIResearch(status) && debateWorkflow.snapshot.phase === 'running' && debateWorkflow.snapshot.kind === 'generate') debateWorkflow.cancel();
  updateDebateControls(); updateConnectionStatus(); relationsEditor?.sync(); relationsAI?.sync(); attribution?.sync();
} });

function selectCompany(input) {
  const company = createCompany(input);
  if (!notes.setCompany(company)) return false;
  session.select(company);
  state.profile = company; state.modules = {};
  relationsEditor?.sync();
  relationsAI?.sync();
  attribution?.sync();
  resetModules(); view.renderProfile(company); debateWorkflow.reset(); updateDebateControls();
  const url = new URL(location.href); url.searchParams.set('ticker', company.ticker); url.searchParams.set('company', company.name);
  history.replaceState(null, '', url);
  watchlist?.refresh();
  updateConnectionStatus();
  void Promise.allSettled(Object.keys(renderers).map(refresh));
  sidebar?.closeDrawer();
  return true;
}
const companyPicker = initCompanyPicker({ options: companyOptions, getCompany: () => state.profile, onSelect: selectCompany,
  searchCompanies: ({ q, limit, market, signal }) => researchService.searchCompanies({ q, limit, market }, { signal }) });
watchlist = initWatchlist({
  database: true,
  onOwnerChange: owner => notes.setOwner(owner),
  getCompany: () => state.profile,
  getAsOf: () => state.asOf,
  loadQuote: async (params, options) => (await researchService.load('quote', params, options)).data,
  onSelect: selectCompany,
  onSearch: () => { sidebar?.closeDrawer(); companyPicker.open(); },
});
const dialog = document.getElementById('source-dialog');
document.getElementById('sources-button').addEventListener('click', () => dialog.showModal());
document.getElementById('close-sources').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});

const periodMap = { '1个月': '1m', '6个月': '6m', '1年': '1y' };
document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
  state.period = periodMap[button.dataset.period];
  document.querySelectorAll('[data-period]').forEach(item => { const active = item === button; item.classList.toggle('selected', active); item.setAttribute('aria-pressed', String(active)); });
  attribution?.sync();
  refresh('prices');
}));
document.querySelectorAll('[data-band-period]').forEach(button => button.addEventListener('click', () => {
  state.bandPeriod = button.dataset.bandPeriod;
  document.querySelectorAll('[data-band-period]').forEach(item => { const active = item === button; item.classList.toggle('selected', active); item.setAttribute('aria-pressed', String(active)); });
  void refresh('bands');
}));
initEvents({
  onFilter: category => { state.category = category; void refresh('events'); },
  onLoadMore: ({ offset, category }) => { if (category === state.category) void refresh('events', { offset, append: true }); },
  onRefresh: () => { void refresh('events'); },
});

initRelations({ onSelect: selectCompany });
relativeAttribution = initRelationAttribution({ getContext: () => ({ ticker: session.company.ticker, asOf: state.asOf }) });
relationsEditor = initRelationsEditor({
  getContext: () => ({ ticker: session.company.ticker, asOf: state.asOf, name: state.profile.name }),
  getReport: () => state.modules.relations?.data,
  canEdit: () => apiConfig.enabled && authStatus != null && authStatus.sharedReadOnly !== true,
  readOnly: () => authStatus?.sharedReadOnly === true,
  searchCompanies: (params, options) => researchService.searchCompanies(params, options),
  saveChanges: (params, options) => researchService.saveRelationsManual(params, options),
  loadRelations: (params, options) => researchService.load('relations', params, options),
  onSaved(result, context) {
    if (context.ticker !== session.company.ticker || context.asOf !== state.asOf) return;
    assertRelationsRevision(result.data, state.modules.relations?.data);
    session.begin('relations');
    state.modules.relations = result;
    renderers.relations(result.data, { status: result.status, ticker: context.ticker, asOf: context.asOf });
    view.renderModuleStatus('relations', result.status); updateConnectionStatus();
    void refresh('events');
  },
});
relationsAI = initRelationsAI({
  getContext: () => ({ ticker: session.company.ticker, asOf: state.asOf, name: state.profile.name }),
  allowed: () => apiConfig.enabled && canUseAIResearch(authStatus) && validResearchDate(researchDateInput.value)
    && state.modules.relations?.data?.meta?.knownTicker !== false,
  canGenerate: () => state.asOf === researchToday(),
  unavailableReason: () => authStatus?.sharedReadOnly === true ? '局域网仅支持只读浏览，请在本机使用 AI 识别。'
    : !validResearchDate(researchDateInput.value) ? '请选择有效的研究截止日期。'
      : state.asOf !== researchToday() ? '历史日期仅查看已保存关系，请切回今日启动联网识别。'
        : state.modules.relations?.data?.meta?.knownTicker === false ? '该公司不在本地 A 股与港股公司库中。'
          : authError || 'AI 服务尚未连接，请检查后端 AI 配置。',
  startResearch: (params, options) => researchService.startRelationsResearch(params, options),
  loadJob: (params, options) => researchService.loadRelationsResearch(params, options),
  loadRelations: (params, options) => researchService.load('relations', params, options),
  onSaved(result, context) {
    if (context.ticker !== session.company.ticker || context.asOf !== state.asOf) return;
    assertRelationsRevision(result.data, state.modules.relations?.data);
    session.begin('relations');
    state.modules.relations = result;
    renderers.relations(result.data, { status: result.status, ticker: context.ticker, asOf: context.asOf });
    view.renderModuleStatus('relations', result.status); updateConnectionStatus(); relationsEditor?.sync();
  },
});
attribution = initAttribution({
  getContext: () => ({ ticker: session.company.ticker, asOf: state.asOf, historical: state.asOf !== researchToday() }),
  getPeriod: () => state.period,
  canRead: () => apiConfig.enabled && validResearchDate(researchDateInput.value),
  canGenerate: () => !authBusy && authStatus?.provider === 'deepseek' && canUseAIResearch(authStatus)
    && state.asOf === researchToday() && validResearchDate(researchDateInput.value),
  unavailableReason: () => authStatus?.sharedReadOnly === true ? '局域网仅支持只读浏览，请在本机生成。'
    : !validResearchDate(researchDateInput.value) ? '请选择有效的数据截止日期。'
      : state.asOf !== researchToday() ? '历史日期仅查看已保存归因，请切回今日生成。'
        : authStatus?.provider !== 'deepseek' ? '涨跌归因需要后端配置 DeepSeek 联网服务。'
          : authError || 'AI 服务尚未连接，请检查后端 AI 配置。',
  loadReports: (params, options) => researchService.load('attributions', params, options),
  startResearch: (params, options) => researchService.startAttribution(params, options),
  loadJob: (params, options) => researchService.loadAttributionJob(params, options),
});
window.addEventListener('focus', () => { if (!attribution.snapshot.busy) void attribution.reload(); });
await Promise.allSettled(Object.keys(renderers).map(refresh));
