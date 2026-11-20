/** The one boundary every GitHub API request passes through, shared by the Deployment and runners. */

/** Every credentialed GitHub request goes to this one origin. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

export class GitHubAppError extends Error {
  constructor(message: string, readonly status?: number, readonly rateLimited = false) { super(message); }
}

/**
 * Whether GitHub refused for its rate limit, and when it lifts (epoch milliseconds) when it says.
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 */
export async function rateLimitOf(response: Response): Promise<{ until: number | null } | null> {
  const { status, headers } = response;
  const limited = status === 429 || (status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after')
    || /rate limit/i.test(await response.clone().text().catch(() => ''))));
  if (!limited) return null;
  const retryAfter = Number(headers.get('retry-after'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  const until = Number.isFinite(retryAfter) && retryAfter > 0 ? Date.now() + retryAfter * 1_000 : Number.isFinite(reset) && reset > 0 ? reset * 1_000 : null;
  return { until };
}

/** A rate-limit refusal in the reader's words: retryable, and when. */
export const rateLimitWords = (until: number | null): string =>
  `GitHub’s rate limit was reached; try again after ${until === null ? 'it resets' : `${new Date(until).toISOString().slice(11, 16)} UTC`}.`;

/** The most of one GitHub answer read for an App's identity or public page. */
export const MAX_GITHUB_APP_ANSWER_BYTES = 64 * 1024;

/** A GitHub answer's JSON, read only up to `max` bytes; a longer answer is cancelled and refused without being parsed. */
export async function readGitHubJson(response: Response, max: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { await response.body?.cancel(); throw new GitHubAppError(`GitHub’s answer is ${declared} bytes; at most ${max} are read.`); }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader !== undefined) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new GitHubAppError(`GitHub’s answer is over ${max} bytes; at most ${max} are read.`); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new GitHubAppError('GitHub answered with something unreadable.'); }
}

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * One request to GitHub's API, with the bearer it is handed or none for a public read, bounded by the caller's `signal`. Workers refuses `redirect: 'error'`, so a redirect is
 * answered, never followed, and the caller reads its status like any other refusal. A failure to reach GitHub throws
 * `GitHubAppError` naming the next step.
 */
export async function githubApi(fetchImpl: FetchImpl, path: string, options: { bearer?: string; signal: AbortSignal; method?: string; body?: unknown; next: string }): Promise<Response> {
  try {
    return await fetchImpl(`${GITHUB_API_ORIGIN}${path}`, {
      method: options.method ?? 'GET', redirect: 'manual', signal: options.signal,
      headers: {
        accept: 'application/vnd.github+json', ...(options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }), 'x-github-api-version': '2022-11-28', 'user-agent': 'Myco',
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
export async function revokeInstallationToken(fetchImpl: FetchImpl, token: string, signal: AbortSignal): Promise<boolean> {
  try { return (await githubApi(fetchImpl, '/installation/token', { bearer: token, signal, method: 'DELETE', next: 'The token expires on its own.' })).status === 204; }
  catch { return false; }
}

