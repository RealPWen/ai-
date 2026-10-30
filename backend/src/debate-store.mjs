import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { ResearchError } from './errors.mjs';
import { parseInput, todayShanghai, validDate } from './input.mjs';
import { reportSchema, validateShape } from './schema.mjs';
import { canonicalUrl } from './source-audit.mjs';
import { imaEvidenceKey, IMA_LIBRARY } from './ima-evidence.mjs';

const TICKER=/^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const PROVIDERS=new Set(['deepseek','chatgpt','openai']);
const MAX_REPORT_BYTES=2*1024*1024;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=message=>new ResearchError('INVALID_DEBATE_REPORT',message,400);
const unavailable=()=>new ResearchError('DEBATE_DATABASE_UNAVAILABLE','核心市场分歧数据库暂不可用，请稍后重试。',503);
function tickerOf(input){
  const ticker=typeof input?.ticker==='string'?input.ticker.trim().toUpperCase():'';
  if(!TICKER.test(ticker))throw invalid('请输入有效的股票代码。');
  return ticker;
}
function timestamp(value){
  if(typeof value!=='string'||value.length>64||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    ||!validDate(value.slice(0,10))||+value.slice(11,13)>23||!Number.isFinite(Date.parse(value)))throw invalid('报告生成时间须为有效的含时区 ISO 时间。');
  return new Date(value).toISOString();
}
function nonempty(value,label,max=12000){
  if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\u0000'))throw invalid(`${label}无效。`);
  return value;
}
// Auditing adds fields such as citationVerified. Validate the schema's core
// fields while preserving all bounded audit metadata in the stored report.
function coreProjection(value,schema){
  if(schema.type==='object'&&object(value))return Object.fromEntries(Object.entries(schema.properties)
    .filter(([key])=>Object.hasOwn(value,key)).map(([key,child])=>[key,coreProjection(value[key],child)]));
  if(schema.type==='array'&&Array.isArray(value))return value.map(item=>coreProjection(item,schema.items));
  return value;
}

