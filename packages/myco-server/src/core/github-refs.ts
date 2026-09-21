/**
 * The GitHub reads release reconciliation relies on, and nothing else.
 *
 * A Deployment holds no checkout, so containment is asked of GitHub rather
 * than of `git merge-base`. Four reads cover it: the repository itself, a
 * tag listing, a compare, and the pull requests that carried a commit.
 *
 * **Every read counts against one budget, spent or refused.** The budget is
 * the per-run lookup ceiling the Project configured; a read that would exceed
 * it is refused as `budget_exhausted` without leaving the process, so a run
 * never makes more requests than the owner allowed.
 *
 * **A failure is named, never collapsed into "no".** A rejected credential, a
 * rate limit, a timeout and a truncated listing each come back as their own
 * failure, and the classifier treats every one of them as the absence of
 * evidence rather than as evidence of absence.
 *
 * **Compare direction.** `compare/{sha}...{ref}` answers `ahead` or
 * `identical` exactly when `ref` contains `sha`; `behind` and `diverged` mean
 * it does not. A squash-merged pull request's head reads `diverged` against
 * its base, which is why the pull-request read exists. Verified read-only
 * against goondocks-co/myco on 2026-09-21.
 *
 * The token is sent only as the Authorization header of these requests and is
 * never returned, logged or placed in evidence.
 */

import type { OutboundFetch } from './adapters.js';

const GITHUB_API = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 5_000;

/** A tag listing longer than this is treated as truncated rather than read whole. */
export const MAX_LISTED_REFS = 2_000;

export type GithubFailure =
  | 'budget_exhausted'
  | 'credential_rejected'
  | 'rate_limited'
  | 'not_found'
  | 'truncated'
  | 'timeout'
  | 'network'
  | 'unexpected_response';

export type GithubRead<T> = { ok: true; value: T } | { ok: false; failure: GithubFailure; status?: number };

export type CompareStatus = 'ahead' | 'identical' | 'behind' | 'diverged';

export interface ListedRef {
  ref: string;
  sha: string;
}

export interface MergedPull {
  number: number;
  mergeCommitSha: string;
  baseRef: string;
}

export interface GithubReads {
  /** Whether the repository is reachable with this credential; a private repository without one reads `not_found`. */
  repository(): Promise<GithubRead<{ defaultBranch: string }>>;
  /** Every ref under `refs/{prefix}` with the object it points at, or `truncated` when GitHub signals more or the list exceeds the bound. */
  matchingRefs(prefix: string): Promise<GithubRead<ListedRef[]>>;
  /** The commit a branch points at. */
  branchHead(branch: string): Promise<GithubRead<string>>;
  /** Whether `ref` contains `sha`. */
  compare(sha: string, ref: string): Promise<GithubRead<CompareStatus>>;
  /** Whether the commit exists on GitHub. */
  commit(sha: string): Promise<GithubRead<true>>;
  /** The merged pull requests GitHub associates with the commit. */
  mergedPullsForCommit(sha: string): Promise<GithubRead<MergedPull[]>>;
  lookupsUsed(): number;
}

export interface GithubReadOptions {
  repo: string;
  token: string | null;
  maxLookups: number;
  fetcher?: OutboundFetch;
  timeoutMs?: number;
}

const REPO_GRAMMAR = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_GRAMMAR = /^[0-9a-f]{40}$/;

export const isGithubRepo = (value: unknown): value is string => typeof value === 'string' && REPO_GRAMMAR.test(value);
export const isCommitSha = (value: unknown): value is string => typeof value === 'string' && SHA_GRAMMAR.test(value);

const COMPARE_STATUSES = new Set<string>(['ahead', 'identical', 'behind', 'diverged']);

function failureFor(response: Response): GithubFailure {
  if (response.status === 401) return 'credential_rejected';
  if (response.status === 429) return 'rate_limited';
  if (response.status === 403) return response.headers.get('x-ratelimit-remaining') === '0' ? 'rate_limited' : 'credential_rejected';
  if (response.status === 404 || response.status === 422) return 'not_found';
  return 'unexpected_response';
}

const encodeRef = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

export function githubReads(options: GithubReadOptions): GithubReads {
  if (!isGithubRepo(options.repo)) throw new Error('A GitHub repository is named owner/name.');
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'myco-release-provenance',
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let used = 0;

  async function read<T>(path: string, parse: (body: unknown, response: Response) => GithubRead<T>): Promise<GithubRead<T>> {
    if (used >= options.maxLookups) return { ok: false, failure: 'budget_exhausted' };
    used += 1;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetcher(`${GITHUB_API}/repos/${options.repo}${path ? `/${path}` : ''}`, { headers, signal });
      if (!response.ok) return { ok: false, failure: failureFor(response), status: response.status };
      return parse(await response.json(), response);
    } catch (error) {
      return { ok: false, failure: signal.aborted ? 'timeout' : error instanceof SyntaxError ? 'unexpected_response' : 'network' };
    }
  }

  const bad = { ok: false, failure: 'unexpected_response' } as const;

  return {
    repository: () => read('', (body) => {
      const branch = (body as { default_branch?: unknown } | null)?.default_branch;
      return typeof branch === 'string' ? { ok: true, value: { defaultBranch: branch } } : bad;
    }),
    matchingRefs: (prefix) => read(`git/matching-refs/${encodeRef(prefix)}`, (body, response) => {
      if (!Array.isArray(body)) return bad;
      if (/rel="next"/.test(response.headers.get('link') ?? '') || body.length > MAX_LISTED_REFS) return { ok: false, failure: 'truncated' };
      const refs: ListedRef[] = [];
      for (const entry of body as Array<{ ref?: unknown; object?: { sha?: unknown } }>) {
        if (typeof entry.ref === 'string' && typeof entry.object?.sha === 'string') refs.push({ ref: entry.ref, sha: entry.object.sha });
      }
      return { ok: true, value: refs };
    }),
    branchHead: (branch) => read(`git/ref/heads/${encodeRef(branch)}`, (body) => {
      const head = (body as { object?: { sha?: unknown } } | null)?.object?.sha;
      return isCommitSha(head) ? { ok: true, value: head } : bad;
    }),
    compare: (sha, ref) => read(`compare/${sha}...${encodeRef(ref)}?per_page=1`, (body) => {
      const status = (body as { status?: unknown } | null)?.status;
      return typeof status === 'string' && COMPARE_STATUSES.has(status) ? { ok: true, value: status as CompareStatus } : bad;
    }),
    commit: (sha) => read(`commits/${sha}?per_page=1`, (body) => (
      (body as { sha?: unknown } | null)?.sha === sha ? { ok: true, value: true } : bad
    )),
    mergedPullsForCommit: (sha) => read(`commits/${sha}/pulls?per_page=10`, (body) => {
      if (!Array.isArray(body)) return bad;
      const pulls: MergedPull[] = [];
      for (const entry of body as Array<Record<string, unknown>>) {
        const base = (entry.base as { ref?: unknown } | undefined)?.ref;
        if (typeof entry.number === 'number' && typeof entry.merged_at === 'string' && isCommitSha(entry.merge_commit_sha) && typeof base === 'string') {
          pulls.push({ number: entry.number, mergeCommitSha: entry.merge_commit_sha, baseRef: base });
        }
      }
      return { ok: true, value: pulls };
    }),
    lookupsUsed: () => used,
  };
}
