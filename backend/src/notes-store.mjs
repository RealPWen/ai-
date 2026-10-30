import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { ResearchError } from './errors.mjs';
import { watchlistOwner, watchlistCompany } from './watchlist-store.mjs';

export function noteIdentity(input) {
  return { owner: watchlistOwner(input?.owner), ticker: watchlistCompany(input).ticker };
}
export function noteInput(input) {
  const identity = noteIdentity(input);
  const companyName = typeof input?.companyName === 'string' ? input.companyName.trim() : '';
  if (!companyName || companyName.length > 120 || /[\p{Cc}\p{Cf}]/u.test(companyName)) throw new ResearchError('INVALID_COMPANY_NAME', '请提供有效公司名称', 400);
  if (typeof input.content !== 'string' || input.content.length > 50000 || input.content.includes('\0')) throw new ResearchError('INVALID_NOTE_CONTENT', '笔记内容最多 50000 字，不能含空字符', 400);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion >= 2147483647) throw new ResearchError('INVALID_NOTE_VERSION', '笔记版本无效，请重新读取', 400);
  return { ...identity, companyName, content: input.content, expectedVersion: input.expectedVersion };
}
const columns = 'owner_name AS owner, ticker, company_name AS "companyName", content, created_at AS "createdAt", updated_at AS "updatedAt", version';

export function createNotesStore({ connectionString, pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10000 }) } = {}) {
  const get = async input => {
    const { owner, ticker } = noteIdentity(input);
    return (await pool.query(`SELECT ${columns} FROM research_data.user_notes WHERE owner_name=$1 AND ticker=$2`, [owner, ticker])).rows[0] ?? null;
  };
  return {
    async migrate() { await pool.query(await readFile(new URL('./notes-schema.sql', import.meta.url), 'utf8')); },
    get,
    async save(input) {
      const { owner, ticker, companyName, content, expectedVersion } = noteInput(input);
      const values = [owner, ticker, companyName, content];
      const result = expectedVersion === 0
        ? await pool.query(`INSERT INTO research_data.user_notes(owner_name,ticker,company_name,content) VALUES($1,$2,$3,$4)
            ON CONFLICT(owner_name,ticker) DO NOTHING RETURNING ${columns}`, values)
        : await pool.query(`UPDATE research_data.user_notes SET company_name=$3,content=$4,updated_at=clock_timestamp(),version=version+1
            WHERE owner_name=$1 AND ticker=$2 AND version=$5 RETURNING ${columns}`, [...values, expectedVersion]);
      if (result.rows[0]) return result.rows[0];
      const current = await get({ owner, ticker });
      // A retry after a lost response can acknowledge the exact saved payload.
      if (current?.content === content && current.companyName === companyName) return current;
      throw new ResearchError('NOTE_CONFLICT', '其他页面已更新这条笔记，请先核对数据库版本；本地草稿已保留', 409);
    },
    close: () => pool.end(),
  };
}
