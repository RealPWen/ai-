import { eventChinaDate, eventSourceUrl } from '../features/events-data.js';

const make = (tag, className = '', value = '') => {
  const element = document.createElement(tag); element.className = className; element.textContent = value; return element;
};
const sourceNames = { major_news: '长篇资讯', news: '快讯', anns_d: '公告', cls_web: '财联社官网' };
let current = null, currentItems = [], currentCategory = '公司', busy = false;
const byId = id => document.getElementById(id);

export function eventsCoverageText(data) {
  const sources = data?.meta?.sources || [];
  const parts = [];
  for (const [status, suffix] of [['available', '已接入'], ['permission_denied', '未开通'], ['failed', '读取失败'], ['not_synced', '待同步']]) {
    const names = sources.filter(source => source.status === status).map(source => sourceNames[source.sourceApi] || source.sourceApi);
    if (names.length) parts.push(`${names.join('、')}${suffix}`);
  }
  const history = eventsHistoryCoverageText(data);
  if (history) parts.unshift(history);
  return parts.join('；') || '来源覆盖情况尚未取得';
}

export function eventsHistoryCoverageText(data) {
  const coverage = data?.meta?.coverage;
  const web = data?.meta?.sources?.find(source => source.sourceApi === 'cls_web' && source.articleCount > 0);
  if (web && !web.coverage?.complete) return `财联社文章池 ${web.articleCount} 篇 · 历史覆盖待核验`;
  if (!coverage) return '';
  if (coverage.status === 'complete') return '已接入来源历史采集完成';
  if (coverage.status === 'not_synced' || !coverage.coveredSeconds) return '历史资讯尚未采集';
  const percent = Math.min(99, Math.floor(coverage.coveredSeconds / coverage.totalSeconds * 100));
  // coveredThrough is exclusive and only advances through contiguous completed windows.
  const through = coverage.coveredThrough ? eventChinaDate(new Date(Date.parse(coverage.coveredThrough) - 1000).toISOString()) : '';
  const start = eventChinaDate(coverage.requestedFrom);
  const range = through && start ? ` · 连续覆盖 ${start} — ${through}` : '';
  return `历史资讯待补齐 · 已采集 ${percent < 1 ? '不足 1' : percent}%${range}`;
}

function renderCoverage(data) {
  const container = byId('events-source-status');
  const details = make('details', 'news-coverage-details');
  const summary = make('summary', '', '来源与覆盖');
  details.append(summary, make('p', '', eventsCoverageText(data)));
  container.replaceChildren(details); container.hidden = false;
}

function publishedTime(value) {
  const day = eventChinaDate(value);
  if (!day) return '';
  const date = new Date(Date.parse(value) + 8 * 60 * 60 * 1000);
  return `${day} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

function eventRow(item) {
  const article = make('article', 'news-item'), meta = make('div', 'news-item-meta');
  const time = make('time', '', publishedTime(item.publishedAt)); time.dateTime = item.publishedAt;
  meta.append(time, make('span', 'news-source', item.sourceName), make('span', 'news-category', item.category));
  article.append(meta);
  const content = item.content?.trim(), url = eventSourceUrl(item.url);
  if (content) {
    const details = make('details', 'news-details'), summary = make('summary', 'news-title');
    summary.append(make('span', '', item.title), make('span', 'news-expand', item.contentKind === 'summary' ? '摘要' : '正文'));
    const body = make('div', 'news-body'); body.append(make('p', 'news-content', content));
    if (item.relatedCompanies?.length) body.append(make('p', 'news-related', `涉及：${item.relatedCompanies.map(company => company.name).join('、')}`));
    if (url) body.append(originalLink(url));
    details.append(summary, body); article.append(details);
  } else {
    article.append(make('h3', 'news-title-static', item.title));
    if (url) article.append(originalLink(url));
  }
  return article;
}

function originalLink(url) {
  const link = make('a', 'news-original', '查看原文 ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
}

function updateControls() {
  document.querySelectorAll('[data-event]').forEach(button => {
    const active = button.dataset.event === currentCategory;
    button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
  });
  const more = byId('events-load-more'); more.hidden = !current?.hasMore; more.disabled = busy;
  more.textContent = busy && currentItems.length ? '加载中…' : '加载更多';
  byId('events-refresh').disabled = busy;
}

export function initEvents({ onFilter, onLoadMore, onRefresh } = {}) {
  document.querySelectorAll('[data-event]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.event === currentCategory) return;
    currentCategory = button.dataset.event; onFilter?.(currentCategory);
  }));
  byId('events-load-more').addEventListener('click', () => {
    if (!busy && current?.hasMore) onLoadMore?.({ offset: current.offset + current.items.length, category: currentCategory });
  });
  byId('events-refresh').addEventListener('click', () => { if (!busy) onRefresh?.(); });
  return { render: renderEvents };
}

export function renderEvents(data, { status = 'ready', ticker = data?.ticker || '', asOf = data?.asOf || '', error = '', append = false, category = data?.category || '公司' } = {}) {
  const area = byId('events-list'); if (!area) return;
  currentCategory = category;
  busy = status === 'loading';
  const changed = current && (current.ticker !== ticker || current.asOf !== asOf || current.category !== category);
  if (!append || changed) { current = null; currentItems = []; area.replaceChildren(); }
  const statusElement = byId('events-status'), coverage = byId('events-source-status'), summary = byId('events-result-summary');
  statusElement.textContent = busy ? '读取中' : status === 'error' ? '读取失败' : status === 'not_supported' ? '暂未接入' : '近三个月';
  coverage.hidden = true; coverage.replaceChildren(); summary.textContent = '';
  if (status === 'loading') {
    if (!currentItems.length) area.append(make('p', 'news-empty', '正在读取近三个月资讯…'));
    else { area.replaceChildren(...currentItems.map(eventRow)); renderCoverage(current); }
  } else if (status === 'error') {
    const message = make('p', 'news-error', error || '资讯暂时读取失败，请稍后重试。'); message.setAttribute('role', 'alert');
    area.replaceChildren(...currentItems.map(eventRow), message);
    if (current) renderCoverage(current);
  } else if (data) {
    current = data;
    if (append && !changed) {
      // Deduplicate stable IDs if the cache gains articles between paged requests.
      const ids = new Set(currentItems.map(item => item.id)); currentItems.push(...data.items.filter(item => !ids.has(item.id)));
    } else currentItems = [...data.items];
    area.replaceChildren(...currentItems.map(eventRow));
    area.classList.toggle('has-events', Boolean(currentItems.length));
    if (!currentItems.length) area.append(make('p', 'news-empty', category === '全部' ? '已下载的资讯中，暂未匹配到当前股票。' : `已下载的资讯中，暂无${category}匹配资讯。`));
    renderCoverage(data);
    statusElement.textContent = `${data.total} 条`;
    byId('events-window').textContent = `${data.from} — ${data.asOf}`;
    summary.textContent = data.total > currentItems.length ? `${currentItems.length} / ${data.total} 条` : '';
  } else {
    area.classList.toggle('has-events', false);
    area.append(make('p', 'news-empty', status === 'not_supported' ? '港股新闻事件暂未接入。' : status === 'not_configured' ? '资讯接口尚未连接。' : '资讯尚未同步，请先下载数据。'));
    byId('events-window').textContent = '近三个月';
  }
  if (busy || status === 'error') {
    if (!current) byId('events-window').textContent = asOf ? `截至 ${asOf} · 近三个月` : '近三个月';
  }
  area.setAttribute('aria-busy', String(busy));
  updateControls();
}
