import { createCompany, normalizeTicker } from '../data/companies.js';

export const RECENT_COMPANIES_KEY = 'company-research.recent-companies.v1';
export const RECENT_COMPANIES_LIMIT = 8;
const marketNames = { a: 'A 股', h: '港股', other: '其他市场' };

export function companyMarket(ticker) {
  const code = String(ticker ?? '').toUpperCase();
  if (/\.(SH|SZ|BJ)$/.test(code)) return 'a';
  return code.endsWith('.HK') ? 'h' : 'other';
}

// Persist identifiers only. Treat local storage as untrusted and optional.
export function sanitizeCompanies(records, limit = RECENT_COMPANIES_LIMIT) {
  if (!Array.isArray(records)) return [];
  const seen = new Set();
  const companies = [];
  for (const record of records) {
    if (!record || typeof record !== 'object' || typeof record.ticker !== 'string' || (record.name !== undefined && typeof record.name !== 'string')) continue;
    try {
      const ticker = normalizeTicker(record.ticker);
      if (seen.has(ticker)) continue;
      seen.add(ticker);
      companies.push({ ticker, name: record.name?.trim().slice(0, 120) || ticker });
      if (companies.length >= limit) break;
    } catch { /* Ignore one invalid record without discarding the rest. */ }
  }
  return companies;
}

export function readRecentCompanies(storage) {
  try {
    const raw = storage?.getItem(RECENT_COMPANIES_KEY);
    if (!raw || raw.length > 50_000) return [];
    return sanitizeCompanies(JSON.parse(raw));
  } catch { return []; }
}

export function writeRecentCompanies(storage, records) {
  const companies = sanitizeCompanies(records);
  try { storage?.setItem(RECENT_COMPANIES_KEY, JSON.stringify(companies)); } catch { /* A full or disabled store must not block switching. */ }
  return companies;
}

export function filterCompanies(companies, query = '', market = 'all') {
  const search = String(query).trim().toLocaleLowerCase();
  return companies.filter(company => (market === 'all' || companyMarket(company.ticker) === market)
    && (!search || `${company.name}\n${company.ticker}`.toLocaleLowerCase().includes(search)));
}

function localStore() {
  try { return window.localStorage; } catch { return null; }
}

function element(tag, className, text = '') {
  const result = document.createElement(tag);
  result.className = className;
  result.textContent = text;
  return result;
}

