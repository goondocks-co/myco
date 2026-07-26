/**
 * Project write lease — the machine-global record that a long-running operation
 * holds exclusive write rights over one project.
 *
 * This is the storage half of the pause mechanism that `grove/registry.ts`
 * already exposes as `pauseProject`/`isProjectPaused`, lifted out of the
 * per-Grove `projects.toml` row and into a file keyed only by project id.
 *
 * WHY IT MOVED. The lease used to live *inside* the registry row it protects.
 * That works for `grove move`, which keeps the row registered throughout, and
 * fails for residency migration, which deregisters the row as its first step —
 * so the lease could not survive the operation it exists to protect, and
 * residency grew its own quiescence mechanism instead of reusing this one.
 * Keyed by project id in a registry-independent location, one lease now covers
 * both, and any future operation that moves a project between registries.
 *
 * Two properties the in-row version could not offer:
 *
 *   - **A single read.** `isProjectPaused` had to scan every Grove, because a
 *     moving project is briefly registered in two. A lease keyed by project id
 *     is one file read regardless of how many Groves exist — and it is on the
 *     capture hot path, so that matters.
 *
 *   - **A monotonic generation.** Each acquisition bumps a counter that is never
 *     reused. A writer that resolved its tenancy before the current lease was
 *     taken holds an older generation and can be fenced on that basis, which a
 *     bare boolean cannot express. Nothing consumes the generation for fencing
 *     yet; it is recorded now so the write-admission chokepoint can.
 *
 * Deliberately DB-free and daemon-free — plain `fs` with atomic temp+rename
 * writes, matching `host/registry.ts`. Acquisition runs under a per-user file
 * lock so two processes cannot both observe "unheld" and both take it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { isGroveEraId } from './ids.js';
import { resolveMycoHome } from './paths.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';
import { ABSENT, readFilePresence, readDirPresence, type Presence } from '@myco/utils/presence.js';

/** Directory under the Myco home holding one lease file per project. */
export const LEASES_DIRNAME = 'leases';

export interface ProjectLease {
  project_id: string;
  /** The operation holding the lease (`grove-move`, `residency-attach`, …). */
  owner_op: string;
  /** Operator-facing explanation, surfaced by refusals and by doctor. */
  reason: string;
  /** Epoch seconds of the most recent acquisition, for staleness sweeps. */
  since: number;
  /**
   * Monotonically increasing per project, never reused — including across a
   * release and re-acquire, which is why a released lease keeps its record
   * rather than deleting it. A writer that resolved its tenancy under an older
   * generation is by definition stale; if the counter could restart, a stale
   * writer's generation could compare as NEWER than the live one and fencing
   * would invert.
   */
  generation: number;
  /** Epoch seconds when the holder released, or null while held. */
  released_at: number | null;
}

export class ProjectLeaseHeldError extends Error {
  readonly code = 'project_lease_held';

  constructor(readonly projectId: string, readonly holder: ProjectLease) {
    super(
      `project_lease_held: ${projectId} is held by ${holder.owner_op} `
      + `(reason=${holder.reason}, generation=${holder.generation})`,
    );
    this.name = 'ProjectLeaseHeldError';
  }
}

export function resolveLeasesDir(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, LEASES_DIRNAME);
}

function leasePath(projectId: string, mycoHome: string): string {
  return path.join(resolveLeasesDir(mycoHome), `${projectId}.json`);
}

function assertProjectId(projectId: string): void {
  if (!isGroveEraId(projectId, 'project')) {
    throw new Error(
      `project lease requires a grove project id (proj_<32 hex>), got ${JSON.stringify(projectId)}.`,
    );
  }
}

/**
 * Cheap short-circuit for the common no-lease case: no leases dir means no
 * lease for any project, one stat instead of a per-project read. The capture
 * hot path hits this on every request.
 */
export function leasesDirExists(mycoHome = resolveMycoHome()): boolean {
  return fs.existsSync(resolveLeasesDir(mycoHome));
}

function parseLease(raw: string): ProjectLease | null {
  try {
    const doc = JSON.parse(raw) as Partial<ProjectLease>;
    if (typeof doc.project_id !== 'string'
      || typeof doc.owner_op !== 'string'
      || typeof doc.reason !== 'string'
      || typeof doc.since !== 'number'
      || typeof doc.generation !== 'number'
      || !(doc.released_at === null || typeof doc.released_at === 'number')) return null;
    return doc as ProjectLease;
  } catch {
    return null;
  }
}

/**
 * The raw on-disk record, held or released. Released records are retained to
 * carry the generation forward, so acquisition reads this rather than
 * {@link readProjectLease}, which reports a released record as absent.
 */
function readLeaseRecord(projectId: string, mycoHome: string): Presence<ProjectLease> {
  if (!isGroveEraId(projectId, 'project')) return ABSENT;
  if (!leasesDirExists(mycoHome)) return ABSENT;
  const read = readFilePresence(leasePath(projectId, mycoHome));
  if (read.state !== 'present') return read as Presence<ProjectLease>;
  const parsed = parseLease(read.value);
  return parsed
    ? { state: 'present', value: parsed }
    : { state: 'unknown', error: new Error(`project lease at ${leasePath(projectId, mycoHome)} is unreadable`) };
}

/**
 * Read a project's lease.
 *
 * Three-state: an absent file genuinely means no lease, but an unreadable one
 * must not read as unheld — that would let a writer proceed against a project
 * an operation is actively moving. Callers gate on `present`, and treat
 * `unknown` as held.
 */
export function readProjectLease(
  projectId: string,
  mycoHome = resolveMycoHome(),
): Presence<ProjectLease> {
  const record = readLeaseRecord(projectId, mycoHome);
  if (record.state !== 'present') return record;
  // A released record is retained only to carry the generation forward; it is
  // not a held lease. An unreadable one stays `unknown` so writers stay out.
  return record.value.released_at === null ? record : ABSENT;
}

