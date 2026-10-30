import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adapters, assertForecastsContext } from '../frontend/src/services/adapters.js';
import { endpoints } from '../frontend/src/api/endpoints.js';
import { createResearchService } from '../frontend/src/services/research-service.js';
import { createCompanySession } from '../frontend/src/features/company-session.js';
import { renderForecasts } from '../frontend/src/views/research-view.js';
import { createForecastReadService } from '../backend/market-data/forecast-read-service.mjs';

const example = () => ({
  ticker: '002920.SZ', asOf: '2026-10-14', windowStart: '2026-07-17', windowDays: 90,
  source: 'Tushare report_rc', unit: '元/股', currency: null, basis: '接口未提供基本/稀释及调整口径，待原文核验',
  meta: { availableFrom: '2025-10-14', databaseThrough: '2026-10-13', fetchedAt: '2026-10-14T05:00:00Z', rawRowCount: 9, reportCount: 3, brokerCount: 2, excludedCount: 1, pointInTimeNote: '按研报日期筛选，不保证数据库记录的历史版本。' },
  rows: ['2026E', '2027E'].map((fiscalYear, index) => ({
    fiscalYear, period: `${2026 + index}Q4`, sampleSize: 2,
    low: { value: 0, broker: '券商甲', brokers: ['券商甲'] }, high: { value: 4, broker: '券商乙', brokers: ['券商乙'] }, consensus: { value: 2, method: 'mean' }, median: 2,
    source: 'Tushare report_rc', asOf: '2026-10-12', unit: '元/股', currency: null, basis: '待核验',
    samples: [
      { id: `a-${index}`, broker: '券商甲', author: '分析师甲', reportDate: '2026-10-10', title: '盈利预测甲', eps: 0, pe: null, netProfit: null, rating: '增持', period: `${2026 + index}Q4`, sourceUrl: null },
      { id: `b-${index}`, broker: '券商乙', author: '分析师乙', reportDate: '2026-10-12', title: '盈利预测乙', eps: 4, pe: 20, netProfit: 30, rating: '买入', period: `${2026 + index}Q4`, sourceUrl: null },
    ],
  })),
});

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this._text = ''; this.attributes = new Map(); this.className = ''; this.open = false; this.listeners = new Map(); }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  get childNodes() { return this.children; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = [...children]; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  querySelector(selector) { return descendants(this).slice(1).find(item => item.tagName === selector.toUpperCase()) || null; }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
const make = (tag, text = '') => { const result = new Element(tag); result.textContent = text; return result; };
function fixture(t) {
  const body = make('tbody'), pill = make('span'), summary = make('p'), details = make('div'), metric = make('article'), note = make('div'), source = make('div'), sourceHeading = make('th'), introduction = make('p'); metric.append(make('strong'), make('p'));
  const selectors = new Map([['#valuation tbody', body], ['#valuation .status-pill', pill], ['.forecast-metric', metric], ['#valuation .table-note', note], ['#valuation .forecast-summary-table th:last-child', sourceHeading], ['#valuation .section-heading p', introduction]]);
  const ids = new Map([['forecast-summary', summary], ['forecast-sample-details', details], ['forecast-source', source]]);
  const original = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag), querySelector: selector => selectors.get(selector) || null, getElementById: id => ids.get(id) || null };
  t.after(() => { globalThis.document = original; });
  const inlineDetails = new Element('div');
  Object.defineProperty(inlineDetails, 'children', { get: () => body.children.filter(item => item.className === 'forecast-inline-details') });
  return { body, pill, summary, details: inlineDetails, metric, note, source, sourceHeading, introduction };
}

