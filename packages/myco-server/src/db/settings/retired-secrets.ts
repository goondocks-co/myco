import type { RelationalStore } from '../../core/adapters.js';
import { rows, write } from '../index.js';

/**
 * Sealed rows of names this release admits nowhere: the retired global GitHub key and the per-Project repository and
 * release tokens. A previous release serving during an update can write one after the schema step removed them, so
 * the admin's read of the stored keys removes any it finds, in one bounded statement on that small table.
 */
const removeRetired = write<[], { name: string }>({
  name: 'settings.removeRetiredSecrets',
  sql: "DELETE FROM deployment_secrets WHERE name='github' OR substr(name,1,11)='repository:' OR substr(name,1,19)='release-provenance:' RETURNING name",
});

/** Answers the names removed. */
export async function removeRetiredSecrets(db: RelationalStore): Promise<string[]> {
  return (await rows(db, removeRetired.bind())).map(row => row.name);
}
