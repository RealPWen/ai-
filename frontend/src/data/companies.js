// Only identifiers for the initial selection list. Research data comes from APIs.
export const companyOptions = [
  { name: '德赛西威', ticker: '002920.SZ' },
  { name: '潍柴动力', ticker: '000338.SZ' },
  { name: '申洲国际', ticker: '02313.HK' },
];

export function normalizeTicker(value) {
  const ticker = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(ticker)) throw new Error('请输入有效证券代码，例如 002920.SZ 或 02313.HK');
  // Preserve exchange suffixes and leading zeros. Do not guess an exchange.
  return ticker;
}

export function createCompany({ ticker, name }) {
  const code = normalizeTicker(ticker);
  return {
    ticker: code,
    name: String(name ?? '').trim() || companyOptions.find(item => item.ticker === code)?.name || code,
    description: '选择标的后，逐步补齐公司资料、行情、卖方预测与产业链事件。',
    businesses: [],
    sourceUrl: null,
  };
}

// Common research prompts, never presented as actual market opinions.
export const researchQuestions = [
  { category: '增长', title: '收入与利润增长能否持续？', summary: '结合主营业务、需求变化和盈利能力，跟踪增长兑现。', metrics: ['收入增长', '利润率', '现金流'], evidence: '补充当前公司的财报、业务数据和卖方预测，保留来源与日期。' },
  { category: '竞争', title: '行业格局与竞争优势如何变化？', summary: '跟踪同行、上下游和公司的市场地位，验证竞争优势。', metrics: ['市场份额', '产品价格', '客户结构'], evidence: '补充当前公司及产业链的公开披露和行业研报，区分事实、来源观点与推断。' },
  { category: '估值', title: '当前估值是否反映未来盈利？', summary: '对照卖方预测分歧、历史估值位置与盈利修订方向。', metrics: ['EPS 修订', 'PE/PB 分位', '盈利兑现'], evidence: '补充同财年、同币种和同口径的卖方 EPS，以及历史 PE/PB。未取得数据时不判断贵或便宜。' },
];
