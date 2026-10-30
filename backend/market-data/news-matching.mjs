/** Match explicit company mentions, rather than treating every six-digit number as a stock code. */
const CODE = /^(\d{6})\.(SH|SZ|BJ)$/;
const PRIORITY = { alias: 1, name: 2, fullname: 3, ticker: 4 };
const unsafeNames = new Set(['股份有限公司', '有限责任公司', '中国公司', '上市公司', '集团公司']);
const searchableText = value => String(value ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|quot|lt|gt);/gi, ' ').toUpperCase();

export function createNewsMatcher(securities = []) {
  const records = new Map(), terms = new Map();
  const add = (term, ticker, type) => {
    term = String(term ?? '').trim().replace(/\s+/g, '');
    if (term.length < 3 || term.length > 150 || unsafeNames.has(term)) return;
    const normalized = term.toUpperCase(), entry = { ticker, term, type };
    if (!terms.has(normalized)) terms.set(normalized, new Map());
    const existing = terms.get(normalized).get(ticker);
    if (!existing || PRIORITY[existing.type] < PRIORITY[type]) terms.get(normalized).set(ticker, entry);
  };
  for (const security of securities) {
    const ticker = String(security?.ticker ?? security?.ts_code ?? '').toUpperCase();
    if (!CODE.test(ticker) || records.has(ticker)) continue;
    records.set(ticker, security);
    add(security.name, ticker, 'name');
    add(security.fullname, ticker, 'fullname');
    const alias = String(security.name ?? '').replace(/\s+/g, '').replace(/^\*?ST/i, '');
    if (alias !== String(security.name ?? '').replace(/\s+/g, '')) add(alias, ticker, 'alias');
    const [, code, exchange] = ticker.match(CODE);
    add(ticker, ticker, 'ticker'); add(`${exchange}${code}`, ticker, 'ticker');
  }
  // Ambiguous aliases are omitted; an original company name or explicit code can still match.
  for (const [term, entries] of terms) if (entries.size > 1) {
    for (const [ticker, entry] of entries) if (entry.type === 'alias') entries.delete(ticker);
    if (!entries.size) terms.delete(term);
  }
  // Aho–Corasick keeps bulk matching linear in article length, rather than scanning 5,000 names per article.
  const trie = [{ next: new Map(), fail: 0, output: [] }];
  for (const [term, entries] of terms) {
    let node = 0;
    for (const character of term) {
      if (!trie[node].next.has(character)) { trie[node].next.set(character, trie.length); trie.push({ next: new Map(), fail: 0, output: [] }); }
      node = trie[node].next.get(character);
    }
    trie[node].output.push({ term, entries: [...entries.values()] });
  }
  const queue = [...trie[0].next.values()];
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    for (const [character, child] of trie[node].next) {
      let fallback = trie[node].fail;
      while (fallback && !trie[fallback].next.has(character)) fallback = trie[fallback].fail;
      trie[child].fail = trie[fallback].next.get(character) ?? 0;
      trie[child].output.push(...trie[trie[child].fail].output); queue.push(child);
    }
  }
  const codeLookup = new Map([...records.keys()].map(ticker => [ticker.slice(0, 6), ticker]));

  return function matchArticle(article) {
    const text = searchableText(`${article.title ?? ''}\n${article.content ?? ''}`), matched = new Map();
    const found = entry => {
      let result = matched.get(entry.ticker);
      if (!result) { result = { ticker: entry.ticker, articleId: article.id, matchType: entry.type, matchedTerms: [] }; matched.set(entry.ticker, result); }
      if (PRIORITY[entry.type] > PRIORITY[result.matchType]) result.matchType = entry.type;
      if (result.matchedTerms.length < 20 && !result.matchedTerms.includes(entry.term)) result.matchedTerms.push(entry.term);
    };
    let node = 0;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      while (node && !trie[node].next.has(character)) node = trie[node].fail;
      node = trie[node].next.get(character) ?? 0;
      for (const output of trie[node].output) {
        const begin = index - output.term.length + 1;
        if (/^[A-Z0-9.]+$/.test(output.term) && (/[A-Z0-9]/.test(text[begin - 1] ?? '') || /[A-Z0-9]/.test(text[index + 1] ?? ''))) continue;
        for (const entry of output.entries) found(entry);
      }
    }
    for (const mention of text.matchAll(/(?:股票|证券)(?:交易)?代码\s*[:：为]?\s*([0-9]{6})(?![0-9])/g)) {
      const ticker = codeLookup.get(mention[1]); if (ticker) found({ ticker, type: 'ticker', term: mention[0] });
    }
    return [...matched.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  };
}
