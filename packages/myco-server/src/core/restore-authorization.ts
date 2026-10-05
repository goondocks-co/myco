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

/** Admission precedes every restore write; each transaction retains the actor's current authority. */
export async function authorizeRestore(db: RelationalStore, actor: RestoreAuthorization, tables: Iterable<string>): Promise<RelationalStore> {
  if (actor?.kind === 'recovery') return db;
  if (actor?.kind !== 'member') throw new RestoreAuthorizationError('not_admin');
  const requiresOwner = [...tables].some(table => RESTORE_AUTHORITY_TABLES.has(table));
  const admitted = async (): Promise<boolean> => authorize(await memberSubject(db, actor.memberId, 'http'), requiresOwner ? 'owner' : 'admin', {
    kind: requiresOwner ? 'member' : 'backup', deploymentId: await deploymentIdentity(db), exists: true,
  });
  const refusal = async (): Promise<RestoreAuthorizationError> => {
    if (!requiresOwner) return new RestoreAuthorizationError('not_admin');
    const owner = await db.prepare('SELECT member_id FROM deployment_ownership WHERE id = 1').first<{ member_id: string | null }>();
    return new RestoreAuthorizationError(owner?.member_id == null ? 'owner_pending' : 'not_owner');
  };
  if (!await admitted()) throw await refusal();
  const originals = new WeakMap<PreparedStatement, PreparedStatement>();
  const predicate = requiresOwner ? deploymentOwnerSql('?') : memberWritePredicate('?', 'NULL');
  const batch = async (statements: PreparedStatement[]): Promise<RunResult[]> => {
    const guard = db.prepare(`INSERT INTO restore_reference_guard (missing)
      SELECT 'restore authority changed' WHERE NOT (${predicate})`).bind(actor.memberId);
    try {
      return (await db.batch([guard, ...statements.map(statement => originals.get(statement) ?? statement)])).slice(1);
    } catch (error) {
      if (!await admitted()) throw await refusal();
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
