/** Presentation controls only: no fetching, storage writes or research generation. */
export function initTableColumns({ root = document } = {}) {
  const button = root.getElementById('relations-columns-toggle');
  const section = root.getElementById('relations');
  if (!button || !section) return null;
  let expanded = false;
  function render() {
    section.classList.toggle('show-all-metrics', expanded);
    button.setAttribute('aria-pressed', String(expanded));
    button.textContent = expanded ? '精简指标' : '全部指标';
  }
  const onClick = () => { expanded = !expanded; render(); };
  button.addEventListener('click', onClick); render();
  return { destroy() { button.removeEventListener('click', onClick); } };
}

export function initPageNavigation() {
  const links = [...document.querySelectorAll('.nav-link')];
  const sections = links.map(link => document.querySelector(link.hash));
  let scheduled = false;
  function update() {
    scheduled = false;
    const toolbar = document.querySelector('.company-toolbar');
    const threshold = (toolbar?.getBoundingClientRect().bottom || 96) + 24;
    let current = 0;
    sections.forEach((section, index) => { if (section?.getBoundingClientRect().top <= threshold) current = index; });
    links.forEach((link, index) => {
      link.classList.toggle('active', index === current);
      if (index === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(update); } }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('hashchange', schedule);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  sections.forEach(section => { if (section) observer?.observe(section); });
  document.addEventListener('click', event => {
    document.querySelectorAll('.action-menu[open]').forEach(menu => {
      if (!menu.contains(event.target) || event.target.closest('button')) menu.open = false;
    });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.action-menu[open]').forEach(menu => { menu.open = false; menu.querySelector('summary').focus(); });
  });
  update();
}
