import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDeepSeekClient, DEFAULT_DEEPSEEK_MODEL } from '../backend/src/deepseek-client.mjs';
import { MAX_AI_RELATIONS, relationsAISchema, relationCandidates, relationsSearchContext, relevantRelationCandidates,
  auditRelationsAI, auditRelationListedMapping, revalidateStoredRelationsAI } from '../backend/src/relations-ai-evidence.mjs';

const input = { ticker: '00700.HK', companyName: '腾讯控股', asOf: '2026-10-20', candidates: [
  { ticker: '00700.HK', name: '腾讯控股' }, { ticker: '002415.SZ', name: '海康威视' }, { ticker: '09988.HK', name: '阿里巴巴-W' },
] };
const excerpt = '腾讯控股与海康威视披露了明确的技术合作，双方开展联合研发。';
const source = (changes = {}) => ({ url: 'https://example.com/disclosure?utm_source=test', title: '公司技术合作公告',
  content: excerpt + '其他业务背景。', date: '2026-10-19T02:00:00Z', summary: '摘要不能冒称完整正文', ...changes });
const relation = (changes = {}) => ({ relatedTicker: '002415.SZ', relationType: 'upstream', evidenceType: 'technical_cooperation',
  rationale: '公司与海康威视开展技术合作，不推定采购合同。', actualEntity: '海康威视', listedMappingBasis: '上市主体自身', notes: '',
  sources: [{ sourceId: 's1' }], ...changes });
const proposal = (relations = [relation()]) => ({ relations, gaps: [] });
const completed = value => ({ id: 'response-1', status: 'completed', model: DEFAULT_DEEPSEEK_MODEL,
  output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const context = (rows = [source()]) => relationsSearchContext([rows], input, '2026-10-20T01:00:00.000Z');
const audit = raw => auditRelationsAI(raw, { input, candidates: relationCandidates(input), sources: context().sources });

test('先四次联网检索，再整理关系摘要，来源仅需sourceId且模式显式标识', async () => {
  const calls = [], stages = []; let searches = 0, maximum = 0;
  const client = createDeepSeekClient({ apiKey: 'mock-key', now: () => new Date('2026-10-20T01:00:00Z'), fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/v1/tools/search')) {
      searches++; maximum = Math.max(maximum, searches);
      await new Promise(resolve => setTimeout(resolve, 5)); searches--;
      return Response.json({ results: [source()] });
    }
    assert.equal(searches, 0); return Response.json(completed(proposal()));
  } });
  const prompt=await readFile(new URL('../backend/prompts/relations-ai.md',import.meta.url),'utf8');
  const result = await client.researchRelations(input, prompt, { onProgress: stage => stages.push(stage) });
  assert.equal(calls.length, 7); assert.equal(maximum, 4); assert.deepEqual(stages, ['searching', 'analyzing', 'searching']);
  assert.deepEqual(result.retrievalEvidence.coverageRecovery.categoryChecks,['peer','downstream']);
  for (const call of calls.slice(0, 4)) {
    assert.equal(call.body.count, 8); assert.equal(call.body.need_content, true);
    assert.match(call.body.query, /腾讯控股/); assert.doesNotMatch(call.body.query, /00700.HK/); assert.match(call.body.query, /before:2026-10-21/);
  }
  const inference = calls[4].body, data = JSON.parse(inference.input[0].content.split('\n').slice(1).join('\n'));
  assert.deepEqual(inference.text.format.schema, relationsAISchema); assert.equal(inference.tool_choice, 'none');
  assert.equal(inference.max_output_tokens, 16000); assert.match(inference.instructions, /不可信数据/);
  assert.match(inference.instructions, /不要求逐字引文/); assert.match(inference.instructions, /不是必查名单/);
  assert.match(inference.instructions, /约 10 家.*最多 10 家/);
  assert.match(inference.instructions, /主动检查上游、同行、下游/);
  assert.match(inference.instructions, /不固定配额/);
  assert.match(calls[0].body.query, /主营产品/); assert.match(calls[1].body.query, /上游/);
  assert.match(calls[2].body.query, /同行/); assert.match(calls[3].body.query, /下游/);
  assert.deepEqual(data.candidateHints, [{ ticker: '002415.SZ', name: '海康威视' }]);
  assert.equal(Object.hasOwn(data.parameters, 'candidates'), false);
  assert.equal(result.evidenceMode, 'relation_summary'); assert.equal(result.provider, 'deepseek');
  const saved = result.relations[0].sources[0];
  assert.equal(saved.sourceId, 's1'); assert.equal(saved.url, source().url); assert.equal(saved.publishedAt, '2026-10-19');
  assert.equal(saved.readingScope, 'partial_text'); assert.equal(saved.sourceKind, 'page_text');
  assert.match(saved.evidenceSummary, /综合本条所列材料归纳/); assert.equal(Object.hasOwn(saved, 'excerpt'), false);
  assert.equal(result.retrievalEvidence.evidenceMode, 'relation_summary');
  assert.equal(result.retrievalEvidence.sources[0].contentSha256, createHash('sha256').update(source().content, 'utf8').digest('hex'));
  assert.equal(Object.hasOwn(result.retrievalEvidence.sources[0], 'content'), false);
  assert.doesNotMatch(JSON.stringify(result), /mock-key/);
});

