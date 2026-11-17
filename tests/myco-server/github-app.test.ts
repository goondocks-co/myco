import type { OutboundFetch } from '@myco-server-worker/core/adapters.js';
import { expect, it } from 'bun:test';
import { verify } from 'node:crypto';
import { createServer } from '@myco-server-worker/pipeline.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { cloudflareSourceOf } from '@myco-server-worker/platform/cloudflare/source.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV, ownerCookie, seedMemberRoleAccount, MEMBER_SUB } from './helpers/owner.js';
import { APP_KEY, APP_PEM, APP_RESPONSE, APP_RSA } from '../setup/fixtures/github.js';

it('answers App readiness only to an admin, signs with the existing client id, and never returns key material', async () => {
  const fixture = sqliteEnv();
  seedMemberRoleAccount(fixture.sqlite);
  let upstream: Omit<typeof APP_RESPONSE, 'permissions'> & { permissions: Record<string, string> } = { ...APP_RESPONSE, client_id: OWNER_ENV.GITHUB_CLIENT_ID };
  const fetchImpl: OutboundFetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe('https://api.github.com/app');
    const jwt = request.headers.get('authorization')!.slice('Bearer '.length);
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(atob(header.replace(/-/g, '+').replace(/_/g, '/'))).alg).toBe('RS256');
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    expect(claims.iss).toBe(OWNER_ENV.GITHUB_CLIENT_ID);
    expect(claims.iat).toBeLessThan(Date.now() / 1000);
    expect(claims.exp).toBeLessThanOrEqual(Date.now() / 1000 + 600);
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), APP_RSA.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    return Response.json(upstream);
  };
  const server = createServer({ now: Date.now, sourceOf: cloudflareSourceOf, fetchImpl });
  const env = (key?: string) => ({ ...serverEnvFromBindings({ ...fixture.env, ...OWNER_ENV, GITHUB_APP_PRIVATE_KEY: key } as never), outbound: fetchImpl });
  const request = () => asOwner(fixture.db, '/api/github-app');
  const absent = await server.handleRequest(await request(), env());
  expect(await absent.json()).toEqual({ state: 'key_absent' });
  const ready = await server.handleRequest(await request(), env(APP_KEY));
  expect(ready.headers.get('cache-control')).toBe('no-store');
  const text = await ready.text();
  expect(JSON.parse(text)).toMatchObject({ state: 'ready', app: { clientId: OWNER_ENV.GITHUB_CLIENT_ID }, missing: [] });
  for (const secret of [APP_KEY, APP_PEM, OWNER_ENV.GITHUB_CLIENT_SECRET]) expect(text).not.toContain(secret);
  upstream = { ...upstream, permissions: Object.fromEntries(Object.entries(upstream.permissions).filter(([name]) => name !== 'pull_requests')) };
  expect(await (await server.handleRequest(await request(), env(APP_KEY))).json()).toMatchObject({ state: 'permissions_missing', missing: ['pull_requests must be read-only (currently absent)'] });
  const member = new Request('https://s/api/github-app', { headers: { cookie: await ownerCookie(fixture.db, Date.now(), MEMBER_SUB), 'cf-connecting-ip': '1.2.3.4' } });
  expect((await server.handleRequest(member, env(APP_KEY))).status).toBe(403);
  expect((await server.handleRequest(new Request('https://s/api/github-app', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), env(APP_KEY))).status).toBe(401);
  upstream = { ...upstream, client_id: 'different-app' };
  expect(await (await server.handleRequest(await request(), env(APP_KEY))).json()).toMatchObject({ state: 'unavailable' });
  const login = new Request('https://s/auth/login', { headers: { 'cf-connecting-ip': '1.2.3.4' } });
  for (const key of [undefined, APP_KEY]) {
    const response = await server.handleRequest(new Request(login.url, { headers: login.headers }), env(key));
    const location = new URL(response.headers.get('location')!);
    expect(response.status).toBe(302);
    expect(location.searchParams.get('client_id')).toBe(OWNER_ENV.GITHUB_CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe('https://s/auth/callback');
  }
  expect(JSON.stringify(fixture.sqlite.query('SELECT * FROM deployment_secrets').all())).not.toContain(APP_KEY);
});
