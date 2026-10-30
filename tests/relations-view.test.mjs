import test from 'node:test';
import assert from 'node:assert/strict';
import { initRelations, renderRelations } from '../frontend/src/views/relations-view.js';
import { adaptRelations } from '../frontend/src/features/relations-data.js';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.className = ''; this.textContent = ''; this.children = [];
    this.parentElement = null; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
    this.hidden = false; this.disabled = false; this.open = false; this.isConnected = true;
    this.classList = { toggle: (name, enabled) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
    } };
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  fire(type, properties = {}) {
    const event = { target: this, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }
  querySelector(selector) { return descendants(this).find(node => node.tagName === selector.toUpperCase()) || null; }
  closest(selector) {
    const key = selector.match(/^\[data-([^\]]+)\]$/)?.[1]?.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    for (let node = this; node; node = node.parentElement) if (key && Object.hasOwn(node.dataset, key)) return node;
    return null;
  }
  contains(target) { return target===this || descendants(this).includes(target); }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
}

function descendants(element) { return element.children.flatMap(child => [child, ...descendants(child)]); }
function allText(element) { return [element.textContent, ...element.children.map(allText)].join(' '); }

function fixture(t) {
  const ids = ['relations', 'relation-evidence-dialog', 'relation-evidence-title', 'relation-evidence-content', 'close-relation-evidence', 'relation-table-body', 'relation-filter-note', 'relations-empty', 'relations-content', 'relations-status', 'relations-context', 'relation-coverage'];
  const elements = new Map(ids.map(id => [id, new Element()]));
  elements.get('relations-empty').append(new Element('strong'), new Element('p'));
  const filters = ['all', 'upstream', 'peer', 'downstream'].map(type => {
    const button = new Element('button'); button.dataset.relationFilter = type; button.append(new Element('b')); return button;
  });
  const oldDocument = globalThis.document, oldLocation = globalThis.location;
  globalThis.document = { createElement: tag => new Element(tag), getElementById: id => elements.get(id), querySelectorAll: selector => selector === '[data-relation-filter]' ? filters : [] };
  globalThis.location = { href: 'http://example.test/?ticker=601127.SH#relations' };
  t.after(() => { globalThis.document = oldDocument; globalThis.location = oldLocation; });
  const selected = [];
  initRelations({ onSelect: company => selected.push(company) });
  return {
    byId: id => elements.get(id), filters, selected,
    click: target => elements.get('relations').fire('click', { target }),
    rows: () => elements.get('relation-table-body').children,
  };
}

function report(count, { ticker = '601127.SH', name = '赛力斯', type = 'upstream' } = {}) {
  return adaptRelations({
    ticker, asOf: '2026-10-15', relationAsOf: '2026-10-15', status: count === 10 ? 'complete' : count ? 'partial' : 'not_researched',
    subject: { name, market: null }, gaps: count < 10 ? ['同行、下游待补齐'] : [],
    relations: Array.from({ length: count }, (_, index) => ({
      relatedTicker: `${String(300001 + index)}.SZ`, relatedName: `已核实公司 ${index + 1}`,
      relationType: type, evidenceType: type === 'peer' ? 'business_comparable' : 'direct_business',
      rationale: `已核实的${type === 'peer' ? '可比业务' : '供应链关系'}`, actualEntity: '实际业务公司', market: null,
      sources: [{ url: 'https://example.com/disclosure', title: '公司公开披露', excerpt: '明确披露的关系原文。', publishedAt: '2026-10-14', accessedAt: '2026-10-15T00:00:00Z', readingScope: 'partial_text' }],
    })),
  });
}

const comparisonMarket=(w1,m6,changes={})=>({tradeDate:'2026-10-14',returns:{w1,m6},
  returnStatus:{w1:'available',m6:'available'},returnBaseDates:{w1:'2026-10-07',m6:'2026-04-15'},...changes});
const summaryValues=cell=>cell.children.map(node=>node.textContent);