/** Validate an already audited report, without retrieving or inventing sources. */
export function validateStoredDebateReport(input,report,{now=()=>new Date()}={}){
  const ticker=tickerOf(input),current=typeof now==='function'?now():now;
  if(!object(report))throw invalid('核心市场分歧报告无效。');
  let json;try{json=JSON.stringify(report);}catch{throw invalid('报告不是可保存的 JSON。');}
  if(!json||Buffer.byteLength(json)>MAX_REPORT_BYTES||json.includes('\\u0000'))throw invalid('报告过长或含非法字符。');
  const value=JSON.parse(json);
  try{validateShape(coreProjection(value,reportSchema));}catch{throw invalid('报告核心字段不完整或类型无效。');}
  if(tickerOf(value)!==ticker||tickerOf(value.company)!==ticker)throw invalid('报告证券代码与保存标的不一致。');
  if(value.company.identityStatus!=='verified')throw invalid('尚未核实公司身份，不能覆盖已保存报告。');
  nonempty(value.company.name,'公司名称',1000);nonempty(value.company.description,'公司说明');nonempty(value.summary,'报告摘要');
  if(!PROVIDERS.has(value.provider))throw invalid('报告须保留已知的模型服务来源。');
  nonempty(value.model,'报告模型',200);nonempty(value.promptVersion,'提示词版本',200);
  const generatedAt=timestamp(value.generatedAt);
  if(Date.parse(generatedAt)>current.getTime()+300000)throw invalid('报告生成时间不能明显晚于当前时间。');
  if(!validDate(value.asOf)||value.asOf>todayShanghai(current)||value.asOf>todayShanghai(new Date(generatedAt))
    ||!validDate(value.windowStart)||parseInput({ticker,asOf:value.asOf},current).windowStart!==value.windowStart)throw invalid('报告研究日期或观察窗口无效。');
  if(value.updatedAt!==undefined&&timestamp(value.updatedAt)!==generatedAt)throw invalid('报告最后更新时间须等于原生成时间。');
  if(value.cached!==undefined&&typeof value.cached!=='boolean')throw invalid('报告缓存标记无效。');
  if(value.debates.length>3||!value.sources.length||value.sources.length>40||value.coverage.length>20)throw invalid('报告分歧或来源数量无效。');
  const sources=new Set();
  for(const source of value.sources){
    nonempty(source.id,'来源编号',200);nonempty(source.title,'来源标题');nonempty(source.url,'来源网址',4096);
    const ima = source.sourceKind === 'ima';
    const validIma = ima && imaEvidenceKey(source.url) === `ima://${IMA_LIBRARY.id}/${source.mediaId}`
      && source.libraryName === IMA_LIBRARY.name && /^[a-f0-9]{64}$/.test(source.contentSha256 || '')
      && Array.isArray(source.excerpts) && source.excerpts.length > 0 && source.excerpts.length <= 8
      && source.excerpts.every(p => Number.isInteger(p.page) && p.page > 0 && typeof p.text === 'string' && p.text.length >= 80 && p.text.length <= 3500);
    if(sources.has(source.id)||source.citationVerified!==true||!(ima ? validIma : canonicalUrl(source.url))
      ||source.publishedAt!==null&&(!validDate(source.publishedAt)||source.publishedAt>value.asOf))throw invalid('报告来源未通过引用或日期校验。');
    sources.add(source.id);
  }
  const debates=new Set();
  for(const debate of value.debates){
    nonempty(debate.id,'分歧编号',200);nonempty(debate.title,'分歧标题');nonempty(debate.summary,'分歧摘要');
    if(debates.has(debate.id))throw invalid('报告分歧编号重复。');
    debates.add(debate.id);
    for(const side of [debate.bull,debate.bear]){
      nonempty(side.summary,'分歧观点');
      if(new Set(side.sourceIds).size!==side.sourceIds.length||side.sourceIds.some(id=>!sources.has(id))
        ||side.evidenceStatus==='source_view'&&!side.sourceIds.length)throw invalid('报告观点引用了不存在的来源。');
    }
  }
  if(new Set(value.coverage.map(item=>item.platform)).size!==value.coverage.length)throw invalid('报告检索覆盖项目重复。');
  return {...value,ticker,company:{...value.company,ticker},generatedAt,updatedAt:generatedAt,cached:false};
}

function readReport(row,input,now){
  if(!row)return null;
  try{
    const report=validateStoredDebateReport(input,row.report,{now});
    const updatedAt=new Date(row.updated_at).toISOString();
    if(updatedAt!==report.generatedAt)throw new Error();
    return {...report,updatedAt,cached:true};
  }catch{throw new ResearchError('INVALID_SAVED_DEBATE_REPORT','已保存的核心市场分歧未通过校验，请重新更新。',503);}
}

/** One latest report per ticker. Older/equal generations never replace it. */
export function createDebateStore({connectionString,pool:injectedPool,now=()=>new Date()}={}){
  if(!injectedPool&&(typeof connectionString!=='string'||!connectionString.trim()))throw unavailable();
  const pool=injectedPool??new pg.Pool({connectionString,max:3,connectionTimeoutMillis:10000,query_timeout:20000});
  if(!injectedPool)pool.on('error',()=>{});
  async function query(sql,values){try{return await pool.query(sql,values);}catch{throw unavailable();}}
  async function get(input){
    const ticker=tickerOf(input);
    const result=await query('SELECT report,updated_at FROM market_data.core_market_debates WHERE ticker=$1',[ticker]);
    return readReport(result.rows[0],{ticker},now);
  }
  return {
    key:input=>tickerOf(input),
    async migrate(){await query(await readFile(new URL('./debate-schema.sql',import.meta.url),'utf8'));},
    get,
    async set(input,report){
      const value=validateStoredDebateReport(input,report,{now});
      const result=await query(`INSERT INTO market_data.core_market_debates AS current_report(ticker,report,updated_at,provider,model,prompt_version)
        VALUES($1,$2::jsonb,$3::timestamptz,$4,$5,$6) ON CONFLICT(ticker) DO UPDATE SET report=EXCLUDED.report,
        updated_at=EXCLUDED.updated_at,provider=EXCLUDED.provider,model=EXCLUDED.model,prompt_version=EXCLUDED.prompt_version,saved_at=clock_timestamp()
        WHERE current_report.updated_at<EXCLUDED.updated_at RETURNING report,updated_at`,
      [value.ticker,JSON.stringify(value),value.generatedAt,value.provider,value.model,value.promptVersion]);
      if(result.rows.length)return {...readReport(result.rows[0],{ticker:value.ticker},now),cached:false};
      // A concurrent process may have committed a newer generation. Return the
      // actual latest row rather than a discarded report to the caller.
      const latest=await get({ticker:value.ticker});if(!latest)throw unavailable();return latest;
    },
    async close(){try{await pool.end();}catch{throw unavailable();}},
  };
}

