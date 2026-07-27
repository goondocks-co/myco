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
import { currentHolder, isHolderAlive, type LeaseHolder } from './holder-identity.js';
import { isOperationUnfinished, type LeaseEvidence } from './lease-evidence.js';

/** Directory under the Myco home holding one lease file per project. */
export const LEASES_DIRNAME = 'leases';

export interface ProjectLease {
  project_id: string;
  /** The operation holding the lease (`grove-move`, `residency-attach`, …). */
  owner_op: string;
  /** Operator-facing explanation, surfaced by refusals and by doctor. */
  reason: string;
  /**
   * Epoch seconds of the most recent acquisition. Operator-facing only —
   * held-ness is derived from `holder` and `evidence` (W4), never from age.
   * It previously drove a staleness sweeper; nothing reads it to decide
   * whether a lease is held any more.
   */
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
  /**
   * The process that took the lease (W4). Present on every lease this binary
   * writes; a record without it is malformed rather than legacy, because the
   * lease store landed after the last release and no shipped binary has ever
   * written one.
   */
  holder: LeaseHolder;
  /**
   * Pointer to the operation's own crash-resumable record, or `null` when the
   * operation keeps none and is governed by holder-liveness alone.
   */
  evidence: LeaseEvidence | null;
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

function isValidHolder(holder: unknown): holder is LeaseHolder {
  if (typeof holder !== 'object' || holder === null) return false;
  const h = holder as Record<string, unknown>;
  return typeof h.pid === 'number' && Number.isFinite(h.pid)
    && typeof h.boot_id === 'string' && h.boot_id.length > 0;
}

function isValidEvidence(evidence: unknown): evidence is LeaseEvidence {
  if (typeof evidence !== 'object' || evidence === null) return false;
  const e = evidence as Record<string, unknown>;
  return (e.kind === 'residency-journal' || e.kind === 'move-marker')
    && typeof e.path === 'string' && e.path.length > 0;
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
    // `holder` and `evidence` are validated too, and a bad shape returns null
    // (→ the `unknown` presence, which every consumer treats as held). Without
    // this, a partially-shaped holder such as `{}` or `{pid}` yields an
    // undefined `boot_id`, `Math.abs(NaN) <= tolerance` is false, the holder
    // reads DEAD, and a null-evidence lease is silently FREED — the opposite
    // of the fail-closed posture this module documents, reached without any
    // torn write.
    if (!isValidHolder(doc.holder)) return null;
    if (!(doc.evidence === null || isValidEvidence(doc.evidence))) return null;
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
  if (record.value.released_at !== null) return ABSENT;
  return isStillHeld(record.value) ? record : ABSENT;
}

/**
 * Is this un-released record STILL held? (write-admission W4.)
 *
 * Held-ness is derived, never simply stored. A record on disk says an
 * operation once took the lease; it cannot say whether that is still true,
 * and the pre-W4 design had no way to ask — leaving age as the only signal
 * and a sweeper as the only recovery. A sweeper enumerates, and a project
 * mid-residency-transition is deregistered from every Grove, so the one
 * project that could strand was the one the sweeper could not see.
 *
 * The rule: **held iff the holder is alive OR the operation is unfinished.**
 * Both are facts, checked at read time, so nothing has to find a stranded
 * lease in order to free it — a dead holder with a terminal (or absent)
 * operation record is self-evidently not holding, at the moment anyone asks.
 *
 * Each half covers the other's blind spot. Holder-liveness alone would free a
 * project whose transition crashed but is still resumable, because the
 * journal outlives the process by design. Operation-evidence alone would
 * never free an operation that keeps no record.
 *
 * A record with no `holder` cannot be evaluated, so it is treated as HELD —
 * the same fail-closed posture G4 takes for an unreadable record, and for the
 * same reason: inability to prove a lease free is not proof that it is.
 *
 * This costs nothing in production. The lease store landed three weeks after
 * the last release, so no shipped binary has ever written a lease record at
 * all, let alone one without a holder; the only way to hold one is a
 * development vault that ran an intermediate build of this workstream. That
 * case has an operator escape hatch (`forceResumeProject`) and does not
 * justify the alternative, which is a rule that silently frees any lease it
 * cannot parse.
 */
function isStillHeld(lease: ProjectLease): boolean {
  if (!lease.holder) return true;
  if (isHolderAlive(lease.holder)) return true;
  return lease.evidence !== null && isOperationUnfinished(lease.evidence);
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
  evidence: LeaseEvidence | null,
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
    // Conflict is judged by the SAME predicate every reader uses. Testing
    // `released_at === null` here instead would leave two definitions of
    // "held": a lease whose holder died and whose operation finished reads
    // FREE to every consumer, appears in no listing, and would still refuse
    // acquisition here — permanently, now that nothing sweeps abandoned
    // records. That is two records of one fact needing a reconciler, which
    // is the shape this whole change exists to remove; it must not be
    // reintroduced one function away from the fix.
    if (prior && prior.released_at === null && isStillHeld(prior) && prior.owner_op !== ownerOp) {
      throw new ProjectLeaseHeldError(projectId, prior);
    }
    const next: ProjectLease = {
      project_id: projectId,
      owner_op: ownerOp,
      reason,
      since: Math.floor(Date.now() / 1000),
      generation: (prior?.generation ?? 0) + 1,
      released_at: null,
      // Re-stamped on every acquisition, including a crash-resumed
      // re-entry by the same owner (G2): the resuming process is a
      // different one, and the record must name whoever holds it NOW.
      holder: currentHolder(),
      evidence,
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
 * operator escape hatch uses on a lease left behind by a crashed process
 * that derived held-ness cannot resolve (a record it cannot parse). The
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
 * because a display caller has nothing to show for a torn file. (It has no
 * production consumer today — the admission path uses
 * `listWriteBlockedProjectIds`.) Admission cannot drop them — unreadable is not unheld (G4),
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
