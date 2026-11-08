import type { MemberRole } from '../../auth/roles.js';
import { JOIN_ADMISSION_SQL } from './enrollment-policy.js';
import { write } from '../index.js';
import { prepareBound } from '../kernel/statement.js';
import type { RelationalStore } from '../../core/adapters.js';

export const MEMBER_IDENTITY_SQL = `INSERT OR IGNORE INTO members (id,label,created_at,revoked_at,role) SELECT ?,?,?,NULL,?`;
export const memberIdentityInsert = write<readonly unknown[]>({name:'enrollment.memberIdentityInsert',sql:MEMBER_IDENTITY_SQL});
const firstOwnerIdentity = write<readonly unknown[]>({name:'enrollment.firstOwnerIdentity',sql:MEMBER_IDENTITY_SQL+`
  WHERE (SELECT value FROM schema_meta WHERE key=?)=?`});
export interface MemberIdentityGate { receiptKey:string; memberId:string }
export function enrollmentMemberStatement(db:RelationalStore,values:readonly unknown[],gate?:MemberIdentityGate) {
  return prepareBound(db,gate===undefined?memberIdentityInsert.bind(...values):firstOwnerIdentity.bind(...values,gate.receiptKey,gate.memberId));
}

const joinIdentities = [
  write<readonly unknown[]>({ name: 'enrollment.joinMemberIdentity', sql: MEMBER_IDENTITY_SQL + ` WHERE ${JOIN_ADMISSION_SQL[0]}` }),
  write<readonly unknown[]>({ name: 'enrollment.joinProjectIdentity', sql: MEMBER_IDENTITY_SQL + ` WHERE ${JOIN_ADMISSION_SQL[1]}` }),
];

/** Bind a join's member insert under the same admission as its credential. */
export function joinMemberIdentityWrite(forProject: boolean, memberId: string, now: number, role: MemberRole, admissionValues: readonly unknown[]) {
  return joinIdentities[Number(forProject)]!.bind(memberId, memberId, now, role, ...admissionValues);
}
