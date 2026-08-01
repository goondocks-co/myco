/**
 * Team Host — the host RECEIVE side of a with-history residency attach (Phase F T2).
 *
 * When a project attaches to a Team Host WITH its local history, the member drains
 * that project's rows to the host, one allow-listed table per request
 * (`host/residency-drain.ts` → `POST /routed-capture/residency-rows`). This module
 * is the thin HTTP/validation/transaction shell around the shared apply engine
 * (`db/queries/residency-apply.ts`, run in BOTH transition directions): it validates
 * the body, applies one table's rows to the served Grove DB inside ONE transaction,
 * and — on the batch that carries it — adopts the member's real project name onto the
 * hosted registry row.
 *
 * Every batch commits whole or rolls back whole, and any failure answers non-200 so
 * the member re-sends the identical batch next tick (at-least-once with host-side
 * idempotency). A child row that arrives before its parent TABLE rolls back to a
 * retryable 409 and self-heals when the parent lands — the same path an orphaned
 * `entity_mentions` row takes, so nothing is ever acked-and-dropped.
 */
import { z } from 'zod';

import { LOG_KINDS } from '../constants/log-kinds.js';
import { getDatabase } from '../db/client.js';
import { RESIDENCY_ALLOWED_TABLES, ResidencyTenancyError, applyResidencyRows } from '../db/queries/residency-apply.js';
import { shouldLogOncePerInterval } from '../daemon/log-throttle.js';
import type { Logger } from '../daemon/logger.js';
import type { RouteRequest, RouteResponse } from '../daemon/router.js';
import { rowProjectIdFromRequestContext } from '../grove/request-context.js';
import { adoptHostedProjectName } from './hosted-projects.js';

/** Throttle window for repeated host-side ingest warnings (unknown table, apply
 *  failure, adoption failure) — a rejecting member re-sends every tick. */
const INGEST_LOG_INTERVAL_MS = 60_000;

/** The residency-rows push body (matches the frozen T1 wire contract). */
const ResidencyRowsBody = z.object({
  table: z.string().min(1),
  rows: z.array(z.record(z.string(), z.unknown())),
  adoption: z.object({ project_name: z.string() }).optional(),
});

/**
 * Build the `POST /routed-capture/residency-rows` handler. Runs inside the
 * daemon's per-request `withDatabase` boundary (the member's tenancy headers bind
 * the served Grove DB), so `getDatabase()` resolves to the correct Grove. `mycoHome`
 * is injectable for tests; production uses the resolved home for the adoption write.
 */
export function createRoutedResidencyHandler(
  deps: { logger?: Logger; mycoHome?: string } = {},
): (req: RouteRequest) => Promise<RouteResponse> {
  return async (req: RouteRequest): Promise<RouteResponse> => {
    const parsed = ResidencyRowsBody.safeParse(req.body);
    if (!parsed.success) {
      return { status: 400, body: { ok: false, error: 'invalid_body', detail: parsed.error.issues } };
    }
    const { table, rows, adoption } = parsed.data;

    if (!RESIDENCY_ALLOWED_TABLES.has(table)) {
      // A permanently-invalid table means member/host version skew the protocol
      // gate should have caught; log it (throttled — the member retries every
      // tick) and answer a coded 400.
      if (shouldLogOncePerInterval(`residency.unknown_table:${table}`, INGEST_LOG_INTERVAL_MS)) {
        deps.logger?.warn(LOG_KINDS.RESIDENCY_ATTACH_PUSH, 'Residency batch named an unknown table', { table });
      }
      return { status: 400, body: { ok: false, error: 'unknown_table', table } };
    }

    const groveId = req.requestContext?.groveId ?? null;
    const projectId = rowProjectIdFromRequestContext(req.requestContext) ?? null;
    if (!projectId) {
      // The apply engine's tenancy admission is scoped to the request's
      // project; a request that resolves no project has nothing to validate
      // against and is refused outright — never applied unscoped.
      return { status: 400, body: { ok: false, error: 'missing_project_context' } };
    }

    let applied: number;
    try {
      const db = getDatabase();
      const result = db.transaction(() =>
        applyResidencyRows(db, table, rows, { expectedProjectId: projectId }, { logger: deps.logger }),
      )();
      applied = result.applied;
    } catch (err) {
      if (err instanceof ResidencyTenancyError) {
        // The batch names rows outside the request's own project. Retrying the
        // identical batch can never succeed, so this is a REFUSAL (the member
        // logs it and its transition stalls visibly), not a retryable miss —
        // answering retryable would hide a scoping bug behind an infinite
        // retry loop.
        if (shouldLogOncePerInterval(`residency.tenancy_rejected:${table}`, INGEST_LOG_INTERVAL_MS)) {
          deps.logger?.warn(LOG_KINDS.RESIDENCY_ATTACH_PUSH, 'Residency batch rejected — rows outside the request project', {
            table,
            project_id: projectId,
            error: err.message,
          });
        }
        return { status: 403, body: { ok: false, error: 'tenancy_rejected', retryable: false, message: err.message } };
      }
      // Rolled back whole. A child arriving before its parent table is the
      // designed self-healing case: answer retryable so the member re-sends the
      // identical batch next tick, after the parent lands.
      if (shouldLogOncePerInterval(`residency.apply_failed:${table}`, INGEST_LOG_INTERVAL_MS)) {
        deps.logger?.warn(LOG_KINDS.RESIDENCY_ATTACH_PUSH, 'Residency batch apply failed — member will retry', {
          table,
          error: (err as Error).message,
        });
      }
      return { status: 409, body: { ok: false, error: 'apply_failed', retryable: true, message: (err as Error).message } };
    }

    // Adoption rides the first batch; best-effort so a cosmetic registry write
    // never blocks the durable rows' ack. Idempotent (no-op once the placeholder
    // name is upgraded), so a replayed first batch does not re-adopt.
    if (adoption?.project_name && groveId && projectId) {
      try {
        adoptHostedProjectName(groveId, projectId, adoption.project_name, deps.mycoHome);
      } catch (err) {
        if (shouldLogOncePerInterval(`residency.adopt_failed:${projectId}`, INGEST_LOG_INTERVAL_MS)) {
          deps.logger?.warn(LOG_KINDS.RESIDENCY_ATTACH_PUSH, 'Hosted project name adoption failed', {
            project_id: projectId,
            error: (err as Error).message,
          });
        }
      }
    }

    return { status: 200, body: { ok: true, applied } };
  };
}
