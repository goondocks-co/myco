import { normalizeRemote } from '@goondocks/myco-shared/member-protocol';
import type { RelationalStore } from './adapters.js';
import { projectForRemote } from './remotes.js';
import { repositoryIdentity } from './repositories.js';
import { DROPPED_FEATURES } from './dropped-features.generated.js';

const MYCO_REMOTE = normalizeRemote('https://github.com/goondocks-co/myco.git')!;

/** Myco's recorded feature decisions apply only to the Project bound to its repository. */
export async function droppedFeatureFacts(db: RelationalStore, projectId: string): Promise<string> {
  const bound = await projectForRemote(db, MYCO_REMOTE);
  if (bound !== projectId && normalizeRemote((await repositoryIdentity(db, { projectId }))?.url ?? '') !== MYCO_REMOTE) return '';
  return DROPPED_FEATURES.map(({ section, row }) => `docs/architecture/myco-2.0.md §${section}: ${row}`).join('\n');
}
