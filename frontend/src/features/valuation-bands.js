// Historical multiple charts use one fixed set of quantiles for the requested window.
const charts = new WeakMap();
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const number = value => finite(value) ? value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const axisNumber = value => {
  const magnitude = Math.abs(value);
  if (magnitude >= 1e9 || (magnitude > 0 && magnitude < 0.01)) return value.toExponential(1).replace('e+', 'e');
  if (magnitude >= 1e8) return `${(value / 1e8).toLocaleString('zh-CN', { maximumSignificantDigits: 3, useGrouping: false })}亿`;
  if (magnitude >= 10000) return `${(value / 10000).toLocaleString('zh-CN', { maximumSignificantDigits: 3, useGrouping: false })}万`;
  return value.toLocaleString('zh-CN', { minimumFractionDigits: magnitude < 1000 ? 2 : 0, maximumFractionDigits: magnitude < 1000 ? 2 : 0 });
};
const multiple = value => positive(value) ? number(value) : '—';
const percent = value => finite(value) && value >= 0 && value <= 100 ? `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%` : '—';
const node = (tag, className = '', text = '') => {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
};
const svgNode = (tag, attributes = {}, text = '') => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text) element.textContent = text; return element;
};
const stat = (label, value, className = '') => {
  const element = node('div', `valuation-band-stat ${className}`);
  element.append(node('span', '', label), node('strong', '', value)); return element;
};

function clearPanel(panel) { charts.get(panel)?.(); charts.delete(panel); }
export function cleanupValuationBands(root = document) {
  root.querySelectorAll('.band-panel').forEach(clearPanel);
}

function cleanPoints(group, payload) {
  return [...new Map((Array.isArray(group?.points) ? group.points : [])
    .filter(point => validDate(point?.date) && (!validDate(payload.asOf) || point.date <= payload.asOf)
      && (!validDate(payload.windowStart) || point.date >= payload.windowStart))
    .map(point => [point.date, { date: point.date, value: positive(point.value) ? point.value : null,
      loss: finite(point.value) && point.value < 0 || point.date === group.latest?.date && finite(group.latest.rawValue) && group.latest.rawValue < 0 }])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));
}
function midrank(values, value) {
  return 100 * (values.filter(item => item < value).length + values.filter(item => item === value).length * 0.5) / values.length;
}

