import test from 'node:test';
import assert from 'node:assert/strict';
import { initCompanyPicker, companyMarket, filterCompanies, readRecentCompanies, writeRecentCompanies, sanitizeCompanies, RECENT_COMPANIES_KEY } from '../frontend/src/features/company-picker.js';

const options = [
  { name: '德赛西威', ticker: '002920.SZ' },
  { name: '潍柴动力', ticker: '000338.SZ' },
  { name: '申洲国际', ticker: '02313.HK' },
];
const memoryStore = (initial = null) => {
  let value = initial;
  return { getItem(key) { assert.equal(key, RECENT_COMPANIES_KEY); return value; }, setItem(key, next) { assert.equal(key, RECENT_COMPANIES_KEY); value = next; }, get value() { return value; } };
};

class Element {
  constructor(tagName = 'div') { this.tagName = tagName.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.textContent = ''; this.value = ''; this.hidden = false; this.open = false; this.className = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener(key, handler) { this.listeners.set(key, handler); }
  focus() { document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  closest() { return ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) ? this : null; }
  fire(key, payload = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...payload };
    this.listeners.get(key)?.(event);
    return event;
  }
  click() { return this.fire('click'); }
}

function fixture(t, { storage = memoryStore(), onSelect, searchCompanies, initialCompany } = {}) {
  const ids = ['company-search-scope', 'company-dialog', 'company-search', 'company-results', 'company-error', 'company-code', 'company-name', 'company-manual', 'company-current-name', 'company-current-ticker', 'company-current-market', 'company-results-label', 'company-results-count', 'company-empty', 'company-recent-section', 'company-recent', 'company-switch', 'change-company', 'close-company', 'company-add-from-search', 'company-search-form', 'company-custom-form'];
  const elements = new Map(ids.map(id => [id, new Element(['company-search', 'company-code', 'company-name'].includes(id) ? 'input' : 'div')]));
  const filters = ['all', 'a', 'h', 'other'].map(market => Object.assign(new Element('button'), { dataset: { companyMarket: market } }));
  const root = new Element('document');
  root.getElementById = id => elements.get(id);
  root.createElement = tag => new Element(tag);
  root.querySelectorAll = selector => selector === '[data-company-market]' ? filters : [];
  root.querySelector = selector => selector === 'dialog[open]' ? (root.otherDialog || (elements.get('company-dialog').open ? elements.get('company-dialog') : null)) : null;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = root;
  globalThis.window = { localStorage: storage };
  t.after(() => { globalThis.document = previousDocument; globalThis.window = previousWindow; });
  let current = { ...(initialCompany || options[0]) };
  const calls = [];
  const picker = initCompanyPicker({ options, searchCompanies, getCompany: () => current, onSelect(company) { calls.push(company); const result = onSelect?.(company); if (result !== false) current = company; return result; } });
  return { elements, filters, root, picker, calls, get current() { return current; }, byId: id => elements.get(id), rows: () => elements.get('company-results').children };
}

function allText(element) { return [element.textContent, ...element.children.map(allText)].join(''); }

test('股票筛选区分 A/H/其他市场，代码保留前导零，支持名称与代码搜索', () => {
  assert.equal(companyMarket('002920.SZ'), 'a'); assert.equal(companyMarket('600000.SH'), 'a'); assert.equal(companyMarket('920000.BJ'), 'a');
  assert.equal(companyMarket('02313.HK'), 'h'); assert.equal(companyMarket('AAPL'), 'other'); assert.equal(companyMarket('002920'), 'other');
  assert.equal(filterCompanies(options, ' 0029 ')[0].ticker, '002920.SZ');
  assert.equal(filterCompanies(options, '申洲', 'h').length, 1);
  assert.equal(filterCompanies(options, '申洲', 'a').length, 0);
});

