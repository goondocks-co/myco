import type { RelationalStore, PreparedStatement } from '../core/adapters.js';
import { contentAssertion } from '../core/registered-content.js';
import type { ViewWriteTarget } from './view-guard.js';
import { PARSER_VERSION } from './parse.js';
import { viewWriteGuard, viewWritePredicate } from './view-guard.js';

export const BUILD_SLOT_MS = 600_000;
export const VIEW_BUILD_LEASE_MS = 120_000;
export const VIEW_RECENT_MS = 86_400_000;
export const VIEW_FAILURE_BACKOFF = [3_600_000, 21_600_000, 86_400_000] as const;
export const SERIAL_VIEW_BUDGET = { slots: 1, calls: 500, wallMs: 15_000 } as const;
export const PARALLEL_VIEW_BUDGET = { slots: 2, calls: 2000, wallMs: 15_000 } as const;
/**
 * Sessions the cutover batch builds side by side in one wake while it holds a backlog, each under its own claim. They
 * share the job's admission; an invocation holds at most six outgoing connections, to the database and object store alike.
 */
export const CUTOVER_SESSIONS_IN_FLIGHT = 4;
export interface ViewProfile {
  slots: number;
  calls: number;
  wallMs: number;
}

/** Aging and due promotion complete before a ready head is selected. */
export async function selectViewBuild(db: RelationalStore, now: number) {
  const pageSize = 64;
  for (;;) {
    const due = (
      await db
        .prepare(
          `SELECT project_id,session_id,instance_id FROM view_build_work INDEXED BY idx_view_due
      WHERE state='waiting' AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 64`,
        )
        .bind(now)
        .all<{ project_id: string; session_id: string; instance_id: string }>()
    ).results;
    if (!due.length) break;
    const input = JSON.stringify(due);
    await db.batch([
      db
        .prepare(
          `UPDATE view_instances SET state='building',failure=NULL WHERE state='failed' AND EXISTS(
        SELECT 1 FROM json_each(?) j WHERE view_instances.project_id=json_extract(j.value,'$.project_id')
        AND view_instances.instance_id=json_extract(j.value,'$.instance_id'))`,
        )
        .bind(input),
      db
        .prepare(
          `UPDATE view_checkpoints SET parse_error=NULL,parse_failed_at=NULL,parse_awaited_size=NULL WHERE EXISTS(
        SELECT 1 FROM json_each(?) j WHERE view_checkpoints.project_id=json_extract(j.value,'$.project_id')
        AND view_checkpoints.instance_id=json_extract(j.value,'$.instance_id'))`,
        )
        .bind(input),
      db
        .prepare(
          `UPDATE session_views SET rebuild_state='building' WHERE EXISTS(SELECT 1 FROM json_each(?) j
        WHERE session_views.project_id=json_extract(j.value,'$.project_id') AND session_views.session_id=json_extract(j.value,'$.session_id'))`,
        )
        .bind(input),
      db
        .prepare(
          `UPDATE view_build_work SET state='ready',next_attempt_at=NULL WHERE state='waiting' AND next_attempt_at<=?
        AND EXISTS(SELECT 1 FROM json_each(?) j WHERE view_build_work.project_id=json_extract(j.value,'$.project_id')
          AND view_build_work.session_id=json_extract(j.value,'$.session_id'))`,
        )
        .bind(now, input),
    ]);
    if (due.length < pageSize) break;
  }
  for (;;) {
    const aged = await db
      .prepare(
        `UPDATE view_build_work SET tier=CASE WHEN EXISTS(SELECT 1 FROM session_views s
      WHERE s.project_id=view_build_work.project_id AND s.session_id=view_build_work.session_id AND s.legacy='converting') THEN 1 ELSE 2 END
      WHERE (project_id,session_id) IN(SELECT project_id,session_id FROM view_build_work INDEXED BY idx_view_aging
        WHERE state='ready' AND tier=0 AND recent_until<=? ORDER BY recent_until LIMIT 64) RETURNING session_id`,
      )
      .bind(now)
      .all();
    if (aged.results.length < pageSize) break;
  }
  await db
    .prepare(
      `UPDATE view_build_work SET state='ready' WHERE (project_id,session_id) IN(
    SELECT project_id,session_id FROM view_build_work INDEXED BY idx_view_yielded WHERE state='yielded'
      ORDER BY last_service_at,project_id,session_id LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM view_build_work w INDEXED BY idx_view_ready WHERE w.state='ready'
      AND NOT EXISTS(SELECT 1 FROM view_instances i WHERE i.project_id=w.project_id AND i.instance_id=w.instance_id
        AND i.lease_token IS NOT NULL AND i.lease_expires_at>?))`,
    )
    .bind(now)
    .run();
  return db
    .prepare(
      `SELECT project_id,session_id,instance_id FROM view_build_work INDEXED BY idx_view_ready
    WHERE state='ready' AND NOT EXISTS(SELECT 1 FROM view_instances i WHERE i.project_id=view_build_work.project_id
      AND i.instance_id=view_build_work.instance_id AND i.lease_token IS NOT NULL AND i.lease_expires_at>?) ORDER BY tier,last_service_at,session_created_at DESC,project_id,session_id,instance_id LIMIT 1`,
    )
    .bind(now)
    .first<{ project_id: string; session_id: string; instance_id: string }>();
}

