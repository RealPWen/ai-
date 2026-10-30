import { assertRelationsContext, relationLabels, evidenceLabels } from './relations-data.js';

const contextKey = context => `${context?.ticker || ''}|${context?.asOf || ''}`;
const supportedTicker = value => typeof value === 'string' && /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/.test(value);
const types = ['upstream', 'peer', 'downstream'];
const noAutomaticRecord = '已无自动记录，请从上方搜索重新添加。';
const memo = row => row?.evidenceType === 'manual' ? row.rationale || '' : '';
const matchesTicker = (row, ticker) => row.relatedTicker === ticker || row.alternateTickers?.includes(ticker);

// The draft remains separate from the report until a committed POST is read back.
export function createRelationsEditorWorkflow({ getContext, getReport, canEdit, saveChanges, loadRelations, onSaved, onChange = () => {} }) {
  let opened = false, phase = 'idle', context = null, report = null, error = '', needsReload = false, submitted = false;
  let generation = 0, controller = null;
  const changes = new Map(), names = new Map();
  const busy = () => phase === 'saving' || phase === 'loading';
  const available = () => canEdit() && getReport() && getReport().meta?.knownTicker !== false;
  function relationCount(proposed = changes) {
    const tickers = new Set((report?.relations || []).map(row => row.relatedTicker));
    for (const change of proposed.values()) {
      if (change.action === 'remove') tickers.delete(change.relatedTicker);
      else tickers.add(change.relatedTicker);
    }
    return tickers.size;
  }
  function changeDraft(ticker, change) {
    const proposed = new Map(changes);
    if (change) proposed.set(ticker, change); else proposed.delete(ticker);
    if (relationCount(proposed) > 10) throw new Error('每只股票最多保存 10 家关联公司，请先移除一家公司再添加或恢复。');
    if (change) changes.set(ticker, change); else changes.delete(ticker);
  }
  function snapshot() {
    const rows = new Map((report?.relations || []).map(row => [row.relatedTicker, { ...row, editableRationale: memo(row) }]));
    for (const change of changes.values()) {
      if (change.action === 'upsert') rows.set(change.relatedTicker, { ...rows.get(change.relatedTicker), relatedTicker: change.relatedTicker,
        relatedName: names.get(change.relatedTicker) || rows.get(change.relatedTicker)?.relatedName || change.relatedTicker,
        relationType: change.relationType, editableRationale: change.rationale, draftAction: 'upsert' });
      if (change.action === 'remove' && rows.has(change.relatedTicker)) rows.set(change.relatedTicker, { ...rows.get(change.relatedTicker), draftAction: 'remove' });
      if (change.action === 'restore' && rows.has(change.relatedTicker)) rows.set(change.relatedTicker, { ...rows.get(change.relatedTicker), draftAction: 'restore' });
    }
    return { open: opened, phase, busy: busy(), context: context ? { ...context } : null, report, error, needsReload, submitted,
      changes: [...changes.values()].map(change => ({ ...change })), rows: [...rows.values()],
      removed: (report?.meta?.removedRelations || []).map(row => ({ ...row, restoring: changes.get(row.relatedTicker)?.action === 'restore' })),
      relationCount: relationCount(), canOpen: Boolean(available()), canSave: opened && !busy() && !needsReload && !submitted && changes.size > 0 && relationCount() <= 10 && canEdit() };
  }
  const emit = () => onChange(snapshot());
  function discard() {
    generation += 1; controller?.abort(); controller = null;
    opened = false; phase = 'idle'; context = null; report = null; error = ''; needsReload = false; submitted = false;
    changes.clear(); names.clear(); emit();
  }
  function sync() {
    if (opened && (contextKey(context) !== contextKey(getContext()) || !canEdit())) discard();
    else emit();
  }
  function editable() {
    sync();
    return opened && !busy() && !submitted && canEdit();
  }
  function current(token, target) {
    return opened && generation === token && contextKey(target) === contextKey(getContext()) && canEdit();
  }
  function setError(message) { error = message; emit(); }
  async function readBack({ afterSave = false } = {}) {
    if (!opened || busy() || !canEdit()) return false;
    const token = ++generation, target = { ...context };
    controller = new AbortController(); phase = 'loading'; error = ''; emit();
    try {
      const result = await loadRelations(target, { signal: controller.signal });
      if (!current(token, target)) return false;
      assertRelationsContext(result?.data, target);
      if (!result?.data) throw new Error('未读取到保存后的关系，请重新读取。');
      if (afterSave || submitted) {
        onSaved(result, target); discard(); return true;
      }
      report = result.data; needsReload = false; phase = 'idle'; error = '已重新读取，请核对保留的草稿后保存。'; emit(); return true;
    } catch (failure) {
      if (!current(token, target)) return false;
      phase = 'idle'; needsReload = true;
      error = submitted ? `修改已提交，读取确认失败：${failure.message}。请重新读取。` : failure.message;
      emit(); return false;
    }
  }
  return {
    get snapshot() { return snapshot(); }, sync,
    open() {
      sync(); if (opened || !available()) return false;
      const nextContext = { ...getContext() }, nextReport = getReport();
      assertRelationsContext(nextReport, nextContext);
      context = nextContext; report = nextReport; opened = true; phase = 'idle'; error = ''; needsReload = false; submitted = false;
      changes.clear(); names.clear(); emit(); return true;
    },
    close() { if (busy()) return false; discard(); return true; },
    upsert(company, relationType, rationale = '') {
      if (!editable()) return;
      const ticker = company?.ticker || company?.relatedTicker;
      if (!supportedTicker(ticker) || ticker === context.ticker || !types.includes(relationType)) throw new Error('请选择有效的其他 A 股或港股公司及关系。');
      if (typeof rationale !== 'string' || rationale.length > 2000) throw new Error('备注不能超过 2000 字。');
      const original = report.relations.find(row => row.relatedTicker === ticker);
      names.set(ticker, company.name || company.relatedName || original?.relatedName || ticker);
      if (original && original.relationType === relationType && memo(original) === rationale.trim()) changeDraft(ticker);
      else changeDraft(ticker, { action: 'upsert', relatedTicker: ticker, relationType, rationale: rationale.trim() });
      error = ''; emit();
    },
    add(company, relationType, rationale = '') {
      if (!editable()) return;
      const ticker = company?.ticker;
      if (snapshot().rows.some(row => matchesTicker(row, ticker)) || report.meta?.removedRelations?.some(row => types.includes(row.relationType) && matchesTicker(row, ticker))) throw new Error('该公司已在关系或已移除列表中（含其他上市代码），请直接修改或恢复。');
      this.upsert(company, relationType, rationale);
    },
    remove(ticker) {
      if (!editable()) return;
      if (!report.relations.some(row => row.relatedTicker === ticker)) changes.delete(ticker);
      else changes.set(ticker, { action: 'remove', relatedTicker: ticker });
      error = ''; emit();
    },
    undo(ticker) { if (editable()) { changeDraft(ticker); error = ''; emit(); } },
    restore(ticker) {
      if (!editable()) return;
      const existing = report.relations.some(row => row.relatedTicker === ticker && row.evidenceType === 'manual');
      const removed = report.meta?.removedRelations?.find(row => row.relatedTicker === ticker);
      if (!existing && !removed) return;
      if (!existing && !types.includes(removed.relationType)) throw new Error(noAutomaticRecord);
      changeDraft(ticker, { action: 'restore', relatedTicker: ticker }); error = ''; emit();
    },
    setError,
    reload: () => readBack(),
    async save() {
      sync(); if (!snapshot().canSave) return false;
      const target = { ...context }, token = ++generation;
      const payload = { ticker: target.ticker, asOf: target.asOf, expectedRevision: report.meta.manualRevision,
        changes: [...changes.values()].map(change => ({ ...change })) };
      controller = new AbortController(); phase = 'saving'; error = ''; emit();
      try {
        await saveChanges(payload, { signal: controller.signal });
        if (!current(token, target)) return false;
        submitted = true; phase = 'idle';
        return readBack({ afterSave: true });
      } catch (failure) {
        if (!current(token, target)) return false;
        phase = 'idle';
        needsReload = failure.status === 409 || ['TIMEOUT', 'NETWORK_ERROR', 'ABORTED'].includes(failure.code);
        error = failure.status === 409 ? '关系已被其他操作更新。草稿已保留，请重新读取后核对。'
          : needsReload ? '保存结果尚未确认，草稿已保留。请重新读取后核对。' : failure.message;
        emit(); return false;
      }
    },
  };
}

