/**
 * Member-side residency drain (Phase F) — the daemon job that carries a
 * residency transition the rest of the way in both directions.
 *
 * ATTACH: re-drives a crash-interrupted `parking` journal, ships a `pushing`
 * journal's queued rows (+ the two sidecar streams) to the host, and — only
 * after the host acknowledges the FULL push — deletes the project's local rows
 * (the backup is the safety copy) and clears the journal.
 *
 * DETACH (hybrid): `fetching` prepares + downloads the host's digest-verified
 * project artifact in resumable chunks and saves it as a real backup;
 * `restoring` restores it into the target Grove (atomic, idempotent) and THEN
 * flips (remove the attach ref, re-materialize the local Grove row);
 * `rehoming` re-homes events buffered under the host Grove during the window,
 * purges the member-side drain stores, sends the goodbye (durable marker
 * retry), and clears the journal.
 *
 * Discipline mirrors the other member drains (`capture/plan-drain.ts`): at-
 * least-once with host-side idempotency, a failed POST logs (throttled) and
 * retries next tick, and NOTHING advances on failure. Transports are injectable
 * seams so the ship/pull discipline is unit-testable without a real host.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  HOST_PROTOCOL_HEADER,
  HOST_PROTOCOL_VERSION,
  HOST_PROXY_BODY_TIMEOUT_MS,
  HOST_PROXY_HEADERS_TIMEOUT_MS,
  epochSeconds,
} from '../constants.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { type Database } from '../db/client.js';
import { GROVE_PROJECT_SCOPED_TABLES } from '../db/schema-ddl.js';
import {
  listPendingForProject,
  markSent,
  markSourceRowsSynced,
  pruneOld,
  type OutboxRow,
} from '../db/queries/team-outbox.js';
import {
  deleteContentPublicationsForProject,
  listContentPublicationPages,
  listEntityMentionPages,
} from '../db/queries/residency-backfill.js';
import { RESIDENCY_TABLE_ORDER } from '../db/queries/residency-apply.js';
import { createFsDrainStore } from '../capture/transcript-drain.js';
import { createFsPlanDrainStore } from '../capture/plan-drain.js';
import { createFsReplayStore } from '../capture/event-replay-drain.js';
import type { DrainHealthCounters } from '../capture/drain-health.js';
import { defaultDial, hostAuthority } from '../daemon/host-proxy.js';
import { readDirPresence } from '@myco/utils/presence.js';
import { shouldLogOncePerInterval } from '../daemon/log-throttle.js';
import { REQUEST_CONTEXT_HEADERS } from '../grove/request-context.js';
import type { GroveProjectId } from '../grove/ids.js';
import { memberHostTag, resolveHostDir, resolveProjectBufferDir } from '../grove/paths.js';
import { stampArtifactLineage } from './routed-residency-detach.js';
import { restoreBackup } from '../backup/engine.js';
import { resolveGroveBackupDir } from '../backup/location.js';
import { detachProject, getHostMembershipSnapshot } from './registry.js';
import { nativePerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';
import { registerProjectInGrove } from '../grove/registry.js';
import { hostDescriptorFor, requireProjectScopedTarget } from './routing.js';
import type { RemoteTarget } from './routing.js';
import { completeAttachParking, releaseResidencyLease, type ResidencyDaemonDeps } from './residency-transition.js';
import {
  ROUTED_RESIDENCY_ROWS_PATH,
  ROUTED_DETACH_ARTIFACT_PATH,
  ROUTED_DETACH_COMPLETE_PATH,
  RESIDENCY_MIN_HOST_PROTOCOL,
  RETIRED_RESIDENCY_PHASES,
  residencyJournalPath,
  advanceResidencyPhase,
  clearResidencyFailure,
  clearResidencyJournal,
  clearResidencyStaging,
  listResidencyJournals,
  readResidencyJournal,
  stampResidencyFailure,
  type ResidencyJournal,
} from './residency-journal.js';

/** Throttle window for repeated per-project drain-failure warnings. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

/** A transition must be at least this old before it can be called stalled —
 *  a large first pull legitimately takes a while. */
const STALL_NOTIFY_MIN_AGE_MS = 30 * 60 * 1000;
/**
 * The stall check runs immediately after each journal's attempt this pass, so
 * a qualifying failure stamp is at most seconds old. This window only has to
 * cover that same-pass gap — it must NOT be sized to the drain cadence, which
 * stretches to 5 minutes in the `sleep` power state; a cadence-sized window
 * would reject every stamp in exactly the walked-away scenario the surface
 * exists for. Anything older than this means the transition progressed
 * without failing on the current attempt.
 */
