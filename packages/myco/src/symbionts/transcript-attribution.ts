/**
 * Which project a transcript found on disk belongs to.
 *
 * A harness's transcript store is not project-scoped: `~/.claude/projects/`
 * holds every project on the machine, and a walk of it answers files rather
 * than a project's files. A hook never faces this — it fires from inside a
 * project, and the credential resolved from that root is the answer — so this
 * exists only for the direction that has no hook, which is import (#1148).
 *
 * Getting it wrong is silent in both directions. Attributing nothing files one
 * project's history under another's; attributing too narrowly discards a
 * machine's other checkouts while reporting itself complete. Neither shows up
 * as a failure: every row lands and every count looks right.
 *
 * Two mechanisms, in order, because the manifests support two:
 *
 *   - the working directory the transcript records, at the dot path its
 *     manifest declares. Exact, and available only where the format writes one.
 *   - the project-slug path segment, for stores that name their directory after
 *     the project root. Inexact but real: it is how the harnesses that record no
 *     cwd are attributable at all.
 *
 * The header read is bounded — a transcript reaches tens of megabytes and the
 * working directory is in its first records — so a format that stops writing
 * that key early loses attribution silently and entirely. That is a contract on
 * the format, not a property of this code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getAtPath } from '../utils/dot-path.js';
import { runGitAnswer } from '../utils/git.js';
import { manifestTranscriptDiscovery } from './transcript-discovery.js';

/** Bytes of a transcript read while looking for the working directory. */
export const HEAD_BYTES = 64 * 1024;
/** Lines of that head inspected. Beyond this the record is not a header. */
export const MAX_HEADER_LINES = 40;

/**
 * The string a transcript's head records at a dot path, or null.
 *
 * Reads the head only. A partial trailing line and a line that is not JSON are
 * both ordinary here and neither is an error: the answer is the first line that
 * carries the key.
 */
export function transcriptHeadField(filePath: string, dotPath: string): string | null {
  let handle: number;
  try {
    handle = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, read).toString('utf8').split('\n').slice(0, MAX_HEADER_LINES)) {
      if (line.trim() === '') continue;
      try {
        const found = getAtPath(JSON.parse(line) as unknown, dotPath);
        if (typeof found === 'string' && found !== '') return found;
      } catch {
        continue;
      }
    }
    return null;
  } finally {
    fs.closeSync(handle);
  }
}

/** Parse an instant a transcript line records: an ISO string or epoch milliseconds. */
const instantOf = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * The first and last instants a transcript's lines record in a top-level
 * `timestamp`, read from its head and its tail only; null when neither holds
 * one.
 */
export function transcriptTimeSpan(filePath: string): { first: number; last: number } | null {
  let handle: number;
  try { handle = fs.openSync(filePath, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(handle).size;
    const readAt = (offset: number, length: number): string[] => {
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(handle, buffer, 0, length, offset);
      return buffer.subarray(0, read).toString('utf8').split('\n');
    };
    const instants = (lines: string[]): number[] => lines.flatMap((line) => {
      try { const at = instantOf((JSON.parse(line) as Record<string, unknown>).timestamp); return at === null ? [] : [at]; } catch { return []; }
    });
    const head = instants(readAt(0, Math.min(size, HEAD_BYTES)).slice(0, MAX_HEADER_LINES));
    const tail = instants(readAt(Math.max(0, size - HEAD_BYTES), Math.min(size, HEAD_BYTES)).slice(size > HEAD_BYTES ? 1 : 0));
    const all = [...head, ...tail];
    return all.length === 0 ? null : { first: head[0] ?? Math.min(...all), last: Math.max(...all) };
  } finally {
    fs.closeSync(handle);
  }
}

/** The working directory a transcript records, or null. */
export const transcriptCwd = (filePath: string, cwdPath: string): string | null => transcriptHeadField(filePath, cwdPath);

/** A project root as a store names its directory: non-alphanumeric runs collapsed to a dash, and any leading dash dropped. */
export const rootSlug = (root: string): string => root.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+/, '');

