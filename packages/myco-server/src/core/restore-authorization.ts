import { authorize, deploymentIdentity, memberSubject } from '../auth/authorization.js';
import type { RelationalStore } from './adapters.js';
import { guardedStore } from '../db/kernel/guarded-store.js';
import { deploymentOwned, restoreAuthorityHolds } from '../db/recovery/restore-guards.js';

export type RestoreAuthorization = { kind: 'member'; memberId: string } | { kind: 'recovery' };

/** These rows can grant credentials, connect accounts, or attribute administrative authority. */
const RESTORE_AUTHORITY_TABLES: ReadonlySet<string> = new Set([
  'members', 'machine_claims', 'enrollment_authorities', 'identity_link_authorities', 'member_credentials',
  'deployment_ownership', 'deployment_ownership_audit', 'member_role_audit', 'external_grants',
  'raw_credentials', 'raw_claims', 'raw_resources',
]);

export class RestoreAuthorizationError extends Error {
  constructor(readonly code: 'not_owner' | 'owner_pending' | 'not_admin') {
    super(code);
    this.name = 'RestoreAuthorizationError';
  }
}

type RestoreAdmission = { allowed: true; requiresOwner: boolean; code: null } | {
  allowed: false; requiresOwner: boolean; code: RestoreAuthorizationError['code'];
};

/** Resolve the same actor and table authority used by preview and restore writes. */
export async function restoreAdmission(db: RelationalStore, actor: RestoreAuthorization, tables: Iterable<string>): Promise<RestoreAdmission> {
  const requiresOwner = [...tables].some(table => RESTORE_AUTHORITY_TABLES.has(table));
  if (actor?.kind === 'recovery') return { allowed: true, requiresOwner, code: null };
  if (actor?.kind !== 'member') return { allowed: false, requiresOwner, code: 'not_admin' };
  const allowed = authorize(await memberSubject(db, actor.memberId, 'http'), requiresOwner ? 'owner' : 'admin', {
    kind: requiresOwner ? 'member' : 'backup', deploymentId: await deploymentIdentity(db), exists: true,
  });
  if (allowed) return { allowed: true, requiresOwner, code: null };
  if (!requiresOwner) return { allowed: false, requiresOwner, code: 'not_admin' };
  return { allowed: false, requiresOwner, code: await deploymentOwned(db) ? 'not_owner' : 'owner_pending' };
}

/** Admission precedes every restore write; each transaction retains the actor's current authority. */
export async function authorizeRestore(db: RelationalStore, actor: RestoreAuthorization, tables: Iterable<string>): Promise<RelationalStore> {
  if (actor?.kind === 'recovery') return db;
  const tableNames = [...tables];
  const admission = await restoreAdmission(db, actor, tableNames);
  if (!admission.allowed) throw new RestoreAuthorizationError(admission.code);
  const { memberId } = actor;
  return guardedStore(db, {
    before: () => [restoreAuthorityHolds(memberId, admission.requiresOwner ? 'owner' : 'admin')],
    covers: 'every',
    refusal: async error => {
      const current = await restoreAdmission(db, actor, tableNames);
      if (!current.allowed) throw new RestoreAuthorizationError(current.code);
      throw error;
    },
  });
}
