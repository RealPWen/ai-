import test from 'node:test';
import assert from 'node:assert/strict';
import { createModuleReset, renderQuote, renderPrices } from '../frontend/src/views/research-view.js';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this._text = '';
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
    };
  }
  get childNodes() { return this.children; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { children.forEach(child => { child.parentElement = this; this.children.push(child); }); }
  replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === 'class') this.className = String(value); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  removeEventListener(type, handler) { if (this.listeners.get(type) === handler) this.listeners.delete(type); }
  getBoundingClientRect() { return { left: 0, width: 1100 }; }
  querySelector(selector) { return descendants(this).slice(1).find(item => selector.startsWith('.') ? item.className.split(' ').includes(selector.slice(1)) : item.tagName === selector.toUpperCase()) || null; }
  cloneNode(deep) { const clone = new Element(this.tagName); clone.className = this.className; clone._text = this._text; clone.id = this.id; clone.dataset = { ...this.dataset }; clone.attributes = new Map(this.attributes); if (deep) clone.append(...this.children.map(child => child.cloneNode(true))); return clone; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
}
function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }
function element(tag, className = '', text = '') { const result = new Element(tag); result.className = className; result.textContent = text; return result; }
function fixture(t, ticker = '002920.SZ') {
  const metrics = element('div', 'metrics');
  for (let index = 0; index < 4; index++) {
    const card = element('article', 'metric'), heading = element('span', '', index ? '其他指标' : '最新收盘价');
    if (!index) heading.append(element('small', '', '—'));
    card.append(heading, element('strong', '', '—'), element('p', '', '待接入'));
    if (!index) card.append(element('span', 'quote-trade-date', '收盘日线 · 非实时'));
    metrics.append(card);
  }
  const area = element('div', 'chart-empty'), caption = element('p', '', '待读取日线'); caption.id = 'price-caption'; area.append(caption);
  const footer = element('div', 'chart-footer'); footer.append(element('span', '', '数据范围：尚未取得'), element('span', '', '数据来源：Tushare'));
  const elements = new Map([['.metrics', metrics], ['.chart-empty', area], ['.chart-footer', footer], ['current-company-ticker', element('span', '', ticker)], ['market-title', element('h2')], ['.market-heading-note', element('p')]]);
  ['.debate-grid', '#debates .status-pill', '#valuation tbody', '#valuation .status-pill', '.band-grid', '.events-empty', '#events .status-pill', '.hero-side > strong', '.hero-side > p'].forEach(selector => elements.set(selector, element('div')));
  const original = globalThis.document;
  globalThis.document = {
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), createTextNode: text => element('#text', '', text),
    getElementById: id => elements.get(id) || [...elements.values()].flatMap(descendants).find(item => item.id === id) || null,
    querySelector: selector => elements.get(selector) || null,
    querySelectorAll: selector => selector === '.metrics .metric' ? metrics.children : [],
  };
  t.after(() => { globalThis.document = original; });
  return { metrics, area, footer };
}
const quote = overrides => ({ ticker: '002920.SZ', asOf: '2026-10-13', requestedAsOf: '2026-10-14', price: 87.24, open: 85.8, high: 87.6, low: 85.3, previousClose: 85.24, change: 2, pctChange: 2.35, volume: 12345.67, volumeUnit: '手', amount: 103456.7, amountUnit: '千元', currency: 'CNY', source: 'Tushare', adjustment: 'none', peTtm: null, pb: null, valuationAsOf: null, valuationStatus: 'missing', valuationSource: 'Tushare daily_basic', databaseThrough: '2026-10-13', ...overrides });
const prices = () => ({ ticker: '002920.SZ', points: [
  { date: '2026-10-09', value: 85, open: 84, high: 86, low: 83, close: 85, volume: 12345.67, amount: 23456.78 },
  { date: '2026-10-12', value: 86, open: 87, high: 88, low: 84, close: 86, volume: 14000, amount: 25678.9 },
  { date: '2026-10-13', value: 87.24, open: 86, high: 88.2, low: 85.9, close: 87.24, volume: 12500, amount: 24567.8 },
], meta: { source: 'Tushare', currency: 'CNY', adjustment: 'none', requestedAsOf: '2026-10-14', databaseThrough: '2026-10-13', period: '1m' } });

