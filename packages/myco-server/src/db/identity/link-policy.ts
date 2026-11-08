import { personMemberSql } from '../../auth/member-kind.js';
const ADMIN = 'admin';
export const linkedAdmin = (alias: string): string =>
  `${alias}.role = '${ADMIN}' AND ${alias}.github_id IS NOT NULL AND ${alias}.revoked_at IS NULL`;

/**
 * Whether a key issued by `issuer` for `member` — SQL expressions; a NULL
 * issuer for a key a member's own credential minted — may be minted or bind
 * now: a self-issued key only for an admin, while no live admin has a GitHub
 * account linked, so the one bind it admits makes the Deployment's admin; an
 * admin-issued key while its issuer is still a live, linked admin. The one
 * statement of the rule; the mint and the bind each compose it into their own
 * write, so no read decides it ahead of the write it guards.
 */
export const linkAdmitted = (issuer: string, member: string): string =>
  `(${personMemberSql(`(${member})`)}) AND (((${issuer}) IS NULL
      AND EXISTS (SELECT 1 FROM members lt WHERE lt.id = (${member}) AND lt.role = '${ADMIN}')
      AND NOT EXISTS (SELECT 1 FROM members la WHERE ${linkedAdmin('la')}))
    OR EXISTS (SELECT 1 FROM members la WHERE la.id = (${issuer}) AND ${linkedAdmin('la')}))`;
