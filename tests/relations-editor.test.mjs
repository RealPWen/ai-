import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelationsEditorWorkflow, initRelationsEditor } from '../frontend/src/features/relations-editor.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const company = { ticker: '02313.HK', name: '申洲国际' };
const row = { relatedTicker: '300001.SZ', relatedName: '已有公司', relationType: 'upstream', evidenceType: 'direct_business', rationale: '公开业务依据', sources: [] };
function report(relations = [row], revision = '0') {
  return { ticker: '002920.SZ', asOf: '2026-10-19', status: relations.length ? 'partial' : 'not_researched', subject: { name: '德赛西威' }, relations,
    meta: { manualRevision: revision, removedRelations: [] } };
}
function fixture(overrides = {}) {
  let context = { ticker: '002920.SZ', asOf: '2026-10-19', name: '德赛西威' }, data = report(), allowed = true;
  const saves = [], reads = [], applied = [], updates = [];
  const workflow = createRelationsEditorWorkflow({ getContext: () => context, getReport: () => data, canEdit: () => allowed,
    saveChanges: async (payload, options) => { saves.push({ payload, options }); return overrides.save?.(payload, options); },
    loadRelations: async (target, options) => { reads.push({ target, options }); return overrides.load ? overrides.load(target, options) : { status: 'ready', data: report([row], '1') }; },
    onSaved: (result, target) => applied.push({ result, target }), onChange: snapshot => updates.push(snapshot) });
  return { workflow, saves, reads, applied, updates, setContext: value => { context = value; }, setReport: value => { data = value; }, setAllowed: value => { allowed = value; } };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('无 AI 关系也能草稿添加港股：POST 数据库后须等待 GET 读取确认才能成功', async () => {
  const post = deferred(), get = deferred(), f = fixture({ save: () => post.promise, load: () => get.promise });
  f.setReport(report([])); assert.equal(f.workflow.open(), true);
  f.workflow.add(company, 'peer', '  业务可比，由我添加  ');
  const pending = f.workflow.save();
  assert.equal(f.saves.length, 1); assert.equal(f.reads.length, 0); assert.equal(f.applied.length, 0);
  assert.deepEqual(f.saves[0].payload, { ticker: '002920.SZ', asOf: '2026-10-19', expectedRevision: '0', changes: [{ action: 'upsert', relatedTicker: '02313.HK', relationType: 'peer', rationale: '业务可比，由我添加' }] });
  assert.equal(f.workflow.snapshot.open, true); assert.equal(f.workflow.close(), false);
  assert.equal(await f.workflow.save(), false); assert.equal(f.saves.length, 1);
  post.resolve({ data: { revision: '1' } }); await settle();
  assert.equal(f.reads.length, 1); assert.equal(f.applied.length, 0); assert.equal(f.workflow.snapshot.phase, 'loading');
  const saved = report([{ ...row, relatedTicker: company.ticker, relatedName: company.name, evidenceType: 'manual' }], '1');
  get.resolve({ status: 'ready', data: saved }); assert.equal(await pending, true);
  assert.equal(f.applied.length, 1); assert.equal(f.applied[0].result.data, saved); assert.equal(f.workflow.snapshot.open, false);
});

test('分类与备注修改、移除、恢复都进入同一草稿，取消不提交', () => {
  const f = fixture(), data = report(); data.meta.removedRelations = [{ relatedTicker: '600000.SH', relatedName: '被移除公司', relationType: 'upstream' }];
  f.setReport(data); f.workflow.open();
  f.workflow.upsert(row, 'downstream', '实际为客户');
  assert.equal(f.workflow.snapshot.rows[0].relationType, 'downstream');
  assert.equal(data.relations[0].relationType, 'upstream');
  f.workflow.remove(row.relatedTicker); assert.equal(f.workflow.snapshot.rows[0].draftAction, 'remove');
  f.workflow.undo(row.relatedTicker); assert.equal(f.workflow.snapshot.changes.length, 0);
  f.workflow.restore('600000.SH'); assert.deepEqual(f.workflow.snapshot.changes, [{ action: 'restore', relatedTicker: '600000.SH' }]);
  assert.equal(f.workflow.snapshot.removed[0].restoring, true);
  f.workflow.add(company, 'peer'); f.workflow.remove(company.ticker);
  assert.equal(f.workflow.snapshot.rows.length, 1); assert.equal(f.workflow.snapshot.changes.length, 1);
  f.workflow.close(); assert.equal(f.saves.length, 0); assert.equal(f.workflow.snapshot.changes.length, 0);
});

test('409 保留草稿，重新读取并核对后使用新 revision 保存', async () => {
  let conflict = true;
  const f = fixture({ save: () => { if (conflict) throw Object.assign(new Error('revision conflict'), { status: 409 }); }, load: async () => ({ status: 'ready', data: report([row], '7') }) });
  f.workflow.open(); f.workflow.upsert(row, 'downstream', '客户');
  assert.equal(await f.workflow.save(), false); assert.equal(f.workflow.snapshot.open, true);
  assert.equal(f.workflow.snapshot.needsReload, true); assert.equal(f.workflow.snapshot.changes[0].rationale, '客户');
  assert.match(f.workflow.snapshot.error, /草稿已保留/); assert.equal(await f.workflow.save(), false); assert.equal(f.saves.length, 1);
  assert.equal(await f.workflow.reload(), true); assert.equal(f.workflow.snapshot.rows[0].relationType, 'downstream');
  conflict = false; assert.equal(await f.workflow.save(), true);
  assert.equal(f.saves[1].payload.expectedRevision, '7'); assert.equal(f.applied.length, 1);
});

test('POST 已确认但 GET 失败时禁止重复 POST，重新读取成功才应用', async () => {
  let readFails = true;
  const f = fixture({ load: async () => { if (readFails) throw new Error('读取离线'); return { status: 'ready', data: report([row], '1') }; } });
  f.workflow.open(); f.workflow.remove(row.relatedTicker);
  assert.equal(await f.workflow.save(), false); assert.equal(f.saves.length, 1); assert.equal(f.applied.length, 0);
  assert.equal(f.workflow.snapshot.submitted, true); assert.match(f.workflow.snapshot.error, /修改已提交.*读取确认失败/);
  assert.equal(await f.workflow.save(), false); f.workflow.upsert(row, 'peer'); assert.equal(f.saves.length, 1);
  readFails = false; assert.equal(await f.workflow.reload(), true); assert.equal(f.saves.length, 1); assert.equal(f.applied.length, 1);
});

test('保存期间切股使会话失效，迟到 POST 不会触发旧股票 GET 或覆盖新页面', async () => {
  const pendingPost = deferred(), f = fixture({ save: () => pendingPost.promise });
  f.workflow.open(); f.workflow.remove(row.relatedTicker); const pending = f.workflow.save();
  f.setContext({ ticker: '601127.SH', asOf: '2026-10-19' }); f.workflow.sync();
  assert.equal(f.workflow.snapshot.open, false); assert.equal(f.saves[0].options.signal.aborted, true);
  pendingPost.resolve({}); assert.equal(await pending, false); assert.equal(f.reads.length, 0); assert.equal(f.applied.length, 0);
  assert.equal(f.saves[0].payload.ticker, '002920.SZ');
});

test('读取确认期间改研究日期，旧 GET 不能覆盖新日期', async () => {
  const pendingRead = deferred(), f = fixture({ load: () => pendingRead.promise });
  f.workflow.open(); f.workflow.remove(row.relatedTicker); const pending = f.workflow.save(); await settle();
  assert.equal(f.reads.length, 1);
  f.setContext({ ticker: '002920.SZ', asOf: '2026-10-18' }); f.workflow.sync();
  assert.equal(f.reads[0].options.signal.aborted, true);
  pendingRead.resolve({ status: 'ready', data: report([row], '1') }); assert.equal(await pending, false); assert.equal(f.applied.length, 0);
});

test('共享只读/未确认权限禁用编辑，已开草稿权限变化后失效，且不依赖 AI 授权', async () => {
  const f = fixture(); f.setAllowed(false); assert.equal(f.workflow.open(), false);
  assert.equal(await f.workflow.save(), false); assert.equal(f.saves.length, 0);
  f.setAllowed(true); assert.equal(f.workflow.open(), true); f.workflow.add(company, 'peer');
  f.setAllowed(false); f.workflow.sync(); assert.equal(f.workflow.snapshot.open, false); assert.equal(f.saves.length, 0);
  f.setAllowed(true); f.setReport({ ...report(), meta: { manualRevision: '0', knownTicker: false } }); assert.equal(f.workflow.open(), false);
});

test('拒绝自关联、重复公司、未支持证券代码与过长备注，读取错股票不冒充保存成功', async () => {
  const f = fixture({ load: async () => ({ status: 'ready', data: { ...report(), ticker: '601127.SH' } }) });
  f.workflow.open();
  assert.throws(() => f.workflow.add({ ticker: '002920.SZ', name: '自己' }, 'upstream'));
  assert.throws(() => f.workflow.add({ ticker: row.relatedTicker, name: '重复' }, 'peer'));
  assert.throws(() => f.workflow.add({ ticker: 'AAPL', name: '无效' }, 'peer'));
  assert.throws(() => f.workflow.add(company, 'peer', '字'.repeat(2001)));
  f.workflow.add(company, 'peer'); assert.equal(await f.workflow.save(), false); assert.equal(f.applied.length, 0);
  assert.match(f.workflow.snapshot.error, /读取确认失败/);
});

test('有效的人工关系也可恢复自动，撤销恢复保留现有值且保存只提交 restore', async () => {
  const f = fixture(), manual = { ...row, evidenceType: 'manual', origin: 'manual', rationale: '我调整过的分类' };
  f.setReport(report([manual], '5')); f.workflow.open();
  f.workflow.restore(row.relatedTicker);
  assert.equal(f.workflow.snapshot.rows[0].draftAction, 'restore');
  assert.deepEqual(f.workflow.snapshot.changes, [{ action: 'restore', relatedTicker: row.relatedTicker }]);
  f.workflow.undo(row.relatedTicker); assert.equal(f.workflow.snapshot.rows[0].editableRationale, '我调整过的分类');
  assert.equal(f.workflow.snapshot.changes.length, 0);
  f.workflow.restore(row.relatedTicker); assert.equal(await f.workflow.save(), true);
  assert.deepEqual(f.saves[0].payload.changes, [{ action: 'restore', relatedTicker: row.relatedTicker }]);
});

test('当前结果的A/H别名不可重复添加；已人工移除的其他上市代码也不会被添加操作恢复', async () => {
  const current = { ...row, relatedTicker: '601633.SH', relatedName: '长城汽车', alternateTickers: ['02333.HK'] };
  const f = fixture(); f.setReport(report([current], '3')); f.workflow.open();
  assert.throws(() => f.workflow.add({ ticker: '02333.HK', name: '长城汽车' }, 'downstream'), /其他上市代码/);
  assert.equal(f.workflow.snapshot.rows.length, 1); assert.equal(f.workflow.snapshot.changes.length, 0);
  f.workflow.close();
  const removed = report([], '4'); removed.meta.removedRelations = [current]; f.setReport(removed); f.workflow.open();
  assert.throws(() => f.workflow.add({ ticker: '02333.HK', name: '长城汽车' }, 'downstream'), /已移除/);
  assert.equal(f.workflow.snapshot.rows.length, 0); assert.equal(f.workflow.snapshot.removed.length, 1);
  assert.equal(f.workflow.snapshot.changes.length, 0); assert.equal(await f.workflow.save(), false); assert.equal(f.saves.length, 0);
  f.workflow.restore('601633.SH');
  assert.deepEqual(f.workflow.snapshot.changes, [{ action: 'restore', relatedTicker: '601633.SH' }]);
});

test('人工编辑最终最多10家，先移除再添加可替换，撤销移除不能使草稿超过10家', () => {
  const f = fixture(), rows = Array.from({ length: 10 }, (_, index) => ({ ...row, relatedTicker: `${600000 + index}.SH`, relatedName: `已有公司 ${index}` }));
  f.setReport(report(rows, '6')); f.workflow.open();
  assert.equal(f.workflow.snapshot.relationCount, 10);
  assert.throws(() => f.workflow.add(company, 'peer'), /最多保存 10 家/);
  assert.equal(f.workflow.snapshot.changes.length, 0);
  f.workflow.upsert(rows[0], 'downstream', '修改已有公司不增加数量');
  assert.equal(f.workflow.snapshot.relationCount, 10);
  f.workflow.remove(rows[1].relatedTicker); assert.equal(f.workflow.snapshot.relationCount, 9);
  f.workflow.add(company, 'peer'); assert.equal(f.workflow.snapshot.relationCount, 10);
  assert.throws(() => f.workflow.undo(rows[1].relatedTicker), /最多保存 10 家/);
  assert.equal(f.workflow.snapshot.relationCount, 10);
  assert.equal(f.workflow.snapshot.rows.find(item => item.relatedTicker === rows[1].relatedTicker).draftAction, 'remove');
  f.workflow.remove(company.ticker); f.workflow.undo(rows[1].relatedTicker);
  assert.equal(f.workflow.snapshot.relationCount, 10);
});

test('人工恢复已移除公司也受10家限制，移除一家公司后才可恢复', () => {
  const f = fixture(), rows = Array.from({ length: 10 }, (_, index) => ({ ...row, relatedTicker: `${600000 + index}.SH` }));
  const data = report(rows, '8'); data.meta.removedRelations = [{ relatedTicker: company.ticker, relatedName: company.name, relationType: 'upstream' }];
  f.setReport(data); f.workflow.open();
  assert.throws(() => f.workflow.restore(company.ticker), /最多保存 10 家/);
  assert.equal(f.workflow.snapshot.removed[0].restoring, false);
  f.workflow.remove(rows[0].relatedTicker); f.workflow.restore(company.ticker);
  assert.equal(f.workflow.snapshot.relationCount, 10); assert.equal(f.workflow.snapshot.removed[0].restoring, true);
  assert.throws(() => f.workflow.undo(rows[0].relatedTicker), /最多保存 10 家/);
});

test('已移除且无自动底稿的公司可搜索后人工重新添加，恢复操作给出明确说明', async () => {
  const f = fixture(), data = report([], '9');
  data.meta.removedRelations = [{ relatedTicker: company.ticker, relatedName: company.name, relationType: null }];
  f.setReport(data); f.workflow.open();
  assert.throws(() => f.workflow.restore(company.ticker), /已无自动记录，请从上方搜索重新添加/);
  assert.equal(f.workflow.snapshot.changes.length, 0);
  f.workflow.add(company, 'downstream', '人工重新加入');
  assert.equal(f.workflow.snapshot.relationCount, 1);
  assert.equal(f.workflow.snapshot.rows[0].relatedName, company.name);
  assert.deepEqual(f.workflow.snapshot.changes, [{ action: 'upsert', relatedTicker: company.ticker, relationType: 'downstream', rationale: '人工重新加入' }]);
  assert.equal(await f.workflow.save(), true);
  assert.deepEqual(f.saves[0].payload.changes, [{ action: 'upsert', relatedTicker: company.ticker, relationType: 'downstream', rationale: '人工重新加入' }]);
});

test('无自动底稿的已移除公司重新添加仍受10家限制，先移除其他公司后才可加入', () => {
  const f = fixture(), rows = Array.from({ length: 10 }, (_, index) => ({ ...row, relatedTicker: `${600000 + index}.SH` }));
  const data = report(rows, '9'); data.meta.removedRelations = [{ relatedTicker: company.ticker, relatedName: company.name, relationType: null }];
  f.setReport(data); f.workflow.open();
  assert.throws(() => f.workflow.add(company, 'peer'), /最多保存 10 家/);
  assert.equal(f.workflow.snapshot.changes.length, 0);
  f.workflow.remove(rows[0].relatedTicker); f.workflow.add(company, 'peer');
  assert.equal(f.workflow.snapshot.relationCount, 10);
  assert.deepEqual(f.workflow.snapshot.changes.map(change => change.action), ['remove', 'upsert']);
  assert.throws(() => f.workflow.undo(rows[0].relatedTicker), /最多保存 10 家/);
});


class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.value = ''; this.textContent = ''; this.open = false; this.hidden = false; this.disabled = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  fire(type, properties = {}) { for (const handler of this.listeners.get(type) || []) handler({ preventDefault() {}, ...properties }); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
}

function editorFixture(t, data) {
  const ids = ['relation-editor-dialog', 'relation-company-search', 'relation-company-results', 'relation-add-type', 'relation-add-note', 'relation-search-status', 'edit-relations', 'relation-editor-context', 'relation-editor-rows', 'relation-editor-empty', 'relation-editor-removed', 'relation-editor-removed-list', 'relation-editor-error', 'relation-editor-save', 'relation-editor-reload', 'relation-editor-cancel', 'close-relation-editor', 'relation-add-company', 'relation-editor-body', 'relation-editor-add-shortcut'];
  const elements = new Map(ids.map(id => [id, new Element()]));
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: id => elements.get(id), createElement: tag => new Element(tag) };
  t.after(() => { globalThis.document = previousDocument; });
  const editor = initRelationsEditor({ getContext: () => ({ ticker: data.ticker, asOf: data.asOf }), getReport: () => data, canEdit: () => true, saveChanges: async () => {}, loadRelations: async () => ({ status: 'ready', data }), onSaved() {}, searchCompanies: async () => [] });
  return { editor, elements };
}

