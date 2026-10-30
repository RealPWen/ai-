import test from 'node:test';
import assert from 'node:assert/strict';
import { WATCHLIST_KEY, initWatchlist, readWatchlist } from '../frontend/src/features/watchlist.js';

const companies = [
  { ticker: '002920.SZ', name: '德赛西威' },
  { ticker: '000338.SZ', name: '潍柴动力' },
  { ticker: '02313.HK', name: '申洲国际' },
];

function memoryStore(initial = null) {
  let value = initial;
  return {
    getItem(key) { assert.equal(key, WATCHLIST_KEY); return value; },
    setItem(key, next) { assert.equal(key, WATCHLIST_KEY); value = next; },
    get value() { return value; },
  };
}

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.classList = {
      contains: value => this.className.split(/\s+/).includes(value),
      add: (...values) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...values])].join(' '); },
      remove: (...values) => { this.className = this.className.split(/\s+/).filter(value => !values.includes(value)).join(' '); },
      toggle: (value, force) => {
        const enabled = force ?? !this.classList.contains(value);
        this.classList[enabled ? 'add' : 'remove'](value);
        return enabled;
      },
    };
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(key, handler) {
    this.listeners.set(key, [...(this.listeners.get(key) || []), handler]);
  }
  removeEventListener(key, handler) {
    this.listeners.set(key, (this.listeners.get(key) || []).filter(listener => listener !== handler));
  }
  fire(key, payload = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...payload };
    for (const handler of this.listeners.get(key) || []) handler(event);
    return event;
  }
  click() { if (!this.disabled) return this.fire('click'); }
  get textContent() { return this._textContent ?? ''; }
  set textContent(value) { this._textContent = String(value ?? ''); this.children = []; }
  set innerHTML(value) { throw new Error(`Watchlist must use textContent, received innerHTML: ${value}`); }
}

function descendants(element) {
  return element.children.flatMap(child => child instanceof Element ? [child, ...descendants(child)] : []);
}
function hasClass(element, className) { return element.className.split(/\s+/).includes(className); }
function byClass(element, className) { return descendants(element).find(child => hasClass(child, className)); }
function allText(element) { return [element.textContent, ...element.children.map(child => child instanceof Element ? allText(child) : String(child))].join(''); }

function fixture(t, { storage = memoryStore(), initialCompany = companies[0], onSelect, loadQuote, asOf = '2026-10-15' } = {}) {
  const elements = new Map(['watchlist-count', 'watchlist-add', 'watchlist-status', 'watchlist-list', 'watchlist-search'].map(id => [id, new Element(id.endsWith('-add') || id.endsWith('-search') ? 'button' : 'div')]));
  const root = new Element('document');
  root.getElementById = id => elements.get(id);
  root.createElement = tag => new Element(tag);
  const events = new Element('window');
  events.localStorage = storage;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = root;
  globalThis.window = events;
  t.after(() => { globalThis.document = previousDocument; globalThis.window = previousWindow; });
  let current = { ...initialCompany };
  const calls = [];
  let searches = 0;
  const watchlist = initWatchlist({
    getCompany: () => current,
    getAsOf: () => asOf,
    loadQuote,
    onSelect(company) {
      calls.push(company);
      const result = onSelect?.(company);
      if (result !== false) current = company;
      return result;
    },
    onSearch() { searches += 1; },
    storage,
    eventTarget: events,
  });
  t.after(() => watchlist.destroy());
  return {
    watchlist, calls, storage, events, root,
    byId: id => elements.get(id),
    rows: () => elements.get('watchlist-list').children.filter(child => hasClass(child, 'watchlist-item')),
    get current() { return current; },
    setCurrent(company) { current = { ...company }; },
    setAsOf(value) { asOf = value; },
    get searches() { return searches; },
  };
}

function rowFor(f, ticker) { return f.rows().find(row => byClass(row, 'watchlist-ticker')?.textContent === ticker); }

