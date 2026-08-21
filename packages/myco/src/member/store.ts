/**
 * The member's private file store under `<MYCO_HOME>/member/`: every
 * directory 0700, every file 0600, atomic tmp+rename writes, and fail-closed
 * reads (a loose mode or an unparsable file reads as absent, with one stderr
 * line). Directories and lock files are created here with their modes BEFORE
 * any lock primitive or `EventBuffer` touches them, because those open with
 * default modes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { MEMBER_DIR_MODE, MEMBER_FILE_MODE } from './constants.js';

export const MEMBER_DIRNAME = 'member';

/** `<MYCO_HOME>/member`. */
export function memberRoot(mycoHome: string = resolveMycoHome()): string {
  return path.join(mycoHome, MEMBER_DIRNAME);
}

/** Permission bits beyond the owner. */
const OTHER_BITS = 0o077;

export function isPrivateMode(mode: number): boolean {
  return (mode & OTHER_BITS) === 0;
}

/**
 * Create `dir` (which must sit under the member root) and every level between
 * the member root and it with mode 0700; the member root itself is created
 * 0700 too. Levels above the member root (`MYCO_HOME`) are created with the
 * default mode when absent and left as they are.
 */
export function ensureMemberDir(dir: string, mycoHome: string = resolveMycoHome()): void {
  const root = memberRoot(mycoHome);
  const resolved = path.resolve(dir);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`ensureMemberDir: ${dir} is outside the member root ${root}`);
  }
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const levels = [root, ...(rel === '' ? [] : rel.split(path.sep).map((_, i, parts) => path.join(root, ...parts.slice(0, i + 1))))];
  for (const level of levels) {
    if (!fs.existsSync(level)) fs.mkdirSync(level, { mode: MEMBER_DIR_MODE });
    const mode = fs.statSync(level).mode & 0o777;
    if (mode !== MEMBER_DIR_MODE) fs.chmodSync(level, MEMBER_DIR_MODE);
  }
}

/** Create `file` empty with mode 0600 when absent, so a later default-mode open finds it already private. */
export function ensurePrivateFile(file: string): void {
  if (fs.existsSync(file)) return;
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT, MEMBER_FILE_MODE);
  fs.closeSync(fd);
}

/** Write `content` to `file` atomically (tmp in the same directory, then rename), mode 0600. */
export function writePrivateFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, content, { mode: MEMBER_FILE_MODE });
  fs.renameSync(tmp, file);
}

export type PrivateRead<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'missing' | 'loose-mode' | 'malformed'; detail?: string };

/** Read and parse a private JSON file; a loose mode or a parse failure reads as refused, never as data. */
export function readPrivateJson<T>(file: string): PrivateRead<T> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!isPrivateMode(stat.mode)) return { ok: false, reason: 'loose-mode', detail: (stat.mode & 0o777).toString(8) };
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf-8')) as T };
  } catch (err) {
    return { ok: false, reason: 'malformed', detail: (err as Error).message };
  }
}

/** One stderr line naming the file and why it was skipped. */
export function reportSkippedPrivateFile(what: string, file: string, read: { reason: string; detail?: string }): void {
  process.stderr.write(`[myco] member: ${what} skipped (${read.reason}${read.detail ? `: ${read.detail}` : ''}) ${file}\n`);
}
