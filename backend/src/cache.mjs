import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
// File fallback has the same latest-per-ticker identity as PostgreSQL. Legacy
// date/model/account-partition files are never searched or imported here.
export function createFileCache(directory) {
  const key = input => createHash('sha256').update(JSON.stringify([input.ticker.trim().toUpperCase()])).digest('hex');
  return {
    key,
    async get(input) {
      try { const report = JSON.parse(await readFile(path.join(directory, `${key(input)}.json`), 'utf8')); return { ...report, cached: true }; }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
    },
    async set(input, report) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = path.join(directory, `${key(input)}.json`), temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
      await rename(temporary, target);
    },
  };
}
