/**
 * Sign-in that sets itself up: a GitHub App registered from a manifest, by
 * the operator's own machine, and installed as the Deployment's secrets.
 *
 * The dashboard signs users in through GitHub's web flow, which needs a client
 * id and secret held by the Deployment and a callback URL registered on
 * GitHub for the Deployment's host. GitHub creates such an app from a manifest
 * in one click: this module serves the manifest form on a loopback listener,
 * receives the temporary code GitHub redirects back with, converts it into the
 * app's credentials, and hands them to the target — the Worker's secrets on
 * Cloudflare, the native volume's secrets, or the Compose bundle's secrets. Nothing here is
 * relayed through a server Myco runs; the app belongs to the operator or the
 * organization they name.
 *
 * The app is public. GitHub lets only members of the owning account authorize
 * a private app, and authorization is the sign-in flow — a private app would
 * sign in its owner and nobody else. Installation is never used; membership
 * is decided by the Deployment on every request.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import fs, { existsSync } from 'node:fs';
import { writePrivateFileAtomic, isPrivateMode } from '@myco/member/store.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { LocalVolume } from '@myco/server/local-volume.js';
import { withCloudflareOperation } from '@myco/server/cloudflare-operation.js';
import { deploymentRecordPath, putWorkerSecrets, readDeploymentRecord, writeDeploymentRecord, type DeploymentRecord } from './cloudflare.js';
import { assertComposeReadable, recreateDeployment, resolveDeploymentPaths, writeSignInSecrets, type DeploymentPaths } from './deployment.js';
import { systemRunner, type CommandRunner } from './runner.js';
import { configureLocalSignIn, localDeploymentPresent, resolveLocalPaths, type LocalDeploymentPaths } from './local.js';
import { localOwnerLinked } from './local-owner.js';
import { carriedNative } from './local-run.js';

const LOOPBACK = '127.0.0.1';
const GITHUB_API = 'https://api.github.com';
const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
/** GitHub's limit on an app's name. */
export const APP_NAME_MAX = 34;
/** How long the operator has to click before the command gives up. */
export const REGISTRATION_TIMEOUT_MS = 10 * 60_000;
/** The verify probe: attempts and the pause between them, for a Worker whose secrets are still propagating. */
export const VERIFY_ATTEMPTS = 6;
export const VERIFY_PAUSE_MS = 5_000;

export interface GitHubAppManifest {
  name: string;
  url: string;
  redirect_url: string;
  callback_urls: string[];
  public: true;
  default_permissions: Record<string, never>;
}

/** The credentials GitHub answers a manifest conversion with; the app's key and webhook secret are never read. */
export interface RegisteredApp {
  clientId: string;
  clientSecret: string;
  slug: string;
  htmlUrl: string;
  name: string;
  ownerLogin: string | null;
}

export type SignInTarget =
  | { kind: 'cloudflare'; record: DeploymentRecord; mycoHome?: string }
  | { kind: 'local'; paths: LocalDeploymentPaths }
  | { kind: 'compose'; paths: DeploymentPaths };

export interface RegisterOptions {
  /** The Deployment's public URL; its origin is the callback host. */
  url: string;
  /** The organization to own the app; the operator's own account when absent. */
  org?: string;
  name?: string;
  existing?: Pick<RegisteredApp, 'clientId' | 'clientSecret'>;
  target: SignInTarget;
  runner?: CommandRunner;
  fetchImpl?: typeof fetch;
  /** Opens the manifest page in the operator's browser; the URL is printed too. */
  openUrl?: (url: string) => Promise<void>;
  log?: (line: string) => void;
  timeoutMs?: number;
  /** The local port to listen on; 0 lets the system choose. */
  port?: number;
}

export interface RegistrationResult {
  app: Pick<RegisteredApp, 'slug' | 'htmlUrl' | 'name' | 'clientId' | 'ownerLogin'>;
  callbackUrl: string;
  verified: VerifyResult;
}

export class RegistrationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationRefused';
  }
}

/** A callback URL uses https, or plain http to a loopback literal. */
export function isDeploymentUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === LOOPBACK || url.hostname === '[::1]' || url.hostname === '::1');
}

