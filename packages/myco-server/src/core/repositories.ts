import { repositoryConnection, saveRepository, removeRepository, type ConnectionRow } from '../db/storage/repository-connection.js';
import { repositoryBranch, RepositoryInputError } from '@goondocks/myco-shared/repository';
import type { RelationalStore, ServerEnv } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { githubAppConfigured, githubAppProjects } from './github-app.js';

/** Configured source identity, read from storage alone. */
export async function repositoryIdentity(db: RelationalStore, scope: ReadScope): Promise<{ url: string; branch: string } | null> {
  const row = await repositoryConnection(db, scope.projectId);
  return row === null ? null : { url: row.url, branch: row.branch };
}

/** Whether a source-reading task can be handed out: a connection is stored and the App key is configured. GitHub is not asked. */
export async function repositoryReady(env: Pick<ServerEnv, 'db' | 'secrets'>, scope: ReadScope): Promise<'ready' | 'missing' | 'unconfigured'> {
  if (await repositoryConnection(env.db, scope.projectId) === null) return 'missing';
  return githubAppConfigured(env) ? 'ready' : 'unconfigured';
}

export type RepositoryConnection = ConnectionRow;

export interface RepositoryConnectionWrite {
  installationId: number;
  repositoryId: number;
  branch: string;
  revision: string | null;
}

export class RepositoryConflictError extends Error {
  constructor() { super('The repository connection changed. Refresh before saving again.'); }
}

/** The single writer of Project repository connections. */
export function projectRepositories(env: Pick<ServerEnv, 'db' | 'secrets' | 'outbound'>) {
  const describe = (projectId: string): Promise<RepositoryConnection | null> => repositoryConnection(env.db, projectId);
  return {
    describe,
    /** Saves an admin's choice once GitHub confirms it through an approved installation; the canonical URL comes from GitHub. */
    async save(projectId: string, input: RepositoryConnectionWrite, actor: string, now: number): Promise<RepositoryConnection | null> {
      if (!Number.isSafeInteger(input.installationId) || input.installationId <= 0 || !Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0) {
        throw new RepositoryInputError('Choose an installed repository: installationId and repositoryId are GitHub’s numeric ids.');
      }
      const branch = repositoryBranch(input.branch);
      const previous = await describe(projectId);
      if ((previous?.revision ?? null) !== input.revision) throw new RepositoryConflictError();
      const repository = await githubAppProjects(env).verify(input.installationId, input.repositoryId);
      const next: ConnectionRow = {
        revision: crypto.randomUUID(), url: repository.url, branch, repositoryId: repository.id, installationId: input.installationId,
        updatedAt: now, updatedBy: actor,
      };
      if (!await saveRepository(env.db, projectId, input.revision, next)) throw new RepositoryConflictError();
      return describe(projectId);
    },
    async remove(projectId: string, revision: string): Promise<void> {
      if (!await removeRepository(env.db, projectId, revision)) throw new RepositoryConflictError();
    },
  };
}
