import { personMemberSql } from '../../auth/member-kind.js';

/** The member named by `member` holds the Deployment's ownership, live and an admin. */
export const deploymentOwnerSql = (member: string): string => `EXISTS (SELECT 1 FROM deployment_ownership owner_record JOIN members owner_member ON owner_member.id = owner_record.member_id
  WHERE owner_record.id = 1 AND owner_record.member_id = ${member} AND owner_member.revoked_at IS NULL AND owner_member.role = 'admin')`;

export const linkedHumanAdminSql = (alias: string): string => `${alias}.revoked_at IS NULL AND ${alias}.role = 'admin'
  AND ${alias}.github_id IS NOT NULL AND ${personMemberSql(`${alias}.id`)}`;

/** Protected membership mutations retain the active owner and another recoverable administrator. */
export const removableAdministratorSql = (alias: string): string => `NOT EXISTS (SELECT 1 FROM deployment_ownership o WHERE o.id = 1 AND o.member_id = ${alias}.id)
  AND (NOT (${linkedHumanAdminSql(alias)}) OR EXISTS (SELECT 1 FROM members other WHERE other.id <> ${alias}.id AND ${linkedHumanAdminSql('other')}))`;
