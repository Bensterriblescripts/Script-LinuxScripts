// Internal worker, launched only under flock. No Pi APIs or model access.
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { normalize, readHistory } from './storage.mjs';

const directory = process.argv[2];
// One fixed temporary pathname is safe because the kernel lock covers its lifetime.
// It also bounds crash leftovers to one file, replaced on the next successful save.
const temporary = join(directory, 'history.tmp');
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text) {
    const latest = await readHistory(directory); // Invalid data aborts, never resets.
    const next = normalize([...latest, text]);
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(next) + '\n', 'utf8');
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, join(directory, 'history.json'));
  }
} catch {
  // Never print errors that could contain prompt data (e.g. JSON parse errors).
  process.exitCode = 1;
} finally {
  await unlink(temporary).catch(() => {});
}
