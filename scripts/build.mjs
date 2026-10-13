import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../frontend/', import.meta.url));
const output = fileURLToPath(new URL('../dist/', import.meta.url));
await mkdir(output, { recursive: true });
// Keep Sites-generated deployment metadata. Everything else is generated from frontend/.
for (const name of await readdir(output)) {
  if (name !== '.openai') await rm(`${output}/${name}`, { recursive: true, force: true });
}
await cp(source, output, { recursive: true });
console.log('Frontend built: frontend/ → dist/');
