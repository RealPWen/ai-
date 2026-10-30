import { summarizeMarketComparison } from '../features/market-comparison.js';
import { cleanupValuationBands, renderValuationBands } from '../features/valuation-bands.js';
export { cleanupValuationBands };

// Rendering only: no network access or backend paths; market values retain source units.
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

const marketCurrencies = new Map();
function renderMarketSource(hongKong, source = hongKong ? 'Tencent' : 'Tushare', valuationSource = '', currency = hongKong ? 'HKD' : 'CNY') {
  const row = document.getElementById('market-source'); if (!row) return;
  row.querySelector('strong').textContent = `${source} · ${hongKong ? '港股行情' : 'A 股行情与估值'}`;
  row.querySelector('p').textContent = `${hongKong ? `${currency} · 未复权 · 成交量：股 · 成交额：${currency === 'USD' ? '美元' : '港元'}` : 'CNY · 前复权 · 成交量：手 · 成交额：千元'} · 估值来源：${valuationSource || (hongKong ? '未取得' : 'Tushare daily_basic')}`;
  row.querySelector('span').textContent = hongKong && !valuationSource ? '日线已接入 · 估值暂无数据' : '日线 / 估值已接入';
}

export function renderProfile(profile) {
  if (!profile) return;
  const name = profile.name || profile.ticker || '股票资料';
  const ticker = profile.ticker || '';
  if (profile.currency) marketCurrencies.set(ticker, profile.currency);
  // A late reference-profile response must not overwrite the actual price
  // source already supplied by the quote for the same selected security.
  if (document.getElementById('current-company-ticker')?.textContent?.trim() !== ticker) renderMarketSource(ticker.endsWith('.HK'), undefined, '', profile.currency);
  const heading = document.querySelector('.hero-copy h1');
  heading.replaceChildren(document.createTextNode(`${name} `), node('span', '', ticker));
  document.title = `${name} · 公司投研看板`;
  document.getElementById('current-company-name').textContent = name;
  document.getElementById('current-company-ticker').textContent = ticker;
  document.getElementById('current-company-market').textContent = /\.(SH|SZ|BJ)$/.test(ticker) ? 'A 股' : ticker.endsWith('.HK') ? '港股' : '其他市场';
  document.getElementById('company-switch').setAttribute('aria-label', `切换研究标的，当前为 ${name} ${ticker}`);
  document.querySelector('.company-avatar').textContent = Array.from(name)[0];
  document.getElementById('breadcrumb-company').textContent = name;
  document.getElementById('footer-company').textContent = `${name} · 公司投研看板`;
  const description = document.querySelector('.hero-description');
  const brief = (profile.description || '').replace(/公司(?:业务)?简介待(?:补充|接入)。?/g, '').trim();
  description.textContent = brief;
  description.hidden = !brief || /^行业分类[:：]/.test(brief);
  document.querySelector('.business-tags').replaceChildren(...(profile.businesses || []).map(text => node('span', '', text)));
  const link = document.querySelector('.hero-copy .source-inline');
  const url = safeSourceUrl(profile.sourceUrl);
  if (url) { link.href = url; link.hidden = false; } else { link.removeAttribute('href'); link.hidden = true; }
  const source = document.getElementById('profile-source');
  const summary = node('div'); summary.append(node('strong', '', `${name} · 公司资料`), node('p', '', url ? '公司资料原文' : '业务资料来源未取得'));
  source.replaceChildren(summary, url ? sourceLink('查看原文', url) : node('span', '', '待接入'));
  const announcement = document.querySelector('.event-bottom a');
  announcement.hidden = !/\.(SZ|SH|BJ|HK)$/.test(ticker);
  announcement.href = ticker.endsWith('.HK') ? 'https://www.hkexnews.hk/' : 'https://www.cninfo.com.cn/';
  announcement.textContent = ticker.endsWith('.HK') ? '查看港交所公告 ↗' : '查看巨潮公告 ↗';
}

// Snapshot only data containers, preserving controls and their event listeners.
export function createModuleReset() {
  cleanupValuationBands();
  const selectors = ['.metrics', '.forecast-metric', '.chart-empty', '.chart-footer', '.debate-grid', '#debates .status-pill', '#valuation tbody', '#valuation .status-pill', '#forecast-summary', '#forecast-sample-details', '.band-grid', '.events-empty', '#events .status-pill'];
  const snapshots = selectors.map(selector => {
    const target = document.querySelector(selector);
    return target ? { target, children: [...target.childNodes].map(child => child.cloneNode(true)), className: target.className } : null;
  }).filter(Boolean);
  return () => {
    clearMarketChart(document.querySelector('.chart-empty'));
    cleanupValuationBands();
    document.querySelectorAll('[data-module-status]').forEach(item => item.remove());
    snapshots.forEach(({ target, children, className }) => { target.className = className; target.replaceChildren(...children.map(child => child.cloneNode(true))); });
  };
}

const moduleTargets = { profile: '#overview', quote: '.metrics', prices: '.price-panel', debates: '#debates', forecasts: '#valuation', bands: '.band-grid', events: '#events' };
export function renderModuleStatus(module, status, message = '') {
  // This module owns its loading, coverage and error states inside the panel.
  if (module === 'relations') return;
  let feedback = document.querySelector(`[data-module-status="${module}"]`);
  if (!feedback) {
    feedback = node('div', 'module-feedback'); feedback.dataset.moduleStatus = module; feedback.setAttribute('role', 'status');
    const target = document.querySelector(moduleTargets[module]);
    if (module === 'prices') target.querySelector('.panel-heading').after(feedback);
    else if (['debates', 'forecasts', 'events'].includes(module)) target.querySelector('.section-heading').after(feedback);
    else target.before(feedback);
  }
  feedback.hidden = status === 'ready' || status === 'not_configured' || (module === 'bands' && status === 'empty');
  feedback.classList.toggle('error', status === 'error');
  feedback.textContent = status === 'loading' ? module === 'debates' ? '正在读取研究结果…' : '正在获取数据…' : status === 'generating' ? '正在生成观点…（最长 6 分钟）' : status === 'cancelled' ? '已取消等待，可稍后读取结果。' : status === 'empty' ? module === 'debates' ? '暂无已保存的研究结果。' : '暂无数据。' : status === 'error' ? `获取失败：${message}。` : '';
}

const isFiniteMarketNumber = value => typeof value === 'number' && Number.isFinite(value);
const marketNumber = (value, digits = 2) => isFiniteMarketNumber(value) ? value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const marketPrice = (value, hongKong) => hongKong && isFiniteMarketNumber(value)
  ? value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) : marketNumber(value);
