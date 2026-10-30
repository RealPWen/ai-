import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderBands, cleanupValuationBands, createModuleReset } from '../frontend/src/views/research-view.js';

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.className = ''; this.children = []; this.attributes = new Map(); this.listeners = new Map(); this._text = ''; this.dataset = {}; }
  get childNodes() { return this.children; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { children.forEach(child => { child.parentElement = this; this.children.push(child); }); }
  replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === 'class') this.className = String(value); }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  removeEventListener(event, handler) { if (this.listeners.get(event) === handler) this.listeners.delete(event); }
  getBoundingClientRect() { return { left: 0, width: 600 }; }
  querySelector(selector) { return descendants(this).slice(1).find(item => selector.startsWith('.') ? item.className.split(' ').includes(selector.slice(1)) : item.tagName === selector.toUpperCase()) || null; }
  querySelectorAll(selector) { return descendants(this).slice(1).filter(item => selector.startsWith('.') ? item.className.split(' ').includes(selector.slice(1)) : item.tagName === selector.toUpperCase()); }
  cloneNode(deep) { const copy = new Element(this.tagName); copy.className = this.className; copy._text = this._text; copy.attributes = new Map(this.attributes); if (deep) copy.append(...this.children.map(child => child.cloneNode(true))); return copy; }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