const STALL_NOTIFY_FRESH_FAILURE_MS = 60 * 1000;
/** Re-surface a still-stalled transition at most this often per project. */
const STALL_NOTIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Raise the stalled-transition surface when a journal is old and its attempt
 * THIS pass just failed (read fresh from disk — the pass-start snapshot
 * predates this pass's own stamp). Every input is a durable harness fact
 * (journal timestamps), never inference. A stalled transition is not data
 * loss — capture buffers and the journal retries — but writes into the
 * project wait indefinitely and, for tool writes, are refused outright; the
 * user must be able to SEE that and choose to cancel rather than discover it
 * by absence.
 */
function notifyIfStalledAfterAttempt(
  projectId: string,
  deps: ResidencyDrainDeps,
  teamsHome: string | undefined,
): void {
  if (!deps.notifyStalledTransition) return;
  const journal = readResidencyJournal(projectId, teamsHome);
  if (!journal || journal.phase === 'done') return;
  const now = Date.now();
  const createdAt = Date.parse(journal.created_at);
  if (!Number.isFinite(createdAt) || now - createdAt < STALL_NOTIFY_MIN_AGE_MS) return;
  const lastErrorAt = journal.last_error_at ? Date.parse(journal.last_error_at) : Number.NaN;
  if (!Number.isFinite(lastErrorAt) || now - lastErrorAt > STALL_NOTIFY_FRESH_FAILURE_MS) return;
  if (!shouldLogOncePerInterval(`residency.stall.notify.${projectId}`, STALL_NOTIFY_INTERVAL_MS, now)) return;
  deps.notifyStalledTransition(journal, now - createdAt);
}

/** Cursor sentinel meaning a sidecar stream is fully shipped. A real cursor is a
 *  JSON-encoded key, never this literal. */
const CURSOR_DONE = 'done';

/** The residency-rows push body (`POST /routed-capture/residency-rows`). One
 *  allow-listed table per request; `adoption` rides the FIRST batch only. */
export interface ResidencyRowsRequest {
  table: string;
  rows: Record<string, unknown>[];
  adoption?: { project_name: string };
}

/** The host ack: `applied` is the count the host upserted (informational). */
export interface ResidencyRowsResponse {
  status: number;
  applied: number;
}

/** The POST transport seam — the one side effect that leaves the machine. */
export type ResidencyPostTransport = (
  target: RemoteTarget,
  body: ResidencyRowsRequest,
  machineId: string,
) => Promise<ResidencyRowsResponse>;

/** Resolve the per-project host connection target (host record + bearer). */
export type ResolveResidencyTarget = (
  hostId: string,
  groveId: string,
  projectId: string,
) => RemoteTarget | null;

/** The prepare half of the artifact protocol: report (or start) the host-side
 *  one-time build. `ready:false` is PROGRESS (the member re-polls next tick),
 *  never a failure. */
export interface DetachArtifactPrepareResponse {
  status: number;
  ready: boolean;
  sha256: string | null;
  size: number | null;
  message?: string;
}

/** One positional chunk of the prepared artifact. `restart` means the host no
 *  longer serves the sha the member is resuming (restart/TTL/rebuild) — reset
 *  the durable offset and re-prepare. */
export interface DetachArtifactChunkResponse {
  status: number;
  chunk: Buffer | null;
  next_offset: number | null;
  restart: boolean;
}

/** The artifact transport seam — prepare + positional chunk reads. */
export interface DetachArtifactClient {
  prepare: (target: RemoteTarget, machineId: string) => Promise<DetachArtifactPrepareResponse>;
  chunk: (target: RemoteTarget, machineId: string, offset: number, sha256: string) => Promise<DetachArtifactChunkResponse>;
}

/** The goodbye transport seam — tells the host the detach landed locally so it
 *  runs its idempotent side effects (claims release, transcript prune,
 *  stub-deregister). */
export type DetachGoodbyeTransport = (
  target: RemoteTarget,
  machineId: string,
) => Promise<{ status: number }>;

export interface ResidencyDrainDeps extends ResidencyDaemonDeps {
  transport?: ResidencyPostTransport;
  detachArtifactClient?: DetachArtifactClient;
  detachGoodbyeTransport?: DetachGoodbyeTransport;
  resolveHostTarget?: ResolveResidencyTarget;
  teamsHome?: string;
  /**
   * Operator-visible surface for a transition that keeps failing while holding
   * the project write lease. Injected by the daemon (daemon-scope notification:
   * a mid-transition project is registered in no Grove, so no project-scoped
   * surface can carry this). The drain decides WHEN deterministically; the
   * daemon decides HOW it renders.
   */
  notifyStalledTransition?: (journal: ResidencyJournal, stalledForMs: number) => void;
}

/**
 * Production transport: POST the rows to the host's residency route through the
 * same dial primitive the byte-opaque proxy uses, attaching the host bearer +
 * protocol header AND the per-request tenancy headers the host binds the Grove
 * DB from — grove = the HOST's served Grove, project = the project being moved,
 * machine = this member. Reads the small JSON ack.
 */
export const defaultResidencyTransport: ResidencyPostTransport = async (target, body, machineId) => {
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  const headers = {
    host: hostAuthority(target),
    authorization: `Bearer ${target.bearer}`,
    'content-type': 'application/json',
    'content-length': String(payload.length),
    [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
    [REQUEST_CONTEXT_HEADERS.projectId]: requireProjectScopedTarget(target, 'residency drain'),
    [REQUEST_CONTEXT_HEADERS.groveId]: target.groveId,
    [REQUEST_CONTEXT_HEADERS.machineId]: machineId,
  };
  const req = await defaultDial(target, { method: 'POST', path: ROUTED_RESIDENCY_ROWS_PATH, headers });

  return new Promise<ResidencyRowsResponse>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => { if (!settled) { settled = true; req.destroy(); reject(err); } };
    const headersTimer = setTimeout(() => fail(new Error('headers_timeout')), HOST_PROXY_HEADERS_TIMEOUT_MS);

    req.on('response', (res) => {
      clearTimeout(headersTimer);
      const bodyTimer = setTimeout(() => fail(new Error('body_timeout')), HOST_PROXY_BODY_TIMEOUT_MS);
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(bodyTimer);
        if (settled) return;
        settled = true;
        let parsed: { applied?: unknown } = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* non-JSON body */ }
        resolve({
          status: res.statusCode ?? 0,
          applied: typeof parsed.applied === 'number' ? parsed.applied : 0,
        });
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(payload);
  });
};

/** Default host-target builder: read the host record + bearer from the machine-
 *  global registry, tenancy scoped to the residency push (host's served Grove). */
const defaultResolveResidencyTarget = (
  hostId: string,
  groveId: string,
  projectId: string,
  lockNamespace = nativePerUserLockNamespace,
): RemoteTarget | null => {
  const membership = getHostMembershipSnapshot(hostId, lockNamespace);
  if (!membership) return null;
  const { record, bearer } = membership;
  const host = hostDescriptorFor(record);
  if (!host) return null;
  return {
    projectId: projectId as GroveProjectId,
    groveId,
    host,
    bearer,
  };
};

/** Shared dial for the artifact protocol's small JSON exchanges. */
async function dialDetachRoute<T>(
  target: RemoteTarget,
  machineId: string,
  routePath: string,
  body: Record<string, unknown>,
  parse: (parsed: Record<string, unknown>, status: number) => T,
): Promise<T> {
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  const headers = {
    host: hostAuthority(target),
    authorization: `Bearer ${target.bearer}`,
    'content-type': 'application/json',
    'content-length': String(payload.length),
    [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
    [REQUEST_CONTEXT_HEADERS.projectId]: requireProjectScopedTarget(target, 'residency drain'),
    [REQUEST_CONTEXT_HEADERS.groveId]: target.groveId,
    [REQUEST_CONTEXT_HEADERS.machineId]: machineId,
  };
  const req = await defaultDial(target, { method: 'POST', path: routePath, headers });
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => { if (!settled) { settled = true; req.destroy(); reject(err); } };
    const headersTimer = setTimeout(() => fail(new Error('headers_timeout')), HOST_PROXY_HEADERS_TIMEOUT_MS);
    req.on('response', (res) => {
      clearTimeout(headersTimer);
      const bodyTimer = setTimeout(() => fail(new Error('body_timeout')), HOST_PROXY_BODY_TIMEOUT_MS);
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(bodyTimer);
        if (settled) return;
        settled = true;
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>; } catch { /* non-JSON body */ }
        resolve(parse(parsed, res.statusCode ?? 0));
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(payload);
  });
}

/**
 * Production artifact client. Each exchange is small (prepare status, or one
 * ~2 MB chunk), so the ordinary proxy timeouts hold regardless of project
 * size — the transfer is bounded per REQUEST, resumable per OFFSET.
 */
export const defaultDetachArtifactClient: DetachArtifactClient = {
  prepare: (target, machineId) =>
    dialDetachRoute(target, machineId, ROUTED_DETACH_ARTIFACT_PATH, { op: 'prepare' }, (parsed, status) => ({
      status,
      ready: parsed.ready === true,
      sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : null,
      size: typeof parsed.size === 'number' ? parsed.size : null,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
    })),
  chunk: (target, machineId, offset, sha256) =>
    dialDetachRoute(target, machineId, ROUTED_DETACH_ARTIFACT_PATH, { op: 'chunk', offset, sha256 }, (parsed, status) => ({
      status,
      chunk: typeof parsed.chunk === 'string' ? Buffer.from(parsed.chunk, 'base64') : null,
      next_offset: typeof parsed.next_offset === 'number' ? parsed.next_offset : null,
      restart: parsed.restart === true,
    })),
};

/** Production goodbye transport: POST the host's detach-complete route. */
export const defaultDetachGoodbyeTransport: DetachGoodbyeTransport = async (target, machineId) => {
  const payload = Buffer.from('{}', 'utf-8');
  const headers = {
    host: hostAuthority(target),
    authorization: `Bearer ${target.bearer}`,
    'content-type': 'application/json',
    'content-length': String(payload.length),
    [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
    [REQUEST_CONTEXT_HEADERS.projectId]: requireProjectScopedTarget(target, 'residency drain'),
    [REQUEST_CONTEXT_HEADERS.groveId]: target.groveId,
    [REQUEST_CONTEXT_HEADERS.machineId]: machineId,
  };
  const req = await defaultDial(target, { method: 'POST', path: ROUTED_DETACH_COMPLETE_PATH, headers });

  return new Promise<{ status: number }>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => { if (!settled) { settled = true; req.destroy(); reject(err); } };
    const headersTimer = setTimeout(() => fail(new Error('headers_timeout')), HOST_PROXY_HEADERS_TIMEOUT_MS);
    req.on('response', (res) => {
      clearTimeout(headersTimer);
      res.resume();
      res.on('end', () => { if (!settled) { settled = true; resolve({ status: res.statusCode ?? 0 }); } });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(payload);
  });
};

/** How many transitions are still in flight — the deep-sleep `hold.pending`
 *  signal, so the machine never sleeps mid-move. Covers both directions. */
export function countResidencyInFlight(teamsHome?: string): number {
  return listResidencyJournals(teamsHome).filter((j) => j.phase !== 'done').length;
}

/**
 * Serialize residency drain passes into a single-flight runner + a one-shot
 * kick. `run()` never overlaps itself: a call while a pass is in flight sets a
 * pending flag and returns, and the in-flight pass loops once more when it
 * finishes (coalescing bursts of kicks into one follow-up pass, so a begin's
 * kick can't race the periodic job into a double pass). `kick()` schedules a
 * `run()` on the next tick — used AFTER a route response is sent, so a begin's
 * transition starts in milliseconds instead of waiting for the housekeeping
 * round-robin. The periodic job also drives `run()`, so failures/restarts still
 * resume. `schedule` is injectable for deterministic tests (default setImmediate).
 */
export function createResidencyKicker(
  runPass: () => Promise<unknown>,
  schedule: (fn: () => void) => void = (fn) => { setImmediate(fn); },
): { run: () => Promise<void>; kick: () => void } {
  let running = false;
  let pending = false;
  const run = async (): Promise<void> => {
    if (running) { pending = true; return; }
    running = true;
    try {
      do {
        pending = false;
        await runPass();
      } while (pending);
    } finally {
      running = false;
    }
  };
  const kick = (): void => { schedule(() => { void run(); }); };
  return { run, kick };
}

/**
 * Per-host residency drain health for the drain-health surface (T6): each
 * in-flight journal is a pending entry for its host, and one carrying a
 * `last_error` stamp is a failing entry. Residency does not classify
 * unreachable-vs-rejected (the reason is in the last_error message), so
 * `hostUnreachableEntries` stays 0. Same {@link DrainHealthCounters} shape as
 * the three capture drains, so the route renders a fourth kind uniformly.
 */
export function residencyHealthByHost(teamsHome?: string): Map<string, DrainHealthCounters> {
  const out = new Map<string, DrainHealthCounters>();
  for (const journal of listResidencyJournals(teamsHome)) {
    if (journal.phase === 'done') continue;
    const counters = out.get(journal.host_id) ?? { pendingEntries: 0, failingEntries: 0, hostUnreachableEntries: 0 };
    counters.pendingEntries += 1;
    if (journal.last_error) counters.failingEntries += 1;
    out.set(journal.host_id, counters);
  }
  return out;
}

/**
 * One drain tick: advance every journal as far as it will go. Attach `parking`
 * journals are re-driven to `pushing`; `pushing` journals ship + purge + finish.
 * Detach `pulling` journals pull to staging then flip; `applying` journals apply
 * + re-home + finish.
 */
export async function runResidencyTransitions(deps: ResidencyDrainDeps): Promise<{ processed: number }> {
  const transport = deps.transport ?? defaultResidencyTransport;
  const artifactClient = deps.detachArtifactClient ?? defaultDetachArtifactClient;
  const goodbyeTransport = deps.detachGoodbyeTransport ?? defaultDetachGoodbyeTransport;
  const lockNamespace = deps.lockNamespace ?? nativePerUserLockNamespace;
  const resolveTarget = deps.resolveHostTarget
    ?? ((hostId, groveId, projectId) =>
      defaultResolveResidencyTarget(hostId, groveId, projectId, lockNamespace));
  const teamsHome = deps.teamsHome;
  let processed = 0;

  for (const journal of listResidencyJournals(teamsHome)) {
    if (journal.phase === 'done') {
      clearResidencyJournal(journal.project_id, teamsHome);
      clearResidencyStaging(journal.project_id, teamsHome);
      // A crash between the terminal clear and the release would otherwise
      // strand the lease, locking every writer out of the project forever.
      releaseResidencyLease(journal.project_id, deps.mycoHome);
      continue;
    }
    try {
      if (journal.direction === 'attach') {
        if (journal.phase === 'parking') {
          completeAttachParking(journal, deps);
        }
        const current = readResidencyJournal(journal.project_id, teamsHome);
        if (current?.phase === 'pushing') {
          await pushTransition(current, deps, transport, resolveTarget, teamsHome);
          processed += 1;
        }
      } else {
        await runDetachTransition(journal, deps, artifactClient, goodbyeTransport, resolveTarget, teamsHome);
        processed += 1;
      }
    } catch (err) {
      recordJournalFailure(journal, err, deps, teamsHome);
    }
    notifyIfStalledAfterAttempt(journal.project_id, deps, teamsHome);
  }

  try {
    await retryPendingGoodbyes(deps, goodbyeTransport, resolveTarget, teamsHome);
  } catch (err) {
    deps.logger?.warn(LOG_KINDS.RESIDENCY_COMPLETE, 'goodbye retry pass failed — will retry next tick', {
      error: (err as Error).message,
    });
  }

  return { processed };
}

/**
 * Carry a detach journal forward through the hybrid phases. `fetching`: fetch
 * the digest-verified project artifact from the host and save it as a real
 * backup in the TARGET grove's backup dir — the user's durable copy, pruned by
 * ordinary retention. `restoring`: restore the artifact into the target grove
 * (atomic + idempotent), THEN flip — remove the attach ref and re-materialize
 * the local Grove row (both idempotent, so a crash between them heals) — and
 * advance to `rehoming`; restore-before-flip means a read never meets an
 * empty just-flipped project. `rehoming`: re-home the events buffered under
 * the host Grove during the window, purge the member-side drain stores, send
 * the goodbye (a durable marker retries it when the host is unreachable —
 * host bookkeeping never holds the local project's write lease), and finish.
 * Retired `pulling`/`applying` journals (older dev builds only; no release
 * ever wrote them) are refused with guidance, never progressed.
 */
async function runDetachTransition(
  journal: ResidencyJournal,
  deps: ResidencyDrainDeps,
  artifactClient: DetachArtifactClient,
  goodbyeTransport: DetachGoodbyeTransport,
  resolveTarget: ResolveResidencyTarget,
  teamsHome: string | undefined,
): Promise<void> {
  const lockNamespace = deps.lockNamespace ?? nativePerUserLockNamespace;
  const targetGroveId = journal.target_grove_id;
  if (!targetGroveId) {
    recordJournalFailure(journal, new Error('detach journal has no target_grove_id'), deps, teamsHome);
    return;
  }

  if (RETIRED_RESIDENCY_PHASES.has(journal.phase)) {
    stampResidencyFailure(
      journal.project_id,
      'this move was started by an older version of Myco and cannot continue — cancel it and start the move again',
      teamsHome,
    );
    return;
  }

  if (journal.phase === 'fetching') {
    const target = resolveTarget(journal.host_id, journal.divert_grove_id, journal.project_id);
    if (!target) {
      stampResidencyFailure(journal.project_id, `host record for ${journal.host_id} is missing — the move cannot proceed`, teamsHome);
      return;
    }
    if (target.host.protocol_version < RESIDENCY_MIN_HOST_PROTOCOL) {
      stampResidencyFailure(
        journal.project_id,
        `host is below the residency protocol (${target.host.protocol_version} < ${RESIDENCY_MIN_HOST_PROTOCOL}) — waiting for the host to update`,
        teamsHome,
      );
      if (shouldLogOncePerInterval(`residency.proto.${journal.project_id}`, FAILURE_LOG_INTERVAL_MS, Date.now())) {
        deps.logger?.warn(LOG_KINDS.RESIDENCY_DETACH_PULL, 'host below residency protocol — artifact fetch skipped', {
          project_id: journal.project_id, host_id: journal.host_id, host_protocol: target.host.protocol_version,
        });
      }
      return;
    }

    let prep: DetachArtifactPrepareResponse;
    try { prep = await artifactClient.prepare(target, deps.machineId); }
    catch (err) { recordJournalFailure(journal, err, deps, teamsHome); return; }
    if (prep.status !== 200) {
      recordJournalFailure(journal, new Error(prep.message ?? `host returned ${prep.status} preparing the detach artifact`), deps, teamsHome);
      return;
    }
    if (!prep.ready || !prep.sha256 || typeof prep.size !== 'number') {
      // Building is PROGRESS: clear any stale failure so the stall surface
      // doesn't misread an actively-preparing host, and poll next tick.
      clearResidencyFailure(journal.project_id, teamsHome);
      return;
    }

    // Durable resume: the partial download and its offset survive crashes and
    // ticks. A sha change on the host (restart/TTL/rebuild) resets both.
    const partialPath = path.join(residencyDirFor(teamsHome), `artifact-${journal.project_id}.partial`);
    let offset = journal.artifact_sha256 === prep.sha256 && typeof journal.artifact_offset === 'number'
      ? journal.artifact_offset
      : 0;
    if (offset === 0) {
      fs.mkdirSync(path.dirname(partialPath), { recursive: true });
      fs.writeFileSync(partialPath, '');
      advanceResidencyPhase(journal.project_id, 'fetching', { artifact_sha256: prep.sha256, artifact_offset: 0 }, teamsHome);
    } else if (!fs.existsSync(partialPath) || fs.statSync(partialPath).size !== offset) {
      // The partial no longer matches the durable offset — start this
      // transfer over rather than assembling a corrupt artifact.
      offset = 0;
      fs.mkdirSync(path.dirname(partialPath), { recursive: true });
      fs.writeFileSync(partialPath, '');
      advanceResidencyPhase(journal.project_id, 'fetching', { artifact_sha256: prep.sha256, artifact_offset: 0 }, teamsHome);
    }

    for (;;) {
      let piece: DetachArtifactChunkResponse;
      try { piece = await artifactClient.chunk(target, deps.machineId, offset, prep.sha256); }
      catch (err) { recordJournalFailure(journal, err, deps, teamsHome); return; }
      if (piece.restart) {
        fs.rmSync(partialPath, { force: true });
        advanceResidencyPhase(journal.project_id, 'fetching', { artifact_sha256: undefined, artifact_offset: undefined }, teamsHome);
        return; // re-prepare next tick
      }
      if (piece.status !== 200 || !piece.chunk) {
        recordJournalFailure(journal, new Error(`host returned ${piece.status} for artifact chunk at ${offset}`), deps, teamsHome);
        return; // resume from the durable offset next tick
      }
      // Abort re-check across the network await: bail before any further
      // durable step if the journal is gone or moved on.
      const live = readResidencyJournal(journal.project_id, teamsHome);
      if (!live || live.phase !== 'fetching') { return; }
      fs.appendFileSync(partialPath, piece.chunk);
      offset += piece.chunk.length;
      advanceResidencyPhase(journal.project_id, 'fetching', { artifact_offset: offset }, teamsHome);
      if (piece.next_offset === null) break;
      await yieldToLoop();
    }

    // The transfer contract: whole-file digest (and size) must match before
    // ANYTHING durable happens beyond the resumable partial. A torn assembly
    // is refused whole and restarted — there is no partial-apply window.
    const assembled = fs.readFileSync(partialPath, 'utf-8');
    const digest = createHash('sha256').update(assembled, 'utf-8').digest('hex');
    if (digest !== prep.sha256 || Buffer.byteLength(assembled, 'utf-8') !== prep.size) {
      fs.rmSync(partialPath, { force: true });
      advanceResidencyPhase(journal.project_id, 'fetching', { artifact_sha256: undefined, artifact_offset: undefined }, teamsHome);
      recordJournalFailure(journal, new Error('detach artifact failed digest verification — refetching'), deps, teamsHome);
      return;
    }

    // Stamp the MEMBER's target grove lineage so the saved artifact is a
    // first-class backup the cross-Grove restore gate keeps protecting.
    const stamped = stampArtifactLineage(assembled, targetGroveId);
    const backupDir = resolveGroveBackupDir(targetGroveId, { mycoHome: deps.mycoHome });
    fs.mkdirSync(backupDir, { recursive: true });
    const artifactPath = path.join(backupDir, `${deps.machineId}__detach-${memberHostTag(journal.host_id)}__${epochSeconds()}.sql`);
    fs.writeFileSync(artifactPath, stamped, 'utf-8');
    fs.rmSync(partialPath, { force: true });

    // Re-confirm after the awaits: a concurrent abort (synchronous, on the
    // localhost route) may have cleared this journal. The artifact file is
    // just a backup copy — harmless to leave behind on a bail.
    const still = readResidencyJournal(journal.project_id, teamsHome);
    if (!still || still.phase !== 'fetching') return;
    advanceResidencyPhase(journal.project_id, 'restoring', { backup_ref: artifactPath }, teamsHome);
    const refreshed = readResidencyJournal(journal.project_id, teamsHome);
    if (!refreshed) return;
    journal = refreshed;
  }

  if (journal.phase === 'restoring') {
    const artifactPath = journal.backup_ref;
    if (!artifactPath || !fs.existsSync(artifactPath)) {
      // Artifact gone before the restore (manual cleanup, disk loss). Nothing
      // has flipped — go fetch a fresh one rather than wedging here.
      advanceResidencyPhase(journal.project_id, 'fetching', { backup_ref: null }, teamsHome);
      return;
    }
    try {
      deps.withGroveDb(targetGroveId, (db) => { restoreBackup(db, artifactPath); });
    } catch (err) {
      recordJournalFailure(journal, err, deps, teamsHome);
      return;
    }
    // Flip AFTER the restore lands: routing goes local only once the history
    // is already there. Both steps are idempotent; a crash between them
    // re-drives cleanly next tick.
    detachProject(journal.host_id, journal.project_id, lockNamespace);
    registerProjectInGrove(targetGroveId, {
      projectId: journal.project_id,
      projectName: journal.project_name,
      projectRoot: journal.root,
    }, deps.mycoHome);
    advanceResidencyPhase(journal.project_id, 'rehoming', {}, teamsHome);
    const swept = readResidencyJournal(journal.project_id, teamsHome);
    if (!swept) return;
    journal = swept;
  }

  if (journal.phase === 'rehoming') {
    // (7) re-home the events diverted under the host Grove during the window
    // into the local buffer, and (8) purge the member-side host drain stores.
    // Known residual (same class as the retired pull): a capture that resolved
    // the host buffer path before the divert flipped off but writes after this
    // scan leaves bytes no enumerator revisits once the journal clears —
    // part of the documented as-of-disconnect loss window.
    // Both idempotent; the journal is cleared ONLY after they complete (an
    // earlier clear would orphan residual buffered events with no journal to
    // drive the resume).
    const rehomed = rehomeBufferedEvents(
      resolveProjectBufferDir(journal.divert_grove_id, journal.project_id, deps.mycoHome),
      resolveProjectBufferDir(targetGroveId, journal.project_id, deps.mycoHome),
    );
    if (!rehomed.complete) {
      recordJournalFailure(journal, rehomed.error, deps, teamsHome);
      return;
    }
    try {
      createFsDrainStore().purgeProject(journal.host_id, journal.project_id);
      createFsPlanDrainStore().purgeProject(journal.host_id, journal.project_id);
      createFsReplayStore().purgeProject(journal.host_id, journal.project_id);
    } catch { /* best-effort machine-scoped cleanup */ }

    // The goodbye: the host releases the departing machine's claims, prunes
    // its transcript trees, and stub-deregisters when this was the last
    // member. Best-effort NOW; on failure a durable marker retries it on
    // later passes — the project's write lease is fully local from here and
    // must not wait on host reachability for bookkeeping.
    let goodbyeOk = false;
    const target = resolveTarget(journal.host_id, journal.divert_grove_id, journal.project_id);
    if (target) {
      try { goodbyeOk = (await goodbyeTransport(target, deps.machineId)).status === 200; }
      catch { /* marker below */ }
    }
    if (!goodbyeOk) {
      writeGoodbyeMarker(journal.host_id, journal.divert_grove_id, journal.project_id, teamsHome);
    }

    advanceResidencyPhase(journal.project_id, 'done', {}, teamsHome);
    clearResidencyJournal(journal.project_id, teamsHome);
    clearResidencyStaging(journal.project_id, teamsHome);
    // Last act: the project is fully home, so writers may proceed again.
    releaseResidencyLease(journal.project_id, deps.mycoHome);

    deps.logger?.info(LOG_KINDS.RESIDENCY_COMPLETE, 'residency detach transition complete', {
      project_id: journal.project_id, host_id: journal.host_id, artifact: journal.backup_ref,
    });
  }
}

/** The residency dir (journals, goodbye markers, transfer partials). */
function residencyDirFor(teamsHome: string | undefined): string {
  return path.dirname(residencyJournalPath('proj_00000000000000000000000000000000', teamsHome));
}

/** Durable goodbye marker — `goodbye-<project>.json` beside the journals. The
 *  pass-level retry consumes it; listResidencyJournals skips it (no `phase`). */
function goodbyeMarkerPath(projectId: string, teamsHome: string | undefined): string {
  return path.join(residencyDirFor(teamsHome), `goodbye-${projectId}.json`);
}

function writeGoodbyeMarker(hostId: string, groveId: string, projectId: string, teamsHome: string | undefined): void {
  const filePath = goodbyeMarkerPath(projectId, teamsHome);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ host_id: hostId, grove_id: groveId, project_id: projectId }), 'utf-8');
}