test('搜索摘要可用且标明阅读范围，未知日期不猜测，未来来源仍排除', () => {
  const result = context([
    source({ url: 'https://example.com/future', date: '2026-10-20T18:00:00Z' }),
    source({ url: 'https://example.com/snippet', content: '', summary: excerpt }),
    source({ url: 'https://example.com/unknown', date: null }),
    source({ url: 'https://example.com/invalid-date', date: '2026-02-30T00:00:00Z' }),
    source({ url: 'https://example.com/date-only', date: '2026-10-18' }),
    source({ url: 'https://example.com/empty', content: '', summary: '' }),
  ]);
  assert.equal(result.rejectedFutureCount, 1); assert.equal(result.rejectedWithoutTextCount, 1);
  assert.equal(result.sources.length, 4); assert.equal(result.sources[0].readingScope, 'search_snippet');
  assert.equal(result.sources[0].sourceKind, 'search_summary'); assert.equal(result.sources[0].content, excerpt);
  assert.equal(result.sources[1].publishedAt, null); assert.equal(result.sources[2].publishedAt, null);
  assert.equal(result.sources[3].publishedAt, '2026-10-18');
});

test('重复URL优先真实正文，不让较长摘要覆盖正文', () => {
  const result = context([
    source({ content: '', summary: excerpt.repeat(10) }),
    source({ url: 'https://example.com/disclosure?utm_source=another' }),
  ]);
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].sourceKind, 'page_text');
  assert.equal(result.sources[0].content, source().content);
});

test('单条引用无效时保留同一关系其他来源；坏关系不丢弃其他有效关系', () => {
  const mixed = relation({ sources: [{ sourceId: 'invented' }, { sourceId: 's1' }] });
  const result = audit(proposal([relation({ relatedTicker: 'AAPL' }), mixed]));
  assert.equal(result.relations.length, 1); assert.equal(result.relations[0].sources.length, 1);
  assert.match(result.relations[0].notes, /忽略 1 条/); assert.match(result.gaps.join(' '), /已排除/);
  assert.equal(audit(proposal([relation({ sources: [{ sourceId: 'invented' }] })])).relations.length, 0);
});

test('非上市、自关联、重复、字段错误独立剔除，最终名称以完整清单为准', () => {
  for (const bad of [relation({ relatedTicker: '12345.HK' }), relation({ relatedTicker: input.ticker }),
    relation({ relationType: 'peer' }), relation({ rationale: '' }), relation({ sources: [{ sourceId: 's1', url: 'https://invented.example' }] })]) {
    const result = audit(proposal([bad, relation()]));
    assert.equal(result.relations.length, 1);
  }
  assert.equal(audit(proposal([relation(), relation()])).relations.length, 1);
  assert.throws(() => relationCandidates({ ...input, companyName: '错误名称' }), { code: 'INVALID_RELATIONS_INPUT' });
  assert.throws(() => relationCandidates({ ...input, candidates: [...input.candidates, input.candidates[0]] }), { code: 'INVALID_RELATIONS_INPUT' });
});

