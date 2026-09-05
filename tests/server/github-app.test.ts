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
import { HARNESS_STOP_GRACE_SECONDS } from '@myco/server/compose-template.js';
import { systemRunner, type CommandRunner, type CommandResult, type RunOptions } from '@myco/server/runner.js';

interface Call { command: string; args: string[]; options?: RunOptions }
let calls: Call[] = [];
const runner = (answer: (call: Call) => Partial<CommandResult> = () => ({})): CommandRunner => ({
  async run(command, args, options) {
    const call = { command, args: [...args], options };
    calls.push(call);
    // Compose answers the union of the bundle and the operator's override.
    if (args.includes('--services')) return { code: 0, stdout: 'server\nharness\n', stderr: '' };
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

  it('refuses a name past GitHub\'s 34 characters before listening, naming --name', async () => {
    await expect(registerGitHubApp({ url: 'https://myco-server.example-account.workers.dev', target: { kind: 'cloudflare', record: RECORD }, runner: runner() })).rejects.toThrow(/34 characters.*--name/);
    expect(calls).toEqual([]);
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
    // The service list Compose is asked for is a read, not an act.
    expect(calls.filter((c) => !c.args.includes('--services')).map((c) => [c.command, ...c.args])).toEqual([
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
    // The harness goes down on its own first: Compose takes the namespace owner
    // down ahead of it, and a recreate that starts with `up` kills the server
    // while the harness is still holding runs.
    // The service list Compose is asked for is a read, not an act.
    expect(calls.filter((c) => !c.args.includes('--services')).map((c) => [c.command, ...c.args])).toEqual([
      ['docker', 'compose', '--file', paths.composeFile, '--file', paths.overrideFile, '--project-name', 'myco', 'stop', '--timeout', String(HARNESS_STOP_GRACE_SECONDS), 'harness'],
      ['docker', 'compose', '--file', paths.composeFile, '--file', paths.overrideFile, '--project-name', 'myco', 'up', '--detach', '--force-recreate', '--wait'],
    ]);
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
    let opened!: (url: string) => void;
    const page = new Promise<string>((resolve) => { opened = resolve; });
    const pending = registerGitHubApp({ url: `${URL_}/`, org: 'goondocks-co', target, runner: r, fetchImpl, log: (l) => logs.push(l), openUrl: async (u) => opened(u) });
    const pageUrl = await page;
    expect(pageUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{16,}$/);
    expect(new URL(pageUrl).pathname).not.toBe('/callback');
    expect((await fetch(pageUrl, { method: 'HEAD' })).status).toBe(404);
    const { form, html, back } = await browse(pageUrl, async (markup) => {
      const again = await fetch(pageUrl);
      expect({ status: again.status, opened: /already opened once/.test(await again.text()) }).toEqual({ status: 404, opened: true });
      expect((await fetch(`${new URL(pageUrl).origin}/elsewhere`)).status).toBe(404);
      const port = new URL(pageUrl).port;
      expect((await fetch(`http://127.0.0.1:${port}/callback?code=good&state=forged`)).status).toBe(400);
      return stateIn(markup);
    });
    expect(form.status).toBe(200);
    expect(html).toContain('organizations/goondocks-co/settings/apps/new');
    expect(back.status).toBe(200);
    const result = await pending;
    await expect(fetch(pageUrl)).rejects.toThrow();
    expect(result).toEqual({ app: { slug: 'myco-myco-example-co', htmlUrl: 'https://github.com/apps/myco-myco-example-co', name: 'Myco (myco.example.co)', clientId: 'Iv1.deadbeef', ownerLogin: 'goondocks-co' }, callbackUrl: `${URL_}/auth/callback`, verified: { ok: true } });
    expect(calls.map((c) => c.args.slice(0, 3))).toEqual([['--no-install', 'wrangler', '--version'], ['wrangler', 'secret', 'bulk']]);
    expect(calls[1]!.options?.env?.WRANGLER_LOG).toBe('log');
    expect(JSON.parse(readFileSync(join(home, 'server', 'cloudflare', 'record.json'), 'utf8')).url).toBe(URL_);
    expect(logs.join('\n')).not.toContain('s3cr3t');
    expect(logs.join('\n')).toContain('owned by goondocks-co');
  });

  it('refuses an app owned by someone other than the organization named, installing nothing; a renamed app is accepted and said so', async () => {
    const home = mkdtempSync(join(tmpdir(), 'myco-flow-'));
    writeDeploymentRecord(RECORD, home);
    const okLocation = `https://github.com/login/oauth/authorize?client_id=Iv1.deadbeef&redirect_uri=${encodeURIComponent(`${URL_}/auth/callback`)}`;
    const withLogin = (gh: ReturnType<typeof fakeGitHub>) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === `${URL_}/auth/login`) return new Response(null, { status: 302, headers: { location: okLocation } });
      return gh.fetchImpl(input, init);
    }) as typeof fetch;
    const drive = async (opts: { org?: string; app: Parameters<typeof fakeGitHub>[0] }) => {
      let opened!: (url: string) => void;
      const page = new Promise<string>((resolve) => { opened = resolve; });
      const logs: string[] = [];
      const outcome = registerGitHubApp({ url: URL_, org: opts.org, target: resolveSignInTarget(undefined, home), runner: runner(), fetchImpl: withLogin(fakeGitHub(opts.app)), log: (l) => logs.push(l), openUrl: async (u) => opened(u) })
        .then((r) => r, (err: unknown) => err);
      const { back } = await browse(await page, stateIn);
      return { back, outcome: await outcome, logs };
    };
    calls = [];
    const foreign = await drive({ org: 'goondocks-co', app: { owner: { login: 'someone-else' } } });
    expect({ status: foreign.back.status, refused: foreign.outcome instanceof RegistrationRefused, installs: calls.length }).toEqual({ status: 200, refused: true, installs: 0 });
    const renamed = await drive({ app: { name: 'Myco sign-in (edited)' } });
    expect({ registered: (renamed.outcome as { app?: { name: string } }).app?.name, said: renamed.logs.some((l) => /edited on GitHub/.test(l)) }).toEqual({ registered: 'Myco sign-in (edited)', said: true });
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
    expect(JSON.parse(readFileSync(join(home, 'server', 'cloudflare', 'record.json'), 'utf8')).url).toBe(URL_);
    writeFileSync(join(home, 'server', 'cloudflare', 'record.json'), JSON.stringify(RECORD));
    expect(resolveSignInTarget('cloudflare', home)).toEqual({ kind: 'cloudflare', record: RECORD, mycoHome: home });
  });
});
