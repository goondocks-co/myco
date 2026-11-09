import type { PreparedStatement, RelationalStore } from './adapters.js';

/** The schema_meta receipt naming the member a first-owner setup made. */
export const FIRST_MEMBER_KEY = 'first_member_setup';
/** The provisional name of an owner whose GitHub account is not linked yet. */
export const FIRST_OWNER_MEMBER_LABEL = 'Deployment administrator';

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
