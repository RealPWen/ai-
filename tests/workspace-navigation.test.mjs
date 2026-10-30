import test from 'node:test';
import assert from 'node:assert/strict';
import { initTableColumns } from '../frontend/src/features/workspace-navigation.js';

test('全部指标切换只改变显示状态，可反复切换且销毁后不再响应', () => {
  const classes = new Set(), attributes = new Map(), listeners = new Map();
  const section = { classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } };
  const button = { setAttribute: (key, value) => attributes.set(key, value),
    addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: type => listeners.delete(type) };
  const controls = initTableColumns({ root: { getElementById: id => id === 'relations' ? section : button } });
  assert.equal(attributes.get('aria-pressed'), 'false');
  assert.equal(button.textContent, '全部指标');
  listeners.get('click')();
  assert.equal(attributes.get('aria-pressed'), 'true'); assert.equal(classes.has('show-all-metrics'), true);
  assert.equal(button.textContent, '精简指标');
  listeners.get('click')();
  assert.equal(attributes.get('aria-pressed'), 'false'); assert.equal(classes.has('show-all-metrics'), false);
  controls.destroy(); assert.equal(listeners.size, 0);
});
