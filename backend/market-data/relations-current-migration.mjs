import { todayShanghai, validDate } from '../src/input.mjs';

// One-time import of a single existing report per stock. Never union companies
// from different reports. A pre-existing current row is never changed on restart.
export async function migrateRelationsCurrent(client, now = () => new Date()) {
  const existing = await client.query(`SELECT to_regclass('market_data.company_relations') AS published,
    to_regclass('market_data.company_relation_jobs') AS jobs, to_regclass('market_data.company_relation_runs') AS runs`);
  const tables = existing.rows[0] ?? {}, snapshots = [];
  const ai = await client.query(`SELECT subject_ticker AS ticker, subject_name AS name, to_char(as_of,'YYYY-MM-DD') AS as_of,
    relations, gaps, researched_at, method_version, 'ai'::text AS source, job_id::text AS run_id, created_at
    FROM market_data.company_relation_ai_jobs WHERE status='succeeded' AND jsonb_array_length(relations)>0`);
  snapshots.push(...ai.rows);
  if (tables.published) {
    const published = await client.query(`SELECT subject_ticker AS ticker, max(subject_name) AS name,
      to_char(as_of,'YYYY-MM-DD') AS as_of, run_id, method_version, 'published'::text AS source,
      max(verified_at) AS researched_at, max(verified_at) AS created_at, '[]'::jsonb AS gaps,
      jsonb_agg(jsonb_build_object('relatedTicker',related_ticker,'relatedName',related_name,
        'relationType',relation_type,'evidenceType',evidence_type,'rank',rank,'rationale',rationale,
        'actualEntity',actual_entity,'listedMappingBasis',listed_mapping_basis,'notes',notes,
        'verifiedAt',verified_at,'sources',sources) ORDER BY rank) AS relations
      FROM market_data.company_relations r WHERE NOT EXISTS(SELECT 1 FROM market_data.company_relation_current c WHERE c.subject_ticker=r.subject_ticker)
      GROUP BY subject_ticker,as_of,run_id,method_version`);
    snapshots.push(...published.rows);
  }
  if (tables.jobs && tables.runs) {
    const jobs = await client.query(`SELECT j.ticker,j.name,to_char(r.as_of,'YYYY-MM-DD') AS as_of,
      j.run_id,r.method_version,j.draft_relations,j.archived_relations,j.gaps,j.updated_at AS created_at
      FROM market_data.company_relation_jobs j JOIN market_data.company_relation_runs r ON r.run_id=j.run_id
      WHERE NOT EXISTS(SELECT 1 FROM market_data.company_relation_current c WHERE c.subject_ticker=j.ticker)
        AND (jsonb_array_length(j.draft_relations)>0 OR j.archived_relations IS NOT NULL)`);
    for (const row of jobs.rows) {
      if (Array.isArray(row.draft_relations) && row.draft_relations.length) snapshots.push({...row,source:'draft',relations:row.draft_relations});
      const archive=row.archived_relations;
      if (Array.isArray(archive) && archive.length) snapshots.push({...row,source:'archive',relations:archive});
      else if (archive && Array.isArray(archive.relations) && archive.relations.length) snapshots.push({...row,
        source:'archive',as_of:archive.asOf ?? archive.as_of ?? row.as_of,run_id:archive.runId ?? row.run_id,
        method_version:archive.methodVersion ?? row.method_version,relations:archive.relations});
    }
  }
  const latest = new Map(), cutoff = todayShanghai(now());
  for (const row of snapshots) {
    if (!validDate(row.as_of) || row.as_of>cutoff || !Array.isArray(row.relations)) continue;
    const seen=new Set();
    const relations=row.relations.filter(relation=>{
      if (!relation || seen.has(relation.relatedTicker) || relation.relatedTicker===row.ticker
        || !/^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/.test(relation.relatedTicker)
        || !['upstream','peer','downstream'].includes(relation.relationType)
        || !Array.isArray(relation.sources) || !relation.sources.length
        || !Number.isFinite(Date.parse(relation.verifiedAt)) || todayShanghai(new Date(relation.verifiedAt))>row.as_of
        || relation.sources.some(source=>source.publishedAt && (!validDate(source.publishedAt)||source.publishedAt>row.as_of))) return false;
      seen.add(relation.relatedTicker); return true;
    }).slice(0,10).map((relation,index)=>({...relation,rank:index+1}));
    if (!relations.length) continue;
    const candidate={...row,relations,researched_at:new Date(Math.max(...relations.map(relation=>Date.parse(relation.verifiedAt)))).toISOString()};
    const prior=latest.get(row.ticker);
    // Preserve the fullest already-saved report during this one-time conversion;
    // all subsequent generation uses unconditional whole-report replacement.
    if (!prior || relations.length>prior.relations.length || relations.length===prior.relations.length
      && (row.as_of>prior.as_of || row.as_of===prior.as_of && Date.parse(row.created_at)>Date.parse(prior.created_at))) latest.set(row.ticker,candidate);
  }
  for (const row of latest.values()) await client.query(`INSERT INTO market_data.company_relation_current
    (subject_ticker,subject_name,as_of,relations,gaps,researched_at,method_version,source,run_id)
    VALUES($1,$2,$3::date,$4::jsonb,$5::jsonb,$6::timestamptz,$7,$8,$9)
    ON CONFLICT(subject_ticker) DO NOTHING`,[row.ticker,row.name,row.as_of,JSON.stringify(row.relations),
      JSON.stringify(row.gaps ?? []),row.researched_at,row.method_version,row.source,row.run_id]);
  await client.query(`UPDATE market_data.company_relation_ai_jobs SET result_count=least(10,jsonb_array_length(relations)),relations='[]'::jsonb
    WHERE jsonb_array_length(relations)>0`);
  // The task table no longer stores business-result copies. Keep this invariant
  // in PostgreSQL too, including databases upgraded from the prior 30-row cap.
  await client.query(`ALTER TABLE market_data.company_relation_ai_jobs DROP CONSTRAINT IF EXISTS company_relation_ai_jobs_relations_check`);
  await client.query(`ALTER TABLE market_data.company_relation_ai_jobs ADD CONSTRAINT company_relation_ai_jobs_relations_check
    CHECK(jsonb_typeof(relations)='array' AND jsonb_array_length(relations)=0)`);
}
