import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompany, normalizeTicker } from '../frontend/src/data/companies.js';
import { createCompanySession } from '../frontend/src/features/company-session.js';
import { createResearchService } from '../frontend/src/services/research-service.js';
import { noteKey } from '../frontend/src/features/notes.js';

test('证券代码保留港股前导零，未知股票不继承默认公司的资料', () => {
  assert.equal(normalizeTicker(' 02313.hk '), '02313.HK');
  const company = createCompany({ ticker: '600519.SH', name: '贵州茅台' });
  assert.equal(company.name, '贵州茅台');
  assert.deepEqual(company.businesses, []);
  assert.equal(company.sourceUrl, null);
  assert.equal(createCompany({ ticker: 'AAPL' }).name, 'AAPL');
  assert.throws(() => normalizeTicker('invalid code'));
});

test('快速切换股票会取消所有旧模块请求，即使旧接口返回也不能覆盖新数据', async () => {
  const session = createCompanySession({ ticker: '002920.SZ' });
  const oldQuote = session.begin('quote');
  const oldEvents = session.begin('events');
  session.select({ ticker: '02313.HK' });
  const newQuote = session.begin('quote');
  assert.equal(oldQuote.signal.aborted, true);
  assert.equal(oldEvents.signal.aborted, true);
  assert.equal(oldQuote.isCurrent(), false);
  assert.equal(oldEvents.isCurrent(), false);
  assert.equal(newQuote.isCurrent(), true);
  assert.equal(newQuote.ticker, '02313.HK');
  session.begin('quote');
  assert.equal(newQuote.signal.aborted, true);
  assert.equal(newQuote.isCurrent(), false);
});

test('切换后的所有模块使用同一当前证券代码，非法输入不会破坏当前会话', async () => {
  const session = createCompanySession({ ticker: '002920.SZ' });
  const current = session.begin('quote');
  assert.throws(() => session.select({ ticker: '<script>' }));
  assert.equal(current.isCurrent(), true);
  assert.equal(current.signal.aborted, false);
  session.select({ ticker: '02313.HK' });
  const observed = [];
  const routes = Object.fromEntries(['profile', 'quote', 'prices', 'debates', 'forecasts', 'bands', 'events'].map(module => [module, ({ ticker }) => ({ path: `/${module}`, query: { ticker } })]));
  const service = createResearchService({ config: { enabled: true }, routes, client: { get: async (path, options) => { observed.push(options.query.ticker); return null; } }, mappers: Object.fromEntries(Object.keys(routes).map(module => [module, value => value])) });
  await Promise.all(Object.keys(routes).map(module => service.load(module, { ticker: session.begin(module).ticker })));
  assert.deepEqual(observed, Array(7).fill('02313.HK'));
  assert.notEqual(noteKey('002920.SZ'), noteKey('02313.HK'));
});