test('新增两列按当前标的减关联股显示百分号差值，当前行显示当前筛选平均',t=>{
  const f=fixture(t),data=report(2);
  data.subject.market=comparisonMarket(0.11,-30.33);
  data.relations[0].market=comparisonMarket(-1.55,-8.13);
  data.relations[1].relationType='peer';data.relations[1].evidenceType='business_comparable';
  data.relations[1].market=comparisonMarket(1.30,-56.83);
  renderRelations(data);
  assert.equal(f.rows()[1].children[9].textContent,'+1.66%');
  assert.equal(f.rows()[1].children[10].textContent,'−22.20%');
  assert.match(f.rows()[1].children[9].className,/market-up/);
  assert.match(f.rows()[1].children[10].className,/market-down/);
  assert.match(f.rows()[1].children[9].title,/当前标的.*%.*正数/);
  assert.deepEqual(summaryValues(f.rows()[0].children[9]),['+0.24%','—']);
  assert.deepEqual(summaryValues(f.rows()[0].children[10]),['+2.15%','—']);
  assert.match(f.rows()[0].children[9].attributes.get('aria-description'),/有效 2\/2 家/);
  assert.match(f.rows()[0].children[9].children[1].attributes.get('aria-description'),/至少需要 3 家/);
  f.click(f.filters[1]);
  assert.equal(f.rows().length,2);assert.deepEqual(summaryValues(f.rows()[0].children[9]),['+1.66%','—']);
  assert.deepEqual(summaryValues(f.rows()[0].children[10]),['−22.20%','—']);
  f.click(f.filters[2]);
  assert.deepEqual(summaryValues(f.rows()[0].children[9]),['−1.19%','—']);
  assert.deepEqual(summaryValues(f.rows()[0].children[10]),['+26.50%','—']);
  f.click(f.filters[3]);
  assert.equal(f.rows().length,1);assert.deepEqual(summaryValues(f.rows()[0].children[9]),['—','—']);
  assert.match(f.rows()[0].children[9].attributes.get('aria-description'),/有效 0\/0 家/);
});

test('差值平均分别排除缺失和异日区间，零差值保留，切股不会沿用上次平均',t=>{
  const f=fixture(t),data=report(5);
  data.subject.market=comparisonMarket(0.11,-30.33);
  data.relations[0].market=comparisonMarket(-1.55,-8.13);
  data.relations[1].market=comparisonMarket(1.30,-56.83);
  data.relations[2].market=comparisonMarket(null,-20.33);
  data.relations[3].market=comparisonMarket(12,15,{tradeDate:'2026-10-13'});
  data.relations[4].market=comparisonMarket(0.11,null);
  renderRelations(data);
  assert.deepEqual(summaryValues(f.rows()[0].children[9]),['+0.16%','0.00%']);
  assert.deepEqual(summaryValues(f.rows()[0].children[10]),['−1.90%','−10.00%']);
  assert.match(f.rows()[0].children[9].attributes.get('aria-description'),/有效 3\/5 家/);
  assert.match(f.rows()[0].children[10].attributes.get('aria-description'),/有效 3\/5 家/);
  assert.equal(f.rows()[3].children[9].textContent,'—');
  assert.equal(f.rows()[4].children[9].textContent,'—');
  assert.match(f.rows()[4].children[9].title,/日期/);
  assert.equal(f.rows()[5].children[9].textContent,'0.00%');
  assert.match(f.rows()[5].children[9].className,/market-flat/);
  const another=report(1,{ticker:'00700.HK',name:'腾讯控股'});
  renderRelations(another);
  assert.deepEqual(summaryValues(f.rows()[0].children[9]),['—','—']);assert.deepEqual(summaryValues(f.rows()[0].children[10]),['—','—']);
});

test('当前行两列分别展示普通平均和去极值平均，切换分类后重算且各数字保留自身颜色',t=>{
  const f=fixture(t),data=report(5);
  data.subject.market=comparisonMarket(0,0);
  const values=[[-100,100],[-1,1],[-3,3],[-5,5],[20,-20]];
  data.relations.forEach((relation,index)=>{
    relation.market=comparisonMarket(...values[index]);
    if(index===4)relation.relationType='peer';
  });
  renderRelations(data);
  const week=f.rows()[0].children[9],sixMonths=f.rows()[0].children[10];
  assert.deepEqual(summaryValues(week),['+17.80%','+3.00%']);
  assert.deepEqual(summaryValues(sixMonths),['−17.80%','−3.00%']);
  assert.match(week.children[1].className,/market-up/);
  assert.match(sixMonths.children[1].className,/market-down/);
  assert.equal(week.children[1].dataset.gapStatistic,'trimmed');
  assert.match(week.children[1].attributes.get('aria-label'),/1周.*去掉一个最大值和一个最小值.*\+3\.00%/);
  assert.match(week.attributes.get('aria-description'),/上方：均值 \+17\.80%\n下方：去除最大、最小值后的均值 \+3\.00%/);
  assert.equal(week.children[0].title,undefined);
  assert.equal(week.title,undefined);
  assert.equal(week.dataset.gapHint,'上方是算术平均\n下方是去除最大最小后的均值');
  assert.match(week.children[1].attributes.get('aria-description'),/^去除最大、最小值后的均值：\+3\.00%/);
  assert.match(sixMonths.attributes.get('aria-description'),/上方：均值 −17\.80%\n下方：去除最大、最小值后的均值 −3\.00%/);
  assert.match(week.children[1].attributes.get('aria-description'),/剩余 3 家/);
  assert.doesNotMatch(allText(week),/均值|平均/);
  assert.equal(f.rows()[1].children[9].children.length,0);
  assert.match(allText(f.byId('relation-coverage')),/上方.*等权平均.*下方.*去掉一个最大值和一个最小值.*不足 3 家/s);
  f.click(f.filters[1]);
  assert.deepEqual(summaryValues(f.rows()[0].children[9]),['+27.25%','+4.00%']);
  assert.deepEqual(summaryValues(f.rows()[0].children[10]),['−27.25%','−4.00%']);
  assert.match(f.rows()[0].children[9].children[1].attributes.get('aria-description'),/剩余 2 家/);
});

