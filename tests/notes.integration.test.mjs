import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createNotesStore } from '../backend/src/notes-store.mjs';

test('PostgreSQL notes persist exact content, authors and server timestamps; stale concurrent writes are rejected', {
  skip: process.env.NOTES_DATABASE_TESTS !== '1' || !process.env.DATABASE_URL,
}, async () => {
  const schema = `notes_test_${randomUUID().replaceAll('-', '')}`;
  const raw = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const pool = { query: (sql, values) => raw.query(sql.replaceAll('research_data.', `${schema}.`).replaceAll('CREATE SCHEMA IF NOT EXISTS research_data', `CREATE SCHEMA IF NOT EXISTS ${schema}`), values), end: async () => {} };
  const store = createNotesStore({ pool });
  const base = { owner: '隔离测试甲', ticker: '002920.SZ', companyName: '德赛西威', content: '原文\n<标签>  尾部 ', expectedVersion: 0 };
  try {
    await store.migrate(); await store.migrate(); assert.equal(await store.get(base), null);
    const first = await store.save(base); assert.equal(first.owner, base.owner); assert.equal(first.content, base.content);
    assert.ok(first.createdAt instanceof Date); assert.ok(first.updatedAt instanceof Date);
    await store.save({ ...base, owner: '隔离测试乙', content: '另一位作者' });
    const second = await store.save({ ...base, expectedVersion: first.version, content: '更新后的笔记' });
    assert.equal(second.createdAt.toISOString(), first.createdAt.toISOString()); assert.ok(second.updatedAt > first.updatedAt); assert.equal(second.version, 2);
    await assert.rejects(store.save({ ...base, expectedVersion: 1, content: '过期请求' }), e => e.code === 'NOTE_CONFLICT');
    const retry = await store.save({ ...base, expectedVersion: 1, content: second.content }); assert.equal(retry.version, 2);
    const raced = await Promise.allSettled(['并发甲', '并发乙'].map(content => store.save({ ...base, expectedVersion: 2, content })));
    assert.equal(raced.filter(x => x.status === 'fulfilled').length, 1); assert.equal(raced.filter(x => x.reason?.code === 'NOTE_CONFLICT').length, 1);
    const latest = await store.get(base); assert.equal(latest.version, 3);
    await store.save({ ...base, expectedVersion: latest.version, content: '' }); assert.equal((await store.get(base)).content, '');
    assert.equal((await store.get({ ...base, owner: '隔离测试乙' })).content, '另一位作者');
    assert.equal(Number((await raw.query(`SELECT count(*) FROM ${schema}.user_notes`)).rows[0].count), 2);
  } finally { await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await raw.end(); }
});
