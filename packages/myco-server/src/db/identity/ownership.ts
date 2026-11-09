import type { DeploymentOwnershipPreview } from '@goondocks/myco-shared/raw-claims';
import { isSystemMember, personMemberSql } from '../../auth/member-kind.js';
import { memberWriteOutcome } from '../../auth/member-write-refusal.js';
import type { MemberRole } from '../../auth/roles.js';
import type { RelationalStore } from '../../core/adapters.js';
import { FOREIGN_LINEAGE_REVOKER } from '../../constants.js';
import { assertion, commitNamed, first, read, readSet, refused, refusalCode, write } from '../index.js';
import { deploymentOwnerSql, linkedHumanAdminSql, removableAdministratorSql } from './ownership-policy.js';

export class OwnershipRefusal extends Error {
  constructor(readonly code: 'not_owner' | 'owner_pending' | 'invalid_owner' | 'invalid_member' | 'active_owner' | 'last_admin' | 'revision_conflict' | 'not_admin' | 'owner_already_recorded' | 'backfill_pending') { super(code); }
}

/** The named operation's state no longer holds at its commit; nothing in the batch applied. */
const OWNERSHIP_STATE_CHANGED = refusalCode('ownership_state_changed');
const conflictIfStateChanged = (error: unknown): never => {
  throw refused(error, OWNERSHIP_STATE_CHANGED) ? new OwnershipRefusal('revision_conflict') : error;
};

const ownershipAdmitted = read<[member: string], { admitted: number }>({
  name: 'ownership.isOwner', sql: `SELECT ${deploymentOwnerSql('?1')} AS admitted`,
});
export async function isDeploymentOwner(db: RelationalStore, memberId: string): Promise<boolean> {
  return (await first(db, ownershipAdmitted.bind(memberId)))?.admitted === 1;
}

const ownerRecord = read<[], { member_id: string | null; revision: number }>({
  name: 'ownership.record', sql: 'SELECT member_id,revision FROM deployment_ownership WHERE id=1',
});
const ownerCandidates = read<[], DeploymentOwnershipPreview['candidates'][number]>({
  name: 'ownership.candidates',
  sql: `SELECT m.id AS memberId,m.label,m.role,CAST(m.role_revision AS TEXT) AS roleRevision
    FROM members m WHERE ${linkedHumanAdminSql('m')} ORDER BY m.id`,
});
export async function ownershipPreview(db: RelationalStore): Promise<DeploymentOwnershipPreview> {
  const [records, candidates] = await readSet(db, ownerRecord.bind(), ownerCandidates.bind());
  const row = records[0];
  if (row === undefined) throw new Error('Deployment ownership record is missing');
  return { ownerMemberId: row.member_id, revision: String(row.revision), candidates,
    proposalMemberId: row.member_id === null && candidates.length === 1 ? candidates[0]!.memberId : null };
}

async function requireOwner(db: RelationalStore, actor: string): Promise<void> {
  if (await isDeploymentOwner(db, actor)) return;
  throw new OwnershipRefusal((await ownershipPreview(db)).ownerMemberId === null ? 'owner_pending' : 'not_owner');
}

const linkedHumanAdmin = read<[member: string], { one: number }>({
  name: 'ownership.linkedHumanAdmin', sql: `SELECT 1 AS one FROM members m WHERE m.id=?1 AND ${linkedHumanAdminSql('m')}`,
});

const transferAdmitted = assertion<[actor: string, revision: string, candidate: string]>({
  name: 'ownership.transferAdmitted', refusal: OWNERSHIP_STATE_CHANGED,
  when: `EXISTS (SELECT 1 FROM deployment_ownership WHERE id=1 AND member_id=?1 AND revision=?2)
    AND ${deploymentOwnerSql('?1')} AND EXISTS (SELECT 1 FROM members m WHERE m.id=?3 AND ${linkedHumanAdminSql('m')})`,
});
const transfer = write<[candidate: string, actor: string], { revision: number }>({
  name: 'ownership.transfer',
  sql: `UPDATE deployment_ownership SET member_id=?1,revision=revision+1,bootstrap_mode='selection' WHERE id=1 AND member_id=?2 RETURNING revision`,
});
const transferAudit = write<[actor: string, now: number, previous: string, candidate: string]>({
  name: 'ownership.transferAudit',
  sql: `INSERT INTO deployment_ownership_audit(revision,member_id,actor_id,created_at,previous_member_id,operation)
    SELECT revision,member_id,?1,?2,?3,'transfer' FROM deployment_ownership WHERE id=1 AND member_id=?4`,
});

