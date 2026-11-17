/** GitHub App identity, signing and GitHub API requests, shared by operator validation, the Deployment and runners. */
export const GITHUB_APP_PERMISSIONS = { contents: 'read', pull_requests: 'read', metadata: 'read' } as const;
/**
 * The permissions an installation token is minted with, per purpose; a token never asks for more than its purpose
 * names. https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
 */
export const GITHUB_TOKEN_PERMISSIONS = {
  discovery: { metadata: 'read' },
  checkout: { contents: 'read', metadata: 'read' },
  release: { contents: 'read', pull_requests: 'read', metadata: 'read' },
} as const satisfies Record<string, Partial<Record<keyof typeof GITHUB_APP_PERMISSIONS, 'read'>>>;
export type GitHubTokenPurpose = keyof typeof GITHUB_TOKEN_PERMISSIONS;
// Workers limits each secret to 5 KB; base64 PKCS#8 stays single-line in native secrets.env.
// https://developers.cloudflare.com/workers/platform/limits/#environment-variables
export const GITHUB_APP_KEY_MAX_BYTES = 5_000;
/** Every credentialed GitHub request goes to this one origin. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';
const JWT_CLOCK_SKEW_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 9 * 60;
const REQUEST_TIMEOUT_MS = 10_000;
const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

export interface GitHubAppIdentity {
  id: number;
  clientId: string;
  slug: string;
  permissions: Record<string, string>;
}
export type GitHubAppStatus =
  | { state: 'key_absent' }
  | { state: 'ready' | 'permissions_missing'; app: GitHubAppIdentity; missing: string[] }
  | { state: 'unavailable'; reason: string };

export class GitHubAppError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const json64 = (value: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(value)));

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

/** The key and JWT never leave the authenticated request capability. */
export function githubAppAccess(options: { clientId: string; privateKey: string; fetchImpl: FetchImpl; now?: () => number }) {
  const jwt = async (): Promise<string> => {
    let key: CryptoKey;
    try {
      const bytes = Uint8Array.from(atob(options.privateKey), (c) => c.charCodeAt(0));
      // Workers supports RSASSA-PKCS1-v1_5 import/sign with SHA-256.
      // https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#supported-algorithms
      key = await crypto.subtle.importKey('pkcs8', bytes, RSA, false, ['sign']);
    } catch { throw new GitHubAppError('The GitHub App private key is invalid. Generate a new key in GitHub and run the import again.'); }
    const now = Math.floor((options.now ?? Date.now)() / 1_000);
    const unsigned = `${json64({ alg: 'RS256', typ: 'JWT' })}.${json64({ iss: options.clientId, iat: now - JWT_CLOCK_SKEW_SECONDS, exp: now + JWT_LIFETIME_SECONDS })}`;
    try { return `${unsigned}.${base64url(new Uint8Array(await crypto.subtle.sign(RSA, key, new TextEncoder().encode(unsigned))))}`; }
    catch { throw new GitHubAppError('The GitHub App key could not sign a request. Generate a new key in GitHub and run the import again.'); }
  };
  /** A request authenticated as the App itself. */
  const app = async (path: string, request: { method?: string; body?: unknown; next: string }): Promise<Response> =>
    githubApi(options.fetchImpl, path, { ...request, bearer: await jwt() });
  return {
    app,
    async identity(): Promise<GitHubAppIdentity> {
      const response = await app('/app', { next: 'Check connectivity and run the import again.' });
      if (response.status !== 200) throw new GitHubAppError(`GitHub refused App verification (HTTP ${response.status}). Check the key belongs to this server’s App and run the import again.`, response.status);
      let body: unknown;
      try { body = await response.json(); } catch { throw new GitHubAppError('GitHub returned an invalid App response. Run the import again.'); }
      if (body === null || typeof body !== 'object') throw new GitHubAppError('GitHub returned an invalid App identity. Run the import again.');
      const identity = body as Record<string, unknown>;
      if (!Number.isSafeInteger(identity.id) || Number(identity.id) <= 0 || typeof identity.slug !== 'string' || identity.slug === '' || identity.client_id !== options.clientId
        || identity.permissions === null || typeof identity.permissions !== 'object' || Array.isArray(identity.permissions)
        || !Object.values(identity.permissions).every((v) => typeof v === 'string')) {
        throw new GitHubAppError('GitHub did not confirm this server’s App client id and permissions. Nothing was saved; check the App and run the import again.');
      }
      return { id: Number(identity.id), clientId: options.clientId, slug: identity.slug, permissions: identity.permissions as Record<string, string> };
    },
  };
}

export function gitHubAppPermissionIssues(app: GitHubAppIdentity): string[] {
  const required = Object.keys(GITHUB_APP_PERMISSIONS)
    .filter((permission) => app.permissions[permission] !== 'read')
    .map((permission) => `${permission} must be read-only (currently ${app.permissions[permission] ?? 'absent'})`);
  const extraWrites = Object.entries(app.permissions)
    .filter(([permission, level]) => !Object.hasOwn(GITHUB_APP_PERMISSIONS, permission) && ['write', 'admin'].includes(level))
    .map(([permission, level]) => `${permission} must not grant write access (currently ${level})`);
  return [...required, ...extraWrites];
}
