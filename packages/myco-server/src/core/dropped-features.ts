import { normalizeRemote } from '@goondocks/myco-shared/member-protocol';
import type { RelationalStore } from './adapters.js';
import { projectForRemote } from './remotes.js';
import { DROPPED_FEATURE_FACTS } from './dropped-features.generated.js';

const MYCO_REMOTE = normalizeRemote('https://github.com/goondocks-co/myco.git')!;

/** Myco's recorded feature decisions apply only to the Project bound to its repository. */
export async function droppedFeatureFacts(db: RelationalStore, projectId: string): Promise<string> {
  const bound = await projectForRemote(db, MYCO_REMOTE);
  if (bound !== projectId) return '';
  return DROPPED_FEATURE_FACTS;
}
