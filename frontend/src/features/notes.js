export const noteKey = ticker => `company-research-note-v1:${ticker}`;
const legacyKey = 'desay-sv-research-note-v1';

export function initNotes(initialCompany) {
  const note = document.getElementById('research-note');
  const status = document.getElementById('note-status');
  const count = document.getElementById('note-count');
  let company, timer, dirty = false, persistAvailable = true;
  const save = () => {
    clearTimeout(timer); timer = undefined;
    if (!dirty) return true;
    try { localStorage.setItem(noteKey(company.ticker), note.value); dirty = false; persistAvailable = true; status.textContent = '已保存到当前浏览器 · 不会上传'; return true; }
    catch { persistAvailable = false; status.textContent = '无法保存，请导出笔记后保留'; return false; }
  };
  const setCompany = next => {
    if (!save()) { showToast('笔记尚未保存，请先导出后再切换股票'); return false; }
    company = next;
    note.value = '';
    status.textContent = '仅保存在当前浏览器，不会上传';
    try {
      let saved = localStorage.getItem(noteKey(company.ticker));
      if (saved === null && company.ticker === '002920.SZ') saved = localStorage.getItem(legacyKey);
      note.value = saved || ''; persistAvailable = true;
    } catch { persistAvailable = false; status.textContent = '当前浏览器无法保存，请导出笔记'; }
    document.querySelector('label[for="research-note"]').textContent = `${company.name} · 我的观察`;
    count.textContent = `${Array.from(note.value).length} 字`;
    return true;
  };
  setCompany(initialCompany);
  note.addEventListener('input', () => {
    dirty = true;
    count.textContent = `${Array.from(note.value).length} 字`;
    status.textContent = persistAvailable ? '正在保存…' : '当前浏览器无法保存，请导出笔记';
    clearTimeout(timer); timer = setTimeout(save, 350);
  });
  window.addEventListener('pagehide', save);
  document.getElementById('export-note').addEventListener('click', () => {
    if (!note.value.trim()) { showToast('先写一条笔记，再导出'); note.focus(); return; }
    const blob = new Blob([`# ${company.name} · 研究笔记\n\n证券代码：${company.ticker}\n\n${note.value}\n`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `${company.name.replace(/[\\/:*?"<>|]/g, '_')}_${company.ticker}_研究笔记.md`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000); showToast('研究笔记已导出');
  });
  return { setCompany, updateCompany(next) { company = next; document.querySelector('label[for="research-note"]').textContent = `${company.name} · 我的观察`; } };
}
let toastTimer;
export function showToast(text) {
  const box = document.getElementById('toast'); box.textContent = text; box.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('show'), 2600);
}
