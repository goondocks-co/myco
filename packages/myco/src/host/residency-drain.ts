/**
 * Member-side residency drain (Phase F) — the daemon job that carries a
 * residency transition the rest of the way in both directions.
 *
 * ATTACH: re-drives a crash-interrupted `parking` journal, ships a `pushing`
 * journal's queued rows (+ the two sidecar streams) to the host, and — only
 * after the host acknowledges the FULL push — deletes the project's local rows
 * (the backup is the safety copy) and clears the journal.
 *
 * DETACH: pulls a `pulling` journal's project rows back into per-table NDJSON
 * staging page by page, then flips (remove the attach ref, re-materialize the
 * local Grove row) → `applying`, applies the staged rows into the local Grove DB
 * via the shared apply engine, re-homes any events buffered under the host Grove
 * during the window, purges the host drain stores, and clears the journal.
 *
 * Discipline mirrors the other member drains (`capture/plan-drain.ts`): at-
 * least-once with host-side idempotency, a failed POST logs (throttled) and
 * retries next tick, and NOTHING advances on failure. Transports are injectable
 * seams so the ship/pull discipline is unit-testable without a real host.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  HOST_BEARER_SECRET,
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
import { defaultDial, parseOverlayAddress } from '../daemon/host-proxy.js';
import { shouldLogOncePerInterval } from '../daemon/log-throttle.js';
import { REQUEST_CONTEXT_HEADERS } from '../grove/request-context.js';
import type { GroveProjectId } from '../grove/ids.js';
import { resolveProjectBufferDir } from '../grove/paths.js';
import { detachProject, getHost, readHostSecrets } from './registry.js';
import { registerProjectInGrove } from '../grove/registry.js';
import type { RemoteTarget } from './routing.js';
import { completeAttachParking, type ResidencyDaemonDeps } from './residency-transition.js';
import {
  ROUTED_RESIDENCY_ROWS_PATH,
  ROUTED_RESIDENCY_PULL_PATH,
  RESIDENCY_MIN_HOST_PROTOCOL,
  advanceResidencyPhase,
  appendResidencyStagingRows,
  clearResidencyJournal,
  clearResidencyStaging,
  listResidencyJournals,
  listResidencyStagingTables,
  readResidencyJournal,
  readResidencyStagingRows,
  type ResidencyJournal,
} from './residency-journal.js';

/** Throttle window for repeated per-project drain-failure warnings. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

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

/** One pulled page of the detach transfer. */
export interface ResidencyPullResponse {
  status: number;
  rows: { table: string; row: Record<string, unknown> }[];
  next_cursor: string | null;
  done: boolean;
}

/** The pull transport seam — reads one page of the machine's rows from the host. */
export type ResidencyPullTransport = (
  target: RemoteTarget,
  body: { cursor: string | null },
  machineId: string,
) => Promise<ResidencyPullResponse>;

/**
 * Apply staged detach rows into the local Grove DB. Wraps the SHARED apply
 * engine (`db/queries/residency-apply.ts` `applyResidencyRows`, extracted by T3)
 * so both directions use identical per-table rules with no duplication. MUST run
 * inside a transaction — the caller wraps it. Injected so the drain stays
 * testable and decoupled from the engine's extraction timing.
 */
export type ApplyStagedRows = (db: Database, table: string, rows: Record<string, unknown>[]) => void;

export interface ResidencyDrainDeps extends ResidencyDaemonDeps {
  transport?: ResidencyPostTransport;
  pullTransport?: ResidencyPullTransport;
  resolveHostTarget?: ResolveResidencyTarget;
  /** Apply staged detach rows into the local Grove DB (the shared engine). */
  applyStagedRows?: ApplyStagedRows;
  teamsHome?: string;
}

/**
 * Production transport: POST the rows to the host's residency route through the
 * same dial primitive the byte-opaque proxy uses, attaching the host bearer +
 * protocol header AND the per-request tenancy headers the host binds the Grove
 * DB from — grove = the HOST's served Grove, project = the project being moved,
 * machine = this member. Reads the small JSON ack.
 */
