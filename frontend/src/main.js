import { apiConfig, companyConfig } from '../config.js';
import { researchService } from './services/research-service.js';
import { companyOptions, createCompany, researchQuestions } from './data/companies.js';
import { createCompanySession } from './features/company-session.js';
import { initNotes } from './features/notes.js';
import * as view from './views/research-view.js';

const query = new URL(location.href).searchParams;
let initialCompany;
try { initialCompany = createCompany({ ticker: query.get('ticker') || companyConfig.defaultTicker, name: query.get('company') }); }
catch { initialCompany = createCompany({ ticker: companyConfig.defaultTicker }); }
const session = createCompanySession(initialCompany);
const state = { period: '1m', category: '全部', modules: {}, profile: initialCompany };
const resetModules = view.createModuleReset();
const notes = initNotes(initialCompany);
const renderers = { profile: view.renderProfile, quote: view.renderQuote, prices: view.renderPrices, debates: view.renderDebates, forecasts: view.renderForecasts, bands: view.renderBands, events: data => view.renderEvents(data, state.category) };

function updateConnectionStatus() {
  const statuses = Object.values(state.modules);
  const configured = statuses.filter(item => item.status !== 'not_configured').length;
  const ready = statuses.filter(item => item.status === 'ready').length;
  document.getElementById('connection-status').textContent = !apiConfig.enabled || !configured ? '通用模板 / 后端接口尚未配置' : `已配置 ${configured} 个研究模块 / 数据由后端提供`;
  if (!ready) {
    document.querySelector('.hero-side > strong').textContent = '等待研究数据';
    document.querySelector('.hero-side > p').textContent = '行情、卖方预测与事件尚未取得。';
    document.querySelector('.dialog-intro').textContent = '当前公司的资料与研究数据按模块加载；未接入的数据保持为空。';
  } else {
    document.querySelector('.hero-side > strong').textContent = '研究数据逐步补齐';
    document.querySelector('.hero-side > p').textContent = `已有 ${ready} 个模块取得数据，其余信息继续补充。`;
    document.querySelector('.dialog-intro').textContent = '公司基础资料及已取得的研究数据，请结合各模块注明的原始来源核验。';
  }
}

async function refresh(module) {
  const request = session.begin(module);
  view.renderModuleStatus(module, 'loading');
  const params = { ticker: request.ticker, period: state.period, category: state.category };
  try {
    const result = await researchService.load(module, params, { signal: request.signal });
    if (!request.isCurrent()) return; // Ignore superseded results.
    if (module === 'profile' && result.data) {
      if (result.data.ticker && result.data.ticker.toUpperCase() !== request.ticker) throw new Error('接口返回的证券代码与当前标的不一致');
      state.profile = { ...state.profile, ...Object.fromEntries(Object.entries(result.data).filter(([, value]) => value !== undefined)), ticker: request.ticker };
      result.data = state.profile;
      notes.updateCompany(state.profile);
    }
    state.modules[module] = result;
    if (result.status !== 'not_configured') renderers[module](result.data ?? (['prices', 'debates', 'forecasts', 'events'].includes(module) ? [] : null));
    view.renderModuleStatus(module, result.status);
  } catch (error) {
    if (!request.isCurrent() || error.code === 'ABORTED') return;
    state.modules[module] = { status: 'error', data: null };
    view.renderModuleStatus(module, 'error', error.message);
  } finally {
    if (request.isCurrent()) updateConnectionStatus();
  }
}

view.renderProfile(initialCompany); view.renderQuestions(researchQuestions);

const companyDialog = document.getElementById('company-dialog');
const companySelect = document.getElementById('company-select');
const companies = [...companyOptions];
function updateCompanyOptions() {
  companySelect.replaceChildren(...companies.map(company => {
    const option = document.createElement('option'); option.value = company.ticker; option.textContent = `${company.name} · ${company.ticker}`; return option;
  }));
  companySelect.value = session.company.ticker;
}
if (!companies.some(item => item.ticker === initialCompany.ticker)) companies.push(initialCompany);
updateCompanyOptions();
function openCompanyDialog() {
  document.getElementById('company-error').hidden = true;
  document.getElementById('company-code').value = '';
  document.getElementById('company-name').value = '';
  companyDialog.showModal();
}
document.getElementById('company-switch').addEventListener('click', openCompanyDialog);
document.getElementById('change-company').addEventListener('click', openCompanyDialog);
document.getElementById('close-company').addEventListener('click', () => companyDialog.close());
function selectCompany(input) {
  const company = createCompany(input);
  if (!notes.setCompany(company)) return;
  session.select(company);
  state.profile = company; state.modules = {};
  resetModules(); view.renderProfile(company); view.renderQuestions(researchQuestions);
  const caption = document.getElementById('price-caption');
  caption.textContent = `接入最近 ${document.querySelector('[data-period].selected').dataset.period}日线后，显示价格走势。`;
  if (!companies.some(item => item.ticker === company.ticker)) companies.push(company);
  updateCompanyOptions();
  const url = new URL(location.href); url.searchParams.set('ticker', company.ticker); url.searchParams.set('company', company.name);
  history.replaceState(null, '', url);
  companyDialog.close(); updateConnectionStatus();
  void Promise.allSettled(Object.keys(renderers).map(refresh));
}
document.getElementById('company-list-form').addEventListener('submit', event => {
  event.preventDefault(); selectCompany(companies.find(item => item.ticker === companySelect.value));
});
document.getElementById('company-custom-form').addEventListener('submit', event => {
  event.preventDefault();
  try { selectCompany({ ticker: document.getElementById('company-code').value, name: document.getElementById('company-name').value }); }
  catch (error) { const feedback = document.getElementById('company-error'); feedback.textContent = error.message; feedback.hidden = false; }
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
  const caption = document.getElementById('price-caption');
  if (caption) caption.textContent = `接入最近 ${button.dataset.period}日线后，显示价格走势。`;
  refresh('prices');
}));
document.querySelectorAll('[data-event]').forEach(button => button.addEventListener('click', () => {
  state.category = button.dataset.event;
  document.querySelectorAll('[data-event]').forEach(item => { const active = item === button; item.classList.toggle('selected', active); item.setAttribute('aria-pressed', String(active)); });
  const title = document.getElementById('event-title'); const caption = document.getElementById('event-caption');
  if (title) title.textContent = state.category === '全部' ? '等待第一条事件' : `等待${state.category}事件`;
  if (caption) caption.textContent = state.category === '全部' ? '尚未获取新闻或公告。接入后按发布时间、影响路径和来源展示。' : `尚未获取${state.category}相关资料，当前不能判断是否有新增事件。`;
  refresh('events');
}));

const links = Array.from(document.querySelectorAll('.nav-link'));
links.forEach(link => link.addEventListener('click', () => links.forEach(item => item.classList.toggle('active', item === link))));
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) links.forEach(link => link.classList.toggle('active', link.hash === `#${visible.target.id}`));
  }, { rootMargin: '-100px 0px -45% 0px', threshold: [0, 0.1, 0.4] });
  links.forEach(link => { const section = document.querySelector(link.hash); if (section) observer.observe(section); });
}

await Promise.allSettled(Object.keys(renderers).map(refresh));
