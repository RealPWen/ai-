import { syncIma, SyncError } from '../backend/research-data/ima-sync.mjs';
const args = process.argv.slice(2);
const value = (key, fallback) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : fallback; };
try {
  const workers = Number(value('--workers', '3'));
  const reserveGB = Number(value('--reserve-gb', '15'));
  const maxDownloads = Number(value('--max-downloads', 'Infinity'));
  if (!Number.isInteger(workers) || workers < 1 || workers > 6 || !Number.isFinite(reserveGB) || reserveGB < 5 || !(maxDownloads > 0)) throw new SyncError('INVALID_OPTIONS');
  await syncIma({ mode: value('--mode', 'sync'), workers, reserveBytes: reserveGB * 1024 ** 3, maxDownloads, retryErrors: args.includes('--retry-errors') });
} catch (e) {
  console.error(JSON.stringify({ status: 'failed', code: e instanceof SyncError ? e.code : 'IMA_SYNC_FAILED' }));
  process.exitCode = 1;
}
