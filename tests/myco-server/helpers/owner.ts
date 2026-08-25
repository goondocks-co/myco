import { setCookie, signSession } from '@myco-server-worker/auth/owner/cookie.js';

/** A session secret at the enforced minimum length, so the fixture exercises the real floor. */
export const SESSION_SECRET = 'test-session-secret-of-sufficient-length';
export const OWNER_ENV = { OWNER_GITHUB_ID: '583231', GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', SESSION_SECRET };

export async function ownerCookie(now = Date.now()): Promise<string> {
  const value = await signSession(SESSION_SECRET, { sub: '583231', iat: now, exp: now + 60_000 });
  return setCookie(value, 60).split(';')[0];
}

/** The owner session every owner-route test authenticates as. */
export const PRINCIPAL = { sub: '583231', iat: 0, exp: 9_999_999_999_999 };

/** An authenticated owner GET. */
export const asOwner = async (path: string): Promise<Request> =>
  new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } });

/** An authenticated owner POST, same-origin so the CSRF check admits it. */
export const asOwnerPost = async (path: string, body?: unknown): Promise<Request> =>
  new Request(`https://s${path}`, {
    method: 'POST',
    headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
