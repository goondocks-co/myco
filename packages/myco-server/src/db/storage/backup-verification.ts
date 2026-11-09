import type { RelationalStore } from '../../core/adapters.js';
import type { BackupVerificationDetail } from './backup-list.js';
import { commitNamed, write } from '../index.js';

const record = write<[state: 'verified' | 'failed' | null, checkedAt: number, detail: BackupVerificationDetail | null, id: string, key: string], { id: string }>({
  name: 'storage.recordBackupVerification', sql:
    'UPDATE backups SET verification_state=?1,verification_checked_at=?2,verification_detail=?3 WHERE id=?4 AND key=?5 RETURNING id',
});

/**
 * Records a check against the object it read; a backup no longer naming that key records nothing. A null state is a check
 * that had no digest to compare: it records when the size matched and verifies nothing.
 */
export async function recordBackupVerification(db: RelationalStore, check: { id: string; key: string; state: 'verified' | 'failed' | null; checkedAt: number; detail: BackupVerificationDetail | null }): Promise<boolean> {
  const { recorded } = await commitNamed(db, { recorded: record.bind(check.state, check.checkedAt, check.detail, check.id, check.key) });
  return recorded.results.length === 1;
}