/** Retry pending goodbyes for completed detaches. A marker whose host record is
 *  gone (the user left the host) is dropped — there is nobody to notify. */
async function retryPendingGoodbyes(
  deps: ResidencyDrainDeps,
  goodbyeTransport: DetachGoodbyeTransport,
  resolveTarget: ResolveResidencyTarget,
  teamsHome: string | undefined,
): Promise<void> {
  const dir = path.dirname(residencyJournalPath('proj_00000000000000000000000000000000', teamsHome));
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('goodbye-') || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(dir, entry.name);
    let marker: { host_id?: unknown; grove_id?: unknown; project_id?: unknown } = {};
    try { marker = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { fs.rmSync(filePath, { force: true }); continue; }
    if (typeof marker.host_id !== 'string' || typeof marker.grove_id !== 'string' || typeof marker.project_id !== 'string') {
      fs.rmSync(filePath, { force: true });
      continue;
    }
    try {
      const target = resolveTarget(marker.host_id, marker.grove_id, marker.project_id);
      if (!target) {
        // Null is NOT proof the membership is gone — a mid-rotation snapshot
        // resolves null too. Drop the marker only on positive absence of the
        // host's durable directory (leave removes it); otherwise keep it.
        if (!fs.existsSync(resolveHostDir(marker.host_id))) {
          fs.rmSync(filePath, { force: true });
        } else if (shouldLogOncePerInterval(`residency.goodbye_unresolved:${marker.project_id}`, FAILURE_LOG_INTERVAL_MS, Date.now())) {
          deps.logger?.warn(LOG_KINDS.RESIDENCY_COMPLETE, 'goodbye pending — host membership unresolved, keeping the marker', {
            project_id: marker.project_id, host_id: marker.host_id,
          });
        }
        continue;
      }
      if ((await goodbyeTransport(target, deps.machineId)).status === 200) fs.rmSync(filePath, { force: true });
    } catch { /* keep the marker; retry next pass */ }
  }
}

