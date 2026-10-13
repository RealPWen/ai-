// Rendering only: no network access, backend paths or financial calculations.
const node = (tag, className = '', text = '') => {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
};
const displayNumber = value => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
export function safeSourceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function sourceLink(label, url) {
  const safe = safeSourceUrl(url);
  if (!safe) return node('span', 'source-unavailable', `${label} · 原文链接未取得`);
  const link = node('a', 'source-inline', `${label} ↗`);
  link.href = safe; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
}

export function renderProfile(profile) {
  if (!profile) return;
  const name = profile.name || profile.ticker || '股票资料';
  const ticker = profile.ticker || '';
  const heading = document.querySelector('.hero-copy h1');
  heading.replaceChildren(document.createTextNode(`${name} `), node('span', '', ticker));
  document.title = `${name} · 公司投研看板`;
  document.getElementById('current-company-name').textContent = name;
  document.getElementById('current-company-ticker').textContent = ticker;
  document.querySelector('.company-avatar').textContent = Array.from(name)[0];
  document.getElementById('breadcrumb-company').textContent = name;
  document.getElementById('footer-company').textContent = `${name} · 公司投研看板`;
  document.querySelector('.hero-description').textContent = profile.description || '公司简介待接入。';
  document.querySelector('.business-tags').replaceChildren(...(profile.businesses?.length ? profile.businesses : ['业务分类待接入']).map(text => node('span', '', text)));
  const link = document.querySelector('.hero-copy .source-inline');
  const url = safeSourceUrl(profile.sourceUrl);
  if (url) { link.href = url; link.hidden = false; } else { link.removeAttribute('href'); link.hidden = true; }
  const source = document.getElementById('profile-source');
  const summary = node('div'); summary.append(node('strong', '', `${name} · 公司资料`), node('p', '', url ? '资料来源见原文链接，研究数据在各模块单独注明。' : '名称与代码为所选标的，业务资料来源尚未取得。'));
  source.replaceChildren(summary, url ? sourceLink('查看原文', url) : node('span', '', '待接入'));
  const announcement = document.querySelector('.event-bottom a');
  announcement.hidden = !/\.(SZ|SH|BJ|HK)$/.test(ticker);
  announcement.href = ticker.endsWith('.HK') ? 'https://www.hkexnews.hk/' : 'https://www.cninfo.com.cn/';
  announcement.textContent = ticker.endsWith('.HK') ? '查看港交所公告 ↗' : '查看巨潮公告 ↗';
}

// Snapshot only data containers, preserving controls and their event listeners.
export function createModuleReset() {
  const selectors = ['.metrics', '.chart-empty', '.chart-footer', '.debate-grid', '#debates .status-pill', '#valuation tbody', '#valuation .status-pill', '.band-grid', '.events-empty', '#events .status-pill'];
  const snapshots = selectors.map(selector => {
    const target = document.querySelector(selector);
    return { target, children: [...target.childNodes].map(child => child.cloneNode(true)), className: target.className };
  });
  return () => {
    document.querySelectorAll('[data-module-status]').forEach(item => item.remove());
    snapshots.forEach(({ target, children, className }) => { target.className = className; target.replaceChildren(...children.map(child => child.cloneNode(true))); });
    document.querySelector('.hero-side > strong').textContent = '框架已就绪';
    document.querySelector('.hero-side > p').textContent = '行情、卖方预测与事件尚未接入。';
  };
}

const moduleTargets = { profile: '#overview', quote: '.metrics', prices: '.price-panel', debates: '#debates', forecasts: '#valuation', bands: '.band-grid', events: '#events' };
export function renderModuleStatus(module, status, message = '') {
  let feedback = document.querySelector(`[data-module-status="${module}"]`);
  if (!feedback) {
    feedback = node('div', 'module-feedback'); feedback.dataset.moduleStatus = module; feedback.setAttribute('role', 'status');
    const target = document.querySelector(moduleTargets[module]);
    if (module === 'prices') target.querySelector('.panel-heading').after(feedback);
    else if (['debates', 'forecasts', 'events'].includes(module)) target.querySelector('.section-heading').after(feedback);
    else target.before(feedback);
  }
  feedback.hidden = status === 'ready' || status === 'not_configured';
  feedback.classList.toggle('error', status === 'error');
  feedback.textContent = status === 'loading' ? '正在获取数据…' : status === 'empty' ? '接口已连接，暂未返回可展示数据。' : status === 'error' ? `获取失败：${message}。当前模块内容未更新。` : '';
}