function renderChart(panel, area, points, group, payload, label, hasQuantiles) {
  const valid = points.filter(point => positive(point.value)), values = valid.map(point => point.value);
  const width = 640, height = 340, left = 62, right = 620, top = 18, bottom = 300;
  const low = Math.min(...values), high = Math.max(...values), spread = high - low || Math.abs(high) * 0.08 || 1;
  const min = Math.max(0, low - spread * 0.12), max = Math.min(Number.MAX_VALUE, high + spread * 0.12);
  const x = index => points.length === 1 ? (left + right) / 2 : left + index * (right - left) / (points.length - 1);
  const y = value => bottom - (value - min) / (max - min) * (bottom - top);
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', tabindex: 0, class: 'valuation-band-chart',
    'aria-label': `${payload.ticker || ''} ${label} 历史倍数走势，${points[0].date}至${points.at(-1).date}，单位为倍。${hasQuantiles ? '分位带按整个所选窗口计算。' : '样本不足，仅展示走势。'}左右方向键选择交易日，Home和End跳至首末日。` });
  svg.append(svgNode('title', {}, `${label} 历史倍数与整窗口分位区间`));
  svg.append(svgNode('rect', { x: left, y: top, width: right - left, height: bottom - top, rx: 8, class: 'valuation-band-plot' }));
  if (hasQuantiles) {
    const q = group.quantiles;
    svg.append(svgNode('rect', { x: left, y: y(q.p90), width: right - left, height: Math.max(0, y(q.p10) - y(q.p90)), class: 'valuation-band-range valuation-band-outer' }),
      svgNode('rect', { x: left, y: y(q.p75), width: right - left, height: Math.max(0, y(q.p25) - y(q.p75)), class: 'valuation-band-range valuation-band-inner' }));
  }
  for (let index = 0; index < 5; index++) {
    const value = min + (max - min) * index / 4;
    svg.append(svgNode('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'valuation-band-gridline' }),
      svgNode('text', { x: left - 16, y: y(value) + 4, 'text-anchor': 'end', class: 'valuation-band-axis' }, axisNumber(value)));
  }
  const tickIndexes = [...new Set([0, Math.round((points.length - 1) / 2), points.length - 1])];
  tickIndexes.forEach((index, position) => {
    if (position > 0 && position < tickIndexes.length - 1) svg.append(svgNode('line', { x1: x(index), x2: x(index), y1: top, y2: bottom, class: 'valuation-band-gridline valuation-band-gridline-vertical' }));
    svg.append(svgNode('text', { x: x(index), y: 328, class: 'valuation-band-axis',
      'text-anchor': tickIndexes.length === 1 ? 'middle' : position === 0 ? 'start' : position === tickIndexes.length - 1 ? 'end' : 'middle' }, points[index].date));
  });
  if (hasQuantiles) {
    for (const key of ['p10', 'p25', 'p50', 'p75', 'p90']) svg.append(svgNode('line', {
      x1: left, x2: right, y1: y(group.quantiles[key]), y2: y(group.quantiles[key]),
      class: `valuation-band-quantile ${key === 'p50' ? 'valuation-band-median' : ''}`, 'data-quantile': key,
    }));
  }
  const segments = []; let segment = [];
  points.forEach((point, index) => {
    if (positive(point.value)) segment.push({ index, value: point.value });
    else if (segment.length) { segments.push(segment); segment = []; }
  });
  if (segment.length) segments.push(segment);
  segments.forEach(items => {
    svg.append(svgNode('path', { d: items.map((point, index) => `${index ? 'L' : 'M'} ${x(point.index)} ${y(point.value)}`).join(' '), class: 'valuation-band-history' }));
    if (items.length === 1) svg.append(svgNode('circle', { cx: x(items[0].index), cy: y(items[0].value), r: 2.5, class: 'valuation-band-isolated' }));
  });
  const cursor = svgNode('line', { x1: left, x2: left, y1: top, y2: bottom, class: 'valuation-band-cursor' });
  const marker = svgNode('circle', { cx: left, cy: bottom, r: 5.5, class: 'valuation-band-selected' });
  svg.append(cursor, marker, svgNode('rect', { x: left - 7, y: top, width: right - left + 14, height: bottom - top, fill: 'transparent', class: 'valuation-band-hit' }));
  const inspection = node('div', 'valuation-band-inspection'); inspection.setAttribute('role', 'status');
  inspection.setAttribute('aria-live', 'polite'); inspection.setAttribute('aria-atomic', 'true');
  let selected = -1;
  const select = index => {
    index = Math.max(0, Math.min(points.length - 1, index)); if (selected === index) return; selected = index;
    const point = points[index], available = positive(point.value);
    const loss = label === 'PE-TTM' && !available && point.loss;
    inspection.replaceChildren(node('strong', '', point.date), node('span', loss ? 'valuation-loss' : '',
      available ? `${label} ${multiple(point.value)}` : loss ? 'PE-TTM 亏损' : '当日倍数缺失或非正'));
    if (hasQuantiles && available) inspection.append(node('span', '', `窗口分位 ${percent(midrank(values, point.value))}`));
    cursor.setAttribute('x1', x(index)); cursor.setAttribute('x2', x(index));
    marker.setAttribute('cx', x(index)); marker.setAttribute('cy', available ? y(point.value) : bottom); marker.setAttribute('visibility', available ? 'visible' : 'hidden');
  };
  select(points.length - 1);
  const bindings = [];
  const listen = (event, handler) => { svg.addEventListener(event, handler); bindings.push([event, handler]); };
  listen('pointermove', event => {
    const bounds = svg.getBoundingClientRect(); if (!positive(bounds.width) || !finite(event.clientX)) return;
    // The SVG keeps xMidYMid meet: a fixed CSS height can add horizontal letterboxing.
    const scale = positive(bounds.height) ? Math.min(bounds.width / width, bounds.height / height) : bounds.width / width;
    const offsetX = (bounds.width - width * scale) / 2;
    const plotX = (event.clientX - bounds.left - offsetX) / scale;
    select(Math.round((plotX - left) / (right - left) * (points.length - 1)));
  });
  listen('pointerleave', () => select(points.length - 1));
  listen('keydown', event => {
    const index = { ArrowLeft: selected - 1, ArrowRight: selected + 1, Home: 0, End: points.length - 1 }[event.key];
    if (index === undefined) return; event.preventDefault(); select(index);
  });
  listen('blur', () => select(points.length - 1));
  charts.set(panel, () => bindings.forEach(([event, handler]) => svg.removeEventListener(event, handler)));
  const scroll = node('div', 'valuation-band-chart-scroll'); scroll.append(svg);
  area.append(inspection, scroll);
}

