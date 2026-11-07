import { RUN_REPOSITORY_DIR } from '@goondocks/myco-shared/repository';
import type { RelationalStore } from './adapters.js';
import { repositoryIdentity } from './repositories.js';

/** Knowledge runs use the connected repository at its current commit, or reason from knowledge alone. */
export async function knowledgeRepositoryInput(db: RelationalStore, projectId: string) {
  const repository = await repositoryIdentity(db, { projectId });
  return repository === null
    ? { instruction: '\n\nNo repository is connected. Judge on the served knowledge alone.', repository: undefined }
    : {
      instruction: `\n\nThe connected repository ${repository.url} (branch ${repository.branch}) is pinned at its current commit in the ${RUN_REPOSITORY_DIR} checkout beside the run instructions. Your working directory is the checkout; read and search paths relative to it. Check claims against this code before saving, merging or retiring knowledge. Use only the harness file read, grep and glob tools inside the checkout; no edit or shell tools. A missing file alone never invalidates knowledge. Historical paths are hints at most. When in doubt, keep it.`,
      repository: { ...repository, historyDepth: 1 },
    };
}
