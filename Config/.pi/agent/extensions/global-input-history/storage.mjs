import { mkdir, open, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function normalize(entries) {
  const result = [];
  for (const entry of entries) {
    const text = entry.trim();
    if (text && result.at(-1) !== text) result.push(text);
  }
  return result.slice(-100);
}

export async function readHistory(directory) {
  let raw;
  try { raw = await readFile(join(directory, 'history.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string')) {
    throw new Error('Invalid history shape');
  }
  return normalize(entries);
}

export async function saveInput(directory, text) {
  text = text.trim();
  if (!text) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Never unlink this inode: all writers must lock the same file.
  const lock = await open(join(directory, 'history.lock'), 'a', 0o600);
  await lock.close();
  await new Promise((resolve, reject) => {
    // -F replaces flock with the worker: timeout kills the actual lock holder.
    // Prompts go over stdin, never command arguments, stdout, or stderr.
    const child = spawn('/usr/bin/flock', [
      '-F', '-w', '2', join(directory, 'history.lock'), process.execPath,
      fileURLToPath(new URL('./writer.mjs', import.meta.url)), directory,
    ], { stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000, killSignal: 'SIGKILL' });
    child.on('error', reject);
    child.stdin.on('error', () => {}); // Early lock failure may close the pipe.
    child.on('close', code => code === 0 ? resolve() : reject(new Error('History save failed')));
    child.stdin.end(text);
  });
}
