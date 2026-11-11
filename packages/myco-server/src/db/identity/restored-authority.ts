/**
 * Restoring ownership and role receipts, and marking a restore that brings human members.
 *
 * An imported receipt belongs only to the imported authority state the destination actually holds: it lands while that
 * state's member and revision still stand there, and never ahead of it.
 */
import { write, type Bound } from '../index.js';

type BindNullable = string | number | null;

const ownershipReceipt = write<[revision: number, member: BindNullable, actor: BindNullable, created: BindNullable, previous: BindNullable, operation: string,
  heldMember: BindNullable, heldRevision: BindNullable], { rowid: number }>({ name: 'identity.restoreOwnershipReceipt', sql:
  `INSERT OR IGNORE INTO deployment_ownership_audit (revision,member_id,actor_id,created_at,previous_member_id,operation)
      SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS (SELECT 1 FROM deployment_ownership WHERE id = 1 AND member_id = ?7 AND revision = ?8 AND ?1 <= revision) RETURNING rowid` });

const roleReceipt = write<[member: BindNullable, revision: BindNullable, previous: BindNullable, role: BindNullable, actor: BindNullable, created: BindNullable,
  heldMember: BindNullable, heldRole: BindNullable, heldRevision: BindNullable], { rowid: number }>({ name: 'identity.restoreRoleReceipt', sql:
  `INSERT OR IGNORE INTO member_role_audit (member_id,revision,previous_role,role,actor_id,created_at)
      SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS (SELECT 1 FROM members WHERE id = ?7 AND role = ?8 AND role_revision = ?9 AND ?2 <= role_revision) RETURNING rowid` });

const value = (field: unknown): BindNullable => (field ?? null) as BindNullable;

/** A restored ownership or role receipt, kept only while the authority state it names is the one the destination holds. */
export function restoreAuthorityReceipt(table: 'deployment_ownership_audit' | 'member_role_audit', row: Readonly<Record<string, unknown>>,
  authority: Readonly<Record<string, unknown>> | undefined): Bound<{ rowid: number }, 'write'> {
  if (table === 'deployment_ownership_audit') {
    return ownershipReceipt.bind(row.revision as number, value(row.member_id), value(row.actor_id), value(row.created_at), value(row.previous_member_id),
      (row.operation ?? 'bootstrap') as string, value(authority?.member_id), value(authority?.revision));
  }
  return roleReceipt.bind(value(row.member_id), value(row.revision), value(row.previous_role), value(row.role), value(row.actor_id), value(row.created_at),
    value(authority?.id), value(authority?.role), (authority?.role_revision ?? 0) as BindNullable);
}

/** A restore bringing a human member records that the owner is chosen explicitly, while no owner is recorded. */
export const restoreSelectsOwner = write<[]>({ name: 'identity.restoreSelectsOwner', sql:
  "UPDATE deployment_ownership SET bootstrap_mode = 'selection' WHERE id = 1 AND member_id IS NULL" });