const marketAxisNumber = (value, hongKong, step) => {
  const magnitude = Math.abs(value);
  if (hongKong && magnitude < 10000) {
    const digits = Math.min(6, Math.max(3, step > 0 ? 1 - Math.floor(Math.log10(step)) : 3));
    return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: digits });
  }
  if (magnitude >= 1e9 || (magnitude > 0 && magnitude < 0.01)) return value.toExponential(1).replace('e+', 'e');
  if (magnitude >= 1e8) return `${(value / 1e8).toLocaleString('zh-CN', { maximumSignificantDigits: 3, useGrouping: false })}亿`;
  if (magnitude >= 10000) return `${(value / 10000).toLocaleString('zh-CN', { maximumSignificantDigits: 3, useGrouping: false })}万`;
  return marketNumber(value, magnitude >= 1000 ? 0 : 2);
};
const marketVolume = value => isFiniteMarketNumber(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
const marketDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : '';
const marketTone = value => !isFiniteMarketNumber(value) || value === 0 ? 'market-flat' : value > 0 ? 'market-up' : 'market-down';
const signedMarketNumber = value => !isFiniteMarketNumber(value) ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${marketNumber(Math.abs(value))}`;
const signedMarketPrice = (value, hongKong) => !isFiniteMarketNumber(value) ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${marketPrice(Math.abs(value), hongKong)}`;
const currentMarketTicker = () => document.getElementById('current-company-ticker')?.textContent?.trim() || '';
function marketEmptyText(ticker = currentMarketTicker()) {
  return String(ticker || currentMarketTicker()).endsWith('.HK') ? '当前港股与研究截止日期下没有可展示的日线记录。' : '当前 A 股与研究截止日期下没有可展示的日线记录。';
}

export function renderQuote(quote) {
  const metrics = document.querySelectorAll('.metrics .metric');
  const hongKong = String(quote?.ticker || currentMarketTicker()).endsWith('.HK');
  const ticker = quote?.ticker || currentMarketTicker();
  if (quote?.currency) marketCurrencies.set(ticker, quote.currency);
  const currency = quote?.currency || marketCurrencies.get(ticker) || (hongKong ? 'HKD' : 'CNY');
  renderMarketSource(hongKong, quote?.source || (hongKong ? 'Tencent' : 'Tushare'), quote?.valuationSource, currency);
  const available = quote && isFiniteMarketNumber(quote.price) && quote.price > 0;
  const tone = marketTone(quote?.pctChange ?? quote?.change);
  const price = metrics[0].querySelector('strong'); price.textContent = available ? marketPrice(quote.price, hongKong) : '—'; price.className = available ? tone : 'market-flat';
  metrics[0].querySelector('small').textContent = currency;
  const change = metrics[0].querySelector('p'); change.className = `quote-change ${available ? tone : 'market-flat'}`;
  change.textContent = available ? `${signedMarketPrice(quote.change, hongKong)} (${signedMarketNumber(quote.pctChange)}%)` : marketEmptyText(quote?.ticker);
  let date = metrics[0].querySelector('.quote-trade-date');
  if (!date) { date = node('span', 'quote-trade-date'); metrics[0].append(date); }
  date.textContent = available ? `${marketDate(quote.asOf) || '交易日期未提供'} 收盘` : '日线 · 非实时';
  date.setAttribute('title', `日线 · 非实时${marketDate(quote?.requestedAsOf) ? ` · 研究截止 ${quote.requestedAsOf}` : ''}`);
  const valuationDate = marketDate(quote?.valuationAsOf);
  const valuationMissing = !quote || quote.valuationStatus === 'missing' || (!valuationDate && quote.peTtm == null && quote.pb == null);
  [quote?.peTtm, quote?.pb].forEach((value, index) => {
    const card = metrics[index + 1], valid = !valuationMissing && isFiniteMarketNumber(value) && (index !== 0 || value > 0);
    const loss = index === 0 && !valuationMissing && ((isFiniteMarketNumber(value) && value < 0) || quote?.valuationStatus === 'loss');
    const primary = card.querySelector('strong');
    primary.textContent = valid ? marketNumber(value) : loss ? '亏损' : '—';
    primary.classList[loss ? 'add' : 'remove']('valuation-loss');
    card.querySelector('p').textContent = loss ? valuationDate ? `估值日 ${valuationDate}` : '' : valid ? `估值日 ${valuationDate || '未提供'}` : valuationMissing ? '估值暂无数据' : index === 0 ? '暂无有效PE' : '暂无有效PB';
    if (!valid && !loss && valuationDate) card.querySelector('p').append(node('span', '', ` · ${valuationDate}`));
    card.querySelector('.valuation-source')?.remove();
    card.setAttribute('title', `${valuationDate ? `估值日 ${valuationDate} · ` : ''}${quote?.valuationSource || (hongKong ? '估值来源未取得' : 'Tushare daily_basic')}`);
  });
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

const marketChartCleanups = new WeakMap();
const marketBenchmarkVisibility = new WeakMap();
function clearMarketChart(area) {
  marketChartCleanups.get(area)?.(); marketChartCleanups.delete(area);
}
const svgNode = (tag, attributes = {}, text = '') => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  if (text) element.textContent = text; return element;
};
function cleanMarketPoints(raw, { hongKong = false } = {}) {
  const byDate = new Map();
  (Array.isArray(raw) ? raw : []).forEach(point => {
    const date = marketDate(point?.date), close = point?.close ?? point?.value;
    const ohlc = [point?.open, point?.high, point?.low, close];
    if (!date || !ohlc.every(value => isFiniteMarketNumber(value) && value >= 0)) return;
    const [open, high, low] = ohlc;
    if (high < low || (!hongKong && (high < Math.max(open, close) || low > Math.min(open, close)))) return;
    const clean = { date, open, high, low, close };
    ['volume', 'amount'].forEach(key => { clean[key] = isFiniteMarketNumber(point[key]) && point[key] >= 0 ? point[key] : null; });
    byDate.set(date, clean);
  });
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}
function marketStat(label, value, className = '') {
  const item = node('div', `market-stat ${className}`); item.append(node('span', '', label), node('strong', '', value)); return item;
}
function compactMarketVolume(value, unit = '手') {
  return isFiniteMarketNumber(value) ? value >= 10000 ? `${marketNumber(value / 10000)} 万${unit}` : `${marketVolume(value)} ${unit}` : '—';
}
function compactMarketAmount(value, unit = '千元') {
  if (!isFiniteMarketNumber(value)) return ['港元', '美元'].includes(unit) ? '暂无' : '—';
  if (['港元', '美元'].includes(unit)) return value >= 100000000 ? `${marketNumber(value / 100000000)} 亿${unit}` : value >= 10000 ? `${marketNumber(value / 10000)} 万${unit}` : `${marketNumber(value)} ${unit}`;
  return value >= 100000 ? `${marketNumber(value / 100000)} 亿元` : value >= 10 ? `${marketNumber(value / 10)} 万元` : `${marketNumber(value, 1)} 千元`;
}
const benchmarkStatusText = {
  unmapped: '当前股票尚无可用的申万行业归属，行业指数暂无法叠加。',
  missing_classification: '当前股票的申万行业分类资料缺失，行业指数暂无法叠加。',
  ambiguous_membership: '最新行业归属存在冲突，行业指数暂无法叠加。',
  no_common_date: '区间内股票与行业指数没有共同有效交易日，行业指数暂无法叠加。',
};
const benchmarkLevelName = benchmark => benchmark?.level === 2 ? '二级' : '三级';
const benchmarkDisplayName = benchmark => benchmark?.system === 'HSI' ? '恒生指数' : `申万${benchmarkLevelName(benchmark)}行业指数`;
function benchmarkFallbackText(benchmark) {
  if (benchmark?.fallbackReason === 'missing_classification') return '三级归属缺失，使用所属二级。';
  if (benchmark?.fallbackReason === 'ambiguous_membership') return '三级归属存在冲突，使用唯一所属二级。';
  return '三级无可用行情，使用所属二级。';
}
function benchmarkUnavailableText(benchmark) {
  if (benchmark.system === 'HSI') return benchmark.status === 'no_common_date' ? '区间内股票与恒生指数没有共同有效交易日，暂无法比较。' : '恒生指数日线尚未齐备，暂无法叠加。';
  const level = benchmarkLevelName(benchmark);
  if (benchmark.status === 'unpublished') return `对应申万${level}行业未发布指数，行业指数暂无法叠加。`;
  if (benchmark.status === 'missing_prices') return `对应申万${level}行业指数日线尚未入库，行业指数暂无法叠加。`;
  return benchmarkStatusText[benchmark.status] || '行业指数暂不可用。';
}
function benchmarkLegend(benchmark) {
  if (!benchmark) return null;
  const legend = node('div', 'market-benchmark-legend');
  const identity = node('div', 'market-benchmark-identity');
  const level = benchmarkLevelName(benchmark);
  identity.append(node('span', 'market-benchmark-swatch'), node('strong', '', benchmark.industryName || '行业指数'), node('span', 'market-benchmark-label', benchmark.system === 'HSI' ? '港股基准' : `申万${level}`));
  const classification = benchmark.classification;
  identity.setAttribute('title', [benchmark.system === 'HSI' ? '恒生指数' : `申万 2021 ${level}`, benchmark.industryName, benchmark.indexCode, benchmark.level === 2 && classification?.l3Name ? `三级归属：${classification.l3Name}` : null].filter(Boolean).join(' · '));
  legend.append(identity);
  if (benchmark.status !== 'available') legend.append(node('p', 'market-benchmark-status', benchmarkUnavailableText(benchmark)));
  else if (benchmark.level === 2) legend.append(node('p', 'market-benchmark-status', benchmarkFallbackText(benchmark)));
  return legend;
}
function marketChartDetails(benchmark, comparison, currency = 'CNY') {
  const details = node('details', 'market-chart-details'), summary = node('summary', '', '数据说明');
  details.hidden = true;
  const body = node('div', 'market-chart-details-body');
  if (benchmark) {
    body.append(node('p', '', `${benchmark.system === 'HSI' ? '恒生指数' : `申万 2021 ${benchmarkLevelName(benchmark)}`}${benchmark.industryName && benchmark.system !== 'HSI' ? ` · ${benchmark.industryName}` : ''}${benchmark.indexCode ? ` (${benchmark.indexCode})` : ''}`));
    if (benchmark.level === 2 && benchmark.classification?.l3Name) body.append(node('p', '', `股票三级归属：${benchmark.classification.l3Name}${benchmark.classification.l3Code ? ` (${benchmark.classification.l3Code})` : ''}。`));
    const fetchedDate = benchmark.membershipFetchedAt ? new Date(benchmark.membershipFetchedAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '';
    if (benchmark.system !== 'HSI') body.append(node('p', '', `最新行业归属${fetchedDate ? ` · 采集于 ${fetchedDate}` : ' · 采集时间未提供'}；历史研究日期沿用最新归属。`));
    if (benchmark.status === 'available') body.append(node('p', '', `共同基准日 ${benchmark.baseDate} · 指数按共同起点缩放 · 股票 ${marketNumber(benchmark.baseStockClose)} ${currency === 'CNY' ? '元' : currency} / ${benchmark.system === 'HSI' ? '恒生指数' : '行业'} ${marketNumber(benchmark.baseIndexClose)} 点`));
  }
  if (comparison?.performance) {
    const { from, to, stockReturn, indexReturn, excessPercentagePoints } = comparison.performance;
    body.append(node('p', '', `${from} — ${to}：股票涨跌幅 ${marketNumber(stockReturn * 100)}%，指数涨跌幅 ${marketNumber(indexReturn * 100)}%；相对表现 ${marketNumber(excessPercentagePoints)} 个百分点（股票涨跌幅减指数涨跌幅，首末日一致）。`));
  }
  body.append(node('p', 'market-interaction-guide', '悬停查看交易日；聚焦图表后按 ← → 选择，Home / End 跳至首末日。'));
  details.append(summary, body); return details;
}
function adjustmentNote(meta) {
  if (meta.adjustment !== 'qfq') return '';
  if (meta.adjustmentStatus === 'missing_anchor_factor') return `前复权锚点${meta.adjustmentAnchorDate ? `（${meta.adjustmentAnchorDate}）` : ''}缺少有效复权因子，无法展示前复权 K 线。`;
  if (meta.adjustmentStatus === 'partial' || meta.missingFactorCount > 0) return `缺少 ${meta.missingFactorCount ?? '部分'} 个交易日的有效复权因子，已略去对应日线，未混用未复权价格。`;
  return '';
}
function renderDailyMarketChart(area, points, { ticker = '', currency = 'CNY', adjustment = 'none', benchmark = null, period = '', volumeUnit = '手', amountUnit = '千元' } = {}) {
  const first = points[0], last = points.at(-1);
  const hongKong = ticker.endsWith('.HK');
  const envelope = point => ({ low: Math.min(point.low, point.open, point.close), high: Math.max(point.high, point.open, point.close) });
  const low = Math.min(...points.map(point => envelope(point).low)), high = Math.max(...points.map(point => envelope(point).high));
  const adjustmentLabel = adjustment === 'qfq' ? '前复权' : '未复权';
  const benchmarkByDate = new Map((benchmark?.points || []).map(point => [point.date, point]));
  const scaledPoints = benchmark?.status === 'available' ? points.map(point => benchmarkByDate.get(point.date)?.scaledClose).filter(value => isFiniteMarketNumber(value) && value > 0) : [];
  const axisLow = Math.min(low, ...scaledPoints), axisHigh = Math.max(high, ...scaledPoints);
  const summary = node('div', 'market-chart-summary');
  const comparison = summarizeMarketComparison(points, benchmark);
  const closing = marketStat('最新收盘价', marketPrice(comparison.stock?.close, hongKong));
  closing.querySelector('strong').append(node('span', 'market-currency', currency === 'CNY' ? '元' : currency));
  closing.append(node('small', 'market-summary-date', comparison.stock?.date || '暂无收盘数据'));
  const index = marketStat(benchmark?.system === 'HSI' ? '恒生指数点位' : '行业指数点位', marketNumber(comparison.index?.close), 'market-index-summary');
  if (comparison.index) index.querySelector('strong').append(node('span', 'market-currency', '点'));
  index.append(node('small', 'market-summary-date', comparison.index?.date || '指数暂不可用'));
  const performance = comparison.performance, difference = performance?.excessPercentagePoints;
  const direction = !performance ? 'unavailable' : Math.abs(difference) < 1e-9 ? 'flat' : difference > 0 ? 'ahead' : 'behind';
  const label = { unavailable: '区间相对表现', flat: '与指数持平', ahead: '跑赢指数', behind: '跑输指数' }[direction];
  const value = !performance ? '—' : Math.abs(difference) > 1e-9 && Math.abs(difference) < 0.005 ? '<0.01' : marketNumber(Math.abs(difference));
  const relative = marketStat(label, value, `market-relative-${direction}`);
  if (performance) relative.querySelector('strong').append(node('span', 'market-currency', '个百分点'));
  const periodName = { '1m': '1M', '6m': '6M', '1y': '1Y' }[period] || '区间';
  const comparisonDates = performance ? `${performance.from} — ${performance.to.slice(0, 4) === performance.from.slice(0, 4) ? performance.to.slice(5) : performance.to}` : '暂无可比数据';
  relative.append(node('small', 'market-summary-date', `${periodName} · ${comparisonDates}`));
  if (hongKong && !benchmark) summary.append(closing);
  else summary.append(closing, index, relative);
  const inspection = node('div', 'market-inspection'); inspection.setAttribute('role', 'status'); inspection.setAttribute('aria-live', 'polite'); inspection.setAttribute('aria-atomic', 'true');
  const width = 1100, height = 480, left = 92, right = 1080, top = 32, bottom = 292, volumeTop = 344, volumeBottom = 420;
  const spread = axisHigh - axisLow || Math.abs(axisHigh) * 0.04 || 1, min = Math.max(0, axisLow - spread * 0.13), max = Math.min(Number.MAX_VALUE, axisHigh + spread * 0.13);
  const x = index => points.length === 1 ? (left + right) / 2 : left + (right - left) * index / (points.length - 1);
  const y = value => bottom - (value - min) / (max - min) * (bottom - top);
  const volumeMax = Math.max(...points.map(point => point.volume ?? 0), 1);
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'group', tabindex: 0, 'aria-label': `${ticker}${adjustmentLabel}日K线与成交量${scaledPoints.length ? `及${benchmarkDisplayName(benchmark)}` : ''}，${first.date}至${last.date}。使用左右方向键选择交易日，Home和End跳至首末日。`, class: 'market-chart' });
  svg.append(svgNode('title', {}, `${hongKong ? '港股' : 'A 股'}日K线与成交量，展示开盘、最高、最低、收盘，非实时，${adjustmentLabel}${scaledPoints.length ? `；${benchmarkDisplayName(benchmark)}按共同起点缩放` : ''}`));
  for (let index = 0; index < 5; index++) {
    const value = min + (max - min) * index / 4;
    svg.append(svgNode('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'market-grid-line' }), svgNode('text', { x: left - 12, y: y(value) + 6, 'text-anchor': 'end', class: 'market-axis' }, marketAxisNumber(value, hongKong, (max - min) / 4)));
  }
  svg.append(svgNode('text', { x: left, y: 18, class: 'market-axis market-axis-title' }, `价格 (${currency})`));
  const candleWidth = Math.max(1, Math.min(12, (right - left) / Math.max(points.length, 1) * 0.65));
  points.forEach((point, index) => {
    const tone = marketTone(point.close - point.open);
    const bodyHeight = Math.max(1, Math.abs(y(point.open) - y(point.close)));
    const bodyY = (y(point.open) + y(point.close)) / 2 - bodyHeight / 2;
    const candle = svgNode('g', { class: `market-candle ${tone}`, 'data-date': point.date });
    candle.append(svgNode('line', { x1: x(index), x2: x(index), y1: y(point.high), y2: y(point.low), class: 'market-candle-wick' }), svgNode('rect', { x: x(index) - candleWidth / 2, y: bodyY, width: candleWidth, height: bodyHeight, class: 'market-candle-body' }));
    svg.append(candle);
  });
  const benchmarkGroup = svgNode('g', { class: 'market-benchmark-series' });
  if (scaledPoints.length) {
    const segments = []; let segment = [];
    points.forEach((point, index) => {
      const value = benchmarkByDate.get(point.date)?.scaledClose;
      if (isFiniteMarketNumber(value) && value > 0) segment.push({ index, value });
      else if (segment.length) { segments.push(segment); segment = []; }
    });
    if (segment.length) segments.push(segment);
    segments.forEach(segment => {
      const d = segment.map((point, index) => `${index ? 'L' : 'M'} ${x(point.index)} ${y(point.value)}`).join(' ');
      benchmarkGroup.append(svgNode('path', { d, class: 'market-benchmark-line' }));
      if (segment.length === 1) benchmarkGroup.append(svgNode('circle', { cx: x(segment[0].index), cy: y(segment[0].value), r: 2.5, class: 'market-benchmark-point' }));
    });
    svg.append(benchmarkGroup);
  }
  svg.append(svgNode('text', { x: left, y: 328, class: 'market-axis market-axis-title' }, `成交量 (${volumeUnit})`), svgNode('text', { x: right, y: 328, 'text-anchor': 'end', class: 'market-axis' }, points.some(point => point.volume != null) ? `区间最大 ${marketVolume(Math.max(...points.map(point => point.volume ?? 0)))} ${volumeUnit}` : '成交量未返回'));
  const barWidth = Math.min(14, (right - left) / Math.max(points.length, 1) * 0.65);
  points.forEach((point, index) => {
    if (point.volume == null) return;
    const height = point.volume / volumeMax * (volumeBottom - volumeTop);
    const tone = marketTone(point.close - point.open);
    svg.append(svgNode('rect', { x: x(index) - barWidth / 2, y: volumeBottom - height, width: barWidth, height, class: `market-volume-bar ${tone}` }));
  });
  svg.append(svgNode('line', { x1: left, x2: right, y1: volumeBottom, y2: volumeBottom, class: 'market-grid-line' }));
  const tickIndexes = [...new Set([0, Math.round((points.length - 1) / 3), Math.round((points.length - 1) * 2 / 3), points.length - 1])];
  tickIndexes.forEach((index, position) => svg.append(svgNode('text', { x: x(index), y: 455, 'text-anchor': tickIndexes.length === 1 ? 'middle' : position === 0 ? 'start' : position === tickIndexes.length - 1 ? 'end' : 'middle', class: 'market-axis' }, points[index].date)));
  const cursor = svgNode('line', { x1: x(points.length - 1), x2: x(points.length - 1), y1: top, y2: volumeBottom, class: 'market-crosshair' });
  const selection = svgNode('rect', { x: x(points.length - 1) - candleWidth / 2 - 3, y: y(envelope(last).high) - 4, width: candleWidth + 6, height: Math.max(1, y(envelope(last).low) - y(envelope(last).high)) + 8, class: 'market-selected-candle' });
  svg.append(cursor, selection, svgNode('rect', { x: left - 8, y: 0, width: right - left + 16, height: volumeBottom + 4, fill: 'transparent', class: 'market-chart-hit' }));
  let selected = -1;
  const select = index => {
    index = Math.max(0, Math.min(points.length - 1, index)); if (selected === index) return; selected = index;
    const point = points[index], date = node('div', 'market-inspection-date'); date.append(node('strong', '', point.date));
    const prices = node('div', 'market-inspection-prices'); prices.append(marketStat('开盘', marketPrice(point.open, hongKong)), marketStat('最高', marketPrice(point.high, hongKong)), marketStat('最低', marketPrice(point.low, hongKong)), marketStat('收盘', marketPrice(point.close, hongKong)));
    const trading = node('div', 'market-inspection-trading');
    const volume = marketStat('成交量', compactMarketVolume(point.volume, volumeUnit)), amount = marketStat('成交额', compactMarketAmount(point.amount, amountUnit));
    volume.setAttribute('title', `成交量 ${marketVolume(point.volume)} ${volumeUnit}`); amount.setAttribute('title', isFiniteMarketNumber(point.amount) ? `成交额 ${marketNumber(point.amount, 1)} ${amountUnit}` : '成交额 暂无');
    trading.append(volume, amount); inspection.replaceChildren(date, prices, trading);
    if (benchmark) {
      const benchmarkPoint = benchmarkByDate.get(point.date);
      inspection.classList.add('with-benchmark');
      trading.append(marketStat(benchmark.system === 'HSI' ? '恒生指数' : '行业指数', isFiniteMarketNumber(benchmarkPoint?.close) ? `${marketNumber(benchmarkPoint.close)} 点` : '当日数据缺失', 'market-benchmark-inspection'));
    }
    cursor.setAttribute('x1', x(index)); cursor.setAttribute('x2', x(index)); selection.setAttribute('x', x(index) - candleWidth / 2 - 3); selection.setAttribute('y', y(envelope(point).high) - 4); selection.setAttribute('height', Math.max(1, y(envelope(point).low) - y(envelope(point).high)) + 8);
  };
  select(points.length - 1);
  const bindings = [];
  const listen = (event, handler) => { svg.addEventListener(event, handler); bindings.push([event, handler]); };
  listen('pointermove', event => {
    const bounds = svg.getBoundingClientRect(); if (!bounds.width || !isFiniteMarketNumber(event.clientX)) return;
    const scale = isFiniteMarketNumber(bounds.height) && bounds.height > 0 ? Math.min(bounds.width / width, bounds.height / height) : bounds.width / width;
    const offsetX = (bounds.width - width * scale) / 2;
    const plotX = (event.clientX - bounds.left - offsetX) / scale;
    select(Math.round((plotX - left) / (right - left) * (points.length - 1)));
  });
  listen('pointerleave', () => select(points.length - 1));
  listen('keydown', event => {
    const next = { ArrowLeft: selected - 1, ArrowRight: selected + 1, Home: 0, End: points.length - 1 }[event.key];
    if (next === undefined) return; event.preventDefault(); select(next);
  });
  listen('blur', () => select(points.length - 1));
  const legend = benchmarkLegend(benchmark);
  let toggle = null, toggleHandler = null;
  if (legend && scaledPoints.length) {
    toggle = node('input'); toggle.type = 'checkbox'; toggle.checked = marketBenchmarkVisibility.get(area) !== false;
    toggle.setAttribute('aria-label', `显示${benchmarkDisplayName(benchmark)}`);
    const control = node('label', 'market-benchmark-toggle'); control.append(toggle, node('span', '', benchmark.system === 'HSI' ? '指数对照' : '行业对照'));
    const status = legend.querySelector('.market-benchmark-status');
    if (status) { status.remove(); legend.append(control, status); }
    else legend.append(control);
    const applyVisibility = () => {
      benchmarkGroup.setAttribute('visibility', toggle.checked ? 'visible' : 'hidden');
      benchmarkGroup.setAttribute('aria-hidden', String(!toggle.checked));
    };
    toggleHandler = () => { marketBenchmarkVisibility.set(area, toggle.checked); applyVisibility(); };
    toggle.addEventListener('change', toggleHandler); applyVisibility();
  }
  marketChartCleanups.set(area, () => {
    bindings.forEach(([event, handler]) => svg.removeEventListener(event, handler));
    if (toggle && toggleHandler) toggle.removeEventListener('change', toggleHandler);
  });
  area.append(summary);
  if (legend) area.append(legend);
  area.append(inspection, svg, marketChartDetails(benchmark, comparison, currency));
}

export function renderPrices(data, { adjustment: requestedAdjustment = 'none' } = {}) {
  const area = document.querySelector('.chart-empty'), footer = document.querySelector('.chart-footer');
  clearMarketChart(area); area.replaceChildren(); area.classList.remove('has-market-chart');
  const rawPoints = Array.isArray(data) ? data : Array.isArray(data?.points) ? data.points : [];
  const ticker = data?.ticker || currentMarketTicker(), hongKong = ticker.endsWith('.HK');
  const points = cleanMarketPoints(rawPoints, { hongKong }), meta = { adjustment: requestedAdjustment, ...(!Array.isArray(data) ? data?.meta || {} : {}) };
  const volumeUnit = hongKong ? '股' : '手', amountUnit = hongKong ? meta.amountUnit || (meta.currency === 'USD' ? '美元' : '港元') : '千元', benchmark = data?.benchmark;
  const adjustmentLabel = meta.adjustment === 'qfq' ? '前复权' : '未复权', missingAdjustment = adjustmentNote(meta);
  const title = document.getElementById('market-title'); if (title) title.textContent = `${adjustmentLabel}日 K 线与${hongKong ? '恒生指数' : '行业指数'}`;
  const eyebrow = document.querySelector('.price-panel .panel-heading .kicker'); if (eyebrow) eyebrow.textContent = `动态信息 · ${hongKong ? '港股' : 'A 股'}日线`;
  if (!points.length) {
    const empty = node('div', 'empty-content'); empty.append(node('span', 'empty-icon', '⌁'), node('h3', '', '暂无可展示的日 K 线'));
    const caption = node('p', '', missingAdjustment || (rawPoints.length ? '日线缺少完整有效的开、高、低、收（OHLC）数据，无法绘制 K 线。' : marketEmptyText(ticker))); caption.id = 'price-caption'; empty.append(caption, node('span', 'empty-tag', `${hongKong ? '港股' : 'A 股'}日 K 线 · 非实时 · ${adjustmentLabel}`));
    const legend = benchmarkLegend(benchmark); if (legend) empty.append(legend);
    area.append(empty);
    footer.replaceChildren(node('span', '', '暂无日线'), node('span', '', `${meta.source || (hongKong ? 'Tencent' : 'Tushare')} · ${adjustmentLabel}`)); return;
  }
  area.classList.add('has-market-chart');
  renderDailyMarketChart(area, points, { ticker, currency: meta.currency || (hongKong ? 'HKD' : 'CNY'), adjustment: meta.adjustment, benchmark, period: meta.period, volumeUnit, amountUnit });
  const basisNote = meta.adjustment === 'qfq' ? `前复权锚点 ${marketDate(meta.adjustmentAnchorDate) || '未提供'}，按研究截止日前最近交易日的因子调整 OHLC；成交量和成交额为原始值。` : '除权、拆并股可能造成价格跳变，不能直接视为投资收益。';
  const skippedNote = rawPoints.length > points.length ? `已跳过 ${rawPoints.length - points.length} 条缺失、不合法或重复的日线。` : '';
  const caption = node('p', 'market-price-caption', `${points.length} 个交易日 · ${adjustmentLabel}日 K 线；${basisNote}红涨绿跌（收盘对比开盘），平盘为灰色，成交量柱同色。${missingAdjustment ? ` ${missingAdjustment}` : ''}${skippedNote ? ` ${skippedNote}` : ''}`); caption.id = 'price-caption'; area.querySelector('.market-chart-details-body').append(caption);
  if (missingAdjustment || skippedNote) area.append(node('p', 'market-data-warning', [missingAdjustment, skippedNote].filter(Boolean).join(' ')));
  const actualEnd = points.at(-1).date, requested = marketDate(meta.requestedAsOf), through = marketDate(meta.databaseThrough);
  const source = `${meta.source || (hongKong ? 'Tencent' : 'Tushare')}${benchmark ? benchmark.system === 'HSI' ? ' / 恒生指数（Tencent）' : ' / sw_daily' : ''}`;
  area.querySelector('.market-chart-details-body').append(node('p', '', [requested ? `研究截止 ${requested}` : '', through ? `库内数据截至 ${through}` : `最新展示交易日 ${actualEnd}`, `${source} · ${adjustmentLabel} · 非实时`, `价格：${meta.currency || (hongKong ? 'HKD' : 'CNY')} · 成交量：${volumeUnit} · 成交额：${amountUnit}`].filter(Boolean).join(' · ')));
  footer.replaceChildren(node('span', '', `${points[0].date} — ${actualEnd}`), node('span', '', source));
}

function debateCard(item, index, isQuestion) {
  const card = node('article', 'debate-card');
  const top = node('div', 'card-top'); top.append(node('span', 'number-label', `${String(index + 1).padStart(2, '0')} / ${item.category || '分歧'}`), node('span', 'question-tag', isQuestion ? '研究问题' : '来源观点'));
  card.append(top, node('h3', '', item.title), node('p', '', item.summary || ''));
  const verification = node('div', 'verification'); verification.append(node('span', '', '验证指标'), node('strong', '', item.metrics.join(' · ') || '待补充')); card.append(verification);
  const details = node('details'); const summary = node('summary', '', isQuestion ? '需要补充的证据 ' : '观点与来源 '); summary.append(node('span', 'disclosure-toggle-icon', '＋')); details.append(summary);
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

const platformNames = { company: '公司公告 / IR', sell_side: '卖方研报', ima: 'ima 数据', alpha: 'alpha 派', xueqiu: '雪球', tradingview: 'TradingView', x: 'X', other: '其他公开来源' };
const scopeNames = { full_text: '全文', partial_text: '部分正文', search_snippet: '搜索摘要' };
const coverageNames = { found: '已找到来源', limited: '覆盖有限', not_found: '未找到可用来源', not_searched: '未检索', needs_import: '需要导入资料' };
const statusNames = { documented_disagreement: '有来源支持的分歧', research_hypothesis: '研究假设', insufficient_evidence: '证据不足' };
const evidenceNames = { source_view: '来源观点', model_inference: '模型推断', insufficient: '证据不足' };

function opinionCopy(text) {
  const paragraph = node('p', 'opinion-copy');
  // Render only Markdown source links; all other model output stays plain text.
  // One nested pair supports URLs such as /report(2026), without accepting HTML.
  const links = /\[([^\[\]\r\n]+)\]\(([^\s()<>]+(?:\([^\s()<>]*\)[^\s()<>]*)*)\)/g;
  let offset = 0;
  for (const match of text.matchAll(links)) {
    const url = safeSourceUrl(match[2]);
    if (!url) continue;
    paragraph.append(document.createTextNode(text.slice(offset, match.index)));
    const labelUrl = safeSourceUrl(match[1]);
    const link = sourceLink(labelUrl ? new URL(labelUrl).hostname : match[1], url);
    link.className = 'opinion-source-link';
    paragraph.append(link);
    offset = match.index + match[0].length;
  }
  paragraph.append(document.createTextNode(text.slice(offset)));
  return paragraph;
}

function opinionPanel(side, name, className, sourceIndex, sources) {
  const panel = node('section', `opinion-panel ${className}`);
  const heading = node('div', 'opinion-heading'); heading.append(node('strong', '', name), node('span', `evidence-tag ${side.evidenceStatus}`, evidenceNames[side.evidenceStatus]));
  panel.append(heading, opinionCopy(side.summary || '未取得可支持该方向的观点。'));
  const refs = node('div', 'opinion-refs');
  side.sourceIds.forEach(id => {
    const index = sourceIndex.get(id); if (index === undefined) return;
    const ref = node('a', '', `[${index + 1}]`); ref.href = `#debate-source-${index + 1}`; ref.setAttribute('aria-label', `展开并查看来源 ${index + 1}`);
    // Open before the native anchor navigation so a citation is never hidden.
    ref.addEventListener('click', () => { sources.open = true; }); refs.append(ref);
  });
  if (!side.sourceIds.length) refs.append(node('span', '', side.evidenceStatus === 'model_inference' ? '无独立来源 · 待验证' : '无可引用来源'));
  panel.append(refs); return panel;
}

function disclosureSummary(title, count) {
  const summary = node('summary', 'report-disclosure-summary');
  const label = node('span', 'report-disclosure-label');
  label.append(node('strong', '', title), node('small', '', count));
  const action = node('span', 'report-disclosure-action');
  action.append(node('span', 'disclosure-expand', '展开'), node('span', 'disclosure-collapse', '收起'), node('span', 'disclosure-chevron', '⌄'));
  summary.append(label, action); return summary;
}

function prepareDisclosure(container, reportKey) {
  if (container.dataset.reportKey !== reportKey) container.open = false;
  container.dataset.reportKey = reportKey;
}

function generatedTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未提供';
  return `${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)}（北京时间）`;
}

export function renderDebates(report, { ticker = '' } = {}) {
  if (report && ticker && report.ticker?.toUpperCase() !== ticker) throw new Error('核心分歧内容与当前股票不一致');
  const area = document.querySelector('.debate-grid');
  const coverage = document.getElementById('debate-coverage');
  const sources = document.getElementById('debate-sources');
  const reportTime = document.getElementById('debate-generated-time');
  if (reportTime) {
    reportTime.hidden = !report;
    reportTime.textContent = report ? `生成时间：${generatedTime(report.generatedAt || report.updatedAt)}` : '';
    if (report?.pipeline?.ima) reportTime.textContent += report.pipeline.ima.sourceCount
      ? ` · ima 参考 ${report.pipeline.ima.sourceCount} 份，引用 ${report.pipeline.ima.citedCount || 0} 份${report.pipeline.ima.cacheHit ? '（复用近期读取）' : ''} ＋ 联网研究`
      : ' · 本次未使用 ima 资料，已联网研究';
  }
  const disclosures = [coverage, sources].filter(Boolean);
  coverage.hidden = sources.hidden = !report;
  if (!report) {
    area.replaceChildren(node('p', 'empty-message', '暂无已保存分歧，点击“生成分歧”开始。'));
    document.querySelector('#debates .status-pill').textContent = '尚未生成分歧';
    disclosures.forEach(container => { container.open = false; delete container.dataset.reportKey; });
    coverage.replaceChildren(); sources.replaceChildren(); return;
  }
  const reportKey = JSON.stringify([report.ticker, report.asOf, report.updatedAt || report.generatedAt || '', report.id || '']);
  disclosures.forEach(container => prepareDisclosure(container, reportKey));
  document.querySelector('#debates .status-pill').textContent = report.debates.length ? `${report.debates.length} 个核心问题` : '证据不足，暂无分歧';
  const sourceIndex = new Map(report.sources.map((source, index) => [source.id, index]));
  area.replaceChildren(...(report.debates.length ? report.debates.map((item, index) => {
    const card = node('article', 'market-debate-card');
    const top = node('div', 'card-top'); top.append(node('span', 'number-label', `${String(index + 1).padStart(2, '0')} / 核心问题`), node('span', `question-tag ${item.status}`, statusNames[item.status]));
    card.append(top, node('h3', '', item.title)); if (item.summary) card.append(node('p', 'debate-summary', item.summary));
    const details = node('details', 'debate-perspectives'); details.open = index === 0;
    const toggle = node('summary', 'debate-perspectives-toggle');
    toggle.append(node('span', 'disclosure-expand', '展开正反观点与验证指标'), node('span', 'disclosure-collapse', '收起正反观点与验证指标'));
    details.append(toggle);
    const opinions = node('div', 'opinion-grid'); opinions.append(opinionPanel(item.bull, '正方 · 乐观观点', 'bull', sourceIndex, sources), opinionPanel(item.bear, '反方 · 审慎观点', 'bear', sourceIndex, sources)); details.append(opinions);
    const verification = node('div', 'verification'); verification.append(node('span', '', '后续验证指标 / 事件'), node('strong', '', item.metrics.join(' · ') || '未提供具体指标')); details.append(verification); card.append(details); return card;
  }) : [node('p', 'empty-message', '当前可用证据不足，未形成可展示的核心分歧。请结合来源覆盖情况判断。')]));
  const foundCount = report.coverage.filter(item => ['found', 'limited'].includes(item.status)).length;
  coverage.replaceChildren(disclosureSummary('平台覆盖情况', `${report.coverage.length} 个平台 · ${foundCount} 个找到资料`));
  const coverageBody = node('div', 'report-disclosure-body');
  const coverageRows = node('div', 'coverage-grid');
  report.coverage.forEach(item => {
    const row = node('div', 'coverage-item'); row.append(node('strong', '', platformNames[item.platform] || item.platform), node('span', `coverage-state ${item.status}`, coverageNames[item.status] || '状态未提供'), node('p', '', item.note || '')); coverageRows.append(row);
  });
  if (!report.coverage.length) coverageRows.append(node('p', '', '接口未提供平台覆盖信息。'));
  coverageBody.append(coverageRows); coverage.append(coverageBody);
  if (report.pipeline?.ima) coverageBody.append(node('p', 'source-explanation', report.pipeline.ima.message || ''));
  sources.replaceChildren(disclosureSummary('引用来源', `${report.sources.length} 条`));
  const sourceBody = node('div', 'report-disclosure-body');
  sourceBody.append(node('p', 'source-explanation', '网络资料与真实检索记录核对；ima 数据对应实际取得的研报正文，可展开查看所读片段。核对标记不代表内容真实或已经阅读全文，观点仍需结合原文判断。'));
  report.sources.forEach((source, index) => {
    const row = node('article', 'research-source'); row.id = `debate-source-${index + 1}`; row.tabIndex = -1;
    const isIma = source.sourceKind === 'ima';
    const top = node('div', 'research-source-title'); top.append(node('span', '', `[${index + 1}]`),
      ...(isIma ? [node('span', 'ima-source-badge', 'ima 数据'), node('span', '', source.title || '标题未取得')] : [sourceLink(source.title || '标题未取得', source.url)]));
    if (source.qualityLabel) top.append(node('span', 'low-quality-label', source.qualityLabel));
    row.append(top, node('p', 'source-metadata', `${platformNames[source.platform] || source.platform} · 作者 / 机构：${source.author || '未取得'} · 日期：${source.publishedAt || '未取得'} · 读取范围：${scopeNames[source.readingScope] || '未提供'}${source.citationVerified ? '' : ' · 未与搜索元数据核对'}`)); sourceBody.append(row);
    if (isIma) {
      row.append(node('p', 'source-metadata', `知识库：${source.libraryName || 'ima'} · 可在 ima 中按研报标题查找原文`));
      const details = node('details', 'ima-evidence');
      details.append(node('summary', '', '查看实际读取的研报片段'));
      for (const excerpt of source.excerpts || []) {
        details.append(node('p', 'source-metadata', `第 ${excerpt.page} 页${excerpt.method === 'ocr' ? ' · 文字识别，数字需核对' : ''}`), node('blockquote', '', excerpt.text));
      }
      row.append(details);
    }
  });
  if (!report.sources.length) sourceBody.append(node('p', 'empty-message', '本次未取得可引用的来源。'));
  sources.append(sourceBody);

}

const forecastField = (item, fallback, name) => Object.hasOwn(item, name) ? item[name] : fallback?.[name];
const forecastUnits = (item, fallback = {}) => `${forecastField(item, fallback, 'unit') || '单位未提供'} · ${forecastField(item, fallback, 'currency') || '币种未提供'}`;
const forecastBasis = (item, fallback = {}) => forecastField(item, fallback, 'basis') || '基本 / 稀释及调整口径待原文核验';
const forecastFiscalEnd = item => item.fiscalPeriod ? /^\d{4}-\d{2}$/.test(item.fiscalPeriod) ? `财年截至 ${item.fiscalPeriod}` : '财年结束月未提供' : '';
const forecastCollectionFailed = data => data?.meta?.dateMeaning === 'broker_update_date' && !data.meta.snapshotDate
  && (data.meta.status === 'collection_failed' || ['failed', 'partial'].includes(data.meta.updateStatus));

function renderForecastSource(data, status) {
  const target = document.getElementById('forecast-source'); if (!target) return;
  const snapshot = data?.meta?.dateMeaning === 'broker_update_date';
  const collectionFailed = forecastCollectionFailed(data);
  const noCoverage = snapshot && data.meta?.status === 'no_coverage';
  const collecting = snapshot && data.meta?.status === 'collecting';
  const summary = node('div');
  summary.append(node('strong', '', data?.source ? `${data.source} · 卖方 EPS` : '卖方 EPS 预测'), node('p', '', collectionFailed ? '采集失败 · 无可用快照' : noCoverage ? '已查询经济通，暂无公开卖方 EPS 预测覆盖' : collecting ? '该公司预测正在采集' : data ? `公开${snapshot ? '券商预测快照' : '研报样本'}${data.meta?.databaseThrough ? ` · 库内${snapshot ? '更新' : '报告'}截至 ${data.meta.databaseThrough}` : ''}` : status === 'error' ? '卖方预测读取失败' : status === 'loading' ? '正在读取卖方预测…' : '等待卖方预测'));
  target.replaceChildren(summary, node('span', '', collectionFailed ? '采集失败' : noCoverage ? '已查询 · 暂无覆盖' : collecting ? '采集中' : status === 'error' ? '读取失败' : status === 'loading' ? '读取中' : data ? data.rows?.length ? '样本已读取' : snapshot && data.meta?.status === 'not_downloaded' ? '尚未采集' : '暂无公开样本' : '等待读取'));
}

export function renderForecasts(payload, { status = 'ready' } = {}) {
  const data = Array.isArray(payload) ? { rows: payload } : payload;
  const rows = data?.rows || [], meta = data?.meta || {};
  const snapshot = meta.dateMeaning === 'broker_update_date';
  const showRowBasis = new Set(rows.map(item => forecastBasis(item, data))).size > 1;
  const noSnapshot = snapshot && meta.status === 'not_downloaded';
  const collectionFailed = forecastCollectionFailed(data);
  const noCoverage = snapshot && meta.status === 'no_coverage';
  const collecting = snapshot && meta.status === 'collecting';
  const body = document.querySelector('#valuation tbody'); body.replaceChildren();
  const summary = document.getElementById('forecast-summary');
  const details = document.getElementById('forecast-sample-details'); details.replaceChildren();
  const metric = document.querySelector('.forecast-metric');
  const metricValue = metric.querySelector('strong'), metricNote = metric.querySelector('p');
  const pill = document.querySelector('#valuation .status-pill');
  const windowDays = data?.windowDays || 90;
  summary.textContent = '';
  renderForecastSource(data, status);
  const sourceHeading = document.querySelector('#valuation .forecast-summary-table th:last-child');
  if (sourceHeading) sourceHeading.textContent = snapshot ? '来源及券商更新日' : '来源及研报日期';
  const introduction = document.querySelector('#valuation .section-heading p');
  if (introduction) introduction.textContent = '';
  const tableNote = document.querySelector('#valuation .table-note');
  if (tableNote) {
    tableNote.hidden = !data || status === 'not_supported';
    tableNote.replaceChildren();
  }
  if (!data || !rows.length) {
    const label = status === 'not_supported' ? '该市场卖方预测暂未接入' : status === 'loading' ? '正在读取卖方预测' : status === 'error' ? '卖方预测读取失败' : status === 'not_configured' ? '待接入卖方预测' : collectionFailed ? '卖方预测采集失败，暂无可用快照' : collecting ? '该公司卖方 EPS 预测正在采集，请稍后查看' : noCoverage ? '已查询经济通，该公司当前暂无公开卖方 EPS 预测覆盖' : noSnapshot ? '该截止日尚无已采集的预测快照' : `近 ${windowDays} 天暂无公开有效 EPS 样本`;
    const row = node('tr'), cell = node('td', 'forecast-empty', label); cell.colSpan = 6; row.append(cell); body.append(row);
    pill.textContent = status === 'loading' ? '读取中' : status === 'error' ? '读取失败' : ['not_supported', 'not_configured'].includes(status) ? '未接入' : collectionFailed ? '采集失败' : collecting ? '采集中' : noCoverage ? '已查询 · 暂无覆盖' : noSnapshot ? '尚未采集' : '无有效样本';
    metricValue.textContent = ['loading', 'error', 'not_configured'].includes(status) || !data || noSnapshot || collectionFailed || collecting ? '—' : '0 家';
    metricNote.textContent = status === 'not_supported' ? '该市场未接入' : status === 'loading' ? '读取中…' : status === 'error' ? '读取失败' : status === 'not_configured' || !data ? '等待数据' : collectionFailed ? '采集失败' : collecting ? '采集中' : noCoverage ? '已查询 · 暂无覆盖' : noSnapshot ? '尚未采集' : `近 ${windowDays} 天 · 无有效样本`;
    if (!data) return;
  } else {
    const brokers = new Set(rows.flatMap(item => (item.samples || []).filter(sample => isFiniteMarketNumber(sample.eps)).map(sample => sample.broker?.trim()).filter(Boolean)));
    const count = brokers.size || (Number.isInteger(meta.brokerCount) ? meta.brokerCount : null);
    metricValue.textContent = count == null ? '已取得' : `${count} 家`;
    metricNote.textContent = `近 ${windowDays} 天`;
    pill.textContent = `${rows.length} 组预测`;
    rows.forEach((item, rowIndex) => {
      const row = node('tr');
      const extreme = estimate => {
        const cell = node('td', 'forecast-extreme');
        cell.append(node('strong', '', displayNumber(estimate?.value)));
        const names = estimate?.brokers?.length ? estimate.brokers.join('、') : estimate?.broker;
        cell.append(node('small', '', names || '券商未提供'));
        return cell;
      };
      const mean = node('td', 'forecast-mean'); mean.append(node('strong', '', displayNumber(item.consensus?.value)));
      const source = node('td', 'forecast-source');
      const sourceName = item.source || data.source || '来源未提供';
      source.append(safeSourceUrl(item.sourceUrl) ? sourceLink(sourceName, item.sourceUrl) : node('span', '', sourceName), node('small', '', item.asOf || `${snapshot ? '更新' : '研报'}日期未提供`));
      const year = node('td', 'forecast-year', item.fiscalYear);
      year.append(node('small', '', [item.fiscalPeriod ? forecastFiscalEnd(item) : '', forecastUnits(item, data), showRowBasis ? forecastBasis(item, data) : ''].filter(Boolean).join(' · ')));
      row.append(year, extreme(item.low), mean, extreme(item.high), node('td', '', `${item.sampleSize ?? '—'} 家`), source); body.append(row);

      row.className = 'forecast-expand-row';
      const disclosure = node('tr', 'forecast-inline-details');
      disclosure.hidden = true; disclosure.id = `forecast-details-${rowIndex}`;
      const detailCell = node('td'); detailCell.colSpan = 6;
      const toggle = node('button', 'forecast-row-toggle', `${item.fiscalYear} ＋`);
      toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', disclosure.id);
      toggle.setAttribute('aria-label', `展开 ${item.fiscalYear} 预测明细`);
      year.textContent = ''; year.append(toggle, node('small', '', [item.fiscalPeriod ? forecastFiscalEnd(item) : '', forecastUnits(item, data), showRowBasis ? forecastBasis(item, data) : ''].filter(Boolean).join(' · ')));
      const expand = () => {
        disclosure.hidden = !disclosure.hidden;
        toggle.textContent = `${item.fiscalYear} ${disclosure.hidden ? '＋' : '−'}`;
        toggle.setAttribute('aria-expanded', String(!disclosure.hidden));
        toggle.setAttribute('aria-label', `${disclosure.hidden ? '展开' : '收起'} ${item.fiscalYear} 预测明细`);
      };
      row.addEventListener('click', event => { if (!event.target?.closest?.('a')) expand(); });
      const area = node('div', 'table-scroll forecast-detail-body'), table = node('table', 'forecast-detail-table');
      const thead = node('thead'), header = node('tr');
      [snapshot ? '券商' : '券商 / 分析师', snapshot ? '券商更新日' : '研报日期', `EPS（${forecastUnits(item, data)}）`, '预测 PE', '评级', snapshot ? '预测记录及来源' : '研报标题及来源'].forEach(label => header.append(node('th', '', label))); thead.append(header);
      const sampleBody = node('tbody');
      (item.samples || []).forEach(sample => {
        const entry = node('tr'), broker = node('td'); broker.append(node('strong', '', sample.broker || '券商未提供'));
        if (sample.author || !snapshot) broker.append(node('small', '', sample.author || '分析师未提供'));
        if (sample.brokerOriginal && sample.brokerOriginal !== sample.broker) broker.append(node('small', '', `来源名称：${sample.brokerOriginal}`));
        const title = node('td', 'forecast-report-title');
        const url = safeSourceUrl(sample.sourceUrl);
        title.append(url ? sourceLink(sample.title || (snapshot ? '查看券商预测' : '研报原文'), url) : node('span', '', sample.title || (snapshot ? '公开预测记录' : '标题未提供')));
        title.append(node('small', '', sample.source || item.source || data.source || '来源未提供'));
        const sampleEps = node('td', '', displayNumber(sample.eps));
        if (forecastUnits(sample, item) !== forecastUnits(item, data) || forecastBasis(sample, item) !== forecastBasis(item, data)) sampleEps.append(node('small', '', `${forecastUnits(sample, item)} · ${forecastBasis(sample, item)}`));
        entry.append(broker, node('td', '', sample.reportDate || '未提供'), sampleEps, node('td', '', displayNumber(sample.pe)), node('td', '', sample.rating || '—'), title); sampleBody.append(entry);
      });
      if (!sampleBody.childNodes.length) { const entry = node('tr'), cell = node('td', '', '该财年的逐券商明细尚未返回'); cell.colSpan = 6; entry.append(cell); sampleBody.append(entry); }
      table.append(thead, sampleBody); area.append(node('p', 'forecast-detail-basis', `${forecastUnits(item, data)} · ${forecastBasis(item, data)}`), table); detailCell.append(area); disclosure.append(detailCell); body.append(disclosure);
    });
  }
  const period = data.windowStart && data.asOf ? `${data.windowStart} — ${data.asOf}（${windowDays} 天）` : `近 ${windowDays} 天`;
  const coverage = [data.asOf ? `研究截止 ${data.asOf}` : '', meta.snapshotDate ? `快照采集日 ${meta.snapshotDate}` : ''].filter(Boolean);
  summary.append(node('span', 'forecast-context', coverage.join(' · ')));
  if (Number.isInteger(meta.excludedCount) && meta.excludedCount > 0) summary.append(node('span', 'forecast-data-warning', `已排除 ${meta.excludedCount} 项缺失或冲突样本`));
  const basis = data.basis || '接口未提供基本 / 稀释及调整口径，待原文核验';
  if (meta.stale === true) summary.append(node('span', 'forecast-history-note', meta.updateStatus === 'running' ? '正在更新 · 显示此前快照' : '更新失败 · 显示此前快照'));
  if (tableNote) {
    const disclosure = node('details', 'data-disclosure forecast-data-details'), content = node('div', 'data-disclosure-body');
    disclosure.append(node('summary', '', '数据说明'));
    content.append(node('p', '', `${snapshot ? '券商更新' : '研报'}窗口 ${period}${meta.databaseThrough ? ` · 库内${snapshot ? '更新' : '报告'}截至 ${meta.databaseThrough}` : ''}`));
    content.append(node('p', '', `EPS 单位：${data.unit || '接口未提供'} · 币种：${data.currency || '接口未提供'} · ${basis}。`));
    content.append(node('p', '', '同一币种与 EPS 口径下，每家券商每个财年保留最新有效记录。样本均值为已收集公开样本的算术均值，并非全市场一致预期。'));
    if (snapshot) content.append(node('p', '', '日期为券商更新日；从首次成功采集起保存每日快照，历史更新日期不代表已拥有该日的预测快照。'));
    if (meta.pointInTimeNote) content.append(node('p', '', meta.pointInTimeNote));
    const url = safeSourceUrl(data.sourceUrl) || (data.source === 'Tushare report_rc' ? 'https://tushare.pro/document/2?doc_id=292' : null);
    if (url) content.append(sourceLink(`${data.source || '数据'}来源说明`, url));
    disclosure.append(content); tableNote.append(disclosure);
  }
}

export function renderBands(bands, options = {}) {
  renderValuationBands(bands, options);
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
