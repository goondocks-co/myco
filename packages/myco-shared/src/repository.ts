export class RepositoryInputError extends Error {}
export const REPOSITORY_COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
export const REPOSITORY_TASKS: readonly string[] = ['canopy-map', 'skill-generate', 'skill-evolve', 'vault-seed'];

/** HTTPS source with credentials supplied independently of the remote URL. */
export function repositoryUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RepositoryInputError('Repository URL is invalid.'); }
  if (raw.length > 2048 || raw !== raw.trim() || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname === '/') {
    throw new RepositoryInputError('Repository URL must be HTTPS, with a repository path and no credentials, query, or fragment.');
  }
  return url.href;
}

/** A named branch, without Git revision expressions or refspec destinations. */
export function repositoryBranch(raw: string): string {
  // eslint-disable-next-line no-control-regex
  if (!raw || raw.length > 192 || /[\x00-\x20\x7f~^:?*\[\\]/.test(raw) || raw.includes('..') || raw.includes('@{')
    || raw.startsWith('-') || raw.endsWith('.') || raw.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new RepositoryInputError('Repository branch must be a valid named Git branch.');
  }
  return raw;
}

export interface RepositoryIdentity { url: string; branch: string }
export interface RepositoryPin extends RepositoryIdentity { commit: string }
export interface RepositoryAccess extends RepositoryIdentity {
  credential?: { username: string; token: string };
  commit?: string;
}