/** Move the durable capture files (`<session>.jsonl`) diverted under the host
 *  Grove during the window into the local Grove's buffer dir — a byte-level move
 *  (no re-parse), merging by append on a same-session collision so the local
 *  reconciler dedups by event id. */
function rehomeBufferedEvents(fromDir: string, toDir: string): { complete: true } | { complete: false; error: Error } {
  const listed = readDirPresence(fromDir);
  if (listed.state === 'absent') return { complete: true }; // nothing buffered
  if (listed.state === 'unknown') return { complete: false, error: listed.error };
  for (const entry of listed.value) {
    const file = entry.name;
    if (!file.endsWith('.jsonl')) continue; // durable capture only; skip .lock / quarantine
    const src = path.join(fromDir, file);
    const dest = path.join(toDir, file);
    try {
      fs.mkdirSync(toDir, { recursive: true });
      if (fs.existsSync(dest)) {
        fs.appendFileSync(dest, fs.readFileSync(src));
        fs.rmSync(src, { force: true });
      } else {
        fs.renameSync(src, dest);
      }
    } catch (err) {
      // A file that vanished mid-move is genuinely done; anything else means
      // these bytes are still in a directory nothing will enumerate again once
      // the journal is cleared, so the sweep is not complete.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { complete: false, error: err as Error };
    }
  }
  return { complete: true };
}

