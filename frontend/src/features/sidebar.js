export const SIDEBAR_STORAGE_KEY = 'company-research.sidebar-open.v1';

function localStore() {
  try { return window.localStorage; } catch { return null; }
}
function viewportQuery() {
  try { return window.matchMedia('(max-width: 1099px)'); } catch { return null; }
}

export function initSidebar({ root = document, storage = localStore(), media = viewportQuery(), defaultOpen = true } = {}) {
  const workspace = root.querySelector('.workspace');
  const sidebar = root.getElementById('watchlist-sidebar');
  const toggle = root.getElementById('watchlist-toggle');
  const collapse = root.getElementById('watchlist-collapse');
  const backdrop = root.getElementById('watchlist-backdrop');
  const main = root.querySelector('main.wrap');
  if (!workspace || !sidebar || !toggle || !collapse) return null;
  let desktopOpen = defaultOpen, drawerOpen = false;
  try {
    const saved = storage?.getItem(SIDEBAR_STORAGE_KEY);
    if (saved === 'open' || saved === 'closed') desktopOpen = saved === 'open';
  } catch { /* Preferences must not block research. */ }
  const narrow = () => Boolean(media?.matches);
  const isOpen = () => narrow() ? drawerOpen : desktopOpen;

  function render() {
    const open = isOpen(), modal = narrow() && open;
    sidebar.hidden = !open;
    workspace.classList.toggle('is-sidebar-collapsed', !open || narrow());
    root.body?.classList.toggle('watchlist-drawer-open', modal);
    if (main) main.inert = modal;
    if (backdrop) backdrop.hidden = !modal;
    if (modal) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); }
    else { sidebar.removeAttribute?.('role'); sidebar.removeAttribute?.('aria-modal'); }
    for (const button of [toggle, collapse]) {
      button.setAttribute('aria-controls', sidebar.id);
      button.setAttribute('aria-expanded', String(open));
    }
    toggle.textContent = narrow() ? '自选股票' : open ? '收起自选' : '展开自选';
    collapse.textContent = narrow() ? '关闭' : '收起';
  }
  function change(next) {
    if (!next) toggle.focus({ preventScroll: true });
    if (narrow()) drawerOpen = next;
    else {
      desktopOpen = next;
      try { storage?.setItem(SIDEBAR_STORAGE_KEY, next ? 'open' : 'closed'); } catch { /* Keep the in-memory choice. */ }
    }
    render();
    if (next) collapse.focus();
  }
  const onToggle = () => change(!isOpen());
  const onClose = () => change(false);
  const onResize = () => {
    const hadFocus = sidebar.contains?.(root.activeElement);
    drawerOpen = false;
    render();
    if (hadFocus && !isOpen()) toggle.focus({ preventScroll: true });
  };
  const onKey = event => {
    if (!narrow() || !isOpen()) return;
    // A native dialog (including the / search shortcut) owns keyboard focus.
    if (root.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); change(false); }
    if (event.key !== 'Tab') return;
    const focusable = [...sidebar.querySelectorAll('button:not([disabled]), input, select, summary, a[href], [tabindex="0"]')]
      .filter(element => element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (!first) return;
    if (event.shiftKey && (root.activeElement === first || !sidebar.contains(root.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (root.activeElement === last || !sidebar.contains(root.activeElement))) { event.preventDefault(); first.focus(); }
  };
  toggle.addEventListener('click', onToggle);
  collapse.addEventListener('click', onClose);
  backdrop?.addEventListener('click', onClose);
  root.addEventListener?.('keydown', onKey);
  media?.addEventListener?.('change', onResize);
  render();
  return {
    get open() { return isOpen(); },
    closeDrawer() { if (narrow() && drawerOpen) change(false); },
    destroy() {
      toggle.removeEventListener('click', onToggle);
      collapse.removeEventListener('click', onClose);
      backdrop?.removeEventListener('click', onClose);
      root.removeEventListener?.('keydown', onKey);
      media?.removeEventListener?.('change', onResize);
      root.body?.classList.toggle('watchlist-drawer-open', false);
      if (main) main.inert = false;
    },
  };
}