/** The manifest GitHub receives: identity only — no permissions, no webhook, public. */
export function manifestFor(opts: { url: string; name?: string; redirectUrl: string; machineHostname?: string }): GitHubAppManifest {
  const origin = new URL(opts.url).origin;
  return {
    name: opts.name ?? defaultAppName(opts.url, opts.machineHostname),
    url: origin,
    redirect_url: opts.redirectUrl,
    callback_urls: [`${origin}/auth/callback`],
    public: true,
    default_permissions: {},
  };
}

/** Host-derived names fit GitHub's limit and distinguish loopback Deployments by machine and port. */
export function defaultAppName(url: string, machineHostname = hostname()): string {
  const address = new URL(url);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(address.hostname);
  const host = loopback ? `${machineHostname}:${address.port || (address.protocol === 'https:' ? '443' : '80')}` : address.host;
  const full = `Myco (${host})`;
  if (full.length <= APP_NAME_MAX) return full;
  const hash = createHash('sha256').update(host).digest('hex').slice(0, 4);
  const label = host.split('.')[0];
  const suffix = loopback ? `:${address.port || (address.protocol === 'https:' ? '443' : '80')}` : '';
  const available = APP_NAME_MAX - 'Myco ()'.length - '-'.length - hash.length - suffix.length;
  return `Myco (${label.slice(0, available)}-${hash}${suffix})`;
}

/** Where the manifest form posts: the operator's account, or the organization named. */
export function manifestFormAction(org: string | undefined, state: string): string {
  const base = org === undefined ? 'https://github.com/settings/apps/new' : `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The page the browser opens: one form, one button, submitted on load. */
export function manifestPage(manifest: GitHubAppManifest, action: string): string {
  return [
    '<!doctype html><meta charset="utf-8"><title>Register the Myco sign-in app</title>',
    '<body style="font-family:system-ui;margin:3rem auto;max-width:36rem;line-height:1.5">',
    `<h1>Register the sign-in app for ${escapeHtml(manifest.url)}</h1>`,
    '<p>GitHub will show the app it is about to create. Confirm it there; this page then finishes on its own.</p>',
    `<form method="post" action="${escapeHtml(action)}">`,
    `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">`,
    '<button type="submit">Create GitHub App</button></form>',
    '<script>document.forms[0].submit()</script>',
  ].join('\n');
}

const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>Received</title><body style="font-family:system-ui;margin:3rem auto;max-width:36rem"><h1>Received.</h1><p>Return to the terminal; it reports what GitHub answered and installs the credentials.</p>';
const NOT_FOUND_PAGE = '<!doctype html><meta charset="utf-8"><title>Not found</title>';
const OPENED_ONCE_PAGE = '<!doctype html><meta charset="utf-8"><title>Already opened</title><body style="font-family:system-ui;margin:3rem auto;max-width:36rem"><h1>This page was already opened once.</h1><p>Run the command again for a fresh one.</p>';

/** Convert the temporary code GitHub redirected with into the app's credentials. */
export async function convertManifestCode(code: string, fetchImpl: typeof fetch = fetch): Promise<RegisteredApp> {
  const res = await fetchImpl(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
  });
  if (res.status !== 201) throw new RegistrationRefused(`GitHub did not convert the registration (HTTP ${res.status})`);
  const body = await res.json() as { client_id?: unknown; client_secret?: unknown; slug?: unknown; html_url?: unknown; name?: unknown; owner?: { login?: unknown } | null };
  if (typeof body.client_id !== 'string' || typeof body.client_secret !== 'string' || typeof body.slug !== 'string' || typeof body.html_url !== 'string' || typeof body.name !== 'string') {
    throw new RegistrationRefused('GitHub answered the registration without the app credentials');
  }
  return { clientId: body.client_id, clientSecret: body.client_secret, slug: body.slug, htmlUrl: body.html_url, name: body.name, ownerLogin: typeof body.owner?.login === 'string' ? body.owner.login : null };
}

