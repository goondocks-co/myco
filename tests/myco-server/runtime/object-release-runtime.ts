/**
 * Runtime proof for the object lifecycle's drain, on real workerd.
 *
 * `wrangler dev --local` runs the product's own `DeploymentClock` with a migrated local D1 and local R2 in a throwaway
 * state directory. What it proves cannot be proven in process: a clock wake killed with store deletes on the wire
 * leaves its journal in D1, a restarted runtime drains that journal to empty by deletes it issues again, and a later
 * upload of the same content under a new generation survives every delete issued for the earlier ones.
 *
 * Every process it starts is stopped by its exact PID. Usage: bun tests/myco-server/runtime/object-release-runtime.ts
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const WRANGLER = path.join(ROOT, 'node_modules/.bin/wrangler');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-object-release-runtime-'));
const EVIDENCE = process.env.MYCO_OBJECT_RELEASE_EVIDENCE ?? path.join(RUN, 'result.json');
const STATE = path.join(RUN, 'state');
const checks: Array<Record<string, unknown>> = [];
const owned: Array<{ what: string; pid: number }> = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ check: label, ok, actual, ...(ok ? {} : { expected }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual).slice(0, 200)}`);
  if (!ok) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const note = (label: string, value: unknown) => { checks.push({ note: label, value }); console.log(`note ${label}: ${JSON.stringify(value).slice(0, 240)}`); };
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); }); });
const descendants = (pid: number): number[] => Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout.toString().trim().split('\n').filter(Boolean).map(Number).flatMap((child) => [child, ...descendants(child)]);

async function stop(proc: ReturnType<typeof Bun.spawn>, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const tree = descendants(proc.pid);
  for (const pid of [proc.pid, ...tree]) { try { process.kill(pid, signal); } catch {} }
  await proc.exited;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (tree.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } })) return;
    await Bun.sleep(100);
  }
  for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

const PROJECT = 'proj_1';
const KEY = 'c'.repeat(64);
const JOURNALED = 1600;

/** A test entry around the product's own clock: it seeds rows and objects, wakes the clock, and reads state back. */
const ENTRY = `
import { DeploymentClock } from '${path.join(ROOT, 'packages/myco-server/src/platform/cloudflare/deployment-clock.ts')}';
export { DeploymentClock };
const json = (value) => Response.json(value);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/seed-journal') {
      const count = Number(url.searchParams.get('count'));
      const names = [];
      for (let i = 0; i < count; i += 1) {
        const physical = '${PROJECT}/${KEY}~' + crypto.randomUUID();
        await env.BUCKET.put(physical, 'released bytes ' + i);
        names.push(physical);
      }
      for (let at = 0; at < names.length; at += 50) {
        await env.MYCO_DB.batch(names.slice(at, at + 50).map((physical, i) => env.MYCO_DB.prepare('INSERT INTO object_releases (physical, kind, created_at) VALUES (?, ?, ?)').bind(physical, 'blob', at + i)));
      }
      return json({ names });
    }
    if (url.pathname === '/register') {
      const generation = crypto.randomUUID();
      const physical = '${PROJECT}/${KEY}~' + generation;
      await env.BUCKET.put(physical, 'registered bytes');
      await env.MYCO_DB.prepare("INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES (?, ?, 16, 'text/plain', 't', 1, ?)").bind('${PROJECT}', '${KEY}', generation).run();
      return json({ physical });
    }
    if (url.pathname === '/wake') {
      // An owner's recent request is activity, so the wake runs at a depth where its jobs run.
      await env.MYCO_DB.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('last_request_at', ?)").bind(String(Date.now())).run();
      const clock = env.CLOCK.get(env.CLOCK.idFromName('deployment'));
      // Wakes back to back, as a busy clock would, so a kill can land inside a drain pass.
      const times = Number(url.searchParams.get('times') ?? '1');
      const woke = [];
      try { for (let i = 0; i < times; i += 1) woke.push(await clock.wake()); return json({ woke }); } catch (error) { return json({ raised: String(error).slice(0, 200) }); }
    }
    if (url.pathname === '/state') {
      const journal = (await env.MYCO_DB.prepare('SELECT physical FROM object_releases ORDER BY physical').all()).results.map((row) => row.physical);
      const objects = [];
      let cursor;
      do {
        const listed = await env.BUCKET.list({ prefix: '${PROJECT}/', cursor });
        objects.push(...listed.objects.map((object) => object.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor !== undefined);
      return json({ journal, objects: objects.sort() });
    }
    return new Response('not found', { status: 404 });
  },
};
`;

