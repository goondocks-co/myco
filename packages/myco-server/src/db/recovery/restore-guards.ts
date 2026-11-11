/**
 * The conditions an additive restore holds in every batch it writes: no session was deleted since the restore read the
 * tombstone frontier, and the actor still holds the authority the restore was admitted with. A broken condition inserts
 * into `restore_reference_guard`, which never holds a row, so the whole batch fails.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { memberWritePredicate } from '../auth/write-predicates.js';
import { deploymentOwnerSql } from '../identity/ownership-policy.js';
import { first, read, write, type Bound } from '../index.js';

const frontier = read<[], { watermark: number }>({ name: 'restore.tombstoneFrontier', sql:
  'SELECT COALESCE(MAX(rowid),0) watermark FROM session_tombstones' });
const unmoved = write<[watermark: number]>({ name: 'restore.tombstonesUnmoved', sql:
  `INSERT INTO restore_reference_guard(missing)
    SELECT 'session deleted during restore' WHERE (SELECT COALESCE(MAX(rowid),0) FROM session_tombstones)<>?1` });

/** The tombstone frontier: the newest tombstone's rowid, which only grows. */
export const tombstoneFrontier = (): Bound<{ watermark: number }, 'read'> => frontier.bind();
export async function readTombstoneFrontier(db: RelationalStore): Promise<number> {
  return (await first(db, frontier.bind()))!.watermark;
}
/** Fails the batch unless the frontier is still `watermark`. */
export const tombstonesUnmoved = (watermark: number): Bound<never, 'write'> => unmoved.bind(watermark);

const authorityChanged = (predicate: string) => `INSERT INTO restore_reference_guard (missing)
      SELECT 'restore authority changed' WHERE NOT (${predicate})`;
const ownerHolds = write<[member: string]>({ name: 'restore.ownerAuthorityHolds', sql: authorityChanged(deploymentOwnerSql('?1')) });
const adminHolds = write<[member: string]>({ name: 'restore.adminAuthorityHolds', sql: authorityChanged(memberWritePredicate('?1', 'NULL')) });

/** Fails the batch unless `member` still holds the authority the restore needs: Deployment ownership, or an administrator's write. */
export const restoreAuthorityHolds = (member: string, authority: 'owner' | 'admin'): Bound<never, 'write'> =>
  (authority === 'owner' ? ownerHolds : adminHolds).bind(member);

const owner = read<[], { member_id: string | null }>({ name: 'restore.ownerMember', sql: 'SELECT member_id FROM deployment_ownership WHERE id = 1' });
/** Whether the Deployment has an owner yet. */
export async function deploymentOwned(db: RelationalStore): Promise<boolean> {
  return (await first(db, owner.bind()))?.member_id != null;
}