const make = (tag, className = '', text = '') => {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
};
const button = (text, action) => {
  const element = make('button', 'button subtle', text); element.type = 'button'; element.addEventListener('click', action); return element;
};
function relationshipSelect(value) {
  const select = make('select');
  for (const type of types) { const option = make('option', '', relationLabels[type]); option.value = type; select.append(option); }
  select.value = value; return select;
}
export function initRelationsEditor(options) {
  const byId = id => document.getElementById(id), dialog = byId('relation-editor-dialog');
  const search = byId('relation-company-search'), results = byId('relation-company-results');
  let workflow, searchController = null, searchGeneration = 0, searchTimer = null, chosen = null, composing = false;
  let renderedRows = '', renderedRemoved = '', preserveInputs = false;
  const addType = byId('relation-add-type'), addNote = byId('relation-add-note');
  function cancelSearch() {
    searchGeneration += 1; searchController?.abort(); searchController = null;
    if (searchTimer !== null) clearTimeout(searchTimer); searchTimer = null;
  }
  function feedback(message = '') { byId('relation-search-status').textContent = message; }
  function safeAction(action) { try { action(); } catch (error) { workflow.setError(error.message); } }
  function renderRow(row, snapshot) {
    const article = make('article', `relation-editor-row${row.draftAction === 'remove' ? ' is-removed' : ''}`);
    const identity = make('div', 'relation-editor-identity');
    identity.append(make('strong', '', row.relatedName), make('span', '', [row.relatedTicker, ...(row.alternateTickers || [])].join(' / ')));
    const provenance = row.draftAction === 'restore' ? '待恢复' : row.draftAction === 'upsert' ? '待保存' : evidenceLabels[row.evidenceType] || '人工添加';
    const origin = make('span', 'relation-editor-origin', provenance); identity.append(origin);
    const select = relationshipSelect(row.relationType); select.setAttribute('aria-label', `${row.relatedName}的分类`);
    const note = make('input', 'relation-editor-note'); note.type = 'text'; note.maxLength = 2000; note.value = row.editableRationale;
    note.placeholder = '备注（选填）'; note.setAttribute('aria-label', `${row.relatedName}的备注`);
    const update = () => safeAction(() => workflow.upsert(row, select.value, note.value));
    select.addEventListener('change', update); note.addEventListener('change', update);
    note.addEventListener('input', () => {
      preserveInputs = true;
      try { update(); } finally { preserveInputs = false; }
      const changed = workflow.snapshot.changes.some(change => change.relatedTicker === row.relatedTicker && change.action === 'upsert');
      origin.textContent = changed ? '待保存' : evidenceLabels[row.evidenceType] || '人工添加';
    });
    const remove = row.draftAction === 'remove' ? button('撤销移除', () => safeAction(() => workflow.undo(row.relatedTicker))) : button('移除', () => workflow.remove(row.relatedTicker));
    select.disabled = note.disabled = snapshot.busy || snapshot.submitted || ['remove', 'restore'].includes(row.draftAction); remove.disabled = snapshot.busy || snapshot.submitted;
    const actions = make('div', 'relation-editor-row-actions');
    if (row.evidenceType === 'manual' && row.draftAction !== 'remove') {
      const restore = button(row.draftAction === 'restore' ? '撤销恢复' : '恢复自动', () => safeAction(() => row.draftAction === 'restore' ? workflow.undo(row.relatedTicker) : workflow.restore(row.relatedTicker)));
      restore.disabled = snapshot.busy || snapshot.submitted; actions.append(restore);
    }
    actions.append(remove);
    const controls = make('div', 'relation-editor-row-controls'); controls.append(select, note, actions);
    article.append(identity, controls);
    if (row.rationale && row.evidenceType !== 'manual') {
      const details = make('details', 'relation-editor-evidence');
      details.append(make('summary', '', '原依据'), make('p', '', row.rationale)); article.append(details);
    }
    return article;
  }
  function render(snapshot) {
    const entry = byId('edit-relations'); entry.disabled = !snapshot.canOpen || snapshot.busy;
    entry.title = options.readOnly?.() ? '局域网仅支持只读浏览，请在本机修改。' : !snapshot.canOpen ? '等待读取关系与本机权限。' : '';
    if (!snapshot.open) {
      if (dialog.open) dialog.close(); cancelSearch(); chosen = null; renderedRows = ''; renderedRemoved = ''; return;
    }
    byId('relation-editor-context').textContent = `${snapshot.context.name || snapshot.report.subject.name} · ${snapshot.context.ticker} · ${snapshot.context.asOf} · ${snapshot.relationCount}/10 家`;
    const rowKey = JSON.stringify([snapshot.rows, snapshot.busy, snapshot.submitted]);
    if (rowKey !== renderedRows) {
      if (!preserveInputs) byId('relation-editor-rows').replaceChildren(...snapshot.rows.map(row => renderRow(row, snapshot)));
      renderedRows = rowKey;
    }
    byId('relation-editor-empty').hidden = snapshot.rows.length > 0;
    const removed = byId('relation-editor-removed'); removed.hidden = !snapshot.removed.length;
    const removedKey = JSON.stringify([snapshot.removed, snapshot.busy, snapshot.submitted]);
    if (removedKey !== renderedRemoved) byId('relation-editor-removed-list').replaceChildren(...snapshot.removed.map(row => {
      const item = make('div', 'relation-editor-removed-row'), text = make('div');
      text.append(make('strong', '', row.relatedName), make('span', '', [row.relatedTicker, ...(row.alternateTickers || [])].join(' / ')));
      item.append(text);
      if (types.includes(row.relationType)) {
        const restore = button(row.restoring ? '撤销恢复' : '恢复自动', () => safeAction(() => row.restoring ? workflow.undo(row.relatedTicker) : workflow.restore(row.relatedTicker)));
        restore.disabled = snapshot.busy || snapshot.submitted; item.append(restore);
      } else text.append(make('span', '', noAutomaticRecord));
      return item;
    }));
    renderedRemoved = removedKey;
    const error = byId('relation-editor-error'); error.textContent = snapshot.error; error.hidden = !snapshot.error;
    byId('relation-editor-save').disabled = !snapshot.canSave;
    byId('relation-editor-save').textContent = snapshot.phase === 'saving' ? '保存中…' : snapshot.phase === 'loading' ? '读取确认中…' : '保存修改';
    byId('relation-editor-reload').hidden = !snapshot.needsReload;
    byId('relation-editor-reload').disabled = snapshot.busy;
    byId('relation-editor-cancel').disabled = byId('close-relation-editor').disabled = snapshot.busy;
    byId('relation-editor-add-shortcut').disabled = snapshot.busy || snapshot.submitted;
    for (const element of [search, addType, addNote, byId('relation-add-company')]) element.disabled = snapshot.busy || snapshot.submitted;
    byId('relation-add-company').disabled ||= !chosen;
    if (snapshot.busy || snapshot.submitted) { cancelSearch(); results.replaceChildren(); }
    dialog.setAttribute('aria-busy', String(snapshot.busy));
    if (!dialog.open) {
      search.value = ''; addNote.value = ''; addType.value = 'upstream'; chosen = null; composing = false;
      results.replaceChildren(); feedback(); dialog.showModal();
      byId('relation-editor-body').scrollTop = 0; byId('close-relation-editor').focus();
    }
  }
  workflow = createRelationsEditorWorkflow({ ...options, onChange: render });
  async function runSearch() {
    cancelSearch(); chosen = null; byId('relation-add-company').disabled = true; results.replaceChildren();
    const q = search.value.trim(); if (!q) { feedback(); return; }
    const token = searchGeneration, target = contextKey(options.getContext());
    searchController = new AbortController(); feedback('搜索中…');
    try {
      const companies = await options.searchCompanies({ q, limit: 20, market: 'all' }, { signal: searchController.signal });
      if (token !== searchGeneration || !workflow.snapshot.open || workflow.snapshot.busy || workflow.snapshot.submitted || target !== contextKey(options.getContext())) return;
      const snapshot = workflow.snapshot;
      const rows = companies.filter(company => supportedTicker(company.ticker) && company.ticker !== snapshot.context.ticker);
      results.replaceChildren(...rows.map(company => {
        const choice = button('', () => {
          if (workflow.snapshot.busy || workflow.snapshot.submitted) return;
          chosen = company; search.value = `${company.name} · ${company.ticker}`; results.replaceChildren(); feedback();
          byId('relation-add-company').disabled = false;
        });
        choice.className = 'relation-company-choice'; choice.append(make('strong', '', company.name), make('span', '', company.ticker));
        return choice;
      }));
      feedback(rows.length ? '' : '未找到公司，请输入名称或完整代码。');
    } catch (error) {
      if (token === searchGeneration && workflow.snapshot.open && error.code !== 'ABORTED') feedback(error.message);
    }
  }
  byId('edit-relations').addEventListener('click', () => safeAction(() => workflow.open()));
  byId('relation-editor-add-shortcut').addEventListener('click', () => search.focus());
  byId('relation-editor-cancel').addEventListener('click', () => workflow.close());
  byId('close-relation-editor').addEventListener('click', () => workflow.close());
  byId('relation-editor-save').addEventListener('click', () => { void workflow.save(); });
  byId('relation-editor-reload').addEventListener('click', () => { void workflow.reload(); });
  byId('relation-add-company').addEventListener('click', () => {
    if (!chosen) return;
    try {
      workflow.add(chosen, addType.value, addNote.value);
      chosen = null; search.value = ''; addNote.value = ''; results.replaceChildren(); feedback(); byId('relation-add-company').disabled = true;
    } catch (error) { workflow.setError(error.message); }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); workflow.close(); });
  dialog.addEventListener('close', () => { if (!dialog.open) { cancelSearch(); workflow.close(); } });
  search.addEventListener('compositionstart', () => { composing = true; cancelSearch(); });
  search.addEventListener('compositionend', () => { composing = false; void runSearch(); });
  search.addEventListener('input', event => {
    cancelSearch(); chosen = null; byId('relation-add-company').disabled = true;
    if (event.isComposing || composing) return;
    searchTimer = setTimeout(() => { void runSearch(); }, 250);
  });
  search.addEventListener('keydown', event => { if (event.key === 'Enter' && !composing && !event.isComposing) { event.preventDefault(); void runSearch(); } });
  workflow.sync();
  return workflow;
}