/**
 * The root whose slug appears as a path segment, or null.
 *
 * Both the bare and the leading-dash spellings are in use across the stores
 * that do this, so both are matched.
 */
export function attributeByPathSlug(filePath: string, roots: Iterable<string>): string | null {
  const segments = new Set(filePath.split('/').filter(Boolean));
  for (const root of roots) {
    const slug = rootSlug(root);
    if (slug === '') continue;
    if (segments.has(slug) || segments.has(`-${slug}`)) return root;
  }
  return null;
}

/**
 * Where a transcript belongs, as one of three answers.
 *
 * The three are kept apart because they mean different things to whoever reads
 * the report. `bound` is a checkout this machine works in. `elsewhere` is a
 * real directory the transcript names that no binding covers — "your other
 * project is not connected here", which a person can act on. `unknown` is a
 * transcript that names no place at all, which is a property of the harness's
 * format rather than of this machine's setup.
 *
 * Collapsing the last two would report a disconnected project as an unreadable
 * one, and hide the only case a person can fix.
 */
export type Attribution =
  | { kind: 'bound'; root: string }
  | { kind: 'elsewhere'; directory: string }
  | { kind: 'unknown' };

/**
 * A recorded working directory mapped onto a root by the person importing: a
 * directory and everything under it, or with a trailing `*` on its last
 * segment, every sibling directory whose name starts with what precedes it.
 */
export interface DirectoryMapping {
  from: string;
  to: string;
}

/** Parse `<from>=<to>`, or null for a value that names no directory on either side. */
export function parseDirectoryMapping(value: string): DirectoryMapping | null {
  const at = value.lastIndexOf('=');
  if (at <= 0 || at === value.length - 1) return null;
  const from = value.slice(0, at).trim();
  const to = value.slice(at + 1).trim();
  return path.isAbsolute(from) && path.isAbsolute(to) ? { from, to } : null;
}

/** Whether a directory falls under a mapping's `from`. */
export function mappingCovers(mapping: DirectoryMapping, dir: string): boolean {
  const from = mapping.from.replace(/\/+$/, '');
  if (!from.endsWith('*')) return rootContaining(dir, [from]) !== null;
  const prefix = from.slice(0, -1);
  const parent = path.dirname(prefix);
  const relative = path.relative(parent, dir);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0].startsWith(path.basename(prefix));
}

/**
 * A path as the filesystem spells it: the nearest existing ancestor resolved
 * through `realpath`, which answers the case a case-insensitive volume stores,
 * with whatever lies below it kept as written.
 */