let worker: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
function writeConfig(): void {
  fs.writeFileSync(path.join(RUN, 'wrangler.toml'), [
    'name = "myco-object-release-runtime"',
    'main = "entry.ts"',
    'compatibility_date = "2026-08-01"',
    '',
    '[[durable_objects.bindings]]', 'name = "CLOCK"', 'class_name = "DeploymentClock"', '',
    '[[migrations]]', 'tag = "v1-clock"', 'new_sqlite_classes = [ "DeploymentClock" ]', '',
    '[[d1_databases]]', 'binding = "MYCO_DB"', 'database_name = "myco-object-release-runtime"',
    'database_id = "00000000-0000-4000-8000-000000001316"',
    `migrations_dir = "${path.join(ROOT, 'packages/myco-server/migrations')}"`, '',
    '[[r2_buckets]]', 'binding = "BUCKET"', 'bucket_name = "myco-object-release-runtime-blobs"', '',
    '[vars]', 'CLOCK_MODE = "manual"', 'HARNESS_LAUNCH_MODE = "record"', '',
  ].join('\n'));
  fs.writeFileSync(path.join(RUN, 'entry.ts'), ENTRY);
}

async function startWorker(): Promise<void> {
  port = await freePort();
  const inspector = await freePort();
  const logFile = path.join(RUN, 'wrangler.log');
  const log = fs.openSync(logFile, 'a');
  worker = Bun.spawn([WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', STATE, '-c', path.join(RUN, 'wrangler.toml')], {
    cwd: RUN, stdin: 'ignore', stdout: log, stderr: log, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
  });
  owned.push({ what: 'wrangler dev', pid: worker.pid });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch {}
    if (worker.exitCode !== null) throw new Error(`wrangler dev exited ${worker.exitCode}`);
    await Bun.sleep(250);
  }
  throw new Error('wrangler dev did not answer within 90s');
}
const call = async (route: string): Promise<any> => (await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(120_000) })).json();

let failure: unknown = null;
try {
  writeConfig();
  const migrate = Bun.spawnSync([WRANGLER, 'd1', 'migrations', 'apply', 'myco-object-release-runtime', '--local', '--persist-to', STATE, '-c', path.join(RUN, 'wrangler.toml')],
    { cwd: RUN, stdin: 'ignore', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  if (migrate.exitCode !== 0) throw new Error(`migrations failed: ${migrate.stderr.toString().slice(-800)}`);
  await startWorker();

  const seeded = await call(`/seed-journal?count=${JOURNALED}`);
  check('the journal holds every released generation, and the store every object', [(await call('/state')).journal.length, (await call('/state')).objects.length], [JOURNALED, JOURNALED]);

  // A clock wake killed while its deletes are on the wire: the kill lands after the wake is issued and before it
  // can answer, so some deletes may have reached the store and none of their journal rows is trusted to be gone.
  // The process tree is read before the wake, so the kill lands without a lookup in between.
  const tree = [worker!.pid, ...descendants(worker!.pid)];
  const killed = fetch(`http://127.0.0.1:${port}/wake?times=60`, { signal: AbortSignal.timeout(60_000) }).then((r) => r.text()).catch((error) => `killed: ${String(error).slice(0, 80)}`);
  await Bun.sleep(150);
  for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await stop(worker!, 'SIGKILL');
  worker = null;
  note('the killed wake answered', await killed);

  await startWorker();
  const afterKill = await call('/state');
  note('state after the kill', { journal: afterKill.journal.length, objects: afterKill.objects.length });
  check('the kill landed inside the drain: journal rows and objects remain', [afterKill.journal.length > 0, afterKill.objects.length < JOURNALED], [true, true]);
  note('the kill landed between an acknowledged delete and its journal row removal', afterKill.objects.length < afterKill.journal.length);
  check('every object still stored after the kill is still journaled', afterKill.objects.every((name: string) => afterKill.journal.includes(name)), true);

  // A later upload of the same content, under a generation of its own, registered before the drain resumes.
  const registered = await call('/register');

  let state = afterKill;
  let wakes = 0;
  for (; wakes < 200 && state.journal.length > 0; wakes += 1) {
    const woke = await call('/wake?times=20');
    if (wakes === 0) note('first wake after restart', woke);
    state = await call('/state');
  }
  check('the restarted clock drains the journal to empty', state.journal, []);
  check('every released generation is deleted, and the later generation is kept', state.objects, [registered.physical]);
  note('wakes to converge', wakes);
  check('no released name was ever the registered name', seeded.names.includes(registered.physical), false);
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  if (worker !== null) await stop(worker, 'SIGTERM');
  const leftovers = owned.filter(({ pid }) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify({
    at: new Date().toISOString(), run: RUN, wrangler: Bun.spawnSync([WRANGLER, '--version'], { stdin: 'ignore' }).stdout.toString().trim().split('\n').pop(),
    passed: failure === null, failure: failure === null ? null : String(failure), checks, owned, leftovers,
  }, null, 2) + '\n');
  console.log(`${failure === null ? 'passed' : 'FAILED'}: ${checks.filter((entry) => 'check' in entry).length} checks; evidence ${EVIDENCE}; leftovers ${leftovers.length}`);
  process.exit(failure === null ? 0 : 1);
}
