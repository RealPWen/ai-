import test from 'node:test';
import assert from 'node:assert/strict';
import { auditReport } from '../backend/src/source-audit.mjs';

const input = { ticker: '002920.SZ', asOf: '2026-10-19', windowStart: '2026-07-22' };
const url = 'https://example.com/real';
const fixture = () => ({ company: { ticker: input.ticker, name: '测试公司', identityStatus: 'verified', description: '' }, summary: '', debates: [],
  sources: [{ id: 's1', title: '真实来源', url, author: '未披露', publishedAt: '2026-10-01', platform: 'other', readingScope: 'full_text', qualityLabel: '' }], coverage: [], limitations: [] });
const response = { output: [] };

test('可信独立检索控制发布日期和阅读范围，未知日期不接受模型补造', () => {
  const evidence = { origin: 'deepseek-search', sources: [{ url, publishedAt: null, readingScope: 'search_snippet' }] };
  const audited = auditReport(fixture(), response, input, evidence);
  assert.equal(audited.sources[0].publishedAt, null);
  assert.equal(audited.sources[0].readingScope, 'search_snippet');
  assert.equal(audited.sources[0].citationVerified, true);
  evidence.sources[0] = { url, publishedAt: '2026-10-02', readingScope: 'partial_text' };
  const partial = auditReport(fixture(), response, input, evidence).sources[0];
  assert.equal(partial.publishedAt, '2026-10-02');
  assert.equal(partial.readingScope, 'partial_text');
});

test('普通模型响应的引用和自带retrievalEvidence不能扩展可信Search白名单', () => {
  const raw = fixture();
  raw.sources.push({ ...raw.sources[0], id: 's2', url: 'https://example.com/invented' });
  const untrusted = { retrievalEvidence: { origin: 'deepseek-search', sources: [{ url: raw.sources[1].url }] },
    output: [{ type: 'message', content: [{ annotations: [{ type: 'url_citation', url: raw.sources[1].url }] }] }] };
  const evidence = { origin: 'deepseek-search', sources: [{ url, publishedAt: null, readingScope: 'search_snippet' }] };
  assert.deepEqual(auditReport(raw, untrusted, input, evidence).sources.map(item => item.url), [url]);
  assert.equal(auditReport(fixture(), { ...response, retrievalEvidence: evidence }, input).sources.length, 0);
});

test('搜索提供方明确晚于截止日的文章不能被模型改成旧日期后使用', () => {
  const evidence = { origin: 'deepseek-search', sources: [{ url, publishedAt: '2026-10-20', readingScope: 'partial_text' }] };
  const audited = auditReport(fixture(), response, input, evidence);
  assert.equal(audited.sources.length, 0);
  assert.equal(audited.company.identityStatus, 'uncertain');
});