export function renderQuote(quote) {
  const metrics = document.querySelectorAll('.metrics .metric');
  const values = [quote?.price, quote?.peTtm, quote?.pb];
  values.forEach((value, index) => {
    metrics[index].querySelector('strong').textContent = displayNumber(value);
    const label = quote ? value == null ? '该指标未返回' : `截至 ${quote.asOf || '日期未提供'}` : '接口未返回数据';
    metrics[index].querySelector('p').replaceChildren(node('i'), document.createTextNode(label));
  });
  metrics[0].querySelector('small').textContent = quote?.currency || '币种未提供';
}

function renderLineChart(container, points, label) {
  container.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 640 220'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); svg.classList.add('data-chart');
  const values = points.map(point => point.value);
  const low = Math.min(...values), high = Math.max(...values), spread = high - low || Math.abs(high) * 0.05 || 1;
  const min = low - spread * 0.12, max = high + spread * 0.12;
  const x = index => 50 + index * 570 / Math.max(points.length - 1, 1);
  const y = value => 180 - (value - min) / (max - min) * 155;
  for (let i = 0; i < 4; i++) {
    const value = min + (max - min) * i / 3;
    const line = document.createElementNS(ns, 'line');
    for (const [key, val] of Object.entries({ x1: 50, x2: 620, y1: y(value), y2: y(value), stroke: '#edf1f3' })) line.setAttribute(key, val);
    const text = document.createElementNS(ns, 'text'); text.setAttribute('x', '43'); text.setAttribute('y', String(y(value) + 4)); text.setAttribute('text-anchor', 'end'); text.textContent = value.toFixed(2); svg.append(line, text);
  }
  const path = document.createElementNS(ns, 'polyline'); path.setAttribute('points', points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ')); path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#147d75'); path.setAttribute('stroke-width', '2'); svg.append(path);
  const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('cx', String(x(points.length - 1))); dot.setAttribute('cy', String(y(points.at(-1).value))); dot.setAttribute('r', '3'); dot.setAttribute('fill', '#147d75'); svg.append(dot);
  for (const [date, position, alignment] of [[points[0].date, 50, 'start'], [points.at(-1).date, 620, 'end']]) {
    const text = document.createElementNS(ns, 'text'); text.setAttribute('x', String(position)); text.setAttribute('y', '207'); text.setAttribute('text-anchor', alignment); text.textContent = date; svg.append(text);
  }
  container.append(svg);
}

export function renderPrices(points) {
  const area = document.querySelector('.chart-empty');
  const footer = document.querySelector('.chart-footer span');
  if (!points.length) { area.replaceChildren(node('p', 'empty-message', '接口已连接，当前区间没有行情数据。')); footer.textContent = '数据范围：未取得'; return; }
  renderLineChart(area, points, '股价日线走势');
  footer.textContent = `数据范围：${points[0].date} — ${points.at(-1).date}`;
}

