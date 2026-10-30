import { rename } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

// Keep atomic replacement: never unlink the last good file to work around a lock.
export async function replaceFile(source, destination, {
  platform = process.platform, renameImpl = rename, sleep = setTimeout, attempts = 10,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await renameImpl(source, destination); return; }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= attempts - 1) throw error;
      await sleep(200 * (attempt + 1));
    }
  }
}
