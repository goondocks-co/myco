/** GitHub App identity and signing, shared by operator validation and the Deployment. */
import { GitHubAppError, githubApi, MAX_GITHUB_APP_ANSWER_BYTES, rateLimitOf, rateLimitWords, readGitHubJson, type FetchImpl } from './github-api.js';
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
const JWT_CLOCK_SKEW_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 9 * 60;
const REQUEST_TIMEOUT_MS = 10_000;
const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

/** The account that owns an App, or holds one of its installations. */
export interface GitHubAppOwner { login: string; type: 'User' | 'Organization' }
export interface GitHubAppIdentity {
  id: number;
  clientId: string;
  slug: string;
  name: string;
  owner: GitHubAppOwner | null;
  permissions: Record<string, string>;
}
export type GitHubAppStatus =
  | { state: 'key_absent' }
  | { state: 'ready' | 'permissions_missing'; app: GitHubAppIdentity; missing: string[] }
  | { state: 'unavailable'; reason: string }
  /** GitHub throttled the check; the key was not judged. */
  | { state: 'rate_limited'; reason: string };


const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const json64 = (value: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(value)));

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
    githubApi(options.fetchImpl, path, { ...request, bearer: await jwt(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return {
    app,
    async identity(): Promise<GitHubAppIdentity> {
      const response = await app('/app', { next: 'Check connectivity and run the import again.' });
      const limited = response.status === 200 ? null : await rateLimitOf(response);
      if (limited !== null) throw new GitHubAppError(rateLimitWords(limited.until), response.status, true);
      if (response.status !== 200) throw new GitHubAppError(`GitHub refused App verification (HTTP ${response.status}). Check the key belongs to this server’s App and run the import again.`, response.status);
      let body: unknown;
      try { body = await readGitHubJson(response, MAX_GITHUB_APP_ANSWER_BYTES); } catch { throw new GitHubAppError('GitHub returned an invalid App response. Run the import again.'); }
      const identity = appAnswerOf(body);
      if (identity === null || identity.clientId !== options.clientId) {
        throw new GitHubAppError('GitHub did not confirm this server’s App client id and permissions. Nothing was saved; check the App and run the import again.');
      }
      return identity;
    },
  };
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const PERMISSION = /^[a-z_]{1,64}$/;
const LEVEL = /^[a-z_]{1,16}$/;
const MAX_NAME_CHARS = 100;
const MAX_CLIENT_ID_CHARS = 64;
const MAX_PERMISSIONS = 100;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** An App's owner as GitHub names it, when it is an account with a valid login. */
export function ownerOf(value: unknown): GitHubAppOwner | null {
  if (!isRecord(value)) return null;
  const { login, type } = value;
  return typeof login === 'string' && LOGIN.test(login) && (type === 'User' || type === 'Organization') ? { login, type } : null;
}

/**
 * The fields Myco reads from GitHub's answer for an App (`GET /app` or `GET /apps/{slug}`), each of the type and
 * length GitHub gives them; null when any is missing or out of shape. https://docs.github.com/en/rest/apps/apps#get-an-app
 */
export function appAnswerOf(value: unknown): GitHubAppIdentity | null {
  if (!isRecord(value)) return null;
  const { id, client_id: clientId, slug, name, permissions } = value;
  if (!Number.isSafeInteger(id) || Number(id) <= 0 || typeof clientId !== 'string' || clientId === '' || clientId.length > MAX_CLIENT_ID_CHARS
    || typeof slug !== 'string' || !SLUG.test(slug) || !(name === undefined || (typeof name === 'string' && name !== '' && name.length <= MAX_NAME_CHARS))
    || !isRecord(permissions) || Object.keys(permissions).length > MAX_PERMISSIONS
    || !Object.entries(permissions).every(([key, level]) => PERMISSION.test(key) && typeof level === 'string' && LEVEL.test(level))) return null;
  return { id: Number(id), clientId, slug, name: typeof name === 'string' ? name : slug, owner: ownerOf(value.owner), permissions: permissions as Record<string, string> };
}

export function gitHubAppPermissionIssues(app: Pick<GitHubAppIdentity, 'permissions'>): string[] {
  const required = Object.keys(GITHUB_APP_PERMISSIONS)
    .filter((permission) => app.permissions[permission] !== 'read')
    .map((permission) => `${permission} must be read-only (currently ${app.permissions[permission] ?? 'absent'})`);
  const extraWrites = Object.entries(app.permissions)
    .filter(([permission, level]) => !Object.hasOwn(GITHUB_APP_PERMISSIONS, permission) && ['write', 'admin'].includes(level))
    .map(([permission, level]) => `${permission} must not grant write access (currently ${level})`);
  return [...required, ...extraWrites];
}