/** Transfer moves a non-null singleton under its revision and rechecks both identities inside the atomic batch. */
export async function transferOwnership(db: RelationalStore, actor: string, candidate: string, revision: string, now: number): Promise<DeploymentOwnershipPreview> {
  await requireOwner(db, actor);
  if (actor === candidate) throw new OwnershipRefusal('invalid_owner');
  if (await first(db, linkedHumanAdmin.bind(candidate)) === null) throw new OwnershipRefusal('invalid_owner');
  await commitNamed(db, {
    admitted: transferAdmitted.bind(actor, revision, candidate),
    transfer: transfer.bind(candidate, actor),
    audit: transferAudit.bind(actor, now, actor, candidate),
  }).catch(conflictIfStateChanged);
  return ownershipPreview(db);
}

interface MemberRoleOutcome { memberId: string; role: MemberRole; roleRevision: string }

const memberRoleRow = read<[member: string], { role: MemberRole; role_revision: number; revoked_at: number | null; revoked_by: string | null }>({
  name: 'ownership.memberRole', sql: 'SELECT role,role_revision,revoked_at,revoked_by FROM members WHERE id=?1',
});
const roleChangeAdmitted = assertion<[member: string, held: number, foreign: string, revision: string, previous: string, actor: string, role: string]>({
  name: 'ownership.roleChangeAdmitted', refusal: OWNERSHIP_STATE_CHANGED,
  when: `EXISTS (SELECT 1 FROM members WHERE id=?1 AND ${personMemberSql('id')} AND (revoked_at IS NULL OR (?2=1 AND revoked_by=?3))
    AND role_revision=?4 AND role=?5 AND ${deploymentOwnerSql('?6')} AND (?7='admin' OR (${removableAdministratorSql('members')})))`,
});
const roleChange = write<[role: string, member: string], { role: MemberRole; roleRevision: string }>({
  name: 'ownership.roleChange',
  sql: `UPDATE members SET role=?1,role_revision=role_revision+1,revoked_at=NULL,revoked_by=NULL WHERE id=?2
    RETURNING role,CAST(role_revision AS TEXT) AS roleRevision`,
});
const roleChangeAudit = write<[previous: string, actor: string, now: number, member: string]>({
  name: 'ownership.roleChangeAudit',
  sql: `INSERT INTO member_role_audit(member_id,revision,previous_role,role,actor_id,created_at)
    SELECT id,role_revision,?1,role,?2,?3 FROM members WHERE id=?4`,
});

/**
 * Role changes and their immutable receipts share one batch, with authorization and recovery checked at the write.
 * A member a restore from another Deployment held (`FOREIGN_LINEAGE_REVOKER`) is re-admitted by the role the owner
 * assigns it, the same role included; the receipt records that admission. Every other revoked member stays revoked.
 */
export async function changeMemberRole(db: RelationalStore, actor: string, memberId: string, role: MemberRole, revision: string, now: number): Promise<MemberRoleOutcome> {
  await requireOwner(db, actor);
  const before = await first(db, memberRoleRow.bind(memberId));
  const held = before !== null && before.revoked_at !== null && before.revoked_by === FOREIGN_LINEAGE_REVOKER;
  if (before === null || (before.revoked_at !== null && !held) || isSystemMember(memberId)) throw new OwnershipRefusal('invalid_member');
  if (String(before.role_revision) !== revision) throw new OwnershipRefusal('revision_conflict');
  if (before.role === role && !held) return { memberId, role, roleRevision: revision };
  if (memberId === actor && role === 'member') throw new OwnershipRefusal('active_owner');
  const { change } = await commitNamed(db, {
    admitted: roleChangeAdmitted.bind(memberId, held ? 1 : 0, FOREIGN_LINEAGE_REVOKER, revision, before.role, actor, role),
    change: roleChange.bind(role, memberId),
    audit: roleChangeAudit.bind(before.role, actor, now, memberId),
  }).catch(conflictIfStateChanged);
  const current = change.results[0];
  if (current === undefined) throw new Error('Changed member is missing');
  return { memberId, ...current };
}

