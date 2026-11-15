import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, rows, write } from '../index.js';

export interface RecoveryCredential {
  name: string;
  repositoryProject: string | null;
  releaseProject: string | null;
}

const descriptions = read<[names: string | null], RecoveryCredential>({
  name: 'settings.recoveredCredentialDescriptions',
  sql: `SELECT s.value AS name, rp.name AS repositoryProject, lp.name AS releaseProject
    FROM json_each(COALESCE(?1,(SELECT json_group_array(name) FROM deployment_secrets))) s
    LEFT JOIN project_repositories r ON r.secret_slot=s.value
    LEFT JOIN projects rp ON rp.project_id=r.project_id
    LEFT JOIN project_release_provenance l ON l.secret_slot=s.value
    LEFT JOIN projects lp ON lp.project_id=l.project_id
    ORDER BY s.value`,
});
const discard = write<[], { name: string }>({
  name: 'settings.discardRecoveredCredentials',
  sql: 'DELETE FROM deployment_secrets RETURNING name',
});

/** Describe the recorded credential references and remove their sealed rows in the unpublished recovery copy. */
export async function discardRecoveredCredentials(db: RelationalStore): Promise<RecoveryCredential[]> {
  const [described] = await commit(db, descriptions.bind(null), discard.bind());
  return described.results;
}

/** Resolve names carried by a recovery journal against their recorded Project references. */
export function describeRecoveryCredentials(db: RelationalStore, names: readonly string[]): Promise<readonly RecoveryCredential[]> {
  return rows(db, descriptions.bind(JSON.stringify(names)));
}
