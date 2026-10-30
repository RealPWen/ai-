import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDebates } from '../frontend/src/views/research-view.js';

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.open = false; this.hidden = false; this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this.textContent = ''; }
  get childNodes() { return this.children; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  click() { this.listeners.get('click')?.(); }
}
function fixture(t) {
  const disclosureIds = ['debate-coverage', 'debate-sources'];
  const elements = new Map([...disclosureIds, '.debate-grid', '#debates .status-pill'].map(id => [id, new Element(disclosureIds.includes(id) ? 'details' : 'div')]));
  const original = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { textContent: text }), getElementById: id => elements.get(id), querySelector: selector => elements.get(selector) };
  t.after(() => { globalThis.document = original; });
  return elements;
}
function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }

test('ima 来源显示标签与实际片段，不把内部标识作为公开下载链接', t => {
  const elements = fixture(t), value = report();
  Object.assign(value.sources[0], { sourceKind: 'ima', url: 'ima://ima_kb_test/pdf_test', libraryName: '测试知识库', excerpts: [{ page: 1, method: 'ocr', text: '<script>仅为原文文字</script>' }] });
  renderDebates(value);
  const all = descendants(elements.get('debate-sources'));
  assert.ok(all.some(e => e.textContent === 'ima 数据'));
  assert.ok(all.some(e => e.tagName === 'BLOCKQUOTE' && e.textContent === '<script>仅为原文文字</script>' && e.children.length === 0));
  assert.equal(all.some(e => e.tagName === 'A' && e.href?.startsWith('ima:')), false);
});
const report = () => ({
  ticker: '002920.SZ', asOf: '2026-10-14', windowStart: '2026-07-17', generatedAt: '2026-10-14T02:35:04Z',
  company: { name: '德赛西威', identityStatus: 'verified' }, summary: '公开资料研究',
  debates: [{ title: '利润率能否保持？', status: 'research_hypothesis', metrics: ['利润率'], bull: { summary: '乐观观点', evidenceStatus: 'source_view', sourceIds: ['s1'] }, bear: { summary: '需进一步验证', evidenceStatus: 'insufficient', sourceIds: [] } }],
  coverage: [{ platform: 'sell_side', status: 'found', note: '公开研报' }, { platform: 'alpha', status: 'not_found' }],
  sources: [{ id: 's1', platform: 'sell_side', title: '<script>source</script>', author: '机构', url: 'https://example.com/report', readingScope: 'search_snippet' }], limitations: [],
});

test('新报告默认折叠摘要、报告信息和证据区；同报告保留展开，切换版本及清空报告时重新折叠', t => {
  const elements = fixture(t); const first = report();
  renderDebates(first);
  const coverage = elements.get('debate-coverage'), sources = elements.get('debate-sources');
  const disclosures = ['debate-coverage', 'debate-sources'].map(id => elements.get(id));
  disclosures.forEach(container => { assert.equal(container.tagName, 'DETAILS'); assert.equal(container.open, false); });
  assert.equal(coverage.children[0].tagName, 'SUMMARY'); assert.equal(sources.children[0].tagName, 'SUMMARY');
  assert.ok(descendants(coverage.children[0]).some(item => item.textContent === '2 个平台 · 1 个找到资料'));
  assert.ok(descendants(sources.children[0]).some(item => item.textContent.startsWith('1 条')));
  disclosures.forEach(container => { container.open = true; });
  renderDebates({ ...first, cached: true });
  disclosures.forEach(container => assert.equal(container.open, true));
  renderDebates({ ...first, generatedAt: '2026-10-14T03:00:00Z' });
  disclosures.forEach(container => assert.equal(container.open, false));
  for (const changed of [{ ...first, ticker: '600519.SH' }, { ...first, asOf: '2026-10-13' }]) {
    disclosures.forEach(container => { container.open = true; });
    renderDebates(changed);
    disclosures.forEach(container => assert.equal(container.open, false));
  }
  disclosures.forEach(container => { container.open = true; });
  renderDebates(null);
  disclosures.forEach(container => { assert.equal(container.open, false); assert.equal(Object.hasOwn(container.dataset, 'reportKey'), false); });
  assert.equal(sources.hidden, true); assert.equal(sources.children.length, 0);
});

test('观点引用编号打开折叠区并保留可定位锚点，来源文字不作为 HTML 插入', t => {
  const elements = fixture(t); renderDebates(report());
  const sources = elements.get('debate-sources');
  const ref = descendants(elements.get('.debate-grid')).find(item => item.tagName === 'A' && item.href === '#debate-source-1');
  assert.ok(ref); assert.equal(sources.open, false);
  ref.click(); assert.equal(sources.open, true);
  const target = descendants(sources).find(item => item.id === 'debate-source-1');
  assert.ok(target); assert.equal(target.tabIndex, -1);
  const sourceTitle = descendants(target).find(item => item.tagName === 'A');
  assert.equal(sourceTitle.textContent, '<script>source</script> ↗');
  assert.equal(sourceTitle.children.length, 0);

});

test('观点中的长 Markdown 来源转成简短链接，保留正文和编号引用', t => {
  const elements = fixture(t); const data = report();
  const url = `https://example.com/reports/${'long-path-'.repeat(30)}(2026)?id=1&stock=002920`;
  data.debates[0].bull.summary = `前文（[公开研报](${url})），后文。[https://example.com/another-long-path](https://example.com/another-long-path)`;
  renderDebates(data);
  const copy = descendants(elements.get('.debate-grid')).find(item => item.className === 'opinion-copy');
  const links = copy.children.filter(item => item.tagName === 'A');
  assert.equal(links.length, 2);
  assert.equal(links[0].href, url);
  assert.equal(links[0].textContent, '公开研报 ↗');
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.equal(links[1].textContent, 'example.com ↗');
  assert.equal(copy.children.map(item => item.textContent).join(''), '前文（公开研报 ↗），后文。example.com ↗');
  assert.ok(descendants(elements.get('.debate-grid')).some(item => item.href === '#debate-source-1'));
});

test('观点链接只接受 HTTP(S)，HTML 与不安全协议保持纯文字', t => {
  const elements = fixture(t); const data = report();
  const text = '<img src=x onerror=alert(1)> [不要执行](javascript:alert(1)) [其他协议](data:text/html,test)';
  data.debates[0].bull.summary = text;
  renderDebates(data);
  const copy = descendants(elements.get('.debate-grid')).find(item => item.className === 'opinion-copy');
  assert.equal(copy.children.length, 1);
  assert.equal(copy.children[0].textContent, text);
  assert.equal(descendants(copy).some(item => item.tagName === 'A' || item.tagName === 'IMG'), false);
});

test('分歧默认只展开第一条，其余摘要和完整观点、来源仍保留在文档中', t => {
  const elements = fixture(t), data = report();
  data.debates = [1, 2, 3].map(index => ({ ...data.debates[0], title: `问题 ${index}`, summary: `摘要 ${index}` }));
  renderDebates(data);
  const all = descendants(elements.get('.debate-grid'));
  const perspectives = all.filter(item => item.className === 'debate-perspectives');
  assert.deepEqual(perspectives.map(item => item.open), [true, false, false]);
  assert.deepEqual(all.filter(item => item.className === 'debate-summary').map(item => item.textContent), ['摘要 1', '摘要 2', '摘要 3']);
  assert.equal(all.filter(item => item.className === 'opinion-copy').length, 6);
  assert.equal(all.filter(item => item.tagName === 'A' && item.href === '#debate-source-1').length, 3);
});
