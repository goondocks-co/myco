import type { DeploymentOwnershipPreview } from '@goondocks/myco-shared/raw-claims';
import type { RelationalStore, PreparedStatement } from './adapters.js';
import { HARNESS_MEMBER_ID } from '../constants.js';
import type { MemberRole } from '../auth/roles.js';
import { memberWriteOutcome } from '../auth/member-write-refusal.js';

export class OwnershipRefusal extends Error {
  constructor(readonly code: 'not_owner' | 'owner_pending' | 'invalid_owner' | 'invalid_member' | 'active_owner' | 'last_admin' | 'revision_conflict' | 'not_admin' | 'owner_already_recorded' | 'backfill_pending') { super(code); }
}

export const deploymentOwnerSql = (member: string): string => `EXISTS (SELECT 1 FROM deployment_ownership o JOIN members m ON m.id = o.member_id
  WHERE o.id = 1 AND o.member_id = ${member} AND m.revoked_at IS NULL AND m.role = 'admin')`;

export const linkedHumanAdminSql = (alias: string): string => `${alias}.revoked_at IS NULL AND ${alias}.role = 'admin'
  AND ${alias}.github_id IS NOT NULL AND ${alias}.id <> '${HARNESS_MEMBER_ID}'`;

/** Protected membership mutations retain the active owner and another recoverable administrator. */
export const removableAdministratorSql = (alias: string): string => `NOT EXISTS (SELECT 1 FROM deployment_ownership o WHERE o.id = 1 AND o.member_id = ${alias}.id)
  AND (NOT (${linkedHumanAdminSql(alias)}) OR EXISTS (SELECT 1 FROM members other WHERE other.id <> ${alias}.id AND ${linkedHumanAdminSql('other')}))`;

export async function isDeploymentOwner(db: RelationalStore, memberId: string): Promise<boolean> {
  return (await db.prepare(`SELECT ${deploymentOwnerSql('?')} AS admitted`).bind(memberId).first<{ admitted: number }>())?.admitted === 1;
}

export async function ownershipPreview(db: RelationalStore): Promise<DeploymentOwnershipPreview> {
  const row = await db.prepare('SELECT member_id, revision FROM deployment_ownership WHERE id = 1').first<{ member_id: string | null; revision: number }>();
  if (row === null) throw new Error('Deployment ownership record is missing');
  const candidates = (await db.prepare(`SELECT m.id AS memberId, m.label, m.role, CAST(m.role_revision AS TEXT) AS roleRevision
    FROM members m WHERE ${linkedHumanAdminSql('m')} ORDER BY m.id`).all<DeploymentOwnershipPreview['candidates'][number]>()).results;
  return { ownerMemberId: row.member_id, revision: String(row.revision), candidates,
    proposalMemberId: row.member_id === null && candidates.length === 1 ? candidates[0]!.memberId : null };
}

/** The receipt is conditional on this operation's resulting singleton revision. */
function ownershipAuditStatement(db: RelationalStore, actor: string, candidate: string, revision: string, now: number, previous: string | null = null): PreparedStatement {
  return db.prepare(`INSERT INTO deployment_ownership_audit (revision,member_id,actor_id,created_at,previous_member_id,operation)
    SELECT revision, member_id, ?, ?, ?, ? FROM deployment_ownership WHERE id = 1 AND member_id = ? AND revision = ?
      AND changes() = 1`).bind(actor, now, previous, previous === null ? 'bootstrap' : 'transfer', candidate, Number(revision) + 1);
}

async function requireOwner(db: RelationalStore, actor: string): Promise<void> {
  if (await isDeploymentOwner(db, actor)) return;
  throw new OwnershipRefusal((await ownershipPreview(db)).ownerMemberId === null ? 'owner_pending' : 'not_owner');
}

/** Transfer moves a non-null singleton under its revision and rechecks both identities inside the atomic batch. */
export async function transferOwnership(db: RelationalStore, actor: string, candidate: string, revision: string, now: number): Promise<DeploymentOwnershipPreview> {
  await requireOwner(db, actor);
  if (actor === candidate) throw new OwnershipRefusal('invalid_owner');
  const eligible = await db.prepare(`SELECT 1 FROM members m WHERE m.id = ? AND ${linkedHumanAdminSql('m')}`).bind(candidate).first();
  if (eligible === null) throw new OwnershipRefusal('invalid_owner');
  const results = await db.batch([
    db.prepare(`UPDATE deployment_ownership SET member_id = ?, revision = revision + 1, bootstrap_mode = 'selection'
      WHERE id = 1 AND member_id = ? AND revision = ? AND ${deploymentOwnerSql('?')}
        AND EXISTS (SELECT 1 FROM members m WHERE m.id = ? AND ${linkedHumanAdminSql('m')})`)
      .bind(candidate, actor, revision, actor, candidate),
    ownershipAuditStatement(db, actor, candidate, revision, now, actor),
  ]);
  if (results[0]!.meta.changes !== 1) throw new OwnershipRefusal('revision_conflict');
  return ownershipPreview(db);
}