test('历史只保留有限的安全标识，校验去重并容错损坏/禁用的本地存储', () => {
  const unsafe = [{ ticker: '002920.sz', name: ' 德赛西威 ', token: 'never-persist' }, { ticker: '002920.SZ', name: 'duplicate' }, { ticker: '<script>', name: 'invalid' }, { ticker: '02313.HK', name: {} }, null];
  assert.deepEqual(sanitizeCompanies(unsafe), [{ ticker: '002920.SZ', name: '德赛西威' }]);
  for (const raw of ['{bad-json', '{}', 'null', JSON.stringify(unsafe)]) {
    assert.equal(readRecentCompanies(memoryStore(raw)).length, raw === JSON.stringify(unsafe) ? 1 : 0);
  }
  const denied = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } };
  assert.deepEqual(readRecentCompanies(denied), []);
  assert.equal(writeRecentCompanies(denied, options).length, 3);
  const store = memoryStore();
  writeRecentCompanies(store, [...unsafe, ...Array.from({ length: 20 }, (_, i) => ({ ticker: `TEST${i}`, name: `Company ${i}` }))]);
  const saved = JSON.parse(store.value);
  assert.equal(saved.length, 8);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['name', 'ticker']);
  assert.doesNotMatch(store.value, /token|never-persist/);
});

test('股票选择展示当前行，搜索和市场筛选仅操作本地列表；同代码不触发切换', t => {
  const f = fixture(t); f.byId('company-switch').click();
  assert.equal(f.byId('company-dialog').open, true);
  assert.equal(f.root.activeElement, f.byId('company-search'));
  assert.equal(f.byId('company-current-name').textContent, '德赛西威');
  assert.equal(f.rows()[0].className, 'company-result is-current');
  assert.equal(f.rows()[0].attributes.get('aria-pressed'), 'true');
  f.filters[2].click();
  assert.equal(f.rows().length, 1); assert.match(allText(f.rows()[0]), /申洲国际/);
  assert.equal(f.filters[2].attributes.get('aria-pressed'), 'true');
  f.filters[0].click();
  f.byId('company-search').value = '002920'; f.byId('company-search').fire('input');
  f.byId('company-search-form').fire('submit');
  assert.equal(f.calls.length, 0); assert.equal(f.byId('company-dialog').open, false); assert.equal(f.byId('company-search').value, '');
});

test('成功切换记住前后标的，最近记录排除当前；守卫拒绝不关闭或覆盖历史', t => {
  const storage = memoryStore(); let allowed = false;
  const f = fixture(t, { storage, onSelect: () => allowed }); f.picker.open();
  f.rows()[1].click();
  assert.equal(f.current.ticker, '002920.SZ'); assert.equal(f.byId('company-dialog').open, true);
  assert.equal(f.byId('company-error').hidden, false); assert.equal(storage.value, null);
  allowed = true; f.rows()[1].click();
  assert.equal(f.current.ticker, '000338.SZ'); assert.equal(f.byId('company-dialog').open, false);
  assert.deepEqual(JSON.parse(storage.value).map(company => company.ticker), ['000338.SZ', '002920.SZ']);
  f.picker.open();
  const recent = f.byId('company-recent').children;
  assert.equal(recent.length, 1); assert.match(allText(recent[0]), /德赛西威/); assert.doesNotMatch(allText(recent[0]), /潍柴动力/);
  recent[0].click(); assert.equal(f.current.ticker, '002920.SZ');
});

test('手动添加不猜交易所，搜索无结果可补代码，存储失败不影响切换与最近记录', t => {
  const denied = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const f = fixture(t, { storage: denied }); f.picker.open();
  f.byId('company-search').value = '000001'; f.byId('company-search').fire('input'); f.byId('company-search-form').fire('submit');
  assert.equal(f.byId('company-manual').open, true); assert.equal(f.byId('company-code').value, '000001');
  f.byId('company-name').value = '<img onerror=alert(1)>';
  f.byId('company-custom-form').fire('submit');
  assert.equal(f.current.ticker, '000001'); assert.equal(f.byId('company-dialog').open, false);
  f.picker.open(); assert.match(allText(f.rows()[0]), /<img onerror=alert\(1\)>/);
  assert.equal(f.rows()[0].children[1].children[0].children.length, 0);
  assert.equal(f.byId('company-recent').children.length, 1);
  f.byId('company-code').value = 'bad code'; f.byId('company-custom-form').fire('submit');
  assert.equal(f.byId('company-error').hidden, false); assert.equal(f.byId('company-dialog').open, true);
});

