import type { RelationalStore } from '../../core/adapters.js';
import { commit, write } from '../index.js';

const discard = write<[], { name: string }>({
  name: 'settings.discardRecoveredCredentials',
  sql: 'DELETE FROM deployment_secrets RETURNING name',
});

/** Remove sealed credentials only in the unpublished recovery copy. */
export async function discardRecoveredCredentials(db: RelationalStore): Promise<string[]> {
  const [removed] = await commit(db, discard.bind());
  return removed.results.map(row => row.name).sort();
}
