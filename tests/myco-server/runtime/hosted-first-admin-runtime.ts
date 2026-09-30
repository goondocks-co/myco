/**
 * Runtime proof for the hosted Deployment's first administrator (#1500), on real workerd.
 *
 * `wrangler dev --local` runs the product's own Worker with a migrated local D1 and GitHub sign-in configured. The
 * first-owner setup `setup-owner --target cloudflare` runs (`core/first-owner.ts`) is run over that D1 one statement at a
 * time, with no batch, the way the operator's store runs it over the D1 API. Then the product's own routes take it from
 * there: `/auth/login` answers what owner setup checks before it writes, the minted link previews and confirms for a
 * signed-in GitHub account through `POST /auth/link`, that account is the administrator on `/auth/me` and on an
 * admin-only route, and a further setup is refused.
 *
 * What it proves beyond the in-process tests: D1's own engine runs every guarded statement and answers the changed-row
 * counts the setup's guards read, and the product Worker, not a test double, accepts what the setup wrote.
 *
 * Every process it starts is stopped by its exact PID. Usage: bun tests/myco-server/runtime/hosted-first-admin-runtime.ts
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { signSession, SESSION_COOKIE } from '../../../packages/myco-server/src/auth/owner/cookie.ts';
import { signInConfigured } from '../../../packages/myco/src/server/github-app.ts';

const ROOT = path.resolve(import.meta.dir, '../../..');
const WRANGLER = path.join(ROOT, 'node_modules/.bin/wrangler');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hosted-first-admin-runtime-'));
const EVIDENCE = process.env.MYCO_FIRST_ADMIN_EVIDENCE ?? path.join(RUN, 'result.json');
const STATE = path.join(RUN, 'state');
const SESSION_SECRET = 'runtime-session-secret-of-sufficient-length';
const GITHUB_ACCOUNT = '583231';
const checks: Array<Record<string, unknown>> = [];
const owned: Array<{ what: string; pid: number }> = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ check: label, ok, actual, ...(ok ? {} : { expected }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual).slice(0, 200)}`);
  if (!ok) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); }); });
const descendants = (pid: number): number[] => Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout.toString().trim().split('\n').filter(Boolean).map(Number).flatMap((child) => [child, ...descendants(child)]);

async function stop(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const tree = descendants(proc.pid);
  for (const pid of [proc.pid, ...tree]) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await proc.exited;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (tree.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } })) return;
    await Bun.sleep(100);
  }
  for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

/** The product Worker, and one route that runs the first-owner setup over its D1 with no batch. */
const ENTRY = `
import product, { DeploymentClock, RecoveryProducer } from '${path.join(ROOT, 'packages/myco-server/src/index.ts')}';
import { setupFirstOwner } from '${path.join(ROOT, 'packages/myco-server/src/core/first-owner.ts')}';
import { serverEnvFromBindings } from '${path.join(ROOT, 'packages/myco-server/src/platform/cloudflare/env.ts')}';
export { DeploymentClock, RecoveryProducer };
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__first-owner') {
      const db = serverEnvFromBindings(env).db;
      const store = { prepare: (sql) => db.prepare(sql), batch: async () => { throw new Error('the operator store runs no batch'); } };
      try {
        return Response.json(await setupFirstOwner(store, Date.now(), 'schema mismatch'));
      } catch (error) {
        return Response.json({ refused: String(error && error.message || error) }, { status: 409 });
      }
    }
    return product.fetch(request, env, ctx);
  },
  scheduled: product.scheduled,
};
`;

let worker: ReturnType<typeof Bun.spawn> | null = null;
let origin = '';
function writeConfig(): void {
  fs.writeFileSync(path.join(RUN, 'wrangler.toml'), [
    'name = "myco-first-admin-runtime"',
    'main = "entry.ts"',
    'compatibility_date = "2026-08-01"',
    '',
    '[[durable_objects.bindings]]', 'name = "CLOCK"', 'class_name = "DeploymentClock"', '',
    '[[durable_objects.bindings]]', 'name = "RECOVERY"', 'class_name = "RecoveryProducer"', '',
    '[[migrations]]', 'tag = "v1"', 'new_sqlite_classes = [ "DeploymentClock", "RecoveryProducer" ]', '',
    '[[d1_databases]]', 'binding = "MYCO_DB"', 'database_name = "myco-first-admin-runtime"',
    'database_id = "00000000-0000-4000-8000-000000001500"',
    `migrations_dir = "${path.join(ROOT, 'packages/myco-server/migrations')}"`, '',
    '[[r2_buckets]]', 'binding = "BUCKET"', 'bucket_name = "myco-first-admin-runtime-blobs"', '',
    '[[ratelimits]]', 'name = "SOURCE_LIMIT"', 'namespace_id = "1001"', 'simple = { limit = 600, period = 60 }', '',
    '[[ratelimits]]', 'name = "TOKEN_LIMIT"', 'namespace_id = "1002"', 'simple = { limit = 300, period = 60 }', '',
    '[vars]', 'CLOCK_MODE = "manual"', 'HARNESS_LAUNCH_MODE = "record"', `SESSION_SECRET = "${SESSION_SECRET}"`, 'GITHUB_CLIENT_ID = "Iv1.runtime"', 'GITHUB_CLIENT_SECRET = "runtime-client-secret"', '',
  ].join('\n'));
  fs.writeFileSync(path.join(RUN, 'entry.ts'), ENTRY);
}