export function initCompanyPicker({ options = [], getCompany, onSelect, searchCompanies }) {
  const byId = id => document.getElementById(id);
  const dialog = byId('company-dialog');
  const search = byId('company-search');
  const results = byId('company-results');
  const error = byId('company-error');
  const code = byId('company-code');
  const name = byId('company-name');
  const manual = byId('company-manual');
  const filters = [...document.querySelectorAll('[data-company-market]')];
  const storage = localStore();
  const scope = byId('company-search-scope');
  const localScope = '已添加标的';
  const hasDatabaseSearch = typeof searchCompanies === 'function';
  let recent = readRecentCompanies(storage);
  let market = 'all';
  let resultButtons = [];
  let remote = [];
  let remoteStatus = 'idle';
  let remoteError = '';
  let interactionMessage = '';
  let remoteGeneration = 0;
  let remoteController = null;
  let debounceTimer = null;
  let composing = false;

  function renderFeedback() {
    const message = interactionMessage || remoteError;
    error.textContent = message;
    error.hidden = !message;
  }

  function feedback(message = '') {
    interactionMessage = message;
    renderFeedback();
  }

  function renderSearchStatus() {
    byId('company-results-count').textContent = `${resultButtons.length} 个${remoteStatus === 'loading' ? ' · 搜索中…' : ''}`;
    results.setAttribute('aria-busy', String(remoteStatus === 'loading'));
    renderFeedback();
  }

  function cancelRemote() {
    remoteGeneration += 1;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
    remoteController?.abort();
    remoteController = null;
    remote = [];
    remoteStatus = 'idle';
    remoteError = '';
  }

  function close() {
    cancelRemote();
    search.value = '';
    renderSearchStatus();
    dialog.close();
  }

  function canSearchDatabase() { return hasDatabaseSearch && ['all', 'a', 'h'].includes(market); }

  async function runRemote(query, generation) {
    if (!dialog.open || composing || generation !== remoteGeneration || !canSearchDatabase()) return;
    const controller = new AbortController();
    remoteController = controller;
    try {
      const response = await searchCompanies({ q: query, limit: query ? 50 : market === 'h' ? 50 : 20, market: { a: 'A', h: 'HK', all: 'all' }[market], signal: controller.signal });
      if (!dialog.open || generation !== remoteGeneration || controller.signal.aborted) return;
      const items = Array.isArray(response) ? response : response?.items;
      if (!Array.isArray(items)) throw new Error('Invalid stock search response');
      remote = sanitizeCompanies(items, 50).filter(company => ['a', 'h'].includes(companyMarket(company.ticker)) && (market === 'all' || companyMarket(company.ticker) === market));
      remoteStatus = 'idle';
    } catch (cause) {
      if (!dialog.open || generation !== remoteGeneration) return;
      remoteStatus = controller.signal.aborted || cause?.name === 'AbortError' ? 'idle' : 'error';
      if (remoteStatus === 'error') remoteError = '搜索失败，当前仅显示已添加标的。';
    } finally {
      if (dialog.open && generation === remoteGeneration) {
        remoteController = null;
        refresh();
      }
    }
  }

  function queueRemote({ immediate = false } = {}) {
    cancelRemote();
    const allowed = dialog.open && !composing && canSearchDatabase();
    if (allowed) remoteStatus = 'loading';
    refresh();
    if (!allowed) return;
    const query = search.value.trim();
    const generation = remoteGeneration;
    if (immediate) void runRemote(query, generation);
    else debounceTimer = setTimeout(() => { debounceTimer = null; void runRemote(query, generation); }, 300);
  }

  function select(input) {
    feedback();
    try {
      const company = createCompany(input);
      const previous = getCompany();
      if (normalizeTicker(previous.ticker) === company.ticker) { close(); return true; }
      if (onSelect(company) === false) {
        feedback('尚未切换标的。');
        return false;
      }
      recent = writeRecentCompanies(storage, [company, previous, ...recent]);
      close();
      return true;
    } catch (cause) {
      feedback(cause instanceof Error ? cause.message : '暂时无法切换标的，请重试。');
      return false;
    }
  }

  function resultButton(company, current) {
    const active = current.ticker === company.ticker;
    const button = element('button', `company-result${active ? ' is-current' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', `${company.name}，${company.ticker}，${active ? '当前标的' : '切换到此标的'}`);
    const identity = element('span', 'company-result-identity');
    identity.append(element('strong', '', company.name), element('small', '', company.ticker));
    button.append(element('span', 'company-result-avatar', company.name === company.ticker ? company.ticker.slice(0, 2) : company.name.slice(0, 1)), identity,
      element('span', 'company-market-badge', marketNames[companyMarket(company.ticker)]), element('span', 'company-result-state', active ? '当前' : '↗'));
    button.addEventListener('click', () => select(company));
    button.addEventListener('keydown', event => {
      const index = resultButtons.indexOf(button);
      let target;
      if (event.key === 'ArrowDown') target = Math.min(index + 1, resultButtons.length - 1);
      if (event.key === 'ArrowUp') {
        if (index === 0) { event.preventDefault(); search.focus(); return; }
        target = index - 1;
      }
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = resultButtons.length - 1;
      if (target !== undefined) { event.preventDefault(); resultButtons[target]?.focus(); }
    });
    return button;
  }

  function refresh() {
    const current = createCompany(getCompany());
    byId('company-current-name').textContent = current.name;
    byId('company-current-ticker').textContent = current.ticker;
    byId('company-current-market').textContent = marketNames[companyMarket(current.ticker)];
    const remoteNames = new Map(remote.filter(company => company.name !== company.ticker).map(company => [company.ticker, company.name]));
    const enrich = company => ({ ...company, name: remoteNames.get(company.ticker) || company.name });
    const candidates = sanitizeCompanies([current, ...options, ...recent], Number.POSITIVE_INFINITY).map(enrich);
    const localMatches = filterCompanies(candidates, search.value, market);
    const remoteMatches = remote.filter(company => market === 'all' || companyMarket(company.ticker) === market).map(enrich);
    const currentMatch = [...localMatches, ...remoteMatches].find(company => company.ticker === current.ticker);
    const matches = sanitizeCompanies([...(currentMatch ? [currentMatch] : []), ...remoteMatches, ...localMatches], 50);
    if (scope) {
      scope.textContent = canSearchDatabase() ? `${market === 'a' ? 'A股' : market === 'h' ? '港股' : 'A股 / 港股'}股票` : localScope;
      scope.hidden = canSearchDatabase();
    }
    byId('company-results-label').textContent = search.value.trim() ? '搜索结果' : market === 'all' ? '可选标的' : `${marketNames[market]}标的`;
    byId('company-empty').hidden = matches.length !== 0 || remoteStatus !== 'idle' || composing;
    filters.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.companyMarket === market)));
    resultButtons = matches.map(company => resultButton(company, current));
    results.replaceChildren(...resultButtons);
    renderSearchStatus();
    const visited = recent.filter(company => company.ticker !== current.ticker).map(enrich);
    byId('company-recent-section').hidden = !visited.length;
    byId('company-recent').replaceChildren(...visited.map(company => {
      const button = element('button', 'company-recent-chip');
      button.type = 'button';
      button.setAttribute('aria-label', `切换到 ${company.name}，${company.ticker}`);
      button.append(element('strong', '', company.name), element('small', '', company.ticker));
      button.addEventListener('click', () => select(company));
      return button;
    }));
  }

  function open() {
    cancelRemote();
    composing = false;
    market = 'all'; search.value = ''; code.value = ''; name.value = ''; manual.open = false; feedback();
    if (!dialog.open) dialog.showModal();
    queueRemote({ immediate: true });
    search.focus();
  }

  function openManual() {
    feedback();
    manual.open = true;
    try { code.value = normalizeTicker(search.value); }
    catch { code.value = ''; }
    code.focus();
  }

  byId('company-switch').addEventListener('click', open);
  byId('change-company').addEventListener('click', open);
  byId('close-company').addEventListener('click', close);
  byId('company-add-from-search').addEventListener('click', openManual);
  dialog.addEventListener('cancel', () => { cancelRemote(); renderSearchStatus(); });
  dialog.addEventListener('close', () => {
    // A previous close event can arrive after a rapid reopen.
    if (dialog.open) return;
    cancelRemote(); search.value = ''; renderSearchStatus();
  });
  search.addEventListener('compositionstart', () => { composing = true; cancelRemote(); refresh(); });
  search.addEventListener('compositionend', () => { composing = false; feedback(); queueRemote(); });
  search.addEventListener('input', event => {
    feedback();
    if (event.isComposing || composing) { cancelRemote(); refresh(); return; }
    queueRemote();
  });
  search.addEventListener('keydown', event => {
    if (!composing && !event.isComposing && event.key === 'ArrowDown' && resultButtons.length) { event.preventDefault(); resultButtons[0].focus(); }
  });
  filters.forEach(button => button.addEventListener('click', () => {
    market = ['all', 'a', 'h', 'other'].includes(button.dataset.companyMarket) ? button.dataset.companyMarket : 'all';
    feedback(); queueRemote({ immediate: true });
  }));
  byId('company-search-form').addEventListener('submit', event => {
    event.preventDefault();
    if (composing || event.isComposing) return;
    if (remoteStatus === 'loading') { (resultButtons[0] || search).focus(); return; }
    if (resultButtons.length === 1) resultButtons[0].click();
    else if (resultButtons.length) resultButtons[0].focus();
    else openManual();
  });
  byId('company-custom-form').addEventListener('submit', event => {
    event.preventDefault();
    select({ ticker: code.value, name: name.value });
  });
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    const target = event.target;
    if (target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]') || document.querySelector('dialog[open]')) return;
    event.preventDefault(); open();
  });

  return { open, close, refresh };
}