test('备注每次输入即进入草稿，后台状态更新和其他行操作不会丢字或夺走输入焦点', t => {
  const data = report([row, { ...row, relatedTicker: '600000.SH', relatedName: '另一家公司' }]);
  const { editor, elements } = editorFixture(t, data);
  editor.open();
  const originalNote = elements.get('relation-editor-rows').children[0].children[1].children[1];
  originalNote.value = '正在输入的人工备注'; originalNote.focus(); originalNote.fire('input');
  assert.equal(editor.snapshot.changes[0].rationale, '正在输入的人工备注');
  assert.equal(elements.get('relation-editor-rows').children[0].children[1].children[1], originalNote);
  editor.sync(); assert.equal(elements.get('relation-editor-rows').children[0].children[1].children[1], originalNote);
  const otherSelect = elements.get('relation-editor-rows').children[1].children[1].children[0]; otherSelect.value = 'peer'; otherSelect.fire('change');
  const retainedNote = elements.get('relation-editor-rows').children[0].children[1].children[1];
  assert.equal(retainedNote.value, '正在输入的人工备注'); assert.equal(editor.snapshot.changes.length, 2);
  editor.close(); assert.equal(elements.get('relation-editor-dialog').open, false);
});

test('已移除列表仅为仍有自动底稿的公司展示恢复按钮，无底稿明确提示搜索后重新添加', t => {
  const data = report([]);
  data.meta.removedRelations = [
    { relatedTicker: '600000.SH', relatedName: '仍有底稿', relationType: 'upstream' },
    { relatedTicker: company.ticker, relatedName: company.name, relationType: null },
  ];
  const { editor, elements } = editorFixture(t, data); editor.open();
  const removed = elements.get('relation-editor-removed-list').children;
  assert.equal(removed[0].children[1].tagName, 'BUTTON');
  assert.equal(removed[0].children[1].textContent, '恢复自动');
  assert.equal(removed[1].children.length, 1);
  assert.equal(removed[1].children[0].children.at(-1).textContent, '已无自动记录，请从上方搜索重新添加。');
  removed[0].children[1].fire('click');
  assert.deepEqual(editor.snapshot.changes, [{ action: 'restore', relatedTicker: '600000.SH' }]);
  assert.equal(elements.get('relation-editor-removed-list').children[0].children[1].textContent, '撤销恢复');
  editor.close();
});
