/**
 * Member-side residency transition — the daemon-only orchestrator that moves a
 * project WITH local history onto a Team Host (Phase F, attach direction).
 *
 * Decisions D-F-1 (attach IS the migration — one action) and D-F-2 (backup,
 * THEN move) are load-bearing here: nothing destructive happens before both the
 * journal (step 1) and the project-scoped safety backup exist, and the local
 * rows are removed only after the host acknowledges the full push (the delete
 * lives in `host/residency-drain.ts`).
 *
 * The sequence is journal-resumable at every boundary. `beginAttachResidency`
 * runs it synchronously for a fresh attach; the same idempotent core,
 * {@link completeAttachParking}, is re-driven by the residency drain for any
 * `parking` journal a crash left mid-sequence. Only the network push and the
 * post-ack delete are deferred to the drain.
 */
import path from 'node:path';

import { epochSeconds } from '../constants.js';
import type { Database } from '../db/client.js';
import { createBackup } from '../backup/engine.js';
import { resolveGroveBackupDir } from '../backup/location.js';
import { listActiveContentClaims, releaseContentClaim } from '../db/queries/content-claims.js';
import { backfillProjectForResidency } from '../db/queries/residency-backfill.js';
import { countPendingForProjects, dropPendingForProjects } from '../db/queries/team-outbox.js';
import { slugifyGroveName, projectScope, type GroveProjectId } from '../grove/ids.js';
import { deregisterProjectInGrove, registerProjectInGrove, resolveDefaultGrove } from '../grove/registry.js';
import { findRegisteredProjectById } from '../grove/registry-resolve.js';
import type { DaemonLogger } from '../daemon/logger.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import type {
  AttachResult,
  DetachResult,
  ResidencyAttachContext,
  ResidencyDetachContext,
} from './attach-command.js';
import { codedMembershipError } from './membership-error.js';
import { attachProject, detachProject, getHost, type AttachRef } from './registry.js';
import {
  RESIDENCY_MIN_HOST_PROTOCOL,
  advanceResidencyPhase,
  clearResidencyJournal,
  clearResidencyStaging,
  readResidencyJournal,
  startResidencyJournal,
  type ResidencyDirection,
  type ResidencyJournal,
  type ResidencyPhase,
} from './residency-journal.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';

/** Daemon-owned capabilities the transition and drain both need. `withGroveDb`
 *  pins + scopes a Grove connection so `getDatabase()` inside `fn` resolves to
 *  it (production: `GroveRuntimeCache`; tests: an in-memory map). */
export interface ResidencyDaemonDeps {
  machineId: string;
  mycoHome: string;
  withGroveDb: <T>(groveId: string, fn: (db: Database) => T) => T;
  logger?: Pick<DaemonLogger, 'info' | 'warn'>;
  now?: () => number;
  lockNamespace?: PerUserLockNamespace;
  /**
   * Kick an immediate residency drain pass (mirrors the capture live-forward
   * pattern). Called after a begin/abort writes its journal so the transition
   * makes progress in milliseconds instead of waiting for the housekeeping
   * round-robin to re-dispatch the periodic job (which starved a live detach for
   * 20+ minutes). Wired in `daemon/main.ts` to a serialized one-shot pass — a
   * kick during a running pass coalesces, never overlaps. The periodic job stays
   * the retry/resume driver for failures, restarts, and backoff.
   */
  kickResidencyDrain?: () => void;
}

/**
 * Start a with-history attach transition. Writes the journal, gates on host
 * protocol, backs up, parks the local registration, records the attach ref,
 * enqueues the project's rows, and releases this machine's active content
 * claims — then returns while the drain ships the queued rows. A protocol-gate
 * refusal clears the journal (nothing has moved yet) and rethrows the coded
 * error for the caller to surface.
 */