/** Ship a `pushing` journal's outbox rows and sidecars; on full ack, purge and
 *  finish. Returns without advancing when the host is unreachable/rejecting. */
async function pushTransition(
  journal: ResidencyJournal,
  deps: ResidencyDrainDeps,
  transport: ResidencyPostTransport,
  resolveTarget: ResolveResidencyTarget,
  teamsHome: string | undefined,
): Promise<void> {
  const target = resolveTarget(journal.host_id, journal.divert_grove_id, journal.project_id);
  if (!target) {
    // Not a transient miss: the record only leaves the registry with the
    // membership. Stamp it so the health/stall surfaces can see the hold.
    stampResidencyFailure(journal.project_id, `host record for ${journal.host_id} is missing — the move cannot proceed`, teamsHome);
    return;
  }
  if (target.host.protocol_version < RESIDENCY_MIN_HOST_PROTOCOL) {
    // The route the push needs does not exist on a pre-residency host; it never
    // self-heals by retry, so skip until an upgrade + reconnect.
    stampResidencyFailure(
      journal.project_id,
      `host is below the residency protocol (${target.host.protocol_version} < ${RESIDENCY_MIN_HOST_PROTOCOL}) — waiting for the host to update`,
      teamsHome,
    );
    if (shouldLogOncePerInterval(`residency.proto.${journal.project_id}`, FAILURE_LOG_INTERVAL_MS, Date.now())) {
      deps.logger?.warn(LOG_KINDS.RESIDENCY_ATTACH_PUSH, 'host below residency protocol — push skipped', {
        project_id: journal.project_id,
        host_id: journal.host_id,
        host_protocol: target.host.protocol_version,
      });
    }
    return;
  }

  // Raw POST: attaches the pending adoption (first batch only) and returns the
  // HTTP status (0 on a transport error). No failure is recorded here — the
  // caller decides, after subdivision, whether the whole ship gave up.
  let lastStatus = 0;
  const post = async (body: ResidencyRowsRequest): Promise<number> => {
    if (!journal.adopted) body.adoption = { project_name: journal.project_name };
    try {
      lastStatus = (await transport(target, body, deps.machineId)).status;
    } catch {
      lastStatus = 0;
    }
    if (lastStatus === 200 && !journal.adopted) {
      journal.adopted = true;
      advanceResidencyPhase(journal.project_id, 'pushing', { adopted: true }, teamsHome);
    }
    return lastStatus;
  };

  // The host answers a REFUSAL (a request it will never accept identically —
  // tenancy rejection, missing context) with 400/403. Splitting such a batch
  // ships its in-scope halves while the offending rows keep refusing, so the
  // transition half-applies and then loops; refusal must stop the ship
  // wholesale, not bisect around the refused rows.
  const isRefusal = (status: number): boolean => status === 400 || status === 403;

  // A non-200 STATUS on a multi-row batch may just be an over-cap payload (near
  // the 8MB per-request limit); halve and retry so an oversized batch can't wedge
  // retry-forever. A transport error (status 0 — host unreachable) never
  // self-heals by splitting, so it fails straight to a next-tick retry — and a
  // refusal never self-heals at all, so it never splits either.
  const shipOutboxRows = async (table: string, rows: OutboxRow[]): Promise<boolean> => {
    if (rows.length === 0) return true;
    const status = await post({ table, rows: rows.map((r) => r.payload) });
    if (status === 200) {
      const sentAt = epochSeconds();
      deps.withGroveDb(journal.source_grove_id, () => {
        markSent(rows.map((r) => r.id), sentAt);
        markSourceRowsSynced(rows, sentAt);
      });
      return true;
    }
    if (status !== 0 && !isRefusal(status) && rows.length > 1) {
      const mid = Math.floor(rows.length / 2);
      return (await shipOutboxRows(table, rows.slice(0, mid))) && (await shipOutboxRows(table, rows.slice(mid)));
    }
    return false;
  };

  const shipPlainRows = async (table: string, rows: Record<string, unknown>[]): Promise<boolean> => {
    if (rows.length === 0) return true;
    const status = await post({ table, rows });
    if (status === 200) return true;
    if (status !== 0 && !isRefusal(status) && rows.length > 1) {
      const mid = Math.floor(rows.length / 2);
      return (await shipPlainRows(table, rows.slice(0, mid))) && (await shipPlainRows(table, rows.slice(mid)));
    }
    return false;
  };

  const giveUp = (): void =>
    recordJournalFailure(
      journal,
      new Error(
        isRefusal(lastStatus)
          ? `residency push refused by the host (status ${lastStatus}) — retrying the identical batch cannot succeed; cancel the move or fix the scoping mismatch`
          : `residency push failed (host status ${lastStatus})`,
      ),
      deps,
      teamsHome,
    );

  // (1) outbox rows — drain project-filtered batches, one POST per table.
  for (;;) {
    const pending = deps.withGroveDb(journal.source_grove_id, () => listPendingForProject(journal.project_id));
    if (pending.length === 0) break;
    for (const [table, rows] of groupByTable(pending)) {
      if (!(await shipOutboxRows(table, rows))) { giveUp(); return; }
    }
    await yieldToLoop();
  }

  // (2) sidecars — page each stream, cursor advancing only after the page ships.
  if (!(await shipSidecar(journal, deps, shipPlainRows, teamsHome, 'entity_mentions', listEntityMentionPages))) { giveUp(); return; }
  if (!(await shipSidecar(journal, deps, shipPlainRows, teamsHome, 'content_publications', listContentPublicationPages))) { giveUp(); return; }

  // (3) adoption backstop — a project with a registry row but no sync-eligible
  // rows ships zero batches, so the host never learns its name. Send one
  // adoption-only request before the local rows go.
  if (!journal.adopted && (await post({ table: 'sessions', rows: [] })) !== 200) { giveUp(); return; }

  // (4) full ack — clear failure state, purge local rows, finish.
  clearJournalFailure(journal, deps, teamsHome);
  deleteAfterAck(journal, deps);
  deps.logger?.info(LOG_KINDS.RESIDENCY_COMPLETE, 'residency attach transition complete', {
    project_id: journal.project_id,
    host_id: journal.host_id,
  });
}