test('自选读取规范化证券代码并去重，只保留公司标识；损坏或禁用的存储可以容错', () => {
  const storage = memoryStore(JSON.stringify([
    { ticker: '002920.sz', name: ' 德赛西威 ', ignored: 'not-part-of-watchlist' },
    { ticker: '002920.SZ', name: '重复标的' },
    companies[2],
    { ticker: '<script>', name: '无效代码' },
    null,
  ]));
  assert.deepEqual(readWatchlist(storage), [companies[0], companies[2]]);
  for (const raw of ['{bad-json', '{}', 'null']) assert.deepEqual(readWatchlist(memoryStore(raw)), []);
  assert.deepEqual(readWatchlist({ getItem() { throw new Error('storage denied'); } }), []);
});

test('空自选不会自动收藏，加入当前股票可保存，重复代码不会新增一行', t => {
  const f = fixture(t);
  assert.equal(f.rows().length, 0);
  assert.ok(byClass(f.byId('watchlist-list'), 'watchlist-empty'));
  f.watchlist.refresh();
  assert.equal(f.rows().length, 0);
  assert.equal(f.watchlist.addCurrent(), true);
  assert.equal(f.rows().length, 1);
  assert.deepEqual(readWatchlist(f.storage), [companies[0]]);
  assert.deepEqual(Object.keys(JSON.parse(f.storage.value)[0]).sort(), ['name', 'ticker']);
  f.setCurrent({ ticker: '002920.sz', name: '德赛西威' });
  f.watchlist.addCurrent();
  assert.equal(f.rows().length, 1);
  assert.equal(f.byId('watchlist-count').textContent, '1');
});

test('重新打开页面时恢复已保存的自选列表及当前标的高亮', t => {
  const f = fixture(t, { storage: memoryStore(JSON.stringify(companies)) });
  assert.equal(f.rows().length, 3);
  assert.match(allText(f.byId('watchlist-list')), /德赛西威/);
  assert.match(allText(f.byId('watchlist-list')), /申洲国际/);
  assert.ok(hasClass(rowFor(f, companies[0].ticker), 'is-active'));
});

test('点击自选复用选择守卫，拒绝切换时保留当前高亮，同股票不重复切换', t => {
  let allowed = false;
  const f = fixture(t, { storage: memoryStore(JSON.stringify(companies)), onSelect: () => allowed });
  const currentRow = rowFor(f, companies[0].ticker);
  assert.ok(hasClass(currentRow, 'is-active'));
  assert.equal(byClass(currentRow, 'watchlist-select').getAttribute('aria-current'), 'true');
  byClass(currentRow, 'watchlist-select').click();
  assert.equal(f.calls.length, 0);
  byClass(rowFor(f, companies[1].ticker), 'watchlist-select').click();
  assert.equal(f.current.ticker, companies[0].ticker);
  assert.ok(hasClass(rowFor(f, companies[0].ticker), 'is-active'));
  assert.equal(byClass(rowFor(f, companies[1].ticker), 'watchlist-select').getAttribute('aria-current'), 'false');
  allowed = true;
  byClass(rowFor(f, companies[1].ticker), 'watchlist-select').click();
  assert.equal(f.current.ticker, companies[1].ticker);
  assert.ok(hasClass(rowFor(f, companies[1].ticker), 'is-active'));
  assert.equal(byClass(rowFor(f, companies[0].ticker), 'watchlist-select').getAttribute('aria-current'), 'false');
});

test('移除当前自选只更新收藏列表，不切换公司，搜索按钮打开现有选择入口', t => {
  const f = fixture(t, { storage: memoryStore(JSON.stringify(companies)) });
  byClass(rowFor(f, companies[0].ticker), 'watchlist-remove').click();
  assert.equal(f.current.ticker, companies[0].ticker);
  assert.equal(f.calls.length, 0);
  assert.equal(rowFor(f, companies[0].ticker), undefined);
  assert.deepEqual(readWatchlist(f.storage), companies.slice(1));
  f.byId('watchlist-search').click();
  assert.equal(f.searches, 1);
});

