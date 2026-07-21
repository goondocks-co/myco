/**
 * Member-side residency drain (Phase F, attach direction) — the daemon job that
 * carries a with-history attach the rest of the way: it re-drives any `parking`
 * journal a crash left mid-setup, ships a `pushing` journal's queued rows (and
 * the two sidecar streams) to the Team Host, and — only after the host
 * acknowledges the FULL push — deletes the project's local rows (the backup is
 * the safety copy) and clears the journal.
 *
 * Discipline mirrors the other member drains (`capture/plan-drain.ts`): at-
 * least-once with host-side idempotency, a failed POST logs (throttled) and
 * retries next tick, and NOTHING advances on failure. The one difference is the
 * terminal act — a local delete — which runs exactly once, gated on full ack.
 *
 * Transport is the injectable seam so the ship discipline is unit-testable
 * without a real host; production POSTs through the host's `proxy_port` via
 * {@link defaultResidencyTransport}, exactly like the transcript/plan drains.
 */
import {
  HOST_BEARER_SECRET,
  HOST_PROTOCOL_HEADER,
  HOST_PROTOCOL_VERSION,
  HOST_PROXY_BODY_TIMEOUT_MS,
  HOST_PROXY_HEADERS_TIMEOUT_MS,
  epochSeconds,
} from '../constants.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { changesSince, type Database } from '../db/client.js';
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
import { defaultDial, parseOverlayAddress } from '../daemon/host-proxy.js';
import { shouldLogOncePerInterval } from '../daemon/log-throttle.js';
import { REQUEST_CONTEXT_HEADERS } from '../grove/request-context.js';
import type { GroveProjectId } from '../grove/ids.js';
import { getHost, readHostSecrets } from './registry.js';
import type { RemoteTarget } from './routing.js';
import { completeAttachParking, type ResidencyDaemonDeps } from './residency-transition.js';
import {
  ROUTED_RESIDENCY_ROWS_PATH,
  RESIDENCY_MIN_HOST_PROTOCOL,
  advanceResidencyPhase,
  clearResidencyJournal,
  listResidencyJournals,
  readResidencyJournal,
  type ResidencyJournal,
} from './residency-journal.js';

/** Rows deleted per DELETE batch during the post-ack local purge. A giant
 *  synchronous delete stalls the main loop; we yield between batches. */
const DELETE_BATCH_SIZE = 500;

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