async function startWorker(): Promise<void> {
  const port = await freePort();
  const inspector = await freePort();
  const log = fs.openSync(path.join(RUN, 'wrangler.log'), 'a');
  worker = Bun.spawn([WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', STATE, '-c', path.join(RUN, 'wrangler.toml')], {
    cwd: RUN, stdin: 'ignore', stdout: log, stderr: log, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
  });
  owned.push({ what: 'wrangler dev', pid: worker.pid });
  origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) })).status < 500) return; } catch {}
    if (worker.exitCode !== null) throw new Error(`wrangler dev exited ${worker.exitCode}`);
    await Bun.sleep(250);
  }
  throw new Error('wrangler dev did not answer within 90s');
}

const session = async (): Promise<string> => {
  const now = Date.now();
  return `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { sub: GITHUB_ACCOUNT, login: 'octocat', iat: now, exp: now + 600_000 })}`;
};
const asAccount = async (route: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${origin}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: await session(), origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const setup = async (): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${origin}/__first-owner`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
  return { status: response.status, body: await response.json() };
};

let failure: unknown = null;
try {
  writeConfig();
  const migrate = Bun.spawnSync([WRANGLER, 'd1', 'migrations', 'apply', 'myco-first-admin-runtime', '--local', '--persist-to', STATE, '-c', path.join(RUN, 'wrangler.toml')],
    { cwd: RUN, stdin: 'ignore', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  if (migrate.exitCode !== 0) throw new Error(`migrations failed: ${migrate.stderr.toString().slice(-800)}`);
  await startWorker();

  check('the Deployment signs in with GitHub, as owner setup requires before it writes', await signInConfigured(origin), { ok: true });

  const first = await setup();
  const second = await setup();
  check('a setup records the first administrator and mints a link', [first.status, typeof first.body.key, first.body.memberId.startsWith('mem_')], [200, 'string', true]);
  check('a retry before the link is used takes the same administrator', second.body.memberId, first.body.memberId);

  check('before linking, the account is no member and an administrator-only route refuses it', [(await asAccount('/auth/me')).body?.member ?? null, (await asAccount('/api/enrollment')).status >= 400], [null, true]);
  check('the replaced link is refused', (await asAccount('/auth/link', { key: first.body.key })).status, 400);
  const preview = await asAccount('/auth/link', { key: second.body.key });
  check('the live link previews the administrator it names', [preview.status, preview.body?.preview?.member?.id, preview.body?.preview?.member?.role], [200, first.body.memberId, 'admin']);
  const linked = await asAccount('/auth/link', { key: second.body.key, confirm: true });
  check('confirming links the signed-in GitHub account to the administrator', [linked.status, linked.body?.linked, linked.body?.member?.role], [200, true, 'admin']);

  const me = await asAccount('/auth/me');
  check('the account is the administrator', [me.status, me.body?.member?.id, me.body?.member?.role], [200, first.body.memberId, 'admin']);
  check('an administrator-only route admits it: the invitations list', (await asAccount('/api/enrollment')).status, 200);
  const again = await setup();
  check('a further setup is refused and makes no second member', [again.status, String(again.body.refused).includes('already has members')], [409, true]);
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  if (worker !== null) await stop(worker);
  const leftovers = owned.filter(({ pid }) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify({
    at: new Date().toISOString(), run: RUN, wrangler: Bun.spawnSync([WRANGLER, '--version'], { stdin: 'ignore' }).stdout.toString().trim().split('\n').pop(),
    passed: failure === null, failure: failure === null ? null : String(failure), checks, owned, leftovers,
  }, null, 2) + '\n');
  console.log(`${failure === null ? 'passed' : 'FAILED'}: ${checks.filter((entry) => 'check' in entry).length} checks; evidence ${EVIDENCE}; leftovers ${leftovers.length}`);
  process.exit(failure === null ? 0 : 1);
}
