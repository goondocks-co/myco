import type { OwnerConfig } from './config.js';

/** A state this server minted: a nonce plus the instant it stops being accepted. */
export interface OAuthState {
  nonce: string;
  exp: number;
}

/** The short-lived cookie holding the OAuth `state`, so the callback can prove the dance began here. */
export const OAUTH_STATE_COOKIE = '__Host-myco_oauth_state';

/** The state cookie's life. */
export const OAUTH_STATE_TTL_SECONDS = 600;

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const ACCESS_TOKEN = 'https://github.com/login/oauth/access_token';
const USER = 'https://api.github.com/user';

/** Where the browser is sent to sign in. */
export function authorizeUrl(config: OwnerConfig, redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', '');
  url.searchParams.set('allow_signup', 'false');
  return url.toString();
}

/** The access token for a callback code, or null on any failure. */
export async function exchangeCode(fetchImpl: typeof fetch, config: OwnerConfig, redirectUri: string, code: string): Promise<string | null> {
  const response = await fetchImpl(ACCESS_TOKEN, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }),
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
  return typeof body?.access_token === 'string' && body.access_token.length > 0 ? body.access_token : null;
}

/** The authenticated GitHub identity, or null. */
export async function fetchIdentity(fetchImpl: typeof fetch, accessToken: string): Promise<{ id: string; login: string } | null> {
  const response = await fetchImpl(USER, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}`, 'user-agent': 'myco-server' },
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { id?: unknown; login?: unknown } | null;
  if (typeof body?.id !== 'number' || !Number.isSafeInteger(body.id)) return null;
  return { id: String(body.id), login: typeof body.login === 'string' ? body.login : '' };
}
