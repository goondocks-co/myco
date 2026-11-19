import { REPOSITORY_COMMIT_PATTERN, REPOSITORY_TOKEN_MIN_LIFETIME_MS, RepositoryInputError, type RepositoryAccess, type RepositoryFailure, type RepositoryComparison, type RepositoryIdentity, type RepositoryPin } from '@goondocks/myco-shared/repository';
import type { ServerEnv } from './adapters.js';
import { projectRepositories } from './repositories.js';
import { GitHubAccessRefused, githubAppProjects, HandedOver } from './github-app.js';
import { pinRepositoryForRun, repositoryPinOfRun } from '../db/runs/preparation.js';
import { type RunRow } from '../db/runs/lifecycle.js';
import { type RunLease } from '../db/runs/leases.js';

/** A source read's answer: the source with its token, or why there is none. */
type SourceAnswer = { repositoryFailure?: RepositoryFailure; persisted: true; held: true; repository?: RepositoryAccess; comparison?: RepositoryComparison; error?: string };

/** What a preparation checks its answer against, and adds to a source read before handing its token over. */
export interface RunRepositoryOptions {
  expected?: RepositoryIdentity;
  lease?: RunLease;
  pinCommit?: (pin: RepositoryPin) => Promise<RepositoryPin | null>;
  /** Evidence the answer carries beside its source; read while the token is still this preparation's to revoke. */
  comparison?: () => Promise<RepositoryComparison | null>;
}

/**
 * Prepare or pin the connected source for an admitted run. A source read's token is handed over only inside a
 * complete answer; any failure before that, the comparison read included, revokes it.
 */
export async function prepareRunRepository(env: ServerEnv, projectId: string, run: RunRow, input: Record<string, unknown>, options: RunRepositoryOptions = {}) {
  const { expected, lease, pinCommit } = options;
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
  const now = () => lease?.now ?? Date.now();
  try {
    const answer = await githubAppProjects(env, now).withToken<SourceAnswer>(current, 'checkout', async (issued) => {
      // The connection is read again after GitHub's answer: a token for a repository the Project no longer names is never handed out.
      const after = await repositories.describe(projectId);
      if (after?.revision !== current.revision) return { persisted: true, held: true, error: 'Repository connection changed. Retry preparation.' } as const;
      if (issued.expiresAt - now() < REPOSITORY_TOKEN_MIN_LIFETIME_MS) return { persisted: true, held: true, error: 'GitHub issued a token too close to expiry. Retry preparation.' } as const;
      const repository: RepositoryAccess = {
        url: current.url, branch: current.branch, remote: issued.repository.url, expiresAt: issued.expiresAt,
        credential: { username: 'x-access-token', token: issued.token }, ...(pin === null ? {} : { commit: pin.commit }),
      };
      const comparison = await options.comparison?.() ?? null;
      return new HandedOver<SourceAnswer>({ persisted: true, held: true, repository, ...(comparison === null ? {} : { comparison }) });
    });
    return answer instanceof HandedOver ? answer.value : answer;
  } catch (error) {
    if (error instanceof GitHubAccessRefused) return { persisted: true, held: true, error: error.message, repositoryFailure: { code: error.failure } } as const;
    throw error;
  }
}

/** Ends a token minted for an answer that is not delivered. */
export async function revokeUndelivered(env: ServerEnv, answer: unknown): Promise<void> {
  const repository = (answer as { repository?: RepositoryAccess | null } | null)?.repository;
  if (repository?.credential !== undefined) await githubAppProjects(env).revoke(repository.credential.token, 'checkout');
}