test('数字和格子悬停立即显示同一说明，移出或按Escape关闭，无原生延迟提示',t=>{
  const f=fixture(t),data=report(3);
  data.subject.market=comparisonMarket(0,0);
  data.relations.forEach((relation,index)=>{relation.market=comparisonMarket(index,index);});
  renderRelations(data);
  const section=f.byId('relations'),cell=f.rows()[0].children[9];
  const hint=descendants(section).find(node=>node.className==='relation-gap-tooltip');
  const oldWindow=globalThis.window;
  globalThis.window={innerWidth:1280,innerHeight:720};
  t.after(()=>{globalThis.window=oldWindow;});
  cell.getBoundingClientRect=()=>({right:1100,top:500,bottom:575});
  hint.getBoundingClientRect=()=>({width:260,height:60});hint.style={};
  assert.equal(hint.hidden,true);
  section.fire('pointerover',{target:cell.children[0]});
  assert.equal(hint.hidden,false);
  assert.equal(hint.textContent,'上方是算术平均\n下方是去除最大最小后的均值');
  assert.equal(hint.style.left,'840px');assert.equal(hint.style.top,'581px');
  section.fire('pointerout',{target:cell.children[0],relatedTarget:cell.children[1]});
  assert.equal(hint.hidden,false);
  section.fire('pointerout',{target:cell.children[1],relatedTarget:null});
  assert.equal(hint.hidden,true);
  section.fire('pointerover',{target:cell});assert.equal(hint.hidden,false);
  section.fire('keydown',{key:'Escape'});assert.equal(hint.hidden,true);
  assert.equal(cell.title,undefined);
  assert.ok(cell.children.every(node=>node.title===undefined));
});

test('普通平均和去极值平均正负不同也各自着色',t=>{
  const f=fixture(t),data=report(3);
  data.subject.market=comparisonMarket(0,0);
  [[100,-100],[-1,1],[-2,2]].forEach((values,index)=>{data.relations[index].market=comparisonMarket(...values);});
  renderRelations(data);
  assert.deepEqual(summaryValues(f.rows()[0].children[9]),['−32.33%','+1.00%']);
  assert.deepEqual(summaryValues(f.rows()[0].children[10]),['+32.33%','−1.00%']);
  assert.match(f.rows()[0].children[9].children[0].className,/market-down/);
  assert.match(f.rows()[0].children[9].children[1].className,/market-up/);
  assert.match(f.rows()[0].children[10].children[0].className,/market-up/);
  assert.match(f.rows()[0].children[10].children[1].className,/market-down/);
});

test('港股subject与已核实A股关系照常展示，空港股价格不借用同行且币种按行注明', t => {
  const f = fixture(t), data = report(1, { ticker: '00700.HK', name: '腾讯控股', type: 'peer' });
  data.relations[0].market = { close: 12.34, currency: 'CNY', tradeDate: '2026-10-14', returns: {} };
  renderRelations(data, { ticker: '00700.HK', asOf: data.asOf });
  assert.equal(f.rows().length, 2); assert.match(allText(f.rows()[0]), /腾讯控股.*00700.HK/);
  assert.equal(f.rows()[0].children[2].textContent, '—'); assert.equal(f.rows()[0].children[2].title, '未复权收盘价 · HKD');
  assert.equal(f.rows()[1].children[2].textContent, '12.34'); assert.equal(f.rows()[1].children[2].title, '未复权收盘价 · CNY · 行情日 2026-10-14');
  assert.equal(f.byId('relations-context').textContent, '行情 2026-10-14');
  assert.equal(f.byId('relations-empty').hidden, true);
  assert.equal(f.rows()[0].children[7].textContent, '—');
  assert.equal(f.rows()[1].children[7].textContent, '—');
});

