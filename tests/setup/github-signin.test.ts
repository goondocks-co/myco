import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import {
  APP_NAME_MAX, defaultAppName, manifestFor, registerGitHubApp, signInPendingPath,
  signInState, writeSignInPending, discardSignInPending, type RegisterOptions, type SignInTarget,
} from '@myco/server/github-app.js';
import { readDeploymentRecord, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { createLocalDeployment, DEFAULT_LOCAL_RECORD, readLocalSecrets, resolveLocalPaths, writeLocalSecrets } from '@myco/server/local.js';
import { LocalVolume, volumeIdentity } from '@myco/server/local-volume.js';
import { createBunHandler, type BunHandler } from '@myco-server-worker/entry/bun.js';
import { OAUTH_STATE_COOKIE } from '@myco-server-worker/auth/owner/github.js';
import type { CommandRunner } from '@myco/server/runner.js';
import { fakeGitHub, SETUP_APP } from './fixtures/github.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { PROTOCOL_HEADER } from '@goondocks/myco-shared/member-protocol';
import { convertedBeforeInstall } from './fixtures/interrupted-state.js';

const URL_ = 'https://setup.invalid';
const roots: string[] = [];
const handlers: BunHandler[] = [];
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-signin-'));
  roots.push(root);
  return root;
}
function responseFetch(answer: () => Response | Promise<Response>): typeof fetch {
  return Object.assign(async () => answer(), { preconnect: () => {} });
}
function redirect(clientId = SETUP_APP.clientId, callback = `${URL_}/auth/callback`) {
  return new Response(null, { status: 302, headers: { location: `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(callback)}` } });
}

describe('sign-in observations', () => {
  it('observes the native C1 login and me routes as absent with a fake OAuth boundary', async () => {
    const paths = resolveLocalPaths(fresh());
    createLocalDeployment(DEFAULT_LOCAL_RECORD, { library: null, vec0: null }, paths);
    const github = fakeGitHub();
    const handler = await createBunHandler({ databasePath: paths.databasePath, blobDir: path.join(paths.root, 'blobs'), header: 'x-forwarded-for', wakeLoop: false,
      SESSION_SECRET: readLocalSecrets(paths).SESSION_SECRET!, fetchImpl: github.fetchImpl });
    handlers.push(handler);
    const transport: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => handler.fetch(new Request(input, {
      ...init, headers: { 'x-forwarded-for': '192.0.2.1' },
    })), { preconnect: () => {} });
    for (const route of ['/auth/login', '/auth/me']) {
      const response = await transport(`${URL_}${route}`);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'sign_in_unconfigured' });
    }
    expect(await signInState(URL_, transport)).toMatchObject({ kind: 'absent' });
    expect(github.calls).toHaveLength(0);
  });
  it('classifies the merged C1 401 sign_in_unconfigured envelope as absent', async () => {
    expect(await signInState(URL_, responseFetch(() => Response.json({ error: 'sign_in_unconfigured' }, { status: 401 })))).toMatchObject({ kind: 'absent' });
  });
  it('refuses 404 and a GitHub redirect without a client id', async () => {
    expect(await signInState(URL_, responseFetch(() => new Response(null, { status: 404 })))).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('check the URL') });
    expect(await signInState(URL_, responseFetch(() => redirect('')))).toMatchObject({ kind: 'unavailable' });
  });
  for (const [status, headers, fix] of [
    [401, { [PROTOCOL_HEADER]: '2' }, 'this server is older'],
    [401, {}, "this address doesn't answer as a Myco server"],
    [404, { [PROTOCOL_HEADER]: '2' }, "this address doesn't answer as a Myco server"],
    [200, {}, "this address doesn't answer as a Myco server"],
    [503, {}, "this address doesn't answer as a Myco server"],
  ] as const) it(`refuses a bare ${status} with protocol=${PROTOCOL_HEADER in headers} before registration`, async () => {
    const fetchImpl = responseFetch(() => new Response(null, { status, headers }));
    expect(await signInState(URL_, fetchImpl)).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining(fix) });
    const f = hosted();
    await expect(registerGitHubApp({ ...f.options, fetchImpl })).rejects.toThrow(fix);
    expect(f.github.calls).toHaveLength(0);
    expect(f.installs).toHaveLength(0);
    expect(fs.existsSync(signInPendingPath(f.options.target))).toBe(false);
  });
  it('requires GitHub, a client id and the Deployment callback for configured', async () => {
    let request!: Request;
    const fetchImpl: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return redirect();
    }, { preconnect: () => {} });
    expect(await signInState(`${URL_}/`, fetchImpl)).toEqual({ kind: 'configured', clientId: SETUP_APP.clientId });
    expect(request.redirect).toBe('manual');
    expect(request.signal.aborted).toBe(false);
    expect(await signInState(URL_, responseFetch(() => redirect(SETUP_APP.clientId, 'https://other.invalid/auth/callback')))).toMatchObject({ kind: 'unavailable' });
    for (const location of ['bad', 'https://other.invalid/login']) {
      expect(await signInState(URL_, responseFetch(() => new Response(null, { status: 302, headers: { location } })))).toMatchObject({ kind: 'unavailable' });
    }
  });
  for (const failure of ['network', 'timeout', '5xx'] as const) it(`stops on ${failure} without opening GitHub or installing credentials`, async () => {
    const fetchImpl = responseFetch(() => {
      if (failure === '5xx') return new Response(null, { status: 503 });
      throw failure === 'timeout' ? new DOMException('timed out', 'TimeoutError') : new TypeError('network down');
    });
    expect(await signInState(URL_, fetchImpl)).toMatchObject({ kind: 'unavailable' });
    const f = hosted();
    await expect(registerGitHubApp({ ...f.options, fetchImpl })).rejects.toThrow(/Could not check GitHub sign-in/);
    expect(f.installs).toHaveLength(0);
    expect(fs.existsSync(signInPendingPath(f.options.target))).toBe(false);
  });
});

