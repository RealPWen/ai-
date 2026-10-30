import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRelationListedMapping } from '../backend/src/relations-ai-evidence.mjs';

const xiangcai = { ticker: '600095.SH', name: '湘财股份' };
const hikvision = { ticker: '002415.SZ', name: '海康威视' };
function audit(candidate, actualEntity, content, listedMappingBasis = '上市主体自身') {
  return auditRelationListedMapping({ actualEntity, listedMappingBasis, rationale: '具体业务可比。', notes: '' }, candidate, { texts: [content] });
}

test('证券标签与子公司名称相邻不能将子公司当成发行人自身', () => {
  for (const content of [
    '证券简称：湘财股份。湘财证券股份有限公司是其子公司。',
    '证券简称：湘财股份。湘财证券股份有限公司不是上市主体。',
    '证券代码：600095。湘财证券股份有限公司开展证券业务。',
    '公司中文名称：湘财股份有限公司；证券简称：湘财股份；子公司中文名称：湘财证券股份有限公司。',
  ]) assert.equal(audit(xiangcai, '湘财证券股份有限公司', content).ok, false, content);
});

test('明确法人全称与证券简称定义可在来源正文其他位置提供身份依据', () => {
  assert.equal(audit(hikvision, '杭州海康威视数字技术股份有限公司',
    '杭州海康威视数字技术股份有限公司（以下简称“海康威视”）。' + '业务背景。'.repeat(100) + '海康威视主营视频产品。').ok, true);
  assert.equal(audit(hikvision, '杭州海康威视数字技术股份有限公司',
    '杭州海康威视数字技术股份有限公司（以下简称海康威视）主营视频产品。').ok, true);
});

test('公司中文名称与对应证券简称或证券代码字段支持上市身份，兼容换行及字段顺序', () => {
  for (const content of [
    '公司中文名称：杭州海康威视数字技术股份有限公司；证券简称：海康威视。',
    '杭州海康威视数字技术股份有限公司（证券简称：海康威视，股票代码002415.SZ）公告。',
    '公司中文名称：杭州海康威视数字技术股份有限公司\n证券代码：002415',
    '证券简称：海康威视\n公司中文名称：杭州海康威视数字技术股份有限公司',
  ]) assert.equal(audit(hikvision, '杭州海康威视数字技术股份有限公司', content).ok, true, content);
});

test('否定的简称定义及把子公司另称发行人的句子不构成自身身份证明', () => {
  for (const content of [
    '证券简称：湘财股份。湘财证券股份有限公司并非湘财股份。',
    '湘财证券股份有限公司（以下简称“湘财股份”）不是上市主体。',
    '并非湘财证券股份有限公司（证券简称：湘财股份）作为上市主体。',
    '湘财证券股份有限公司（以下简称“湘财股份”）是某公司的全资子公司。',
  ]) assert.equal(audit(xiangcai, '湘财证券股份有限公司', content).ok, false, content);
});

test('中国或省市名前缀不自动省略，明确全称定义才支持证券简称', () => {
  const candidate = { ticker: '601857.SH', name: '中国石油' };
  const actual = '中国石油天然气股份有限公司';
  assert.equal(audit(candidate, actual, '中国石油与中国石油天然气股份有限公司开展业务。').ok, false);
  assert.equal(audit(candidate, actual, '中国石油天然气股份有限公司（以下简称“中国石油”）开展业务。').ok, true);
});

test('明确控股映射仍按子公司关系通过，不以发行人自身认定', () => {
  assert.equal(audit(xiangcai, '湘财证券股份有限公司',
    '湘财股份的控股子公司湘财证券股份有限公司开展证券业务。', '湘财股份的控股子公司').ok, true);
});