test('EPS 适配保留研究截止、库内覆盖、空币种与逐券商原始出处，不把对象降为数组', () => {
  const source = example(), result = adapters.forecasts({ data: source });
  assert.equal(Array.isArray(result), false); assert.equal(result.ticker, source.ticker); assert.equal(result.asOf, '2026-10-14');
  assert.equal(result.windowStart, '2026-07-17'); assert.equal(result.currency, null); assert.equal(result.meta.databaseThrough, '2026-10-13');
  assert.equal(result.rows[0].samples[0].eps, 0); assert.equal(result.rows[0].samples[1].reportDate, '2026-10-12');
  assert.equal(result.rows[0].samples[0].sourceUrl, null); assert.equal(result.rows[0].consensus.method, 'mean');
  assert.notEqual(result, source); assert.notEqual(result.rows[0], source.rows[0]); assert.notEqual(result.rows[0].samples[0], source.rows[0].samples[0]);
  source.rows[0].samples[0].eps = '3.1'; assert.throws(() => adapters.forecasts(source), /应为数字/);
  const invalid = example(); invalid.meta.brokerCount = -1; assert.throws(() => adapters.forecasts(invalid), /无效/);
});

test('卖方预测仅 GET 当前代码和截止日，空 rows 保留覆盖元数据并给出 empty', async () => {
  const calls = [];
  const service = createResearchService({ config: { enabled: true }, routes: endpoints, mappers: adapters, client: { get: async (path, options) => { calls.push({ path, ...options }); return { data: { ...example(), asOf: options.query.asOf, rows: [] } }; } } });
  const result = await service.load('forecasts', { ticker: '600519.SH', asOf: '2026-09-30' });
  assert.equal(result.status, 'empty'); assert.equal(result.data.meta.databaseThrough, '2026-10-13');
  assert.deepEqual(calls[0].query, { ticker: '600519.SH', asOf: '2026-09-30' }); assert.equal(calls[0].path, '/api/forecasts');
  await service.load('forecasts', { ticker: '600519.SH', asOf: '2026-10-14' }); assert.equal(calls[1].query.asOf, '2026-10-14');
});

const hongKongExample = () => {
  const data = example();
  Object.assign(data, { ticker: '00700.HK', market: 'HK', source: '经济通 ETNet', unit: '按各预测行标注', currency: null, basis: '按币种及 EPS 口径分别统计', sourceUrl: 'https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php?code=700' });
  Object.assign(data.meta, { dateMeaning: 'broker_update_date', snapshotDate: '2026-10-14', availableFrom: '2026-10-14', pointInTimeNote: '仅使用研究截止日当日或之前已采集的快照；券商更新日期不等于历史快照日。' });
  data.rows.forEach((row, index) => {
    Object.assign(row, { fiscalYear: '2026E', fiscalPeriod: index ? '2026-12' : '2026-06', source: data.source, unit: '元/股', currency: index ? 'HKD' : 'CNY', basis: index ? '摊薄 EPS' : '基本 EPS' });
    row.samples.forEach(sample => Object.assign(sample, { author: null, title: null, source: data.source, sourceUrl: data.sourceUrl, currency: row.currency, unit: row.unit, basis: row.basis }));
  });
  return data;
};

test('港股按原代码只读预测API，保留财年月份与币种口径分组，网络失败不伪装空样本', async () => {
  const calls = [], payload = hongKongExample();
  const service = createResearchService({ config: { enabled: true }, routes: endpoints, mappers: adapters, client: { get: async (path, options) => { calls.push({ path, ...options }); return { data: payload }; } } });
  const result = await service.load('forecasts', { ticker: '00700.HK', asOf: '2026-10-14' });
  assert.equal(result.status, 'ready'); assert.deepEqual(calls[0].query, { ticker: '00700.HK', asOf: '2026-10-14' });
  assert.equal(result.data.market, 'HK'); assert.equal(result.data.rows.length, 2); assert.equal(result.data.meta.snapshotDate, '2026-10-14');
  assert.deepEqual(result.data.rows.map(row => [row.fiscalYear, row.fiscalPeriod, row.currency, row.basis]), [['2026E', '2026-06', 'CNY', '基本 EPS'], ['2026E', '2026-12', 'HKD', '摊薄 EPS']]);
  assert.equal(result.data.rows[0].samples[0].sourceUrl, payload.sourceUrl);
  assert.equal(assertForecastsContext(result.data, calls[0].query), result.data);
  const failed = createResearchService({ config: { enabled: true }, routes: endpoints, mappers: adapters, client: { get: async () => { throw new Error('数据库不可用'); } } });
  await assert.rejects(failed.load('forecasts', calls[0].query), /数据库不可用/);
  for (const mutate of [data => { data.market = 'A'; }, data => { data.ticker = '700.HK'; }, data => { data.rows[0].currency = 1; }, data => { data.rows[0].fiscalPeriod = '2026-13'; }]) {
    const invalid = hongKongExample(); mutate(invalid); assert.throws(() => adapters.forecasts(invalid));
  }
});

