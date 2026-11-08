import { MEMBER_ROLES_SQL } from '../../auth/roles.js';
import { enrollmentAuthorityPredicate } from '../../auth/authorization.js';
import { memberLive } from '../liveness.js';

/** A SQL condition and the values it binds, conjoined into a statement's WHERE. */
export interface Fragment {
  sql: string;
  params: unknown[];
}

/** Admission predicates for spending an invitation, optionally bound to its resolved member. */
export function enrollmentAdmission(
  keyHash: string, nowMs: number, opts: { forProject?: boolean; memberId?: string } = {},
): Fragment {
  const target = opts.memberId === undefined ? null : opts.memberId;
  return {
    sql: `key_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
            AND role IN (${MEMBER_ROLES_SQL})
            ${opts.forProject === true ? 'AND project_id IS NOT NULL' : ''}
            ${target === null ? '' : 'AND COALESCE(member_id, ?) = ?'}
            AND (member_id IS NULL OR ${memberLive('enrollment_authorities.member_id')})
            AND (created_by_member IS NULL OR ${memberLive('enrollment_authorities.created_by_member')})
            AND ${enrollmentAuthorityPredicate('enrollment_authorities')}`,
    params: target === null ? [keyHash, nowMs] : [keyHash, nowMs, target, target],
  };
}

/** True while `machineId` is unheld or held by `memberId`. Holds across an insert of that member's own claim. */
export function machineClaimable(machineId: string, memberId: string): Fragment {
  return {
    sql: `NOT EXISTS (SELECT 1 FROM machine_claims WHERE machine_id = ? AND member_id <> ?)`,
    params: [machineId, memberId],
  };
}

/** True while the authority this key names meets every admission. */
export function authorityAdmitted(admission: Fragment): Fragment {
  return {
    sql: `EXISTS (SELECT 1 FROM enrollment_authorities WHERE ${admission.sql})`,
    params: [...admission.params],
  };
}

/** Conjoin fragments into one WHERE body. */
export const allOf = (...fragments: readonly Fragment[]): Fragment => ({
  sql: fragments.map((f) => `(${f.sql})`).join(' AND '),
  params: fragments.flatMap((f) => f.params),
});

/** The fixed admission policy shared by a join's identity and credential. */
export const JOIN_ADMISSION_SQL = [false, true].map(forProject => allOf(
  authorityAdmitted(enrollmentAdmission('', 0, { forProject, memberId: '' })),
  machineClaimable('', ''),
  {
    sql: `NOT EXISTS (SELECT 1 FROM device_requests WHERE device_hash = ? AND (machine_id <> ? OR decision IS NOT 'approved'))`,
    params: [],
  },
).sql);