/** The target's own way of holding the two secrets. */
export async function installSignInSecrets(target: SignInTarget, app: Pick<RegisteredApp, 'clientId' | 'clientSecret'>, runner?: CommandRunner): Promise<void> {
  if (target.kind === 'local') {
    return configureLocalSignIn(target.paths, async (install) => { install(app); });
  }
  if (target.kind === 'cloudflare') {
    await putWorkerSecrets({ accountId: target.record.accountId, workerName: target.record.workerName, runner, mycoHome: target.mycoHome }, { GITHUB_CLIENT_ID: app.clientId, GITHUB_CLIENT_SECRET: app.clientSecret });
    return;
  }
  // The credential is written only once the recreate that applies it is known
  // to be possible, and the check reads the same file set that recreate will:
  // a Deployment must never hold a sign-in secret it is not serving with.
  await assertComposeReadable({ paths: target.paths, runner: runner ?? systemRunner() });
  writeSignInSecrets(target.paths, { clientId: app.clientId, clientSecret: app.clientSecret });
  await recreateDeployment({ paths: target.paths, runner });
}

export type VerifyResult = { ok: true } | { ok: false; reason: string; pendingStart?: true };

/**
 * The Deployment now sends a visitor to GitHub for this app and back to its own
 * callback: `GET /auth/login` answers 302 to GitHub's authorize URL carrying
 * the new client id and a `redirect_uri` on the Deployment's origin. Retried,
 * since a Worker's secrets take a moment to reach every edge.
 */
export async function verifySignIn(url: string, clientId: string, deps: { fetchImpl?: typeof fetch; attempts?: number; pauseMs?: number } = {}): Promise<VerifyResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const attempts = deps.attempts ?? VERIFY_ATTEMPTS;
  const origin = new URL(url).origin;
  let last: VerifyResult = { ok: false, reason: 'not attempted' };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, deps.pauseMs ?? VERIFY_PAUSE_MS));
    last = await probeSignIn(origin, clientId, fetchImpl);
    if (last.ok) return last;
  }
  return last;
}

/**
 * Whether the Deployment at `url` signs in with GitHub now: its `/auth/login` redirects to GitHub's authorize page with a
 * client id and its own callback. Owner setup asks this before it mints a link that sign-in must then confirm.
 */
export async function signInConfigured(url: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  return probeSignIn(new URL(url).origin, null, fetchImpl);
}

export type SignInState =
  | { kind: 'configured'; clientId: string }
  | { kind: 'absent' | 'unavailable'; reason: string };

/** Observe the sign-in redirect without following it or starting an OAuth round trip. */
export async function signInState(url: string, fetchImpl: typeof fetch = fetch, clientId: string | null = null): Promise<SignInState> {
  const origin = new URL(url).origin;
  let res: Response;
  try {
    res = await fetchImpl(`${origin}/auth/login`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { kind: 'unavailable', reason: `${origin} did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  await res.body?.cancel();
  if (res.status === 401 || res.status === 404) return { kind: 'absent', reason: `${origin}/auth/login answered ${res.status}; the sign-in secrets are not in place` };
  if (res.status !== 302) return { kind: 'unavailable', reason: `${origin}/auth/login answered ${res.status}` };
  let target: URL;
  try {
    target = new URL(res.headers.get('location') ?? '');
  } catch {
    return { kind: 'unavailable', reason: `${origin}/auth/login redirected to an unreadable location` };
  }
  if (`${target.origin}${target.pathname}` !== GITHUB_AUTHORIZE) return { kind: 'unavailable', reason: `${origin}/auth/login redirected to ${target.origin}${target.pathname}, not GitHub` };
  const presented = target.searchParams.get('client_id');
  if (!presented) return { kind: 'absent', reason: 'the Deployment names no client id' };
  if (clientId !== null && presented !== clientId) return { kind: 'unavailable', reason: 'the Deployment signs in with a different client id' };
  const redirectUri = target.searchParams.get('redirect_uri');
  if (redirectUri !== `${origin}/auth/callback`) return { kind: 'unavailable', reason: `the Deployment's callback is ${redirectUri ?? 'absent'}, not ${origin}/auth/callback` };
  return { kind: 'configured', clientId: presented };
}

async function probeSignIn(origin: string, clientId: string | null, fetchImpl: typeof fetch): Promise<VerifyResult> {
  const state = await signInState(origin, fetchImpl, clientId);
  return state.kind === 'configured' ? { ok: true } : { ok: false, reason: state.reason };
}

export interface PendingSignIn extends RegisteredApp { url: string; at: number; installed: boolean }

/** Private conversion credentials, scoped to the target and callback origin. */
export function signInPendingPath(target: SignInTarget): string {
  return path.join(target.kind === 'cloudflare' ? path.dirname(deploymentRecordPath(target.mycoHome)) : target.paths.root, 'sign-in-pending.json');
}

function readSignInPending(target: SignInTarget, url: string): PendingSignIn | null {
  const file = signInPendingPath(target);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || !isPrivateMode(stat.mode)) throw new Error('pending registration must be a private regular file');
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value === null || typeof value !== 'object') throw new Error('invalid pending registration');
    const pending = value as PendingSignIn;
    if (!['clientId', 'clientSecret', 'slug', 'htmlUrl', 'name', 'url'].every((key) => typeof Reflect.get(pending, key) === 'string')
      || !Number.isFinite(pending.at) || !(pending.ownerLogin === null || typeof pending.ownerLogin === 'string')
      || !(pending.installed === undefined || typeof pending.installed === 'boolean')) throw new Error('invalid pending registration');
    validateCredentials(pending);
    if (pending.url !== new URL(url).origin) throw new RegistrationRefused(`pending sign-in registration at ${file} belongs to ${pending.url}; use that URL to finish it before registering another app`);
    return { ...pending, installed: pending.installed === true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof RegistrationRefused) throw error;
    throw new RegistrationRefused(`cannot read pending sign-in registration at ${file}; restore the private file and run server github-app again`);
  }
}

