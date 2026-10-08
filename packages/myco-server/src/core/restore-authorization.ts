import { authorize, deploymentIdentity, memberSubject, memberWritePredicate } from '../auth/authorization.js';
import type { PreparedStatement, RelationalStore, RunResult } from './adapters.js';
import { deploymentOwnerSql } from './ownership.js';

export type RestoreAuthorization = { kind: 'member'; memberId: string } | { kind: 'recovery' };

/** These rows can grant credentials, connect accounts, or attribute administrative authority. */
export const RESTORE_AUTHORITY_TABLES: ReadonlySet<string> = new Set([
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

export type RestoreAdmission = { allowed: true; requiresOwner: boolean; code: null } | {
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
  const owner = await db.prepare('SELECT member_id FROM deployment_ownership WHERE id = 1').first<{ member_id: string | null }>();
  return { allowed: false, requiresOwner, code: owner?.member_id == null ? 'owner_pending' : 'not_owner' };
}

/** Admission precedes every restore write; each transaction retains the actor's current authority. */
export async function authorizeRestore(db: RelationalStore, actor: RestoreAuthorization, tables: Iterable<string>): Promise<RelationalStore> {
  if (actor?.kind === 'recovery') return db;
  const tableNames = [...tables];
  const admission = await restoreAdmission(db, actor, tableNames);
  if (!admission.allowed) throw new RestoreAuthorizationError(admission.code);
  const originals = new WeakMap<PreparedStatement, PreparedStatement>();
  const predicate = admission.requiresOwner ? deploymentOwnerSql('?') : memberWritePredicate('?', 'NULL');
  const batch = async (statements: PreparedStatement[]): Promise<RunResult[]> => {
    const guard = db.prepare(`INSERT INTO restore_reference_guard (missing)
      SELECT 'restore authority changed' WHERE NOT (${predicate})`).bind(actor.memberId);
    try {
      return (await db.batch([guard, ...statements.map(statement => originals.get(statement) ?? statement)])).slice(1);
    } catch (error) {
      const current = await restoreAdmission(db, actor, tableNames);
      if (!current.allowed) throw new RestoreAuthorizationError(current.code);
      throw error;
    }
  };
  const statement = (original: PreparedStatement): PreparedStatement => {
    const wrapped: PreparedStatement = {
      bind: (...values) => statement(original.bind(...values)),
      run: async () => (await batch([original]))[0]!,
      all: async <T>() => ({ results: (await batch([original]))[0]!.results as T[] }),
      first: async <T>() => ((await batch([original]))[0]!.results[0] as T | undefined) ?? null,
    };
    originals.set(wrapped, original);
    return wrapped;
  };
  return { prepare: sql => statement(db.prepare(sql)), batch };
}