/** Ship one sidecar stream to exhaustion, persisting the resume cursor after
 *  each acked page. Returns false (and leaves the cursor) on a failed POST. */
async function shipSidecar(
  journal: ResidencyJournal,
  deps: ResidencyDrainDeps,
  shipRows: (table: string, rows: Record<string, unknown>[]) => Promise<boolean>,
  teamsHome: string | undefined,
  table: 'entity_mentions' | 'content_publications',
  pager: (projectId: string, cursor: string | null) => { rows: Record<string, unknown>[]; nextCursor: string | null },
): Promise<boolean> {
  let cursor = journal.cursors[table];
  while (cursor !== CURSOR_DONE) {
    const startToken = typeof cursor === 'string' && cursor ? cursor : null;
    const page = deps.withGroveDb(journal.source_grove_id, () => pager(journal.project_id, startToken));
    if (page.rows.length > 0) {
      if (!(await shipRows(table, page.rows))) return false;
    }
    const nextToken = page.nextCursor ?? CURSOR_DONE;
    advanceResidencyPhase(journal.project_id, 'pushing', { cursors: { [table]: nextToken } }, teamsHome);
    cursor = nextToken;
    await yieldToLoop();
  }
  return true;
}

/**
 * Delete the project's local rows after the host has the full push, in the
 * house project-delete shape (`grove/project-lifecycle.ts` `deleteProjectRows`):
 * ONE synchronous FK-off transaction — plain `DELETE ... WHERE project_id = ?`
 * per table, no yields inside the FK-off window. Two requirements force this
 * exact shape: FK enforcement must not straddle a yield on the shared pinned
 * connection (a grove-mate project's write mid-yield would run FK-off), and a
 * plain project-id delete removes the WITHOUT ROWID tables (`canopy_entries`,
 * `canopy_maps`) that a `rowid`-keyed delete cannot even prepare against.
 * `content_publications` (no `project_id`, so absent from the scoped set) is
 * deleted first, while its owning artifacts still exist to scope the join.
 */