test('当前港股展示自身收盘和各期涨跌幅，并明确未复权口径及缺失区间原因', t => {
  const f = fixture(t), data = report(1, { ticker: '02313.HK', name: '申洲国际', type: 'peer' });
  data.subject.market = { close: 37.34, currency: 'HKD', tradeDate: '2026-10-14', valuationAsOf: '2026-10-14', peTtm: 10.7, pb: 1.31,
    returnAdjustment: 'none', returns: { w1: 3.87, m1: -2.5, m6: 0, y1: null }, returnStatus: { y1: 'insufficient_history' }, returnBaseDates: { w1: '2026-10-07' } };
  data.relations[0].market = { close: 12.34, currency: 'CNY', tradeDate: '2026-10-14', returns: {} };
  renderRelations(data);
  const cells = f.rows()[0].children;
  assert.match(allText(cells[1]), /当前标的/);
  assert.doesNotMatch(allText(cells[1]), /未复权|前复权/);
  assert.match(allText(f.byId('relation-coverage')), /港股为未复权价格涨跌幅/);
  assert.equal(cells.length, 11);
  assert.deepEqual(cells.slice(2,9).map(cell => cell.textContent), ['37.34', '+3.87%', '−2.50%', '0.00%', '—', '10.70', '1.31']);
  assert.equal(cells[2].title, '未复权收盘价 · HKD · 行情日 2026-10-14');
  assert.equal(f.byId('relations-context').textContent, '行情 2026-10-14');
  assert.equal(cells[3].className, 'market-up'); assert.equal(cells[4].className, 'market-down');
  assert.match(cells[3].title, /未复权价格涨跌幅.*2026-10-07.*不含现金股息/);
  assert.equal(cells[6].title, '历史区间不足');
  f.click(f.filters[1]);
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].children[2].textContent, '37.34');
});

test('美元港股主体按USD标注收盘价并保留币种说明',t=>{
  const f=fixture(t),data=report(1,{ticker:'00770.HK',name:'SHANGHAI GROWTH'});
  data.subject.market={close:0.165,currency:'USD',tradeDate:'2026-10-14',returns:{}};
  renderRelations(data);
  assert.equal(f.rows()[0].children[2].title,'未复权收盘价 · USD · 行情日 2026-10-14');
  assert.equal(f.rows()[0].children[7].textContent,'—');
  assert.match(allText(f.byId('relation-coverage')),/港元或美元/);
});

test('港股收盘0.012保留三位且至少两位，A股价格、估值及涨跌幅仍为两位',t=>{
  const f=fixture(t),data=report(2,{ticker:'00030.HK',name:'港股仙股'});
  data.subject.market={close:0.012,currency:'HKD',tradeDate:'2026-10-16',peTtm:12.345,pb:1.235,returns:{w1:0.123}};
  data.relations[0].market={close:1.234,currency:'CNY',tradeDate:'2026-10-16',returns:{}};
  data.relations[1].relatedTicker='00770.HK';
  data.relations[1].market={close:0.012,currency:'USD',tradeDate:'2026-10-16',returns:{}};
  renderRelations(data);
  assert.equal(f.rows()[0].children[2].textContent,'0.012');
  assert.equal(f.rows()[1].children[2].textContent,'1.23');
  assert.equal(f.rows()[2].children[2].textContent,'0.012');
  assert.equal(f.rows()[0].children[3].textContent,'+0.12%');
  assert.equal(f.rows()[0].children[7].textContent,'12.35');
  assert.equal(f.rows()[0].children[8].textContent,'1.24');
  data.subject.market.close=1.2;renderRelations(data);
  assert.equal(f.rows()[0].children[2].textContent,'1.20');
});

test('关联公司PE明确负值才显示亏损，缺失显示—、零值显示N/M，PB原有空值和N/M不变', t => {
  const f = fixture(t), data = report(7);
  const peValues = [null, 0, -2, Number.NaN, Infinity, '12.5', 12.5];
  data.relations.forEach((item, index) => {
    item.relatedTicker = index % 2 ? '00700.HK' : item.relatedTicker;
    item.market = { peTtm: peValues[index], pb: index === 0 ? null : index === 1 ? -1 : 1.3, valuationAsOf: '2026-10-14' };
  });
  renderRelations(data);
  assert.deepEqual(f.rows().map(row => row.children[7].textContent), ['—', '—', 'N/M', '亏损', '—', '—', '—', '12.50']);
  assert.equal(f.rows()[0].children[7].title, '该收盘日估值尚未取得');
  assert.equal(f.rows()[3].children[7].title, '估值日期 2026-10-14');
  assert.equal(f.rows()[2].children[7].title, '该估值不具有正值比较意义');
  assert.deepEqual(f.rows().slice(1, 4).map(row => row.children[8].textContent), ['—', 'N/M', '1.30']);
});