function validateCredentials(app: Pick<RegisteredApp, 'clientId' | 'clientSecret'>): void {
  if (![app.clientId, app.clientSecret].every((value) => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\r\n\0]/.test(value))) {
    throw new RegistrationRefused('GitHub client id and secret must be non-empty single-line values; use --existing --client-id <id> --client-secret-stdin');
  }
}

function persistSignInPending(target: SignInTarget, app: RegisteredApp, url: string, at: number, installed = false): PendingSignIn {
  validateCredentials(app);
  const pending = { ...app, url: new URL(url).origin, at, installed };
  const file = signInPendingPath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(file, `${JSON.stringify(pending)}\n`);
  return pending;
}

async function withRegistrationLock<T>(target: SignInTarget, operation: () => Promise<T>): Promise<T> {
  if (target.kind === 'cloudflare') return withCloudflareOperation(target.mycoHome, operation);
  const root = target.paths.root;
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
  const held = LifecycleLock.acquire(`${root}.sign-in.lock`, { command: 'myco server github-app' });
  if (!held.acquired) throw new RegistrationRefused('sign-in registration is already in progress; wait for it to finish and run the command again');
  try { return await operation(); } finally { held.lock.release(); }
}

/** Stage converted credentials under the target's mutation lease, before installation. */
export async function writeSignInPending(target: SignInTarget, app: RegisteredApp, url: string, at = Date.now()): Promise<PendingSignIn> {
  return withRegistrationLock(target, async () => {
    if (readSignInPending(target, url) !== null) throw new RegistrationRefused(`pending sign-in registration already exists at ${signInPendingPath(target)}; run server github-app again to resume it`);
    const write = () => persistSignInPending(target, app, url, at);
    return target.kind === 'local' ? new LocalVolume(target.paths).exclusive(write) : write();
  });
}

/** Multiple recorded Deployments require an explicit target. */
export function resolveSignInTarget(named: string | undefined, mycoHome?: string): SignInTarget {
  const record = readDeploymentRecord(mycoHome);
  const paths = resolveDeploymentPaths(mycoHome);
  const bundle = existsSync(paths.composeFile);
  const localPaths = resolveLocalPaths(mycoHome);
  const local = localDeploymentPresent(localPaths);
  if (named === 'local') {
    if (!local) throw new RegistrationRefused('no native Deployment on this machine; `myco server create --target local` provisions one');
    return { kind: 'local', paths: localPaths };
  }
  if (named === 'cloudflare') {
    if (record === null) throw new RegistrationRefused('no Cloudflare Deployment record on this machine');
    return { kind: 'cloudflare', record, mycoHome };
  }
  if (named === 'compose') {
    if (!bundle) throw new RegistrationRefused('no Compose bundle on this machine; `myco server create` writes one');
    return { kind: 'compose', paths };
  }
  if (named !== undefined) throw new RegistrationRefused(`--target must be local, cloudflare or compose, and is ${JSON.stringify(named)}`);
  if ([record !== null, bundle, local].filter(Boolean).length > 1) throw new RegistrationRefused('this machine holds multiple Deployments; pass --target local, --target cloudflare or --target compose');
  if (local) return { kind: 'local', paths: localPaths };
  if (record !== null) return { kind: 'cloudflare', record, mycoHome };
  if (bundle) return { kind: 'compose', paths };
  throw new RegistrationRefused('no Deployment on this machine: no native record, Cloudflare record or Compose bundle');
}