test('全市场港股EPS尚未采集会清除旧券商预测，不冒充已查询无覆盖或失败', t => {
  const { body, pill, summary, details, metric, note, source } = fixture(t);
  renderForecasts(hongKongExample()); assert.ok(details.childNodes.length > 0);
  const payload = hongKongExample(); payload.ticker = '00001.HK'; payload.source = null; payload.rows = [];
  payload.meta = { ...payload.meta, status: 'not_downloaded', coverageScope: 'stock', eligibleUniverse: 'hk_listed_universe', snapshotDate: null, brokerCount: 0 };
  const adapted = adapters.forecasts(payload); assert.equal(adapted.meta.status, 'not_downloaded');
  renderForecasts(adapted, { status: 'empty' });
  assert.match(body.textContent, /尚无已采集的预测快照/);
  assert.equal(pill.textContent, '尚未采集'); assert.equal(metric.querySelector('strong').textContent, '—');
  assert.match(metric.querySelector('p').textContent, /尚未采集/); assert.match(source.textContent, /尚未采集/);
  assert.equal(details.childNodes.length, 0);
  assert.doesNotMatch(body.textContent + metric.textContent + source.textContent + summary.textContent, /28 只|价值投资池|0 家|经济通|Tushare|采集失败|无有效样本|已查询/);
});

test('全市场港股已查询无覆盖、正在采集、采集失败各自明确显示，不再出现原28限制', t => {
  const { body, pill, metric, details, source } = fixture(t);
  const payload = hongKongExample(); payload.ticker = '00002.HK'; payload.rows = []; payload.source = null;
  for (const [status, snapshotDate, text, metricValue] of [
    ['no_coverage', '2026-10-14', '已查询', '0 家'], ['collecting', null, '正在采集', '—'], ['collection_failed', null, '采集失败', '—'],
  ]) {
    payload.meta = { ...payload.meta, status, snapshotDate, updateStatus: status === 'collection_failed' ? 'failed' : status === 'collecting' ? 'running' : 'succeeded' };
    renderForecasts(adapters.forecasts(payload), { status: 'empty' });
    assert.ok(body.textContent.includes(text)); assert.equal(metric.querySelector('strong').textContent, metricValue);
    assert.equal(details.childNodes.length, 0); assert.doesNotMatch(body.textContent + source.textContent, /28 只|价值投资池/);
    if (status === 'no_coverage') { assert.match(body.textContent, /暂无公开卖方 EPS 预测覆盖/); assert.equal(pill.textContent, '已查询 · 暂无覆盖'); }
    if (status === 'collecting') assert.equal(pill.textContent, '采集中');
    if (status === 'collection_failed') { assert.equal(pill.textContent, '采集失败'); assert.doesNotMatch(source.textContent, /暂无公开样本|暂无覆盖/); }
  }
});

test('港股券商快照显示真实更新日期、采集日、来源和独立币种，不写成历史研报', t => {
  const { body, summary, details, note, source, sourceHeading, introduction } = fixture(t);
  renderForecasts(adapters.forecasts(hongKongExample()));
  assert.equal(body.children.length, 4); assert.match(body.textContent, /财年截至 2026-06 · 元\/股 · CNY · 基本 EPS/); assert.match(body.textContent, /财年截至 2026-12 · 元\/股 · HKD · 摊薄 EPS/);
  assert.match(body.textContent, /2026-10-12/); assert.doesNotMatch(body.textContent, /最新研报/);
  assert.match(summary.textContent, /快照采集日 2026-10-14/); assert.doesNotMatch(summary.textContent, /券商更新窗口|历史快照日/); assert.match(note.textContent, /券商更新窗口/); assert.match(note.textContent, /历史快照日/);
  assert.equal(sourceHeading.textContent, '来源及券商更新日'); assert.equal(introduction.textContent, '');
  assert.match(details.textContent, /券商更新日/); assert.match(details.textContent, /查看券商预测/); assert.doesNotMatch(details.textContent, /分析师未提供|标题未提供|研报日期/);
  assert.match(source.textContent, /经济通 ETNet/); assert.match(source.textContent, /公开券商预测快照/);
  assert.doesNotMatch(body.textContent + summary.textContent + details.textContent + note.textContent + source.textContent, /Tushare/);
  const links = descendants(details).filter(item => item.tagName === 'A'); assert.equal(links.length, 4); assert.ok(links.every(link => link.href === hongKongExample().sourceUrl));
});

