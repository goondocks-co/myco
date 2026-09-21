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

/**
 * Whether nothing is at `target`.
 *
 * An entry that is there and leads nowhere is not an absence, and neither is a
 * leaf under an ancestor that leads nowhere: the walk stops at the nearest
 * entry and reports absence only where that entry is a directory the path could
 * have continued through. A check that could not be made is not an absence
 * either.
 */
export function pathIsAbsent(target: string): boolean {
  const resolved = path.resolve(target);
  let at = resolved;
  for (;;) {
    try {
      fs.lstatSync(at);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = path.dirname(at);
      if (parent === at) return true;
      at = parent;
    }
  }
  if (at === resolved) return false;
  try {
    return fs.statSync(at).isDirectory();
  } catch {
    return false;
  }
}

/** `<MYCO_HOME>/member`. */
export function memberRoot(mycoHome: string = resolveMycoHome()): string {
  return path.join(mycoHome, MEMBER_DIRNAME);
}

/** Permission bits beyond the owner. */
const OTHER_BITS = 0o077;

export function isPrivateMode(mode: number): boolean {
  return (mode & OTHER_BITS) === 0;
}

/** `p` under `base`, or null where it is not. Lexical only. */
function containedRel(base: string, p: string): string | null {
  const rel = path.relative(base, p);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

/** What `lstat` says is at `p`: the entry, or nothing, or a failure that is neither. */
function entryAt(p: string): { at: 'entry'; stat: fs.Stats } | { at: 'absent' } | { at: 'unknown'; code?: string } {
  try {
    return { at: 'entry', stat: fs.lstatSync(p) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { at: 'absent' } : { at: 'unknown', code };
  }
}

/**
 * Refuse a path that leaves the member root, by name or through a link.
 *
 * The configured home may sit under links — a home under `/tmp` on macOS
 * resolves elsewhere — so the home is resolved and the member root is expected
 * directly beneath what it resolved to. The `member` component is held to that:
 * a link there must resolve, and must resolve inside the home. Every component
 * below it must resolve inside the member root.
 *
 * Only a component that is genuinely not there ends the walk, so a leaf about
 * to be created is allowed while a component that cannot be read is refused.
 * Nothing here creates, opens or locks anything.
 */
export function assertMemberPathContained(target: string, mycoHome: string = resolveMycoHome()): void {
  const home = path.resolve(mycoHome);
  const root = memberRoot(mycoHome);
  const refusal = (why: string): Error =>
    new Error(`assertMemberPathContained: ${target} ${why} the member root ${root}`);

  const atHome = entryAt(home);
  if (atHome.at === 'unknown') throw refusal(`could not be checked against (${atHome.code}) for`);
  let homeAnchor = home;
  if (atHome.at === 'entry') {
    try {
      homeAnchor = fs.realpathSync(home);
    } catch (err) {
      throw refusal(`could not be checked against (${(err as NodeJS.ErrnoException).code}) for`);
    }
  }

  const resolved = path.resolve(target);
  const rel = containedRel(path.join(home, MEMBER_DIRNAME), resolved)
    ?? containedRel(path.join(homeAnchor, MEMBER_DIRNAME), resolved);
  if (rel === null) throw refusal('is outside');

  // The member component first, so a member root that is a link is held to the
  // home; then every component below it, held to the member root it resolved to.
  let at = homeAnchor;
  let bound = homeAnchor;
  for (const [index, part] of [MEMBER_DIRNAME, ...(rel === '' ? [] : rel.split(path.sep))].entries()) {
    at = path.join(at, part);
    const entry = entryAt(at);
    if (entry.at === 'absent') return;
    if (entry.at === 'unknown') throw refusal(`passes through a component that could not be read (${entry.code}) under`);
    if (entry.stat.isSymbolicLink()) {
      let dest: string;
      try {
        dest = fs.realpathSync(at);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        throw refusal(code === 'ENOENT' ? 'passes through a link leading nowhere under' : `passes through a link that could not be read (${code}) under`);
      }
      if (containedRel(bound, dest) === null) throw refusal('passes through a link out of');
      at = dest;
    }
    // Below the member root, containment is the member root itself.
    if (index === 0) bound = at;
  }
}

export function ensureMemberDir(dir: string, mycoHome: string = resolveMycoHome()): void {
  const root = memberRoot(mycoHome);
  const resolved = path.resolve(dir);
  // Before anything is created or chmodded: every component already there must
  // keep the path inside the root.
  assertMemberPathContained(resolved, mycoHome);
  // The levels below are built by joining `rel` onto the root, so the writer
  // takes only a path under the root AS NAMED. A canonical alias of the home,
  // which a read may use, puts `..` in `rel` and would walk the modes out.
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`ensureMemberDir: ${dir} is outside the member root ${root}`);
  }
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const levels = [root, ...(rel === '' ? [] : rel.split(path.sep).map((_, i, parts) => path.join(root, ...parts.slice(0, i + 1))))];
  for (const level of levels) {
    if (!fs.existsSync(level)) fs.mkdirSync(level, { mode: MEMBER_DIR_MODE });
    const stat = fs.statSync(level);
    if (!stat.isDirectory()) throw new Error(`ensureMemberDir: ${level} is not a directory`);
    const mode = stat.mode & 0o777;
    if (mode !== MEMBER_DIR_MODE) fs.chmodSync(level, MEMBER_DIR_MODE);
  }
}

/** Create `file` empty with mode 0600 when absent, so a later default-mode open finds it already private. */
export function ensurePrivateFile(file: string): void {
  const entry = entryAt(file);
  if (entry.at === 'unknown') throw new Error(`ensurePrivateFile: ${file} could not be checked (${entry.code})`);
  if (entry.at === 'entry') {
    if (!entry.stat.isFile()) throw new Error(`ensurePrivateFile: ${file} is not a regular file`);
    return;
  }
  try {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, MEMBER_FILE_MODE);
    fs.closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const current = entryAt(file);
    if (current.at !== 'entry' || !current.stat.isFile()) throw err;
  }
}

/** Write `content` to `file` atomically (tmp in the same directory, then rename), mode 0600. */
export function writePrivateFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, content, { mode: MEMBER_FILE_MODE });
  fs.renameSync(tmp, file);
}

export type PrivateRead<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'missing' | 'unreadable' | 'loose-mode' | 'malformed'; detail?: string };

/** Read and parse a private JSON file; a loose mode, an unreachable file or a parse failure reads as refused, never as data. `missing` is absence alone: every other errno is `unreadable`, so a file that is there and cannot be opened never reads as one that is not. */
export function readPrivateJson<T>(file: string): PrivateRead<T> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') return { ok: false, reason: 'unreadable', detail: code };
    // `stat` follows a link, so its ENOENT is the target's, not the entry's.
    return pathIsAbsent(file) ? { ok: false, reason: 'missing' } : { ok: false, reason: 'unreadable', detail: code };
  }
  if (!isPrivateMode(stat.mode)) return { ok: false, reason: 'loose-mode', detail: (stat.mode & 0o777).toString(8) };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return { ok: false, reason: 'unreadable', detail: (err as NodeJS.ErrnoException).code };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (err) {
    return { ok: false, reason: 'malformed', detail: (err as Error).message };
  }
}

/** One stderr line naming the file and why it was skipped. */
export function reportSkippedPrivateFile(what: string, file: string, read: { reason: string; detail?: string }): void {
  process.stderr.write(`[myco] member: ${what} skipped (${read.reason}${read.detail ? `: ${read.detail}` : ''}) ${file}\n`);
}