function hosted() {
  const home = fresh();
  const record = { accountId: 'a'.repeat(32), workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: '2026-10-10T00:00:00Z', url: URL_ };
  writeDeploymentRecord(record, home);
  const target: SignInTarget = { kind: 'cloudflare', record, mycoHome: home };
  const github = fakeGitHub();
  const installs: unknown[] = [];
  let installed = false;
  let liveClient = SETUP_APP.clientId;
  let interrupt: 'before-install' | 'after-install' | null = null;
  const runner: CommandRunner = { async run(_command, args, options) {
    if (args.includes('bulk')) {
      expect(fs.statSync(signInPendingPath(target)).mode & 0o777).toBe(0o600);
      if (interrupt === 'before-install') { interrupt = null; throw new Error('interrupted before install'); }
      const values = JSON.parse(options!.input!);
      installs.push(values);
      liveClient = values.GITHUB_CLIENT_ID;
      installed = true;
      if (interrupt === 'after-install') { interrupt = null; throw new Error('interrupted after install'); }
    } else expect(args).toEqual(['--no-install', 'wrangler', '--version']);
    return { code: 0, stdout: '', stderr: '' };
  } };
  const fetchImpl: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === `${URL_}/auth/login`) return installed ? redirect(liveClient) : Response.json({ error: 'sign_in_unconfigured' }, { status: 401 });
    return github.registrationFetch(input, init);
  }, { preconnect: () => {} });
  const options: RegisterOptions = { url: URL_, target, runner, fetchImpl, timeoutMs: 2000,
    openUrl: async () => { throw new Error('unexpected second registration'); } };
  return { options, github, installs, interruptAt: (at: typeof interrupt) => { interrupt = at; }, alreadyConfigured: (clientId = SETUP_APP.clientId) => { installed = true; liveClient = clientId; } };
}

async function registerThroughBrowser(options: RegisterOptions) {
  return registerGitHubApp({ ...options, openUrl: async (url) => {
    const html = await (await fetch(url)).text();
    const state = /state=([A-Za-z0-9_%-]+)/.exec(html)![1];
    await fetch(`${new URL(url).origin}/callback?state=${state}&code=setup-conversion`);
  } });
}