test('数据库年度EPS经真实read汇总与HTTP JSON适配可展示YYYY财政期，不猜年结月且保留A股Q4契约', async t => {
  const { body, details } = fixture(t);
  const raw = { forecast_id: 'hk-year-only', org_name: '券商甲', report_date: '2026-10-12', report_title: null, author_name: null,
    fiscal_year: 2026, fiscal_period: '2026', eps: '2.15', currency: 'CNY', eps_basis: null, np: null, pe: null, rating: null,
    source: 'etnet', source_api: 'etnet_hk_profit_forecast', source_url: 'https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php?code=700',
    snapshot_date: '2026-10-14', available_from: '2026-10-14', database_through: '2026-10-12', fetched_at_max: '2026-10-14T01:00:00.000Z' };
  const backend = createForecastReadService({ now: () => new Date('2026-10-14T01:00:00Z'), pool: { query: async (sql, values) => ({ rows: sql.startsWith('SELECT ts_code, name FROM market_data.hk_listed_universe') ? [{ ts_code: values[0], name: '腾讯控股' }] : values[0] === '00700.HK' ? [raw, { ...raw, forecast_id: 'hk-explicit-june', fiscal_period: '2026-06', eps: '3.15' }] : [{ ...raw, forecast_id: 'a-q4', quarter: '2026Q4', source: 'tushare', source_api: 'report_rc' }] }) } });
  const params = { ticker: '00700.HK', asOf: '2026-10-14' };
  const response = JSON.parse(JSON.stringify({ data: await backend.get(params) }));
  const adapted = adapters.forecasts(response); assertForecastsContext(adapted, params);
  assert.deepEqual(adapted.rows.map(row => row.fiscalPeriod), ['2026', '2026-06']);
  assert.equal(adapted.rows[0].period, '2026'); assert.equal(adapted.rows[0].samples[0].period, '2026');
  assert.equal(adapted.rows[0].consensus.value, 2.15);
  renderForecasts(adapted); assert.match(body.textContent, /2026E.*财年结束月未提供/); assert.match(body.textContent, /财年截至 2026-06/);
  assert.match(body.textContent, /财年结束月未提供/); assert.doesNotMatch(body.textContent + details.textContent, /2026-12|读取失败/);
  const aParams = { ticker: '002920.SZ', asOf: '2026-10-14' };
  const aShare = adapters.forecasts(JSON.parse(JSON.stringify({ data: await backend.get(aParams) }))); assertForecastsContext(aShare, aParams);
  assert.equal(aShare.rows[0].period, '2026Q4'); assert.equal(aShare.rows[0].samples[0].period, '2026Q4'); assert.equal(aShare.rows[0].fiscalPeriod, undefined);
});

test('预测不接受错误标的、截止日、未来快照及窗口外券商日期', () => {
  const params = { ticker: '00700.HK', asOf: '2026-10-14' };
  for (const mutate of [data => { data.ticker = '002920.SZ'; }, data => { data.asOf = '2026-10-13'; }, data => { data.meta.snapshotDate = '2026-10-15'; }, data => { data.rows[0].asOf = '2026-10-15'; }, data => { data.rows[0].samples[0].reportDate = '2026-10-15'; }, data => { data.rows[0].samples[0].reportDate = '2026-01-01'; }]) {
    const data = hongKongExample(); mutate(data); assert.throws(() => assertForecastsContext(data, params));
  }
});