const element = (tag = 'div', className = '', text = '') => { const item = new Element(tag); item.className = className; item.textContent = text; return item; };
const findClass = (parent, className) => descendants(parent).find(item => item.className.split(' ').includes(className));
const findAllClass = (parent, className) => descendants(parent).filter(item => item.className.split(' ').includes(className));
function fixture(t) {
  const grid = element('div', 'band-grid');
  for (const title of ['PE-TTM band', 'PB band']) {
    const panel = element('article', 'band-panel'), heading = element('div', 'panel-heading');
    heading.append(element('h3', '', title), element('span', 'plain-badge', '近 1 年'));
    panel.append(heading, element('div', 'band-empty', '等待读取')); grid.append(panel);
  }
  const other = new Map([['.chart-empty', element()], ['.hero-side > strong', element()], ['.hero-side > p', element()]]);
  const original = globalThis.document;
  globalThis.document = {
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    querySelector: selector => selector === '.band-grid' ? grid : other.get(selector) || null,
    querySelectorAll: selector => selector === '.band-panel' ? grid.children : [],
  };
  t.after(() => { cleanupValuationBands(); globalThis.document = original; });
  return { grid, panels: grid.children };
}
const example = () => {
  const group = (metric, scale) => ({ metric, status: 'available',
    points: Array.from({ length: 24 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`, value: (index + 10) * scale })),
    quantiles: { p10: 12.3 * scale, p25: 15.75 * scale, p50: 21.5 * scale, p75: 27.25 * scale, p90: 30.7 * scale },
    latest: { date: '2026-09-24', rawValue: 33 * scale, value: 33 * scale, percentile: 97.9166666667 },
    meta: { validCount: 24, totalCount: 24, missingCount: 0, nonPositiveCount: 0, firstDate: '2026-09-01', lastDate: '2026-09-24', availableFrom: '2025-10-14', databaseThrough: '2026-10-13', minSamples: 20 },
  });
  return { ticker: '002920.SZ', asOf: '2026-10-14', period: '1y', windowStart: '2025-10-14', source: 'Tushare daily_basic', peTtm: group('pe_ttm', 1), pb: group('pb', 0.1) };
};

test('PE/PB两卡保留核心指标、走势和图例，不显示统计明细与技术脚注', t => {
  const { panels } = fixture(t); renderBands(example());
  assert.match(panels[0].textContent, /最新估值33.00/); assert.match(panels[1].textContent, /最新估值3.30/);
  assert.doesNotMatch(panels[0].textContent, /中位数 P50/); assert.match(panels[0].textContent, /历史分位97.9%/);
  for (const panel of panels) {
    assert.equal(findAllClass(panel, 'valuation-band-range').length, 2);
    const quantiles = findAllClass(panel, 'valuation-band-quantile'); assert.equal(quantiles.length, 5);
    assert.equal(quantiles.filter(item => item.attributes.get('data-quantile') === 'p50').length, 1);
    assert.match(panel.textContent, /P10–P90P25–P75P50 中位数/);
    assert.doesNotMatch(panel.textContent, /有效样本|已剔除|实际记录|请求截止|Tushare|正值样本|悬停查看|Home \/ End/);
    for (const className of ['valuation-band-levels', 'valuation-band-footnote', 'valuation-band-method', 'valuation-band-guide']) {
      assert.equal(findAllClass(panel, className).length, 0);
    }
    assert.doesNotMatch(panel.textContent, /近5年|近 5 年|2027/);
    const svg = descendants(panel).find(item => item.tagName === 'SVG'); assert.match(svg.attributes.get('aria-label'), /整个所选窗口/);
    assert.equal(svg.parentElement, findClass(panel, 'valuation-band-chart-scroll'));
    assert.equal(svg.attributes.get('viewBox'), '0 0 640 340');
    const axes = findAllClass(svg, 'valuation-band-axis');
    assert.equal(axes.filter(item => item.attributes.get('text-anchor') === 'end' && Number(item.attributes.get('y')) < 310).length, 5);
    assert.deepEqual(axes.filter(item => item.attributes.get('y') === '328').map(item => item.textContent), ['2026-09-01', '2026-09-13', '2026-09-24']);
  }
});

test('HK band展示实际来源和历史覆盖，样本不足时不构造分位区间', t => {
  const { panels } = fixture(t), payload = example();
  payload.ticker = '00700.HK'; payload.market = 'HK'; payload.currency = 'HKD'; payload.source = 'Example HK provider';
  for (const group of [payload.peTtm, payload.pb]) {
    group.points = group.points.slice(0, 1); group.status = 'insufficient_samples';
    group.quantiles = { p10: null, p25: null, p50: null, p75: null, p90: null };
    group.latest = { date: '2026-09-01', rawValue: group.points[0].value, value: group.points[0].value, percentile: null };
    group.meta = { ...group.meta, validCount: 1, totalCount: 1, lastDate: '2026-09-01' };
  }
  renderBands(payload);
  for (const panel of panels) {
    const metadata = findClass(panel, 'valuation-band-latest-date');
    assert.equal(metadata.textContent, '2026-09-01 · Example HK provider');
    assert.match(metadata.title, /历史记录 2026-09-01 至 2026-09-01 · 来源：Example HK provider/);
    assert.match(panel.textContent, /样本不足，分位暂缺/);
    assert.equal(findAllClass(panel, 'valuation-band-range').length, 0);
    assert.equal(findAllClass(panel, 'valuation-band-quantile').length, 0);
    assert.doesNotMatch(panel.textContent, /Tushare|港股历史估值暂未接入|2025-10-14/);
  }
  renderBands(null, { status: 'loading', period: '6m' });
  for (const panel of panels) assert.doesNotMatch(panel.textContent, /Example|2026-09-01|10\.00/);
});

test('空日和非正估值形成曲线缺口，全部有效高异常值落在坐标内', t => {
  const { panels } = fixture(t), payload = example();
  payload.peTtm.points[5].value = null; payload.peTtm.points[10].value = -3; payload.peTtm.points[23].value = 10000;
  payload.peTtm.meta = { ...payload.peTtm.meta, validCount: 22, missingCount: 1, nonPositiveCount: 1 };
  renderBands(payload);
  const paths = findAllClass(panels[0], 'valuation-band-history'); assert.equal(paths.length, 3);
  assert.equal(paths[0].attributes.get('d').split('L').length, 5);
  assert.equal(paths[1].attributes.get('d').split('L').length, 4);
  const lastCoordinates = paths.at(-1).attributes.get('d').split(' ').slice(-2).map(Number);
  assert.ok(lastCoordinates[1] >= 32 && lastCoordinates[1] <= 350);
  for (const path of paths) assert.doesNotMatch(path.attributes.get('d'), /NaN|Infinity/);
  assert.doesNotMatch(panels[0].textContent, /有效样本|已剔除/);
});

test('键盘和悬停选择日期、倍数及窗口中秩，缺失点不显示为零', t => {
  const { panels } = fixture(t), payload = example(); payload.peTtm.points[1].value = null; renderBands(payload);
  const svg = descendants(panels[0]).find(item => item.tagName === 'SVG'), inspection = findClass(panels[0], 'valuation-band-inspection');
  assert.equal(svg.attributes.get('tabindex'), '0'); assert.match(inspection.textContent, /2026-09-24.*PE-TTM 33.00/);
  let prevented = false; svg.listeners.get('keydown')({ key: 'Home', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.match(inspection.textContent, /2026-09-01.*10.00.*窗口分位 2.2%/);
  svg.listeners.get('keydown')({ key: 'ArrowRight', preventDefault() {} });
  assert.match(inspection.textContent, /2026-09-02.*当日倍数缺失或非正/); assert.doesNotMatch(inspection.textContent, /0.00/);
  const marker = findClass(svg, 'valuation-band-selected'); assert.equal(marker.attributes.get('visibility'), 'hidden');
  svg.listeners.get('pointermove')({ clientX: 588 }); assert.match(inspection.textContent, /2026-09-24.*33.00/);
  svg.listeners.get('keydown')({ key: 'Home', preventDefault() {} }); svg.listeners.get('blur')();
  assert.match(inspection.textContent, /2026-09-24/);
});

test('放大图表在窄幅和宽幅等比缩放后仍准确选择首尾与中间交易日', t => {
  const { panels } = fixture(t); renderBands(example());
  const svg = descendants(panels[0]).find(item => item.tagName === 'SVG'), inspection = findClass(panels[0], 'valuation-band-inspection');
  for (const width of [400, 560, 1200]) {
    svg.getBoundingClientRect = () => ({ left: 40, width, height: 420 });
    const scale = Math.min(width / 640, 420 / 340), horizontalInset = (width - 640 * scale) / 2;
    for (const [index, expectedDate] of [[0, '2026-09-01'], [11, '2026-09-12'], [23, '2026-09-24']]) {
      const clientX = 40 + horizontalInset + (62 + index * 558 / 23) * scale;
      svg.listeners.get('pointermove')({ clientX }); assert.match(inspection.textContent, new RegExp(expectedDate));
    }
  }
  assert.equal(svg.attributes.has('preserveAspectRatio'), false, '保留SVG默认等比缩放');
});

test('最新记录缺失或非正时不回退到历史有效倍数，历史样本充分仍保留分位带', t => {
  const { panels } = fixture(t);
  for (const rawValue of [null, -2, 0]) {
    const payload = example(); payload.peTtm.points[23].value = null;
    payload.peTtm.latest = { date: '2026-09-24', rawValue, value: null, percentile: null };
    renderBands(payload);
    const latest = findClass(panels[0], 'valuation-band-latest'); assert.equal(latest.querySelector('strong').textContent, rawValue < 0 ? '亏损' : '—');
    assert.match(panels[0].textContent, /历史分位—/);
    if (rawValue < 0) assert.doesNotMatch(panels[0].textContent, /最新值缺失或非正/);
    else assert.match(panels[0].textContent, /最新值缺失或非正/);
    assert.equal(findAllClass(panels[0], 'valuation-band-range').length, 2);
    assert.match(findClass(panels[0], 'valuation-band-inspection').textContent, rawValue < 0 ? /2026-09-24.*PE-TTM 亏损/ : /2026-09-24.*当日倍数缺失或非正/);
  }
});

test('历史估值缺失与未采集不会显示亏损，只有明确负PE保留亏损提示', t => {
  const { panels } = fixture(t);
  for (const ticker of ['000002.SZ', '002920.SZ', '00700.HK']) {
    for (const value of [null, -2, 0]) {
      const payload = example(); payload.ticker = ticker;
      for (const group of [payload.peTtm, payload.pb]) {
        group.points = group.points.map(point => ({ ...point, value: null })); group.status = 'no_data';
        group.latest = { ...group.latest, rawValue: value, value: null, percentile: null };
      }
      renderBands(payload);
      assert.equal(findClass(panels[0], 'valuation-band-empty-state').textContent, value < 0 ? '亏损' : '暂无历史估值数据。');
      assert.equal(findAllClass(panels[0], 'valuation-loss').length, value < 0 ? 1 : 0);
      assert.equal(descendants(panels[0]).some(item => item.tagName === 'SVG'), false);
      assert.match(panels[1].textContent, /暂无历史估值数据/);
    }
  }
  for (const status of ['ready', 'empty']) {
    renderBands(null, { status });
    assert.equal(findClass(panels[0], 'valuation-band-empty-state').textContent, '暂无历史估值记录。');
  }
  renderBands(example());
  assert.equal(findAllClass(panels[0], 'valuation-loss').length, 0);
  assert.match(panels[0].textContent, /最新估值33.00/);
});

test('全市场港股的尚未采集状态明确清理旧曲线监听，不出现原28限制', t => {
  const { panels } = fixture(t); renderBands(example());
  const old = descendants(panels[0]).find(item => item.tagName === 'SVG');
  const payload = example(); payload.ticker = '00001.HK'; payload.coverageScope = 'hk_listed_universe'; payload.coverageStatus = 'not_downloaded';
  renderBands(payload);
  assert.equal(old.listeners.size, 0);
  for (const panel of panels) {
    assert.match(panel.textContent, /历史估值尚未采集/);
    assert.doesNotMatch(panel.textContent, /28 只|价值投资池/);
    assert.doesNotMatch(panel.textContent, /亏损|33\.00|3\.30|2026-09/);
    assert.equal(descendants(panel).some(item => item.tagName === 'SVG'), false);
  }
});

test('港股采集中、源明确无估值、失败和无日线状态分别显示，不把缺数据写成亏损', t => {
  const { panels } = fixture(t), payload = example(); payload.ticker = '00001.HK';
  for (const group of [payload.peTtm, payload.pb]) {
    group.points = []; group.status = 'no_data'; group.latest = { date: null, rawValue: null, value: null, percentile: null };
    group.quantiles = { p10: null, p25: null, p50: null, p75: null, p90: null };
  }
  for (const [status, text] of [['collecting', '正在采集'], ['no_data', '已查询百度股市通'], ['collection_failed', '估值采集失败'], ['no_price_data', '暂无本地日线']]) {
    payload.coverageStatus = status; renderBands(payload);
    for (const panel of panels) {
      assert.ok(panel.textContent.includes(text)); assert.doesNotMatch(panel.textContent, /亏损|28 只|价值投资池/);
      assert.equal(descendants(panel).some(item => item.tagName === 'SVG'), false);
    }
  }
});

test('港股新采集失败或源返回空仍展示此前历史，最新价格日缺估值不回退旧倍数', t => {
  const { panels } = fixture(t), payload = example(); payload.ticker = '00001.HK';
  payload.peTtm.points.at(-1).value = null;
  payload.peTtm.latest = { date: '2026-09-24', rawValue: null, value: null, percentile: null };
  payload.meta = { retainedHistory: true, missingPriceCount: 1 };
  for (const [status, text] of [['collection_failed', '估值采集失败'], ['collecting', '正在采集估值'], ['no_data', '保留此前历史记录']]) {
    payload.coverageStatus = status; renderBands(payload);
    for (const panel of panels) { assert.ok(panel.textContent.includes(text)); assert.equal(descendants(panel).some(item => item.tagName === 'SVG'), true); }
    assert.match(panels[0].textContent, /最新估值—/); assert.match(panels[0].textContent, /部分交易日估值缺失/);
    assert.doesNotMatch(panels[0].textContent, /最新估值32\.00/);
  }
});

test('港股单项指标明确无覆盖时只提示该项，其他指标仍保留真实曲线', t => {
  const { panels } = fixture(t), payload = example(); payload.ticker = '00001.HK'; payload.coverageStatus = 'available';
  payload.meta = { sourceCoverage: { kind: 'partial_metrics', metricStatus: { pe_ttm: 'available', pb: 'no_data' } } };
  payload.pb.points = payload.pb.points.map(point => ({ ...point, value: null })); payload.pb.latest = { ...payload.pb.latest, value: null, rawValue: null, percentile: null };
  renderBands(payload);
  assert.equal(descendants(panels[0]).some(item => item.tagName === 'SVG'), true);
  assert.match(panels[1].textContent, /已查询百度股市通，暂未取得 PB 历史估值/);
  assert.equal(descendants(panels[1]).some(item => item.tagName === 'SVG'), false);
});

test('不足20样本只有真实曲线，无分位带/假中位数，异常提示不展示统计数量', t => {
  const { panels } = fixture(t), payload = example();
  payload.peTtm.points = payload.peTtm.points.slice(0, 3); payload.peTtm.status = 'insufficient_samples';
  payload.peTtm.latest = { date: '2026-09-03', rawValue: 12, value: 12, percentile: null };
  payload.peTtm.quantiles = { p10: null, p25: null, p50: null, p75: null, p90: null };
  payload.peTtm.meta = { ...payload.peTtm.meta, validCount: 3, totalCount: 3 };
  payload.pb.points = payload.pb.points.map(point => ({ ...point, value: null })); payload.pb.status = 'no_data';
  payload.pb.latest = { date: '2026-09-24', rawValue: -2, value: null, percentile: null };
  payload.pb.meta = { ...payload.pb.meta, validCount: 0, missingCount: 12, nonPositiveCount: 12 };
  renderBands(payload);
  assert.equal(findAllClass(panels[0], 'valuation-band-range').length, 0);
  assert.equal(findAllClass(panels[0], 'valuation-band-quantile').length, 0);
  assert.equal(findAllClass(panels[0], 'valuation-band-history').length, 1);
  assert.match(panels[0].textContent, /最新估值12.00历史分位—/);
  assert.match(panels[0].textContent, /样本不足，分位暂缺/);
  assert.doesNotMatch(panels[0].textContent, /有效样本|当前 3 个/);
  assert.equal(descendants(panels[1]).some(item => item.tagName === 'SVG'), false);
  assert.match(panels[1].textContent, /暂无历史估值数据/); assert.doesNotMatch(panels[1].textContent, /已剔除|缺失 12|非正 12/);
});

test('常数和单点估值走势均保持可见有限坐标，未来观察不会进入曲线', t => {
  const { panels } = fixture(t);
  for (const count of [1, 20]) {
    const payload = example(); payload.peTtm.points = payload.peTtm.points.slice(0, count).map(point => ({ ...point, value: 8 }));
    payload.peTtm.status = count < 20 ? 'insufficient_samples' : 'available';
    payload.peTtm.quantiles = { p10: 8, p25: 8, p50: 8, p75: 8, p90: 8 };
    payload.peTtm.latest = { date: payload.peTtm.points.at(-1).date, rawValue: 8, value: 8, percentile: count < 20 ? null : 50 };
    payload.peTtm.points.push({ date: '2027-01-01', value: 999 }); renderBands(payload);
    const svg = descendants(panels[0]).find(item => item.tagName === 'SVG'); assert.ok(svg);
    for (const item of descendants(svg)) for (const value of item.attributes.values()) assert.doesNotMatch(value, /NaN|Infinity|undefined|2027/);
    if (count === 1) assert.equal(findAllClass(svg, 'valuation-band-isolated').length, 1);
    else assert.match(panels[0].textContent, /历史分位50%/);
  }
});

test('重载、失败、未配置及切换窗口均立即清旧图监听和数据，reset恢复前清理引用', t => {
  const { grid, panels } = fixture(t), reset = createModuleReset();
  for (const status of ['loading', 'error', 'not_configured']) {
    renderBands(example()); const old = descendants(panels[0]).find(item => item.tagName === 'SVG'); assert.equal(old.listeners.size, 4);
    renderBands(null, { status, period: '6m' }); assert.equal(old.listeners.size, 0);
    assert.equal(panels[0].querySelector('.plain-badge').textContent, '近 6 个月');
    assert.equal(descendants(panels[0]).some(item => item.tagName === 'SVG'), false);
    assert.doesNotMatch(panels[0].textContent, /33.00|2026-09/);
  }
  renderBands(example()); const old = descendants(panels[0]).find(item => item.tagName === 'SVG');
  const next = example(); next.period = '6m'; renderBands(next); assert.equal(old.listeners.size, 0);
  assert.equal(panels[0].querySelector('.plain-badge').textContent, '近 6 个月');
  const current = descendants(panels[0]).find(item => item.tagName === 'SVG'); reset(); assert.equal(current.listeners.size, 0);
  assert.equal(grid.textContent, 'PE-TTM band近 1 年等待读取PB band近 1 年等待读取');
  renderBands(example()); const chart = descendants(grid).find(item => item.tagName === 'SVG'); cleanupValuationBands(); assert.equal(chart.listeners.size, 0);
});

test('独立共同窗口控件默认1Y，保留双卡并可访问', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  assert.match(html, /class="valuation-band-controls"/);
  assert.match(html, /data-band-period="6m" aria-pressed="false"/);
  assert.match(html, /data-band-period="1y" aria-pressed="true"/);
  assert.match(html, /aria-labelledby="pe-band-title"/); assert.match(html, /aria-labelledby="pb-band-title"/);
});