describe('durable registration recovery', () => {
  for (const step of ['conversion', 'before-install', 'after-install'] as const) it(`resumes an interruption at ${step} without creating another app`, async () => {
    const f = hosted();
    if (step !== 'conversion') f.interruptAt(step);
    await expect(registerThroughBrowser({ ...f.options, log: step === 'conversion' ? (line) => { if (line.startsWith('Installing ')) throw new Error('interrupted after conversion'); } : undefined })).rejects.toThrow(/interrupted|installation did not finish/);
    const file = signInPendingPath(f.options.target);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ ...SETUP_APP, url: URL_ });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await registerGitHubApp(f.options)).verified).toEqual({ ok: true });
    expect(f.installs).toEqual(Array.from({ length: step === 'after-install' ? 2 : 1 }, () => ({ GITHUB_CLIENT_ID: SETUP_APP.clientId, GITHUB_CLIENT_SECRET: SETUP_APP.clientSecret })));
    expect(f.github.calls).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses another callback origin, names the file and preserves its bytes', async () => {
    const f = hosted();
    await writeSignInPending(f.options.target, SETUP_APP, URL_);
    const file = signInPendingPath(f.options.target);
    const before = fs.readFileSync(file);
    await expect(registerGitHubApp({ ...f.options, url: 'https://other.invalid' })).rejects.toThrow(file);
    await expect(registerGitHubApp({ ...f.options, url: 'https://other.invalid' })).rejects.toThrow('--discard-pending');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(f.github.calls).toHaveLength(0);
    expect(f.installs).toHaveLength(0);
  });

  it('keeps pending credentials on an unavailable observation and refuses corrupt or public state', async () => {
    const f = hosted();
    await writeSignInPending(f.options.target, SETUP_APP, URL_);
    const file = signInPendingPath(f.options.target);
    const before = fs.readFileSync(file);
    await expect(registerGitHubApp({ ...f.options, fetchImpl: responseFetch(() => new Response(null, { status: 503 })) })).rejects.toThrow(/Could not check GitHub sign-in/);
    expect(fs.readFileSync(file)).toEqual(before);
    fs.chmodSync(file, 0o644);
    await expect(registerGitHubApp(f.options)).rejects.toThrow(file);
    await expect(registerGitHubApp(f.options)).rejects.toThrow('--discard-pending');
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, '{broken');
    await expect(registerGitHubApp(f.options)).rejects.toThrow(file);
    expect(f.installs).toHaveLength(0);
  });

  it('refuses a pending app over a different live client and permits explicit existing-app replacement', async () => {
    const f = hosted();
    await writeSignInPending(f.options.target, SETUP_APP, URL_);
    const file = signInPendingPath(f.options.target);
    const before = fs.readFileSync(file);
    f.alreadyConfigured('different-live-client');
    const result = await registerGitHubApp(f.options).then(() => null, (error: Error) => error.message);
    for (const detail of [file, SETUP_APP.clientId, 'different-live-client', '--discard-pending', '--existing']) expect(result).toContain(detail);
    expect(f.installs).toHaveLength(0);
    expect(f.github.calls).toHaveLength(0);
    expect(fs.readFileSync(file)).toEqual(before);
    expect((await registerGitHubApp({ ...f.options, existing: SETUP_APP })).verified.ok).toBe(true);
    expect(f.installs).toHaveLength(1);
  });

  it('names discard as the way out of a pending organization mismatch', async () => {
    const f = hosted();
    await writeSignInPending(f.options.target, SETUP_APP, URL_);
    await expect(registerGitHubApp({ ...f.options, org: 'another-org' })).rejects.toThrow('--discard-pending');
    expect(f.installs).toHaveLength(0);
  });

  it('names discard after a native origin refusal involving a pending app', async () => {
    const home = fresh();
    const paths = resolveLocalPaths(home);
    createLocalDeployment({ ...DEFAULT_LOCAL_RECORD, port: 18806 }, { library: null, vec0: null }, paths);
    await convertedBeforeInstall(home, fakeGitHub().registrationFetch, 'https://old.invalid');
    await expect(registerGitHubApp({ url: 'https://old.invalid', target: { kind: 'local', paths },
      fetchImpl: responseFetch(() => { throw new TypeError('stopped'); }) })).rejects.toThrow('--discard-pending');
  });

  it('prints the app URL before discarding a journal, including a corrupt journal', async () => {
    const f = hosted();
    await writeSignInPending(f.options.target, SETUP_APP, URL_);
    const file = signInPendingPath(f.options.target);
    const logs: string[] = [];
    await discardSignInPending(f.options.target, (line) => {
      if (line.includes(SETUP_APP.htmlUrl)) expect(fs.existsSync(file)).toBe(true);
      logs.push(line);
    });
    expect(logs[0]).toContain(SETUP_APP.htmlUrl);
    expect(logs[0]).toContain('--existing');
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, '{broken', { mode: 0o600 });
    await discardSignInPending(f.options.target, (line) => { logs.push(line); });
    expect(logs.join('\n')).toContain('could not be read');
    expect(fs.existsSync(file)).toBe(false);
    expect(f.installs).toHaveLength(0);
  });

  it('flushes the private journal before atomic publication and flushes its parent afterward', async () => {
    const f = hosted();
    const file = signInPendingPath(f.options.target);
    const events: string[] = [];
    const sync = fs.fsyncSync;
    const rename = fs.renameSync;
    const flush = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      events.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file');
      sync(fd);
    });
    const publish = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === file) {
        expect(fs.statSync(from).mode & 0o777).toBe(0o600);
        expect(JSON.parse(fs.readFileSync(from, 'utf8')).clientSecret).toBe(SETUP_APP.clientSecret);
        events.push('publish');
      }
      rename(from, to);
    });
    try { await writeSignInPending(f.options.target, SETUP_APP, URL_); }
    finally { flush.mockRestore(); publish.mockRestore(); }
    expect(events.indexOf('file')).toBeLessThan(events.indexOf('publish'));
    expect(events.lastIndexOf('directory')).toBeGreaterThan(events.indexOf('publish'));
  });

  it('preserves the prior journal when atomic publication fails', async () => {
    const f = hosted();
    await writeSignInPending(f.options.target, SETUP_APP, URL_);
    const file = signInPendingPath(f.options.target);
    const before = fs.readFileSync(file);
    const rename = fs.renameSync;
    const publish = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === file) throw new Error('interrupted publication');
      rename(from, to);
    });
    try {
      await expect(registerGitHubApp({ ...f.options, existing: { ...SETUP_APP, clientSecret: 'regenerated' } })).rejects.toThrow('interrupted publication');
    } finally { publish.mockRestore(); }
    expect(fs.readFileSync(file)).toEqual(before);
    expect(f.installs).toHaveLength(0);
  });

  it('cleans both pending tempfile formats on the next run and preserves neighboring files', async () => {
    const f = hosted();
    const file = signInPendingPath(f.options.target);
    const strays = [`${file}.123.abc123.tmp`, `${file}.tmp-123-deadbeef`];
    for (const stray of strays) fs.writeFileSync(stray, SETUP_APP.clientSecret, { mode: 0o600 });
    const neighbor = path.join(path.dirname(file), 'other.tmp');
    fs.writeFileSync(neighbor, 'keep');
    await registerGitHubApp({ ...f.options, existing: SETUP_APP });
    for (const stray of strays) expect(fs.existsSync(stray)).toBe(false);
    expect(fs.readFileSync(neighbor, 'utf8')).toBe('keep');
  });

  it('installs --existing credentials through the same pending journal without a manifest conversion', async () => {
    const f = hosted();
    const result = await registerGitHubApp({ ...f.options, existing: SETUP_APP });
    expect(result.verified).toEqual({ ok: true });
    expect(f.github.calls).toHaveLength(0);
    expect(f.installs).toHaveLength(1);
    expect(fs.existsSync(signInPendingPath(f.options.target))).toBe(false);
  });

  it('recovers an interrupted --existing install and refuses replacing another pending client', async () => {
    const f = hosted();
    f.interruptAt('before-install');
    await expect(registerGitHubApp({ ...f.options, existing: SETUP_APP })).rejects.toThrow(/interrupted|installation did not finish/);
    await expect(registerGitHubApp({ ...f.options, existing: { clientId: 'another', clientSecret: 'regenerated' } })).rejects.toThrow(/different client id/);
    expect((await registerGitHubApp(f.options)).verified.ok).toBe(true);
    expect(f.github.calls).toHaveLength(0);
    expect(f.installs).toHaveLength(1);
  });

  it('replays a regenerated secret even when the old secret still produces the same client-id redirect', async () => {
    const f = hosted();
    f.alreadyConfigured();
    f.interruptAt('before-install');
    await expect(registerGitHubApp({ ...f.options, existing: SETUP_APP })).rejects.toThrow(/installation did not finish/);
    expect(JSON.parse(fs.readFileSync(signInPendingPath(f.options.target), 'utf8')).installed).toBe(false);
    expect((await registerGitHubApp(f.options)).verified.ok).toBe(true);
    expect(f.installs).toEqual([{ GITHUB_CLIENT_ID: SETUP_APP.clientId, GITHUB_CLIENT_SECRET: SETUP_APP.clientSecret }]);
  });

  it('reconciles the target URL before clearing an installed, configured pending app', async () => {
    const f = hosted();
    if (f.options.target.kind !== 'cloudflare') throw new Error('wrong fixture target');
    const file = signInPendingPath(f.options.target);
    const parent = path.dirname(file);
    const fetchImpl: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await f.options.fetchImpl!(input, init);
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).installed) fs.chmodSync(parent, 0o500);
      return response;
    }, { preconnect: () => {} });
    try {
      await expect(registerThroughBrowser({ ...f.options, fetchImpl })).rejects.toThrow(/EACCES/);
    } finally { fs.chmodSync(parent, 0o700); }
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).installed).toBe(true);
    f.options.target.record.url = 'https://old.invalid';
    writeDeploymentRecord(f.options.target.record, f.options.target.mycoHome);
    expect((await registerGitHubApp(f.options)).verified.ok).toBe(true);
    expect(readDeploymentRecord(f.options.target.mycoHome)?.url).toBe(URL_);
    expect(f.installs).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('holds registration ownership through a conversion begun before the browser deadline', async () => {
    const f = hosted();
    const independent = new AsyncResource('independent-registration');
    const fetchImpl: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/conversions')) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        await expect(independent.runInAsyncScope(() => registerGitHubApp(f.options))).rejects.toThrow(/in use/);
      }
      return f.options.fetchImpl!(input, init);
    }, { preconnect: () => {} });
    expect((await registerThroughBrowser({ ...f.options, fetchImpl, timeoutMs: 200 })).verified.ok).toBe(true);
    expect(f.github.calls).toHaveLength(1);
  });

  it('leaves no native journal after durable installation and opens GitHub for a second native registration', async () => {
    const paths = resolveLocalPaths(fresh());
    const url = 'http://127.0.0.1:18806';
    createLocalDeployment({ ...DEFAULT_LOCAL_RECORD, port: 18806 }, { library: null, vec0: null }, paths);
    const target: SignInTarget = { kind: 'local', paths };
    const github = fakeGitHub();
    const options = { url, target, fetchImpl: github.registrationFetch, timeoutMs: 1000 };
    expect((await registerThroughBrowser(options)).verified).toMatchObject({ pendingStart: true });
    expect(fs.existsSync(signInPendingPath(target))).toBe(false);
    expect(readLocalSecrets(paths).GITHUB_CLIENT_ID).toBe(SETUP_APP.clientId);
    expect((await registerThroughBrowser({ ...options, name: 'myco Whisker Engineering' })).verified).toMatchObject({ pendingStart: true });
    expect(github.calls).toHaveLength(2);
    expect(github.calls.every((call) => call.url.endsWith('/conversions'))).toBe(true);
    expect(fs.existsSync(signInPendingPath(target))).toBe(false);
  });

  it('clears a completed native journal matching secrets.env before a fresh registration, even at an old URL', async () => {
    const paths = resolveLocalPaths(fresh());
    const url = 'http://127.0.0.1:18806';
    createLocalDeployment({ ...DEFAULT_LOCAL_RECORD, port: 18806 }, { library: null, vec0: null }, paths);
    writeLocalSecrets({ GITHUB_CLIENT_ID: SETUP_APP.clientId, GITHUB_CLIENT_SECRET: SETUP_APP.clientSecret }, paths);
    const target: SignInTarget = { kind: 'local', paths };
    const record = await writeSignInPending(target, SETUP_APP, 'https://old.invalid');
    atomicWriteFileSync(signInPendingPath(target), JSON.stringify({ ...record, installed: true }), { mode: 0o600, durable: true });
    const github = fakeGitHub();
    await registerThroughBrowser({ url, target, fetchImpl: github.registrationFetch, name: 'Myco Renamed', timeoutMs: 1000 });
    expect(github.calls).toHaveLength(1);
    expect(fs.existsSync(signInPendingPath(target))).toBe(false);
  });

  it('clears an installed native journal matching the live client without reinstalling it', async () => {
    const paths = resolveLocalPaths(fresh());
    const url = 'http://127.0.0.1:18806';
    createLocalDeployment({ ...DEFAULT_LOCAL_RECORD, port: 18806 }, { library: null, vec0: null }, paths);
    const target: SignInTarget = { kind: 'local', paths };
    const record = await writeSignInPending(target, SETUP_APP, url);
    atomicWriteFileSync(signInPendingPath(target), JSON.stringify({ ...record, installed: true }), { mode: 0o600, durable: true });
    const result = await registerGitHubApp({ url, target, fetchImpl: responseFetch(() => redirect(SETUP_APP.clientId, `${url}/auth/callback`)),
      openUrl: async () => { throw new Error('must not register again'); }, timeoutMs: 1000 });
    expect(result.verified.ok).toBe(true);
    expect(readLocalSecrets(paths).GITHUB_CLIENT_ID).toBeUndefined();
    expect(fs.existsSync(signInPendingPath(target))).toBe(false);
  });

  it('resumes the PR B artifact on a stopped native Deployment, clears its journal after writing secrets and exercises real OAuth with fake GitHub', async () => {
    const home = fresh();
    const paths = resolveLocalPaths(home);
    const url = 'http://127.0.0.1:18806';
    createLocalDeployment({ ...DEFAULT_LOCAL_RECORD, port: 18806 }, { library: null, vec0: null }, paths);
    const github = fakeGitHub();
    const artifact = await convertedBeforeInstall(home, github.registrationFetch, url);
    const target: SignInTarget = { kind: 'local', paths };
    const options: RegisterOptions = { url, target, fetchImpl: responseFetch(() => { throw new TypeError('stopped'); }), openUrl: async () => { throw new Error('must not register again'); } };
    expect((await registerGitHubApp(options)).verified).toMatchObject({ pendingStart: true });
    expect(readLocalSecrets(paths)).toMatchObject({ GITHUB_CLIENT_ID: SETUP_APP.clientId, GITHUB_CLIENT_SECRET: SETUP_APP.clientSecret });
    expect(fs.existsSync(artifact.file)).toBe(false);
    const secrets = readLocalSecrets(paths);
    const handler = await createBunHandler({ databasePath: paths.databasePath, blobDir: path.join(paths.root, 'blobs'), header: 'x-forwarded-for', wakeLoop: false,
      GITHUB_CLIENT_ID: secrets.GITHUB_CLIENT_ID!, GITHUB_CLIENT_SECRET: secrets.GITHUB_CLIENT_SECRET!, SESSION_SECRET: secrets.SESSION_SECRET!, fetchImpl: github.fetchImpl });
    handlers.push(handler);
    const transport: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== url) throw new Error('real network fallback');
      return handler.fetch(new Request(request, { headers: { 'x-forwarded-for': '192.0.2.1' } }));
    }, { preconnect: () => {} });
    const serving = await new LocalVolume(paths).serve({ pending: () => false, startup: () => {}, identity: () => volumeIdentity(paths.databasePath, () => null), start: async () => ({ stop: async () => {} }) });
    try {
      expect(await signInState(url, transport)).toEqual({ kind: 'configured', clientId: SETUP_APP.clientId });
      const login = await transport(`${url}/auth/login`);
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
      const callback = await handler.fetch(new Request(`${url}/auth/callback?code=owner&state=${encodeURIComponent(state)}`, {
        headers: { 'x-forwarded-for': '192.0.2.1', cookie: `${OAUTH_STATE_COOKIE}=${state}` },
      }));
      expect(callback.status).toBe(302);
      expect(github.calls.map((call) => call.url)).toEqual(['https://api.github.com/app-manifests/setup-conversion/conversions', 'https://github.com/login/oauth/access_token', 'https://api.github.com/user']);
    } finally { await serving.stop(); }
  });
});

