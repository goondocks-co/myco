import { setCookie, signSession } from '@myco-server-worker/auth/owner/cookie.js';

/** A session secret at the enforced minimum length, so the fixture exercises the real floor. */
export const SESSION_SECRET = 'test-session-secret-of-sufficient-length';
export const OWNER_ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', SESSION_SECRET };

/** The GitHub account the seeded member `mem_machine_1` is linked to (`helpers/d1.ts`). */
export const LINKED_SUB = '583231';

export async function ownerCookie(now = Date.now(), sub = LINKED_SUB): Promise<string> {
  const value = await signSession(SESSION_SECRET, { sub, login: 'octocat', iat: now, exp: now + 60_000 });
  return setCookie(value, 60).split(';')[0];
}

/** The member every owner-route test acts as: the one the seeded account is linked to. */
export const PRINCIPAL = { id: 'mem_machine_1', label: 'machine_1' };

/** An authenticated owner GET. */
export const asOwner = async (path: string): Promise<Request> =>
  new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } });

/** An authenticated owner PATCH, same-origin so the CSRF check admits it. */
export const asOwnerPatch = async (path: string, body?: unknown): Promise<Request> =>
  new Request(`https://s${path}`, {
    method: 'PATCH',
    headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** An authenticated owner POST, same-origin so the CSRF check admits it. */
export const asOwnerPost = async (path: string, body?: unknown): Promise<Request> =>
  new Request(`https://s${path}`, {
    method: 'POST',
    headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