export function beginAttachResidency(
  ctx: ResidencyAttachContext,
  deps: ResidencyDaemonDeps,
): AttachResult {
  const divertGroveId = ctx.host.served_grove_id;
  if (!divertGroveId) {
    // attachCommand validates served_grove_id before reaching here; guard so a
    // future caller can never open a journal with an empty divert target.
    throw codedMembershipError(
      'host_predates_served_grove',
      `Host ${ctx.hostId} has no served Grove; cannot start a residency transition.`,
    );
  }

  const local = findRegisteredProjectById(ctx.projectId, deps.mycoHome);
  const projectName = local?.project.name ?? path.basename(path.resolve(ctx.root));

  // Step 1 — the journal is the first durable act; every later step is
  // idempotent and resumable from it.
  startResidencyJournal({
    direction: 'attach',
    phase: 'parking',
    host_id: ctx.hostId,
    project_id: ctx.projectId,
    divert_grove_id: divertGroveId,
    source_grove_id: ctx.sourceGroveId,
    project_name: projectName,
    root: path.resolve(ctx.root),
    local_grove_id: ctx.localGroveId,
    backup_ref: null,
    cursors: {},
  });

  const journal = readResidencyJournal(ctx.projectId);
  if (!journal) {
    throw new Error(`residency journal for ${ctx.projectId} vanished immediately after write`);
  }

  try {
    completeAttachParking(journal, deps);
  } catch (err) {
    // A protocol-gate refusal is the one failure where nothing has moved: the
    // backup/park/attach steps run only after it passes. Clear the journal so a
    // corrected retry starts clean; any other failure leaves the journal for the
    // drain to resume.
    if (isProtocolRefusal(err)) clearResidencyJournal(ctx.projectId);
    throw err;
  }

  deps.logger?.info(LOG_KINDS.RESIDENCY_ATTACH_PUSH, 'residency attach transition started', {
    project_id: ctx.projectId,
    host_id: ctx.hostId,
    grove_id: divertGroveId,
  });

  // Live-forward: run the first drain pass now, don't wait for the periodic job.
  deps.kickResidencyDrain?.();

  return {
    projectId: ctx.projectId,
    groveId: divertGroveId,
    hostId: ctx.hostId,
    hostLabel: ctx.host.label,
    root: path.resolve(ctx.root),
    alreadyAttached: false,
    notes: [
      'Residency transition started: this project\'s knowledge history is moving to the team host. '
      + 'A local safety backup was taken first; the move completes in the background.',
    ],
  };
}

/**
 * Idempotent core of the attach transition: protocol gate → backup → park →
 * attach ref → backfill → release claims → advance to `pushing`. Safe to re-run
 * against a `parking` journal a crash left partway through (each step no-ops
 * when already done). Throws a coded `residency_requires_host_update` when the
 * host is below the residency protocol — the only step that runs before any
 * state changes, so the caller can cleanly abandon.
 */
