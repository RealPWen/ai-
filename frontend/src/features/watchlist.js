import { apiPath } from '../../config.js';
import { sanitizeCompanies } from './company-picker.js';
import { createWatchlistQuotes } from './watchlist-quotes.js';

export const WATCHLIST_KEY = 'company-research.watchlist.v1';
const WATCHLIST_LIMIT = 200;

function localStore() {
  try { return window.localStorage; } catch { return null; }
}

export function readWatchlist(storage) {
  try {
    const raw = storage?.getItem(WATCHLIST_KEY);
    if (!raw || raw.length > 100_000) return [];
    return sanitizeCompanies(JSON.parse(raw), WATCHLIST_LIMIT);
  } catch { return []; }
}

function element(tag, className, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export function initWatchlist({ getCompany, getAsOf = () => '', loadQuote, onSelect, onSearch, onOwnerChange = () => true, storage = localStore(), database = false }) {
  const byId = id => document.getElementById(id);
  const list = byId('watchlist-list');
  const add = byId('watchlist-add');
  const status = byId('watchlist-status');
  let companies = database ? [] : readWatchlist(storage);
  let owner = '', busy = false;
  const ownerKey = 'company-research.watchlist-owner.v1';
  let ownerInput, ownerButton, ownerPanel, ownerSummary;
  async function request(ownerName, change) {
    const response = await fetch(apiPath(`/api/watchlist${change ? '' : `?owner=${encodeURIComponent(ownerName)}`}`), {
      method: change ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      ...(change ? { body: JSON.stringify({ ...change, owner: ownerName }) } : {}), signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || '自选数据库请求失败');
    return sanitizeCompanies(body.data, WATCHLIST_LIMIT);
  }
  function setBusy(value) { busy = value; renderKey = ''; render(); if(ownerButton)ownerButton.disabled=value; }
  async function remoteChange(change) {
    if (!owner) { feedback('请先输入姓名并进入自选'); ownerInput?.focus(); return false; }
    if (busy) return false;
    setBusy(true);
    try { companies = await request(owner, change); feedback('已保存到数据库'); return true; }
    catch(e) { feedback(e.message || '保存失败，原自选已保留'); return false; }
    finally { setBusy(false); refreshQuotes(); }
  }
  async function login() {
    if(busy)return;
    const next = ownerInput.value.normalize('NFKC').trim().replace(/\s+/gu,' ');
    setBusy(true);
    try {
      const nextCompanies = await request(next);
      if (await onOwnerChange(next) === false) { feedback('笔记尚未保存，未切换姓名'); return; }
      owner = next; companies = nextCompanies;
      try { storage?.setItem(ownerKey,owner); } catch {}
      if (ownerSummary) ownerSummary.textContent = `${owner}的自选 · 切换`;
      if (ownerPanel) ownerPanel.open = false;
      feedback('');
    } catch(e) { feedback(e.message || '读取失败，未切换姓名'); }
    finally { setBusy(false); refreshQuotes(); }
  }

  let renderKey = '';
  let buttons = [];
  let quoteNodes = new Map();

  function paintQuotes() {
    for (const [ticker, { node, name }] of quoteNodes) {
      const quote = quotes.get(ticker);
      const value = quote.status === 'ready' ? Math.round(quote.pctChange * 100) / 100 : null;
      const text = value == null ? '—' : `${value > 0 ? '+' : ''}${(value === 0 ? 0 : value).toFixed(2)}%`;
      node.textContent = text;
      node.className = `watchlist-change${value > 0 ? ' is-up' : value < 0 ? ' is-down' : ''}`;
      node.title = quote.status === 'ready' ? `${quote.tradeDate} 涨跌幅 ${text}`
        : `${quote.tradeDate ? `${quote.tradeDate} · ` : ''}${quote.reason}`;
      node.setAttribute('aria-label', `${name}，${node.title}`);
    }
  }
  const quotes = createWatchlistQuotes({ loadQuote, onChange: paintQuotes });
  function refreshQuotes() {
    let asOf;
    try { asOf = getAsOf(); } catch { asOf = ''; }
    quotes.setContext({ asOf, tickers: companies.map(company => company.ticker) });
  }

  function currentCompany() { return sanitizeCompanies([getCompany()], 1)[0]; }
  function feedback(message = '') {
    status.textContent = message;
    status.hidden = !message;
  }
  function persist() {
    try {
      if (!storage) throw new Error('Storage unavailable');
      storage.setItem(WATCHLIST_KEY, JSON.stringify(companies));
      feedback();
    } catch { feedback('未能保存自选，仅本次有效'); }
  }

  function render() {
    const current = currentCompany();
    const key = JSON.stringify([companies, current?.ticker]);
    if (key === renderKey) return;
    renderKey = key;
    const focused = buttons.find(item => item.node === document.activeElement);
    const watched = companies.some(item => item.ticker === current?.ticker);
    byId('watchlist-count').textContent = String(companies.length);
    add.disabled = !current || watched || (database && (busy || !owner));
    add.textContent = watched ? '✓ 已加入' : '＋ 加入自选';
    add.title = current ? `${watched ? '已收藏' : '收藏'} ${current.name}（${current.ticker}）` : '请先选择股票';
    list.replaceChildren();
    buttons = [];
    quoteNodes = new Map();
    if (!companies.length) {
      list.append(element('p', 'watchlist-empty', '暂无自选'));
      return;
    }
    for (const company of companies) {
      const row = element('div', 'watchlist-item');
      row.dataset.ticker = company.ticker;
      row.classList.toggle('is-active', company.ticker === current?.ticker);
      const select = element('button', 'watchlist-select');
      select.type = 'button';
      select.title = `${company.name} · ${company.ticker}`;
      select.setAttribute('aria-label', `查看 ${company.name}（${company.ticker}）`);
      select.setAttribute('aria-current', String(company.ticker === current?.ticker));
      select.append(element('span', 'watchlist-name', company.name), element('span', 'watchlist-ticker', company.ticker));
      select.addEventListener('click', () => {
        if (company.ticker === currentCompany()?.ticker) return;
        try {
          if (onSelect({ ...company }) === false) return;
          refresh();
          buttons.find(item => item.ticker === company.ticker && item.action === 'select')?.node.focus?.();
        } catch { feedback('切换股票失败，请重试'); }
      });
      const remove = element('button', 'watchlist-remove', '×');
      remove.type = 'button';
      remove.title = '移出自选';
      remove.setAttribute('aria-label', `将 ${company.name} 移出自选`);
      remove.disabled = database && busy;
      remove.addEventListener('click', () => {
        if(database) { void remoteChange({action:'remove',ticker:company.ticker}); return; }
        const index = companies.findIndex(item => item.ticker === company.ticker);
        companies = companies.filter(item => item.ticker !== company.ticker);
        persist();
        render();
        refreshQuotes();
        const next = companies[Math.min(index, companies.length - 1)];
        (buttons.find(item => item.ticker === next?.ticker && item.action === 'remove')?.node || add).focus?.();
      });
      const change = element('span', 'watchlist-change', '—');
      quoteNodes.set(company.ticker, { node: change, name: company.name });
      row.append(select, change, remove);
      list.append(row);
      buttons.push({ ticker: company.ticker, action: 'select', node: select }, { ticker: company.ticker, action: 'remove', node: remove });
    }
    paintQuotes();
    if (focused) buttons.find(item => item.ticker === focused.ticker && item.action === focused.action)?.node.focus?.();
  }

  function refresh() {
    const current = currentCompany();
    const watched = companies.find(item => item.ticker === current?.ticker);
    // A delayed profile may fill a name; a code placeholder must not erase it.
    if (!database && watched && current.name !== current.ticker && current.name !== watched.name) {
      watched.name = current.name;
      persist();
    }
    render();
    refreshQuotes();
  }

  function addCurrent() {
    const current = currentCompany();
    if (!current) { feedback('请先选择股票'); return false; }
    if (companies.some(item => item.ticker === current.ticker)) { refresh(); return true; }
    if (companies.length >= WATCHLIST_LIMIT) { feedback(`自选最多保存 ${WATCHLIST_LIMIT} 只股票`); return false; }
    if(database) { void remoteChange({action:'add',companies:[current]}); return true; }
    companies.push(current);
    persist();
    render();
    refreshQuotes();
    return true;
  }

  if(database) {
    const panel = element('details','watchlist-owner');
    ownerPanel = panel;
    ownerSummary = element('summary','watchlist-owner-summary','选择自选用户');
    panel.append(ownerSummary);
    ownerInput=element('input','watchlist-owner-input'); ownerInput.type='text'; ownerInput.maxLength=40;
    ownerInput.placeholder='输入你的姓名'; ownerInput.setAttribute('aria-label','自选所属姓名');
    ownerButton=element('button','watchlist-owner-button','进入 / 切换');ownerButton.type='button';
    ownerButton.addEventListener('click',()=>void login());
    ownerInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void login();}});
    const hint=element('small','watchlist-owner-hint','按姓名区分自选；同名共用，无密码验证');
    panel.append(ownerInput,ownerButton,hint);
    add.before(panel);
    try {ownerInput.value=storage?.getItem(ownerKey)||'';}catch{}
    panel.open = !ownerInput.value;
    if(ownerInput.value)void login();
    else feedback('输入姓名后读取该人的数据库自选');
  }
  add.addEventListener('click', addCurrent);
  byId('watchlist-search').addEventListener('click', () => onSearch());
  refresh();
  return { refresh, addCurrent, destroy: () => quotes.destroy() };
}
