import pg from 'pg';
import { ResearchError } from './errors.mjs';
export function watchlistOwner(value) {
  const name = typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : '';
  if (!name || name.length > 40 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new ResearchError('INVALID_OWNER', '请输入有效姓名（最多40字）', 400);
  return name;
}
export function watchlistCompany(value) {
  const ticker = typeof value?.ticker === 'string' ? value.ticker.trim().toUpperCase() : '';
  if (!/^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/.test(ticker)) throw new ResearchError('INVALID_TICKER', '自选仅支持A股和港股代码', 400);
  return { ticker, name: typeof value.name === 'string' ? value.name.trim().slice(0, 120) || ticker : ticker };
}
export function createWatchlistStore({ connectionString }) {
 const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10000 });
 const list = async owner => (await pool.query(`SELECT ticker,company_name AS name,added_at AS "addedAt" FROM market_data.user_watchlists WHERE owner_name=$1 ORDER BY added_at,ticker`, [watchlistOwner(owner)])).rows;
 return {
  async migrate() { await pool.query(`CREATE SCHEMA IF NOT EXISTS market_data;
   CREATE TABLE IF NOT EXISTS market_data.user_watchlists (
    owner_name text NOT NULL CHECK(length(btrim(owner_name)) BETWEEN 1 AND 40),
    ticker text NOT NULL CHECK(ticker ~ '^(?:[0-9]{6}\\.(SH|SZ|BJ)|[0-9]{5}\\.HK)$'),
    company_name text NOT NULL, added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(owner_name,ticker));
   CREATE INDEX IF NOT EXISTS user_watchlists_ticker_idx ON market_data.user_watchlists(ticker);`); },
  list,
  async change({ owner, action, companies = [], ticker }) {
   owner=watchlistOwner(owner);
   if (!['add','remove','import'].includes(action)) throw new ResearchError('INVALID_ACTION','自选操作无效',400);
   if (!Array.isArray(companies) || companies.length>200) throw new ResearchError('INVALID_COMPANIES','每人最多200只自选',400);
   const rows=action==='remove' ? [watchlistCompany({ticker})] : companies.map(watchlistCompany);
   if(action==='add'&&rows.length!==1)throw new ResearchError('INVALID_COMPANIES','请选择一只股票',400);
   const c=await pool.connect();
   try { await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1), 786215)',[owner]);
    if(action==='remove')await c.query('DELETE FROM market_data.user_watchlists WHERE owner_name=$1 AND ticker=$2',[owner,rows[0].ticker]);
    else for(const row of rows) await c.query(`INSERT INTO market_data.user_watchlists(owner_name,ticker,company_name) VALUES($1,$2,$3) ON CONFLICT(owner_name,ticker) DO NOTHING`,[owner,row.ticker,row.name]);
    const n=(await c.query('SELECT count(*) FROM market_data.user_watchlists WHERE owner_name=$1',[owner])).rows[0].count;
    if(Number(n)>200)throw new ResearchError('WATCHLIST_LIMIT','每人最多200只自选',400);
    await c.query('COMMIT');
   } catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
   return list(owner);
  },
  async union() { return (await pool.query('SELECT DISTINCT ticker FROM market_data.user_watchlists ORDER BY ticker')).rows.map(r=>r.ticker); },
  close:()=>pool.end()
 };
}
