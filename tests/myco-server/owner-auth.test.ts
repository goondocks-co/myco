import { describe, it, expect } from 'bun:test';
import { clearCookie, readCookie, SESSION_COOKIE, setCookie, signSession, verifySession } from '@myco-server-worker/auth/owner/cookie.js';

import { ownerConfig } from '@myco-server-worker/auth/owner/config.js';
import { OWNER_ENV, SESSION_SECRET } from './helpers/owner.js';

const SECRET = 'test-secret-value-not-a-real-one';

const FULL = { OWNER_GITHUB_ID: '583231', GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', SESSION_SECRET };

describe('owner config', () => {
  it('resolves when every value is present', () => {
    expect(ownerConfig({ secrets: FULL } as never)).toEqual({ ownerGithubId: '583231', clientId: 'cid', clientSecret: 'csecret', sessionSecret: SESSION_SECRET });
  });

  it('is absent when any value is missing or blank — no partial human surface', () => {
    for (const key of Object.keys(FULL)) {
      expect(ownerConfig({ secrets: { ...FULL, [key]: undefined } } as never)).toBeNull();
      expect(ownerConfig({ secrets: { ...FULL, [key]: '  ' } } as never)).toBeNull();
    }
  });

  it('is absent when the session secret is too short to resist offline attack', () => {
    expect(ownerConfig({ secrets: { ...FULL, SESSION_SECRET: 'x'.repeat(31) } } as never)).toBeNull();
    expect(ownerConfig({ secrets: { ...FULL, SESSION_SECRET: 'x'.repeat(32) } } as never)).not.toBeNull();
  });

  it('is absent when the owner id is not a numeric account id', () => {
    for (const bad of ['octocat', '12a', '', '-1', '1.5']) expect(ownerConfig({ secrets: { ...FULL, OWNER_GITHUB_ID: bad } } as never)).toBeNull();
  });
});

import { authorizeUrl, exchangeCode, fetchIdentity } from '@myco-server-worker/auth/owner/github.js';

const CONFIG = { ownerGithubId: '583231', clientId: 'cid', clientSecret: 'csecret', sessionSecret: SESSION_SECRET };

describe('github oauth', () => {
  it('builds an authorize url carrying the state and redirect', () => {
    const url = new URL(authorizeUrl(CONFIG, 'https://s/auth/callback', 'st4te'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('redirect_uri')).toBe('https://s/auth/callback');
    expect(url.searchParams.get('scope')).toBe('');
  });

  it('exchanges a code for an access token', async () => {
    const calls: Request[] = [];
    const fetchImpl = async (input: RequestInfo) => {
      calls.push(input as Request);
      return Response.json({ access_token: 'gho_test', token_type: 'bearer' });
    };
    expect(await exchangeCode(fetchImpl as typeof fetch, CONFIG, 'https://s/auth/callback', 'the-code')).toBe('gho_test');
    expect(new URL(String((calls[0] as unknown as Request).url ?? calls[0])).host).toBe('github.com');
  });

  it('returns null when the exchange fails or answers no token', async () => {
    const failing = async () => Response.json({ error: 'bad_verification_code' }, { status: 200 });
    expect(await exchangeCode(failing as unknown as typeof fetch, CONFIG, 'https://s/auth/callback', 'x')).toBeNull();
    const http500 = async () => new Response('nope', { status: 500 });
    expect(await exchangeCode(http500 as unknown as typeof fetch, CONFIG, 'https://s/auth/callback', 'x')).toBeNull();
  });

  it('reads the numeric account id, not the login', async () => {
    const fetchImpl = async () => Response.json({ id: 583231, login: 'octocat' });
    expect(await fetchIdentity(fetchImpl as unknown as typeof fetch, 'gho_test')).toEqual({ id: '583231', login: 'octocat' });
  });

  it('returns null when the identity response carries no numeric id', async () => {
    for (const body of [{ login: 'octocat' }, { id: 'octocat' }, {}]) {
      const fetchImpl = async () => Response.json(body);
      expect(await fetchIdentity(fetchImpl as unknown as typeof fetch, 'gho_test')).toBeNull();
    }
  });
});

import worker from '@myco-server-worker/index.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { cloudflareSourceOf } from '@myco-server-worker/platform/cloudflare/source.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';

async function ownerCookie(now = Date.now()): Promise<string> {
  const value = await signSession(SESSION_SECRET, { sub: '583231', iat: now, exp: now + 60_000 });
  return setCookie(value, 60).split(';')[0];
}

describe('owner route dispatch', () => {
  it('accepts the owner session on an owner route', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(
      new Request('https://s/auth/logout', { method: 'POST', headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' } }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('refuses a member token on an owner route WITHOUT reading member_credentials', async () => {
    const e = sqliteEnv();
    const minted = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    e.executed.length = 0;
    const res = await worker.fetch(
      new Request('https://s/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${minted.token}`, 'cf-connecting-ip': '1.2.3.4' } }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.status).toBe(401);
    expect(e.executed.filter((sql) => sql.includes('member_tokens'))).toEqual([]);
  });

  it('refuses an owner session on a member route WITHOUT verifying it', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(
      new Request('https://s/events', { method: 'POST', headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' }, body: '{}' }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="myco"');
  });

  it('serves no owner route at all when the owner is unconfigured', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(
      new Request('https://s/auth/logout', { method: 'POST', headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } }),
      e.env
    );
    expect(res.status).toBe(401);
  });

  it('discloses no protocol number to an owner', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(
      new Request('https://s/auth/logout', { method: 'POST', headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.headers.get('x-myco-protocol')).toBeNull();
  });
});

import { OAUTH_STATE_COOKIE } from '@myco-server-worker/auth/owner/github.js';

/** Drives the worker with a supplied outbound fetch, the way the entry supplies the real one. */
const withFetch = (request: Request, env: unknown, fetchImpl: typeof fetch) =>
  createServer({ now: () => Date.now(), sourceOf: cloudflareSourceOf, fetchImpl })
    .handleRequest(request, serverEnvFromBindings(env as never));

const cookieValue = (header: string, name: string): string | null => {
  for (const set of header.split(/,(?=[^ ;]+=)/)) {
    const t = set.trim();
    if (t.startsWith(`${name}=`)) return t.slice(name.length + 1).split(';')[0];
  }
  return null;
};

describe('sign-in', () => {
  it('redirects to github and plants a state cookie the callback can check', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(new Request('https://s/auth/login', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.host).toBe('github.com');
    const planted = cookieValue(res.headers.get('set-cookie')!, OAUTH_STATE_COOKIE);
    expect(planted).toBe(location.searchParams.get('state'));
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('signs the owner in and sets the session cookie', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const login = await worker.fetch(new Request('https://s/auth/login', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), env);
    const state = cookieValue(login.headers.get('set-cookie')!, OAUTH_STATE_COOKIE)!;
    const res = await createServer({ now: () => Date.now(), sourceOf: cloudflareSourceOf, fetchImpl: (async (input: RequestInfo) => (String((input as Request).url ?? input).includes('api.github.com')
          ? Response.json({ id: 583231, login: 'octocat' })
          : Response.json({ access_token: 'gho_test' }))) as unknown as typeof fetch }).handleRequest(
      new Request(`https://s/auth/callback?code=the-code&state=${state}`, { headers: { 'cf-connecting-ip': '1.2.3.4', cookie: `${OAUTH_STATE_COOKIE}=${state}` } }),
      serverEnvFromBindings(env as never)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const session = cookieValue(res.headers.get('set-cookie')!, SESSION_COOKIE)!;
    expect((await verifySession(SESSION_SECRET, session, Date.now()))?.sub).toBe('583231');
  });

  it('refuses an identity whose login matches the owner but whose id does not', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const login = await worker.fetch(new Request('https://s/auth/login', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), env);
    const state = cookieValue(login.headers.get('set-cookie')!, OAUTH_STATE_COOKIE)!;
    const res = await createServer({ now: () => Date.now(), sourceOf: cloudflareSourceOf, fetchImpl: (async (input: RequestInfo) => (String((input as Request).url ?? input).includes('api.github.com')
          ? Response.json({ id: 999999, login: 'octocat' })
          : Response.json({ access_token: 'gho_test' }))) as unknown as typeof fetch }).handleRequest(
      new Request(`https://s/auth/callback?code=c&state=${state}`, { headers: { 'cf-connecting-ip': '1.2.3.4', cookie: `${OAUTH_STATE_COOKIE}=${state}` } }),
      serverEnvFromBindings(env as never)
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie') ?? '').not.toContain(SESSION_COOKIE);
  });

  it('refuses a callback whose state does not match the planted cookie', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(
      new Request('https://s/auth/callback?code=c&state=attacker', { headers: { 'cf-connecting-ip': '1.2.3.4', cookie: `${OAUTH_STATE_COOKIE}=planted` } }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.status).toBe(400);
  });

  it('refuses a callback with no state cookie at all', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(
      new Request('https://s/auth/callback?code=c&state=whatever', { headers: { 'cf-connecting-ip': '1.2.3.4' } }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.status).toBe(400);
  });
});

describe('owner session cookie', () => {
  it('refuses a payload signed for another purpose with the same key', async () => {
    const { signPayload } = await import('@myco-server-worker/auth/owner/cookie.js');
    const foreign = await signPayload(SECRET, 'oauth_state', { sub: '1234567', iat: 1_000, exp: 9_000 } as never);
    expect(await verifySession(SECRET, foreign, 5_000)).toBeNull();
  });

  it('round-trips a session', async () => {
    const signed = await signSession(SECRET, { sub: '1234567', iat: 1_000, exp: 9_000 });
    expect(await verifySession(SECRET, signed, 5_000)).toMatchObject({ sub: '1234567', iat: 1_000, exp: 9_000 });
  });

  it('refuses a session signed with another secret', async () => {
    const signed = await signSession(SECRET, { sub: '1234567', iat: 1_000, exp: 9_000 });
    expect(await verifySession('a-different-secret-entirely', signed, 5_000)).toBeNull();
  });

  it('refuses a tampered payload', async () => {
    const signed = await signSession(SECRET, { sub: '1234567', iat: 1_000, exp: 9_000 });
    const forged = `${btoa(JSON.stringify({ sub: '9999999', iat: 1_000, exp: 9_000 })).replace(/=+$/, '')}.${signed.split('.')[1]}`;
    expect(await verifySession(SECRET, forged, 5_000)).toBeNull();
  });

  it('refuses an expired session', async () => {
    const signed = await signSession(SECRET, { sub: '1234567', iat: 1_000, exp: 9_000 });
    expect(await verifySession(SECRET, signed, 9_001)).toBeNull();
  });

  it('refuses malformed values without throwing', async () => {
    for (const bad of ['', '.', 'nodot', 'a.b', '..']) expect(await verifySession(SECRET, bad, 1)).toBeNull();
  });

  it('serializes with every required flag', () => {
    const header = setCookie('value', 604_800);
    expect(header.startsWith(`${SESSION_COOKIE}=value;`)).toBe(true);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=604800']) expect(header).toContain(flag);
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    expect(header).not.toContain('Domain=');
    expect(clearCookie()).toContain('Max-Age=0');
  });

  it('reads its cookie out of a crowded header', () => {
    expect(readCookie(`other=1; ${SESSION_COOKIE}=abc.def; another=2`)).toBe('abc.def');
    expect(readCookie('other=1')).toBeNull();
    expect(readCookie(null)).toBeNull();
  });
});

describe('same-origin on state-changing owner routes', () => {
  it('refuses a cross-origin POST carrying a valid session', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(
      new Request('https://s/auth/logout', {
        method: 'POST',
        headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4', origin: 'https://evil.example' },
      }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.status).toBe(403);
  });

  it('refuses a POST that offers no origin evidence at all', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(
      new Request('https://s/auth/logout', { method: 'POST', headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.status).toBe(403);
  });

  it('accepts a browser fetch that declares same-origin', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(
      new Request('https://s/auth/logout', {
        method: 'POST',
        headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4', 'sec-fetch-site': 'same-origin' },
      }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.status).toBe(204);
  });

  it('never blocks a safe method', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(
      new Request('https://s/api/projects', { headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.status).toBe(200);
  });
});

describe('the human surface is metered', () => {
  it('charges the source bucket for an anonymous auth route', async () => {
    const e = sqliteEnv();
    await worker.fetch(new Request('https://s/auth/login', { headers: { 'cf-connecting-ip': '9.9.9.9' } }), { ...e.env, ...OWNER_ENV });
    expect(e.sourceKeys).toContain('9.9.9.9');
  });

  it('charges the source bucket for an owner route with no valid cookie', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(new Request('https://s/api/projects', { headers: { 'cf-connecting-ip': '8.8.8.8' } }), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(401);
    expect(e.sourceKeys).toContain('8.8.8.8');
  });
});

describe('no owner configured means no human surface at all', () => {
  const paths = ['/api/projects', '/api/status', '/api/projects/proj_1/sessions'] as const;

  it('refuses every /api route', async () => {
    const e = sqliteEnv();
    for (const path of paths) {
      const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } }), e.env);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });

  it('issues no OAuth redirect', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(new Request('https://s/auth/login', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), e.env);
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
  });

  it('completes no callback', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(new Request('https://s/auth/callback?code=c&state=s', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), e.env);
    expect(res.status).toBe(401);
  });
});

describe('a principal who is not the owner reaches nothing', () => {
  it('is refused on every owner route, cookie signed by this server or not', async () => {
    const e = sqliteEnv();
    const now = Date.now();
    // Correctly signed by this server, but for a different GitHub account.
    const stranger = await signSession(SESSION_SECRET, { sub: '999999', iat: now, exp: now + 60_000 });
    for (const path of ['/api/projects', '/api/status', '/api/projects/proj_1/tokens']) {
      const res = await worker.fetch(
        new Request(`https://s${path}`, { headers: { cookie: `${SESSION_COOKIE}=${stranger}`, 'cf-connecting-ip': '1.2.3.4' } }),
        { ...e.env, ...OWNER_ENV }
      );
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });
});

describe('the session cookie a browser actually receives', () => {
  it('carries every flag on the real Set-Cookie of a completed sign-in', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const login = await worker.fetch(new Request('https://s/auth/login', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), env);
    const state = cookieValue(login.headers.get('set-cookie')!, OAUTH_STATE_COOKIE)!;
    const res = await withFetch(
      new Request(`https://s/auth/callback?code=the-code&state=${encodeURIComponent(state)}`, {
        headers: { 'cf-connecting-ip': '1.2.3.4', cookie: `${OAUTH_STATE_COOKIE}=${state}` },
      }),
      env,
      async (input: RequestInfo) => (String((input as Request).url ?? input).includes('api.github.com')
        ? Response.json({ id: 583231, login: 'octocat' })
        : Response.json({ access_token: 'gho_test' }))
    );
    const header = res.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE))!;
    expect(header).toBeDefined();
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=']) expect(header).toContain(flag);
    expect(header).not.toContain('Domain=');
    expect(res.headers.getSetCookie().length).toBe(2);
  });
});
