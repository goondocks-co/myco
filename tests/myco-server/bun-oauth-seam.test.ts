import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBunHandler, type BunHandler } from '@myco-server-worker/entry/bun.js';
import { startDeployment } from '@myco-server-worker/platform/bun/server-main.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { OAUTH_STATE_COOKIE } from '@myco-server-worker/auth/owner/github.js';
import { SESSION_COOKIE, verifySession } from '@myco-server-worker/auth/owner/cookie.js';
import { deploymentIdentity } from '@myco-server-worker/auth/authorization.js';
import { convertManifestCode } from '@myco/server/github-app.js';
import { seededSqlite } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { SESSION_SECRET } from './helpers/owner.js';
import { fakeGitHub, SETUP_APP, SETUP_IDENTITIES } from '../setup/fixtures/github.js';

const roots: string[] = [];
const handlers: BunHandler[] = [];
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const bindings = { GITHUB_CLIENT_ID: SETUP_APP.clientId, GITHUB_CLIENT_SECRET: SETUP_APP.clientSecret, SESSION_SECRET };
function nativeDatabase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-oauth-'));
  roots.push(root);
  const databasePath = path.join(root, 'myco.sqlite');
  const sqlite = seededSqlite();
  try { fs.writeFileSync(databasePath, sqlite.serialize()); } finally { sqlite.close(); }
  return { databasePath, blobDir: path.join(root, 'blobs') };
}

async function native(fetchImpl?: ReturnType<typeof fakeGitHub>['fetchImpl']) {
  const handler = await createBunHandler({ ...nativeDatabase(), header: 'x-forwarded-for', wakeLoop: false, ...bindings, fetchImpl });
  handlers.push(handler);
  return handler;
}

async function signIn(handle: (request: Request) => Promise<Response>, identity: keyof typeof SETUP_IDENTITIES, origin = 'https://s') {
  const login = await handle(new Request(`${origin}/auth/login`, { headers: { 'x-forwarded-for': '192.0.2.1' } }));
  expect(login.status).toBe(302);
  const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
  const response = await handle(new Request(`${origin}/auth/callback?code=${identity}&state=${encodeURIComponent(state)}`, {
    headers: { 'x-forwarded-for': '192.0.2.1', cookie: `${OAUTH_STATE_COOKIE}=${state}` },
  }));
  expect(response.status).toBe(302);
  const cookie = response.headers.get('set-cookie')!;
  return cookie.slice(cookie.indexOf(`${SESSION_COOKIE}=`) + SESSION_COOKIE.length + 1).split(';')[0]!;
}

describe('native server OAuth fetch seam', () => {
  it('startDeployment uses runtime fetch for production OAuth', async () => {
    const github = fakeGitHub();
    const loopbackFetch = globalThis.fetch;
    const runtimeFetch = spyOn(globalThis, 'fetch').mockImplementation(github.registrationFetch);
    const signals = ['SIGTERM', 'SIGINT'] as const;
    const listeners = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
    let deployment: Awaited<ReturnType<typeof startDeployment>> | undefined;
    try {
      deployment = await startDeployment({ ...nativeDatabase(), port: 0, sourceFrom: 'proxy', header: 'x-forwarded-for', ...bindings });
      const cookie = await signIn((request) => loopbackFetch(request, { redirect: 'manual' }), 'owner', `http://127.0.0.1:${deployment.port}`);
      expect(await verifySession(SESSION_SECRET, cookie, Date.now(), await deploymentIdentity(deployment.env.db)))
        .toMatchObject({ sub: String(SETUP_IDENTITIES.owner.id), login: SETUP_IDENTITIES.owner.login });
      expect(runtimeFetch).toHaveBeenCalledTimes(2);
      expect(github.calls.map((call) => call.url)).toEqual(['https://github.com/login/oauth/access_token', 'https://api.github.com/user']);
    } finally {
      await deployment?.stop();
      for (const signal of signals) for (const listener of process.listeners(signal)) {
        if (!listeners.get(signal)!.has(listener)) process.removeListener(signal, listener);
      }
      runtimeFetch.mockRestore();
    }
  });

  it('uses runtime fetch when the seam is omitted', async () => {
    const github = fakeGitHub();
    const runtimeFetch = spyOn(globalThis, 'fetch').mockImplementation(github.registrationFetch);
    try {
      const handler = await native();
      await signIn(handler.fetch, 'owner');
      expect(runtimeFetch).toHaveBeenCalledTimes(2);
    } finally { runtimeFetch.mockRestore(); }
  });

  for (const target of ['native', 'd1-adapter'] as const) for (const identity of ['owner', 'teammate'] as const) {
    it(`signs in the fake ${identity} through ${target} with no network fallback`, async () => {
      const github = fakeGitHub();
      const runtimeFetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(() => { throw new Error('real network fallback'); }, { preconnect: () => {} }));
      const fixture = target === 'd1-adapter' ? sqliteEnv() : null;
      try {
        const handler = target === 'native' ? await native(github.fetchImpl) : null;
        const db = handler?.env.db ?? fixture!.db;
        const server = createServer({ now: Date.now, sourceOf: () => '192.0.2.1', fetchImpl: github.fetchImpl });
        const handle = handler?.fetch ?? ((request: Request) => server.handleRequest(request, serverEnvFromBindings({ ...fixture!.env, ...bindings })));
        const cookie = await signIn(handle, identity);
        expect(await verifySession(SESSION_SECRET, cookie, Date.now(), await deploymentIdentity(db)))
          .toMatchObject({ sub: String(SETUP_IDENTITIES[identity].id), login: SETUP_IDENTITIES[identity].login });
        expect(github.calls.map((call) => call.url)).toEqual(['https://github.com/login/oauth/access_token', 'https://api.github.com/user']);
        expect(runtimeFetch).not.toHaveBeenCalled();
      } finally { fixture?.sqlite.close(); runtimeFetch.mockRestore(); }
    });
  }

  it('shares the fake with the existing registration seam and rejects unknown requests', async () => {
    const github = fakeGitHub();
    expect(await convertManifestCode('setup-conversion', github.registrationFetch)).toEqual(SETUP_APP);
    await expect(github.fetchImpl('https://unconfigured.invalid')).rejects.toThrow('unexpected request');
  });
});
