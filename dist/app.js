(() => {
  'use strict';
  const dialog = document.getElementById('source-dialog');
  document.getElementById('sources-button').addEventListener('click', () => dialog.showModal());
  document.getElementById('close-sources').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-period]').forEach(item => { const active = item === button; item.classList.toggle('selected', active); item.setAttribute('aria-pressed', String(active)); });
    document.getElementById('price-caption').textContent = `接入最近 ${button.dataset.period}日线后，显示价格走势。`;
  }));
  document.querySelectorAll('[data-event]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-event]').forEach(item => { const active = item === button; item.classList.toggle('selected', active); item.setAttribute('aria-pressed', String(active)); });
    const group = button.dataset.event;
    document.getElementById('event-title').textContent = group === '全部' ? '等待第一条事件' : `等待${group}事件`;
    document.getElementById('event-caption').textContent = group === '全部' ? '尚未获取新闻或公告。接入后按发布时间、影响路径和来源展示。' : `尚未获取${group}相关资料，当前不能判断是否有新增事件。`;
  }));
  const note = document.getElementById('research-note');
  const status = document.getElementById('note-status');
  const count = document.getElementById('note-count');
  const key = 'desay-sv-research-note-v1';
  let persistAvailable = true;
  try { note.value = localStorage.getItem(key) || ''; } catch { persistAvailable = false; status.textContent = '当前浏览器无法保存，请导出笔记'; }
  count.textContent = `${Array.from(note.value).length} 字`;
  let saveTimer;
  function saveNote() {
    try { localStorage.setItem(key, note.value); persistAvailable = true; status.textContent = '已保存到当前浏览器 · 不会上传'; } catch { persistAvailable = false; status.textContent = '无法保存，请导出笔记后保留'; }
  }
  note.addEventListener('input', () => {
    count.textContent = `${Array.from(note.value).length} 字`;
    status.textContent = persistAvailable ? '正在保存…' : '当前浏览器无法保存，请导出笔记';
    clearTimeout(saveTimer); saveTimer = setTimeout(saveNote, 350);
  });
  window.addEventListener('pagehide', () => { if (saveTimer) saveNote(); });
  let toastTimer;
  function toast(text) {
    const box = document.getElementById('toast'); box.textContent = text; box.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('show'), 2600);
  }
  document.getElementById('export-note').addEventListener('click', () => {
    if (!note.value.trim()) { toast('先写一条笔记，再导出'); note.focus(); return; }
    const blob = new Blob([`# 德赛西威 · 研究笔记\n\n证券代码：002920.SZ\n\n${note.value}\n`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = '德赛西威_研究笔记.md'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); toast('研究笔记已导出');
  });
  const links = Array.from(document.querySelectorAll('.nav-link'));
  links.forEach(link => link.addEventListener('click', () => links.forEach(item => item.classList.toggle('active', item === link))));
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) links.forEach(link => link.classList.toggle('active', link.hash === `#${visible.target.id}`));
    }, { rootMargin: '-100px 0px -45% 0px', threshold: [0, 0.1, 0.4] });
    links.forEach(link => { const section = document.querySelector(link.hash); if (section) observer.observe(section); });
  }
})();