export interface MemberRoleOutcome { memberId: string; role: MemberRole; roleRevision: string }

/** Role changes and their immutable receipts share one batch, with authorization and recovery checked at the write. */
export async function changeMemberRole(db: RelationalStore, actor: string, memberId: string, role: MemberRole, revision: string, now: number): Promise<MemberRoleOutcome> {
  await requireOwner(db, actor);
  const before = await db.prepare('SELECT role,role_revision,revoked_at FROM members WHERE id = ?').bind(memberId)
    .first<{ role: MemberRole; role_revision: number; revoked_at: number | null }>();
  if (before === null || before.revoked_at !== null || memberId === HARNESS_MEMBER_ID) throw new OwnershipRefusal('invalid_member');
  if (String(before.role_revision) !== revision) throw new OwnershipRefusal('revision_conflict');
  if (before.role === role) return { memberId, role, roleRevision: revision };
  if (memberId === actor && role === 'member') throw new OwnershipRefusal('active_owner');
  const results = await db.batch([
    db.prepare(`UPDATE members SET role = ?, role_revision = role_revision + 1
      WHERE id = ? AND revoked_at IS NULL AND role_revision = ? AND role = ?
        AND ${deploymentOwnerSql('?')} AND (? = 'admin' OR (${removableAdministratorSql('members')}))`)
      .bind(role, memberId, revision, before.role, actor, role),
    db.prepare(`INSERT INTO member_role_audit (member_id,revision,previous_role,role,actor_id,created_at)
      SELECT id,role_revision,?,role,?,? FROM members WHERE id = ? AND role = ? AND role_revision = ?
        AND changes() = 1`).bind(before.role, actor, now, memberId, role, Number(revision) + 1),
  ]);
  if (results[0]!.meta.changes !== 1) throw new OwnershipRefusal('revision_conflict');
  const current = await db.prepare('SELECT role,CAST(role_revision AS TEXT) AS roleRevision FROM members WHERE id = ?').bind(memberId)
    .first<{ role: MemberRole; roleRevision: string }>();
  if (current === null) throw new Error('Changed member is missing');
  return { memberId, ...current };
}

/** Only a schema-proven fresh Deployment chooses its first owner during the authenticated link batch. */
function freshOwnershipStatements(db: RelationalStore, memberId: string, githubId: string, now: number): PreparedStatement[] {
  return [
    db.prepare(`UPDATE deployment_ownership SET member_id = ?, revision = revision + 1, bootstrap_mode = 'selection'
      WHERE id = 1 AND member_id IS NULL AND bootstrap_mode = 'fresh' AND changes() = 1
        AND EXISTS (SELECT 1 FROM members m WHERE m.id = ? AND m.github_id = ? AND ${linkedHumanAdminSql('m')})`)
      .bind(memberId, memberId, githubId),
    db.prepare(`INSERT INTO deployment_ownership_audit (revision,member_id,actor_id,created_at)
      SELECT revision,member_id,member_id,? FROM deployment_ownership WHERE id = 1 AND member_id = ? AND changes() = 1`).bind(now, memberId),
  ];
}