/** The whole flow, start to verified. */
export async function registerGitHubApp(options: RegisterOptions): Promise<RegistrationResult> {
  if (!isDeploymentUrl(options.url)) throw new RegistrationRefused(`${options.url} is not an https Deployment URL`);
  if (options.existing !== undefined) validateCredentials(options.existing);
  const proposedName = manifestFor({ url: options.url, name: options.name, redirectUrl: 'http://127.0.0.1/callback' }).name;
  if (proposedName.trim() === '' || proposedName.length > APP_NAME_MAX) throw new RegistrationRefused(`GitHub requires an app name of 1 to ${APP_NAME_MAX} characters; pass --name <shorter>`);
  return withRegistrationLock(options.target, async () => {
    const pending = readSignInPending(options.target, options.url);
    if (pending !== null) assertRegistrationOwner(options, pending, true);
    if (pending !== null && options.existing !== undefined && pending.clientId !== options.existing.clientId) {
      throw new RegistrationRefused(`pending sign-in registration at ${signInPendingPath(options.target)} has a different client id; resume it before installing another app`);
    }
    if (pending !== null || options.target.kind !== 'local') {
      const state = await signInState(options.url, options.fetchImpl);
      if (pending?.installed && state.kind === 'configured' && state.clientId === pending.clientId && options.existing === undefined) {
        recordSignInUrl(options);
        const clear = () => fs.unlinkSync(signInPendingPath(options.target));
        // The registration lock owns the journal; the shared lease preserves the served volume's identity.
        if (options.target.kind === 'local') await new LocalVolume(options.target.paths).reading(async () => { clear(); });
        else clear();
        return registrationResult(pending, options.url, { ok: true });
      }
      if (state.kind === 'unavailable' && options.target.kind !== 'local') throw new RegistrationRefused(`${state.reason}; sign-in state is unavailable. Check the Deployment and run server github-app again; no new app was registered.`);
    }
    if (options.target.kind === 'local') {
      const result = await configureLocalSignIn(options.target.paths,
        (install) => registerWithInstaller(options, async (app) => { install(app); }, pending), options.url);
      const linked = existsSync(options.target.paths.databasePath) && await localOwnerLinked(options.target.paths, carriedNative());
      return { ...result, verified: { ok: false, pendingStart: true, reason: linked ? LOCAL_START_NEXT : `While it's stopped: myco server setup-owner --target local. Then ${LOCAL_START_NEXT}` } };
    }
    return registerWithInstaller(options, (app) => installSignInSecrets(options.target, app, options.runner), pending);
  });
}

const LOCAL_START_NEXT = 'start it: myco server install --target local.';

