/**
 * Optional GitHub PR squash-merge evidence.
 *
 * When direct ancestry and patch-id matching both miss but the captured HEAD
 * was previously the tip of a feature branch that was squash-merged, the
 * squash commit on the base branch has a different SHA. GitHub's PR API can
 * supply the squash `merge_commit_sha` so we can re-check ancestry against
 * production refs.
 *
 * This module is best-effort. It degrades silently when:
 *   - `release_provenance.github.repo` is empty
 *   - the env-var named by `token_env` is unset
 *   - the network fails or the API returns non-200
 *
 * The token is read from the env once per lookup and never logged or
 * returned in evidence.
 */

import type { ReleaseGithubConfig } from './config.js';

const GITHUB_API = 'https://api.github.com';
const FETCH_TIMEOUT_MS = 5_000;

export interface SquashLookupOptions {
  repo: string;
  token: string | null;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

export interface PullRequestSquash {
  number: number;
  merge_commit_sha: string;
  merged: boolean;
}

interface PullRequestSearchHit {
  number: number;
  pull_request?: { merged_at?: string | null };
}

interface PullRequestDetails {
  number: number;
  merged: boolean;
  merge_commit_sha: string | null;
}

/**
 * Find the squash-merge commit on the base branch for a captured head SHA.
 * Returns null when no PR closed the commit, when GitHub is unavailable, or
 * when credentials are missing — the caller treats any of these the same
 * way (no PR evidence; fall through to remaining classification steps).
 */
export async function findSquashMergeForCommit(
  headSha: string,
  options: SquashLookupOptions,
): Promise<PullRequestSquash | null> {
  if (!options.repo || !options.token) return null;
  const fetcher = options.fetcher ?? fetch;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    authorization: `Bearer ${options.token}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const signal = options.signal ?? controller.signal;

  try {
    const searchUrl = `${GITHUB_API}/search/issues?q=${encodeURIComponent(`repo:${options.repo} type:pr ${headSha}`)}`;
    const searchResponse = await fetcher(searchUrl, { headers, signal });
    if (!searchResponse.ok) return null;
    const searchBody = await searchResponse.json() as { items?: PullRequestSearchHit[] };
    const hit = (searchBody.items ?? []).find((item) => item.pull_request?.merged_at);
    if (!hit) return null;

    const detailUrl = `${GITHUB_API}/repos/${options.repo}/pulls/${hit.number}`;
    const detailResponse = await fetcher(detailUrl, { headers, signal });
    if (!detailResponse.ok) return null;
    const detailBody = await detailResponse.json() as PullRequestDetails;
    if (!detailBody.merged || !detailBody.merge_commit_sha) return null;

    return {
      number: detailBody.number,
      merge_commit_sha: detailBody.merge_commit_sha,
      merged: detailBody.merged,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read the GitHub token from the env var named in config. Returns null when
 * the env var is unset or empty — never logs or returns the value itself
 * outside the returned string.
 */
export function readGithubToken(config: ReleaseGithubConfig): string | null {
  if (!config.repo) return null;
  const value = process.env[config.token_env];
  return value && value.length > 0 ? value : null;
}
