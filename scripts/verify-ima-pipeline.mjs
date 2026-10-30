// Explicit paid verification. Replay uses previously obtained IMA evidence;
// it never substitutes for a successful live IMA request or overwrites reports.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createImaRetriever } from '../backend/src/ima-retriever.mjs';
import { makeImaSource, IMA_LIBRARY } from '../backend/src/ima-evidence.mjs';
import { createDeepSeekClient } from '../backend/src/deepseek-client.mjs';
import { createCurlFetch } from '../backend/src/curl-fetch.mjs';
import { createDebatesService } from '../backend/src/research-service.mjs';
import { createDebateStore } from '../backend/src/debate-store.mjs';

const mode = process.argv[2];
if (!['live', 'replay'].includes(mode)) throw new Error('Usage: node --env-file=.env scripts/verify-ima-pipeline.mjs live|replay (uses paid DeepSeek calls)');
const directory = new URL('../backend/storage/research-data/ima/pipeline-verification/', import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const schema = `ima_pipeline_test_${randomUUID().replaceAll('-', '')}`;
const rewrite = sql => sql.replaceAll('market_data.', `${schema}.`).replaceAll('CREATE SCHEMA IF NOT EXISTS market_data', `CREATE SCHEMA IF NOT EXISTS ${schema}`);
const store = createDebateStore({ pool: { query: (sql, params) => db.query(rewrite(sql), params), end: async () => {} } });
const startedAt = new Date().toISOString(), events = [];
const progress = (stage, detail = {}) => {
  const event = { time: new Date().toISOString(), stage, ...detail }; events.push(event); console.log(JSON.stringify(event));
};
try {
  let imaRetriever;
  if (mode === 'live') {
    const live = await createImaRetriever();
    imaRetriever = { async retrieve(...args) { progress('ima_live_read'); const result = await live.retrieve(...args); progress('ima_live_result', { status: result.status, sources: result.sources.length }); return result; } };
  } else {
    const { rows } = await db.query(`SELECT d.media_id,d.title,d.sha256,d.downloaded_at,
      json_agg(json_build_object('page',p.page_number,'text',p.content,'method','ocr') ORDER BY p.page_number) AS pages
      FROM research_data.ima_documents d JOIN research_data.ima_document_pages p USING(library_id,media_id)
      WHERE d.library_id=$1 AND d.title LIKE '%德赛西威%' AND d.download_status='downloaded' AND p.page_number<=4
      GROUP BY d.media_id,d.title,d.sha256,d.downloaded_at ORDER BY d.title LIMIT 2`, [IMA_LIBRARY.id]);
    if (!rows.length) throw new Error('No previously obtained IMA evidence for replay');
    const sources = rows.map((row, index) => makeImaSource(row, row.pages, { index, contentSha256: row.sha256, retrievedAt: new Date(row.downloaded_at).toISOString() }));
    imaRetriever = { async retrieve() { progress('ima_replay', { sources: sources.length }); return { status: 'used', sources,
      libraryName: IMA_LIBRARY.name, checkedAt: new Date().toISOString(), cacheHit: true,
      message: '验证回放：使用此前从 ima 取得的真实研报，非本次实时读取。' }; } };
  }
  const transport = process.env.BACKEND_HTTP_TRANSPORT === 'curl' ? createCurlFetch({ proxyEnv: process.env }) : globalThis.fetch;
  const client = createDeepSeekClient({ apiKey: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL, imaRetriever,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body || '{}');
      progress(url.endsWith('/v1/tools/search') ? 'web_search' : body.text?.format?.name === 'ima_reference_views' ? 'reference_generation' : 'final_generation');
      return transport(url, options);
    } });
  const prompt = await readFile(new URL('../backend/prompts/core-debates.md', import.meta.url), 'utf8');
  const service = createDebatesService({ client, store, provider: 'deepseek', model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
    prompt, promptVersion: `ima-verification-${createHash('sha256').update(prompt).digest('hex').slice(0,12)}` });
  await store.migrate();
  const report = await service.generate({ ticker: '002920.SZ', companyName: '德赛西威' });
  const reread = await service.get({ ticker: '002920.SZ' });
  if (JSON.stringify(report.sources) !== JSON.stringify(reread.sources)) throw new Error('Database roundtrip mismatch');
  await writeFile(new URL(`${mode}-report.json`, directory), JSON.stringify(report, null, 2), { mode: 0o600 });
  const verification = { mode, startedAt, completedAt: new Date().toISOString(), success: true,
    liveImaSucceeded: mode === 'live' && report.pipeline.ima.sourceCount > 0,
    imaStatus: report.pipeline.ima.status, imaRead: report.pipeline.ima.sourceCount, imaCited: report.pipeline.ima.citedCount,
    referenceGenerated: report.pipeline.ima.referenceGenerated, modelCalls: report.pipeline.modelCalls,
    webSources: report.sources.filter(source => source.sourceKind !== 'ima').length,
    debates: report.debates.length, databaseRoundtrip: true, productionReportModified: false, events };
  await writeFile(new URL(`${mode}-verification.json`, directory), JSON.stringify(verification, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(verification));
} catch (error) {
  const result = { mode, startedAt, failedAt: new Date().toISOString(), success: false,
    code: /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'VERIFICATION_FAILED', events };
  await writeFile(new URL(`${mode}-verification.json`, directory), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result)); process.exitCode = 1;
} finally {
  try { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await db.end(); }
}
