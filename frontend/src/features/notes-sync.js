export const noteKey = ticker => `company-research-note-v1:${ticker}`;
export const draftKey = (owner, ticker) => `company-research-note-v2:${encodeURIComponent(owner)}:${ticker}`;
const claimKey = ticker => `company-research-note-migrated-owner-v1:${ticker}`;

/** Independent queues keep late responses and drafts attached to their author and stock. */
export function createNotesSync({ api, storage, onChange = () => {}, delay = 650 }) {
  const entries = new Map();
  let current = null;
  const snapshot = () => current ? { ...current, pending: Boolean(current.pending), loading: Boolean(current.loading) }
    : { owner: '', content: '', dirty: false, phase: 'anonymous' };
  const emit = () => onChange(snapshot());
  function persist(entry) {
    try {
      if (!storage) throw new Error('No storage');
      storage.setItem(draftKey(entry.owner, entry.ticker), JSON.stringify({ content: entry.content, companyName: entry.companyName,
        version: entry.version, dirty: entry.dirty, updatedAt: entry.updatedAt }));
      entry.localOK = true;
    } catch { entry.localOK = false; }
    return entry.localOK;
  }
  function ensure(owner, company) {
    const key = draftKey(owner, company.ticker);
    if (entries.has(key)) return entries.get(key);
    let saved;
    try { saved = JSON.parse(storage?.getItem(key) || 'null'); } catch {}
    const valid = saved && typeof saved.content === 'string' && (saved.version === null || Number.isInteger(saved.version) && saved.version >= 0);
    const entry = { owner, ticker: company.ticker, companyName: company.name || company.ticker, content: valid ? saved.content : '',
      version: valid ? saved.version : null, dirty: valid ? saved.dirty === true : false, updatedAt: valid ? saved.updatedAt : null,
      phase: 'loading', localOK: Boolean(valid), sequence: 0, conflict: false, remote: null };
    entries.set(key, entry);
    return entry;
  }
  async function load(entry) {
    if (entry.loading) return entry.loading;
    if (entry.pending) await entry.pending;
    if (entry.loading) return entry.loading;
    entry.phase = 'loading'; emit();
    entry.loading = (async () => {
      try {
        const remote = await api.get(entry);
        entry.remote = remote;
        if (entry.dirty) {
          if (remote && remote.content === entry.content) {
            entry.dirty = false; entry.version = remote.version; entry.updatedAt = remote.updatedAt; entry.conflict = false;
          } else if ((entry.version ?? 0) !== (remote?.version ?? 0)) {
            entry.conflict = true;
          } else { entry.version = remote?.version ?? 0; entry.conflict = false; }
        } else {
          entry.content = remote?.content ?? ''; entry.version = remote?.version ?? 0;
          entry.updatedAt = remote?.updatedAt ?? null; entry.conflict = false;
        }
        entry.phase = entry.conflict ? 'conflict' : entry.dirty ? 'pending' : 'saved';
        persist(entry);
        return true;
      } catch { entry.phase = 'error'; return false; }
      finally { entry.loading = null; emit(); }
    })();
    return entry.loading;
  }
  async function flush(entry = current) {
    if (!entry) return true;
    clearTimeout(entry.timer);
    if (entry.loading) await entry.loading;
    if (entry.pending) return entry.pending;
    if (!entry.dirty) return true;
    if (entry.conflict || entry.version === null) return false;
    entry.pending = (async () => {
      try {
        while (entry.dirty && !entry.conflict) {
          entry.phase = 'saving'; emit();
          const sequence = entry.sequence;
          const result = await api.save({ owner: entry.owner, ticker: entry.ticker, companyName: entry.companyName,
            content: entry.content, expectedVersion: entry.version });
          entry.version = result.version; entry.updatedAt = result.updatedAt; entry.remote = result;
          if (entry.sequence === sequence) entry.dirty = false;
          persist(entry);
        }
        entry.phase = 'saved'; return true;
      } catch (error) {
        entry.conflict = error?.code === 'NOTE_CONFLICT';
        entry.phase = entry.conflict ? 'conflict' : 'error';
        persist(entry); return false;
      } finally { entry.pending = null; emit(); }
    })();
    return entry.pending;
  }
  function canLeave() {
    if (!current?.dirty) return true;
    const safe = persist(current);
    void flush(current);
    return safe;
  }
  function select(owner, company) {
    if (!canLeave()) return false;
    current = owner ? ensure(owner, company) : null;
    if (current) {
      current.companyName = company.name || current.companyName;
      const entry = current;
      void load(entry).then(ok => ok && flush(entry));
    }
    emit(); return true;
  }
  function edit(content) {
    if (!current || current.loading) return;
    current.content = content; current.sequence += 1; current.dirty = true;
    if (!current.conflict) current.phase = 'pending';
    persist(current); emit();
    clearTimeout(current.timer);
    const entry = current;
    entry.timer = setTimeout(() => void flush(entry), delay);
  }
  async function retry() {
    const entry = current;
    if (entry && await load(entry)) return flush(entry);
    return false;
  }
  async function resolveConflict(useLocal) {
    const entry = current;
    if (!entry?.conflict || !await load(entry)) return false;
    if (!entry.conflict) return flush(entry);
    if (!useLocal) {
      try { storage.setItem(`${draftKey(entry.owner, entry.ticker)}:conflict:${Date.now()}`, entry.content); }
      catch { entry.phase = 'backup-error'; emit(); return false; }
      entry.content = entry.remote?.content ?? ''; entry.dirty = false;
    }
    entry.version = entry.remote?.version ?? 0; entry.updatedAt = entry.remote?.updatedAt ?? null;
    entry.conflict = false; entry.phase = entry.dirty ? 'pending' : 'saved';
    persist(entry); emit();
    return flush(entry);
  }
  async function recoverOwner(owner, companies = []) {
    if (!owner || !storage) return;
    const known = new Map(companies.map(c => [c.ticker, c.name]));
    const candidates = new Set();
    try {
      const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(key => key !== 'desay-sv-research-note-v1');
      if (storage.getItem('desay-sv-research-note-v1') && storage.getItem(noteKey('002920.SZ')) === null) keys.push('desay-sv-research-note-v1');
      for (const key of keys) {
        const ticker = key === 'desay-sv-research-note-v1' ? '002920.SZ' : key?.startsWith('company-research-note-v1:') ? key.slice('company-research-note-v1:'.length) : null;
        if (!ticker || !/^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/.test(ticker)) continue;
        const content = storage.getItem(key), claimed = storage.getItem(claimKey(ticker));
        if (!content?.trim() || claimed && claimed !== owner) continue;
        const target = draftKey(owner, ticker);
        if (!storage.getItem(target)) storage.setItem(target, JSON.stringify({ content, version: 0, dirty: true, companyName: known.get(ticker) || ticker }));
        storage.setItem(claimKey(ticker), owner);
        candidates.add(ticker);
      }
      const prefix = `company-research-note-v2:${encodeURIComponent(owner)}:`;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(prefix) && !key.slice(prefix.length).includes(':')) candidates.add(key.slice(prefix.length));
      }
    } catch { return; }
    for (const ticker of candidates) {
      const entry = ensure(owner, { ticker, name: known.get(ticker) || ticker });
      if (entry.dirty && await load(entry)) await flush(entry);
    }
    emit();
  }
  return { snapshot, select, edit, flush, retry, resolveConflict, recoverOwner, canLeave,
    updateCompany(company) { if (current?.ticker === company.ticker) { current.companyName = company.name; emit(); } },
    flushAll() { return Promise.all([...entries.values()].map(entry => flush(entry))); },
    hasUnsaved() { return [...entries.values()].some(entry => entry.dirty); },
    pendingConflicts() { return [...entries.values()].filter(entry => entry.owner === current?.owner && entry.conflict).map(entry => `${entry.companyName}（${entry.ticker}）`); },
    destroy() { for (const entry of entries.values()) clearTimeout(entry.timer); },
  };
}