test('未提供的港股币种不猜测为港元，陈旧快照提示与空结果/读取失败分开', t => {
  const { body, summary, details, metric, source } = fixture(t), payload = hongKongExample();
  payload.rows = [payload.rows[0]]; payload.rows[0].currency = null; payload.rows[0].samples.forEach(sample => { sample.currency = null; }); payload.meta.stale = true;
  renderForecasts(adapters.forecasts(payload));
  assert.match(body.textContent, /币种未提供/); assert.doesNotMatch(body.textContent + details.textContent, /HKD/); assert.match(summary.textContent, /更新失败 · 显示此前快照/);
  renderForecasts({ ...payload, rows: [] }, { status: 'empty' }); assert.match(body.textContent, /暂无公开有效 EPS 样本/); assert.equal(metric.querySelector('strong').textContent, '0 家'); assert.match(source.textContent, /暂无公开样本/);
  renderForecasts(null, { status: 'error' }); assert.match(body.textContent, /读取失败/); assert.doesNotMatch(body.textContent + source.textContent, /暂无公开样本/); assert.equal(metric.querySelector('strong').textContent, '—'); assert.equal(summary.textContent, ''); assert.equal(details.childNodes.length, 0);
  renderForecasts({ ...payload, rows: [], meta: { ...payload.meta, stale: false, status: 'not_downloaded', snapshotDate: null } }, { status: 'empty' });
  assert.match(body.textContent, /该截止日尚无已采集的预测快照/); assert.equal(metric.querySelector('strong').textContent, '—'); assert.match(source.textContent, /尚未采集/); assert.doesNotMatch(body.textContent, /暂无公开有效 EPS 样本/);
  renderForecasts({ ...payload, rows: [], meta: { ...payload.meta, stale: false, status: 'not_downloaded', snapshotDate: null, updateStatus: 'failed' } }, { status: 'empty' });
  assert.match(body.textContent, /卖方预测采集失败/); assert.equal(metric.querySelector('strong').textContent, '—'); assert.match(source.textContent, /采集失败/); assert.doesNotMatch(body.textContent + source.textContent, /暂无公开样本/);
});

test('顶部按有效券商跨年度去重，表格标样本均值与实际研报日期，明细默认折叠', t => {
  const { body, summary, details, metric, pill, note } = fixture(t), data = example();
  data.rows[0].samples[0].brokerOriginal = '券商甲原始简称';
  renderForecasts(adapters.forecasts(data));
  assert.equal(metric.querySelector('strong').textContent, '2 家'); assert.equal(metric.querySelector('p').textContent, '近 90 天');
  assert.equal(pill.textContent, '2 组预测'); assert.equal(body.children.length, 4);
  assert.match(body.textContent, /0券商甲/); assert.match(body.textContent, /4券商乙/); assert.doesNotMatch(body.textContent, /已收集样本算术均值/); assert.match(note.textContent, /算术均值/);
  assert.match(body.textContent, /2026-10-12/); assert.doesNotMatch(body.textContent, /2026-10-14/);
  assert.match(summary.textContent, /研究截止 2026-10-14/); assert.doesNotMatch(summary.textContent, /库内报告截至|币种：/); assert.match(note.textContent, /库内报告截至 2026-10-13/); assert.match(note.textContent, /币种：接口未提供/);
  assert.doesNotMatch(summary.textContent, /EPS 口径待核验/); assert.match(note.textContent, /待原文核验/); assert.match(note.textContent, /不保证数据库记录的历史版本/);
  const dataDisclosure = descendants(note).find(item => item.tagName === 'DETAILS');
  assert.equal(dataDisclosure.open, false); assert.equal(dataDisclosure.children[0].textContent, '数据说明');
  const disclosures = descendants(details).filter(item => item.className === 'forecast-inline-details');
  assert.equal(disclosures.length, 2); assert.equal(disclosures.every(item => item.hidden === true), true);
  assert.match(details.textContent, /2026-10-10/); assert.match(details.textContent, /分析师甲/); assert.match(details.textContent, /盈利预测乙/);
  assert.match(details.textContent, /来源名称：券商甲原始简称/);
  assert.equal(descendants(details).filter(item => item.tagName === 'A').length, 0, '没有原文链接时不编造研报 URL');
});