/** Initial owner selection is explicit; the guarded write cannot replace an established owner. */
export async function bootstrapOwnership(db: RelationalStore, actor: string, candidate: string, revision: string, now: number): Promise<DeploymentOwnershipPreview> {
  const admin = await db.prepare("SELECT 1 AS admitted FROM members WHERE id = ? AND role = 'admin' AND revoked_at IS NULL").bind(actor).first();
  if (admin === null) throw new OwnershipRefusal('not_admin');
  const current = await ownershipPreview(db);
  if (current.ownerMemberId === candidate) return current;
  if (current.ownerMemberId !== null) throw new OwnershipRefusal('owner_already_recorded');
  if (current.revision !== revision) throw new OwnershipRefusal('revision_conflict');
  const live = await db.prepare(`SELECT 1 AS admitted FROM members m WHERE m.id = ? AND ${linkedHumanAdminSql('m')}`)
    .bind(candidate).first();
  if (live === null) throw new OwnershipRefusal('invalid_owner');
  const outcome = await memberWriteOutcome(() => db.batch([
    db.prepare(`UPDATE deployment_ownership SET member_id = ?, revision = revision + 1 WHERE id = 1 AND member_id IS NULL AND revision = ?
      AND EXISTS (SELECT 1 FROM members WHERE id = ? AND role = 'admin' AND revoked_at IS NULL)
      AND EXISTS (SELECT 1 FROM members m WHERE m.id = ? AND ${linkedHumanAdminSql('m')})`)
      .bind(candidate, revision, actor, candidate),
    db.prepare(`INSERT INTO deployment_ownership_audit (revision,member_id,actor_id,created_at)
      SELECT revision, member_id, ?, ? FROM deployment_ownership WHERE id = 1 AND member_id = ? AND revision = ?
        AND changes() = 1`).bind(actor, now, candidate, Number(revision) + 1),
  ]));
  if (!outcome.admitted || outcome.value[0]!.meta.changes === 0) throw new OwnershipRefusal('revision_conflict');
  return ownershipPreview(db);
}


/** Recovery can fill an unselected owner; additive restore preserves an established destination owner. */
export async function restoreOwnership(db: RelationalStore, row: { member_id: string; revision: number }, audit: { actor_id: string; created_at: number; previous_member_id?: string | null; operation?: string }): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE deployment_ownership SET member_id = ?, revision = ?, bootstrap_mode = 'selection' WHERE id = 1 AND member_id IS NULL
      AND EXISTS (SELECT 1 FROM members WHERE id = ? AND revoked_at IS NULL AND role = 'admin' AND github_id IS NOT NULL)`)
      .bind(row.member_id, row.revision, row.member_id),
    db.prepare(`INSERT INTO deployment_ownership_audit (revision,member_id,actor_id,created_at,previous_member_id,operation)
      SELECT revision,member_id,?,?,?,? FROM deployment_ownership WHERE id = 1 AND member_id = ? AND revision = ? AND changes() = 1`)
      .bind(audit.actor_id, audit.created_at, audit.previous_member_id ?? null, audit.operation ?? 'bootstrap', row.member_id, row.revision),
  ]);
  const restored = await ownershipPreview(db);
  if (restored.ownerMemberId === null) throw new Error('Restored owner is not a live linked administrator');
}

/** The authenticated bind and initial ownership share one transaction and cannot commit separately. */
export async function completeIdentityLink(db: RelationalStore, bind: PreparedStatement, memberId: string, githubId: string, now: number): Promise<number> {
  const results = await db.batch([bind, ...freshOwnershipStatements(db, memberId, githubId, now)]);
  return results[0]!.meta.changes;
}

/** Every restored human membership commits the explicit-selection marker with its rows. */
export async function restoreMembershipBatch(db: RelationalStore, statements: PreparedStatement[], containsHuman: boolean) {
  if (!containsHuman) return db.batch(statements);
  const results = await db.batch([
    db.prepare("UPDATE deployment_ownership SET bootstrap_mode = 'selection' WHERE id = 1 AND member_id IS NULL"),
    ...statements,
  ]);
  return results.slice(1);
}

/** Imported receipts belong only to the imported authority state that the destination actually holds. */
export function restoreAuthorityAuditStatement(db: RelationalStore, table: 'deployment_ownership_audit' | 'member_role_audit', row: Record<string, unknown>, authority: Record<string, unknown> | undefined): PreparedStatement {
  if (table === 'deployment_ownership_audit') {
    return db.prepare(`INSERT OR IGNORE INTO deployment_ownership_audit (revision,member_id,actor_id,created_at,previous_member_id,operation)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM deployment_ownership WHERE id = 1 AND member_id = ? AND revision = ? AND ? <= revision) RETURNING rowid`)
      .bind(row.revision, row.member_id, row.actor_id, row.created_at, row.previous_member_id ?? null, row.operation ?? 'bootstrap',
        authority?.member_id ?? null, authority?.revision ?? null, row.revision);
  }
  return db.prepare(`INSERT OR IGNORE INTO member_role_audit (member_id,revision,previous_role,role,actor_id,created_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM members WHERE id = ? AND role = ? AND role_revision = ? AND ? <= role_revision) RETURNING rowid`)
    .bind(row.member_id, row.revision, row.previous_role, row.role, row.actor_id, row.created_at,
      authority?.id ?? null, authority?.role ?? null, authority?.role_revision ?? 0, row.revision);
}