/** Legacy files have no reliable public/private-account marker. No file is
 * eligible unless the caller explicitly proves its partition/provider origin.
 * This helper never deletes files, generates reports, or invokes a provider. */
export async function migrateLegacyDebates({directory,store,acceptReport,now=()=>new Date()}={}){
  if(typeof directory!=='string'||!directory.trim()||typeof store?.set!=='function'
    ||acceptReport!==undefined&&typeof acceptReport!=='function')throw invalid('旧报告迁移参数无效。');
  const summary={scannedFiles:0,acceptedFiles:0,rejectedFiles:0,invalidFiles:0,selectedTickers:0,importedTickers:0,skippedOlderTickers:0,outcomes:[]};
  let files;try{files=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return summary;throw new ResearchError('DEBATE_MIGRATION_UNAVAILABLE','无法读取旧报告备份目录。',503);}
  const selected=new Map();
  for(const file of files.filter(file=>file.isFile()&&/^[a-f0-9]{64}\.json$/.test(file.name)).sort((a,b)=>a.name.localeCompare(b.name))){
    summary.scannedFiles++;const path=join(directory,file.name);let report;
    try{if((await stat(path)).size>MAX_REPORT_BYTES)throw new Error();report=JSON.parse(await readFile(path,'utf8'));}
    catch{summary.invalidFiles++;continue;}
    if(!acceptReport){summary.rejectedFiles++;continue;}
    let accepted;try{accepted=await acceptReport(report,{filename:file.name,path});}
    catch{throw new ResearchError('DEBATE_MIGRATION_AUTHORIZATION_FAILED','旧报告来源验证失败，迁移尚未写入数据库。',503);}
    if(accepted!==true&&!object(accepted)){summary.rejectedFiles++;continue;}
    if(object(accepted)&&(!PROVIDERS.has(accepted.provider)||Object.keys(accepted).some(key=>key!=='provider'))){summary.rejectedFiles++;continue;}
    if(object(accepted))report={...report,provider:accepted.provider};
    try{report=validateStoredDebateReport({ticker:report?.ticker},report,{now});}catch{summary.invalidFiles++;continue;}
    summary.acceptedFiles++;
    const previous=selected.get(report.ticker);
    if(!previous||Date.parse(previous.report.generatedAt)<Date.parse(report.generatedAt))selected.set(report.ticker,{report,filename:file.name});
  }
  summary.selectedTickers=selected.size;
  for(const {report,filename} of [...selected.values()].sort((a,b)=>a.report.ticker.localeCompare(b.report.ticker))){
    const saved=await store.set({ticker:report.ticker},report),imported=saved?.cached===false;
    if(imported)summary.importedTickers++;else summary.skippedOlderTickers++;
    summary.outcomes.push({ticker:report.ticker,filename,generatedAt:report.generatedAt,storedGeneratedAt:saved?.generatedAt??null,status:imported?'imported':'kept_existing'});
  }
  return summary;
}
