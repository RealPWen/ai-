import { apiClient } from '../api/client.js';
import { companyOptions } from '../data/companies.js';
import { createNotesSync } from './notes-sync.js';
export { noteKey } from './notes-sync.js';

export function initNotes(initialCompany) {
  const note = document.getElementById('research-note');
  const status = document.getElementById('note-status');
  const count = document.getElementById('note-count');
  const retry = document.getElementById('note-retry');
  const conflict = document.getElementById('note-conflict');
  const migrations = document.getElementById('note-migrations');
  let company = initialCompany, owner = '', storage;
  try { storage = window.localStorage; } catch {}
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '';
  function render(state) {
    if (note.value !== state.content) note.value = state.content;
    note.disabled = !state.owner || state.loading || state.phase === 'loading';
    note.placeholder = state.owner ? '记录观点、待验证事项或原文链接…' : '先在自选栏输入姓名，再记录研究笔记';
    document.querySelector('label[for="research-note"]').textContent = `${company.name} · ${owner ? `作者：${owner}` : '尚未选择作者'}`;
    count.textContent = `${Array.from(state.content).length} 字`;
    const local = state.localOK ? '本地草稿已保留' : '本地备份不可用，请及时导出';
    const texts = { anonymous: '请先在自选栏选择姓名', loading: '正在读取数据库…', pending: `待保存 · ${local}`, saving: '正在保存到数据库…',
      saved: state.updatedAt ? `已保存到数据库 · ${time(state.updatedAt)}` : '输入后自动保存到数据库',
      error: `数据库连接失败 · ${local}`, conflict: `其他页面或旧笔记存在不同内容 · ${local}`, 'backup-error': '无法备份草稿，请先导出再选择数据库版本' };
    status.textContent = texts[state.phase] || '';
    retry.hidden = state.phase !== 'error';
    conflict.hidden = !state.conflict;
    const pending = sync.pendingConflicts();
    migrations.hidden = !pending.length;
    migrations.textContent = pending.length ? `以下笔记有不同版本，原文已保留，请切换公司后核对：${pending.join('、')}` : '';
  }
  const sync = createNotesSync({ storage, onChange: render, api: {
    get: async ({ owner, ticker }) => (await apiClient.get('/api/notes', { query: { owner, ticker } })).data,
    save: async body => (await apiClient.post('/api/notes', { body })).data,
  } });
  note.addEventListener('input', () => sync.edit(note.value));
  retry.addEventListener('click', () => void sync.retry());
  document.getElementById('note-use-local').addEventListener('click', () => void sync.resolveConflict(true));
  document.getElementById('note-use-database').addEventListener('click', () => void sync.resolveConflict(false));
  window.addEventListener('online', () => void sync.retry());
  window.addEventListener('pagehide', () => void sync.flushAll());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void sync.flushAll(); });
  window.addEventListener('beforeunload', event => { if (sync.hasUnsaved()) { event.preventDefault(); event.returnValue = ''; } });
  document.getElementById('export-note').addEventListener('click', () => {
    if (!note.value.trim()) { showToast('先写一条笔记，再导出'); note.focus(); return; }
    const saved = sync.snapshot();
    const blob = new Blob([`# ${company.name} · 研究笔记\n\n作者：${owner || '未选择'}\n\n证券代码：${company.ticker}\n\n最后保存：${time(saved.updatedAt) || '尚未保存到数据库'}\n\n${note.value}\n`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `${company.name.replace(/[\\/:*?"<>|]/g, '_')}_${company.ticker}_研究笔记.md`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000); showToast('研究笔记已导出');
  });
  render(sync.snapshot());
  return {
    setCompany(next) { if (!sync.select(owner, next)) { showToast('笔记尚未保存，请先导出后再切换'); return false; } company = next; render(sync.snapshot()); return true; },
    updateCompany(next) { company = next; sync.updateCompany(next); },
    async setOwner(next) {
      if (!sync.canLeave()) { showToast('笔记尚未保存，请先导出后再切换姓名'); return false; }
      await sync.recoverOwner(next, [...companyOptions, company]);
      if (!sync.select(next, company)) return false;
      owner = next; render(sync.snapshot()); return true;
    },
  };
}
let toastTimer;
export function showToast(text) {
  const box = document.getElementById('toast'); box.textContent = text; box.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('show'), 2600);
}