function deleteAfterAck(journal: ResidencyJournal, deps: ResidencyDrainDeps): void {
  // Re-confirm at the TOP of this synchronous critical section: pushTransition
  // reached here through network awaits, during which a concurrent abort
  // (synchronous, from the localhost route) may have restored the local
  // registration and cleared the journal. Bail unless the journal still exists
  // and is still pushing — otherwise this delete would empty the project the
  // abort just restored. Race-free: both this section and the abort are
  // synchronous.
  const current = readResidencyJournal(journal.project_id, deps.teamsHome);
  if (!current || current.phase !== 'pushing') return;

  deps.withGroveDb(journal.source_grove_id, (db) => {
    deleteContentPublicationsForProject(journal.project_id);
    // Tolerate an older/partial Grove DB by pre-checking which tables exist,
    // rather than swallowing every DELETE error (which would also hide a real
    // failure — the bug a catch-all here would reintroduce).
    const present = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name),
    );
    db.run('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        for (const table of GROVE_PROJECT_SCOPED_TABLES) {
          if (!present.has(table)) continue;
          db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(journal.project_id);
        }
      })();
    } finally {
      db.run('PRAGMA foreign_keys = ON');
    }
  });
  advanceResidencyPhase(journal.project_id, 'done', {}, deps.teamsHome);
  clearResidencyJournal(journal.project_id, deps.teamsHome);
  // Last act: the rows are on the host and the local copy is gone, so the
  // project is no longer mid-flight and writers may proceed again.
  releaseResidencyLease(journal.project_id, deps.mycoHome);
  deps.withGroveDb(journal.source_grove_id, () => pruneOld());
}

