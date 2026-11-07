import { knowledgeRepositoryInstruction } from '@goondocks/myco-shared/repository';
import type { RelationalStore } from './adapters.js';
import { repositoryIdentity } from './repositories.js';

/** Knowledge runs use the connected repository at its current commit, or reason from knowledge alone. */
export async function knowledgeRepositoryInput(db: RelationalStore, projectId: string) {
  const repository = await repositoryIdentity(db, { projectId });
  return { instruction: knowledgeRepositoryInstruction(repository), repository: repository === null ? undefined : { ...repository, historyDepth: 1 } };
}
