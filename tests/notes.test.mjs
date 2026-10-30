import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotesSync, noteKey, draftKey } from '../frontend/src/features/notes-sync.js';
import { noteInput } from '../backend/src/notes-store.mjs';
import { createResearchServer } from '../backend/app.mjs';

const stock = { ticker: '002920.SZ', name: '德赛西威' }, other = { ticker: '02313.HK', name: '申洲国际' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t, overrides = {}, initial = {}) {
  const map = new Map(Object.entries(initial)), rows = new Map(), writes = [];
  const storage = { get length() { return map.size; }, key: i => [...map.keys()][i], getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  const api = { get: async ({ owner, ticker }) => rows.get(`${owner}:${ticker}`) ?? null, save: async value => {
    writes.push(value); const key = `${value.owner}:${value.ticker}`, prev = rows.get(key);
    if ((prev?.version ?? 0) !== value.expectedVersion) throw Object.assign(new Error('conflict'), { code: 'NOTE_CONFLICT' });
    const row = { ...value, version: (prev?.version ?? 0) + 1, updatedAt: new Date().toISOString() }; rows.set(key, row); return row;
  }, ...overrides };
  const sync = createNotesSync({ api, storage, delay: 60000 });
  t.after(() => sync.destroy());
  return { sync, rows, writes, storage, map };
}
test('note validation preserves exact text and rejects missing identity, oversized content and invalid versions', () => {
  const input = { owner: '  潘闻 ', ticker: '02313.hk', companyName: '申洲国际', content: '第一行\n  第二行 <b>原文</b> ', expectedVersion: 0 };
  assert.equal(noteInput(input).content, input.content); assert.equal(noteInput(input).owner, '潘闻');
  for (const change of [{ owner: '' }, { owner: 'a\u200bb' }, { ticker: 'x;DROP' }, { content: null }, { content: 'x'.repeat(50001) }, { content: '\0' }, { expectedVersion: -1 }, { expectedVersion: '1' }, { companyName: '' }]) assert.throws(() => noteInput({ ...input, ...change }));
});
test('viewing does not write; content survives save, clearing, author and stock switching', async t => {
  const f = fixture(t); f.sync.select('潘闻', stock); await tick(); assert.equal(f.writes.length, 0);
  f.sync.edit('第一条\n第二条'); await f.sync.flush(); assert.equal(f.rows.get('潘闻:002920.SZ').content, '第一条\n第二条');
  f.sync.select('另一人', stock); await tick(); assert.equal(f.sync.snapshot().content, '');
  f.sync.edit('另一人的笔记'); await f.sync.flush(); f.sync.select('潘闻', other); await tick(); assert.equal(f.sync.snapshot().content, '');
  f.sync.select('潘闻', stock); await tick(); assert.equal(f.sync.snapshot().content, '第一条\n第二条');
  f.sync.edit(''); await f.sync.flush(); assert.equal(f.rows.get('潘闻:002920.SZ').content, ''); assert.equal(f.rows.size, 2);
});
test('in-flight saves serialize edits and remain attached to the original company', async t => {
  const gate = deferred(); let n = 0;
  const f = fixture(t, { save: async input => { f.writes.push({ ...input }); if (++n === 1) await gate.promise; return { ...input, version: n, updatedAt: '2026-10-30T01:00:00Z' }; } });
  f.sync.select('潘闻', stock); await tick(); f.sync.edit('旧稿'); const pending = f.sync.flush();
  f.sync.edit('最新稿'); f.sync.select('潘闻', other); await tick(); gate.resolve(); await pending;
  assert.deepEqual(f.writes.map(x => [x.ticker, x.content, x.expectedVersion]), [['002920.SZ', '旧稿', 0], ['002920.SZ', '最新稿', 1]]);
  assert.equal(f.sync.snapshot().ticker, other.ticker); assert.equal(f.sync.snapshot().content, '');
  assert.equal(JSON.parse(f.storage.getItem(draftKey('潘闻', stock.ticker))).content, '最新稿');
});
test('late reads cannot replace a different author or company', async t => {
  const gate = deferred(); const f = fixture(t, { get: async ({ ticker }) => ticker === stock.ticker ? gate.promise : null });
  f.sync.select('甲', stock); f.sync.select('乙', other); await tick();
  gate.resolve({ content: '旧响应', version: 1 }); await tick(); assert.equal(f.sync.snapshot().owner, '乙'); assert.equal(f.sync.snapshot().content, '');
});
test('offline drafts persist and retry; unavailable local storage prevents abandoning unsaved text', async t => {
  let online = false;
  const f = fixture(t, { save: async value => { if (!online) throw new Error('offline'); return { ...value, version: 1, updatedAt: '2026-10-30T01:00:00Z' }; } });
  f.sync.select('甲', stock); await tick(); f.sync.edit('断网草稿'); assert.equal(await f.sync.flush(), false);
  assert.equal(f.sync.snapshot().phase, 'error'); assert.equal(JSON.parse(f.storage.getItem(draftKey('甲', stock.ticker))).dirty, true);
  online = true; await f.sync.retry(); assert.equal(f.sync.snapshot().dirty, false);
  f.storage.setItem = () => { throw new Error('quota'); }; f.sync.edit('不能丢失'); assert.equal(f.sync.select('乙', other), false);
});
test('legacy notes migrate once with author attribution, preserve originals, and retain conflicting drafts', async t => {
  const f = fixture(t, {}, { [noteKey(stock.ticker)]: '新本地稿', 'desay-sv-research-note-v1': '更旧的稿', [noteKey(other.ticker)]: '港股笔记' });
  f.rows.set('甲:002920.SZ', { content: '数据库稿', version: 2, updatedAt: '2026-10-30T00:00:00Z' });
  await f.sync.recoverOwner('甲', [stock, other]);
  assert.equal(f.rows.get('甲:02313.HK').content, '港股笔记'); assert.equal(f.rows.get('甲:002920.SZ').content, '数据库稿');
  assert.equal(f.storage.getItem(noteKey(stock.ticker)), '新本地稿');
  f.sync.select('甲', stock); await tick(); assert.equal(f.sync.snapshot().content, '新本地稿'); assert.equal(f.sync.snapshot().conflict, true);
  await f.sync.resolveConflict(false); assert.equal(f.sync.snapshot().content, '数据库稿');
  assert.ok([...f.map].some(([key, text]) => key.includes(':conflict:') && text === '新本地稿'));
  await f.sync.recoverOwner('乙', [stock, other]); assert.equal(f.rows.has('乙:02313.HK'), false);
});
test('stale saves expose a conflict; explicit local choice uses a fresh revision', async t => {
  const f = fixture(t); f.sync.select('甲', stock); await tick();
  f.rows.set('甲:002920.SZ', { content: '其他页面', version: 3 });
  f.sync.edit('我的草稿'); await f.sync.flush(); assert.equal(f.sync.snapshot().phase, 'conflict');
  await f.sync.resolveConflict(true); assert.equal(f.rows.get('甲:002920.SZ').content, '我的草稿'); assert.equal(f.rows.get('甲:002920.SZ').version, 4);
});
test('notes API supports large text, rejects foreign origins, and reports unavailable database', async () => {
  const calls = []; const server = createResearchServer({ notesStore: { get: async params => { calls.push(params); return null; }, save: async input => { calls.push(noteInput(input)); return input; } } });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/api/notes?owner=Alice&ticker=002920.SZ`); assert.equal(response.status, 200); assert.equal((await response.json()).data, null);
    response = await fetch(`${base}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'Alice', ticker: stock.ticker, companyName: stock.name, content: '长'.repeat(40000), expectedVersion: 0 }) }); assert.equal(response.status, 200);
    response = await fetch(`${base}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.invalid' }, body: '{}' }); assert.equal(response.status, 403); assert.equal(calls.length, 2);
  } finally { await new Promise(r => server.close(r)); }
  const unavailable = createResearchServer({}); await new Promise(r => unavailable.listen(0, '127.0.0.1', r));
  try { assert.equal((await fetch(`http://127.0.0.1:${unavailable.address().port}/api/notes`)).status, 503); }
  finally { await new Promise(r => unavailable.close(r)); }
});
