/**
 * The one statement of "this member is live" and "this member carries this
 * very revocation", as SQL fragments every writer and reader composes rather
 * than restates. A predicate written in one place is a predicate that
 * cannot drift between the path that refuses and the path that lists.
 */

/** True while the member named by `memberColumn` exists and is unrevoked. */
export const memberLive = (memberColumn: string): string =>
  `EXISTS (SELECT 1 FROM members WHERE id = ${memberColumn} AND revoked_at IS NULL)`;

/** True once the member row carries exactly this revocation; binds `memberRevokedByParams`. A follow-up statement in a revocation batch matches rows only through this. */
export const MEMBER_REVOKED_BY = 'EXISTS (SELECT 1 FROM members WHERE id = ? AND revoked_at = ? AND revoked_by = ?)';

export const memberRevokedByParams = (memberId: string, nowMs: number, revokedBy: string): readonly [string, number, string] =>
  [memberId, nowMs, revokedBy];

/** True for a credential that authenticates: unrevoked, unexpired (binds the clock), and its member live. `alias` qualifies the credential's columns. */
export const credentialLive = (alias = ''): string => {
  const q = alias === '' ? '' : `${alias}.`;
  return `${q}revoked_at IS NULL AND ${q}expires_at > ? AND ${memberLive(`${q}member_id`)}`;
};