test('每股单次最多10家，模型目标约10家但不得为凑数生成', () => {
  assert.equal(MAX_AI_RELATIONS, 10); assert.equal(relationsAISchema.properties.relations.maxItems, 10);
  const candidates = [...input.candidates, ...Array.from({ length: 29 }, (_, n) => ({ ticker: String(600000 + n) + '.SH', name: '产业技术企业' + n }))];
  const params = { ...input, candidates }, catalog = relationCandidates(params);
  const content = candidates.map(row => row.name).join('、') + '；腾讯控股的技术业务与这些企业的产品业务具有衔接。';
  const sources = relationsSearchContext([[source({ content })]], params).sources;
  const rows = candidates.filter(row => row.ticker !== input.ticker).slice(0, 10).map(row => relation({
    relatedTicker: row.ticker, actualEntity: row.name, evidenceType: 'industry_position', rationale: '按已披露技术产品业务判断产业链位置，未证实交易。',
  }));
  assert.equal(auditRelationsAI(proposal(rows), { input: params, candidates: catalog, sources }).relations.length, 10);
  assert.throws(() => auditRelationsAI(proposal([...rows, rows[0]]), { input: params, candidates: catalog, sources }), { code: 'INVALID_RELATIONS_AI_SHAPE' });
});

test('未知日期支持背景、同行与产业链位置，不认定当前直接交易', () => {
  const sources = context([source({ date: null })]).sources, args = { input, candidates: relationCandidates(input), sources };
  for (const evidenceType of ['direct_business', 'technical_cooperation', 'industry_position']) {
    const result = auditRelationsAI(proposal([relation({ evidenceType })]), args);
    assert.equal(result.relations.length, 1); assert.equal(result.relations[0].evidenceType, 'industry_position');
    assert.match(result.relations[0].notes, /未证实直接/); assert.match(result.relations[0].notes, /发布日期未知/);
  }
});

test('同行可以分别依据两家公司业务资料，不要求同篇文章点名双方', () => {
  const sources = context([
    source({ title: '腾讯控股业务介绍', content: '本公司的核心产品包括云平台软件及企业服务。' }),
    source({ url: 'https://example.com/camera', title: '海康威视业务介绍', content: '本公司的产品包括云平台和企业技术服务。' }),
  ]).sources;
  const result = auditRelationsAI(proposal([relation({ relationType: 'peer', evidenceType: 'business_comparable',
    rationale: '比较云平台和企业技术服务，双方其他业务并不完全一致。', sources: [{ sourceId: 's1' }, { sourceId: 's2' }] })]),
  { input, candidates: relationCandidates(input), sources });
  assert.equal(result.relations.length, 1); assert.equal(result.relations[0].evidenceType, 'business_comparable');
});

test('分别有业务依据但没有直接披露的上游关系标为产业链位置', () => {
  const sources = context([
    source({ title: '腾讯控股业务介绍', content: '腾讯控股开展云平台业务和软件研发。' }),
    source({ url: 'https://example.com/camera', title: '海康威视业务介绍', content: '海康威视提供技术设备及系统产品。' }),
  ]).sources;
  const result = auditRelationsAI(proposal([relation({ sources: [{ sourceId: 's1' }, { sourceId: 's2' }] })]),
    { input, candidates: relationCandidates(input), sources });
  assert.equal(result.relations[0].evidenceType, 'industry_position');
  assert.match(result.relations[0].notes, /未明确披露/);
});

