import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaURL, downloadHeaders, nextCatalogPage, validFilePrefix, unwrapAPIResult } from '../backend/research-data/ima-sync.mjs';

test('media fetches cannot forward IMA credentials or use arbitrary/private hosts', () => {
  assert.equal(validateMediaURL('https://skb.ima.myqcloud.com/file.pdf?sign=secret').hostname, 'skb.ima.myqcloud.com');
  for (const url of ['http://skb.ima.myqcloud.com/a', 'https://127.0.0.1/a', 'https://myqcloud.com.evil.test/a', 'https://user:pass@skb.ima.myqcloud.com/a']) assert.throws(() => validateMediaURL(url));
  for (const headers of [{ 'ima-openapi-apikey': 'secret' }, { Host: 'evil.test' }, { authorization: 'x\r\nsecret' }]) assert.throws(() => downloadHeaders(headers));
  assert.equal(downloadHeaders({ Authorization: 'scoped-media-token' }).get('authorization'), 'scoped-media-token');
});

test('catalog pagination must advance and empty pages cannot certify continuation', () => {
  const item = { media_id: 'doc', title: 'Report.pdf', media_type: 1 };
  assert.deepEqual(nextCatalogPage({ knowledge_list: [item], is_end: false, next_cursor: 'b' }, 'a'), { items: [item], cursor: 'b', done: false });
  assert.throws(() => nextCatalogPage({ knowledge_list: [item], is_end: false, next_cursor: 'a' }, 'a'));
  assert.throws(() => nextCatalogPage({ knowledge_list: [], is_end: false, next_cursor: 'b' }, 'a'));
  assert.throws(() => nextCatalogPage({ knowledge_list: [{ title: 'bad' }], is_end: true }, ''));
  assert.equal(nextCatalogPage({ knowledge_list: [], is_end: true }, '').done, true);
});

test('error/login pages cannot be accepted as original PDFs or text files', () => {
  assert.equal(validFilePrefix(1, Buffer.from('%PDF-1.7\n')), true);
  assert.equal(validFilePrefix(1, Buffer.from('<html>login</html>')), false);
  assert.equal(validFilePrefix(13, Buffer.from('<!DOCTYPE html>login')), false);
  assert.equal(validFilePrefix(13, Buffer.alloc(0)), false);
});

test('daily media quota stops the batch instead of permanently rejecting queued files', () => {
  assert.throws(() => unwrapAPIResult({ code: 220021, msg: '资料获取次数已达上限，请明天再尝试' }), e => e.code === 'IMA_DAILY_ACCESS_QUOTA' && e.fatal && !e.retryable);
  assert.throws(() => unwrapAPIResult({ code: 220030, msg: '该文件获取失败，请至ima内查看处理' }), e => !e.fatal && !e.retryable);
  assert.throws(() => unwrapAPIResult({ code: 110021 }), e => e.retryable && !e.fatal);
  assert.deepEqual(unwrapAPIResult({ code: 0, data: { ok: true } }), { ok: true });
});
