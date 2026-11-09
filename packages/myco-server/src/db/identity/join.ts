import { MEMBER_ROLES_SQL } from '../../auth/roles.js';
import { enrollmentAuthorityPredicate } from '../../auth/authorization.js';
import { GITHUB_LOGIN_KEY_PREFIX } from './member-naming.js';
import { memberLive } from '../liveness.js';
import { assertion, read, refusalCode, write, type Bound } from '../index.js';
import { notDueForReclaim } from './authority-retention.js';
import { deploymentOwnerSql } from './ownership-policy.js';

export const JOIN_REFUSED = refusalCode('enrollment_join_refused');

/** The key is unspent, its issuer and recipient live, the machine unheld or this member's, and any device request approved for this machine. */
const joinAdmitted = assertion<[keyHash: string, now: number, memberId: string, machineId: string, forProject: number]>({
  name: 'enrollment.joinAdmitted', refusal: JOIN_REFUSED,
  when: `EXISTS (SELECT 1 FROM enrollment_authorities WHERE key_hash=?1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?2
      AND ${notDueForReclaim('enrollment_authorities', '?2')}
      AND role IN (${MEMBER_ROLES_SQL}) AND (?5=0 OR project_id IS NOT NULL)
      AND COALESCE(member_id,?3)=?3
      AND (member_id IS NULL OR ${memberLive('enrollment_authorities.member_id')})
      AND (created_by_member IS NULL OR ${memberLive('enrollment_authorities.created_by_member')})
      AND ${enrollmentAuthorityPredicate('enrollment_authorities')})
    AND NOT EXISTS (SELECT 1 FROM machine_claims WHERE machine_id=?4 AND member_id<>?3)
    AND NOT EXISTS (SELECT 1 FROM device_requests WHERE device_hash=?1 AND (machine_id<>?4 OR decision IS NOT 'approved'))`,
});
const joinMember = write<[memberId: string, now: number, keyHash: string]>({
  name: 'enrollment.joinMember',
  sql: 'INSERT OR IGNORE INTO members(id,label,created_at,revoked_at,role) SELECT ?1,?1,?2,NULL,role FROM enrollment_authorities WHERE key_hash=?3',
});
const joinMachineClaim = write<[machineId: string, memberId: string, now: number, label: string | null]>({
  name: 'enrollment.joinMachineClaim',
  sql: 'INSERT OR IGNORE INTO machine_claims(machine_id,member_id,claimed_at,label) SELECT ?1,?2,?3,?4',
});
const joinSpend = write<[now: number, runtime: string, keyHash: string], { id: string }>({
  name: 'enrollment.joinSpend',
  sql: 'UPDATE enrollment_authorities SET used_at=?1,used_by_runtime=?2 WHERE key_hash=?3 AND used_at IS NULL AND revoked_at IS NULL RETURNING id',
});
const joinIdentity = read<[loginKeyPrefix: string, tokenId: string], { role: unknown; memberLabel: string | null; owner: number }>({
  name: 'enrollment.joinIdentity',
  sql: `SELECT m.role AS role,(SELECT value FROM schema_meta WHERE key=?1||m.github_id) AS memberLabel,${deploymentOwnerSql('m.id')} AS owner
    FROM member_credentials c JOIN members m ON m.id=c.member_id WHERE c.id=?2`,
});

interface JoinFacts { keyHash: string; now: number; memberId: string; machineId: string; forProject: boolean; runtimeLabel: string | null }

/** One join's statements for the caller's `commitNamed`: the admission first, so a refusal leaves no member, claim, credential or spend. */
export function joinWrites(facts: JoinFacts): { admitted: Bound; member: Bound; claim: Bound; spend: Bound<{ id: string }> } {
  const { keyHash, now, memberId, machineId, forProject, runtimeLabel } = facts;
  return {
    admitted: joinAdmitted.bind(keyHash, now, memberId, machineId, forProject ? 1 : 0),
    member: joinMember.bind(memberId, now, keyHash),
    claim: joinMachineClaim.bind(machineId, memberId, now, runtimeLabel),
    spend: joinSpend.bind(now, machineId, keyHash),
  };
}

export const joinIdentityRead = (tokenId: string): Bound<{ role: unknown; memberLabel: string | null; owner: number }, 'read'> => joinIdentity.bind(GITHUB_LOGIN_KEY_PREFIX, tokenId);
