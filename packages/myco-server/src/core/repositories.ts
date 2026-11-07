import { repositoryConnection, saveRepository, removeRepository, type ConnectionRow } from '../db/storage/repository-connection.js';
import { repositoryUrl, repositoryBranch, RepositoryInputError, type RepositoryAccess } from '@goondocks/myco-shared/repository';
import type { RelationalStore } from './adapters.js';
import type { SecretDescription, SecretStore } from './secrets.js';
import type { ReadScope } from '../read/scope.js';

/** Configured source identity without any credential metadata. */
export async function repositoryIdentity(db: RelationalStore, scope: ReadScope, usableSecret?: (slot: string) => Promise<boolean>): Promise<{ url: string; branch: string } | null> {
  const row=await db.prepare('SELECT url,branch,secret_slot AS secretSlot FROM project_repositories WHERE project_id=?')
    .bind(scope.projectId).first<{url:string;branch:string;secretSlot:string|null}>();
  if (row === null || row.secretSlot !== null && usableSecret !== undefined && !await usableSecret(row.secretSlot)) return null;
  return {url:row.url,branch:row.branch};
}

const MAX_CREDENTIAL_CHARS = 4096;

export interface RepositoryConnection extends Omit<ConnectionRow, 'secretSlot'> {
  credential: SecretDescription | null;
}

export interface RepositoryConnectionWrite {
  url: string;
  branch: string;
  /** Omitted preserves access only for the same repository; null explicitly selects public access. */
  credential?: { username: string; token: string } | null;
  revision: string | null;
}

export class RepositoryConflictError extends Error {
  constructor() { super('The repository connection changed. Refresh before saving again.'); }
}

/** The single writer of project repository connections and their sealed credential references. */
export function projectRepositories(db: RelationalStore, secrets: SecretStore) {
  const row = (projectId: string) => repositoryConnection(db, projectId);
  const describe = async (projectId: string): Promise<RepositoryConnection | null> => {
    const current = await row(projectId);
    if (current === null) return null;
    const { secretSlot, ...metadata } = current;
    return { ...metadata, credential: secretSlot === null ? null : await secrets.describe(secretSlot) };
  };
  return {
    describe,
    async save(projectId: string, input: RepositoryConnectionWrite, actor: string, now: number): Promise<RepositoryConnection | null> {
      const url = repositoryUrl(input.url);
      const branch = repositoryBranch(input.branch);
      const credential = input.credential;
      if (credential != null && (typeof credential.username !== 'string' || !/^[A-Za-z0-9._@-]{1,192}$/.test(credential.username)
        || typeof credential.token !== 'string' || !credential.token || credential.token.length > MAX_CREDENTIAL_CHARS)) {
        throw new RepositoryInputError('Repository access needs a username and a token of at most 4096 characters.');
      }
      const previous = await row(projectId);
      if ((previous?.revision ?? null) !== input.revision) throw new RepositoryConflictError();
      const revision = crypto.randomUUID();
      const preserve = credential === undefined && previous?.url === url;
      const secretSlot = credential == null ? (preserve ? previous!.secretSlot : null) : `repository:${projectId}:${revision}`;
      const username = credential == null ? (preserve ? previous!.username : null) : credential.username;
      const sealed = credential == null ? null : await secrets.preparePut(secretSlot!, credential.token, actor, now);
      if (!await saveRepository(db, projectId, previous, { revision, url, branch, username, secretSlot, updatedAt: now, updatedBy: actor }, sealed)) {
        throw new RepositoryConflictError();
      }
      return describe(projectId);
    },
    async remove(projectId: string, revision: string, actor: string, now: number): Promise<void> {
      const previous = await row(projectId);
      if (previous === null || previous.revision !== revision) throw new RepositoryConflictError();
      if (!await removeRepository(db, projectId, previous, actor, now)) throw new RepositoryConflictError();
    },
    /** Open access only for a held code task; callers must apply the run admission guard first. */
    async access(projectId: string): Promise<RepositoryAccess | null> {
      const current = await row(projectId);
      if (current === null) return null;
      if (current.secretSlot === null) return { url: current.url, branch: current.branch };
      const token = await secrets.get(current.secretSlot);
      if (token === null) throw new Error('Repository read credential is missing. Reconfigure project repository access.');
      return { url: current.url, branch: current.branch, credential: { username: current.username!, token } };
    },
  };
}
