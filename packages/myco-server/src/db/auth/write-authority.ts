import { assertion, refusalCode } from '../index.js';

export const CREDENTIAL_ENDED = refusalCode('credential_ended');
export const GRANT_ENDED = refusalCode('grant_ended');

/** A member's credential is unrevoked and unexpired, and its member live, at the commit that carries it. */
export const credentialWriteAuthority = assertion<[token: string, member: string, now: number]>({
  name: 'authz.credentialWrite',
  refusal: CREDENTIAL_ENDED,
  when: `EXISTS (SELECT 1 FROM member_credentials c JOIN members m ON m.id=c.member_id
    WHERE c.id=?1 AND c.member_id=?2 AND c.revoked_at IS NULL AND c.expires_at>?3 AND m.revoked_at IS NULL AND m.role IN ('admin','member'))`,
});

/** A grant is unrevoked, unexpired and still names this Project at the commit that carries it. */
export const grantWriteAuthority = assertion<[grant: string, project: string, now: number]>({
  name: 'authz.grantWrite',
  refusal: GRANT_ENDED,
  when: 'EXISTS (SELECT 1 FROM external_grants WHERE id=?1 AND project_id=?2 AND revoked_at IS NULL AND expires_at>?3)',
});
