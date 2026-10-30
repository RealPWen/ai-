import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adaptEvents, assertEventsContext, eventChinaDate } from '../frontend/src/features/events-data.js';
import { eventsCoverageText, eventsHistoryCoverageText, initEvents, renderEvents } from '../frontend/src/views/events-view.js';
import { endpoints } from '../frontend/src/api/endpoints.js';

function response({ items, ...overrides } = {}) {
  return { ticker: '601127.SH', asOf: '2026-10-15', from: '2026-07-15', category: '公司', limit: 20, offset: 0, total: items?.length ?? 1, hasMore: false,
    items: items ?? [{ id: 'news-1', title: '赛力斯发布产品进展', content: '第一段正文\n第二段正文', publishedAt: '2026-10-14T16:30:00Z', sourceName: '公开资讯来源', sourceApi: 'major_news', url: null, category: '公司', relatedCompanies: [{ ticker: '601127.SH', name: '赛力斯', relationType: 'company' }] }],
    meta: { sources: [{ sourceApi: 'major_news', status: 'available', updatedAt: '2026-10-15T03:00:00Z' }, { sourceApi: 'news', status: 'permission_denied' }, { sourceApi: 'anns_d', status: 'permission_denied' }] }, ...overrides };
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.className = ''; this.textContent = ''; this.children = []; this.hidden = false; this.disabled = false; this.open = false; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
    this.classList = { toggle: (name, enabled) => { const classes = new Set(this.className.split(/\s+/).filter(Boolean)); if (enabled) classes.add(name); else classes.delete(name); this.className = [...classes].join(' '); } };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  click() { this.listeners.get('click')?.({ target: this }); }
}
const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
const allText = element => [element.textContent, ...element.children.map(allText)].join(' ');
function fixture(t, callbacks = {}) {
  const ids = ['events-list', 'events-status', 'events-source-status', 'events-result-summary', 'events-load-more', 'events-refresh', 'events-window'];
  const elements = new Map(ids.map(id => [id, new Element()]));
  const filters = ['公司', '同行', '上游', '下游'].map(category => Object.assign(new Element('button'), { dataset: { event: category } }));
  const original = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag), getElementById: id => elements.get(id), querySelectorAll: selector => selector === '[data-event]' ? filters : [] };
  t.after(() => { globalThis.document = original; });
  renderEvents(null, { ticker: '601127.SH', asOf: '2026-10-15' });
  initEvents(callbacks);
  return { filters, byId: id => elements.get(id), rows: () => elements.get('events-list').children };
}

test('切到港股未接入空态会清除A股新闻与分页，不留下旧来源或加载更多', t => {
  const f = fixture(t); renderEvents(response({ hasMore: true, total: 2 }));
  assert.match(allText(f.byId('events-list')), /赛力斯/); assert.equal(f.byId('events-load-more').hidden, false);
  renderEvents(null, { status: 'not_supported', ticker: '00700.HK', asOf: '2026-10-15', append: false });
  assert.match(allText(f.byId('events-list')), /港股新闻事件暂未接入/); assert.doesNotMatch(allText(f.byId('events-list')), /赛力斯/);
  assert.equal(f.byId('events-status').textContent, '暂未接入'); assert.equal(f.byId('events-load-more').hidden, true);
  assert.equal(f.byId('events-source-status').hidden, true); assert.equal(f.byId('events-result-summary').textContent, '');
});

test('资讯端点传递股票、研究日期、分类和分页，适配器校验响应上下文', () => {
  const context = { ticker: '601127.SH', asOf: '2026-10-15', category: '公司', limit: 20, offset: 0 };
  assert.deepEqual(endpoints.events(context), { path: '/api/events', query: context });
  const data = adaptEvents({ data: response({ category: '公司' }) });
  assert.equal(assertEventsContext(data, context), data);
  for (const incorrect of [{ ticker: '600399.SH' }, { asOf: '2026-10-14' }, { category: '同行' }, { offset: 20 }]) assert.throws(() => assertEventsContext(data, { ...context, ...incorrect }), /与当前选择不一致/);
});

