import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_HK_UNIVERSE_PATH = fileURLToPath(new URL('./hk-universe.json', import.meta.url));

function invalid() {
  const error = new Error('港股投资池名单格式或代码无效。');
  error.kind = 'validation'; error.code = 'VALIDATION_ERROR'; return error;
}

export function validateHongKongUniverse(value) {
  if (!value || value.version !== 1 || typeof value.source?.path !== 'string' || !value.source.path.trim()
    || typeof value.source?.sheet !== 'string' || !value.source.sheet.trim()
    || !Array.isArray(value.securities) || !value.securities.length || value.securities.length > 1000) throw invalid();
  const securities = value.securities.map(row => {
    if (!row || typeof row.ticker !== 'string' || !/^\d{5}\.HK$/.test(row.ticker)
      || typeof row.name !== 'string' || !row.name.trim() || !Number.isSafeInteger(row.row) || row.row < 1) throw invalid();
    return { ticker: row.ticker, name: row.name.trim(), row: row.row };
  });
  const tickers = securities.map(row => row.ticker);
  if (new Set(tickers).size !== tickers.length) throw invalid();
  // Renaming a sheet or company does not invalidate price coverage; a changed
  // ticker membership always has a different run identity.
  const universeHash = createHash('sha256').update([...tickers].sort().join('\n')).digest('hex');
  return { version: 1, source: { path: value.source.path, sheet: value.source.sheet }, securities, tickers, universeHash };
}

export async function loadHongKongUniverse(path = DEFAULT_HK_UNIVERSE_PATH) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw invalid(); }
  return validateHongKongUniverse(value);
}
