/**
 * Team Host — the host RECEIVE side of a detach-pull (Phase F T3).
 *
 * A detaching member drains its rows back from the host, one page per request
 * (`host/residency-drain.ts` → `POST /routed-capture/residency-pull`). This module
 * is the thin HTTP shell around the pull enumerator (`db/queries/residency-pull.ts`):
 * it serves the caller machine's rows for the project (plus the project's
 * content_publications, all machines — D-F-4), resumable via an opaque cursor, and
 * runs the transition's exactly-once-ish side effects:
 *
 *   - FIRST page (no cursor): release the caller machine's active content claims for
 *     the project — a member leaving must not strand a live publication lock.
 *   - DONE page (every table exhausted): purge the departing project's routed
 *     transcript trees, and — only when the project is a true stub (no rows from any
 *     machine other than the host's own or the departing member's) — deregister the
 *     hosted registry row and invalidate the host-serve status cache so
 *     `hosted_project_count` is honest immediately.
 *
 * Every side effect is idempotent, so a lost-ack re-pull of any page (including the
 * first and the done page) converges: claims re-release to no-op, the purge skips
 * already-gone trees, and a force-deregister of an already-gone row is a no-op. The
 * stub-deregister only ever fires on the done page, never mid-pull.
 */
import { z } from 'zod';

import { epochSeconds } from '../constants.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { getDatabase, type Database } from '../db/client.js';
import { releaseActiveContentClaimsForMachine } from '../db/queries/content-claims.js';
import { projectHasForeignMachineRows, pullResidencyPage } from '../db/queries/residency-pull.js';
import { invalidateHostServeStatusCache } from '../daemon/api/host-serve-status.js';
import { shouldLogOncePerInterval } from '../daemon/log-throttle.js';
import type { Logger } from '../daemon/logger.js';
import type { RouteRequest, RouteResponse } from '../daemon/router.js';
import { deregisterProjectInGrove } from '../grove/registry.js';
import { rowProjectIdFromRequestContext } from '../grove/request-context.js';
import { getTeamMachineId } from '../team/context.js';
import { pruneRoutedTranscriptSessionsForMachine } from './routed-transcript.js';

/** Throttle window for repeated host-side pull warnings — the member re-pulls a
 *  failed page every tick. */
const PULL_LOG_INTERVAL_MS = 60_000;

/** The detach-pull request body (matches the frozen T4 wire contract). */
const ResidencyPullBody = z.object({
  cursor: z.string().nullable().optional(),
});

/**
 * Done-page side effects: purge the departing project's transcript trees, then a
 * stub check — deregister the hosted row only when no OTHER machine still has rows
 * (the host's own intelligence-stamped rows and the departing member's own rows are
 * both excluded; the DB rows are left in place as the team's kept record, D-F-3).
 */
function finishDetachPull(
  db: Database,
  input: { groveId: string; projectId: string; machineId: string; mycoHome?: string; logger?: Logger },
): void {
  // (a) Purge only THIS project's session trees (the cache is machine+session-keyed,
  //     not project-keyed, so a member's other attached projects are untouched).
  const sessionIds = (db.prepare(
    'SELECT id FROM sessions WHERE project_id = ? AND machine_id = ?',
  ).all(input.projectId, input.machineId) as { id: string }[]).map((r) => r.id);
  pruneRoutedTranscriptSessionsForMachine(input.machineId, sessionIds);

  // (b) True-stub check: the host's own machine and the departing member's machine
  //     are both excluded, so this asks "does any OTHER member still have rows here".
  //     Deregisters the REGISTRY row only — the DB rows stay as the team's kept
  //     record (D-F-3 copy-out); true removal is an explicit operator delete.
  //
  //     Edge (accepted, self-healing): a member who ATTACHED but never captured has
  //     no host-visible rows — attach state is member-local, the host cannot see its
  //     refs — so a sole-contributor detach deregisters despite that member existing.
  //     That is fine: that member's FIRST forwarded capture re-registers the project
  //     via the registration-on-ingest seam and reconciles idempotently.
  const hostMachineId = getTeamMachineId();
  if (!projectHasForeignMachineRows(db, input.projectId, [hostMachineId, input.machineId])) {
    deregisterProjectInGrove(input.groveId, input.projectId, input.mycoHome, { force: true });
    invalidateHostServeStatusCache();
    input.logger?.info(LOG_KINDS.RESIDENCY_DETACH_PULL, 'Deregistered stub project after detach', {
      project_id: input.projectId,
      grove_id: input.groveId,
    });
  }
}

/**
 * Build the `POST /routed-capture/residency-pull` handler. Runs inside the daemon's
 * per-request `withDatabase` boundary (the member's tenancy headers bind the served
 * Grove DB), so `getDatabase()` resolves to the correct Grove. `mycoHome` is
 * injectable for tests; production uses the resolved home for the deregister write.
 */
export function createRoutedResidencyPullHandler(
  deps: { logger?: Logger; mycoHome?: string } = {},
): (req: RouteRequest) => Promise<RouteResponse> {
  return async (req: RouteRequest): Promise<RouteResponse> => {
    const parsed = ResidencyPullBody.safeParse(req.body);
    if (!parsed.success) {
      return { status: 400, body: { ok: false, error: 'invalid_body', detail: parsed.error.issues } };
    }
    const cursor = parsed.data.cursor ?? null;
    const groveId = req.requestContext?.groveId ?? null;
    const projectId = rowProjectIdFromRequestContext(req.requestContext) ?? null;
    const machineId = req.requestContext?.machineId ?? null;
    if (!groveId || !projectId || !machineId) {
      return { status: 400, body: { ok: false, error: 'missing_tenancy' } };
    }

    try {
      const db = getDatabase();
      // First page: release the caller's active claims (idempotent on re-pull).
      if (!cursor) {
        releaseActiveContentClaimsForMachine(machineId, projectId, epochSeconds());
      }
      const page = pullResidencyPage(db, { projectId, machineId, cursor });
      if (page.done) {
        finishDetachPull(db, { groveId, projectId, machineId, mycoHome: deps.mycoHome, logger: deps.logger });
      }
      return { status: 200, body: { ok: true, rows: page.rows, next_cursor: page.nextCursor, done: page.done } };
    } catch (err) {
      if (shouldLogOncePerInterval(`residency.pull_failed:${projectId}`, PULL_LOG_INTERVAL_MS)) {
        deps.logger?.warn(LOG_KINDS.RESIDENCY_DETACH_PULL, 'Detach-pull page failed — member will retry', {
          project_id: projectId,
          error: (err as Error).message,
        });
      }
      return { status: 500, body: { ok: false, error: 'pull_failed', message: (err as Error).message } };
    }
  };
}
