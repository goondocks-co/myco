import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import { contentAssertion } from '../core/registered-content.js';
import { PARSER_VERSION } from './parse.js';

export interface ViewWriteTarget {
  projectId: string;
  sessionId: string;
  instanceId: string;
  fence: number;
  liveInstance: string | null;
  leaseToken: string | null;
}

/** All instance mutations share the same version, destination and ownership admission. */
export function viewWritePredicate(target: ViewWriteTarget, now: number): { sql: string; params: unknown[] } {
  return {
    sql: `EXISTS(SELECT 1 FROM view_instances i JOIN session_views s
    ON s.project_id=i.project_id AND s.session_id=i.session_id WHERE i.project_id=? AND i.session_id=? AND i.instance_id=?
      AND i.parser_version=? AND s.fence=? AND s.live_instance IS ? AND (
        (? IS NULL AND s.live_instance=i.instance_id AND i.state='live') OR
        (? IS NOT NULL AND s.building_instance=i.instance_id AND i.state='building' AND i.lease_token=? AND i.lease_expires_at>?)))
    AND NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)`,
    params: [
      target.projectId,
      target.sessionId,
      target.instanceId,
      PARSER_VERSION,
      target.fence,
      target.liveInstance,
      target.leaseToken,
      target.leaseToken,
      target.leaseToken,
      now,
      target.projectId,
      target.sessionId,
    ],
  };
}

export function viewWriteGuard(db: RelationalStore, target: ViewWriteTarget, now: number): PreparedStatement[] {
  const guard = viewWritePredicate(target, now);
  return contentAssertion(db, guard.sql, guard.params);
}

export async function viewWriteOwned(db: RelationalStore, target: ViewWriteTarget, now: number): Promise<boolean> {
  const guard = viewWritePredicate(target, now);
  return (
    (await db
      .prepare(`SELECT 1 WHERE ${guard.sql}`)
      .bind(...guard.params)
      .first()) !== null
  );
}