test('EPS 极值并列券商全部显示，负数和 0 保留，潜在脚本 URL 不变成可点击出处', t => {
  const { body, details } = fixture(t), data = example();
  data.rows[0].low = { value: -1.25, broker: '券商甲', brokers: ['券商甲', '券商丙'] };
  data.rows[0].samples[0].sourceUrl = 'javascript:alert(1)'; data.rows[0].samples[0].title = '<img src=x onerror=alert(1)>';
  renderForecasts(adapters.forecasts(data)); assert.match(body.textContent, /-1.25券商甲、券商丙/);
  assert.match(details.textContent, /<img src=x onerror=alert\(1\)>/); assert.equal(descendants(details).some(item => item.tagName === 'A' || item.tagName === 'IMG'), false);
});

test('新日期读取、失败和空样本都清空上一标的 EPS、明细与来源日期', t => {
  const { body, details, summary, metric, pill, note } = fixture(t);
  for (const status of ['loading', 'error', 'not_configured', 'not_supported']) {
    renderForecasts(adapters.forecasts(example())); renderForecasts(null, { status });
    assert.equal(metric.querySelector('strong').textContent, '—'); assert.equal(details.childNodes.length, 0); assert.equal(summary.textContent, '');
    assert.doesNotMatch(body.textContent + metric.textContent + pill.textContent, /券商甲|2026-10-12|2 家/);
  }
  renderForecasts(null, { status: 'not_supported' }); assert.match(body.textContent, /该市场卖方预测暂未接入/);
  renderForecasts({ ...example(), rows: [], meta: { brokerCount: 0, databaseThrough: '2026-10-13' } }, { status: 'empty' });
  assert.equal(metric.querySelector('strong').textContent, '0 家'); assert.match(body.textContent, /暂无公开有效 EPS 样本/); assert.equal(details.childNodes.length, 0);
  assert.match(note.textContent, /库内报告截至 2026-10-13/); assert.doesNotMatch(summary.textContent, /库内报告截至/);
});

test('切换日期和股票会取消旧预测请求，晚到结果不能复用', async () => {
  const session = createCompanySession({ ticker: '002920.SZ' });
  const oldDate = session.begin('forecasts'); const newDate = session.begin('forecasts');
  assert.equal(oldDate.signal.aborted, true); assert.equal(oldDate.isCurrent(), false); assert.equal(newDate.isCurrent(), true);
  session.select({ ticker: '600519.SH' }); assert.equal(newDate.signal.aborted, true); assert.equal(newDate.isCurrent(), false);
  assert.equal(session.begin('forecasts').ticker, '600519.SH');
  const main = await readFile(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  const dateChange = main.slice(main.indexOf("researchDateInput.addEventListener('change'"), main.indexOf('initAIStatus({'));
  const refreshedModules = dateChange.match(/Promise\.allSettled\(\[([^\]]+)\]\.map\(refresh\)\)/)?.[1];
  assert.ok(refreshedModules);
  for (const module of ['quote', 'prices', 'forecasts', 'bands']) assert.ok(refreshedModules.includes(`'${module}'`));
  assert.equal(refreshedModules.includes("'debates'"), false);
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  assert.match(html, /<th>样本均值<\/th>/); assert.doesNotMatch(html, /样本一致预期/);
  for (const id of ['debate-coverage', 'debate-sources']) assert.match(html, new RegExp(`<details[^>]*id="${id}"[^>]*hidden>`));
});

 test('点击年度行在原位展开明细，再次点击收起，链接不触发展开', t => {
  const { body } = fixture(t); renderForecasts(example());
  const row = body.children[0], detail = body.children[1], toggle = descendants(row).find(item => item.tagName === 'BUTTON');
  assert.equal(detail.hidden, true);
  row.listeners.get('click')({ target: { closest: () => null } });
  assert.equal(detail.hidden, false); assert.equal(toggle.attributes.get('aria-expanded'), 'true');
  assert.match(detail.textContent, /分析师甲/);
  row.listeners.get('click')({ target: { closest: () => ({}) } });
  assert.equal(detail.hidden, false);
  row.listeners.get('click')({ target: { closest: () => null } });
  assert.equal(detail.hidden, true); assert.equal(toggle.attributes.get('aria-expanded'), 'false');
  assert.equal(body.children[3].hidden, true);
});
