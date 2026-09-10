import { REPOSITORY_COMMIT_PATTERN, RepositoryInputError, type RepositoryIdentity } from '@goondocks/myco-shared/repository';
import type { ServerEnv } from './adapters.js';
import { projectRepositories } from './repositories.js';
import { deploymentSecretStore } from './secrets.js';
import { pinRepositoryForRun, repositoryPinOfRun, type RunRow, type RunLease } from './runs.js';

/** Prepare or pin the connected source for an admitted run. */
export async function prepareRunRepository(
  env: ServerEnv, projectId: string, run: RunRow, input: Record<string, unknown>, expected?: RepositoryIdentity, lease?: RunLease,
) {
  const repositories = projectRepositories(env.db, deploymentSecretStore(env.db, env.wrappingKey));
  const current = await repositories.describe(projectId);
  if (current === null) return { persisted: true, held: true, repository: null };
  const pin = repositoryPinOfRun(run);
  const identities = [expected, pin].filter((value): value is RepositoryIdentity => value != null);
  if (identities.some((value) => value.url !== current.url || value.branch !== current.branch)) {
    return { persisted: true, held: true, error: 'Repository connection changed. Start a new run.' };
  }
  if (input.commit !== undefined) {
    if (typeof input.commit !== 'string' || !REPOSITORY_COMMIT_PATTERN.test(input.commit)
      || input.url !== current.url || input.branch !== current.branch) {
      throw new RepositoryInputError('Commit and repository identity must match the run connection.');
    }
    const pinned = await pinRepositoryForRun(env.db, { projectId }, run, {
      url: current.url, branch: current.branch, commit: input.commit,
    }, lease);
    return { persisted: true, held: pinned !== null, pin: pinned };
  }
  const repository = await repositories.access(projectId);
  if (repository === null || repository.url !== current.url || repository.branch !== current.branch) {
    return { persisted: true, held: true, error: 'Repository connection changed. Retry preparation.' };
  }
  return { persisted: true, held: true, repository: { ...repository, ...(pin === null ? {} : { commit: pin.commit }) } };
}
