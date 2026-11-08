import type { MemberRole } from '../../auth/roles.js';
import type { RelationalStore } from '../../core/adapters.js';
import { write } from '../index.js';
import { prepareBound } from '../kernel/statement.js';
import { CREDENTIAL_INSERT_SQL } from './claim-companions.js';
import { joinMemberIdentityWrite } from '../identity/enrollment.js';
import { JOIN_ADMISSION_SQL } from '../identity/enrollment-policy.js';

const joins = [false, true].map(forProject => {
  const gate = JOIN_ADMISSION_SQL[Number(forProject)]!;
  const suffix = forProject ? 'Project' : 'Member';
  return {
    gate,
    credential: write<readonly unknown[]>({ name: `enrollment.join${suffix}Credential`, sql: CREDENTIAL_INSERT_SQL + ` AND (${gate}) RETURNING id` }),
  };
});

/** A named join policy supplies the same observed authority to identities and their credential. */
export function joinAdmission(keyHash: string, now: number, memberId: string, machineId: string, forProject: boolean) {
  const definition = joins[Number(forProject)]!;
  const params = [keyHash, now, memberId, memberId, machineId, memberId, keyHash, machineId];
  return {
    predicate: { sql: definition.gate, params },
    credential: { write: definition.credential, values: params },
    member: (db: RelationalStore, role: MemberRole) => prepareBound(db, joinMemberIdentityWrite(forProject, memberId, now, role, params)),
  };
}

export const nonAdminCredential = write<readonly unknown[]>({
  name: 'enrollment.nonAdminCredential',
  sql: CREDENTIAL_INSERT_SQL + ` AND EXISTS (SELECT 1 FROM members WHERE id = ? AND role = 'member') RETURNING id`,
});