function debateCard(item, index, isQuestion) {
  const card = node('article', 'debate-card');
  const top = node('div', 'card-top'); top.append(node('span', 'number-label', `${String(index + 1).padStart(2, '0')} / ${item.category || '分歧'}`), node('span', 'question-tag', isQuestion ? '研究问题' : '来源观点'));
  card.append(top, node('h3', '', item.title), node('p', '', item.summary || ''));
  const verification = node('div', 'verification'); verification.append(node('span', '', '验证指标'), node('strong', '', item.metrics.join(' · ') || '待补充')); card.append(verification);
  const details = node('details'); const summary = node('summary', '', isQuestion ? '需要补充的证据 ' : '观点与来源 '); summary.append(node('span', '', '＋')); details.append(summary);
  if (isQuestion) details.append(node('p', '', item.evidence));
  else {
    item.perspectives.forEach(perspective => details.append(node('p', '', `${perspective.author || '作者未提供'}${perspective.date ? ` · ${perspective.date}` : ''}：${perspective.text || ''}`)));
    item.sources.forEach(source => {
      const row = node('div', 'view-source'); row.append(sourceLink(source.title || source.author || '来源', source.url));
      row.append(node('small', '', [source.date, source.readingScope, source.qualityLabel].filter(Boolean).join(' · '))); details.append(row);
    });
  }
  card.append(details); return card;
}
export function renderQuestions(questions) { document.querySelector('.debate-grid').replaceChildren(...questions.map((item, index) => debateCard(item, index, true))); }
export function renderDebates(items) {
  const area = document.querySelector('.debate-grid');
  area.replaceChildren(...(items.length ? items.map((item, index) => debateCard(item, index, false)) : [node('p', 'empty-message', '接口未返回明确的市场分歧。')]));
  document.querySelector('#debates .status-pill').textContent = items.length ? '已取得来源观点' : '暂无分歧记录';
}

export function renderForecasts(rows) {
  const body = document.querySelector('#valuation tbody'); body.replaceChildren();
  document.querySelector('#valuation .status-pill').textContent = rows.length ? '已取得卖方预测' : '暂无预测记录';
  if (!rows.length) { const row = node('tr'); const cell = node('td', '', '接口未返回卖方预测数据'); cell.colSpan = 6; row.append(cell); body.append(row); document.querySelector('.metric:last-child strong').textContent = '未返回'; return; }
  rows.forEach(item => {
    const row = node('tr');
    const low = item.low ? `${displayNumber(item.low.value)} / ${item.low.broker || '券商未提供'}` : '—';
    const high = item.high ? `${displayNumber(item.high.value)} / ${item.high.broker || '券商未提供'}` : '—';
    [item.fiscalYear, low, displayNumber(item.consensus?.value), high, item.sampleSize ?? '未提供', [item.source, item.asOf, item.currency, item.basis].filter(Boolean).join(' · ') || '未提供'].forEach(value => row.append(node('td', '', String(value)))); body.append(row);
  });
  document.querySelector('.metric:last-child strong').textContent = '已取得';
  document.querySelector('.metric:last-child p').textContent = '各财年样本数见下表';
}

export function renderBands(bands) {
  document.querySelectorAll('.band-panel').forEach((panel, index) => {
    const group = bands?.[index === 0 ? 'peTtm' : 'pb'];
    const area = panel.querySelector('.band-empty');
    if (!group?.points.length) { area.replaceChildren(node('p', '', '接口未返回该估值序列。')); return; }
    renderLineChart(area, group.points, index === 0 ? '历史 PE-TTM' : '历史 PB');
    panel.querySelector('.plain-badge').textContent = group.asOf || '日期未提供';
  });
}

export function renderEvents(items, category) {
  const area = document.querySelector('.events-empty'); area.replaceChildren();
  if (!items.length) {
    const content = node('div'); content.append(node('h3', '', category === '全部' ? '暂无事件记录' : `暂无${category}事件记录`), node('p', '', '接口已返回空列表，不代表其他来源也没有相关事件。')); area.append(content);
  } else items.forEach(item => {
    const card = node('article', 'event-card'); card.append(node('small', '', `${item.publishedAt} · ${item.category || '分类未提供'}`));
    card.append(sourceLink(item.title, item.sourceUrl), node('p', '', item.summary || ''));
    if (item.impact) card.append(node('p', 'event-impact', `影响分析：${item.impact}`));
    if (item.verification) card.append(node('p', '', `后续验证：${item.verification}`));
    card.append(node('small', '', [item.source, item.readingScope].filter(Boolean).join(' · '))); area.append(card);
  });
  area.classList.toggle('has-events', Boolean(items.length));
  document.querySelector('#events .status-pill').textContent = items.length ? '已取得事件' : '暂无事件记录';
}
