/**
 * Team Host — the host RECEIVE side of the routed plan-content companion push
 * (capture-push §5.5, plan C7).
 *
 * Under Team Host a routed session's plan FILE lives on the MEMBER's disk, but
 * plan capture writes to the HOST's Grove DB. The member's byte-opaque proxy
 * cannot inject the file's content into the `/events` body, so plan content rides
 * its OWN companion channel — exactly parallel to the transcript-content push
 * (C1/C2), but SIMPLER: a plan file is small and read WHOLE, so there is no
 * offset/append discipline and no host-side materialized-file cache. The member
 * reads the plan file and POSTs `{ machine_id, session_id, plan_path, content }`;
 * this module runs the SAME host-side `capturePlan` the local path uses, against
 * the Grove DB the request's tenancy headers bind.
 *
 * IDEMPOTENCY is the plan store's EXISTING logical-key upsert (`capturePlan` →
 * `persistPlan`), not a wire-level gate: the row is keyed
 * `(session_id, normalized plan_path)`, so a re-push of identical content
 * short-circuits (content-hash + title + status match → no write, no team-sync
 * enqueue) and a re-push of CHANGED content upserts the SAME row. A replay is
 * therefore a no-op with no offset gate needed (contrast C2's byte-offset gate).
 * The member drain also dedups by content hash so an unchanged file never re-POSTs.
 *
 * The route is stamped `collect` in `host/routing.ts` `ROUTE_RULES`, so it is
 * served locally on the host and proxied from a member. It inherits the overlay
 * bearer + protocol-version gate; it is never reachable unauthenticated (§5.7).
 */
import { z } from 'zod';

import { capturePlan } from '../daemon/plan-capture.js';
import type { Logger } from '../daemon/logger.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { getLatestBatch } from '../db/queries/batches.js';
import { rowProjectIdFromRequestContext } from '../grove/request-context.js';
import type { RouteRequest, RouteResponse } from '../daemon/router.js';

/**
 * The plan companion-push body (capture-push §5.5). `content` is the WHOLE plan
 * file — a plan is small, so unlike the transcript channel there is no base64
 * offset delta. `machine_id` is the ORIGIN identity (tenancy+identity+residency
 * model); it also rides the request's `x-myco-machine-id` header, and the host
 * resolves the Grove from the tenancy headers, so it is carried for parity/logging
 * here rather than re-derived. `agent` is optional metadata (the host rediscovers
 * the adapter from the session row).
 */
const RoutedPlanBody = z.object({
  machine_id: z.string().min(1),
  session_id: z.string().min(1),
  plan_path: z.string().min(1),
  content: z.string(),
  agent: z.string().optional(),
});

/** The one capture side effect, injectable so handler tests exercise the wire
 *  contract without a bound Grove DB. Returns the persisted plan row id. */
export interface RoutedPlanCapture {
  sessionId: string;
  planPath: string;
  content: string;
  projectId: string | null;
}
export type RoutedPlanSink = (input: RoutedPlanCapture) => { id: string };

/**
 * Default sink: attribute the plan to the session's latest batch (resolved against
 * the ambient tenancy-bound Grove DB, exactly as the local live/backstop paths do)
 * and run the SAME `capturePlan`. Idempotent by logical key (session +
 * normalized plan_path). No `projectRoot` is passed — the plan_path is the
 * member-local path and `normalizePlanSourcePath` preserves an absolute path
 * unchanged, so the logical key stays STABLE across re-pushes (the idempotency
 * invariant).
 */
export function createDefaultRoutedPlanSink(logger?: Logger): RoutedPlanSink {
  return ({ sessionId, planPath, content, projectId }) => {
    const latestBatch = getLatestBatch(sessionId);
    const row = capturePlan({
      sourcePath: planPath,
      content,
      sessionId,
      projectId,
      promptBatchId: latestBatch?.id ?? null,
      logger,
    });
    return { id: row.id };
  };
}

/**
 * Build the `POST /routed-capture/plan` handler. Runs inside the daemon's
 * per-request `withDatabase` boundary (the tenancy headers the member sends bind
 * the host's Grove DB), so the default sink's `getLatestBatch` / `capturePlan`
 * hit the correct Grove. `sink` is injectable for tests; production uses the
 * DB-bound default.
 */
export function createRoutedPlanHandler(
  deps: { logger?: Logger; sink?: RoutedPlanSink } = {},
): (req: RouteRequest) => Promise<RouteResponse> {
  const sink = deps.sink ?? createDefaultRoutedPlanSink(deps.logger);
  return async (req: RouteRequest): Promise<RouteResponse> => {
    const parsed = RoutedPlanBody.safeParse(req.body);
    if (!parsed.success) {
      return { status: 400, body: { ok: false, error: 'invalid_body', detail: parsed.error.issues } };
    }
    const { session_id, plan_path, content } = parsed.data;
    // Tenancy comes from the request context (headers → bound Grove DB), never the
    // body's `machine_id` — the same claim the live `/events` path attributes rows
    // to. Absent (a mis-headered push) → null, and capturePlan writes to the
    // ambient scope; the header-bound DB is the authority either way.
    const projectId = rowProjectIdFromRequestContext(req.requestContext) ?? null;
    try {
      const { id } = sink({ sessionId: session_id, planPath: plan_path, content, projectId });
      return { status: 200, body: { ok: true, plan_id: id } };
    } catch (err) {
      deps.logger?.warn(LOG_KINDS.CAPTURE_PLAN, 'Failed to capture routed plan', {
        session_id,
        plan_path,
        error: (err as Error).message,
      });
      return { status: 500, body: { ok: false, error: 'capture_failed', message: (err as Error).message } };
    }
  };
}
