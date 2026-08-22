import { setCookie, signSession } from '@myco-server-worker/auth/owner/cookie.js';

/** A session secret at the enforced minimum length, so the fixture exercises the real floor. */
export const SESSION_SECRET = 'test-session-secret-of-sufficient-length';
export const OWNER_ENV = { OWNER_GITHUB_ID: '583231', GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', SESSION_SECRET };

export async function ownerCookie(now = Date.now()): Promise<string> {
  const value = await signSession(SESSION_SECRET, { sub: '583231', iat: now, exp: now + 60_000 });
  return setCookie(value, 60).split(';')[0];
}
