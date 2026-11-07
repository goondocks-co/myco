import { normalizeRemote } from '@goondocks/myco-shared/member-protocol';
import type { RelationalStore } from './adapters.js';
import { projectForRemote } from './remotes.js';
import { DROPPED_FEATURES } from './dropped-features.generated.js';

const MYCO_REMOTE = normalizeRemote('https://github.com/goondocks-co/myco.git')!;

/** Myco's recorded feature decisions apply only to the Project bound to its repository. */
export async function droppedFeatureFacts(db: RelationalStore, projectId: string): Promise<string> {
  const bound = await projectForRemote(db, MYCO_REMOTE);
  if (bound !== projectId) return '';
  return 'docs/architecture/myco-2.0.md — DROP decisions (feature | section | reason | issue):\n' + DROPPED_FEATURES.map(({feature,section,reason,issue}) => `${feature} | §${section} | ${reason} | ${issue}`).join('\n');
}