test('行情日期覆盖当前标的和全部关联公司，异日展示区间且不随分类筛选改变', t => {
  const f = fixture(t), data = report(3);
  data.subject.market = { close: 20, currency: 'CNY', tradeDate: '2026-10-10', returns: {} };
  data.relations[0].market = { close: 10, currency: 'CNY', tradeDate: '2026-10-12', returns: {} };
  data.relations[1].market = { close: 11, currency: 'CNY', tradeDate: '2026-10-14', returns: {} };
  data.relations[1].relationType = 'peer';
  renderRelations(data);
  const context = '行情 2026-10-10 — 2026-10-14';
  assert.equal(f.byId('relations-context').textContent, context);
  assert.ok(f.rows().every(row => row.children.length === 11));
  assert.equal(f.rows()[0].children[2].title, '未复权收盘价 · CNY · 行情日 2026-10-10');
  assert.equal(f.rows()[3].children[2].title, '未复权收盘价 · CNY');
  f.click(f.filters[1]);
  assert.equal(f.rows().length, 3);
  assert.equal(f.byId('relations-context').textContent, context);
  f.click(f.filters[2]);
  assert.equal(f.rows().length, 2);
  assert.equal(f.byId('relations-context').textContent, context);
});

for (const count of [1, 7]) {
  test(`已核实 ${count} 家即展示本标的和全部已有关系，行情全空也保留公司与证据`, t => {
    const f = fixture(t), data = report(count);
    renderRelations(data);
    assert.equal(f.byId('relations-content').hidden, false);
    assert.equal(f.byId('relations-empty').hidden, true);
    assert.equal(f.byId('relations-status').textContent, `已保存 ${count} 家`);
    assert.equal(f.byId('relations-context').textContent, '');
    assert.match(allText(f.byId('relation-coverage')), /研究截止 2026-10-15 · 关系研究 2026-10-15/);
    assert.equal(f.rows().length, count + 1);
    assert.ok(f.rows().every(row => row.children.length === 11));
    assert.match(allText(f.rows()[0]), /赛力斯.*601127.SH/);
    for (let index = 1; index <= count; index++) {
      const row = f.rows()[index];
      assert.match(allText(row), new RegExp(`已核实公司 ${index}.*上游.*直接业务 ↗`));
      assert.deepEqual(row.children.slice(2).map(cell => cell.textContent), Array(9).fill('—'));
    }
    assert.equal(f.filters[0].querySelector('b').textContent, String(count));
    const evidence = descendants(f.rows()[1]).find(node => node.dataset.relationEvidence);
    f.click(evidence);
    assert.equal(f.byId('relation-evidence-dialog').open, true);
    assert.equal(f.byId('relation-evidence-title').textContent, '赛力斯 → 已核实公司 1');
    assert.match(allText(f.byId('relation-evidence-content')), /已核实的供应链关系.*公司公开披露.*明确披露的关系原文/);
    assert.equal(f.byId('relation-coverage').children[0].open, false);
    const coverage = f.byId('relation-coverage').children[0];
    assert.equal(coverage.children[0].textContent, '研究说明');
    assert.match(allText(coverage), /同行、下游待补齐.*不含现金股息.*前复权价格回报/s);
  });
}

test('10 家已保存关系显示真实计数，未填充额外占位公司', t => {
  const f = fixture(t); renderRelations(report(10));
  assert.equal(f.rows().length, 11);
  assert.equal(f.byId('relations-status').textContent, '已保存 10 家');
  assert.doesNotMatch(allText(f.byId('relations-content')), /未研究|尚未研究/);
});

test('AI 关系明确标记 AI识别，保留证据入口与人工修改覆盖标记', t => {
  const f = fixture(t), data = report(2);
  data.meta = { origin: 'ai', researchProvider: 'deepseek' };
  renderRelations(data);
  assert.equal(f.byId('relations-status').textContent, '已保存 2 家 · AI识别');
  assert.equal(f.rows().length, 3);
  const evidence = descendants(f.rows()[1]).find(node => node.dataset.relationEvidence);
  f.click(evidence); assert.equal(f.byId('relation-evidence-dialog').open, true);
  data.status = 'customized'; data.meta.hasManualChanges = true;
  renderRelations(data); assert.equal(f.byId('relations-status').textContent, '已保存 2 家 · 人工修改');
});

test('数据库 relationSource AI 标记显示 AI识别；0 结果与失败保留说明在空态或已有表格旁可见', t => {
  const f = fixture(t), data = report(1);
  data.meta = { relationSource: 'ai', aiResultNote: '最近一次 AI 识别失败，已保留此前关系及人工修正。' };
  renderRelations(data); assert.equal(f.byId('relations-status').textContent, '已保存 1 家 · AI识别');
  assert.equal(f.byId('relations-content').hidden, false); assert.equal(f.rows().length, 2);
  assert.match(f.byId('relation-coverage').children[0].textContent, /失败.*保留此前关系/);
  const empty = report(0); empty.meta = { relationSource: 'ai', aiResultNote: '最近一次 AI 识别未找到足够证据支持的关系。未填充未经证实的公司。' };
  renderRelations(empty); assert.equal(f.byId('relations-status').textContent, '暂未保存');
  assert.equal(f.byId('relations-empty').querySelector('p').hidden, false);
  assert.match(f.byId('relations-empty').querySelector('p').textContent, /未找到足够证据.*未填充/);
});

