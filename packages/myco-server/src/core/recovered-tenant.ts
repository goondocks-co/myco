import type { RelationalStore } from './adapters.js';
import { deploymentIdentity } from '../auth/authorization.js';
import { IN_FLIGHT_RUN_STATUSES } from './runs.js';

export type RecoveryTenantMode = 'replacement' | 'fork';

export function assertRecoveryTenantChoice(mode: RecoveryTenantMode = 'replacement', sourceRetired = false): void {
  if (mode !== 'replacement' && mode !== 'fork') throw new Error('unknown recovery tenant mode');
  if (mode === 'replacement' && !sourceRetired) throw new Error('replacement recovery requires --source-retired after retiring the old instance; use --fork for an independent tenant');
}

/** Replacement keeps the tenant; a fork preserves history and retires every copied live authority. */
export async function prepareRecoveredTenant(db: RelationalStore, mode: RecoveryTenantMode, now: number): Promise<string> {
  const original = await deploymentIdentity(db);
  if (mode === 'replacement') return original;
  if (mode !== 'fork') throw new Error('unknown recovery tenant mode');
  const identity = crypto.randomUUID();
  const authorityTables = ['member_credentials', 'enrollment_authorities', 'identity_link_authorities', 'external_grants', 'step_up_authorities'] as const;
  await db.batch([
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'deployment_id' AND value = ?").bind(identity, original),
    ...authorityTables.map((table) => db.prepare(`UPDATE ${table} SET revoked_at = ? WHERE revoked_at IS NULL`).bind(now)),
    db.prepare(`UPDATE agent_runs SET status = 'failed', completed_at = ?, error = 'Deployment fork ended the copied run',
      lease_expires_at = NULL, resumable = 0 WHERE ${IN_FLIGHT_RUN_STATUSES}`).bind(now),
  ]);
  const held = await deploymentIdentity(db);
  if (held !== identity || held === original) throw new Error('fork tenant identity was not rotated');
  return held;
}