test('快捷键避开编辑区和其他弹窗，搜索与结果行支持键盘导航', t => {
  const f = fixture(t);
  f.root.fire('keydown', { key: '/', target: f.byId('company-search') }); assert.equal(f.byId('company-dialog').open, false);
  f.root.otherDialog = new Element('dialog'); f.root.fire('keydown', { key: '/' }); assert.equal(f.byId('company-dialog').open, false);
  f.root.otherDialog = null;
  const slash = f.root.fire('keydown', { key: '/' }); assert.equal(slash.defaultPrevented, true); assert.equal(f.byId('company-dialog').open, true);
  f.byId('company-search').fire('keydown', { key: 'ArrowDown' }); assert.equal(f.root.activeElement, f.rows()[0]);
  f.rows()[0].fire('keydown', { key: 'End' }); assert.equal(f.root.activeElement, f.rows()[2]);
  f.rows()[2].fire('keydown', { key: 'Home' }); assert.equal(f.root.activeElement, f.rows()[0]);
  f.rows()[0].fire('keydown', { key: 'ArrowUp' }); assert.equal(f.root.activeElement, f.byId('company-search'));
  f.byId('company-search-form').fire('submit'); assert.equal(f.calls.length, 0); assert.equal(f.root.activeElement, f.rows()[0]);
});

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

function deferredSearch() {
  const requests = [];
  return { requests, searchCompanies(params) { const pending = deferred(); requests.push({ ...params, ...pending }); return pending.promise; } };
}

test('数据库搜索打开默认 20 条、输入防抖，迟到响应不串查询且真实名称优先', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const remote = deferredSearch();
  const f = fixture(t, { searchCompanies: remote.searchCompanies, initialCompany: { ticker: '300750.SZ', name: '300750.SZ' } });
  f.picker.open();
  assert.equal(remote.requests.length, 1); assert.equal(remote.requests[0].q, ''); assert.equal(remote.requests[0].limit, 20);
  assert.equal(remote.requests[0].market, 'all');
  assert.equal(f.byId('company-search-scope').textContent, 'A股 / 港股股票');
  assert.equal(f.byId('company-search-scope').hidden, true);
  assert.match(allText(f.rows()[0]), /300750.SZ/);
  f.byId('company-search').value = '3007'; f.byId('company-search').fire('input');
  assert.equal(remote.requests[0].signal.aborted, true);
  t.mock.timers.tick(299); assert.equal(remote.requests.length, 1);
  t.mock.timers.tick(1); assert.equal(remote.requests.length, 2); assert.equal(remote.requests[1].limit, 50);
  f.byId('company-search').value = '宁德'; f.byId('company-search').fire('input');
  t.mock.timers.tick(300); assert.equal(remote.requests.length, 3); assert.equal(remote.requests[1].signal.aborted, true);
  remote.requests[2].resolve({ items: [{ ticker: '300750.SZ', name: '宁德时代', market: 'A' }, { ticker: '300751.SZ', name: '宁德示例', market: 'A' }] });
  await settle();
  assert.equal(f.rows().length, 2); assert.match(allText(f.rows()[0]), /宁德时代/); assert.equal(f.rows()[0].className, 'company-result is-current');
  assert.doesNotMatch(f.byId('company-results-count').textContent, /搜索中/);
  remote.requests[1].resolve([{ ticker: '300777.SZ', name: '旧查询返回' }]); remote.requests[0].resolve([{ ticker: '600000.SH', name: '旧默认返回' }]);
  await settle();
  assert.equal(f.rows().length, 2); assert.doesNotMatch(allText(f.byId('company-results')), /旧查询|旧默认/);
  f.rows()[1].click(); assert.equal(f.current.name, '宁德示例'); assert.equal(f.current.ticker, '300751.SZ');
});

test('数据库请求关闭后不重绘，重开及延迟 close 事件不会接收旧响应', async t => {
  const remote = deferredSearch(); const f = fixture(t, { searchCompanies: remote.searchCompanies });
  f.picker.open();
  const before = [...f.rows()]; f.picker.close();
  assert.equal(remote.requests[0].signal.aborted, true);
  assert.equal(f.byId('company-results').attributes.get('aria-busy'), 'false');
  remote.requests[0].resolve([{ ticker: '600000.SH', name: '不应出现' }]); await settle();
  assert.deepEqual(f.rows(), before);
  f.picker.open(); assert.equal(remote.requests.length, 2);
  f.byId('company-dialog').fire('close'); // A queued close event from the previous opening.
  assert.equal(remote.requests[1].signal.aborted, false);
  remote.requests[1].resolve([{ ticker: '600001.SH', name: '重新打开结果' }]); await settle();
  assert.match(allText(f.byId('company-results')), /重新打开结果/); assert.doesNotMatch(allText(f.byId('company-results')), /不应出现/);
  f.picker.close();
});

