import { relationLabels, evidenceLabels } from '../features/relations-data.js';
import { relationsRefreshPresentation } from '../features/relations-ai.js';
import { relationReturnGap, summarizeRelationReturnGaps } from '../features/relations-return-gap.js';

const make = (tag, className = '', text = '') => { const n = document.createElement(tag); n.className = className; n.textContent = text; return n; };
const validNumber = value => typeof value === 'number' && Number.isFinite(value);
const numeric = (value, maximumFractionDigits = 2) => validNumber(value) ? value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits }) : '—';
const percent = value => validNumber(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${numeric(Math.abs(value))}%` : '—';
const gapNumber = value => validNumber(value) ? `${Math.abs(value)<0.005 ? '' : value > 0 ? '+' : '−'}${numeric(Math.abs(value))}%` : '—';
const tone = value => validNumber(value) && value !== 0 ? value > 0 ? 'market-up' : 'market-down' : 'market-flat';
const safeUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; } };
const statusText = { missing_base_factor: '缺少基准日复权因子', invalid_base_price: '基准日价格无效', invalid_price: '收盘价无效', insufficient_history: '历史区间不足', missing_anchor_factor: '缺少收盘日复权因子', no_prices: '日线尚未取得', missing: '数据尚未取得' };
let current = null, selected = 'all', selectCompany = null, hideGapHint = () => {};
const GAP_HINT = '上方是算术平均\n下方是去除最大最小后的均值';

function chip(text, type) { return make('span', `relation-chip relation-${type}`, text); }
function addField(area, label, value) { if (!value) return; const row = make('div', 'relation-evidence-field'); row.append(make('dt', '', label), make('dd', '', value)); area.append(row); }

function appendRefreshChanges(details, changes) {
  if (!changes.length) return;
  details.append(make('h3', 'relation-refresh-heading', '本次公司调整'));
  const list = make('ol', 'relation-refresh-changes');
  changes.forEach(change => {
    const item = make('li'), oldIdentity = `${typeof change.oldName === 'string' && change.oldName.trim() ? change.oldName : change.oldTicker}（${change.oldTicker}）`;
    const nextIdentity = change.newTicker == null ? '移除' : `${typeof change.newName === 'string' && change.newName.trim() ? change.newName : change.newTicker}（${change.newTicker}）`;
    item.append(make('strong', '', `${oldIdentity} → ${nextIdentity}`), make('p', '', change.reason));
    const sources = make('ul', 'relation-refresh-sources');
    (Array.isArray(change.sources) ? change.sources : []).forEach(source => {
      if (!source || typeof source !== 'object') return;
      const title = typeof source.title === 'string' && source.title.trim() ? source.title : '资料来源';
      const url = typeof source.url === 'string' ? safeUrl(source.url) : null;
      const row = make('li'), link = make(url ? 'a' : 'span', '', title);
      if (url) { link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      row.append(link);
      if (typeof source.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.publishedAt)) row.append(make('span', '', ` · ${source.publishedAt}`));
      sources.append(row);
    });
    if (sources.children.length) item.append(sources);
    list.append(item);
  });
  details.append(list);
}

function showEvidence(relation, trigger) {
  const dialog = document.getElementById('relation-evidence-dialog');
  document.getElementById('relation-evidence-title').textContent = `${current.subject.name} → ${relation.relatedName}`;
  const area = document.getElementById('relation-evidence-content');
  const badges = make('div', 'relation-evidence-badges'); badges.append(chip(relationLabels[relation.relationType], relation.relationType), make('span', 'relation-evidence-type', evidenceLabels[relation.evidenceType]));
  const fields = make('dl', 'relation-evidence-fields');
  const manual = relation.evidenceType === 'manual';
  addField(fields, manual ? '人工备注' : '关系理由', relation.rationale);
  if (manual) {
    addField(fields, '修改时间', new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(relation.manualUpdatedAt)));
    addField(fields, '生效日期', relation.manualEffectiveDate);
  }
  addField(fields, '实际业务法人', relation.actualEntity);
  addField(fields, '上市主体映射', relation.listedMappingBasis);
  addField(fields, '同一公司其他上市代码', relation.alternateTickers?.join('、'));
  if (relation.verifiedAt) addField(fields, '关系核验时间', new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(relation.verifiedAt)));
  addField(fields, '补充说明', relation.notes);
  const sources = make('div', 'relation-source-list');
  relation.sources.forEach((source, index) => {
    const article = make('article', 'relation-source');
    const url = safeUrl(source.url), heading = make(url ? 'a' : 'strong', '', `${index + 1}. ${source.title}${url ? ' ↗' : ''}`);
    if (url) { heading.href = url; heading.target = '_blank'; heading.rel = 'noopener noreferrer'; }
    article.append(heading);
    if (source.evidenceSummary) article.append(make('p', 'relation-source-label', '资料摘要'), make('p', 'relation-source-summary', source.evidenceSummary));
    if (source.excerpt) article.append(make('p', 'relation-source-label', '原文摘录'), make('p', 'relation-source-excerpt', source.excerpt));
    const scope = { full_text: '全文', partial_text: '相关段落', search_snippet: '检索摘要' }[source.readingScope] || '阅读范围未注明';
    article.append(make('p', 'relation-source-meta', `${source.publishedAt || '发布日期未注明'} · 核验 ${source.accessedAt.slice(0, 10)} · ${scope}`));
    sources.append(article);
  });
  area.replaceChildren(badges, fields, ...(relation.sources.length ? [make('h3', '', relation.sources.some(source => source.evidenceSummary) ? '资料依据' : '原文依据'), sources] : []));
  dialog.showModal();
  dialog.addEventListener('close', () => { if (trigger.isConnected) trigger.focus(); }, { once: true });
}

function tableRow(item, self = false, averages = {}) {
  const market = item.market;
  const returnLabel = market?.returnAdjustment === 'none' || (self ? item.ticker : item.relatedTicker).endsWith('.HK') ? '未复权价格涨跌幅' : '前复权价格回报';
  const row = make('tr', self ? 'relation-self-row' : ''), identity = make('td', 'relation-company-cell');
  if (self) identity.append(make('strong', 'relation-company-name', item.name));
  else {
    const link = make('a', 'relation-company-name', item.relatedName);
    const url = new URL(location.href); url.searchParams.set('ticker', item.relatedTicker); url.searchParams.set('company', item.relatedName); url.hash = 'relations';
    link.href = url.href; link.dataset.relationTicker = item.relatedTicker; identity.append(link);
  }
  identity.append(make('span', 'relation-company-code', self ? item.ticker : item.relatedTicker));
  if (!self && item.alternateTickers?.length) identity.append(make('span', 'relation-company-code', `${item.alternateTickers.join(' / ')} · 同一公司`));
  row.append(identity);
  const role = make('td', 'relation-role-cell');
  role.append(chip(self ? '当前标的' : relationLabels[item.relationType], self ? 'self' : item.relationType));
  if (self && !market?.tradeDate) role.append(make('span', 'relation-role-note', '暂无行情'));
  else if (!self) {
    const detail = make('button', 'relation-evidence-button', `${evidenceLabels[item.evidenceType]}${item.evidenceType === 'manual' ? '' : ' ↗'}`); detail.type = 'button'; detail.dataset.relationEvidence = item.relatedTicker; detail.setAttribute('aria-label', `查看${item.relatedName}的关系理由与证据`); role.append(detail);
  }
  row.append(role);
  const currency = market?.currency || ((self ? item.ticker : item.relatedTicker).endsWith('.HK') ? 'HKD' : 'CNY');
  const priceDigits = (self ? item.ticker : item.relatedTicker).endsWith('.HK') ? 3 : 2;
  const close = make('td', '', numeric(market?.close, priceDigits)); close.title = `未复权收盘价 · ${currency}${market?.tradeDate ? ` · 行情日 ${market.tradeDate}` : ''}`; row.append(close);
  for (const key of ['w1', 'm1', 'm6', 'y1']) {
    const value = market?.returns?.[key], cell = make('td', tone(value), percent(value));
    if (!validNumber(value)) cell.title = statusText[market?.returnStatus?.[key]] || '该区间数据或复权因子不足';
    else cell.title = `${returnLabel}${market?.returnBaseDates?.[key] ? ` · 基准日 ${market.returnBaseDates[key]}` : ''} · 不含现金股息`;
    row.append(cell);
  }
  for (const key of ['peTtm', 'pb']) {
    const value = market?.[key], loss = key === 'peTtm' && validNumber(value) && value < 0;
    const cell = make('td', loss ? 'valuation-loss' : '', loss ? '亏损' : validNumber(value) && value <= 0 ? 'N/M' : numeric(value));
    cell.title = loss ? market?.valuationAsOf ? `估值日期 ${market.valuationAsOf}` : '亏损' : validNumber(value) ? value <= 0 ? '该估值不具有正值比较意义' : `估值日期 ${market.valuationAsOf || market.tradeDate || '未取得'}` : '该收盘日估值尚未取得'; row.append(cell);
  }
  for (const key of ['w1','m6']) {
    const period=key==='w1'?'1周':'6个月';
    const result=self ? averages[key] : relationReturnGap(current.subject.market,market,key);
    const value=result?.value;
    const cell=make('td',`relation-return-gap${self ? ' relation-gap-summary' : ` ${tone(value)}`}`,self ? '' : gapNumber(value));
    cell.dataset.returnGap=key;
    const description=self
      ? `上方：均值 ${gapNumber(value)}\n下方：去除最大、最小值后的均值 ${gapNumber(result?.trimmedValue)}\n${period}差值＝当前标的涨跌幅 − 当前筛选关联股涨跌幅 · 有效 ${result?.count??0}/${result?.total??0} 家${validNumber(value)?'': ' · 暂无可比较数据'}\n去掉一个最大值和一个最小值 · 剩余 ${result?.trimmedCount??0} 家${validNumber(result?.trimmedValue)?'':' · 至少需要 3 家有效数据'}`
      : validNumber(value)?`${period}差值＝当前标的涨跌幅 − ${item.relatedName}涨跌幅 · 以%显示 · 正数为当前标的跑赢，负数为跑输`
        : result?.reason || '暂无可比较数据';
    if (self) {
      cell.dataset.gapHint=GAP_HINT;
      cell.setAttribute('aria-description',description);
      cell.setAttribute('aria-describedby','relation-gap-tooltip');
      cell.setAttribute('tabindex','0');
    } else cell.title=description;
    if (self) {
      const average=make('span',`relation-gap-average ${tone(value)}`,gapNumber(value));
      average.dataset.gapStatistic='average';
      average.setAttribute('aria-label',`${period}差值平均 ${gapNumber(value)}`);
      const trimmed=make('span',`relation-gap-trimmed ${tone(result?.trimmedValue)}`,gapNumber(result?.trimmedValue));
      trimmed.dataset.gapStatistic='trimmed';
      trimmed.setAttribute('aria-label',`${period}差值去掉一个最大值和一个最小值后的平均 ${gapNumber(result?.trimmedValue)}`);
      trimmed.setAttribute('aria-description',`去除最大、最小值后的均值：${gapNumber(result?.trimmedValue)}\n${validNumber(result?.trimmedValue)
        ? `${period}差值各去掉一个最大值和一个最小值后取平均 · 剩余 ${result.trimmedCount} 家`
        : '至少需要 3 家有效数据，去掉一个最大值和一个最小值后才能计算'}`);
      cell.append(average,trimmed);
    }
    row.append(cell);
  }
  return row;
}

function renderRows() {
  document.dispatchEvent?.(new CustomEvent('relation-comparison-filter',{detail:{scope:selected}}));
  hideGapHint();
  const body = document.getElementById('relation-table-body'); if (!current) return;
  const rows = current.relations.filter(item => selected === 'all' || item.relationType === selected);
  const averages=Object.fromEntries(['w1','m6'].map(key=>[key,summarizeRelationReturnGaps(current.subject.market,rows,key)]));
  body.replaceChildren(tableRow(current.subject, true, averages), ...rows.map(item => tableRow(item)));
  document.querySelectorAll('[data-relation-filter]').forEach(button => { const active = button.dataset.relationFilter === selected; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
  const note = document.getElementById('relation-filter-note'); note.hidden = rows.length > 0; note.textContent = '该类暂未保存关联公司';
}

export function initRelations({ onSelect }) {
  selectCompany = onSelect;
  const section = document.getElementById('relations'), dialog = document.getElementById('relation-evidence-dialog');
  const hint = make('div','relation-gap-tooltip',GAP_HINT);
  hint.id='relation-gap-tooltip'; hint.hidden=true; hint.setAttribute('role','tooltip');
  section.append(hint);
  let hintCell=null;
  hideGapHint=()=>{ hint.hidden=true; hintCell=null; };
  const showHint=target=>{
    const cell=target?.closest?.('[data-gap-hint]');
    if (!cell) { hideGapHint(); return; }
    if (hintCell===cell && !hint.hidden) return;
    hintCell=cell; hint.hidden=false;
    const rect=cell.getBoundingClientRect(), box=hint.getBoundingClientRect();
    hint.style.left=`${Math.max(8,Math.min(window.innerWidth-box.width-8,rect.right-box.width))}px`;
    hint.style.top=`${Math.max(8,rect.bottom+box.height+14<=window.innerHeight?rect.bottom+6:rect.top-box.height-6)}px`;
  };
  section.addEventListener('pointerover',event=>showHint(event.target));
  section.addEventListener('pointerout',event=>{ if (!hintCell?.contains(event.relatedTarget)) hideGapHint(); });
  section.addEventListener('focusin',event=>showHint(event.target));
  section.addEventListener('focusout',hideGapHint);
  section.addEventListener('keydown',event=>{ if(event.key==='Escape') hideGapHint(); });
  section.addEventListener('scroll',hideGapHint,true);
  if (typeof window!=='undefined') {
    window.addEventListener('scroll',hideGapHint,true);
    window.addEventListener('resize',hideGapHint);
  }
  section.addEventListener('click', event => {
    const filter = event.target.closest('[data-relation-filter]');
    if (filter && current) { selected = filter.dataset.relationFilter; renderRows(); return; }
    const evidence = event.target.closest('[data-relation-evidence]');
    if (evidence && current) { const item = current.relations.find(r => r.relatedTicker === evidence.dataset.relationEvidence); if (item) showEvidence(item, evidence); return; }
    const link = event.target.closest('[data-relation-ticker]');
    if (link && current && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
      event.preventDefault(); const item = current.relations.find(r => r.relatedTicker === link.dataset.relationTicker);
      if (item && selectCompany?.({ ticker: item.relatedTicker, name: item.relatedName }) !== false) document.getElementById('relations').scrollIntoView({ block: 'start' });
    }
  });
  document.getElementById('close-relation-evidence').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); });
}

export function renderRelations(data, { status = 'ready', ticker = '', asOf = '', error = '' } = {}) {
  hideGapHint();
  if (status === 'loading' || status === 'error') data = null;
  current = data; selected = 'all';
  const dialog = document.getElementById('relation-evidence-dialog'); if (dialog.open) dialog.close();
  const empty = document.getElementById('relations-empty'), content = document.getElementById('relations-content'), badge = document.getElementById('relations-status');
  const loading = status === 'loading', available = data?.relations?.length > 0;
  const marketDates = [...new Set([data?.subject, ...(data?.relations || [])].map(item => item?.market?.tradeDate).filter(Boolean))].sort();
  const marketContext = marketDates.length ? `行情 ${marketDates[0]}${marketDates.length > 1 ? ` — ${marketDates.at(-1)}` : ''}` : '';
  document.getElementById('relations-context').textContent = marketContext;
  document.getElementById('relation-table-body').replaceChildren();
  document.getElementById('relation-coverage').replaceChildren();
  document.getElementById('relation-filter-note').hidden = true;
  content.hidden = !available; empty.hidden = Boolean(available);
  const count = data?.relations?.length || 0;
  const customized = data?.status === 'customized' || data?.meta?.hasManualChanges === true;
  const aiOrigin = data?.meta?.origin === 'ai' || data?.meta?.relationSource === 'ai';
  const aiNote = typeof data?.meta?.aiResultNote === 'string' ? data.meta.aiResultNote.trim() : '';
  const refresh = relationsRefreshPresentation(data?.meta?.refreshSummary);
  badge.textContent = loading ? '正在读取' : customized ? `已保存 ${count} 家 · 人工修改` : available ? aiOrigin ? `已保存 ${count} 家 · AI识别` : `已保存 ${count} 家` : status === 'error' ? '读取失败' : '暂未保存';
  empty.classList.toggle('relation-error', status === 'error');
  empty.querySelector('strong').textContent = loading ? '正在读取关联公司' : status === 'error' ? '暂时无法读取关系数据' : data?.meta?.knownTicker === false ? '证券不在本地股票库中' : data?.status === 'not_available_as_of' ? '该截止日暂无可用关系' : customized ? '当前未保留关联公司' : '当前标的暂无已保存关系';
  const emptyNote = empty.querySelector('p');
  emptyNote.textContent = status === 'error' ? error || '请稍后刷新重试。' : [aiNote, data?.status === 'not_available_as_of' ? '请调整研究截止日期。' : ''].filter(Boolean).join(' ');
  emptyNote.hidden = !emptyNote.textContent;
  document.querySelectorAll('[data-relation-filter]').forEach(button => {
    const type = button.dataset.relationFilter, count = data?.counts?.[type === 'all' ? 'total' : type];
    button.querySelector('b').textContent = count == null ? '—' : String(count); button.disabled = !available;
    button.classList.toggle('selected', type === 'all'); button.setAttribute('aria-pressed', String(type === 'all'));
  });
  const gaps = [...new Set((Array.isArray(data?.gaps) ? data.gaps : []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  if (!available && !gaps.length && !refresh) return;
  const coverage = document.getElementById('relation-coverage');
  if (aiNote && available) coverage.append(make('p', 'relation-result-note', aiNote));
  const details = make('details', 'relation-coverage-details'), summary = make('summary', '', '研究说明'); details.append(summary);
  details.append(make('p', 'relation-research-dates', `研究截止 ${data.asOf}${data.relationAsOf ? ` · 关系研究 ${data.relationAsOf}` : ''}`));
  if (available || refresh) details.append(make('p', 'relation-storage-note', '每只股票保留一份当前关系，最多 10 家；AI 优先保留已有公司、更新依据，有空位再补充，替换须有充分理由及来源；人工可直接修改，失败保留原内容。'));
  if (refresh) {
    details.append(make('p', 'relation-refresh-summary', refresh.text));
    appendRefreshChanges(details, refresh.changes);
  }
  if (available && count < 10 && !customized) details.append(make('p', 'relation-coverage-note', `本次资料不足以支持 10 家，已保存 ${count} 家，不为凑数加入缺少依据的公司。`));
  const list = make('ul');
  [...gaps, ...(available ? ['产业链位置仅表示业务环节关联；直接业务、技术合作和业务可比分别标注，详情见各行依据。'] : [])].forEach(text => list.append(make('li', '', text)));
  details.append(list);
  if (available) details.append(make('p', 'relations-footnote', '区间价格表现不含现金股息。1 周取前 5 个交易日，其余取研究截止日减对应日历区间当日或之前最近收盘。A 股按复权因子计算前复权价格回报；港股为未复权价格涨跌幅，未调整除权与拆并股。收盘价均未复权，A 股为人民币，港股按实际柜台为港元或美元，悬停各行收盘价查看币种；PE-TTM / PB 对齐各行行情日。PE 负值显示亏损，零值显示 N/M，缺失显示 —；PB 非正值时显示 N/M。缺少行情、区间或 A 股复权因子时显示 —。悬停收盘价可查看各股行情日。'));
  if (available) details.append(make('p', 'relation-gap-note', '差值＝当前标的涨跌幅 − 关联股涨跌幅，以%显示；正数表示当前标的跑赢。当前标的行上方显示当前筛选公司的等权平均，下方显示去掉一个最大值和一个最小值后的平均；有效数据不足 3 家时下方显示 —。缺失或区间日期不一致的数据不计入。'));
  coverage.append(details);
  if (available) renderRows();
}
