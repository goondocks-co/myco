import { REPOSITORY_COMMIT_PATTERN, REPOSITORY_TOKEN_MIN_LIFETIME_MS, RepositoryInputError, type RepositoryAccess, type RepositoryIdentity, type RepositoryPin } from '@goondocks/myco-shared/repository';
import type { ServerEnv } from './adapters.js';
import { projectRepositories } from './repositories.js';
import { GitHubAccessRefused, githubAppProjects } from './github-app.js';
import { pinRepositoryForRun, repositoryPinOfRun } from '../db/runs/preparation.js';
import { type RunRow } from '../db/runs/lifecycle.js';
import { type RunLease } from '../db/runs/leases.js';

/** Prepare or pin the connected source for an admitted run. */
export async function prepareRunRepository(
  env: ServerEnv, projectId: string, run: RunRow, input: Record<string, unknown>, expected?: RepositoryIdentity, lease?: RunLease,
  pinCommit?: (pin: RepositoryPin) => Promise<RepositoryPin | null>,
) {
  const repositories = projectRepositories(env);
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
    const candidate = { url: current.url, branch: current.branch, commit: input.commit };
    const pinned = await (pinCommit === undefined
      ? pinRepositoryForRun(env.db, { projectId }, run, candidate, lease)
      : pinCommit(candidate));
    return { persisted: true, held: pinned !== null, pin: pinned };
  }
  const access = githubAppProjects(env, () => lease?.now ?? Date.now());
  let issued;
  try { issued = await access.issue(current, 'checkout'); }
  catch (error) {
    if (error instanceof GitHubAccessRefused) return { persisted: true, held: true, error: error.message };
    throw error;
  }
  // The connection is read again after GitHub's answer: a token for a repository the Project no longer names is never handed out.
  const after = await repositories.describe(projectId);
  if (after?.revision !== current.revision || issued.expiresAt - (lease?.now ?? Date.now()) < REPOSITORY_TOKEN_MIN_LIFETIME_MS) {
    await access.revoke(issued.token, 'checkout');
    return { persisted: true, held: true, error: after?.revision !== current.revision ? 'Repository connection changed. Retry preparation.' : 'GitHub issued a token too close to expiry. Retry preparation.' };
  }
  const repository: RepositoryAccess = {
    url: current.url, branch: current.branch, remote: issued.repository.url, expiresAt: issued.expiresAt,
    credential: { username: 'x-access-token', token: issued.token }, ...(pin === null ? {} : { commit: pin.commit }),
  };
  return { persisted: true, held: true, repository };
}

/** Ends a token minted for an answer that is not delivered. */
export async function revokeUndelivered(env: ServerEnv, answer: unknown): Promise<void> {
  const repository = (answer as { repository?: RepositoryAccess | null } | null)?.repository;
  if (repository?.credential !== undefined) await githubAppProjects(env).revoke(repository.credential.token, 'checkout');
}