describe('GitHub App names', () => {
  it('lets the operator retry a GitHub name collision with a chosen name', async () => {
    const f = hosted();
    const fetchImpl: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/conversions')) return Response.json({ message: 'Name is already in use' }, { status: 422 });
      return f.options.fetchImpl!(input, init);
    }, { preconnect: () => {} });
    await expect(registerThroughBrowser({ ...f.options, fetchImpl, name: 'Myco Sign In' })).rejects.toThrow(/HTTP 422/);
    expect(f.installs).toHaveLength(0);
    expect(fs.existsSync(signInPendingPath(f.options.target))).toBe(false);
    expect((await registerThroughBrowser({ ...f.options, name: 'myco Whisker Engineering' })).verified.ok).toBe(true);
    expect(f.installs).toHaveLength(1);
  });
  it('keeps a short host, shortens long hosts deterministically and distinguishes first-label collisions', () => {
    expect(defaultAppName('https://myco.example.com')).toBe('Myco (myco.example.com)');
    const host = 'myco-server.example-account.workers.dev';
    const hash = createHash('sha256').update(host).digest('hex').slice(0, 4);
    expect(defaultAppName(`https://${host}`)).toBe(`Myco (myco-server-${hash})`);
    const a = defaultAppName('https://same-name.very-long-account-a.workers.dev');
    const b = defaultAppName('https://same-name.very-long-account-b.workers.dev');
    expect(a).not.toBe(b);
    for (const name of [a, b, defaultAppName(`https://${'x'.repeat(63)}.workers.dev`)]) expect(name.length).toBeLessThanOrEqual(APP_NAME_MAX);
  });
  it('uses machine hostname and port for loopback, and passes the operator name through', () => {
    expect(defaultAppName('http://127.0.0.1:8787', 'work-laptop')).toBe(`Myco (work-laptop-${createHash('sha256').update('work-laptop:8787').digest('hex').slice(0, 4)}:8787)`);
    expect(defaultAppName('http://[::1]:8787', 'home-laptop')).not.toBe(defaultAppName('http://127.0.0.1:8787', 'work-laptop'));
    expect(defaultAppName('http://127.0.0.1:8787', 'x'.repeat(70)).length).toBeLessThanOrEqual(APP_NAME_MAX);
    for (const host of ['127.0.0.2', '127.12.34.56', '127.255.255.255', '[::1]']) {
      expect(defaultAppName(`http://${host}:8787`, 'work-laptop')).toBe(defaultAppName('http://127.0.0.1:8787', 'work-laptop'));
    }
    expect(manifestFor({ url: URL_, redirectUrl: 'http://127.0.0.1/callback', name: 'myco Whisker Engineering' }).name).toBe('myco Whisker Engineering');
  });
  it('refuses empty or overlong explicit names and invalid credentials before opening GitHub', async () => {
    const f = hosted();
    for (const name of ['', 'x'.repeat(APP_NAME_MAX + 1)]) await expect(registerGitHubApp({ ...f.options, name })).rejects.toThrow(/--name/);
    for (const clientSecret of ['', 'bad\nsecret']) await expect(registerGitHubApp({ ...f.options, existing: { clientId: 'id', clientSecret } })).rejects.toThrow(/single-line/);
    expect(f.github.calls).toHaveLength(0);
    expect(f.installs).toHaveLength(0);
  });
});