export interface ResidencyDrainDeps extends ResidencyDaemonDeps {
  transport?: ResidencyPostTransport;
  resolveHostTarget?: ResolveResidencyTarget;
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

/** How many transitions are still in flight — the deep-sleep `hold.pending`
 *  signal, so the machine never sleeps mid-move. */
export function countResidencyInFlight(teamsHome?: string): number {
  return listResidencyJournals(teamsHome).filter((j) => j.phase !== 'done').length;
}

/**
 * One drain tick: advance every attach journal as far as it will go. `parking`
 * journals are re-driven to `pushing`; `pushing` journals ship their rows and,
 * on full ack, purge locally and finish. Detach journals belong to the pull
 * task and are skipped here.
 */
export async function runResidencyTransitions(deps: ResidencyDrainDeps): Promise<{ processed: number }> {
  const transport = deps.transport ?? defaultResidencyTransport;
  const resolveTarget = deps.resolveHostTarget ?? defaultResolveResidencyTarget;
  const teamsHome = deps.teamsHome;
  let processed = 0;

  for (const journal of listResidencyJournals(teamsHome)) {
    if (journal.direction !== 'attach') continue;
    if (journal.phase === 'done') {
      clearResidencyJournal(journal.project_id, teamsHome);
      continue;
    }
    try {
      if (journal.phase === 'parking') {
        completeAttachParking(journal, deps);
      }
      const current = readResidencyJournal(journal.project_id, teamsHome);
      if (current?.phase === 'pushing') {
        await pushTransition(current, deps, transport, resolveTarget, teamsHome);
        processed += 1;
      }
    } catch (err) {
      recordJournalFailure(journal, err, deps, teamsHome);
    }
  }

  return { processed };
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

  const ship = async (body: ResidencyRowsRequest): Promise<boolean> => {
    if (!journal.adopted) body.adoption = { project_name: journal.project_name };
    const resp = await transport(target, body, deps.machineId);
    if (resp.status !== 200) {
      recordJournalFailure(journal, new Error(`host returned ${resp.status}`), deps, teamsHome);
      return false;
    }
    if (!journal.adopted) {
      journal.adopted = true;
      advanceResidencyPhase(journal.project_id, 'pushing', { adopted: true }, teamsHome);
    }
    return true;
  };

  // (1) outbox rows — drain project-filtered batches, one POST per table.
  for (;;) {
    const pending = deps.withGroveDb(journal.source_grove_id, () => listPendingForProject(journal.project_id));
    if (pending.length === 0) break;
    for (const [table, rows] of groupByTable(pending)) {
      const ok = await ship({ table, rows: rows.map((r) => r.payload) });
      if (!ok) return;
      const sentAt = epochSeconds();
      deps.withGroveDb(journal.source_grove_id, () => {
        markSent(rows.map((r) => r.id), sentAt);
        markSourceRowsSynced(rows, sentAt);
      });
    }
    await yieldToLoop();
  }

  // (2) sidecars — page each stream, cursor advancing only on a 200.
  if (!(await shipSidecar(journal, deps, ship, teamsHome, 'entity_mentions', listEntityMentionPages))) return;
  if (!(await shipSidecar(journal, deps, ship, teamsHome, 'content_publications', listContentPublicationPages))) return;

  // (3) full ack — clear failure state, purge local rows, finish.
  clearJournalFailure(journal, deps, teamsHome);
  await deleteAfterAck(journal, deps);
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
  ship: (body: ResidencyRowsRequest) => Promise<boolean>,
  teamsHome: string | undefined,
  table: 'entity_mentions' | 'content_publications',
  pager: (projectId: string, cursor: string | null) => { rows: Record<string, unknown>[]; nextCursor: string | null },
): Promise<boolean> {
  let cursor = journal.cursors[table];
  while (cursor !== CURSOR_DONE) {
    const startToken = typeof cursor === 'string' && cursor ? cursor : null;
    const page = deps.withGroveDb(journal.source_grove_id, () => pager(journal.project_id, startToken));
    if (page.rows.length > 0) {
      if (!(await ship({ table, rows: page.rows }))) return false;
    }
    const nextToken = page.nextCursor ?? CURSOR_DONE;
    advanceResidencyPhase(journal.project_id, 'pushing', { cursors: { [table]: nextToken } }, teamsHome);
    cursor = nextToken;
    await yieldToLoop();
  }
  return true;
}

/**
 * Delete the project's local rows after the host has the full push. FK
 * enforcement is disabled around the sweep (the existing project-delete
 * pattern) so table order is irrelevant, and each table is deleted in batches
 * with a yield between them so a large project never stalls the main loop.
 * `content_publications` (no `project_id`, so not in the scoped set) is deleted
 * first, while its owning artifacts still exist to scope it.
 */
async function deleteAfterAck(journal: ResidencyJournal, deps: ResidencyDrainDeps): Promise<void> {
  await deps.withGroveDb(journal.source_grove_id, async (db) => {
    db.run('PRAGMA foreign_keys = OFF');
    try {
      deleteContentPublicationsForProject(journal.project_id);
      for (const table of GROVE_PROJECT_SCOPED_TABLES) {
        await deleteTableRowsBatched(db, table, journal.project_id);
      }
    } finally {
      db.run('PRAGMA foreign_keys = ON');
    }
  });
  advanceResidencyPhase(journal.project_id, 'done', {}, deps.teamsHome);
  clearResidencyJournal(journal.project_id, deps.teamsHome);
  deps.withGroveDb(journal.source_grove_id, () => pruneOld());
}

async function deleteTableRowsBatched(db: Database, table: string, projectId: string): Promise<void> {
  let stmt: ReturnType<Database['prepare']>;
  try {
    stmt = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE project_id = ? LIMIT ?)`);
  } catch {
    return; // an older/partial Grove DB may lack this table — skip, like deleteProjectRows
  }
  for (;;) {
    stmt.run(projectId, DELETE_BATCH_SIZE);
    if (changesSince(db) === 0) break;
    await yieldToLoop();
  }
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