test('异步公司资料补齐自选名称，但代码占位名称不会覆盖已保存的名称', t => {
  const f = fixture(t, { storage: memoryStore(JSON.stringify([{ ticker: '300750.SZ', name: '300750.SZ' }])), initialCompany: { ticker: '300750.SZ', name: '300750.SZ' } });
  f.setCurrent({ ticker: '300750.SZ', name: '宁德时代' });
  f.watchlist.refresh();
  assert.equal(byClass(f.rows()[0], 'watchlist-name').textContent, '宁德时代');
  assert.deepEqual(readWatchlist(f.storage), [{ ticker: '300750.SZ', name: '宁德时代' }]);
  f.setCurrent({ ticker: '300750.SZ', name: '300750.SZ' });
  f.watchlist.refresh();
  assert.equal(byClass(f.rows()[0], 'watchlist-name').textContent, '宁德时代');
  f.setCurrent(companies[1]);
  f.watchlist.refresh();
  assert.equal(f.rows().length, 1);
  assert.ok(!hasClass(f.rows()[0], 'is-active'));
});

test('存储不可写时仍可以使用内存自选，并提示保存失败', t => {
  const denied = { getItem() { throw new Error('storage denied'); }, setItem() { throw new Error('storage full'); } };
  const f = fixture(t, { storage: denied });
  assert.equal(f.watchlist.addCurrent(), true);
  assert.equal(f.rows().length, 1);
  assert.equal(f.byId('watchlist-status').hidden, false);
  assert.match(f.byId('watchlist-status').textContent, /未.*保存|无法.*保存|保存.*失败|仅.*本次/);
  f.setCurrent(companies[1]);
  f.watchlist.addCurrent();
  assert.equal(f.rows().length, 2);
  assert.match(allText(f.byId('watchlist-list')), /德赛西威.*潍柴动力|潍柴动力.*德赛西威/);
});

test('自选公司名称以纯文本呈现，恶意标签不能变成可执行 DOM', t => {
  const name = '<img src=x onerror=alert(1)>';
  const f = fixture(t, { initialCompany: { ticker: '600000.SH', name } });
  f.byId('watchlist-add').click();
  assert.equal(f.rows().length, 1);
  assert.equal(byClass(f.rows()[0], 'watchlist-name').textContent, name);
  assert.ok(!descendants(f.byId('watchlist-list')).some(element => ['IMG', 'SCRIPT'].includes(element.tagName)));
});

test('侧栏涨跌用实际上一交易日、红涨绿跌及零值展示，无行情仅显示中性横线且不入库存储', async t => {
  const saved = [...companies, { ticker: '600519.SH', name: '贵州茅台' }];
  const values = { '002920.SZ': 1.23, '000338.SZ': -1.23, '600519.SH': 0 };
  const requests = [];
  const f = fixture(t, {
    storage: memoryStore(JSON.stringify(saved)), asOf: '2026-10-12',
    async loadQuote(params, { signal }) {
      requests.push({ ...params, signal });
      return params.ticker === '02313.HK' ? null
        : { ticker: params.ticker, asOf: '2026-10-09', requestedAsOf: params.asOf, pctChange: values[params.ticker] };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 4);
  assert.ok(requests.every(item => item.asOf === '2026-10-11' && item.signal instanceof AbortSignal));
  for (const [ticker, text, direction] of [['002920.SZ', '+1.23%', 'is-up'], ['000338.SZ', '-1.23%', 'is-down'], ['600519.SH', '0.00%', null], ['02313.HK', '—', null]]) {
    const row = rowFor(f, ticker), change = byClass(row, 'watchlist-change');
    assert.equal(change.textContent, text);
    assert.equal(row.children.indexOf(change), row.children.indexOf(byClass(row, 'watchlist-remove')) - 1);
    if (direction) assert.ok(hasClass(change, direction));
    else assert.ok(!hasClass(change, 'is-up') && !hasClass(change, 'is-down'));
    assert.match(change.title, ticker === '02313.HK' ? /暂无上一交易日行情/ : /2026-10-09/);
    assert.match(change.getAttribute('aria-label'), ticker === '02313.HK' ? /申洲国际/ : /2026-10-09/);
  }
  f.watchlist.refresh();
  byClass(rowFor(f, '000338.SZ'), 'watchlist-select').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 4, '列表刷新和选股复用同日涨跌');
  assert.equal(f.current.ticker, '000338.SZ');
  f.setCurrent({ ticker: '300750.SZ', name: '宁德时代' });
  f.watchlist.addCurrent();
  assert.ok(JSON.parse(f.storage.value).every(item => Object.keys(item).sort().join(',') === 'name,ticker'));
});
