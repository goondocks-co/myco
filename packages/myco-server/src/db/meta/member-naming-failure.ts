/**
 * Sign-ins whose member could not be named: one row per member with its repeat count. A row clears in the commit that
 * names or revokes its member, so it needs no clearing call here.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { FIRST_OWNER_MEMBER_LABEL } from '../../core/ownership.js';
import { commit, read, readSet, write } from '../index.js';

export interface MemberNamingFailure { memberId: string; errorClass: string; failures: number; lastFailedAt: number }
interface MemberNamingFailures { members: MemberNamingFailure[]; hasMore: boolean }

/** The members one Attention notice lists; `hasMore` says when others stand behind them. */
export const MEMBER_NAMING_PAGE = 8;

const put = write<[memberId: string, errorClass: string, at: number, placeholder: string]>({
  name: 'meta.recordMemberNamingFailure',
  sql: `INSERT INTO member_naming_failures(member_id,error_class,failures,last_failed_at)
    SELECT id,?2,1,?3 FROM members WHERE id=?1 AND revoked_at IS NULL AND (label IS NULL OR label=?4)
    ON CONFLICT(member_id) DO UPDATE SET error_class=excluded.error_class,failures=failures+1,last_failed_at=MAX(last_failed_at,excluded.last_failed_at)`,
});
const open = read<[placeholder: string, limit: number], MemberNamingFailure>({
  name: 'meta.memberNamingFailures',
  sql: `SELECT f.member_id AS memberId,f.error_class AS errorClass,f.failures,f.last_failed_at AS lastFailedAt
    FROM member_naming_failures f INDEXED BY idx_member_naming_failures_recent JOIN members m ON m.id=f.member_id
    WHERE m.revoked_at IS NULL AND (m.label IS NULL OR m.label=?1)
    ORDER BY f.last_failed_at DESC,f.member_id LIMIT ?2`,
});

/** Records a failure for a live member still without a name; a named or revoked member has nothing to repair. */
export async function recordMemberNamingFailure(db: RelationalStore, memberId: string, errorClass: string, at: number): Promise<void> {
  await commit(db, put.bind(memberId, errorClass, at, FIRST_OWNER_MEMBER_LABEL));
}

/** The most recent unresolved failures, one per member. */
export async function memberNamingFailures(db: RelationalStore): Promise<MemberNamingFailures> {
  const [rows] = await readSet(db, open.bind(FIRST_OWNER_MEMBER_LABEL, MEMBER_NAMING_PAGE + 1));
  return { members: rows.slice(0, MEMBER_NAMING_PAGE), hasMore: rows.length > MEMBER_NAMING_PAGE };
}