test('公开的历史供应商奖可保留，注明不代表当前合同', () => {
  const params = { ticker: '002920.SZ', companyName: '德赛西威', asOf: '2026-10-20',
    candidates: [{ ticker: '002920.SZ', name: '德赛西威' }, { ticker: '000625.SZ', name: '长安汽车' }] };
  const content = '德赛西威发布年度业务回顾。' + '其他经营背景。'.repeat(90)
    + '长安汽车供应商大会。德赛西威荣获年度优秀供应商奖。';
  const sources = relationsSearchContext([[source({ content, date: '2025-03-20T02:00:00Z' })]], params).sources;
  const result = auditRelationsAI(proposal([relation({ relatedTicker: '000625.SZ', relationType: 'downstream',
    evidenceType: 'direct_business', actualEntity: '长安汽车', rationale: '历史供应商奖披露，不推定当前合同。' })]),
    { input: params, candidates: relationCandidates(params), sources });
  assert.equal(result.relations.length, 1); assert.equal(result.relations[0].evidenceType, 'direct_business');
  assert.match(result.relations[0].notes, /披露时的供应商身份/);
});

test('法人映射允许从多份材料归纳，不要求同句同段或固定股权句式', () => {
  const params = { ...input, candidates: [...input.candidates, { ticker: '000049.SZ', name: '德赛电池' }] };
  const sources = relationsSearchContext([[
    source({ title: '腾讯控股合作资料', content: '腾讯控股与惠州市德赛电池有限公司开展产品技术合作。' }),
    source({ url: 'https://example.com/mapping', title: '德赛电池公司介绍', content: '惠州市德赛电池有限公司负责产品制造；德赛电池在本公开介绍中说明了集团业务组织。' }),
  ]], params).sources;
  const row = relation({ relatedTicker: '000049.SZ', actualEntity: '惠州市德赛电池有限公司',
    listedMappingBasis: '根据集团公开业务组织介绍，该实际经营主体对应德赛电池业务体系。',
    sources: [{ sourceId: 's1' }, { sourceId: 's2' }] });
  const result = auditRelationsAI(proposal([row]), { input: params, candidates: relationCandidates(params), sources });
  assert.equal(result.relations.length, 1); assert.equal(result.relations[0].actualEntity, row.actualEntity);
  const unresolved = auditRelationsAI(proposal([{ ...row, listedMappingBasis: '无法核实该实体与德赛电池的上市映射。' }]),
    { input: params, candidates: relationCandidates(params), sources });
  assert.equal(unresolved.relations.length, 0); assert.match(unresolved.gaps.join(' '), /待核实候选/);
});

test('只有公司名称名单没有业务材料时仍不伪造关系', () => {
  const sources = context([source({ content: '腾讯控股、海康威视已在本次登记表列出。' })]).sources;
  const result = auditRelationsAI(proposal(), { input, candidates: relationCandidates(input), sources });
  assert.equal(result.relations.length, 0); assert.match(result.gaps.join(' '), /业务或合作依据/);
});

test('候选提示排除行情热门股票表，仅提示材料有业务语境的公司', () => {
  const catalog = relationCandidates(input);
  assert.deepEqual(relevantRelationCandidates(catalog, [
    { title: '股票行情与融资融券公司一览', content: '海康威视经营技术服务，阿里巴巴-W经营云产品。' },
  ], input.ticker), []);
  assert.deepEqual(relevantRelationCandidates(catalog, [
    { title: '腾讯控股业务资料', content: '公司列表：海康威视、阿里巴巴-W。\n海康威视提供云平台产品和技术服务。' },
  ], input.ticker), [{ ticker: '002415.SZ', name: '海康威视' }]);
});

test('来源预算按检索方向公平分配，正文总量受控', () => {
  const batches = Array.from({ length: 4 }, (_, group) => Array.from({ length: 8 }, (_, n) =>
    source({ url: 'https://example.com/group-' + group + '/' + n, content: '组' + group + '实际正文内容' + n })));
  const result = relationsSearchContext(batches, input); assert.equal(result.sources.length, 24);
  for (let group = 0; group < 4; group++) assert.equal(result.sources.filter(row => row.url.includes('group-' + group)).length, 6);
  const limited = context(Array.from({ length: 50 }, (_, n) => source({ url: 'https://example.com/' + n, content: 'x'.repeat(10000) })));
  assert.ok(limited.sources.length <= 24); assert.ok(JSON.stringify(limited.sources).length < 125000);
});