function groupByTable(rows: OutboxRow[]): Map<string, OutboxRow[]> {
  const byTable = new Map<string, OutboxRow[]>();
  for (const row of rows) {
    const list = byTable.get(row.table_name) ?? [];
    list.push(row);
    byTable.set(row.table_name, list);
  }
  return byTable;
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function recordJournalFailure(
  journal: ResidencyJournal,
  err: unknown,
  deps: ResidencyDrainDeps,
  teamsHome: string | undefined,
): void {
  const message = err instanceof Error ? err.message : String(err);
  // The stamp re-reads the durable journal and preserves whatever phase it
  // holds NOW. The `journal` argument here can be a snapshot from before an
  // await — or the pass-start listing — and the durable phase may have advanced
  // since (the detach flip advances it mid-pass); writing a snapshot phase back
  // would regress the journal across the irreversible flip.
  const current = stampResidencyFailure(journal.project_id, message, teamsHome);
  if (shouldLogOncePerInterval(`residency.fail.${journal.project_id}`, FAILURE_LOG_INTERVAL_MS, Date.now())) {
    deps.logger?.warn(LOG_KINDS.RESIDENCY_ATTACH_PUSH, 'residency transition step failed — retry next tick', {
      project_id: journal.project_id,
      host_id: journal.host_id,
      phase: current?.phase ?? journal.phase,
      error: message,
    });
  }
}

function clearJournalFailure(journal: ResidencyJournal, _deps: ResidencyDrainDeps, teamsHome: string | undefined): void {
  if (!journal.last_error && !journal.last_error_at) return;
  // Phase-preserving for the same reason as the stamp: this may hold a stale
  // snapshot, and the clear must not write its phase back.
  clearResidencyFailure(journal.project_id, teamsHome);
}