export function completeAttachParking(journal: ResidencyJournal, deps: ResidencyDaemonDeps): void {
  const lockNamespace = deps.lockNamespace ?? nativePerUserLockNamespace;
  // Step 2 — protocol gate. Runs before anything destructive so a refusal can be
  // cleanly abandoned.
  const host = getHost(journal.host_id, lockNamespace);
  if (!host || host.protocol_version < RESIDENCY_MIN_HOST_PROTOCOL) {
    throw codedMembershipError(
      'residency_requires_host_update',
      `Host ${journal.host_id} predates the residency protocol (needs version `
      + `${RESIDENCY_MIN_HOST_PROTOCOL}+). Update the team host first (run \`myco update\` on that machine and `
      + 're-enable Team Host serving), then re-attach — hosts update before members (D-F-5).',
    );
  }

  // Step 3 — project-scoped safety backup (D-F-2), restorable like any backup.
  // Skipped when a resumed journal already recorded one.
  if (!journal.backup_ref) {
    const backupRef = deps.withGroveDb(journal.source_grove_id, (db) =>
      createBackup(
        db,
        resolveGroveBackupDir(journal.source_grove_id, { mycoHome: deps.mycoHome }),
        deps.machineId,
        projectScope(journal.project_id as GroveProjectId),
        slugifyGroveName(journal.project_name),
      ),
    );
    advanceResidencyPhase(journal.project_id, 'parking', { backup_ref: backupRef });
    journal.backup_ref = backupRef;
  }

  // Step 4 — park the local registration (projects.toml row + roots.toml reverse
  // entry only). `force` makes a re-run a no-op once the row is already gone.
  deregisterProjectInGrove(journal.source_grove_id, journal.project_id, deps.mycoHome, { force: true });

  // Step 5 — record the attach ref. Parking first means attachProject no longer
  // sees a local row, so it records the ref instead of refusing.
  const ref: AttachRef = {
    grove_id: journal.divert_grove_id,
    project_id: journal.project_id,
    root: journal.root,
    local_grove_id: journal.local_grove_id,
  };
  attachProject(journal.host_id, ref, deps.mycoHome, lockNamespace);

  // Step 6 — enqueue the project's rows for the drain to ship.
  deps.withGroveDb(journal.source_grove_id, () =>
    backfillProjectForResidency(journal.project_id, deps.machineId),
  );

  // Step 7 — release this machine's active content claims for the project; the
  // host becomes the claim authority once the rows land there.
  deps.withGroveDb(journal.source_grove_id, () => {
    const now = epochSeconds();
    for (const claim of listActiveContentClaims(projectScope(journal.project_id as GroveProjectId))) {
      if (claim.machine_id === deps.machineId) releaseContentClaim(claim.id, now);
    }
  });

  // Commit the parking phase last, so a crash before this leaves the journal in
  // `parking` for the drain to re-drive from the top (all steps above are
  // idempotent), never in `pushing` with local setup half-done.
  advanceResidencyPhase(journal.project_id, 'pushing');
}

function isProtocolRefusal(err: unknown): boolean {
  return err instanceof Error
    && (err as Error & { membershipCode?: unknown }).membershipCode === 'residency_requires_host_update';
}

/** The residency-status wire body (`GET /api/host-membership/residency-status`). */
export interface ResidencyStatus {
  in_flight: boolean;
  direction?: ResidencyDirection;
  phase?: ResidencyPhase;
  /** Attach: pending outbox rows still to push. Detach (or none): null. */
  rows_pending?: number | null;
  last_error?: string | null;
}

/** Read a project's transition status for the Team page progress surface. */
export function residencyStatus(projectId: string, deps: ResidencyDaemonDeps): ResidencyStatus {
  const journal = readResidencyJournal(projectId);
  if (!journal || journal.phase === 'done') return { in_flight: false };
  const rowsPending = journal.direction === 'attach'
    ? deps.withGroveDb(journal.source_grove_id, () => countPendingForProjects([projectId]))
    : null;
  return {
    in_flight: true,
    direction: journal.direction,
    phase: journal.phase,
    rows_pending: rowsPending,
    last_error: journal.last_error ?? null,
  };
}

/**
 * Abort an in-flight transition. Valid from any non-done phase:
 *  - ATTACH (parking/pushing): the local rows are still present (delete is
 *    post-ack), so restore the parked local registration, drop the attach ref if
 *    one was recorded, and clear the queued push. The safety backup stays on
 *    disk; its ref is logged. Released content claims stay released (TTL
 *    semantics — the holder re-claims on next use).
 *  - DETACH (pulling): the flip hasn't happened, the project is still attached
 *    and nothing local changed — drop the pull journal + staged pages.
 *  - DETACH (applying/rehoming): the flip already happened; refuse
 *    `residency_abort_too_late` and let the drain finish.
 * A finished/absent transition refuses `residency_abort_too_late` — for attach
 * the rows already live on the host (detach is the way back).
 */
