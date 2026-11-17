/** The one boundary every GitHub API request passes through, shared by the Deployment and runners. */

/** Every credentialed GitHub request goes to this one origin. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;

export class GitHubAppError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * One request to GitHub's API with a bearer it is handed. Workers refuses `redirect: 'error'`, so a redirect is
 * answered, never followed, and the caller reads its status like any other refusal. A failure to reach GitHub throws
 * `GitHubAppError` naming the next step.
 */
export async function githubApi(fetchImpl: FetchImpl, path: string, options: { bearer: string; method?: string; body?: unknown; next: string }): Promise<Response> {
  try {
    return await fetchImpl(`${GITHUB_API_ORIGIN}${path}`, {
      method: options.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: 'application/vnd.github+json', authorization: `Bearer ${options.bearer}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'Myco',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch { throw new GitHubAppError(`GitHub could not be reached. ${options.next}`); }
}

/**
 * Ends an installation token before its hour is up. Answers whether GitHub confirmed it; a token GitHub did not
 * confirm still expires on its own. https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token
 */
export async function revokeInstallationToken(fetchImpl: FetchImpl, token: string): Promise<boolean> {
  try { return (await githubApi(fetchImpl, '/installation/token', { bearer: token, method: 'DELETE', next: 'The token expires on its own.' })).status === 204; }
  catch { return false; }
}