test('只有摘要仍可调用模型，无正文亦无摘要才停止，限流超时不泄漏敏感信息', async () => {
  let inferenceCalls = 0;
  const client = createDeepSeekClient({ apiKey: 'private-key', fetchImpl: async url => {
    if (url.endsWith('/responses')) { inferenceCalls++; return Response.json(completed(proposal())); }
    return Response.json({ results: [source({ content: '', summary: excerpt })] });
  } });
  const result = await client.researchRelations(input, 'prompt'); assert.equal(inferenceCalls, 1);
  assert.equal(result.relations[0].sources[0].readingScope, 'search_snippet');
  assert.match(result.relations[0].notes, /未读取对应网页完整正文/);
  const empty = createDeepSeekClient({ apiKey: 'private-key', fetchImpl: async () => Response.json({ results: [source({ content: '', summary: '' })] }) });
  await assert.rejects(empty.researchRelations(input, 'prompt'), { code: 'RELATIONS_SOURCES_UNVERIFIED' });
  const limited = createDeepSeekClient({ apiKey: 'private-key', fetchImpl: async () => new Response('private-key provider body', { status: 429 }) });
  await assert.rejects(limited.researchRelations(input, 'prompt'), error => error.code === 'DEEPSEEK_RATE_LIMIT' && !/private-key|provider body/.test(JSON.stringify(error)));
  const timed = createDeepSeekClient({ apiKey: 'private-key', searchTimeoutMs: 5,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private-key')), { once: true })) });
  await assert.rejects(timed.researchRelations(input, 'prompt'), { code: 'DEEPSEEK_SEARCH_TIMEOUT' });
});

test('旧存储映射复核helper维持原契约，不能冒充重新联网', () => {
  const candidates = new Map([
    ['002920.SZ', { ticker: '002920.SZ', name: '德赛西威' }], ['300832.SZ', { ticker: '300832.SZ', name: '新产业' }],
    ['000625.SZ', { ticker: '000625.SZ', name: '长安汽车' }],
  ]);
  const url = 'https://www.cninfo.com.cn/disclosure';
  const rows = [
    { ...relation({ relatedTicker: '300832.SZ', actualEntity: '广东弘景光电科技股份有限公司',
      listedMappingBasis: '无法映射上市主体。', evidenceType: 'direct_business' }), relatedName: '新产业',
      sources: [{ sourceId: 's10', url, publishedAt: '2026-03-06', excerpt: '广东弘景光电科技股份有限公司为公司的供应商。' }] },
    { ...relation({ relatedTicker: '000625.SZ', actualEntity: '长安汽车', evidenceType: 'direct_business' }), relatedName: '长安汽车',
      sources: [{ sourceId: 's10', url, publishedAt: '2026-03-06', excerpt: '长安汽车“优秀供应商奖”' }] },
  ];
  const result = revalidateStoredRelationsAI({ relations: rows, gaps: ['原缺口'] },
    { input: { ticker: '002920.SZ', asOf: '2026-10-20' }, candidates, retrievalEvidence: { origin: 'deepseek-search',
      sources: [{ id: 's10', url, publishedAt: '2026-03-06', contentSha256: 'a'.repeat(64) }] } });
  assert.deepEqual(result.relations.map(row => row.relatedTicker), ['000625.SZ']);
  assert.equal(result.revalidation.mode, 'stored-excerpt-mapping-only');
  assert.equal(result.revalidation.originalTextReverified, false); assert.match(result.gaps.at(-1), /未重新抓取网页/);
  const candidate = { ticker: '000049.SZ', name: '德赛电池' }, actualEntity = '惠州市德赛电池有限公司';
  assert.equal(auditRelationListedMapping({ ...relation(), actualEntity, listedMappingBasis: '无法核实控股关系。' },
    candidate, { texts: [actualEntity + '为德赛电池全资子公司。'] }).ok, false);
});