export function abortResidency(projectId: string, deps: ResidencyDaemonDeps): { ok: true } {
  const lockNamespace = deps.lockNamespace ?? nativePerUserLockNamespace;
  const journal = readResidencyJournal(projectId);
  if (!journal || journal.phase === 'done') {
    throw codedMembershipError(
      'residency_abort_too_late',
      `Nothing to abort for ${projectId}: the residency transition has already finished. If it was an attach, the `
      + 'data now lives on the host — detach to bring it back.',
    );
  }

  if (journal.direction === 'attach') {
    registerProjectInGrove(journal.source_grove_id, {
      projectId,
      projectName: journal.project_name,
      projectRoot: journal.root,
    }, deps.mycoHome);
    detachProject(journal.host_id, projectId, lockNamespace);
    // Drop the residency-backfilled pending rows — inert otherwise (nothing ships
    // them once the journal is gone), and a re-attach re-enqueues from scratch.
    deps.withGroveDb(journal.source_grove_id, () => dropPendingForProjects([projectId]));
    deps.logger?.info(LOG_KINDS.RESIDENCY_ABORT, 'residency attach aborted — local registration restored', {
      project_id: projectId,
      backup_ref: journal.backup_ref,
    });
    clearResidencyJournal(projectId);
    // Kick a pass so any OTHER in-flight transition resumes promptly.
    deps.kickResidencyDrain?.();
    return { ok: true };
  }

  if (journal.phase === 'pulling') {
    clearResidencyJournal(projectId);
    clearResidencyStaging(projectId);
    deps.logger?.info(LOG_KINDS.RESIDENCY_ABORT, 'residency detach aborted before flip — still attached', {
      project_id: projectId,
    });
    deps.kickResidencyDrain?.();
    return { ok: true };
  }

  throw codedMembershipError(
    'residency_abort_too_late',
    `Cannot abort the detach of ${projectId}: it already flipped to local. Let the transition finish, then re-attach `
    + 'to move it back.',
  );
}

/**
 * Start a detach-pull transition. Pure orchestration over the journal: validate
 * the ref carries a root (the re-materialize anchor) and resolve the local Grove
 * to land in, then open the journal in `pulling`. The pull, flip, re-materialize,
 * and apply all run in the drain — this returns "pull started" like the attach
 * begin. Suppression-divert is active from the moment the journal exists, so
 * capture during the window buffers under the host Grove and is re-homed at the
 * end.
 */
export function beginDetachResidency(ctx: ResidencyDetachContext, deps: ResidencyDaemonDeps): DetachResult {
  if (!ctx.ref.root) {
    throw codedMembershipError(
      'residency_detach_needs_root',
      `Cannot pull ${ctx.projectId} back: its attach ref has no checkout root (a legacy ref). Re-attach the `
      + 'project once first (that backfills the root), then detach.',
    );
  }
  const divertGroveId = ctx.host.served_grove_id;
  if (!divertGroveId) {
    throw codedMembershipError(
      'host_predates_served_grove',
      `Host ${ctx.hostId} has no served Grove; cannot pull the project back.`,
    );
  }
  const targetGroveId = ctx.ref.local_grove_id ?? resolveDefaultGrove(deps.mycoHome)?.id;
  if (!targetGroveId) {
    throw codedMembershipError(
      'unknown_local_grove',
      `Cannot pull ${ctx.projectId} back: this machine has no local Grove to re-materialize it into. Create a `
      + 'Grove first, then detach.',
    );
  }

  // project_name: the attach-era journal is gone and the AttachRef carries no
  // name, so basename(root) is the honest fallback (see the T4 report flag).
  const root = path.resolve(ctx.ref.root);
  startResidencyJournal({
    direction: 'detach',
    phase: 'pulling',
    host_id: ctx.hostId,
    project_id: ctx.projectId,
    divert_grove_id: divertGroveId,
    source_grove_id: divertGroveId,
    target_grove_id: targetGroveId,
    project_name: path.basename(root),
    root,
    local_grove_id: ctx.ref.local_grove_id,
    backup_ref: null,
    cursors: {},
  });

  deps.logger?.info(LOG_KINDS.RESIDENCY_DETACH_PULL, 'residency detach pull started', {
    project_id: ctx.projectId,
    host_id: ctx.hostId,
    target_grove_id: targetGroveId,
  });

  // Live-forward: run the first pull pass now, don't wait for the periodic job.
  deps.kickResidencyDrain?.();

  return { projectId: ctx.projectId, detachedFromHostId: ctx.hostId };
}