export async function claimViewBuild(
  db: RelationalStore,
  project: string,
  session: string,
  profile: ViewProfile,
  now: number,
): Promise<ViewWriteTarget | null> {
  const token = crypto.randomUUID(),
    cap = profile.slots;
  const state = await db
    .prepare(`SELECT live_instance,fence,building_instance FROM session_views WHERE project_id=? AND session_id=?`)
    .bind(project, session)
    .first<{ live_instance: string | null; fence: number; building_instance: string | null }>();
  if (!state?.building_instance) return null;
  const result = await db
    .prepare(
      `UPDATE view_instances SET lease_token=?,lease_expires_at=? WHERE project_id=? AND session_id=? AND instance_id=?
    AND parser_version=? AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.project_id=view_instances.project_id AND t.session_id=view_instances.session_id)
    AND EXISTS(SELECT 1 FROM session_views s WHERE s.project_id=view_instances.project_id AND s.session_id=view_instances.session_id
      AND s.building_instance=view_instances.instance_id AND s.fence=? AND s.live_instance IS ?)
    AND state='building' AND (lease_token IS NULL OR lease_expires_at<=?) AND (
      SELECT COUNT(*) FROM view_instances INDEXED BY idx_view_active_leases WHERE state='building' AND lease_expires_at>?)<?
    RETURNING instance_id`,
    )
    .bind(
      token,
      now + VIEW_BUILD_LEASE_MS,
      project,
      session,
      state.building_instance,
      PARSER_VERSION,
      state.fence,
      state.live_instance,
      now,
      now,
      cap,
    )
    .first();
  return result
    ? {
        projectId: project,
        sessionId: session,
        instanceId: state.building_instance,
        liveInstance: state.live_instance,
        fence: state.fence,
        leaseToken: token,
      }
    : null;
}

export async function yieldViewBuild(
  db: RelationalStore,
  target: ViewWriteTarget,
  serviceMs: number,
  now: number,
): Promise<boolean> {
  if (target.leaseToken === null) throw new Error('view_build_lease_required');
  if (!Number.isFinite(serviceMs) || serviceMs < 0) throw new Error('view_service_invalid');
  const guards = viewWriteGuard(db, target, now);
  const yielded = `EXISTS(SELECT 1 FROM view_build_work WHERE project_id=? AND session_id=? AND state='yielded')`;
  const result = await db.batch([
    ...guards,
    db
      .prepare(
        `WITH decision AS MATERIALIZED(
      SELECT service_ms+? service,service_ms+?>=? AND EXISTS(SELECT 1 FROM view_build_work peer
        WHERE peer.state IN ('ready','yielded') AND NOT(peer.project_id=? AND peer.session_id=?)) should_yield
      FROM view_build_work WHERE project_id=? AND session_id=?)
    UPDATE view_build_work SET state=CASE WHEN (SELECT should_yield FROM decision) THEN 'yielded' ELSE state END,
      service_ms=CASE WHEN (SELECT should_yield FROM decision) THEN 0 ELSE (SELECT service FROM decision) END,last_service_at=?
      WHERE project_id=? AND session_id=? RETURNING state`,
      )
      .bind(
        serviceMs,
        serviceMs,
        BUILD_SLOT_MS,
        target.projectId,
        target.sessionId,
        target.projectId,
        target.sessionId,
        now,
        target.projectId,
        target.sessionId,
      ),
    db
      .prepare(
        `UPDATE view_instances SET lease_token=CASE WHEN ${yielded} THEN NULL ELSE ? END,
      lease_expires_at=CASE WHEN ${yielded} THEN NULL ELSE ? END WHERE project_id=? AND instance_id=?`,
      )
      .bind(
        target.projectId,
        target.sessionId,
        target.leaseToken,
        target.projectId,
        target.sessionId,
        now + VIEW_BUILD_LEASE_MS,
        target.projectId,
        target.instanceId,
      ),
  ]);
  const state = result[guards.length]!.results[0];
  return typeof state === 'object' && state !== null && 'state' in state && state.state === 'yielded';
}

