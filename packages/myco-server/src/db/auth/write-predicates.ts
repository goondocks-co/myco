import { personMemberSql } from '../../auth/member-kind.js';
import { MEMBER_ROLES_SQL } from '../../auth/roles.js';

/** Owner control credentials are mutable only by that owner at the SQL write. */
export const OWNER_CONTROL_CREDENTIAL_WRITE = `NOT EXISTS (SELECT 1 FROM deployment_ownership o
  WHERE o.id = 1 AND o.member_id = member_credentials.member_id AND o.member_id <> ?)`;

/** A live member edits their own resources; current administrators may edit another member's resources. */
export function memberWritePredicate(actor: string, ownedBy: string): string {
  return `EXISTS (SELECT 1 FROM members write_actor WHERE write_actor.id = ${actor}
    AND write_actor.revoked_at IS NULL AND write_actor.role IN ('admin', 'member')
    AND (write_actor.role = 'admin' OR write_actor.id = ${ownedBy}
      OR EXISTS (SELECT 1 FROM deployment_ownership o WHERE o.id = 1 AND o.member_id = write_actor.id)))`;
}

/** Every enrollment write resolves issuer, recipient and ownership authority at SQL execution. Null issuer denotes operator issuance. */
export function enrollmentAuthorityPredicate(alias: string): string {
  return `(${alias}.member_id IS NULL OR ${personMemberSql(`${alias}.member_id`)})
    AND ${alias}.role IN (${MEMBER_ROLES_SQL})
    AND (${alias}.member_id IS NULL OR EXISTS (SELECT 1 FROM members recipient
      WHERE recipient.id = ${alias}.member_id AND recipient.revoked_at IS NULL AND recipient.role IN (${MEMBER_ROLES_SQL})))
    AND (${alias}.created_by_member IS NULL OR EXISTS (SELECT 1 FROM members issuer
      WHERE issuer.id = ${alias}.created_by_member AND issuer.revoked_at IS NULL AND issuer.role IN (${MEMBER_ROLES_SQL})
        AND (issuer.role = 'admin' OR (${alias}.member_id = issuer.id AND EXISTS (SELECT 1 FROM device_requests device WHERE device.id = ${alias}.id))
          OR EXISTS (SELECT 1 FROM deployment_ownership o WHERE o.id = 1 AND o.member_id = issuer.id))
        AND (EXISTS (SELECT 1 FROM deployment_ownership o WHERE o.id = 1 AND o.member_id = issuer.id)
          OR (${alias}.member_id = issuer.id AND (${alias}.role = 'member' OR ${alias}.role = issuer.role)
            AND EXISTS (SELECT 1 FROM device_requests device WHERE device.id = ${alias}.id))
          OR (${alias}.role = 'member' AND NOT EXISTS (SELECT 1 FROM members recipient
            LEFT JOIN deployment_ownership o ON o.id = 1 WHERE recipient.id = ${alias}.member_id
              AND (recipient.role = 'admin' OR recipient.id = o.member_id))))))`;
}
