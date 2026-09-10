/**
 * Writing the managed block into a repository's AGENTS.md, atomically.
 *
 * The whole safety property of writing into someone's file is that the file is
 * never half-written: the new text is written beside it and renamed over it,
 * so a fault at any point leaves either the old file or the new one and never
 * a mix. The replacement itself is the shared pure function; this is the only
 * place bytes reach a disk.
 */
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { replaceManagedBlock } from '@goondocks/myco-shared/agents-block';

/** What the write answered: whether the file changed. */
export interface ManagedBlockWrite {
  changed: boolean;
}

/**
 * Replace the managed block in the file at `path` with `body`, or append one.
 *
 * The temporary file lives in the same directory as the target, so the rename
 * is one filesystem operation and never a copy across devices. `write` is the
 * seam a fault-injection test drives; the default is the real write.
 */
export function writeManagedBlock(path: string, body: string, write: (file: string, text: string) => void = (file, text) => writeFileSync(file, text, 'utf8')): ManagedBlockWrite {
  let current = '';
  try { current = readFileSync(path, 'utf8'); } catch { current = ''; }
  const next = replaceManagedBlock(current, body);
  if (next === current) return { changed: false };
  const staging = mkdtempSync(join(dirname(path), '.myco-agents-'));
  const temp = join(staging, 'AGENTS.md');
  try {
    write(temp, next);
    renameSync(temp, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { changed: true };
}
