/**
 * Sign-in that sets itself up: the manifest the operator's machine sends to
 * GitHub, the loopback exchange that brings the credentials back, and how each
 * target holds them. Every assertion is on what leaves the process — the argv
 * and stdin a runner receives, the bytes on disk, the HTTP the fake GitHub
 * sees — never on a live registration.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  convertManifestCode, installSignInSecrets, isDeploymentUrl, manifestFor, manifestFormAction, manifestPage,
  registerGitHubApp, RegistrationRefused, resolveSignInTarget, verifySignIn,
} from '@myco/server/github-app.js';
import { putWorkerSecrets, writeDeploymentRecord, WranglerAbsent } from '@myco/server/cloudflare.js';
import { materializeBundle, resolveDeploymentPaths } from '@myco/server/deployment.js';
import { systemRunner, type CommandRunner, type CommandResult, type RunOptions } from '@myco/server/runner.js';

interface Call { command: string; args: string[]; options?: RunOptions }
let calls: Call[] = [];
const runner = (answer: (call: Call) => Partial<CommandResult> = () => ({})): CommandRunner => ({
  async run(command, args, options) {
    const call = { command, args: [...args], options };
    calls.push(call);
    return { code: 0, stdout: '', stderr: '', ...answer(call) };
  },
});
beforeEach(() => { calls = []; });

const URL_ = 'https://myco.example.co';
const ACCOUNT = 'b134c2135129c4800082e677fbffb286';
const RECORD = { accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: '2026-08-29T00:00:00Z' };

describe('the manifest', () => {
  it('asks GitHub for a public app with the Deployment callback, identity only: no permissions, no webhook', () => {
    const manifest = manifestFor({ url: `${URL_}/`, redirectUrl: 'http://127.0.0.1:4242/callback' });
    expect(manifest).toEqual({
      name: 'Myco (myco.example.co)', url: URL_, redirect_url: 'http://127.0.0.1:4242/callback',
      callback_urls: [`${URL_}/auth/callback`], public: true, default_permissions: {},
    });
    expect('hook_attributes' in manifest).toBe(false);
    expect(manifestFor({ url: URL_, name: 'Team sign-in', redirectUrl: 'http://127.0.0.1:1/callback' }).name).toBe('Team sign-in');
  });

  it('posts to the operator account or the organization named, carrying the state', () => {
    expect(manifestFormAction(undefined, 'n0nce')).toBe('https://github.com/settings/apps/new?state=n0nce');
    expect(manifestFormAction('goondocks-co', 'n0nce')).toBe('https://github.com/organizations/goondocks-co/settings/apps/new?state=n0nce');
  });

  it('renders one form whose manifest field is the JSON, escaped for the attribute', () => {
    const manifest = manifestFor({ url: URL_, redirectUrl: 'http://127.0.0.1:1/callback' });
    const page = manifestPage(manifest, manifestFormAction(undefined, 's'));
    expect(page).toContain('action="https://github.com/settings/apps/new?state=s"');
    expect(page).toContain('name="manifest"');
    const value = /name="manifest" value="([^"]*)"/.exec(page)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    expect(JSON.parse(value)).toEqual(manifest);
    expect(page.match(/<form/g)).toHaveLength(1);
  });

  it('admits https, and plain http to a loopback literal only', () => {
    expect(isDeploymentUrl('https://myco.example.co')).toBe(true);
    expect(isDeploymentUrl('http://127.0.0.1:18787')).toBe(true);
    expect(isDeploymentUrl('http://myco.example.co')).toBe(false);
    expect(isDeploymentUrl('http://localhost:18787')).toBe(false);
    expect(isDeploymentUrl('not a url')).toBe(false);
  });
});

/** A fake GitHub: converts one code into one app, records every request. */
function fakeGitHub(app: Partial<{ name: string; owner: { login: string } | null }> = {}) {
  const requests: { url: string; method: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: init?.method ?? 'GET' });
    if (/\/app-manifests\/good\/conversions$/.test(url) && init?.method === 'POST') {
      return Response.json({ id: 1, slug: 'myco-myco-example-co', name: 'Myco (myco.example.co)', html_url: 'https://github.com/apps/myco-myco-example-co', client_id: 'Iv1.deadbeef', client_secret: 's3cr3t', webhook_secret: 'w', pem: 'p', owner: { login: 'goondocks-co' }, ...app }, { status: 201 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe('the conversion', () => {
  it('posts the code to GitHub and reads the credentials, never the key or webhook secret', async () => {
    const gh = fakeGitHub();
    const app = await convertManifestCode('good', gh.fetchImpl);
    expect(app).toEqual({ clientId: 'Iv1.deadbeef', clientSecret: 's3cr3t', slug: 'myco-myco-example-co', htmlUrl: 'https://github.com/apps/myco-myco-example-co', name: 'Myco (myco.example.co)', ownerLogin: 'goondocks-co' });
    expect(gh.requests).toEqual([{ url: 'https://api.github.com/app-manifests/good/conversions', method: 'POST' }]);
    await expect(convertManifestCode('stale', gh.fetchImpl)).rejects.toThrow(RegistrationRefused);
  });
});

describe('installing the credentials', () => {
  it('Cloudflare: one `secret bulk` naming the Worker, both values on stdin, the account pinned, no cwd, after the wrangler presence check', async () => {
    const r = runner();
    await installSignInSecrets({ kind: 'cloudflare', record: RECORD }, { clientId: 'Iv1.x', clientSecret: 's' }, r);
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ['npx', '--no-install', 'wrangler', '--version'],
      ['npx', 'wrangler', 'secret', 'bulk', '--name', 'myco-server'],
    ]);
    const bulk = calls[1]!;
    expect(bulk.options?.cwd).toBeUndefined();
    expect(bulk.options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
    expect(JSON.parse(bulk.options?.input ?? '')).toEqual({ GITHUB_CLIENT_ID: 'Iv1.x', GITHUB_CLIENT_SECRET: 's' });
    expect(bulk.args.join(' ')).not.toContain('s3cr3t');
  });

  it('Cloudflare: refuses before sending anything when wrangler is not installed, so npx cannot read the secrets as an answer to its own prompt', async () => {
    const r = runner((call) => (call.args.includes('--no-install') ? { code: 1 } : {}));
    await expect(putWorkerSecrets({ accountId: ACCOUNT, workerName: 'w', runner: r }, { GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b' })).rejects.toThrow(WranglerAbsent);
    expect(calls).toHaveLength(1);
  });

  it('Compose: the secret file 0600 in the 0700 directory, the id in .env beside the keys already there, then a forced recreate', async () => {
    const home = mkdtempSync(join(tmpdir(), 'myco-github-app-'));
    const paths = resolveDeploymentPaths(home);
    materializeBundle(paths, { MYCO_PORT: '18787', MYCO_VERSION: '2.0.0' });
    const r = runner();
    await installSignInSecrets({ kind: 'compose', paths }, { clientId: 'Iv1.x', clientSecret: 's3cr3t' }, r);
    expect(readFileSync(join(paths.secretsDir, 'github_client_secret'), 'utf8')).toBe('s3cr3t');
    expect(statSync(join(paths.secretsDir, 'github_client_secret')).mode & 0o777).toBe(0o600);
    expect(statSync(paths.secretsDir).mode & 0o777).toBe(0o700);
    const env = readFileSync(paths.envFile, 'utf8');
    expect(env.split('\n').filter(Boolean).sort()).toEqual(['GITHUB_CLIENT_ID=Iv1.x', 'MYCO_PORT=18787', 'MYCO_VERSION=2.0.0']);
    expect(env).not.toContain('s3cr3t');
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([['docker', 'compose', '--file', paths.composeFile, '--project-name', 'myco', 'up', '--detach', '--force-recreate', '--wait']]);
  });

  it('the real runner hands `input` to the child on stdin', async () => {
    const result = await systemRunner().run('cat', [], { input: '{"a":1}' });
    expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 0, stdout: '{"a":1}' });
  });
});

describe('verifying sign-in', () => {
  const login = (location: string | null, status = 302) => (async () => new Response(null, { status, headers: location === null ? {} : { location } })) as unknown as typeof fetch;
  const ok = `https://github.com/login/oauth/authorize?client_id=Iv1.x&redirect_uri=${encodeURIComponent(`${URL_}/auth/callback`)}&state=s`;

  it('accepts only a 302 to GitHub carrying the new client id and the Deployment callback', async () => {
    expect(await verifySignIn(URL_, 'Iv1.x', { fetchImpl: login(ok), attempts: 1 })).toEqual({ ok: true });
    expect((await verifySignIn(URL_, 'Iv1.x', { fetchImpl: login(null, 401), attempts: 1, pauseMs: 0 })).ok).toBe(false);
    expect((await verifySignIn(URL_, 'Iv1.x', { fetchImpl: login(ok, 200), attempts: 1 })).ok).toBe(false);
    expect((await verifySignIn(URL_, 'Iv1.other', { fetchImpl: login(ok), attempts: 1 })).ok).toBe(false);
    const foreign = `https://github.com/login/oauth/authorize?client_id=Iv1.x&redirect_uri=${encodeURIComponent('https://elsewhere.example/auth/callback')}`;
    const result = await verifySignIn(URL_, 'Iv1.x', { fetchImpl: login(foreign), attempts: 1 });
    expect(result).toEqual({ ok: false, reason: `the Deployment's callback is https://elsewhere.example/auth/callback, not ${URL_}/auth/callback` });
    const notGitHub = await verifySignIn(URL_, 'Iv1.x', { fetchImpl: login('https://example.com/authorize?client_id=Iv1.x'), attempts: 1 });
    expect(notGitHub.ok).toBe(false);
  });

  it('retries while the secrets propagate', async () => {
    let n = 0;
    const flaky = (async () => { n += 1; return n < 3 ? new Response(null, { status: 401 }) : new Response(null, { status: 302, headers: { location: ok } }); }) as unknown as typeof fetch;
    expect(await verifySignIn(URL_, 'Iv1.x', { fetchImpl: flaky, attempts: 3, pauseMs: 0 })).toEqual({ ok: true });
    expect(n).toBe(3);
  });
});

describe('choosing the target', () => {
  it('reads the Cloudflare record or the Compose bundle, and refuses when both or neither are present without --target', () => {
    const none = mkdtempSync(join(tmpdir(), 'myco-target-'));
    expect(() => resolveSignInTarget(undefined, none)).toThrow(RegistrationRefused);
    const cf = mkdtempSync(join(tmpdir(), 'myco-target-'));
    writeDeploymentRecord(RECORD, cf);
    expect(resolveSignInTarget(undefined, cf)).toEqual({ kind: 'cloudflare', record: RECORD, mycoHome: cf });
    const both = mkdtempSync(join(tmpdir(), 'myco-target-'));
    writeDeploymentRecord(RECORD, both);
    materializeBundle(resolveDeploymentPaths(both));
    expect(() => resolveSignInTarget(undefined, both)).toThrow(/--target/);
    expect(resolveSignInTarget('compose', both).kind).toBe('compose');
    expect(resolveSignInTarget('cloudflare', both).kind).toBe('cloudflare');
    expect(() => resolveSignInTarget('elsewhere', both)).toThrow(RegistrationRefused);
  });
});

describe('the whole flow on a loopback listener', () => {
  /** Drives the browser's part: fetch the form page, then GitHub's redirect to the callback with the state the form carries. */
  async function browse(page: string, stateOf: (html: string) => string | Promise<string>) {
    const form = await fetch(page);
    const html = await form.text();
    const { port } = new URL(page);
    const back = await fetch(`http://127.0.0.1:${port}/callback?code=good&state=${await stateOf(html)}`, { redirect: 'manual' });
    return { form, html, back };
  }
  const stateIn = (html: string): string => /state=([A-Za-z0-9_%-]+)/.exec(html)![1]!;

  it('serves the form once, takes GitHub\'s code with the state it issued, converts it, installs on the target, records the URL, and verifies', async () => {
    const gh = fakeGitHub();
    const home = mkdtempSync(join(tmpdir(), 'myco-flow-'));
    writeDeploymentRecord(RECORD, home);
    const target = resolveSignInTarget(undefined, home);
    const r = runner();
    const okLocation = `https://github.com/login/oauth/authorize?client_id=Iv1.deadbeef&redirect_uri=${encodeURIComponent(`${URL_}/auth/callback`)}`;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === `${URL_}/auth/login`) return new Response(null, { status: 302, headers: { location: okLocation } });
      return gh.fetchImpl(input, init);
    }) as typeof fetch;
    const logs: string[] = [];
    let opened: string | null = null;
    const pending = registerGitHubApp({ url: URL_, org: 'goondocks-co', target, runner: r, fetchImpl, log: (l) => logs.push(l), openUrl: async (u) => { opened = u; } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const page = opened!;
    expect(page).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{16,}$/);
    expect(new URL(page).pathname).not.toBe('/callback');
    const { form, html, back } = await browse(page, async (markup) => {
      expect((await fetch(page)).status).toBe(404);
      expect((await fetch(`${new URL(page).origin}/elsewhere`)).status).toBe(404);
      return stateIn(markup);
    });
    expect(form.status).toBe(200);
    expect(html).toContain('organizations/goondocks-co/settings/apps/new');
    expect(back.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(fetch(page)).rejects.toThrow();
    const result = await pending;
    expect(result).toEqual({ app: { slug: 'myco-myco-example-co', htmlUrl: 'https://github.com/apps/myco-myco-example-co', name: 'Myco (myco.example.co)', clientId: 'Iv1.deadbeef' }, callbackUrl: `${URL_}/auth/callback`, verified: { ok: true } });
    expect(calls.map((c) => c.args.slice(0, 3))).toEqual([['--no-install', 'wrangler', '--version'], ['wrangler', 'secret', 'bulk']]);
    expect(JSON.parse(readFileSync(join(home, 'server', 'cloudflare.json'), 'utf8')).url).toBe(URL_);
    expect(logs.join('\n')).not.toContain('s3cr3t');
  });

  it('refuses a callback whose state it did not issue, and an app that is not the one it registered, installing nothing', async () => {
    const r = runner();
    const gh = fakeGitHub({ name: 'Somebody else' });
    const home = mkdtempSync(join(tmpdir(), 'myco-flow-'));
    writeDeploymentRecord(RECORD, home);
    for (const attempt of ['wrong-state', 'wrong-app'] as const) {
      let opened: string | null = null;
      const outcome = registerGitHubApp({ url: URL_, target: resolveSignInTarget(undefined, home), runner: r, fetchImpl: gh.fetchImpl, openUrl: async (u) => { opened = u; } })
        .then(() => 'registered' as const, (err: unknown) => err);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const { back } = await browse(opened!, (html) => (attempt === 'wrong-state' ? 'forged' : stateIn(html)));
      expect(back.status).toBe(attempt === 'wrong-state' ? 400 : 200);
      expect(await outcome).toBeInstanceOf(RegistrationRefused);
    }
    expect(calls).toEqual([]);
  });

  it('refuses a URL that is not a Deployment URL before listening', async () => {
    await expect(registerGitHubApp({ url: 'http://myco.example.co', target: { kind: 'cloudflare', record: RECORD }, runner: runner() })).rejects.toThrow(RegistrationRefused);
    expect(calls).toEqual([]);
  });
});

describe('the deployment record', () => {
  it('round-trips the url once an operator has named it', () => {
    const home = mkdtempSync(join(tmpdir(), 'myco-record-'));
    writeDeploymentRecord({ ...RECORD, url: URL_ }, home);
    expect(JSON.parse(readFileSync(join(home, 'server', 'cloudflare.json'), 'utf8')).url).toBe(URL_);
    writeFileSync(join(home, 'server', 'cloudflare.json'), JSON.stringify(RECORD));
    expect(resolveSignInTarget('cloudflare', home)).toEqual({ kind: 'cloudflare', record: RECORD, mycoHome: home });
  });
});