async function registerWithInstaller(options: RegisterOptions, install: (app: RegisteredApp) => Promise<void>, pending: PendingSignIn | null): Promise<RegistrationResult> {
  const log = options.log ?? (() => undefined);
  const fetchImpl = options.fetchImpl ?? fetch;
  const state = randomBytes(32).toString('base64url');
  const formPath = `/${randomBytes(16).toString('base64url')}`;

  const app = options.existing !== undefined ? {
    ...options.existing, slug: pending?.slug ?? '', htmlUrl: pending?.htmlUrl ?? 'https://github.com/settings/apps',
    name: pending?.name ?? options.name ?? 'Existing GitHub App', ownerLogin: pending?.ownerLogin ?? null,
  } : pending ?? await new Promise<RegisteredApp>((resolve, reject) => {
    let formServed = false;
    let callbackTaken = false;
    let manifest: GitHubAppManifest | null = null;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
      if (url.pathname === formPath && req.method === 'GET' && formServed) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(OPENED_ONCE_PAGE);
        return;
      }
      if (url.pathname === formPath && req.method === 'GET' && !formServed && manifest !== null) {
        formServed = true;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(manifestPage(manifest, manifestFormAction(options.org, state)));
        return;
      }
      if (url.pathname === '/callback' && req.method === 'GET' && !callbackTaken) {
        const code = url.searchParams.get('code');
        if (url.searchParams.get('state') !== state || code === null || code === '') {
          // Not the registration this command started; the listener keeps waiting for it.
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('This registration was not started by the command that is listening here.');
          return;
        }
        callbackTaken = true;
        clearTimeout(timer);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(DONE_PAGE);
        convertManifestCode(code, fetchImpl).then((converted) => {
          finish(null, converted);
        }).catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(NOT_FOUND_PAGE);
    });
    const timer = setTimeout(() => finish(new RegistrationRefused(`no registration arrived within ${Math.round((options.timeoutMs ?? REGISTRATION_TIMEOUT_MS) / 60_000)} minutes`)), options.timeoutMs ?? REGISTRATION_TIMEOUT_MS);
    let settled = false;
    function finish(err: Error | null, value?: RegisteredApp): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err !== null) reject(err);
      else resolve(value!);
    }
    server.on('error', (err) => finish(err));
    server.listen(options.port ?? 0, LOOPBACK, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return finish(new Error('the loopback listener did not report a port'));
      const local = `http://${LOOPBACK}:${address.port}`;
      manifest = manifestFor({ url: options.url, name: options.name, redirectUrl: `${local}/callback` });
      const page = `${local}${formPath}`;
      log(`Open this page to register the app (it opens on its own where a browser is available):\n  ${page}`);
      (options.openUrl ?? (async () => undefined))(page).catch(() => undefined);
    });
  });

  if (pending === null) assertRegistrationOwner(options, app, false);
  if (pending === null || options.existing !== undefined) persistSignInPending(options.target, app, options.url, Date.now());
  if (pending === null && options.existing === undefined && app.name !== (options.name ?? defaultAppName(options.url))) {
    log(`GitHub registered the app as ${JSON.stringify(app.name)} (the name was edited on GitHub's page).`);
  }
  log(`Installing ${app.name}, owned by ${app.ownerLogin ?? 'the signed-in account'} (${app.htmlUrl}) on the Deployment…`);
  await install(app);
  persistSignInPending(options.target, app, options.url, pending?.at ?? Date.now(), true);
  recordSignInUrl(options);
  const verified: VerifyResult = options.target.kind === 'local'
    ? { ok: false, pendingStart: true, reason: LOCAL_START_NEXT }
    : await verifySignIn(options.url, app.clientId, { fetchImpl });
  if (verified.ok) fs.unlinkSync(signInPendingPath(options.target));
  return registrationResult(app, options.url, verified);
}

function registrationResult(app: RegisteredApp, url: string, verified: VerifyResult): RegistrationResult {
  return { app: { slug: app.slug, htmlUrl: app.htmlUrl, name: app.name, clientId: app.clientId, ownerLogin: app.ownerLogin }, callbackUrl: `${new URL(url).origin}/auth/callback`, verified };
}

function recordSignInUrl(options: RegisterOptions): void {
  if (options.target.kind === 'cloudflare' && options.target.record.url !== new URL(options.url).origin) {
    writeDeploymentRecord({ ...options.target.record, url: new URL(options.url).origin }, options.target.mycoHome);
  }
}

function assertRegistrationOwner(options: RegisterOptions, app: RegisteredApp, pending: boolean): void {
  if (options.org === undefined || app.ownerLogin?.toLowerCase() === options.org.toLowerCase()) return;
  const next = pending
    ? `The pending app is saved at ${signInPendingPath(options.target)}; run the same command without --org to finish it before registering another app.`
    : `Delete the unwanted app at ${app.htmlUrl}, then run the command again for ${options.org}.`;
  throw new RegistrationRefused(`GitHub answered with an app owned by ${app.ownerLogin ?? 'an unknown account'}, not ${options.org}. ${next}`);
}