export const defaultResidencyTransport: ResidencyPostTransport = async (target, body, machineId) => {
  const { host: overlayHost, port } = parseOverlayAddress(target.host.overlay_address);
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  const headers = {
    host: `${overlayHost}:${port}`,
    authorization: `Bearer ${target.bearer}`,
    'content-type': 'application/json',
    'content-length': String(payload.length),
    [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
    [REQUEST_CONTEXT_HEADERS.projectId]: String(target.projectId),
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
const defaultResolveResidencyTarget: ResolveResidencyTarget = (hostId, groveId, projectId) => {
  const host = getHost(hostId);
  if (!host) return null;
  const bearer = readHostSecrets(hostId)[HOST_BEARER_SECRET] ?? '';
  return {
    projectId: projectId as GroveProjectId,
    groveId,
    host: {
      host_id: host.host_id,
      label: host.label,
      overlay_address: host.overlay_address,
      protocol_version: host.protocol_version,
      proxy_port: host.proxy_port,
    },
    bearer,
  };
};

/**
 * Production pull transport: POST the resume cursor to the host's residency-pull
 * route and read one page. Same dial + tenancy-header shape as the push (grove =
 * the HOST's served Grove, project, THIS machine); parses `{rows, next_cursor,
 * done}`.
 */
export const defaultResidencyPullTransport: ResidencyPullTransport = async (target, body, machineId) => {
  const { host: overlayHost, port } = parseOverlayAddress(target.host.overlay_address);
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  const headers = {
    host: `${overlayHost}:${port}`,
    authorization: `Bearer ${target.bearer}`,
    'content-type': 'application/json',
    'content-length': String(payload.length),
    [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
    [REQUEST_CONTEXT_HEADERS.projectId]: String(target.projectId),
    [REQUEST_CONTEXT_HEADERS.groveId]: target.groveId,
    [REQUEST_CONTEXT_HEADERS.machineId]: machineId,
  };
  const req = await defaultDial(target, { method: 'POST', path: ROUTED_RESIDENCY_PULL_PATH, headers });

  return new Promise<ResidencyPullResponse>((resolve, reject) => {
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
        let parsed: { rows?: unknown; next_cursor?: unknown; done?: unknown } = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* non-JSON body */ }
        resolve({
          status: res.statusCode ?? 0,
          rows: Array.isArray(parsed.rows) ? (parsed.rows as ResidencyPullResponse['rows']) : [],
          next_cursor: typeof parsed.next_cursor === 'string' ? parsed.next_cursor : null,
          done: parsed.done === true,
        });
      });
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
  const pullTransport = deps.pullTransport ?? defaultResidencyPullTransport;
  const resolveTarget = deps.resolveHostTarget ?? defaultResolveResidencyTarget;
  const teamsHome = deps.teamsHome;
  let processed = 0;

  for (const journal of listResidencyJournals(teamsHome)) {
    if (journal.phase === 'done') {
      clearResidencyJournal(journal.project_id, teamsHome);
      clearResidencyStaging(journal.project_id, teamsHome);
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
        await runDetachTransition(journal, deps, pullTransport, resolveTarget, teamsHome);
        processed += 1;
      }
    } catch (err) {
      recordJournalFailure(journal, err, deps, teamsHome);
    }
  }

  return { processed };
}

/**
 * Carry a detach journal forward. `pulling`: pull remaining pages into staging
 * (resume-exact from the journal cursor), then flip — remove the attach ref and
 * re-materialize the local Grove row (both idempotent, so a crash between them
 * heals) — and advance to `applying`. `applying`: apply the staged rows via the
 * shared engine (double-apply is a no-op under its freshness rules), re-home the
 * events buffered under the host Grove during the window, purge the host drain
 * stores, and finish.
 */
async function runDetachTransition(
  journal: ResidencyJournal,
  deps: ResidencyDrainDeps,
  pullTransport: ResidencyPullTransport,
  resolveTarget: ResolveResidencyTarget,
  teamsHome: string | undefined,
): Promise<void> {
  const targetGroveId = journal.target_grove_id;
  if (!targetGroveId) {
    // A detach journal always carries its re-materialize target; a missing one is
    // a corrupt journal, not something a retry fixes.
    recordJournalFailure(journal, new Error('detach journal has no target_grove_id'), deps, teamsHome);
    return;
  }

  if (journal.phase === 'pulling') {
    if (journal.cursors.pull !== CURSOR_DONE) {
      const target = resolveTarget(journal.host_id, journal.divert_grove_id, journal.project_id);
      if (!target) return; // host record gone — leave for a later tick
      if (target.host.protocol_version < RESIDENCY_MIN_HOST_PROTOCOL) {
        if (shouldLogOncePerInterval(`residency.proto.${journal.project_id}`, FAILURE_LOG_INTERVAL_MS, Date.now())) {
          deps.logger?.warn(LOG_KINDS.RESIDENCY_DETACH_PULL, 'host below residency protocol — pull skipped', {
            project_id: journal.project_id, host_id: journal.host_id, host_protocol: target.host.protocol_version,
          });
        }
        return;
      }
      let cursor: string | null = typeof journal.cursors.pull === 'string' && journal.cursors.pull ? journal.cursors.pull : null;
      for (;;) {
        let page: ResidencyPullResponse;
        try { page = await pullTransport(target, { cursor }, deps.machineId); }
        catch (err) { recordJournalFailure(journal, err, deps, teamsHome); return; }
        if (page.status !== 200) {
          recordJournalFailure(journal, new Error(`host returned ${page.status}`), deps, teamsHome);
          return;
        }
        // Re-confirm after the network await: a concurrent abort (synchronous,
        // from the localhost route) may have cleared this journal + staging while
        // we were pulling. Stop, so we don't stage into — or flip — a transition
        // that no longer exists.
        const stillPulling = readResidencyJournal(journal.project_id, teamsHome);
        if (!stillPulling || stillPulling.phase !== 'pulling') return;
        // Append THEN advance the cursor — at-least-once; a resumed re-pull of the
        // same page re-appends, which the idempotent apply engine flattens.
        appendResidencyStagingRows(journal.project_id, page.rows, teamsHome);
        if (page.done) {
          advanceResidencyPhase(journal.project_id, 'pulling', { cursors: { pull: CURSOR_DONE } }, teamsHome);
          break;
        }
        cursor = page.next_cursor;
        advanceResidencyPhase(journal.project_id, 'pulling', { cursors: { pull: cursor ?? '' } }, teamsHome);
        await yieldToLoop();
      }
    }

    // Re-confirm at the TOP of this synchronous critical section before the
    // irreversible flip: a concurrent abort during the pull awaits may have
    // cleared the journal (leaving the project attached, unchanged). Since both
    // this section and the abort are synchronous, this read is race-free — bail
    // unless the journal still exists and is still pulling.
    const beforeFlip = readResidencyJournal(journal.project_id, teamsHome);
    if (!beforeFlip || beforeFlip.phase !== 'pulling') return;

    // Flip: the journal already records target_grove_id + root (written at begin),
    // so a crash between these two steps re-drives idempotently next tick.
    detachProject(journal.host_id, journal.project_id);
    registerProjectInGrove(targetGroveId, {
      projectId: journal.project_id,
      projectName: journal.project_name,
      projectRoot: journal.root,
    }, deps.mycoHome);
    advanceResidencyPhase(journal.project_id, 'applying', {}, teamsHome);
    const refreshed = readResidencyJournal(journal.project_id, teamsHome);
    if (!refreshed) return;
    journal = refreshed;
  }

  if (journal.phase === 'applying') {
    const applyRows = deps.applyStagedRows;
    if (!applyRows) {
      recordJournalFailure(journal, new Error('residency apply engine not wired'), deps, teamsHome);
      return;
    }
    // (6) apply staged pages into the local Grove DB via the shared engine, one
    // transaction. Post-flip live capture already in the DB wins over older host
    // snapshots — the engine's if-newer / insert-only rules guarantee it. Tables
    // apply in the engine's canonical FK-topological order (RESIDENCY_TABLE_ORDER),
    // NOT the arbitrary readdirSync order the staging enumerator returns — a child
    // before its parent throws in the immediate-FK transaction and would wedge the
    // retry.
    const staged = new Set(listResidencyStagingTables(journal.project_id, teamsHome));
    const ordered = RESIDENCY_TABLE_ORDER.filter((table) => staged.has(table));
    // An unexpected staged table (outside the allow-listed residency set) applies
    // last; the engine rejects an unknown table, surfacing the drift loudly rather
    // than dropping data silently.
    const extras = [...staged].filter((table) => !RESIDENCY_TABLE_ORDER.includes(table));
    deps.withGroveDb(targetGroveId, (db) => {
      db.transaction(() => {
        for (const table of [...ordered, ...extras]) {
          applyRows(db, table, readResidencyStagingRows(journal.project_id, table, teamsHome));
        }
      })();
    });
    // Advance to the terminal sweep. The journal PERSISTS through `rehoming` so a
    // crash mid-sweep resumes it, and divert is now OFF (rehoming ∉ divert-active)
    // so no new event lands in the host-Grove buffer after the flip.
    advanceResidencyPhase(journal.project_id, 'rehoming', {}, teamsHome);
    const swept = readResidencyJournal(journal.project_id, teamsHome);
    if (!swept) return;
    journal = swept;
  }

  if (journal.phase === 'rehoming') {
    // (7) re-home the events diverted under the host Grove during the window into
    // the local buffer, and (8) purge the host drain stores. Both idempotent, so
    // a crash mid-sweep re-runs cleanly. The journal is cleared ONLY after they
    // complete — that is what makes the sweep itself crash-resumable (clearing it
    // earlier would orphan any residual buffered events with no journal to drive
    // the resume).
    rehomeBufferedEvents(
      resolveProjectBufferDir(journal.divert_grove_id, journal.project_id, deps.mycoHome),
      resolveProjectBufferDir(targetGroveId, journal.project_id, deps.mycoHome),
    );
    try {
      createFsDrainStore().purgeProject(journal.host_id, journal.project_id);
      createFsPlanDrainStore().purgeProject(journal.host_id, journal.project_id);
      createFsReplayStore().purgeProject(journal.host_id, journal.project_id);
    } catch { /* best-effort machine-scoped cleanup */ }

    advanceResidencyPhase(journal.project_id, 'done', {}, teamsHome);
    clearResidencyJournal(journal.project_id, teamsHome);
    clearResidencyStaging(journal.project_id, teamsHome);

    deps.logger?.info(LOG_KINDS.RESIDENCY_COMPLETE, 'residency detach transition complete', {
      project_id: journal.project_id, host_id: journal.host_id,
    });
  }
}

/** Move the durable capture files (`<session>.jsonl`) diverted under the host
 *  Grove during the window into the local Grove's buffer dir — a byte-level move
 *  (no re-parse), merging by append on a same-session collision so the local
 *  reconciler dedups by event id. */
function rehomeBufferedEvents(fromDir: string, toDir: string): void {
  let files: string[];
  try { files = fs.readdirSync(fromDir); } catch { return; } // nothing buffered
  for (const file of files) {
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
    } catch { /* skip a file that vanished mid-move; a retry re-home catches the rest */ }
  }
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
  if (!target) return; // host record gone — leave the journal for a later tick
  if (target.host.protocol_version < RESIDENCY_MIN_HOST_PROTOCOL) {
    // The route the push needs does not exist on a pre-residency host; it never
    // self-heals by retry, so skip until an upgrade + reconnect.
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

  // A non-200 STATUS on a multi-row batch may just be an over-cap payload (near
  // the 8MB per-request limit); halve and retry so an oversized batch can't wedge
  // retry-forever. A transport error (status 0 — host unreachable) never
  // self-heals by splitting, so it fails straight to a next-tick retry.
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
    if (status !== 0 && rows.length > 1) {
      const mid = Math.floor(rows.length / 2);
      return (await shipOutboxRows(table, rows.slice(0, mid))) && (await shipOutboxRows(table, rows.slice(mid)));
    }
    return false;
  };

  const shipPlainRows = async (table: string, rows: Record<string, unknown>[]): Promise<boolean> => {
    if (rows.length === 0) return true;
    const status = await post({ table, rows });
    if (status === 200) return true;
    if (status !== 0 && rows.length > 1) {
      const mid = Math.floor(rows.length / 2);
      return (await shipPlainRows(table, rows.slice(0, mid))) && (await shipPlainRows(table, rows.slice(mid)));
    }
    return false;
  };

  const giveUp = (): void =>
    recordJournalFailure(journal, new Error(`residency push failed (host status ${lastStatus})`), deps, teamsHome);

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
  if (shouldLogOncePerInterval(`residency.fail.${journal.project_id}`, FAILURE_LOG_INTERVAL_MS, Date.now())) {
    deps.logger?.warn(LOG_KINDS.RESIDENCY_ATTACH_PUSH, 'residency transition step failed — retry next tick', {
      project_id: journal.project_id,
      host_id: journal.host_id,
      phase: journal.phase,
      error: message,
    });
  }
  // Record the last error for the residency-status/doctor surface, without
  // advancing the phase (retry resumes from the same point next tick).
  advanceResidencyPhase(journal.project_id, journal.phase, {
    last_error: message,
    last_error_at: new Date().toISOString(),
  }, teamsHome);
}

function clearJournalFailure(journal: ResidencyJournal, deps: ResidencyDrainDeps, teamsHome: string | undefined): void {
  if (!journal.last_error && !journal.last_error_at) return;
  advanceResidencyPhase(journal.project_id, journal.phase, { last_error: undefined, last_error_at: undefined }, teamsHome);
}
