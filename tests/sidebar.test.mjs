import test from 'node:test';
import assert from 'node:assert/strict';
import { initSidebar, SIDEBAR_STORAGE_KEY } from '../frontend/src/features/sidebar.js';

function memoryStore(saved = null) {
  const values = new Map([['company-research.watchlist.v1', '[{"ticker":"002920.SZ","name":"德赛西威"}]']]);
  if (saved !== null) values.set(SIDEBAR_STORAGE_KEY, saved);
  const writes = [];
  return {
    values, writes,
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { values.set(key, value); writes.push([key, value]); },
  };
}

function fixture({ storage = memoryStore(), defaultOpen = true, media = null } = {}) {
  const keyListeners = new Map();
  const root = { activeElement: null, addEventListener: (type, listener) => keyListeners.set(type, listener), removeEventListener: type => keyListeners.delete(type) };
  const makeElement = id => {
    const listeners = new Map(), attributes = new Map(), classes = new Set();
    return {
      id, hidden: false, textContent: '',
      classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
      setAttribute: (key, value) => attributes.set(key, String(value)),
      getAttribute: key => attributes.get(key),
      removeAttribute: key => attributes.delete(key),
      getClientRects: () => [{}],
      addEventListener: (event, handler) => listeners.set(event, handler),
      removeEventListener(event, handler) { if (listeners.get(event) === handler) listeners.delete(event); },
      focus() { root.activeElement = this; },
      click() { listeners.get('click')?.(); },
    };
  };
  const workspace = makeElement('workspace');
  const elements = new Map(['watchlist-sidebar', 'watchlist-toggle', 'watchlist-collapse', 'watchlist-select', 'watchlist-backdrop'].map(id => [id, makeElement(id)]));
  root.getElementById = id => elements.get(id);
  const main = makeElement('main'); root.body = makeElement('body');
  const aside = elements.get('watchlist-sidebar');
  const controls = [elements.get('watchlist-collapse'), elements.get('watchlist-select')];
  aside.contains = node => controls.includes(node);
  aside.querySelectorAll = () => controls;
  root.querySelector = selector => selector === '.workspace' ? workspace : selector === 'main.wrap' ? main : null;
  const sidebar = initSidebar({ root, storage, defaultOpen, media });
  return { root, workspace, main, storage, sidebar, key: event => keyListeners.get('keydown')?.(event), element: id => elements.get(id) };
}

test('桌面首次展开；收起同时隐藏焦点子树、释放主栏宽度，并把焦点交还工具栏', () => {
  const f = fixture(), aside = f.element('watchlist-sidebar'), toggle = f.element('watchlist-toggle'), collapse = f.element('watchlist-collapse');
  assert.equal(f.sidebar.open, true); assert.equal(aside.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-controls'), aside.id);
  assert.equal(collapse.getAttribute('aria-controls'), aside.id);
  f.element('watchlist-select').focus();
  collapse.click();
  assert.equal(f.sidebar.open, false); assert.equal(aside.hidden, true);
  assert.equal(f.workspace.classList.contains('is-sidebar-collapsed'), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(collapse.getAttribute('aria-expanded'), 'false');
  assert.equal(f.root.activeElement, toggle);
  toggle.click();
  assert.equal(aside.hidden, false); assert.equal(f.workspace.classList.contains('is-sidebar-collapsed'), false);
  assert.equal(f.root.activeElement, collapse);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
});

test('展开偏好与自选数据隔离保存，再次初始化优先恢复偏好，不在初始化时写入', () => {
  const storage = memoryStore(), savedWatchlist = storage.values.get('company-research.watchlist.v1');
  const first = fixture({ storage });
  assert.equal(storage.writes.length, 0);
  first.element('watchlist-toggle').click();
  assert.deepEqual(storage.writes, [[SIDEBAR_STORAGE_KEY, 'closed']]);
  first.sidebar.destroy();
  const second = fixture({ storage, defaultOpen: true });
  assert.equal(second.sidebar.open, false); assert.equal(second.element('watchlist-sidebar').hidden, true);
  second.element('watchlist-toggle').click();
  assert.equal(storage.values.get('company-research.watchlist.v1'), savedWatchlist);
  assert.ok(storage.writes.every(([key]) => key === SIDEBAR_STORAGE_KEY));
  const narrow = fixture({ storage, defaultOpen: false });
  assert.equal(narrow.sidebar.open, true);
});

test('窄屏初次可默认收起，损坏或不可读写偏好不妨碍按钮使用', () => {
  const narrow = fixture({ defaultOpen: false });
  assert.equal(narrow.sidebar.open, false); assert.equal(narrow.element('watchlist-toggle').getAttribute('aria-expanded'), 'false');
  narrow.element('watchlist-toggle').click(); assert.equal(narrow.sidebar.open, true);
  const invalid = fixture({ storage: memoryStore('{bad-preference'), defaultOpen: false });
  assert.equal(invalid.sidebar.open, false);
  const denied = fixture({ storage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } } });
  assert.equal(denied.sidebar.open, true);
  assert.doesNotThrow(() => denied.element('watchlist-collapse').click());
  assert.equal(denied.sidebar.open, false); assert.equal(denied.root.activeElement, denied.element('watchlist-toggle'));
  denied.element('watchlist-toggle').click(); assert.equal(denied.sidebar.open, true);
});

