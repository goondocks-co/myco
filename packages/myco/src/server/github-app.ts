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
 * Cloudflare, the bundle's secret file and `.env` on Compose. Nothing here is
 * relayed through a server Myco runs; the app belongs to the operator or the
 * organization they name.
 *
 * The app is public. GitHub lets only members of the owning account authorize
 * a private app, and authorization is the sign-in flow — a private app would
 * sign in its owner and nobody else. Installation is never used; membership
 * is decided by the Deployment on every request.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { putWorkerSecrets, readDeploymentRecord, writeDeploymentRecord, type DeploymentRecord } from './cloudflare.js';
import { assertComposeReadable, recreateDeployment, resolveDeploymentPaths, writeSignInSecrets, type DeploymentPaths } from './deployment.js';
import { systemRunner, type CommandRunner } from './runner.js';

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
  | { kind: 'compose'; paths: DeploymentPaths };

export interface RegisterOptions {
  /** The Deployment's public URL; its origin is the callback host. */
  url: string;
  /** The organization to own the app; the operator's own account when absent. */
  org?: string;
  name?: string;
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

/** A URL a callback may be registered for: https, or plain http to a loopback literal for a local Compose smoke. */
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
export function manifestFor(opts: { url: string; name?: string; redirectUrl: string }): GitHubAppManifest {
  const origin = new URL(opts.url).origin;
  return {
    name: opts.name ?? `Myco (${new URL(opts.url).host})`,
    url: origin,
    redirect_url: opts.redirectUrl,
    callback_urls: [`${origin}/auth/callback`],
    public: true,
    default_permissions: {},
  };
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
  if (target.kind === 'cloudflare') {
    await putWorkerSecrets({ accountId: target.record.accountId, workerName: target.record.workerName, runner }, { GITHUB_CLIENT_ID: app.clientId, GITHUB_CLIENT_SECRET: app.clientSecret });
    return;
  }
  // The credential is written only once the recreate that applies it is known
  // to be possible, and the check reads the same file set that recreate will:
  // a Deployment must never hold a sign-in secret it is not serving with.
  await assertComposeReadable({ paths: target.paths, runner: runner ?? systemRunner() });
  writeSignInSecrets(target.paths, { clientId: app.clientId, clientSecret: app.clientSecret });
  await recreateDeployment({ paths: target.paths, runner });
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

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

async function probeSignIn(origin: string, clientId: string, fetchImpl: typeof fetch): Promise<VerifyResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${origin}/auth/login`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { ok: false, reason: `${origin} did not answer: ${(err as Error).message}` };
  }
  if (res.status !== 302) return { ok: false, reason: `${origin}/auth/login answered ${res.status}; the sign-in secrets are not in place` };
  const location = res.headers.get('location') ?? '';
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    return { ok: false, reason: `${origin}/auth/login redirected to an unreadable location` };
  }
  if (`${target.origin}${target.pathname}` !== GITHUB_AUTHORIZE) return { ok: false, reason: `${origin}/auth/login redirected to ${target.origin}${target.pathname}, not GitHub` };
  if (target.searchParams.get('client_id') !== clientId) return { ok: false, reason: 'the Deployment signs in with a different client id' };
  const redirectUri = target.searchParams.get('redirect_uri');
  if (redirectUri !== `${origin}/auth/callback`) return { ok: false, reason: `the Deployment's callback is ${redirectUri ?? 'absent'}, not ${origin}/auth/callback` };
  return { ok: true };
}

/** The target the operator's machine holds: the Cloudflare record, or the Compose bundle. Both present needs `--target`. */
export function resolveSignInTarget(named: string | undefined, mycoHome?: string): SignInTarget {
  const record = readDeploymentRecord(mycoHome);
  const paths = resolveDeploymentPaths(mycoHome);
  const bundle = existsSync(paths.composeFile);
  if (named === 'cloudflare') {
    if (record === null) throw new RegistrationRefused('no Cloudflare Deployment record on this machine');
    return { kind: 'cloudflare', record, mycoHome };
  }
  if (named === 'compose') {
    if (!bundle) throw new RegistrationRefused('no Compose bundle on this machine; `myco server create` writes one');
    return { kind: 'compose', paths };
  }
  if (named !== undefined) throw new RegistrationRefused(`--target must be cloudflare or compose, and is ${JSON.stringify(named)}`);
  if (record !== null && bundle) throw new RegistrationRefused('this machine holds both a Cloudflare record and a Compose bundle; pass --target cloudflare or --target compose');
  if (record !== null) return { kind: 'cloudflare', record, mycoHome };
  if (bundle) return { kind: 'compose', paths };
  throw new RegistrationRefused('no Deployment on this machine: neither a Cloudflare record nor a Compose bundle');
}

/** The whole flow, start to verified. */
export async function registerGitHubApp(options: RegisterOptions): Promise<RegistrationResult> {
  if (!isDeploymentUrl(options.url)) throw new RegistrationRefused(`${options.url} is not an https Deployment URL`);
  const proposedName = manifestFor({ url: options.url, name: options.name, redirectUrl: 'http://127.0.0.1/callback' }).name;
  if (proposedName.length > APP_NAME_MAX) throw new RegistrationRefused(`GitHub limits an app's name to ${APP_NAME_MAX} characters and ${JSON.stringify(proposedName)} is ${proposedName.length}; pass --name <shorter>`);
  const log = options.log ?? (() => undefined);
  const fetchImpl = options.fetchImpl ?? fetch;
  const state = randomBytes(32).toString('base64url');
  const formPath = `/${randomBytes(16).toString('base64url')}`;

  const app = await new Promise<RegisteredApp>((resolve, reject) => {
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
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(DONE_PAGE);
        convertManifestCode(code, fetchImpl).then((converted) => {
          if (options.org !== undefined && (converted.ownerLogin === null || converted.ownerLogin.toLowerCase() !== options.org.toLowerCase())) {
            throw new RegistrationRefused(`GitHub answered with an app owned by ${converted.ownerLogin ?? 'an unknown account'}, not ${options.org}`);
          }
          if (converted.name !== manifest!.name) log(`GitHub registered the app as ${JSON.stringify(converted.name)} (the name was edited on GitHub's page).`);
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

  log(`Registered ${app.name}, owned by ${app.ownerLogin ?? 'the signed-in account'} (${app.htmlUrl}). Installing the credentials on the Deployment…`);
  await installSignInSecrets(options.target, app, options.runner);
  if (options.target.kind === 'cloudflare' && options.target.record.url !== new URL(options.url).origin) {
    writeDeploymentRecord({ ...options.target.record, url: new URL(options.url).origin }, options.target.mycoHome);
  }
  const verified = await verifySignIn(options.url, app.clientId, { fetchImpl });
  return { app: { slug: app.slug, htmlUrl: app.htmlUrl, name: app.name, clientId: app.clientId, ownerLogin: app.ownerLogin }, callbackUrl: `${new URL(options.url).origin}/auth/callback`, verified };
}