export function canonicalPath(p: string): string {
  const absolute = path.resolve(p);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(existing);
      return rest.length === 0 ? real : path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

/** A repository remote reduced to host and path, so an https and an ssh spelling of one repository compare equal. */
export function remoteIdentity(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2]}`;
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed;
  }
}

/** What placement asks git, replaceable so a test answers without a repository. */
export interface PlacementGit {
  /** The main checkout of the repository a directory sits in, or null when it sits in none. */
  mainCheckout(dir: string): string | null;
  /** The `origin` remote of a checkout, or null when it names none. */
  remoteOf(root: string): string | null;
}

const git: PlacementGit = {
  mainCheckout(dir) {
    try {
      return path.resolve(dir, runGitAnswer(['rev-parse', '--git-common-dir'], dir), '..');
    } catch {
      return null;
    }
  },
  remoteOf(root) {
    try {
      return runGitAnswer(['remote', 'get-url', 'origin'], root);
    } catch {
      return null;
    }
  },
};

export interface PlacementOptions {
  mappings?: readonly DirectoryMapping[];
  git?: PlacementGit;
}

/**
 * Attribute transcripts to a fixed set of roots.
 *
 * A recorded directory is placed, in order: under a root by its canonical
 * path; under the root that is its repository's main checkout, when the
 * directory still exists; under a root an explicit mapping names, when the
 * directory is gone or in no repository; under the root whose remote the
 * transcript records. Anything else is `elsewhere`. The
 * answers git gives are asked once per directory and once per root.
 */
export function transcriptPlacer(roots: Iterable<string>, opts: PlacementOptions = {}): (agent: string, filePath: string) => Attribution {
  const known = [...roots];
  const canonicalRoots = new Map(known.map((root) => [canonicalPath(root), root]));
  const ask = opts.git ?? git;
  const mappings = opts.mappings ?? [];
  const placed = new Map<string, string | null>();
  let remotes: Map<string, string> | null = null;

  const rootFor = (dir: string): string | null => {
    const hit = rootContaining(canonicalPath(dir), canonicalRoots.keys());
    return hit === null ? null : canonicalRoots.get(hit) ?? null;
  };

  const placeDirectory = (recorded: string): string | null => {
    if (placed.has(recorded)) return placed.get(recorded) ?? null;
    let root = rootFor(recorded);
    // A directory still on disk inside a repository belongs to that repository
    // alone: a mapping never moves another checkout's history into a root.
    let inRepository = false;
    if (root === null && fs.existsSync(recorded)) {
      const main = ask.mainCheckout(recorded);
      inRepository = main !== null;
      if (main !== null) root = rootFor(main);
    }
    if (root === null && !inRepository) {
      const mapping = mappings.find((m) => mappingCovers(m, recorded) || mappingCovers(m, canonicalPath(recorded)));
      if (mapping !== undefined) root = rootFor(mapping.to);
    }
    placed.set(recorded, root);
    return root;
  };

  const rootWithRemote = (recorded: string): string | null => {
    if (remotes === null) {
      remotes = new Map();
      for (const root of known) {
        const remote = ask.remoteOf(root);
        if (remote !== null && !remotes.has(remoteIdentity(remote))) remotes.set(remoteIdentity(remote), root);
      }
    }
    return remotes.get(remoteIdentity(recorded)) ?? null;
  };

  return (agent, filePath) => {
    const discovery = manifestTranscriptDiscovery(agent);
    const recorded = discovery?.transcriptCwdPath === undefined ? null : transcriptHeadField(filePath, discovery.transcriptCwdPath);
    if (recorded !== null) {
      // A recorded directory is not a root: an agent started in a subdirectory
      // records that subdirectory, so the answer is the known root containing it.
      const root = placeDirectory(recorded);
      if (root !== null) return { kind: 'bound', root };
      const repository = discovery?.transcriptRepositoryPath === undefined ? null : transcriptHeadField(filePath, discovery.transcriptRepositoryPath);
      const byRemote = repository === null ? null : rootWithRemote(repository);
      return byRemote === null ? { kind: 'elsewhere', directory: recorded } : { kind: 'bound', root: byRemote };
    }
    const bySlug = attributeByPathSlug(filePath, known);
    return bySlug === null ? { kind: 'unknown' } : { kind: 'bound', root: bySlug };
  };
}

export function attributeTranscript(agent: string, filePath: string, roots: Iterable<string>, opts: PlacementOptions = {}): Attribution {
  return transcriptPlacer(roots, opts)(agent, filePath);
}

/** The known root a directory sits in — itself, or the nearest ancestor — or null. The longest match wins, so a checkout inside another checkout answers itself. */
export function rootContaining(dir: string, roots: Iterable<string>): string | null {
  const normalized = dir.replace(/\/+$/, '');
  let best: string | null = null;
  for (const root of roots) {
    const candidate = root.replace(/\/+$/, '');
    if (normalized !== candidate && !normalized.startsWith(`${candidate}/`)) continue;
    if (best === null || candidate.length > best.length) best = root;
  }
  return best;
}
