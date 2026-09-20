/**
 * The record a capture invocation leaves when it finds no membership.
 *
 * A hook that cannot resolve a credential prints one stderr line and exits 0 —
 * deliberately, because a non-zero hook breaks the harness the user is working
 * in. The harness reports `hook_success`, the line scrolls past, and nothing is
 * captured. So the miss is also counted on disk, under the home the invocation
 * DID resolve: `myco member status` reads it back, which turns "refused: 0
 * logged" into "N hook invocations found no registry entry for <root>".
 *
 * One file per root under `<MYCO_HOME>/member/unmembered/`, in the member's
 * private store (0700 dirs, 0600 files, atomic writes). Counting is
 * best-effort: it is written outside the registry lock, so two hooks racing may
 * merge to one increment. A lost increment costs a number; a failed write must
 * never cost the hook, so every failure here is swallowed.
 *
 * The directory is aged by the two commands that already read it —
 * `myco member status` and `myco member join` — never by the hook. A
 * machine-global hook meets every unjoined checkout on the box, so without a
 * window the store would grow one file per repository the user ever opened and
 * never shrink; but a hook that swept it would parse every file in it on every
 * missed invocation, under a budget measured in milliseconds, to tidy something
 * nothing is reading yet.
 *
 * Only a `registry`-sourced invocation counts: an `env`-sourced credential has
 * no registry entry by design, and its absence is not a miss.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { registryKeyFor } from './registry.js';
import { ensureMemberDir, memberRoot, readPrivateJson, writePrivateFileAtomic } from './store.js';

export const UNMEMBERED_DIRNAME = 'unmembered';

/** What one project root's misses add up to. */
export interface MissingMembershipRecord {
  version: number;
  root: string;
  count: number;
  firstAt: number;
  lastAt: number;
  /** What asked last — `hook stop`, `mcp`, `tool` — so the count names a source. */
  lastInvokedBy?: string;
}

export const MISSING_MEMBERSHIP_VERSION = 1;

/** How long a root's misses are kept after the last one. */
export const MISSING_MEMBERSHIP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function unmemberedDir(mycoHome: string = resolveMycoHome()): string {
  return path.join(memberRoot(mycoHome), UNMEMBERED_DIRNAME);
}

export function missingMembershipPath(root: string, mycoHome: string = resolveMycoHome()): string {
  return path.join(unmemberedDir(mycoHome), `${registryKeyFor(root)}.json`);
}

/** Count one invocation that found no registry entry for `root`. */
export function recordMissingMembership(
  root: string,
  opts: { mycoHome?: string; now?: () => number; invokedBy?: string } = {},
): void {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  const at = (opts.now ?? Date.now)();
  const resolved = path.resolve(root);
  const previous = readMissingMembership(resolved, mycoHome);
  const record: MissingMembershipRecord = {
    version: MISSING_MEMBERSHIP_VERSION,
    root: resolved,
    count: (previous?.count ?? 0) + 1,
    firstAt: previous?.firstAt ?? at,
    lastAt: at,
    lastInvokedBy: opts.invokedBy ?? previous?.lastInvokedBy,
  };
  try {
    ensureMemberDir(unmemberedDir(mycoHome), mycoHome);
    writePrivateFileAtomic(missingMembershipPath(resolved, mycoHome), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // A capture attempt that cannot even count itself still must not fail the harness.
  }
}

/** A record a report asked for: held, never written, or there and unusable. */
export type MissingMembershipResult =
  | { status: 'present'; record: MissingMembershipRecord }
  | { status: 'missing' }
  | { status: 'unavailable' };

/** Private read and base record shape. */
function readRecordFile(file: string): MissingMembershipResult {
  const read = readPrivateJson<MissingMembershipRecord>(file);
  if (!read.ok) return read.reason === 'missing' ? { status: 'missing' } : { status: 'unavailable' };
  const value = read.value;
  const shaped = typeof value?.root === 'string' && typeof value.count === 'number';
  return shaped ? { status: 'present', record: value } : { status: 'unavailable' };
}

/** An instant a surface can render: finite, and a date. */
const rendersAsInstant = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());

/** Whether `name` is the file this record's own root is keyed to. */
const keyed = (record: MissingMembershipRecord, name: string): boolean => name === `${registryKeyFor(record.root)}.json`;

