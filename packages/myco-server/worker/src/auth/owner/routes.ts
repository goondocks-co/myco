import type { AuthContext } from '../../context.js';
import { setCookie, signPayload, verifyPayload, signSession, SESSION_TTL_MS } from './cookie.js';
import { authorizeUrl, exchangeCode, fetchIdentity, OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECONDS, type OAuthState } from './github.js';

const redirectUriFor = (origin: string): string => `${origin}/auth/callback`;

const stateCookie = (state: string, maxAge: number): string =>
  `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

/** Begin sign-in: plant a random state in a short-lived cookie and send the browser to GitHub carrying the same value. */
export async function handleLogin(_request: Request, ctx: AuthContext): Promise<Response> {
  const state = await signPayload<OAuthState>(ctx.config.sessionSecret, {
    nonce: crypto.randomUUID(),
    exp: ctx.now + OAUTH_STATE_TTL_SECONDS * 1000,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl(ctx.config, redirectUriFor(ctx.origin), state),
      'set-cookie': stateCookie(state, OAUTH_STATE_TTL_SECONDS),
    },
  });
}

/** Complete sign-in. The access token is read once for the identity and is never stored. */
export async function handleCallback(request: Request, ctx: AuthContext): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const planted = readStateCookie(request.headers.get('cookie'));
  const minted = state === null ? null : await verifyPayload<OAuthState>(ctx.config.sessionSecret, state, ctx.now);
  if (code === null || state === null || planted === null || planted !== state || minted === null) {
    return new Response(null, { status: 400, headers: { 'set-cookie': stateCookie('', 0) } });
  }
  const accessToken = await exchangeCode(ctx.fetchImpl, ctx.config, redirectUriFor(ctx.origin), code);
  if (accessToken === null) return new Response(null, { status: 400, headers: { 'set-cookie': stateCookie('', 0) } });
  const identity = await fetchIdentity(ctx.fetchImpl, accessToken);
  if (identity === null || identity.id !== ctx.config.ownerGithubId) {
    return new Response(null, { status: 403, headers: { 'set-cookie': stateCookie('', 0) } });
  }
  const session = await signSession(ctx.config.sessionSecret, { sub: identity.id, iat: ctx.now, exp: ctx.now + SESSION_TTL_MS });
  const headers = new Headers({ location: '/' });
  headers.append('set-cookie', setCookie(session, Math.floor(SESSION_TTL_MS / 1000)));
  headers.append('set-cookie', stateCookie('', 0));
  return new Response(null, { status: 302, headers });
}

function readStateCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${OAUTH_STATE_COOKIE}=`)) {
      const value = trimmed.slice(OAUTH_STATE_COOKIE.length + 1);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