const bootstrapActor = read<[actor: string], { admitted: number }>({
  name: 'ownership.bootstrapActor', sql: "SELECT 1 AS admitted FROM members WHERE id=?1 AND role='admin' AND revoked_at IS NULL",
});
const bootstrapAdmitted = assertion<[revision: string, actor: string, candidate: string]>({
  name: 'ownership.bootstrapAdmitted', refusal: OWNERSHIP_STATE_CHANGED,
  when: `EXISTS (SELECT 1 FROM deployment_ownership WHERE id=1 AND member_id IS NULL AND revision=?1)
    AND EXISTS (SELECT 1 FROM members WHERE id=?2 AND role='admin' AND revoked_at IS NULL)
    AND EXISTS (SELECT 1 FROM members m WHERE m.id=?3 AND ${linkedHumanAdminSql('m')})`,
});
const bootstrap = write<[candidate: string]>({
  name: 'ownership.bootstrap', sql: 'UPDATE deployment_ownership SET member_id=?1,revision=revision+1 WHERE id=1 AND member_id IS NULL',
});
const bootstrapAudit = write<[actor: string, now: number, candidate: string]>({
  name: 'ownership.bootstrapAudit',
  sql: 'INSERT INTO deployment_ownership_audit(revision,member_id,actor_id,created_at) SELECT revision,member_id,?1,?2 FROM deployment_ownership WHERE id=1 AND member_id=?3',
});

/** Initial owner selection is explicit; the guarded write cannot replace an established owner. */
export async function bootstrapOwnership(db: RelationalStore, actor: string, candidate: string, revision: string, now: number): Promise<DeploymentOwnershipPreview> {
  if (await first(db, bootstrapActor.bind(actor)) === null) throw new OwnershipRefusal('not_admin');
  const current = await ownershipPreview(db);
  if (current.ownerMemberId === candidate) return current;
  if (current.ownerMemberId !== null) throw new OwnershipRefusal('owner_already_recorded');
  if (current.revision !== revision) throw new OwnershipRefusal('revision_conflict');
  if (await first(db, linkedHumanAdmin.bind(candidate)) === null) throw new OwnershipRefusal('invalid_owner');
  const outcome = await memberWriteOutcome(() => commitNamed(db, {
    admitted: bootstrapAdmitted.bind(revision, actor, candidate),
    bootstrap: bootstrap.bind(candidate),
    audit: bootstrapAudit.bind(actor, now, candidate),
  })).catch(conflictIfStateChanged);
  if (!outcome.admitted) throw new OwnershipRefusal('revision_conflict');
  return ownershipPreview(db);
}

const RESTORABLE_OWNER = `EXISTS (SELECT 1 FROM deployment_ownership WHERE id=1 AND member_id IS NULL)
  AND EXISTS (SELECT 1 FROM members WHERE id=?1 AND revoked_at IS NULL AND role='admin' AND github_id IS NOT NULL)`;
const restoredOwnerAudit = write<[member: string, revision: number, actor: string, createdAt: number, previous: string | null, operation: string]>({
  name: 'ownership.restoreAudit',
  sql: `INSERT INTO deployment_ownership_audit(revision,member_id,actor_id,created_at,previous_member_id,operation)
    SELECT ?2,?1,?3,?4,?5,?6 WHERE ${RESTORABLE_OWNER}`,
});
const restoredOwner = write<[member: string, revision: number]>({
  name: 'ownership.restore',
  sql: `UPDATE deployment_ownership SET member_id=?1,revision=?2,bootstrap_mode='selection' WHERE id=1 AND ${RESTORABLE_OWNER}`,
});

/** Recovery can fill an unselected owner; additive restore preserves an established destination owner. */
export async function restoreOwnership(db: RelationalStore, row: { member_id: string; revision: number }, audit: { actor_id: string; created_at: number; previous_member_id?: string | null; operation?: string }): Promise<void> {
  await commitNamed(db, {
    audit: restoredOwnerAudit.bind(row.member_id, row.revision, audit.actor_id, audit.created_at, audit.previous_member_id ?? null, audit.operation ?? 'bootstrap'),
    owner: restoredOwner.bind(row.member_id, row.revision),
  });
  const restored = await ownershipPreview(db);
  if (restored.ownerMemberId === null) throw new Error('Restored owner is not a live linked administrator');
}