test('AI 港股关系的新来源 sourceId 保留并展示正文、真实链接及发布日期，人工覆盖不展示AI原文', t => {
  const f = fixture(t), raw = report(1, { ticker: '00700.HK', name: '腾讯控股', type: 'peer' });
  raw.meta = { relationSource: 'ai' };
  Object.assign(raw.relations[0], { relatedTicker: '09988.HK', relatedName: '阿里巴巴', verifiedAt: '2026-10-15T03:00:00Z',
    sources: [{ sourceId: 's8', url: 'https://example.com/announcement', title: '公司公告原文', excerpt: '双方业务可比的已读取段落。', publishedAt: '2026-10-14', accessedAt: '2026-10-15T02:00:00Z', readingScope: 'partial_text' }] });
  const data = adaptRelations(raw); assert.equal(data.relations[0].sources[0].sourceId, 's8');
  renderRelations(data); f.click(descendants(f.rows()[1]).find(node => node.dataset.relationEvidence));
  const content = f.byId('relation-evidence-content');
  assert.match(allText(content), /阿里巴巴|业务可比/);
  assert.match(allText(content), /公司公告原文.*双方业务可比的已读取段落.*2026-10-14.*相关段落/s);
  assert.equal(descendants(content).find(node => node.tagName === 'A').href, 'https://example.com/announcement');
  Object.assign(data.relations[0], { evidenceType: 'manual', origin: 'manual', sources: [], rationale: '人工优先备注', manualUpdatedAt: '2026-10-15T04:00:00Z', manualEffectiveDate: '2026-10-15' });
  data.status = 'customized'; data.meta.hasManualChanges = true;
  renderRelations(data); f.click(descendants(f.rows()[1]).find(node => node.dataset.relationEvidence));
  assert.equal(f.byId('relations-status').textContent, '已保存 1 家 · 人工修改');
  assert.match(allText(content), /人工优先备注/); assert.doesNotMatch(allText(content), /公司公告原文|原文依据/);
});

test('当前最多10家公司显示真实分类及保留优先规则，人工可自由修改', t => {
  const f = fixture(t), data = report(10);
  data.meta = { relationSource: 'ai', targetCount: 10 };
  data.gaps = [];
  data.relations[9].relationType = 'downstream'; data.counts = { total: 10, upstream: 9, peer: 0, downstream: 1 };
  renderRelations(data);
  assert.equal(f.rows().length, 11); assert.equal(f.byId('relations-status').textContent, '已保存 10 家 · AI识别');
  assert.deepEqual(f.filters.map(button => button.querySelector('b').textContent), ['10', '9', '0', '1']);
  assert.match(allText(f.byId('relation-coverage')), /每只股票保留一份当前关系，最多 10 家.*优先保留已有公司.*空位再补充.*替换须有充分理由及来源.*人工可直接修改.*失败保留原内容/s);
  assert.doesNotMatch(allText(f.byId('relation-coverage')), /本次公司调整|保留 \d+ 家，新增/);
  assert.doesNotMatch(allText(f.byId('relation-coverage')), /合并|累计/);
  assert.doesNotMatch(allText(f.byId('relations-status')), /待补齐|目标|完整/);
  f.click(f.filters[3]); assert.equal(f.rows().length, 2);
  assert.match(allText(f.rows()[1]), /已核实公司 10/);
  renderRelations(report(3));
  assert.match(allText(f.byId('relation-coverage')), /本次资料不足以支持 10 家，已保存 3 家，不为凑数/);
});

test('刷新摘要显示真实保留新增替换数，研究说明内可查看换股和移除理由及来源', t => {
  const f = fixture(t), data = report(9);
  data.meta = { relationSource: 'ai', refreshSummary: { retainedCount: 7, addedCount: 2, removedCount: 2, blockedCount: 1, changes: [
    { oldTicker: '600000.SH', oldName: '原公司一', newTicker: '600001.SH', newName: '新公司一', reasonCode: 'business_exit',
      reason: '原公司已退出相关业务，新公司具有更明确的业务依据。', sources: [{ title: '业务剥离公告', url: 'https://example.com/exit', publishedAt: '2026-10-14' }] },
    { oldTicker: '600002.SH', oldName: '原公司二', newTicker: null, newName: null, reasonCode: 'delisted',
      reason: '原公司已退市。', sources: [{ title: '退市公告', url: 'http://example.com/delisted', publishedAt: null }] },
  ] } };
  const adapted = adaptRelations(data); renderRelations(adapted);
  const coverage = f.byId('relation-coverage'), text = allText(coverage);
  assert.match(text, /保留 7 家，新增 1 家，替换 1 家，移除 1 家。另有 1 项候选调整未采用/);
  assert.match(text, /本次公司调整.*原公司一（600000.SH） → 新公司一（600001.SH）.*已退出相关业务.*业务剥离公告.*2026-10-14/s);
  assert.match(text, /原公司二（600002.SH） → 移除.*已退市/s);
  const links = descendants(coverage).filter(node => node.tagName === 'A');
  assert.deepEqual(links.map(node => node.href), ['https://example.com/exit', 'http://example.com/delisted']);
  assert.ok(links.every(node => node.target === '_blank' && node.rel === 'noopener noreferrer'));
  assert.equal(coverage.children[0].open, false);
  renderRelations(report(1));
  assert.doesNotMatch(allText(coverage), /原公司一|新公司一|本次公司调整|候选调整未采用/);
});