/** Only the current unexpired lease holder can release its build slot. */
export async function releaseViewBuild(db: RelationalStore, target: ViewWriteTarget, now: number): Promise<boolean> {
  const guard = viewWritePredicate(target, now);
  const result = await db
    .prepare(
      `UPDATE view_instances SET lease_token=NULL,lease_expires_at=NULL
   WHERE project_id=? AND instance_id=? AND lease_token=? AND (${guard.sql}) RETURNING instance_id`,
    )
    .bind(target.projectId, target.instanceId, target.leaseToken, ...guard.params)
    .first();
  return result !== null;
}

/** Capture can re-enable a missing-object build without changing its checkpoints. */
export function resetViewFailure(
  db: RelationalStore,
  project: string,
  session: string,
  when?: { sql: string; params: unknown[] },
): PreparedStatement[] {
  const condition = when === undefined ? '' : ` AND (${when.sql})`,
    params = when?.params ?? [];
  return [
    db
      .prepare(
        `UPDATE view_instances SET state='building',failure=NULL,lease_token=NULL,lease_expires_at=NULL
      WHERE project_id=? AND session_id=? AND state='failed' AND instance_id=(SELECT building_instance FROM session_views WHERE project_id=? AND session_id=?)${condition}`,
      )
      .bind(project, session, project, session, ...params),
    db
      .prepare(
        `UPDATE view_checkpoints SET parse_error=NULL,parse_failed_at=NULL,parse_awaited_size=NULL
      WHERE project_id=? AND session_id=? AND instance_id=(SELECT building_instance FROM session_views WHERE project_id=? AND session_id=?)${condition}`,
      )
      .bind(project, session, project, session, ...params),
    db
      .prepare(
        `UPDATE view_build_work SET state='ready',next_attempt_at=NULL WHERE project_id=? AND session_id=?${condition}`,
      )
      .bind(project, session, ...params),
    db
      .prepare(
        `UPDATE session_views SET next_attempt_at=NULL,unrebuildable_reason=NULL,rebuild_state='building' WHERE project_id=? AND session_id=?${condition}`,
      )
      .bind(project, session, ...params),
  ];
}

/** Admitted capture refreshes queue recency and re-enables a missing-object build. */
export function noteViewCaptureStatements(
  db: RelationalStore,
  project: string,
  session: string,
  now: number,
  admission: { sql: string; params: unknown[] },
): PreparedStatement[] {
  const missing = {
    sql: `(${admission.sql}) AND EXISTS(SELECT 1 FROM session_views WHERE project_id=? AND session_id=? AND unrebuildable_reason='blob_absent')`,
    params: [...admission.params, project, session],
  };
  return [
    ...resetViewFailure(db, project, session, missing),
    db
      .prepare(
        `UPDATE view_build_work SET tier=0,recent_until=MAX(recent_until,?) WHERE project_id=? AND session_id=? AND (${admission.sql})`,
      )
      .bind(now + VIEW_RECENT_MS, project, session, ...admission.params),
  ];
}

export async function failViewBuild(
  db: RelationalStore,
  target: ViewWriteTarget,
  failure: string,
  now: number,
): Promise<void> {
  const current = await db
    .prepare(`SELECT failures FROM session_views WHERE project_id=? AND session_id=?`)
    .bind(target.projectId, target.sessionId)
    .first<{ failures: number }>();
  const next = now + VIEW_FAILURE_BACKOFF[Math.min(current?.failures ?? 0, VIEW_FAILURE_BACKOFF.length - 1)]!;
  await db.batch([
    ...viewWriteGuard(db, target, now),
    ...contentAssertion(db, '? IS NOT NULL', [target.leaseToken]),
    db
      .prepare(
        `UPDATE session_views SET failures=failures+1,last_failure=?,next_attempt_at=?,unrebuildable_reason=?,rebuild_state='failed' WHERE project_id=? AND session_id=?`,
      )
      .bind(failure, next, failure === 'blob_absent' ? failure : null, target.projectId, target.sessionId),
    db
      .prepare(
        `UPDATE view_instances SET state='failed',failure=?,lease_token=NULL,lease_expires_at=NULL WHERE project_id=? AND instance_id=?`,
      )
      .bind(failure, target.projectId, target.instanceId),
    db
      .prepare(`UPDATE view_build_work SET state=?,next_attempt_at=? WHERE project_id=? AND session_id=?`)
      .bind(failure === 'blob_absent' ? 'blocked' : 'waiting', next, target.projectId, target.sessionId),
  ]);
}