/** Diagnostic count and timestamp validation. */
function reportable(record: MissingMembershipRecord): boolean {
  return Number.isSafeInteger(record.count) && record.count > 0
    && record.version === MISSING_MEMBERSHIP_VERSION
    && rendersAsInstant(record.firstAt) && rendersAsInstant(record.lastAt);
}

/** This root's record, or null when nothing has missed here and when the file holds nothing readable. */
export function readMissingMembership(root: string, mycoHome: string = resolveMycoHome()): MissingMembershipRecord | null {
  const read = readRecordFile(missingMembershipPath(path.resolve(root), mycoHome));
  return read.status === 'present' ? read.record : null;
}

/** This root's record as a report reads it: held, never written, or there and unusable. A record naming another root is not this root's. */
export function readMissingMembershipResult(root: string, mycoHome: string = resolveMycoHome()): MissingMembershipResult {
  const resolved = path.resolve(root);
  const file = missingMembershipPath(resolved, mycoHome);
  const read = readRecordFile(file);
  if (read.status !== 'present') return read;
  const usable = keyed(read.record, path.basename(file)) && reportable(read.record);
  return usable ? read : { status: 'unavailable' };
}

/** Every root that has missed under this home, newest miss first, each with the file it was read from. */
export function readMissingMemberships(
  mycoHome: string = resolveMycoHome(),
): Array<{ record: MissingMembershipRecord; file: string }> {
  let names: string[];
  try {
    names = fs.readdirSync(unmemberedDir(mycoHome)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const found: Array<{ record: MissingMembershipRecord; file: string }> = [];
  for (const name of names) {
    const file = path.join(unmemberedDir(mycoHome), name);
    const read = readRecordFile(file);
    if (read.status === 'present') found.push({ record: read.record, file });
  }
  return found.sort((a, b) => b.record.lastAt - a.record.lastAt);
}

/** Every record this home holds, with what the store could not answer for. `readable` is false only where the directory itself could not be listed. */
export function listMissingMembershipsResult(mycoHome: string = resolveMycoHome()): { records: MissingMembershipRecord[]; readable: boolean; unavailableRecords: number } {
  let names: string[];
  try {
    names = fs.readdirSync(unmemberedDir(mycoHome)).filter((f) => f.endsWith('.json'));
  } catch (err) {
    // A store no capture has missed into holds no record; any other errno is one this report could not read.
    return { records: [], readable: (err as NodeJS.ErrnoException).code === 'ENOENT', unavailableRecords: 0 };
  }
  const records: MissingMembershipRecord[] = [];
  let unavailableRecords = 0;
  for (const name of names) {
    const read = readRecordFile(path.join(unmemberedDir(mycoHome), name));
    if (read.status === 'present' && keyed(read.record, name) && reportable(read.record)) records.push(read.record);
    else if (read.status !== 'missing') unavailableRecords += 1;
  }
  return { records: records.sort((a, b) => b.lastAt - a.lastAt), readable: true, unavailableRecords };
}

/** Every root that has missed under this home, newest miss first. */
export function listMissingMemberships(mycoHome: string = resolveMycoHome()): MissingMembershipRecord[] {
  return readMissingMemberships(mycoHome).map((found) => found.record);
}

/**
 * Drop every root whose last miss is older than the retention window.
 *
 * The file that is removed is the file the record was READ from, never a path
 * recomputed from the record's `root`: the two agree for anything this module
 * wrote, and where they disagree the recomputed one names a file that belongs
 * to some other root.
 */
export function pruneMissingMemberships(mycoHome: string = resolveMycoHome(), now: number = Date.now()): number {
  let pruned = 0;
  for (const { record, file } of readMissingMemberships(mycoHome)) {
    if (now - record.lastAt < MISSING_MEMBERSHIP_RETENTION_MS) continue;
    try {
      fs.rmSync(file, { force: true });
      pruned += 1;
    } catch {
      // Already gone.
    }
  }
  return pruned;
}

/** Forget this root's misses — what a successful join has to say about them. */
export function clearMissingMembership(root: string, mycoHome: string = resolveMycoHome()): void {
  try {
    fs.rmSync(missingMembershipPath(path.resolve(root), mycoHome), { force: true });
  } catch {
    // Nothing to forget.
  }
}
