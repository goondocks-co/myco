import { Database } from 'bun:sqlite';
import { expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { SetupDeps } from '@myco/setup/steps.js';
import type { CommandRunner, CommandResult } from '@myco/server/runner.js';
import { createBunHandler, type BunHandler } from '@myco-server-worker/entry/bun.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { OAUTH_STATE_COOKIE } from '@myco-server-worker/auth/owner/github.js';
import { SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { peekLocalPaths, readLocalSecrets } from '@myco/server/local.js';
import { defaultSpec } from '@myco/server/service.js';
import { nativeServicePlatform } from '../../helpers/native-service-platform.js';
import { sqliteEnv } from '../../myco-server/helpers/fixtures.js';
import { sqliteD1 } from '../../myco-server/helpers/d1.js';
import { fakeGitHub } from './github.js';
import { VECTOR_INDEX_DIMENSIONS, VECTOR_METADATA_FIELDS } from '@myco/server/vector-config.js';

export const ACCOUNT = 'a'.repeat(32);
const DATABASE = '11111111-2222-4333-8444-555555555555';
const STORE = 'f'.repeat(32);
export const HOSTED_URL = 'https://myco-server.setup.workers.dev';
const native = { library: null, vec0: null };
const asFetch = (fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch => Object.assign(fn, { preconnect: () => {} });

/** Both provider boundaries fail on any request or command the fixture does not own. */
export function ownerDeployment(root: string, home: string, target: 'cloudflare' | 'local', url = HOSTED_URL) {
  const github = fakeGitHub();
  const calls: string[] = [];
  const commands: string[] = [];
  const links: string[] = [];
  const providerFile = path.join(root, 'fake-provider.json');
  const saved = fs.existsSync(providerFile) ? JSON.parse(fs.readFileSync(providerFile, 'utf8')) : null;
  const secrets: Record<string, string> = saved?.secrets ?? { SESSION_SECRET: 'fixture-session-secret-that-is-long-enough' };
  let databaseCreated = saved?.databaseCreated ?? false;
  let storeCreated = saved?.storeCreated ?? false;
  let vectorCreated = saved?.vectorCreated ?? false;
  let signedIn = saved?.signedIn ?? true;
  let conversions = saved?.conversions ?? 0;
  const buckets = new Set<string>(saved?.buckets ?? []);
  const storeSecrets = new Set<string>(saved?.storeSecrets ?? []);
  const sqlite = new Database(path.join(root, 'fake-cloudflare.sqlite'));
  const fixture = sqliteEnv();
  fixture.env.MYCO_DB = sqliteD1(sqlite);
  fixture.sqlite.close();
  const server = createServer({ now: Date.now, sourceOf: () => '192.0.2.30', fetchImpl: github.fetchImpl });
  let handler: BunHandler | undefined;
  let cookie: string | undefined;
  const paths = peekLocalPaths(home);
  const binaryPath = path.join(root, 'bin', 'myco');
  const spec = defaultSpec(binaryPath, root, 'darwin', home);
  const platform = nativeServicePlatform(paths, spec);
  const answer = (stdout = '', code = 0, stderr = ''): CommandResult => {
    const body = JSON.stringify({ secrets, databaseCreated, storeCreated, vectorCreated, signedIn, conversions, buckets: [...buckets], storeSecrets: [...storeSecrets] });
    if (!fs.existsSync(providerFile) || fs.readFileSync(providerFile, 'utf8') !== body) fs.writeFileSync(providerFile, body, { mode: 0o600 });
    return { stdout, code, stderr };
  };
  const runner: CommandRunner = { async run(command, args, options) {
    expect(command).toBe('npx');
    expect(args.slice(0, 2)).toEqual(['--no-install', 'wrangler']);
    const flat = args.slice(2).join(' ');
    commands.push(flat);
    if (flat === '--version') return answer('4.99.0');
    if (flat === 'login') { expect(options?.stdio).toBe('inherit'); signedIn = true; return answer(); }
    if (flat === 'whoami') return signedIn ? answer(`│ Setup │ ${ACCOUNT} │`) : answer('', 1);
    if (flat === 'auth token --json') return answer(JSON.stringify({ type: 'api_token', token: 'fixture-operator' }));
    if (flat === 'vectorize list --json') return answer(JSON.stringify(vectorCreated ? [{ name: 'myco-server-memory' }] : []));
    if (flat.startsWith('vectorize create ')) { vectorCreated = true; return answer(); }
    if (flat.startsWith('vectorize get ')) return answer(JSON.stringify({ config: { dimensions: VECTOR_INDEX_DIMENSIONS, metric: 'cosine' } }));
    if (flat.startsWith('vectorize list-metadata-index ')) return answer(JSON.stringify(VECTOR_METADATA_FIELDS.map(propertyName => ({ propertyName, indexType: propertyName === 'created_at' ? 'Number' : 'String' }))));
    if (flat === 'd1 list --json') return answer(JSON.stringify(databaseCreated ? [{ name: 'myco-server', uuid: DATABASE }] : []));
    if (flat === 'd1 create myco-server') { databaseCreated = true; return answer(`database_id = "${DATABASE}"`); }
    if (flat.startsWith('d1 time-travel info ')) return answer(JSON.stringify({ bookmark: '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683' }));
    if (flat.startsWith('d1 execute ')) {
      const sql = args[args.indexOf('--command') + 1];
      return answer(JSON.stringify([{ success: true, results: sqlite.query(sql).all() }]));
    }
    if (flat.startsWith('d1 migrations apply ')) { for (const file of renderMigrationFiles()) sqlite.exec(file.sql); return answer(); }
    if (flat.startsWith('r2 bucket list')) return answer(JSON.stringify({ buckets: [...buckets].map(name => ({ name })) }));
    if (flat.startsWith('r2 bucket create ')) {
      const name = args[args.indexOf('create') + 1];
      if (buckets.has(name)) return answer('', 1, 'already exists');
      buckets.add(name); return answer();
    }
    if (flat.startsWith('secrets-store store list')) return answer(storeCreated ? `│ myco │ ${STORE} │` : '');
    if (flat.startsWith('secrets-store store create')) { storeCreated = true; return answer(`Created store myco (${STORE})`); }
    if (flat.startsWith('secrets-store secret list')) return storeSecrets.size > 0
      ? answer(`│ Name │ ID │\n${[...storeSecrets].map(name => `│ ${name} │ ${'e'.repeat(32)} │`).join('\n')}`) : answer('', 1, 'List request returned no secrets');
    if (flat.startsWith('secrets-store secret create')) { storeSecrets.add(args[args.indexOf('--name') + 1]); return answer(); }
    if (flat.startsWith('secret list --name')) return answer(JSON.stringify(Object.keys(secrets).map(name => ({ name }))));
    if (flat.startsWith('secret put ')) { secrets[args[3]] = options!.input!; return answer(); }
    if (flat.startsWith('secret bulk --name')) { Object.assign(secrets, JSON.parse(options!.input!)); return answer(); }
    if (flat.startsWith('deploy -c ')) return answer(`Current Version ID: 16a2423e-af96-4310-b61b-4e2b5fd1310b\n${HOSTED_URL}\n`);
    throw new Error(`fake Cloudflare: unexpected command ${flat}`);
  } };
  const registrationFetch = asFetch(async (input, init) => {
    const result = await github.registrationFetch(input, init);
    if (new Request(input, init).url.includes('/conversions') && result.ok) { conversions++; answer(); }
    return result;
  });
  const operatorFetch: NonNullable<SetupDeps['cloudflare']>['fetch'] = async (address, init) => {
    expect(address).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`);
    const { sql, params = [] } = JSON.parse(String(init.body));
    const statement = sqlite.query(sql);
    const reads = statement.columnNames.length > 0;
    const results = reads ? statement.all(...params) : [];
    const changes = reads ? 0 : statement.run(...params).changes;
    return Response.json({ success: true, result: [{ success: true, results, meta: { changes } }] });
  };
  async function handle(request: Request) {
    request.headers.set('x-forwarded-for', '192.0.2.30');
    if (target === 'cloudflare') return server.handleRequest(request, { ...fixture.serverEnv, secrets });
    if (!fs.existsSync(`${paths.root}.serve.lock`)) throw new Error('fake native Deployment is stopped');
    handler ??= await createBunHandler({ databasePath: paths.databasePath, blobDir: paths.blobDir, header: 'x-forwarded-for', wakeLoop: false, ...readLocalSecrets(paths), fetchImpl: github.fetchImpl });
    return handler.fetch(request);
  }
  async function ownerSession() {
    if (cookie) return cookie;
    const signin = await handle(new Request(`${url}/auth/login`));
    expect(signin.status).toBe(302);
    const state = new URL(signin.headers.get('location')!).searchParams.get('state')!;
    const callback = await handle(new Request(`${url}/auth/callback?code=owner&state=${encodeURIComponent(state)}`, { headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` } }));
    expect(callback.status).toBe(302);
    const cookies = callback.headers.get('set-cookie')!;
    cookie = `${SESSION_COOKIE}=${cookies.slice(cookies.indexOf(`${SESSION_COOKIE}=`) + SESSION_COOKIE.length + 1).split(';')[0]}`;
    return cookie;
  }
  const fetchImpl = asFetch(async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe(url);
    const route = new URL(request.url).pathname;
    calls.push(route);
    const response = await handle(request);
    if (route === '/auth/device/start' && response.ok) {
      const grant = await response.clone().json() as { user_code: string };
      const approved = await handle(new Request(`${url}/api/device/approve`, { method: 'POST', headers: { origin: url, cookie: await ownerSession(), 'content-type': 'application/json' }, body: JSON.stringify({ user_code: grant.user_code }) }));
      expect(approved.status).toBe(200);
    }
    return response;
  });
  const openUrl = async (address: string) => {
    if (new URL(address).hash) {
      links.push(address);
      const linked = await handle(new Request(`${url}/auth/link`, { method: 'POST', headers: { origin: url, cookie: await ownerSession(), 'content-type': 'application/json' }, body: JSON.stringify({ key: new URL(address).hash.slice(1), confirm: true }) }));
      expect(linked.status).toBe(200);
      return;
    }
    const page = await fetch(address);
    const html = await page.text();
    const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(html)![1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
    const state = new URL(/action="([^"]+)"/.exec(html)![1].replaceAll('&amp;', '&')).searchParams.get('state');
    const callback = await fetch(`${manifest.redirect_url}?code=setup-conversion&state=${state}`);
    expect(callback.status).toBe(200);
  };
  return {
    github: { ...github, registrationFetch }, calls, commands, links, sqlite, platform, runner, operatorFetch, fetchImpl, openUrl,
    get conversions() { return conversions; },
    signOutWrangler: () => { signedIn = false; answer(); },
    deps: {
      fetch: fetchImpl, openUrl, github: { fetchImpl: asFetch(async (input, init) => new URL(new Request(input, init).url).origin === url ? fetchImpl(input, init) : registrationFetch(input, init)) },
      cloudflare: { runner, fetch: operatorFetch },
      local: { native, userHome: root, binaryPath, service: { platform: 'darwin' as const, runner: platform.runner } },
    } satisfies SetupDeps,
    close: async () => { platform.dispose(); await handler?.close(); sqlite.close(); },
  };
}
