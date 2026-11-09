import type { MemberRole } from '../../auth/roles.js';
import type { Bound } from '../index.js';
import { read, write } from '../index.js';
import { enrollmentAuthorityPredicate, memberWritePredicate } from '../../auth/authorization.js';
import type { RelationalStore } from '../../core/adapters.js';
import { prepareBound } from '../kernel/statement.js';

export const memberIdentityInsert = write<[id: string, label: string, now: number, role: MemberRole]>({
  name: 'enrollment.memberIdentityInsert',
  sql: 'INSERT OR IGNORE INTO members(id,label,created_at,revoked_at,role) SELECT ?1,?2,?3,NULL,?4',
});
const firstOwnerIdentity = write<[id: string, label: string, now: number, role: MemberRole, receiptKey: string, receiptMember: string]>({
  name: 'enrollment.firstOwnerIdentity',
  sql: `INSERT OR IGNORE INTO members(id,label,created_at,revoked_at,role) SELECT ?1,?2,?3,NULL,?4
    WHERE (SELECT value FROM schema_meta WHERE key=?5)=?6`,
});
/** Records the member a first-owner setup claimed only while its receipt still names it. */
export const firstOwnerMemberWrite = (id: string, label: string, now: number, role: MemberRole, receiptKey: string): Bound<never, 'write'> =>
  firstOwnerIdentity.bind(id, label, now, role, receiptKey, id);

/** The fixed mint of an invitation or device approval: issuer and recipient authority are decided by this statement. */
export const enrollmentMint = write<[issuer: string | null, memberId: string | null, role: MemberRole, id: string, keyHash: string, now: number, expiresAt: number, projectId: string | null], { id: string }>({
  name: 'enrollment.mint',
  sql: `INSERT INTO enrollment_authorities(id,key_hash,created_at,expires_at,used_at,used_by_runtime,revoked_at,created_by_member,member_id,role,project_id)
    SELECT candidate.id,?5,?6,?7,NULL,NULL,NULL,candidate.created_by_member,candidate.member_id,candidate.role,?8
      FROM (SELECT ?1 AS created_by_member,?2 AS member_id,?3 AS role,?4 AS id) candidate
     WHERE ${enrollmentAuthorityPredicate('candidate')} RETURNING id`,
});

export const enrollmentTargetRead = read<[keyHash: string], { id: string; member_id: string | null; role: string; project_id: string | null }>({
  name: 'enrollment.target', sql: 'SELECT id,member_id,role,project_id FROM enrollment_authorities WHERE key_hash=?1',
});

/** Everything that names why a key refused, in one row: refusal precedence is decided from these. */
export const enrollmentExplanation = read<[keyHash: string], { used_at: number | null; revoked_at: number | null; expires_at: number; member_id: string | null; role: string; project_id: string | null; voided: number }>({
  name: 'enrollment.explain',
  sql: `SELECT a.used_at,a.revoked_at,a.expires_at,a.member_id,a.role,a.project_id,NOT (${enrollmentAuthorityPredicate('a')}) AS voided
    FROM enrollment_authorities a WHERE a.key_hash=?1`,
});

export const enrollmentRevoke = write<[now: number, by: string, id: string], { id: string }>({
  name: 'enrollment.revoke',
  sql: 'UPDATE enrollment_authorities SET revoked_at=?1,revoked_by=?2 WHERE id=?3 AND revoked_at IS NULL AND used_at IS NULL RETURNING id',
});

/** A machine's new name, while the actor is an admin or the member the machine belongs to. */
export const machineRename = write<[name: string, machineId: string, actor: string], { machine_id: string }>({
  name: 'enrollment.machineRename',
  sql: `UPDATE machine_claims SET label=?1 WHERE machine_id=?2 AND ${memberWritePredicate('?3', 'machine_claims.member_id')} RETURNING machine_id`,
});

/** The first-owner receipt, claimed only while no member exists and no other setup holds it. */
export const firstOwnerClaim = write<[key: string, member: string], { key: string }>({
  name: 'identity.firstOwnerClaim',
  sql: `INSERT INTO schema_meta(key,value) SELECT ?1,?2
    WHERE NOT EXISTS (SELECT 1 FROM members) AND NOT EXISTS (SELECT 1 FROM schema_meta WHERE key=?1) RETURNING key`,
});

/** One write outside any batch, for an operator's store that refuses write batches; it carries its own guard. */
export const writeAlone = <Row>(db: RelationalStore, bound: Bound<Row, 'write'>): Promise<Row | null> => prepareBound(db, bound).first<Row>();
