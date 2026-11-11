import type { RelationalStore } from './adapters.js';
import { deploymentIdentity } from '../auth/authorization.js';
import { commit } from '../db/index.js';
import { carriedStateStatements, forkTenantStatements } from '../db/recovery/recovered-tenant.js';

export type RecoveryTenantMode = 'replacement' | 'fork';

export function assertRecoveryTenantChoice(mode: RecoveryTenantMode = 'replacement', sourceRetired = false): void {
  if (mode !== 'replacement' && mode !== 'fork') throw new Error('unknown recovery tenant mode');
  if (mode === 'replacement' && !sourceRetired) throw new Error('replacement recovery requires --source-retired after retiring the old instance; use --fork for an independent tenant');
}

/**
 * Replacement keeps the tenant; a fork preserves history and retires every copied live authority. Either way, a
 * pending device request — a sign-in or a runner registration — no longer admits a decision, and the runner reports
 * the copy carried are dropped for runners to report again.
 */
export async function prepareRecoveredTenant(db: RelationalStore, mode: RecoveryTenantMode, now: number): Promise<string> {
  const original = await deploymentIdentity(db);
  if (mode !== 'replacement' && mode !== 'fork') throw new Error('unknown recovery tenant mode');
  if (mode === 'replacement') {
    await commit(db, ...carriedStateStatements(now));
    return original;
  }
  const identity = crypto.randomUUID();
  await commit(db, ...forkTenantStatements(identity, original, now));
  const held = await deploymentIdentity(db);
  if (held !== identity || held === original) throw new Error('fork tenant identity was not rotated');
  return held;
}
