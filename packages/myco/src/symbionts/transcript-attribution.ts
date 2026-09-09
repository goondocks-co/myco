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
import { getAtPath } from '../utils/dot-path.js';
import { manifestTranscriptDiscovery } from './transcript-discovery.js';

/** Bytes of a transcript read while looking for the working directory. */
export const HEAD_BYTES = 64 * 1024;
/** Lines of that head inspected. Beyond this the record is not a header. */
export const MAX_HEADER_LINES = 40;

/**
 * The working directory a transcript records, or null.
 *
 * Reads the head only. A partial trailing line and a line that is not JSON are
 * both ordinary here and neither is an error: the answer is the first line that
 * carries the key.
 */
export function transcriptCwd(filePath: string, cwdPath: string): string | null {
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
        const found = getAtPath(JSON.parse(line) as unknown, cwdPath);
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

export function attributeTranscript(agent: string, filePath: string, roots: Iterable<string>): Attribution {
  const known = [...roots];
  const cwdPath = manifestTranscriptDiscovery(agent)?.transcriptCwdPath;
  const recorded = cwdPath === undefined ? null : transcriptCwd(filePath, cwdPath);
  if (recorded !== null) {
    // A recorded directory is not a root: an agent started in a subdirectory
    // records that subdirectory, so the answer is the known root containing it.
    const root = rootContaining(recorded, known);
    return root === null ? { kind: 'elsewhere', directory: recorded } : { kind: 'bound', root };
  }
  const bySlug = attributeByPathSlug(filePath, known);
  return bySlug === null ? { kind: 'unknown' } : { kind: 'bound', root: bySlug };
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
