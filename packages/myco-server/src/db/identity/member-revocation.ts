import { GITHUB_LOGIN_KEY_PREFIX } from './member-naming.js';
import { personMemberSql } from '../../auth/member-kind.js';
import { removableAdministratorSql, deploymentOwnerSql } from './ownership-policy.js';
import { write, type Bound } from '../index.js';

/** Every follow-up matches rows only once the member row carries exactly this revocation. */
const CARRIES_REVOCATION = 'EXISTS (SELECT 1 FROM members WHERE id=?1 AND revoked_at=?2 AND revoked_by=?3)';

const member = write<[member: string, now: number, actor: string], { id: string }>({
  name: 'memberRevocation.member',
  sql: `UPDATE members SET revoked_at=?2,revoked_by=?3 WHERE id=?1 AND revoked_at IS NULL AND ${personMemberSql('id')}
    AND EXISTS (SELECT 1 FROM members other WHERE other.revoked_at IS NULL AND other.github_id IS NOT NULL AND other.id<>?1)
    AND ${removableAdministratorSql('members')}
    AND (role<>'admin' OR ${deploymentOwnerSql('?3')})
    AND EXISTS (SELECT 1 FROM members actor WHERE actor.id=?3 AND actor.role='admin' AND actor.revoked_at IS NULL)
    RETURNING id`,
});
const credentials = write<[member: string, now: number, actor: string]>({
  name: 'memberRevocation.credentials',
  sql: `UPDATE member_credentials SET revoked_at=?2,revoked_by=?3 WHERE member_id=?1 AND revoked_at IS NULL AND ${CARRIES_REVOCATION}`,
});
const invitations = write<[member: string, now: number, actor: string]>({
  name: 'memberRevocation.invitations',
  sql: `UPDATE enrollment_authorities SET revoked_at=?2,revoked_by=?3 WHERE (member_id=?1 OR created_by_member=?1) AND used_at IS NULL AND revoked_at IS NULL AND ${CARRIES_REVOCATION}`,
});
const linkKeys = write<[member: string, now: number, actor: string]>({
  name: 'memberRevocation.linkKeys',
  sql: `UPDATE identity_link_authorities SET revoked_at=?2,revoked_by=?3 WHERE member_id=?1 AND used_at IS NULL AND revoked_at IS NULL AND ${CARRIES_REVOCATION}`,
});
const uncaptured = write<[member: string, now: number, actor: string]>({
  name: 'memberRevocation.uncaptured',
  sql: `DELETE FROM uncaptured_roots WHERE member_id=?1 AND ${CARRIES_REVOCATION}`,
});
const loginLabel = write<[member: string, now: number, actor: string, prefix: string]>({
  name: 'memberRevocation.loginLabel',
  sql: `DELETE FROM schema_meta WHERE key=(SELECT ?4||github_id FROM members WHERE id=?1) AND ${CARRIES_REVOCATION}`,
});

/** The statements of one member revocation for the caller's `commitNamed`: the member row first, everything else keyed to that revocation. */
export function memberRevocationWrites(memberId: string, actor: string, now: number): {
  member: Bound<{ id: string }>; credentials: Bound; invitations: Bound; linkKeys: Bound; uncaptured: Bound; loginLabel: Bound;
} {
  const facts = [memberId, now, actor] as const;
  return {
    member: member.bind(...facts),
    credentials: credentials.bind(...facts),
    invitations: invitations.bind(...facts),
    linkKeys: linkKeys.bind(...facts),
    uncaptured: uncaptured.bind(...facts),
    loginLabel: loginLabel.bind(...facts, GITHUB_LOGIN_KEY_PREFIX),
  };
}