test('换股理由和来源按纯文本呈现，禁止脚本链接且兼容缺少或畸形刷新摘要', t => {
  const f = fixture(t), data = report(1), payload = '<img src=x onerror=alert(1)>';
  data.meta = { refreshSummary: { retainedCount: 0, addedCount: 1, removedCount: 1, blockedCount: 0, changes: [
    { oldTicker: '600000.SH', oldName: payload, newTicker: '600001.SH', newName: '<script>alert(2)</script>', reason: payload,
      sources: [{ title: payload, url: 'javascript:alert(3)', publishedAt: '<svg onload=alert(4)>' }, { title: '<b>公告</b>', url: 'https://example.com/safe', publishedAt: '2026-10-14' }] },
  ] } };
  renderRelations(data);
  const coverage = f.byId('relation-coverage'), nodes = descendants(coverage);
  assert.match(allText(coverage), /<img src=x onerror=alert\(1\)>/);
  assert.match(allText(coverage), /<script>alert\(2\)<\/script>/);
  assert.equal(nodes.some(node => ['IMG', 'SCRIPT', 'SVG', 'B'].includes(node.tagName)), false);
  assert.deepEqual(nodes.filter(node => node.tagName === 'A').map(node => node.href), ['https://example.com/safe']);
  assert.doesNotMatch(allText(coverage), /<svg/);
  data.meta.refreshSummary = { retainedCount: 'invalid' }; renderRelations(data);
  assert.doesNotMatch(allText(coverage), /本次公司调整|保留 \d+ 家，新增/);
  assert.equal(f.rows().length, 2);
});

test('同一公司A/H代码同一行展示，资料摘要区别于原文并保留真实日期和阅读范围', t => {
  const f = fixture(t), raw = report(1);
  Object.assign(raw.relations[0], { relatedTicker: '601633.SH', relatedName: '长城汽车', alternateTickers: ['02333.HK'], verifiedAt: '2026-10-15T03:00:00Z',
    sources: [{ sourceId: 's21', title: '公司披露业务关系', url: 'https://example.com/gwm', evidenceSummary: '公开资料显示该公司为相关汽车业务客户。',
      publishedAt: '2026-10-14', accessedAt: '2026-10-15T02:00:00Z', readingScope: 'search_snippet' }] });
  const data = adaptRelations(raw); renderRelations(data);
  assert.equal(f.rows().length, 2); assert.match(allText(f.rows()[1].children[0]), /601633.SH.*02333.HK.*同一公司/);
  f.click(descendants(f.rows()[1]).find(node => node.dataset.relationEvidence));
  const content = f.byId('relation-evidence-content');
  assert.match(allText(content), /同一公司其他上市代码.*02333.HK.*关系核验时间/s);
  assert.match(allText(content), /资料依据.*资料摘要.*公开资料显示.*2026-10-14.*检索摘要/s);
  assert.doesNotMatch(allText(content), /原文依据|原文摘录/);
  assert.equal(descendants(content).find(node => node.tagName === 'A').href, 'https://example.com/gwm');
  assert.equal(descendants(content).filter(node => node.tagName === 'BLOCKQUOTE').length, 0);
});

test('空类别提示暂未保存，返回全部仍保留所有已知关系与切股入口', t => {
  const f = fixture(t); renderRelations(report(7));
  f.click(f.filters[3]);
  assert.equal(f.byId('relations-content').hidden, false);
  assert.equal(f.rows().length, 1);
  assert.equal(f.byId('relation-filter-note').hidden, false);
  assert.equal(f.byId('relation-filter-note').textContent, '该类暂未保存关联公司');
  assert.equal(f.filters[3].attributes.get('aria-pressed'), 'true');
  assert.equal(f.filters[0].querySelector('b').textContent, '7');
  f.click(f.filters[0]);
  assert.equal(f.rows().length, 8);
  assert.equal(f.byId('relation-filter-note').hidden, true);
  const link = descendants(f.rows()[1]).find(node => node.dataset.relationTicker);
  assert.equal(f.click(link).defaultPrevented, true);
  assert.deepEqual(f.selected, [{ ticker: '300001.SZ', name: '已核实公司 1' }]);
});

