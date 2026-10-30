export const PLATFORMS = ['company', 'sell_side', 'alpha', 'xueqiu', 'tradingview', 'x', 'other'];
const string = { type: 'string' };
const strings = { type: 'array', items: string };
const enumeration = values => ({ type: 'string', enum: values });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const side = object({ summary: string, evidenceStatus: enumeration(['source_view', 'model_inference', 'insufficient']), sourceIds: strings });
export const reportSchema = object({
  company: object({ name: string, ticker: string, identityStatus: enumeration(['verified', 'uncertain']), description: string }),
  summary: string,
  debates: { type: 'array', items: object({ id: string, title: string, summary: string, status: enumeration(['documented_disagreement', 'research_hypothesis', 'insufficient_evidence']), bull: side, bear: side, metrics: strings }) },
  sources: { type: 'array', items: object({ id: string, title: string, url: string, author: string, publishedAt: { type: ['string', 'null'] }, platform: enumeration(PLATFORMS), readingScope: enumeration(['full_text', 'partial_text', 'search_snippet']), qualityLabel: string }) },
  coverage: { type: 'array', items: object({ platform: enumeration([...PLATFORMS, 'ima']), status: enumeration(['found', 'limited', 'not_found', 'not_searched', 'needs_import']), note: string }) },
  limitations: strings,
});

// Validate independently of the provider's strict output mode.
export function validateShape(value, schema = reportSchema, path = 'report') {
  if (Array.isArray(schema.type)) {
    if (value === null && schema.type.includes('null')) return;
    return validateShape(value, { ...schema, type: schema.type.find(type => type !== 'null') }, path);
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 应为对象`);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} 缺失`);
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`${path}.${key} 不是约定字段`);
    for (const [key, item] of Object.entries(schema.properties)) validateShape(value[key], item, `${path}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 100) throw new Error(`${path} 应为合理长度的数组`);
    value.forEach((item, index) => validateShape(item, schema.items, `${path}[${index}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > 12000 || (schema.enum && !schema.enum.includes(value))) throw new Error(`${path} 文本无效`);
  }
}
