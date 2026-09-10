/**
 * Writing the managed block into a repository's AGENTS.md, atomically.
 *
 * The whole safety property of writing into someone's file is that the file is
 * never half-written: the new text is written beside it and renamed over it,
 * so a fault at any point leaves either the old file or the new one and never
 * a mix. The replacement itself is the shared pure function; this is the only
 * place bytes reach a disk, and it writes the file as the project keeps it —
 * through a symlink to its target, with the mode the file had.
 */
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { ManagedBlockError, replaceManagedBlock } from '@goondocks/myco-shared/agents-block';

/** What the write answered: whether the file changed. */
export interface ManagedBlockWrite {
  changed: boolean;
}

/** What a write may be told beyond the path and the body. */
export interface ManagedBlockWriteOptions {
  /** The repository root the file must stay under once symlinks are followed; the file's own directory when absent. */
  root?: string;
  /** The seam a fault-injection test drives; the default is the real write. */
  write?: (file: string, text: string) => void;
}

/**
 * Replace the managed block in the file at `path` with `body`, or append one.
 *
 * A symlink is followed to the file it names, so a repository that keeps
 * `AGENTS.md → CLAUDE.md` keeps the link and gets the block in the target — but
 * only inside the repository: a link that leaves the root names a file the
 * Deployment was never asked to write, and is refused. The temporary file lives
 * in the target's own directory, so the rename is one filesystem operation and
 * never a copy across devices, and it carries the target's mode. A file whose
 * markers the replacement will not guess about is refused whole
 * (`ManagedBlockError`) and left untouched.
 */
export function writeManagedBlock(path: string, body: string, options: ManagedBlockWriteOptions = {}): ManagedBlockWrite {
  const write = options.write ?? ((file: string, text: string) => writeFileSync(file, text, 'utf8'));
  const exists = existsSync(path) || isDanglingLink(path);
  // A file not yet there is written where its directory really is, so a temp
  // directory reached through a symlink compares against its own real path.
  const target = exists && !isDanglingLink(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
  const root = realpathSync(options.root ?? dirname(path));
  const inside = relative(root, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) {
    throw new ManagedBlockError(`the instructions file resolves outside the repository root: ${target}`);
  }
  let current = '';
  try { current = readFileSync(target, 'utf8'); } catch { current = ''; }
  const next = replaceManagedBlock(current, body);
  if (next === current) return { changed: false };
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  const staging = mkdtempSync(join(dirname(target), '.myco-agents-'));
  const temp = join(staging, 'AGENTS.md');
  try {
    write(temp, next);
    chmodSync(temp, mode);
    renameSync(temp, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { changed: true };
}

/** A symlink whose target is gone: written as a plain file at its own path rather than followed nowhere. */
function isDanglingLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() && !existsSync(path); } catch { return false; }
}