test('切股读取与失败清空旧标的及证据，重新得到部分关系可正常展示', t => {
  const f = fixture(t), previous = report(7);
  renderRelations(previous);
  f.click(descendants(f.rows()[1]).find(node => node.dataset.relationEvidence));
  for (const status of ['loading', 'error']) {
    renderRelations(previous, { status, ticker: '600399.SH', asOf: '2026-10-14', error: '读取失败详情' });
    assert.equal(f.byId('relations-content').hidden, true);
    assert.equal(f.byId('relations-empty').hidden, false);
    assert.equal(f.rows().length, 0);
    assert.equal(f.byId('relation-coverage').children.length, 0);
    assert.equal(f.byId('relation-evidence-dialog').open, false);
    assert.equal(f.filters[0].querySelector('b').textContent, '—');
    assert.ok(f.filters.every(button => button.disabled));
    assert.doesNotMatch(f.byId('relations-context').textContent, /2026-10-15/);
  }
  renderRelations(report(1, { ticker: '600399.SH', name: '抚顺特钢', type: 'peer' }));
  assert.equal(f.rows().length, 2);
  assert.match(allText(f.rows()[0]), /抚顺特钢.*600399.SH/);
  assert.doesNotMatch(allText(f.byId('relation-table-body')), /赛力斯/);
  assert.equal(f.byId('relations-status').textContent, '已保存 1 家');
});

test('只有没有任何已保存关系时显示空态', t => {
  const f = fixture(t); renderRelations(report(0));
  assert.equal(f.byId('relations-content').hidden, true);
  assert.equal(f.byId('relations-empty').hidden, false);
  assert.equal(f.rows().length, 0);
  assert.equal(f.byId('relations-empty').querySelector('strong').textContent, '当前标的暂无已保存关系');
});

test('0 家关系仍可展开真实缺口，去重并按纯文本展示，重复渲染不叠加研究说明', t => {
  const f = fixture(t), data = report(0);
  const reason = '已排除 601377.SH：引用未对应本次取得的正文原句。';
  const untrusted = '<img src=x onerror=alert(1)>检索正文';
  data.gaps = [reason, ` ${reason} `, untrusted, ''];
  data.meta = { aiResultNote: '最近一次 AI 识别未找到足够证据支持的关系。' };
  for (let pass = 0; pass < 2; pass++) {
    renderRelations(data);
    const coverage = f.byId('relation-coverage');
    assert.equal(f.byId('relations-content').hidden, true);
    assert.equal(f.rows().length, 0);
    assert.equal(coverage.children.length, 1);
    const details = coverage.children[0];
    assert.equal(details.tagName, 'DETAILS'); assert.equal(details.open, false);
    assert.equal(details.children[0].textContent, '研究说明');
    assert.deepEqual(details.querySelector('ul').children.map(node => node.textContent), [reason, untrusted]);
    assert.equal(descendants(coverage).some(node => node.tagName === 'IMG'), false);
    assert.doesNotMatch(allText(coverage), /最近一次 AI 识别未找到|区间价格表现/);
  }
});

test('人工关系标明人工修改、真实备注及修改时间，无原文时不伪造原文依据', t => {
  const f = fixture(t), data = report(1);
  data.status = 'customized'; data.meta = { hasManualChanges: true, manualRevision: '1' };
  Object.assign(data.relations[0], { evidenceType: 'manual', origin: 'manual', rationale: '我核对后调整为上游', sources: [], manualUpdatedAt: '2026-10-19T02:30:00Z', manualEffectiveDate: '2026-10-15' });
  renderRelations(data);
  assert.equal(f.byId('relations-status').textContent, '已保存 1 家 · 人工修改');
  const evidence = descendants(f.rows()[1]).find(node => node.dataset.relationEvidence);
  assert.equal(evidence.textContent, '人工修改'); f.click(evidence);
  assert.match(allText(f.byId('relation-evidence-content')), /人工修改.*人工备注.*我核对后调整为上游.*修改时间.*10:30.*生效日期.*2026-10-15/s);
  assert.doesNotMatch(allText(f.byId('relation-evidence-content')), /原文依据|已核实/);
});

test('人工移除全部关系显示真实的 0 家状态', t => {
  const f = fixture(t), data = report(0); data.status = 'customized'; data.meta = { hasManualChanges: true };
  renderRelations(data);
  assert.equal(f.byId('relations-status').textContent, '已保存 0 家 · 人工修改');
  assert.equal(f.byId('relations-empty').querySelector('strong').textContent, '当前未保留关联公司');
});
