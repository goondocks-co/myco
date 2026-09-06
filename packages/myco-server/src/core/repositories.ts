import { repositoryUrl, repositoryBranch, RepositoryInputError, type RepositoryAccess } from '@goondocks/myco-shared/repository';
import type { RelationalStore } from './adapters.js';
import type { SecretDescription, SecretStore } from './secrets.js';

const MAX_CREDENTIAL_CHARS = 4096;

interface ConnectionRow {
  revision: string;
  url: string;
  branch: string;
  username: string | null;
  secretSlot: string | null;
  updatedAt: number;
  updatedBy: string;
}

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
  const row = (projectId: string) => db.prepare(`SELECT revision, url, branch, username, secret_slot AS secretSlot,
    updated_at AS updatedAt, updated_by AS updatedBy FROM project_repositories WHERE project_id = ?`).bind(projectId).first<ConnectionRow>();
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
        throw new RepositoryInputError('Read credentials require a username and a token of at most 4096 characters.');
      }
      const previous = await row(projectId);
      if ((previous?.revision ?? null) !== input.revision) throw new RepositoryConflictError();
      const revision = crypto.randomUUID();
      const preserve = credential === undefined && previous?.url === url;
      const secretSlot = credential == null ? (preserve ? previous!.secretSlot : null) : `repository:${projectId}:${revision}`;
      const username = credential == null ? (preserve ? previous!.username : null) : credential.username;
      if (credential != null) await secrets.put(secretSlot!, credential.token, actor, now);
      const statement = previous === null
        ? db.prepare(`INSERT OR IGNORE INTO project_repositories (project_id, revision, url, branch, username, secret_slot, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(projectId, revision, url, branch, username, secretSlot, now, actor)
        : db.prepare(`UPDATE project_repositories SET revision = ?, url = ?, branch = ?, username = ?, secret_slot = ?, updated_at = ?, updated_by = ?
          WHERE project_id = ? AND revision = ?`).bind(revision, url, branch, username, secretSlot, now, actor, projectId, previous.revision);
      const result = await statement.run();
      if (result.meta.changes !== 1) {
        if (credential != null) await secrets.delete(secretSlot!, actor, now);
        throw new RepositoryConflictError();
      }
      if (previous?.secretSlot != null && previous.secretSlot !== secretSlot) await secrets.delete(previous.secretSlot, actor, now);
      return describe(projectId);
    },
    async remove(projectId: string, revision: string, actor: string, now: number): Promise<void> {
      const previous = await row(projectId);
      if (previous === null || previous.revision !== revision) throw new RepositoryConflictError();
      const result = await db.prepare('DELETE FROM project_repositories WHERE project_id = ? AND revision = ?').bind(projectId, revision).run();
      if (result.meta.changes !== 1) throw new RepositoryConflictError();
      if (previous.secretSlot !== null) await secrets.delete(previous.secretSlot, actor, now);
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