test('数据库失败保留本地结果和明确错误，不覆盖未保存笔记守卫提示；abort 清理 loading', async t => {
  const remote = deferredSearch(); const f = fixture(t, { searchCompanies: remote.searchCompanies, onSelect: () => false });
  f.picker.open(); remote.requests[0].reject(new Error('connection failed')); await settle();
  assert.equal(f.rows().length, 3); assert.match(f.byId('company-error').textContent, /搜索失败.*已添加标的/);
  assert.equal(f.byId('company-error').hidden, false); assert.equal(f.byId('company-empty').hidden, true);
  assert.equal(f.byId('company-results').attributes.get('aria-busy'), 'false');
  f.picker.open(); f.rows()[1].click();
  const guard = f.byId('company-error').textContent;
  remote.requests[1].reject(new Error('another failure')); await settle();
  assert.equal(f.byId('company-error').textContent, guard); assert.match(guard, /尚未切换/); assert.equal(f.byId('company-dialog').open, true);
  f.picker.open(); remote.requests[2].reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); await settle();
  assert.equal(f.byId('company-error').hidden, true); assert.doesNotMatch(f.byId('company-results-count').textContent, /搜索中/);
  assert.equal(f.byId('company-results').attributes.get('aria-busy'), 'false'); f.picker.close();
});

test('中文 IME 完成后防抖，港股请求独立市场，其他仅筛本地且候选不超过 50', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const remote = deferredSearch(); const f = fixture(t, { searchCompanies: remote.searchCompanies }); f.picker.open();
  f.byId('company-search').fire('compositionstart');
  assert.equal(remote.requests[0].signal.aborted, true);
  f.byId('company-search').value = '申'; f.byId('company-search').fire('input', { isComposing: true }); t.mock.timers.tick(1000);
  assert.equal(remote.requests.length, 1);
  f.byId('company-search-form').fire('submit', { isComposing: true }); assert.equal(f.calls.length, 0);
  f.byId('company-search').value = '申洲'; f.byId('company-search').fire('compositionend'); t.mock.timers.tick(300);
  assert.equal(remote.requests.length, 2); assert.equal(remote.requests[1].q, '申洲');
  f.filters[2].click(); assert.equal(remote.requests[1].signal.aborted, true);
  assert.match(f.byId('company-search-scope').textContent, /港股/);
  assert.equal(remote.requests.length, 3); assert.equal(remote.requests[2].market, 'HK');
  assert.equal(f.rows().length, 1); assert.match(allText(f.rows()[0]), /申洲国际/);
  f.filters[3].click(); assert.equal(remote.requests.length, 3); assert.equal(remote.requests[2].signal.aborted, true);
  assert.equal(f.byId('company-search-scope').hidden, false);
  f.byId('company-search').value = ''; f.byId('company-search').fire('input'); f.filters[0].click();
  assert.equal(remote.requests.length, 4);
  remote.requests[3].resolve(Array.from({ length: 100 }, (_, i) => ({ ticker: `${String(600000 + i)}.SH`, name: `数据库标的${i}` })));
  await settle(); assert.equal(f.rows().length, 50); assert.equal(f.rows()[0].className, 'company-result is-current');
  assert.equal(f.byId('company-recent-section').hidden, true); f.picker.close();
});

test('港股空查询使用数据库列出28只，名称和前导零代码可选，旧A股搜索不能覆盖', async t => {
  const remote = deferredSearch(), f = fixture(t, { searchCompanies: remote.searchCompanies });
  f.picker.open(); const oldA = remote.requests[0]; f.filters[2].click();
  const hk = remote.requests[1]; assert.equal(hk.market, 'HK'); assert.equal(hk.limit, 50); assert.equal(hk.q, '');
  const records = [{ ticker: '00700.HK', name: '腾讯控股' }, { ticker: '02313.HK', name: '申洲国际' },
    ...Array.from({ length: 26 }, (_, index) => ({ ticker: `${String(index + 1).padStart(5, '0')}.HK`, name: `港股${index}` }))];
  hk.resolve(records); await settle(); assert.equal(f.rows().length, 28); assert.match(allText(f.rows()[0]), /腾讯控股.*00700.HK/);
  oldA.resolve([{ ticker: '600000.SH', name: '迟到的A股' }]); await settle(); assert.doesNotMatch(allText(f.byId('company-results')), /迟到的A股/);
  f.rows()[0].click(); assert.equal(f.current.ticker, '00700.HK'); assert.equal(f.current.name, '腾讯控股');
});