test('资讯筛选只显示公司、同行、上下游，其他模块的全部筛选保留', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  assert.deepEqual([...html.matchAll(/data-event="([^"]+)"/g)].map(match => match[1]), ['公司', '同行', '上游', '下游']);
  assert.match(html, /class="selected" data-event="公司" aria-pressed="true"/);
  assert.match(html, /data-relation-filter="all"[^>]*>全部/);
  assert.match(html, /data-company-market="all"[^>]*>全部/);
  const main = await readFile(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(main, /const state = \{[^\n]*category: '公司'/);
});

test('默认选中公司，默认请求与上下文校验一致，显式全部参数仍兼容', t => {
  const filters = [], f = fixture(t, { onFilter: category => filters.push(category) });
  assert.equal(f.filters[0].attributes.get('aria-pressed'), 'true');
  assert.ok(f.filters.slice(1).every(button => button.attributes.get('aria-pressed') === 'false'));
  f.filters[0].click(); assert.deepEqual(filters, []);
  const context = { ticker: '601127.SH', asOf: '2026-10-15' };
  assert.equal(endpoints.events(context).query.category, '公司');
  assert.equal(assertEventsContext(adaptEvents(response()), context).category, '公司');
  assert.equal(endpoints.events({ ...context, category: '全部' }).query.category, '全部');
  assert.equal(assertEventsContext(adaptEvents(response({ category: '全部' })), { ...context, category: '全部' }).category, '全部');
});

test('北京时间过滤日期，拒绝超出研究窗口、含未来资讯、无时区及错误分页', () => {
  assert.equal(eventChinaDate('2026-10-14T16:30:00Z'), '2026-10-15');
  const item = response().items[0];
  for (const publishedAt of ['2026-10-15T16:01:00Z', '2026-07-14T12:00:00+08:00', '2026-10-15T12:00:00']) assert.throws(() => adaptEvents(response({ items: [{ ...item, publishedAt }] })));
  assert.throws(() => adaptEvents(response({ hasMore: true })));
  assert.throws(() => adaptEvents(response({ items: [item, item], total: 2 })));
  assert.throws(() => adaptEvents(response({ category: '同行' })));
});

test('来源权限完整保留，只取得长篇资讯时不冒充已覆盖快讯和公告', () => {
  const data = adaptEvents(response());
  assert.equal(eventsCoverageText(data), '长篇资讯已接入；快讯、公告未开通');
  assert.equal(eventsCoverageText({ meta: { sources: [{ sourceApi: 'major_news', status: 'failed' }] } }), '长篇资讯读取失败');
});

test('资讯按文字安全展示，正文默认折叠，缺链接不捏造原文入口', t => {
  const f = fixture(t), raw = response(); raw.items[0].title = '<img src=x onerror=alert(1)>'; raw.items[0].content = '<script>bad()</script>\n真实正文'; raw.items[0].url = 'javascript:alert(1)';
  renderEvents(adaptEvents(raw));
  const row = f.rows()[0], nodes = descendants(row);
  assert.equal(nodes.find(item => item.tagName === 'DETAILS').open, false);
  assert.ok(nodes.every(item => !['IMG', 'SCRIPT', 'A'].includes(item.tagName)));
  assert.match(allText(row), /<img src=x onerror=alert\(1\)>.*<script>bad\(\)<\/script>\n真实正文/);
  assert.match(allText(row), /2026-10-15 00:30.*公开资讯来源.*公司/);
  assert.equal(f.byId('events-status').textContent, '1 条');
  assert.match(allText(f.byId('events-source-status')), /长篇资讯已接入；快讯、公告未开通/);
  const coverage = f.byId('events-source-status').children[0];
  assert.equal(coverage.tagName, 'DETAILS'); assert.equal(coverage.open, false);
  assert.equal(coverage.children[0].textContent, '来源与覆盖');
  assert.doesNotMatch(allText(coverage.children[0]), /存在缺口/);
  assert.doesNotMatch(allText(coverage.children[0]), /未开通|已接入/);
  assert.equal(f.byId('events-window').textContent, '2026-07-15 — 2026-10-15');
  const linked = response(); linked.items[0].url = 'https://example.org/original'; renderEvents(adaptEvents(linked));
  const link = descendants(f.rows()[0]).find(item => item.tagName === 'A'); assert.equal(link.href, 'https://example.org/original'); assert.equal(link.rel, 'noopener noreferrer');
});

test('仅已接入来源空结果仍披露权限缺口，不声称全市场无新闻', t => {
  const f = fixture(t); renderEvents(adaptEvents(response({ items: [], total: 0 })));
  assert.match(allText(f.byId('events-list')), /已下载的资讯中.*暂无公司匹配资讯/);
  assert.match(allText(f.byId('events-source-status')), /快讯、公告未开通/);
  assert.equal(f.byId('events-load-more').hidden, true);
});

test('完整覆盖只显示说明入口，渠道与文章池说明默认收起', t => {
  const f = fixture(t), raw = response();
  raw.meta.sources = [{ sourceApi: 'major_news', status: 'available' }];
  raw.meta.coverage = historyCoverage({ status: 'complete', complete: true, coveredSeconds: 1000 });
  renderEvents(adaptEvents(raw));
  const details = f.byId('events-source-status').children[0];
  assert.equal(details.open, false);
  assert.equal(allText(details.children[0]).trim(), '来源与覆盖');
  assert.match(allText(details), /已接入来源历史采集完成.*长篇资讯已接入/);
});

test('加载更多保留列表并按页加载，分类、股票或日期变化时清除旧结果', t => {
  const calls = [], f = fixture(t, { onLoadMore: params => calls.push(params), onFilter: category => calls.push(category) });
  const first = adaptEvents(response({ total: 2, limit: 1, hasMore: true })); renderEvents(first);
  assert.equal(f.byId('events-result-summary').textContent, '1 / 2 条');
  f.byId('events-load-more').click(); assert.deepEqual(calls, [{ offset: 1, category: '公司' }]);
  renderEvents(null, { status: 'loading', ticker: first.ticker, asOf: first.asOf, category: '公司', append: true });
  assert.equal(f.rows().length, 1); assert.equal(f.byId('events-load-more').disabled, true);
  const next = response({ total: 2, limit: 1, offset: 1 }); next.items[0].id = 'news-2'; next.items[0].title = '另一条新闻';
  renderEvents(adaptEvents(next), { append: true });
  assert.equal(f.rows().length, 2); assert.equal(f.byId('events-load-more').hidden, true);
  assert.equal(f.byId('events-result-summary').textContent, '');
  f.filters[2].click(); assert.equal(calls.at(-1), '上游');
  renderEvents(null, { status: 'loading', ticker: first.ticker, asOf: first.asOf, category: '上游' });
  assert.doesNotMatch(allText(f.byId('events-list')), /赛力斯发布产品|另一条新闻/);
  renderEvents(first); renderEvents(null, { status: 'loading', ticker: '600399.SH', asOf: '2026-10-14', category: '公司', append: true });
  assert.doesNotMatch(allText(f.byId('events-list')), /赛力斯发布产品/);
});

test('请求失败明确显示失败并清除旧股票结果，加载更多失败则可重试', t => {
  const f = fixture(t), data = adaptEvents(response({ total: 2, limit: 1, hasMore: true })); renderEvents(data);
  renderEvents(null, { status: 'error', ticker: data.ticker, asOf: data.asOf, error: '网络读取失败', append: true });
  assert.match(allText(f.byId('events-list')), /赛力斯发布产品[\s\S]*网络读取失败/);
  assert.equal(f.byId('events-load-more').disabled, false);
  renderEvents(null, { status: 'loading', ticker: data.ticker, asOf: data.asOf, append: true });
  assert.doesNotMatch(allText(f.byId('events-list')), /网络读取失败/);
  assert.match(allText(f.byId('events-list')), /赛力斯发布产品/);
  renderEvents(null, { status: 'error', ticker: '600399.SH', asOf: data.asOf, error: '请求失败' });
  assert.doesNotMatch(allText(f.byId('events-list')), /赛力斯/);
  assert.match(allText(f.byId('events-list')), /请求失败/);
  assert.equal(f.byId('events-refresh').disabled, false);
});

function historyCoverage(overrides = {}) {
  return { requestedFrom: '2026-07-14T16:00:00Z', requestedThrough: '2026-10-15T04:00:00Z', endExclusive: true,
    coveredSeconds: 100, totalSeconds: 1000, complete: false, status: 'partial', coveredFrom: '2026-10-13T16:00:00Z',
    coveredThrough: null, latestCoveredAt: '2026-10-15T04:00:00Z', sourceApis: ['major_news'], ...overrides };
}

test('历史下载未完成仍显示全部已有资讯，覆盖进度独立于渠道授权展示', t => {
  const f = fixture(t), raw = response(); raw.meta.coverage = historyCoverage();
  const data = adaptEvents(raw); renderEvents(data);
  assert.equal(f.rows().length, 1);
  assert.match(allText(f.byId('events-list')), /赛力斯发布产品/);
  assert.match(allText(f.byId('events-source-status')), /历史资讯待补齐 · 已采集 10%；长篇资讯已接入；快讯、公告未开通/);
  assert.doesNotMatch(allText(f.byId('events-source-status')), /连续覆盖|采集完成/);
  assert.equal(f.byId('events-window').textContent, '2026-07-15 — 2026-10-15');
});

test('只用真正连续已完成窗口显示覆盖范围，exclusive末日不多算一天', () => {
  const raw = response(); raw.meta.coverage = historyCoverage({ coveredThrough: '2026-07-24T16:00:00Z' });
  assert.match(eventsHistoryCoverageText(adaptEvents(raw)), /连续覆盖 2026-07-15 — 2026-07-24/);
  raw.meta.coverage = historyCoverage({ status: 'complete', complete: true, coveredSeconds: 1000 });
  assert.equal(eventsHistoryCoverageText(adaptEvents(raw)), '已接入来源历史采集完成');
  raw.meta.coverage = historyCoverage({ status: 'not_synced', coveredSeconds: 0 });
  assert.equal(eventsHistoryCoverageText(adaptEvents(raw)), '历史资讯尚未采集');
  raw.meta.coverage = historyCoverage({ status: 'complete', complete: false });
  assert.throws(() => adaptEvents(raw));
});

test('财联社官网文章正确显示来源，已入库文章不冒充完成三个月采集', t => {
  const f = fixture(t), raw = response();
  raw.items[0].sourceApi = 'cls_web'; raw.items[0].sourceName = 'Tushare';
  raw.meta.sources = [{ sourceApi: 'cls_web', status: 'available', articleCount: 7 }];
  raw.meta.coverage = historyCoverage({ status: 'not_synced', coveredSeconds: 0 });
  const data = adaptEvents(raw); renderEvents(data);
  assert.equal(data.items[0].sourceName, '财联社官网'); assert.equal(data.meta.sources[0].articleCount, 7);
  assert.match(allText(f.rows()[0]), /财联社官网/); assert.doesNotMatch(allText(f.rows()[0]), /Tushare/);
  assert.match(allText(f.byId('events-source-status')), /财联社文章池 7 篇 · 历史覆盖待核验.*财联社官网已接入/);
  assert.doesNotMatch(allText(f.byId('events-source-status')), /历史资讯尚未采集|采集完成/);
  raw.meta.coverage = historyCoverage({ status: 'complete', complete: true, coveredSeconds: 1000 });
  assert.equal(eventsHistoryCoverageText(adaptEvents(raw)), '财联社文章池 7 篇 · 历史覆盖待核验');
  assert.doesNotMatch(eventsHistoryCoverageText(adaptEvents(raw)), /已接入来源历史采集完成/);
});

test('财联社文章池计数优先于Tushare窗口百分比，且不替换当前公司的结果计数', t => {
  const f = fixture(t), raw = response();
  raw.meta.sources.push({ sourceApi: 'cls_web', status: 'available', articleCount: 3819 });
  for (const coverage of [undefined, historyCoverage({ coveredSeconds: 10 }), historyCoverage({ status: 'complete', complete: true, coveredSeconds: 1000 })]) {
    raw.meta.coverage = coverage;
    const data = adaptEvents(raw); renderEvents(data);
    assert.equal(eventsHistoryCoverageText(data), '财联社文章池 3819 篇 · 历史覆盖待核验');
    assert.doesNotMatch(allText(f.byId('events-source-status')), /已采集|采集完成/);
    assert.equal(f.byId('events-result-summary').textContent, '');
  }
  raw.meta.sources.at(-1).articleCount = 0; raw.meta.coverage = historyCoverage({ coveredSeconds: 10 });
  assert.equal(eventsHistoryCoverageText(adaptEvents(raw)), '历史资讯待补齐 · 已采集 1%');
});

test('财联社列表简述标为摘要，正文、无内容和旧版响应保持兼容', t => {
  const f = fixture(t), raw = response();
  raw.items[0].sourceApi = 'cls_web'; raw.items[0].sourceName = '财联社官网';
  raw.items[0].content = '来自公开列表的简述'; raw.items[0].contentKind = 'summary';
  const brief = adaptEvents(raw); renderEvents(brief);
  assert.equal(brief.items[0].contentKind, 'summary');
  assert.equal(descendants(f.rows()[0]).find(node => node.className === 'news-expand').textContent, '摘要');
  assert.equal(descendants(f.rows()[0]).find(node => node.tagName === 'DETAILS').open, false);
  raw.items[0].contentKind = 'fulltext'; renderEvents(adaptEvents(raw));
  assert.equal(descendants(f.rows()[0]).find(node => node.className === 'news-expand').textContent, '正文');
  delete raw.items[0].contentKind; assert.equal(adaptEvents(raw).items[0].contentKind, 'fulltext');
  raw.items[0].content = ''; const empty = adaptEvents(raw); renderEvents(empty);
  assert.equal(empty.items[0].contentKind, 'none'); assert.ok(descendants(f.rows()[0]).every(node => node.tagName !== 'DETAILS'));
  raw.items[0].contentKind = 'summary'; assert.throws(() => adaptEvents(raw));
});
