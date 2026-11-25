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
export const recordRunnerKeyRemoval = write<[slot: string, at: number]>({
  name: 'settings.recordRunnerKeyRemoval',
  sql: `INSERT INTO runner_key_removals (slot, removed_at)
    SELECT ?1,?2 WHERE EXISTS (SELECT 1 FROM deployment_secrets WHERE name=?1)
    ON CONFLICT (slot) DO UPDATE SET removed_at=excluded.removed_at`,
});
export const removeSecret = write<[string], { name: string }>({
  name: 'settings.removeSecret',
  sql: 'DELETE FROM deployment_secrets WHERE name=? RETURNING name',
});
/**
 * Sealed rows of names this release admits nowhere: the retired global GitHub key and the per-Project repository and
 * release tokens, which a previous release serving during an update can write after the schema step removed them.
 */
export const removeRetiredSecrets = write<[], { name: string }>({
  name: 'settings.removeRetiredSecrets',
  sql: "DELETE FROM deployment_secrets WHERE name='github' OR substr(name,1,11)='repository:' OR substr(name,1,19)='release-provenance:' RETURNING name",
});

/** Record a committed deletion without exposing the stored value. */
export function recordSecretDeletion(name: string, actor: string, nowMs: number, deleted: boolean): void {
  emit({ kind: 'deployment_secret_deleted', name, actor, deleted, at: nowMs });
}
