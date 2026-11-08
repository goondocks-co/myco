import type { RelationalStore } from '../../core/adapters.js';
import { emit } from '../../telemetry.js';
import { commit, write, type Bound } from '../index.js';
export const putSecret = write<[string, string, string, number, number, string]>({
  name: 'settings.putSecret',
  sql: `
  INSERT INTO deployment_secrets(name,ciphertext,iv,key_version,updated_at,updated_by) VALUES(?,?,?,?,?,?)
  ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,key_version=excluded.key_version,
    updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
});
export const removeSecret = write<[string], { name: string }>({
  name: 'settings.removeSecret',
  sql: 'DELETE FROM deployment_secrets WHERE name=? RETURNING name',
});

/** Record a committed deletion without exposing the stored value. */
export function recordSecretDeletion(name: string, actor: string, nowMs: number, deleted: boolean): void {
  emit({ kind: 'deployment_secret_deleted', name, actor, deleted, at: nowMs });
}

/** Admission, reference writes and optional retirement share one commit. */
export async function commitSecretChange(
  db: RelationalStore,
  admission: Bound<unknown, 'assertion'>,
  writes: readonly Bound[],
  retirement: { name: string; actor: string; now: number } | null,
): Promise<void> {
  const results = await commit(db, admission, ...writes, ...(retirement === null ? [] : [removeSecret.bind(retirement.name)]));
  if (retirement !== null) recordSecretDeletion(retirement.name, retirement.actor, retirement.now, results.at(-1)!.results.length === 1);
}