function renderPanel(panel, group, payload, label, status, period) {
  clearPanel(panel);
  const heading = panel.querySelector('.panel-heading');
  let summarySlot = panel.querySelector('.valuation-band-header-stats');
  if (!summarySlot && heading) {
    summarySlot = node('div', 'valuation-band-header-stats');
    heading.append(summarySlot);
  }
  summarySlot?.replaceChildren();
  const area = panel.querySelector('.band-empty'); if (!area) return;
  area.replaceChildren(); area.className = 'band-empty valuation-band-body';
  const badge = panel.querySelector('.plain-badge');
  if (badge) badge.textContent = (payload?.period || period || '1y') === '6m' ? '近 6 个月' : '近 1 年';
  const resolved = status === 'ready' || status === 'empty';
  if (!payload || !group || !resolved) {
    const text = status === 'loading' ? '正在读取历史估值…' : status === 'error' ? '历史估值读取失败，请重试。' : status === 'not_configured' ? '历史估值接口尚未接入。' : '暂无历史估值记录。';
    area.append(node('div', 'valuation-band-empty-state', text)); return;
  }
  const points = cleanPoints(group, payload), validCount = points.filter(point => positive(point.value)).length;
  const peLoss = label === 'PE-TTM' && points.at(-1)?.date === group.latest?.date && finite(group.latest?.rawValue) && group.latest.rawValue < 0;
  const retained = payload.meta?.retainedHistory === true || validCount > 0 || peLoss;
  const metricUnavailable = payload.meta?.sourceCoverage?.metricStatus?.[group.metric] === 'no_data';
  const coverageMessage = ({
    not_downloaded: '该公司历史估值尚未采集。',
    collecting: retained ? '正在采集估值，显示此前已保存的历史记录。' : '正在采集该公司的历史估值，请稍后查看。',
    no_data: retained ? '本次已查询百度股市通，暂未取得估值数据；保留此前历史记录。' : '已查询百度股市通，该公司暂未取得历史估值数据。',
    collection_failed: retained ? '估值采集失败，显示此前已保存的历史记录。' : '该公司估值采集失败，暂无可用估值记录。',
    no_price_data: '暂无本地日线，暂无法匹配估值交易日。',
  }[payload.coverageStatus]) || (metricUnavailable ? `已查询百度股市通，暂未取得 ${label} 历史估值数据。` : '');
  if (coverageMessage && ((!validCount && !peLoss) || ['not_downloaded', 'no_price_data'].includes(payload.coverageStatus))) {
    area.append(node('div', 'valuation-band-empty-state', coverageMessage)); return;
  }
  if (coverageMessage) area.append(node('p', 'valuation-band-notice', coverageMessage));
  if (!validCount) {
    area.append(node('div', `valuation-band-empty-state${peLoss ? ' valuation-loss' : ''}`, peLoss ? '亏损' : '暂无历史估值数据。')); return;
  }
  const hasQuantiles = group.status === 'available' && validCount >= (group.meta?.minSamples || 20)
    && ['p10', 'p25', 'p50', 'p75', 'p90'].every(key => positive(group.quantiles?.[key]));
  const latestDate = validDate(group.latest?.date) && (!validDate(payload.asOf) || group.latest.date <= payload.asOf)
    && (!validDate(payload.windowStart) || group.latest.date >= payload.windowStart) ? group.latest.date : null;
  const latestValue = latestDate && positive(group.latest?.value) ? group.latest.value : null;
  const summary = node('div', 'valuation-band-stats');
  summary.append(stat('最新估值', peLoss ? '亏损' : multiple(latestValue), `valuation-band-latest${peLoss ? ' valuation-loss' : ''}`),
    stat('历史分位', latestValue != null && hasQuantiles ? percent(group.latest.percentile) : '—'));
  (summarySlot || area).append(summary);
  const metadata = node('p', 'valuation-band-latest-date', latestDate || '最新日期未提供');
  if (payload.ticker?.endsWith('.HK')) {
    const source = payload.source || '来源未提供';
    metadata.textContent += ` · ${source}`;
    metadata.title = `历史记录 ${points[0].date} 至 ${points.at(-1).date} · 来源：${source}`;
  }
  area.append(metadata);
  if (payload.meta?.missingPriceCount > 0) area.append(node('p', 'valuation-band-notice', '部分交易日估值缺失，保留曲线缺口。'));
  const notices = [];
  if (latestValue == null && !peLoss) notices.push('最新值缺失或非正');
  if (!hasQuantiles) notices.push('样本不足');
  if (notices.length) area.append(node('p', 'valuation-band-notice', `${notices.join('；')}，分位暂缺。`));
  renderChart(panel, area, points, group, payload, label, hasQuantiles);
  if (hasQuantiles) {
    const legend = node('div', 'valuation-band-legend');
    [['valuation-band-legend-history', '历史倍数'], ['valuation-band-legend-outer', 'P10–P90'], ['valuation-band-legend-inner', 'P25–P75'], ['valuation-band-legend-median', 'P50 中位数']].forEach(([className, text]) => {
      const item = node('span'); item.append(node('i', className), node('span', '', text)); legend.append(item);
    });
    area.append(legend);
  }
}

export function renderValuationBands(payload, { status = 'ready', period = '1y' } = {}) {
  document.querySelectorAll('.band-panel').forEach((panel, index) => {
    const key = index === 0 ? 'peTtm' : 'pb';
    renderPanel(panel, payload?.[key], payload, index === 0 ? 'PE-TTM' : 'PB', status, period);
  });
}