test('价格卡展示实际交易日和官方涨跌，红涨绿跌零值中性，估值不借用价格', t => {
  const { metrics } = fixture(t); renderQuote(quote());
  const price = metrics.children[0];
  assert.equal(price.querySelector('strong').textContent, '87.24');
  assert.equal(price.querySelector('strong').className, 'market-up');
  assert.equal(price.querySelector('p').textContent, '+2.00 (+2.35%)');
  assert.equal(price.querySelector('.quote-trade-date').textContent, '2026-10-13 收盘');
  assert.equal(price.querySelector('.quote-trade-date').attributes.get('title'), '日线 · 非实时 · 研究截止 2026-10-14');
  assert.equal(metrics.children[1].querySelector('strong').textContent, '—');
  assert.equal(metrics.children[1].querySelector('p').textContent, '估值暂无数据');
  renderQuote(quote({ change: -1, pctChange: -1.12 })); assert.equal(price.querySelector('strong').className, 'market-down');
  renderQuote(quote({ change: 0, pctChange: 0 })); assert.equal(price.querySelector('strong').className, 'market-flat'); assert.equal(price.querySelector('p').textContent, '0.00 (0.00%)');
});

test('日K图保留成交单位、实际范围与库内截止，支持键盘和悬停选择交易日', t => {
  const { area, footer } = fixture(t); renderPrices(prices());
  const all = descendants(area), svg = all.find(item => item.tagName === 'SVG'), inspection = all.find(item => item.className === 'market-inspection');
  assert.ok(svg); assert.equal(svg.attributes.get('tabindex'), '0');
  assert.match(footer.textContent, /2026-10-09 — 2026-10-13/); assert.match(footer.textContent, /Tushare/);
  assert.doesNotMatch(footer.textContent, /研究截止|库内数据截至|非实时/);
  const details = area.querySelector('.market-chart-details');
  assert.equal(details.attributes.has('open'), false); assert.equal(details.querySelector('summary').textContent, '数据说明');
  assert.match(details.textContent, /研究截止 2026-10-14 · 库内数据截至 2026-10-13 · Tushare · 未复权 · 非实时/);
  assert.match(inspection.textContent, /2026-10-13/); assert.match(inspection.textContent, /1.25 万手/); assert.match(inspection.textContent, /2,456.78 万元/);
  assert.ok(descendants(inspection).some(item => item.attributes.get('title') === '成交额 24,567.8 千元'), '精简单位后仍可悬停查看源单位');
  let prevented = false; svg.listeners.get('keydown')({ key: 'Home', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.match(inspection.textContent, /2026-10-09/); assert.match(inspection.textContent, /1.23 万手/);
  svg.listeners.get('keydown')({ key: 'ArrowRight', preventDefault() {} }); assert.match(inspection.textContent, /2026-10-12/);
  svg.listeners.get('pointermove')({ clientX: 1080 }); assert.match(inspection.textContent, /2026-10-13/);
  svg.getBoundingClientRect = () => ({ left: 40, width: 800, height: 180 });
  const scale = 180 / Number(svg.attributes.get('viewBox').split(' ')[3]), horizontalInset = (800 - 1100 * scale) / 2;
  for (const [index, date] of [[0, '2026-10-09'], [1, '2026-10-12'], [2, '2026-10-13']]) {
    svg.listeners.get('pointermove')({ clientX: 40 + horizontalInset + (92 + index * 494) * scale });
    assert.match(inspection.textContent, new RegExp(date));
  }
  assert.equal(all.filter(item => item.tagName === 'RECT' && item.className.includes('market-volume-bar')).length, 3);
  assert.match(document.getElementById('price-caption').textContent, /不能直接视为投资收益/);
});

test('无数据与港股空态清空旧价格、旧图和事件，来源日期不串到下一标的', t => {
  const { metrics, area, footer } = fixture(t, '02313.HK'); renderQuote(quote()); renderPrices(prices());
  const svg = descendants(area).find(item => item.tagName === 'SVG'); assert.equal(svg.listeners.size, 4);
  renderPrices({ ticker: '02313.HK', points: [], meta: {} }); renderQuote(null);
  assert.equal(svg.listeners.size, 0); assert.equal(descendants(area).some(item => item.tagName === 'SVG'), false);
  assert.match(area.textContent, /当前港股与研究截止日期/); assert.equal(metrics.children[0].querySelector('strong').textContent, '—');
  assert.match(metrics.children[0].querySelector('p').textContent, /当前港股与研究截止日期/);
  assert.doesNotMatch(footer.textContent, /2026-10-13/); assert.ok(document.getElementById('price-caption'));
});

test('港股日K保留合法开收盘与高低交叉，使用港元与股且不展示A股行业对照', t => {
  const { metrics, area, footer } = fixture(t, '00700.HK');
  renderQuote(quote({ ticker: '00700.HK', currency: 'HKD', source: 'Tencent', volumeUnit: '股', amountUnit: '港元', amount: null,
    peTtm: null, pb: null, valuationStatus: 'missing', valuationSource: null }));
  const data = { ticker: '00700.HK', points: [
    { date: '2026-10-12', open: 80, close: 81, high: 79, low: 78, volume: 1234567, amount: null },
    { date: '2026-10-13', open: 69, close: 70, high: 72, low: 71, volume: 2345678, amount: null },
  ], meta: { period: '1y', source: 'Tencent', currency: 'HKD', adjustment: 'none', requestedAsOf: '2026-10-14', databaseThrough: '2026-10-13', volumeUnit: '股', amountUnit: '港元' } };
  renderPrices(data);
  const all = descendants(area), svg = all.find(item => item.tagName === 'SVG'), inspection = all.find(item => item.className === 'market-inspection');
  assert.equal(all.filter(item => item.className.startsWith('market-candle ')).length, 2);
  assert.equal(all.filter(item => item.className.includes('market-volume-bar')).length, 2);
  assert.match(svg.textContent, /价格 \(HKD\).*成交量 \(股\)/);
  assert.match(inspection.textContent, /234.57 万股.*成交额暂无/);
  assert.match(footer.textContent, /Tencent/); assert.match(area.querySelector('.market-chart-details').textContent, /Tencent.*未复权.*成交量：股.*成交额：港元/);
  assert.doesNotMatch(area.textContent + footer.textContent, /A 股|万手|千元|申万|行业指数|区间相对表现/);
  assert.equal(document.getElementById('market-title').textContent, '未复权日 K 线与恒生指数');
  assert.equal(metrics.children[0].querySelector('small').textContent, 'HKD');
  assert.match(metrics.children[1].textContent, /估值暂无数据/); assert.doesNotMatch(metrics.children[1].textContent, /亏损|Tushare|daily_basic/);
  const candles = all.filter(item => item.className.startsWith('market-candle '));
  for (const candle of candles) {
    const rect = candle.querySelector('rect'); assert.ok(Number(rect.attributes.get('y')) >= 32); assert.ok(Number(rect.attributes.get('y')) + Number(rect.attributes.get('height')) <= 292);
  }
  svg.listeners.get('keydown')({ key: 'Home', preventDefault() {} });
  assert.match(inspection.textContent, /开盘80.00最高79.00最低78.00收盘81.00/);
  assert.doesNotMatch(document.getElementById('price-caption').textContent, /已跳过/);
  renderPrices(prices());
  assert.match(area.textContent, /成交量 \(手\)/); assert.match(document.getElementById('market-title').textContent, /行业指数/);
});

test('美元柜台港股按USD和美元显示，不被标成港元，空报价保留已知币种', t => {
  const { metrics, area } = fixture(t, '00770.HK');
  renderQuote(quote({ ticker: '00770.HK', currency: 'USD', source: 'Tencent', volumeUnit: '股', amountUnit: '美元' }));
  const data = prices(); data.ticker = '00770.HK'; data.meta = { ...data.meta, currency: 'USD', source: 'Tencent', volumeUnit: '股', amountUnit: '美元' };
  renderPrices(data);
  assert.equal(metrics.children[0].querySelector('small').textContent, 'USD');
  assert.match(area.textContent, /价格 \(USD\).*成交量 \(股\)/);
  assert.match(area.textContent, /成交额.*万美元/);
  assert.match(area.querySelector('.market-chart-details').textContent, /价格：USD.*成交额：美元/);
  assert.doesNotMatch(area.textContent, /港元|价格 \(HKD\)|千元/);
  renderQuote(null); assert.equal(metrics.children[0].querySelector('small').textContent, 'USD');
});

test('港股低价和绝对涨跌保留三位精度，K线检查与坐标不把价格舍入成零', t => {
  const { metrics, area } = fixture(t, '02231.HK');
  renderQuote(quote({ ticker: '02231.HK', currency: 'HKD', price: 0.012, change: 0.001, pctChange: 9.09 }));
  assert.equal(metrics.children[0].querySelector('strong').textContent, '0.012');
  assert.equal(metrics.children[0].querySelector('p').textContent, '+0.001 (+9.09%)');
  for (const close of [0.012, 0.005, 0.001]) {
    renderPrices({ ticker: '02231.HK', points: [{ date: '2026-10-16', open: close, high: close, low: close, close, volume: 1000, amount: null }],
      meta: { period: '1m', source: 'Tencent', currency: 'HKD', adjustment: 'none', volumeUnit: '股', amountUnit: '港元' } });
    assert.match(area.querySelector('.market-inspection-prices').textContent, new RegExp(`收盘${close.toFixed(3).replace('.', '\\.')}`));
    const labels = descendants(area).filter(item => item.tagName === 'TEXT' && item.className === 'market-axis').slice(0, 5).map(item => item.textContent);
    assert.equal(new Set(labels).size, 5);
    assert.ok(labels.every(label => Number(label.replaceAll(',', '')) > 0));
    assert.doesNotMatch(area.querySelector('.market-inspection-prices').textContent, /收盘0\.00(?:$|\D)/);
  }
});

test('切换公司 reset 恢复价格占位与图表初始态，并解绑旧图交互', t => {
  const { metrics, area, footer } = fixture(t); const reset = createModuleReset();
  renderQuote(quote()); renderPrices(prices()); const svg = descendants(area).find(item => item.tagName === 'SVG');
  reset();
  assert.equal(svg.listeners.size, 0); assert.equal(area.className, 'chart-empty'); assert.equal(metrics.children[0].querySelector('strong').textContent, '—');
  assert.equal(footer.textContent, '数据范围：尚未取得数据来源：Tushare'); assert.equal(document.getElementById('price-caption').textContent, '待读取日线');
});

test('PE/PB 使用实际估值日、倍数和来源，不回退研究截止日或价格日期', t => {
  const { metrics } = fixture(t);
  renderQuote(quote({ peTtm: 18.92, pb: 2.94, valuationAsOf: '2026-10-12', valuationStatus: 'available' }));
  assert.equal(metrics.children[1].querySelector('strong').textContent, '18.92');
  assert.equal(metrics.children[2].querySelector('strong').textContent, '2.94');
  for (const card of metrics.children.slice(1, 3)) {
    assert.equal(card.querySelector('p').textContent, '估值日 2026-10-12');
    assert.match(card.attributes.get('title'), /Tushare daily_basic/); assert.equal(card.querySelector('.valuation-source'), null);
    assert.doesNotMatch(card.textContent, /2026-10-13|2026-10-14/);
  }
  renderQuote(quote({ peTtm: 20, pb: 3, valuationAsOf: null, valuationStatus: 'available' }));
  assert.equal(metrics.children[1].querySelector('p').textContent, '估值日 未提供');
  for (const card of metrics.children.slice(1, 3)) assert.doesNotMatch(card.textContent, /截至|2026-10-13|2026-10-14/);
});

test('港股PE/PB卡使用真实估值及其独立日期和来源，切回缺失时清空旧值', t => {
  const { metrics } = fixture(t, '00700.HK');
  const hk = { ticker: '00700.HK', currency: 'HKD', source: 'Tencent', valuationAsOf: '2026-10-14', valuationStatus: 'available', valuationSource: 'Example HK provider', peTtm: 18.4, pb: 3.2 };
  renderQuote(quote(hk));
  assert.equal(metrics.children[1].querySelector('strong').textContent, '18.40');
  assert.equal(metrics.children[2].querySelector('strong').textContent, '3.20');
  for (const card of metrics.children.slice(1, 3)) {
    assert.equal(card.querySelector('p').textContent, '估值日 2026-10-14');
    assert.match(card.attributes.get('title'), /Example HK provider/); assert.equal(card.querySelector('.valuation-source'), null);
    assert.doesNotMatch(card.textContent, /Tushare|未接入|2026-10-13/);
  }
  renderQuote(quote({ ...hk, peTtm: null, pb: 3.2, valuationStatus: 'loss_or_unavailable' }));
  assert.equal(metrics.children[1].querySelector('strong').textContent, '—');
  assert.match(metrics.children[1].querySelector('p').textContent, /^暂无有效PE.*2026-10-14/);
  assert.equal(metrics.children[2].querySelector('strong').textContent, '3.20');
  for (const peTtm of [0, -2, Number.NaN, Infinity, '18.4']) {
    renderQuote(quote({ ...hk, peTtm }));
    assert.equal(metrics.children[1].querySelector('strong').textContent, peTtm === -2 ? '亏损' : '—');
    assert.match(metrics.children[1].querySelector('p').textContent, /2026-10-14/);
  }
  renderQuote(quote(hk));
  assert.equal(metrics.children[1].querySelector('strong').textContent, '18.40');
  assert.equal(metrics.children[1].querySelector('strong').className, '');
  renderQuote(quote({ ...hk, peTtm: null, pb: null, valuationAsOf: null, valuationStatus: 'missing', valuationSource: null }));
  for (const [index, card] of metrics.children.slice(1, 3).entries()) {
    assert.equal(card.querySelector('strong').textContent, '—');
    assert.equal(card.querySelector('.valuation-source'), null); assert.equal(card.attributes.get('title'), '估值来源未取得');
    assert.doesNotMatch(card.textContent, /18\.40|3\.20|2026-10-14|Tushare|Example/);
  }
});

test('缺失估值不冒充亏损，只有明确负PE或亏损标志显示亏损，PB保持独立', t => {
  const { metrics } = fixture(t);
  for (const peTtm of [null, 0, Number.NaN, Infinity]) {
    renderQuote(quote({ peTtm, pb: 2.94, valuationAsOf: '2026-10-13', valuationStatus: 'loss_or_unavailable' }));
    assert.equal(metrics.children[1].querySelector('strong').textContent, '—');
    assert.equal(metrics.children[1].querySelector('strong').className, '');
    assert.match(metrics.children[1].querySelector('p').textContent, /^暂无有效PE.*2026-10-13/);
    assert.equal(metrics.children[2].querySelector('strong').textContent, '2.94');
  }
  renderQuote(quote({ peTtm: 20, pb: null, valuationAsOf: '2026-10-13', valuationStatus: 'available' }));
  assert.equal(metrics.children[1].querySelector('strong').textContent, '20.00');
  assert.equal(metrics.children[2].querySelector('strong').textContent, '—'); assert.match(metrics.children[2].querySelector('p').textContent, /^暂无有效PB/);
  renderQuote(quote({ peTtm: 0, pb: -2.1, valuationAsOf: '2026-10-13', valuationStatus: 'available' }));
  assert.equal(metrics.children[1].querySelector('strong').textContent, '—');
  assert.equal(metrics.children[2].querySelector('strong').textContent, '-2.10');
  for (const explicitLoss of [{ peTtm: -12.3, valuationStatus: 'available' }, { peTtm: null, valuationStatus: 'loss' }]) {
    renderQuote(quote({ ...explicitLoss, pb: 0.8, valuationAsOf: '2026-10-13' }));
    assert.equal(metrics.children[1].querySelector('strong').textContent, '亏损');
    assert.equal(metrics.children[1].querySelector('strong').className, 'valuation-loss');
  }
  for (const missing of [null, quote(), quote({ ticker: '00001.HK', currency: 'HKD', source: 'Tencent' })]) {
    renderQuote(missing);
    for (const card of metrics.children.slice(1, 3)) {
      assert.equal(card.querySelector('strong').textContent, '—');
      assert.equal(card.querySelector('p').textContent, '估值暂无数据');
      assert.doesNotMatch(card.textContent, /亏损|0\.00/);
    }
  }
});

test('日K按OHLC绘制实体与影线，坐标覆盖极端高低价，红绿平盘与成交量同色', t => {
  const { area } = fixture(t), data = prices();
  data.points[0].high = 120; data.points[0].low = 50;
  data.points[2].open = data.points[2].close;
  renderPrices(data);
  const all = descendants(area), svg = all.find(item => item.tagName === 'SVG');
  const candles = all.filter(item => item.className.startsWith('market-candle '));
  const bars = all.filter(item => item.className.startsWith('market-volume-bar '));
  assert.equal(candles.length, 3); assert.equal(bars.length, 3);
  const tones = ['market-up', 'market-down', 'market-flat'];
  candles.forEach((candle, index) => {
    assert.equal(candle.className, `market-candle ${tones[index]}`);
    assert.equal(bars[index].className, `market-volume-bar ${tones[index]}`);
    const wick = candle.children.find(item => item.className === 'market-candle-wick');
    const body = candle.children.find(item => item.className === 'market-candle-body');
    assert.equal(wick.tagName, 'LINE'); assert.equal(body.tagName, 'RECT');
    assert.ok(Number(wick.attributes.get('y1')) >= 32); assert.ok(Number(wick.attributes.get('y2')) <= 292);
    assert.ok(Number(wick.attributes.get('y1')) <= Number(wick.attributes.get('y2')));
    assert.ok(Number(body.attributes.get('height')) >= 1);
  });
  const summary = descendants(area).find(item => item.className === 'market-chart-summary');
  assert.match(summary.textContent, /最新收盘价87.24元2026-10-13/);
  assert.match(summary.textContent, /行业指数点位—/); assert.match(summary.textContent, /暂无可比数据/);
  assert.doesNotMatch(summary.textContent, /最高|最低/);
  assert.equal(descendants(svg).some(item => item.tagName === 'PATH' || item.tagName === 'LINEARGRADIENT'), false);
  assert.match(svg.attributes.get('aria-label'), /未复权日K线/);
  assert.match(document.getElementById('price-caption').textContent, /未复权日 K 线/);
});

test('缺少OHLC不编造K线，非法高低关系与非有限数据被跳过并说明', t => {
  const { metrics, area } = fixture(t); renderQuote(quote({ price: Number.NaN, peTtm: Infinity, pb: -Infinity }));
  assert.equal(metrics.children[0].querySelector('strong').textContent, '—'); assert.equal(metrics.children[1].querySelector('strong').textContent, '—');
  renderPrices([{ date: '2026-10-13', value: 10 }]);
  assert.equal(descendants(area).some(item => item.tagName === 'SVG'), false);
  assert.match(document.getElementById('price-caption').textContent, /缺少完整有效.*OHLC/);
  const invalid = [
    { ...prices().points[0], date: 'bad-date' },
    { ...prices().points[0], high: 84 },
    { ...prices().points[0], low: 85.5 },
    { ...prices().points[0], open: NaN },
    { ...prices().points[0], close: Infinity },
    { ...prices().points[0], low: -1 },
    { ...prices().points[0], open: '84' },
  ];
  renderPrices({ points: invalid, meta: {} }); assert.equal(descendants(area).some(item => item.tagName === 'SVG'), false);
  renderPrices({ points: [prices().points[2], ...invalid], meta: {} });
  assert.ok(descendants(area).some(item => item.tagName === 'SVG'));
  assert.match(document.getElementById('price-caption').textContent, /已跳过 7 条/);
});

test('单根平盘与恒定OHLC日K保持可见有限坐标，旧数组仅接受真实OHLC', t => {
  const { area } = fixture(t);
  const checkFinite = () => {
    const svg = descendants(area).find(item => item.tagName === 'SVG'); assert.ok(svg);
    for (const item of descendants(svg)) for (const value of item.attributes.values()) assert.doesNotMatch(value, /NaN|Infinity|undefined/);
  };
  renderPrices([{ date: '2026-10-13', value: 10, open: 10, high: 10, low: 10 }]); checkFinite();
  assert.match(document.getElementById('price-caption').textContent, /1 个交易日/);
  renderPrices({ points: [{ date: '2026-10-12', open: 0, close: 0, high: 0, low: 0 }, { date: '2026-10-13', open: 0, close: 0, high: 0, low: 0 }], meta: {} }); checkFinite();
  renderPrices({ points: [{ date: '2026-10-13', open: Number.MAX_VALUE, close: Number.MAX_VALUE, high: Number.MAX_VALUE, low: Number.MAX_VALUE, volume: Number.MAX_VALUE }], meta: {} }); checkFinite();
});

const industryPrices = () => {
  const data = prices();
  data.meta = { ...data.meta, adjustment: 'qfq', adjustmentStatus: 'available', adjustmentAnchorDate: '2026-10-13', adjustmentAnchorFactor: 2, missingFactorCount: 0 };
  data.benchmark = { status: 'available', system: 'SW2021', level: 3, membershipBasis: 'latest', membershipFetchedAt: '2026-10-14T01:00:00Z',
    indexCode: '850881.SI', industryName: '汽车电子', baseDate: '2026-10-09', baseStockClose: 85, baseIndexClose: 1000,
    points: data.points.map((point, index) => ({ date: point.date, close: [1000, null, 3000][index], scaledClose: [85, null, 255][index] })) };
  return data;
};

test('前复权标题和图例标明申万2021三级、最新归属及基准日，行业缺日断线且轴不裁极值', t => {
  const { area, footer } = fixture(t); renderPrices(industryPrices());
  const all = descendants(area), svg = all.find(item => item.tagName === 'SVG');
  assert.match(document.getElementById('market-title').textContent, /前复权日 K 线与行业指数/);
  assert.match(svg.attributes.get('aria-label'), /前复权日K线.*申万三级/);
  assert.doesNotMatch(svg.textContent + footer.textContent + document.getElementById('price-caption').textContent, /未复权/);
  assert.match(area.textContent, /申万 2021 三级 · 汽车电子 \(850881.SI\)/);
  assert.match(area.textContent, /最新行业归属.*采集于 2026-10-14/);
  assert.match(area.textContent, /共同基准日 2026-10-09 · 指数按共同起点缩放/);
  const legend = all.find(item => item.className === 'market-benchmark-legend'), details = all.find(item => item.className === 'market-chart-details');
  assert.equal(legend.textContent, '汽车电子申万三级行业对照');
  assert.doesNotMatch(legend.textContent, /采集于|共同基准日|850881/);
  assert.equal(details.tagName, 'DETAILS'); assert.equal(details.attributes.has('open'), false);
  assert.match(details.textContent, /共同基准日/); assert.match(details.textContent, /Home \/ End/);
  const summary = all.find(item => item.className === 'market-chart-summary');
  assert.match(summary.textContent, /最新收盘价87.24元2026-10-13/);
  assert.match(summary.textContent, /行业指数点位3,000.00点2026-10-13/);
  assert.match(summary.textContent, /跑输指数197.36个百分点/);
  assert.match(summary.textContent, /1M · 2026-10-09 — 10-13/);
  const paths = all.filter(item => item.className === 'market-benchmark-line');
  assert.equal(paths.length, 2);
  assert.equal(paths.every(item => !item.attributes.get('d').includes('L')), true, '缺日两侧的孤立点不能连线');
  for (const path of paths) {
    const coordinate = path.attributes.get('d').split(' ').map(Number).at(-1);
    assert.ok(coordinate >= 32 && coordinate <= 292, '高于股票最高价的缩放指数仍在坐标范围内');
  }
  assert.equal(all.filter(item => item.className.startsWith('market-candle ')).length, 3);
  assert.equal(all.filter(item => item.className.startsWith('market-volume-bar ')).length, 3);
  assert.match(document.getElementById('price-caption').textContent, /前复权锚点 2026-10-13.*成交量和成交额为原始值/);
});

test('行业开关只隐藏行业组且保留股票坐标，键盘与悬停展示实际指数点数和缺日', t => {
  const { area } = fixture(t); renderPrices(industryPrices());
  const all = descendants(area), svg = all.find(item => item.tagName === 'SVG'), toggle = all.find(item => item.tagName === 'INPUT');
  const series = all.find(item => item.className === 'market-benchmark-series'), inspection = all.find(item => item.className.startsWith('market-inspection'));
  const candles = all.filter(item => item.className.startsWith('market-candle ')), original = candles.map(item => item.children.map(child => [...child.attributes]));
  assert.equal(toggle.checked, true); assert.equal(series.attributes.get('visibility'), 'visible');
  assert.match(inspection.textContent, /行业指数3,000.00 点/);
  svg.listeners.get('keydown')({ key: 'Home', preventDefault() {} }); assert.match(inspection.textContent, /行业指数1,000.00 点/);
  svg.listeners.get('keydown')({ key: 'ArrowRight', preventDefault() {} }); assert.match(inspection.textContent, /行业指数当日数据缺失/);
  assert.doesNotMatch(inspection.textContent, /行业指数0.00/);
  svg.listeners.get('pointermove')({ clientX: 1080 }); assert.match(inspection.textContent, /行业指数3,000.00 点/);
  toggle.checked = false; toggle.listeners.get('change')();
  assert.equal(series.attributes.get('visibility'), 'hidden'); assert.equal(series.attributes.get('aria-hidden'), 'true');
  assert.equal(descendants(area).find(item => item.tagName === 'SVG'), svg);
  assert.deepEqual(candles.map(item => item.children.map(child => [...child.attributes])), original);
  toggle.checked = true; toggle.listeners.get('change')(); assert.equal(series.attributes.get('visibility'), 'visible');
  renderPrices(null, { adjustment: 'qfq' });
  assert.equal(svg.listeners.size, 0); assert.equal(toggle.listeners.size, 0); assert.doesNotMatch(area.textContent, /汽车电子|3,000/);
});

test('二级回退展示实际指数层级，原三级归属只在悬停和折叠说明中，切回三级清除回退提示', t => {
  const { area } = fixture(t), data = industryPrices();
  data.benchmark = { ...data.benchmark, level: 2, indexCode: '801095.SI', industryName: '乘用车', fallbackReason: 'unpublished',
    classification: { l3Code: '850951.SI', l3Name: '电动乘用车', l2Code: '801095.SI', l2Name: '乘用车' } };
  renderPrices(data);
  let all = descendants(area);
  const legend = all.find(item => item.className === 'market-benchmark-legend');
  assert.match(legend.textContent, /乘用车申万二级/);
  assert.match(legend.textContent, /三级无可用行情，使用所属二级/);
  assert.doesNotMatch(legend.textContent, /电动乘用车|未发布指数/);
  assert.match(all.find(item => item.className === 'market-benchmark-identity').attributes.get('title'), /三级归属：电动乘用车/);
  assert.match(all.find(item => item.className === 'market-chart-details').textContent, /申万 2021 二级 · 乘用车 \(801095.SI\)/);
  assert.match(all.find(item => item.className === 'market-chart-details').textContent, /股票三级归属：电动乘用车 \(850951.SI\)/);
  assert.equal(all.find(item => item.className === 'market-chart-details').attributes.has('open'), false);
  assert.match(all.find(item => item.tagName === 'SVG').attributes.get('aria-label'), /申万二级行业指数/);
  assert.equal(all.find(item => item.tagName === 'INPUT').attributes.get('aria-label'), '显示申万二级行业指数');
  assert.match(all.find(item => item.className === 'market-chart-summary').textContent, /跑输指数197.36个百分点/);
  data.benchmark.fallbackReason = 'missing_classification'; renderPrices(data);
  assert.match(area.textContent, /三级归属缺失，使用所属二级/);
  assert.doesNotMatch(area.textContent, /未发布指数/);
  renderPrices(industryPrices()); all = descendants(area);
  assert.match(all.find(item => item.className === 'market-benchmark-legend').textContent, /汽车电子申万三级/);
  assert.doesNotMatch(area.textContent, /使用所属二级|电动乘用车|801095/);
});

test('二级也不可用时展示实际失败原因，不显示回退成功或零相对收益', t => {
  const { area } = fixture(t), data = industryPrices();
  data.benchmark = { ...data.benchmark, level: 2, indexCode: '801095.SI', industryName: '乘用车', status: 'missing_prices', fallbackReason: 'unpublished',
    baseDate: null, baseStockClose: null, baseIndexClose: null,
    points: data.points.map(point => ({ date: point.date, close: null, scaledClose: null })) };
  renderPrices(data);
  assert.match(area.textContent, /申万二级行业指数日线尚未入库/);
  assert.doesNotMatch(area.textContent, /三级行业未发布|使用所属二级|跑赢指数|跑输指数|与指数持平/);
  const all = descendants(area);
  assert.match(all.find(item => item.className === 'market-chart-summary').textContent, /区间相对表现—/);
  assert.equal(all.some(item => item.className === 'market-benchmark-line' || item.tagName === 'INPUT'), false);
});

test('缺少行业目录元数据明确提示分类资料缺失，不误显示未发布或回退成功', t => {
  const { area } = fixture(t), data = industryPrices();
  data.benchmark = { ...data.benchmark, level: 2, indexCode: '801095.SI', industryName: '乘用车', status: 'missing_classification',
    fallbackReason: 'missing_classification', classification: { l3Code: '850951.SI', l3Name: '电动乘用车', l2Code: '801095.SI', l2Name: '乘用车' },
    baseDate: null, baseStockClose: null, baseIndexClose: null, latest: null,
    points: data.points.map(point => ({ date: point.date, close: null, scaledClose: null })) };
  renderPrices(data);
  assert.match(area.textContent, /申万行业分类资料缺失/);
  assert.doesNotMatch(area.textContent, /未发布指数|使用所属二级|跑赢指数|跑输指数|与指数持平/);
  assert.equal(descendants(area).filter(item => item.className.startsWith('market-candle ')).length, 3);
  assert.match(descendants(area).find(item => item.className === 'market-chart-summary').textContent, /区间相对表现—/);
});

test('行业归属缺失、冲突、未发布、行情缺失及无共同日期都有原因且保留股票K线', t => {
  const { area } = fixture(t);
  for (const [status, reason] of [['unmapped', /尚无.*行业归属/], ['ambiguous_membership', /行业归属存在冲突/], ['unpublished', /未发布指数/], ['missing_prices', /指数日线尚未入库/], ['no_common_date', /没有共同有效交易日/]]) {
    const data = industryPrices(); data.benchmark.status = status;
    data.benchmark.points = data.points.map(point => ({ date: point.date, close: null, scaledClose: null }));
    renderPrices(data);
    assert.match(area.textContent, reason);
    assert.equal(descendants(area).filter(item => item.className.startsWith('market-candle ')).length, 3);
    assert.equal(descendants(area).some(item => item.className === 'market-benchmark-line' || item.tagName === 'INPUT'), false);
    assert.doesNotMatch(area.textContent, /二级/);
  }
});

test('缺少前复权锚点或日因子会在空态与部分数据中展示原因而不回退价格口径', t => {
  const { area, footer } = fixture(t), data = industryPrices();
  data.points = []; data.meta.adjustmentStatus = 'missing_anchor_factor'; data.meta.missingFactorCount = 3;
  data.benchmark = null; renderPrices(data);
  assert.match(area.textContent, /前复权锚点（2026-10-13）缺少有效复权因子/);
  assert.equal(descendants(area).some(item => item.tagName === 'SVG'), false); assert.match(footer.textContent, /前复权/);
  const partial = industryPrices(); partial.meta.adjustmentStatus = 'partial'; partial.meta.missingFactorCount = 2; renderPrices(partial);
  assert.match(document.getElementById('price-caption').textContent, /缺少 2 个交易日.*已略去对应日线/);
  assert.equal(descendants(area).filter(item => item.className.startsWith('market-candle ')).length, 3);
  partial.points = []; partial.benchmark = null; renderPrices(partial);
  assert.match(document.getElementById('price-caption').textContent, /缺少 2 个交易日/);
});


test('港股恒生指数叠加与跑赢跑输使用共同起止日，不展示申万归属', t => {
  const { area, footer } = fixture(t, '00700.HK');
  const data = prices(); data.ticker = '00700.HK';
  data.meta = { ...data.meta, currency: 'HKD', source: 'Tencent', volumeUnit: '股', amountUnit: '港元', adjustment: 'none' };
  data.benchmark = { status: 'available', system: 'HSI', level: null, membershipBasis: 'index', membershipFetchedAt: null,
    indexCode: 'HSI', industryName: '恒生指数', baseDate: data.points[0].date, baseStockClose: 85, baseIndexClose: 25000,
    latest: { date: '2026-10-14', close: 27000 },
    points: data.points.map((point, index) => ({ date: point.date, close: 25000 + index * 500, scaledClose: 85 * (25000 + index * 500) / 25000 })) };
  renderPrices(data);
  assert.match(document.getElementById('market-title').textContent, /恒生指数/);
  assert.match(area.textContent, /恒生指数点位27,000.00/);
  assert.match(area.textContent, /跑输指数1.36/);
  assert.match(area.textContent, /指数对照/);
  assert.doesNotMatch(area.textContent, /申万|行业归属|采集时间未提供/);
  assert.match(footer.textContent, /恒生指数/);
  assert.equal(area.querySelector('.market-benchmark-toggle').querySelector('input').attributes.get('aria-label'), '显示恒生指数');
});
