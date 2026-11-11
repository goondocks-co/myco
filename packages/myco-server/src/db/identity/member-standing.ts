import type { RelationalStore } from '../../core/adapters.js';
import { first, read, readSet, write, type Bound } from '../index.js';
import { deploymentOwnerSql } from './ownership-policy.js';

const role = read<[member: string], { role: string }>({ name: 'memberStanding.role', sql: 'SELECT role FROM members WHERE id = ?1' });
const protectedOwner = read<[member: string], { one: number }>({ name: 'memberStanding.protectedOwner', sql: 'SELECT 1 AS one FROM deployment_ownership WHERE id = 1 AND member_id = ?1' });
const ownerActor = read<[actor: string], { admitted: number }>({ name: 'memberStanding.ownerActor', sql: `SELECT ${deploymentOwnerSql('?1')} AS admitted` });
const otherLinked = read<[member: string], { linked: number }>({ name: 'memberStanding.otherLinked', sql:
  'SELECT COUNT(*) AS linked FROM members WHERE revoked_at IS NULL AND github_id IS NOT NULL AND id <> ?1' });
const bind = write<[github: string, member: string]>({ name: 'memberStanding.bindAccount', sql: `UPDATE members SET github_id = ?1 WHERE id = ?2` });

/** The role a member row holds, or null when there is no such row. */
export async function memberRoleRow(db: RelationalStore, member: string): Promise<string | null> {
  return (await first(db, role.bind(member)))?.role ?? null;
}

/** True when the member is the Deployment's owner. */
export async function isOwnerMember(db: RelationalStore, member: string): Promise<boolean> {
  return await first(db, protectedOwner.bind(member)) !== null;
}

/** True when the actor holds the Deployment's ownership as a live member. */
export async function actsAsOwner(db: RelationalStore, actor: string): Promise<boolean> {
  return (await first(db, ownerActor.bind(actor)))?.admitted === 1;
}

/** How many live, linked members the Deployment holds besides this one. */
export async function otherLinkedMemberCount(db: RelationalStore, member: string): Promise<number> {
  const [[row]] = await readSet(db, otherLinked.bind(member));
  return Number(row?.linked);
}

/** Binds the member to a GitHub account, clearing any earlier account: the operator's own store access decides who. */
export const memberAccountBind = (member: string, github: string): Bound => bind.bind(github, member);