/**
 * Take (or refresh) the lease for `projectId`.
 *
 * Idempotent for the same `ownerOp` — a retry refreshes `since` and takes a new
 * generation. A different owner is refused rather than overwritten.
 *
 * Read and write happen under one lock, so this is not the check-then-act the
 * in-row version was: two processes cannot both see "unheld" and both take it.
 */
export function acquireProjectLease(
  projectId: string,
  ownerOp: string,
  reason: string,
  mycoHome = resolveMycoHome(),
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): ProjectLease {
  assertProjectId(projectId);
  if (!ownerOp.trim()) throw new Error('acquireProjectLease requires a non-empty owner_op');
  if (!reason.trim()) throw new Error('acquireProjectLease requires a non-empty reason');

  const dir = resolveLeasesDir(mycoHome);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(lockNamespace.resolve('project-lease'), `lease-${projectId}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  return withFileLockSync(lockPath, () => {
    // The raw record, held or released — the released one still carries the
    // generation this acquisition must advance past.
    const record = readLeaseRecord(projectId, mycoHome);
    if (record.state === 'unknown') throw record.error;
    const prior = record.state === 'present' ? record.value : null;
    if (prior && prior.released_at === null && prior.owner_op !== ownerOp) {
      throw new ProjectLeaseHeldError(projectId, prior);
    }
    const next: ProjectLease = {
      project_id: projectId,
      owner_op: ownerOp,
      reason,
      since: Math.floor(Date.now() / 1000),
      generation: (prior?.generation ?? 0) + 1,
      released_at: null,
    };
    atomicWriteFileSync(leasePath(projectId, mycoHome), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

/**
 * Release the lease iff `ownerOp` holds it. A mismatched owner is refused, so a
 * late-arriving operation cannot clear the lease of the one that superseded it.
 */
export function releaseProjectLease(
  projectId: string,
  ownerOp: string,
  mycoHome = resolveMycoHome(),
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): void {
  assertProjectId(projectId);
  const lockPath = path.join(lockNamespace.resolve('project-lease'), `lease-${projectId}.lock`);
  if (!fs.existsSync(path.dirname(lockPath))) return;

  withFileLockSync(lockPath, () => {
    const record = readLeaseRecord(projectId, mycoHome);
    if (record.state === 'absent') return;
    if (record.state === 'unknown') throw record.error;
    if (record.value.released_at !== null) return; // already released
    if (record.value.owner_op !== ownerOp) {
      throw new ProjectLeaseHeldError(projectId, record.value);
    }
    // Marked, not deleted: the record is what carries the generation forward.
    const released: ProjectLease = { ...record.value, released_at: Math.floor(Date.now() / 1000) };
    atomicWriteFileSync(leasePath(projectId, mycoHome), `${JSON.stringify(released, null, 2)}\n`);
  });
}

/**
 * Drop a lease regardless of holder — the operator escape hatch, and what the
 * startup sweeper uses on a lease left behind by a crashed process. The
 * generation is NOT reset: a forced release still has to fence any writer that
 * was admitted under the released lease.
 */
export function forceReleaseProjectLease(
  projectId: string,
  mycoHome = resolveMycoHome(),
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): boolean {
  assertProjectId(projectId);
  const lockPath = path.join(lockNamespace.resolve('project-lease'), `lease-${projectId}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return withFileLockSync(lockPath, () => {
    const record = readLeaseRecord(projectId, mycoHome);
    if (record.state !== 'present' || record.value.released_at !== null) return false;
    const released: ProjectLease = { ...record.value, released_at: Math.floor(Date.now() / 1000) };
    atomicWriteFileSync(leasePath(projectId, mycoHome), `${JSON.stringify(released, null, 2)}\n`);
    return true;
  });
}

/**
 * Project ids that write admission must treat as leased: every project
 * with a present lease PLUS every project whose lease record could not be
 * read.
 *
 * Distinct from `listProjectLeases`, which drops unreadable records
 * because its callers render lease details and have nothing to show for a
 * torn file. Admission cannot drop them — unreadable is not unheld (G4),
 * and a torn record here would silently admit a grove-wide writer into
 * the project an operation is actively moving.
 */
export function listWriteBlockedProjectIds(mycoHome = resolveMycoHome()): string[] {
  const dir = resolveLeasesDir(mycoHome);
  const entries = readDirPresence(dir);
  // An ABSENT dir genuinely means no lease was ever taken. An UNDETERMINED
  // read (EACCES, EMFILE, EIO) does not — returning [] there would report
  // "nothing is leased" while a transition holds a lease we simply could
  // not see, admitting a grove-wide writer into the project being moved.
  // Throwing matches `isProjectPaused`'s contract for the same fault, so
  // callers fail closed through their existing catch.
  if (entries.state === 'unknown') throw entries.error;
  if (entries.state === 'absent') return [];
  const out: string[] = [];
  for (const entry of entries.value) {
    const name = entry.name;
    if (!name.endsWith('.json')) continue;
    const projectId = name.slice(0, -'.json'.length);
    const lease = readProjectLease(projectId, mycoHome);
    if (lease.state === 'present' || lease.state === 'unknown') out.push(projectId);
  }
  return out;
}

/** Every project currently holding a lease. Absent dir → none. */
export function listProjectLeases(mycoHome = resolveMycoHome()): ProjectLease[] {
  const dir = resolveLeasesDir(mycoHome);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: ProjectLease[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const projectId = name.slice(0, -'.json'.length);
    const lease = readProjectLease(projectId, mycoHome);
    if (lease.state === 'present') out.push(lease.value);
  }
  return out;
}