test('移除监听后按钮不再改变偏好或显示状态', () => {
  const f = fixture(); f.sidebar.destroy();
  f.element('watchlist-toggle').click(); f.element('watchlist-collapse').click();
  assert.equal(f.sidebar.open, true); assert.equal(f.storage.writes.length, 0);
});


function viewport(matches) {
  const listeners = new Set();
  return { matches, addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener),
    resize(narrow) { this.matches = narrow; listeners.forEach(listener => listener()); } };
}

test('窄屏抽屉独立于桌面偏好，关闭与跨断点切换恢复焦点及主栏', () => {
  const media = viewport(true), storage = memoryStore('open'), f = fixture({ media, storage });
  assert.equal(f.sidebar.open, false);
  f.element('watchlist-toggle').click();
  assert.equal(f.sidebar.open, true); assert.equal(f.main.inert, true);
  assert.equal(f.element('watchlist-sidebar').getAttribute('aria-modal'), 'true');
  assert.equal(f.element('watchlist-backdrop').hidden, false);
  f.key({ key: 'Escape', preventDefault() {} });
  assert.equal(f.sidebar.open, false); assert.equal(f.main.inert, false);
  assert.equal(f.root.activeElement, f.element('watchlist-toggle'));
  assert.equal(storage.writes.length, 0);
  media.resize(false); assert.equal(f.sidebar.open, true);
  f.element('watchlist-toggle').click(); assert.equal(storage.values.get(SIDEBAR_STORAGE_KEY), 'closed');
  media.resize(true); f.element('watchlist-toggle').click(); f.sidebar.closeDrawer();
  media.resize(false); assert.equal(f.sidebar.open, false);
  assert.equal(f.element('watchlist-sidebar').getAttribute('aria-modal'), undefined);
});

test('抽屉循环键盘焦点，遮罩关闭不会修改桌面偏好', () => {
  const f = fixture({ media: viewport(true) });
  f.element('watchlist-toggle').click();
  f.key({ key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(f.root.activeElement, f.element('watchlist-select'));
  f.key({ key: 'Tab', shiftKey: false, preventDefault() {} });
  assert.equal(f.root.activeElement, f.element('watchlist-collapse'));
  f.element('watchlist-backdrop').click(); assert.equal(f.sidebar.open, false);
  assert.equal(f.main.inert, false); assert.equal(f.storage.writes.length, 0);
});

test('原生弹窗打开时将 Escape 与 Tab 交给弹窗，不争抢焦点', () => {
  const f = fixture({ media: viewport(true) });
  f.element('watchlist-toggle').click();
  const previous = f.root.querySelector;
  f.root.querySelector = selector => selector === 'dialog[open]' ? {} : previous(selector);
  f.key({ key: 'Escape', preventDefault() { assert.fail('抽屉不应拦截弹窗 Escape'); } });
  f.key({ key: 'Tab', shiftKey: true, preventDefault() { assert.fail('抽屉不应拦截弹窗 Tab'); } });
  assert.equal(f.sidebar.open, true);
});
