/**
 * Runtime proof that a clock's chained wakes only drain (#1510), on real workerd with a real local D1.
 *
 * `wrangler dev --local` runs the product's own `DeploymentClock` and its own tick, with real alarms, over a D1 migrated
 * by the product's migrations. Every store call is held for a fixed latency, the round trip a clock far from its
 * database pays, and counted. The transcript parse stands in for a backlog that never empties: it answers work left on
 * every pass, so the clock chains. What it proves: the first wake runs every job due; every wake after it inside the
 * cadence runs only the parse, makes at most a handful of store calls, and ends within a budget of those calls at that
 * latency; and the chained wakes still start one after another at the chained interval.
 *
 * Every process it starts is stopped by its exact PID. Usage: bun tests/myco-server/runtime/chained-tick-runtime.ts
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CHAINED_WAKE_MS } from '../../../packages/myco-server/src/core/tick.js';

const ROOT = path.resolve(import.meta.dir, '../../..');
const WRANGLER = path.join(ROOT, 'node_modules/.bin/wrangler');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-chained-tick-runtime-'));
const EVIDENCE = process.env.MYCO_CHAINED_TICK_EVIDENCE ?? path.join(RUN, 'result.json');
const STATE = path.join(RUN, 'state');
const checks: Array<Record<string, unknown>> = [];
const owned: Array<{ what: string; pid: number }> = [];

/** What each store call is held for: a round trip between regions. */
const LATENCY_MS = 25;
/** The store calls a chained wake may make: the queue's drain, the backlog count, and room besides. */
const CHAINED_CALL_BUDGET = 8;
/** How long a chained wake may take: its call budget at the latency, and scheduling slack. */
const CHAINED_TICK_BUDGET_MS = CHAINED_CALL_BUDGET * LATENCY_MS + 400;
/** How long the scenario lets the clock chain. */
const WATCH_MS = 15_000;
/** Scheduling slack a local alarm is allowed on top of the chained wake. */
const SLACK_MS = 1_000;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ check: label, ok, actual, ...(ok ? {} : { expected }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual).slice(0, 200)}`);
  if (!ok) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const note = (label: string, value: unknown) => { checks.push({ note: label, value }); console.log(`note ${label}: ${JSON.stringify(value).slice(0, 240)}`); };
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); }); });
const descendants = (pid: number): number[] => Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout.toString().trim().split('\n').filter(Boolean).map(Number).flatMap((child) => [child, ...descendants(child)]);

async function stop(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const tree = descendants(proc.pid);
  for (const pid of [proc.pid, ...tree]) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await Promise.race([proc.exited, Bun.sleep(10_000)]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (tree.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } })) break;
    await Bun.sleep(100);
  }
  for (const pid of [proc.pid, ...tree]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

const src = path.join(ROOT, 'packages/myco-server/src');
/**
 * The product's clock and tick. Its store is held for the latency and counted, per wake; the parse answers work left
 * until the scenario halts it, and a halted clock arms nothing more.
 */
const ENTRY = `
import { CLOCK_NAME, DeploymentClock as ProductClock } from '${src}/platform/cloudflare/deployment-clock.ts';
import { JOB_IMPLEMENTATIONS } from '${src}/core/jobs-run.ts';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let calls = 0;
let halted = false;
JOB_IMPLEMENTATIONS['transcript-parse'] = async () => ({ changed: 1, more: !halted });
const held = (statement) => ({
  inner: statement,
  bind: (...values) => held(statement.bind(...values)),
  first: async (...a) => { calls += 1; await sleep(${LATENCY_MS}); return statement.first(...a); },
  all: async () => { calls += 1; await sleep(${LATENCY_MS}); return statement.all(); },
  run: async () => { calls += 1; await sleep(${LATENCY_MS}); return statement.run(); },
  raw: async (...a) => { calls += 1; await sleep(${LATENCY_MS}); return statement.raw(...a); },
});
const slowed = (db) => ({
  prepare: (sql) => held(db.prepare(sql)),
  batch: async (statements) => { calls += 1; await sleep(${LATENCY_MS}); return db.batch(statements.map((s) => s.inner ?? s)); },
  exec: async (sql) => { calls += 1; await sleep(${LATENCY_MS}); return db.exec(sql); },
});
export class DeploymentClock extends ProductClock {
  clockEnv() { const env = super.clockEnv(); return { ...env, db: slowed(env.db) }; }
  async tick(now) {
    const started = Date.now();
    calls = 0;
    const report = await super.tick(now);
    const ticks = (await this.ctx.storage.get('ticks')) ?? [];
    ticks.push({ started, ended: Date.now(), calls, drainOnly: report.drainOnly, jobs: report.jobs.map((j) => j.name) });
    await this.ctx.storage.put('ticks', ticks);
    return halted ? { ...report, nextWakeMs: null } : report;
  }
  async record() { return { ticks: (await this.ctx.storage.get('ticks')) ?? [] }; }
  async halt() { halted = true; }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const clock = env.CLOCK.get(env.CLOCK.idFromName(CLOCK_NAME));
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/start') {
      // An owner's request a moment ago: the Deployment is in use, so the parse runs at its depth.
      await env.MYCO_DB.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('last_request_at', ?)").bind(String(Date.now())).run();
      await clock.ensure();
      return Response.json({ started: true });
    }
    if (url.pathname === '/record') return Response.json(await clock.record());
    if (url.pathname === '/halt') { await clock.halt(); return Response.json({ halted: true }); }
    return new Response('not found', { status: 404 });
  },
};
`;

function writeConfig(): void {
  fs.writeFileSync(path.join(RUN, 'entry.ts'), ENTRY);
  fs.writeFileSync(path.join(RUN, 'wrangler.toml'), [
    'name = "myco-chained-tick-runtime"', 'main = "entry.ts"', 'compatibility_date = "2026-08-01"', '',
    '[[durable_objects.bindings]]', 'name = "CLOCK"', 'class_name = "DeploymentClock"', '',
    '[[migrations]]', 'tag = "v1"', 'new_sqlite_classes = [ "DeploymentClock" ]', '',
    '[[d1_databases]]', 'binding = "MYCO_DB"', 'database_name = "myco-chained-tick-runtime"',
    'database_id = "00000000-0000-4000-8000-000000001510"',
    `migrations_dir = "${path.join(ROOT, 'packages/myco-server/migrations')}"`, '',
    '[[r2_buckets]]', 'binding = "BUCKET"', 'bucket_name = "myco-chained-tick-runtime-blobs"', '',
    '[vars]', 'HARNESS_LAUNCH_MODE = "record"', '',
  ].join('\n'));
}

let worker: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
async function start(): Promise<void> {
  port = await freePort();
  const inspector = await freePort();
  const log = fs.openSync(path.join(RUN, 'wrangler.log'), 'a');
  worker = Bun.spawn([WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', STATE, '-c', path.join(RUN, 'wrangler.toml')], {
    cwd: RUN, stdin: 'ignore', stdout: log, stderr: log, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
  });
  owned.push({ what: 'wrangler dev', pid: worker.pid });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch {}
    if (worker.exitCode !== null) throw new Error(`wrangler dev exited ${worker.exitCode}`);
    await Bun.sleep(250);
  }
  throw new Error('wrangler dev did not answer within 120s');
}
const call = async (route: string): Promise<any> => (await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(60_000) })).json();

let failure: unknown = null;
try {
  writeConfig();
  const migrate = Bun.spawnSync([WRANGLER, 'd1', 'migrations', 'apply', 'myco-chained-tick-runtime', '--local', '--persist-to', STATE, '-c', path.join(RUN, 'wrangler.toml')],
    { cwd: RUN, stdin: 'ignore', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, timeout: 300_000 });
  fs.writeFileSync(path.join(RUN, 'migrate.log'), `exit ${migrate.exitCode}\n${migrate.stdout}${migrate.stderr}`);
  if (migrate.exitCode !== 0) throw new Error('migrations failed; see migrate.log');
  await start();
  await call('/start');
  await Bun.sleep(WATCH_MS);
  await call('/halt');
  const ticks: Array<{ started: number; ended: number; calls: number; drainOnly: boolean; jobs: string[] }> = (await call('/record')).ticks;
  note('ticks (calls, ms, draining only)', ticks.map((t) => [t.calls, t.ended - t.started, t.drainOnly]));
  check('the first wake runs every job due', [ticks[0]?.drainOnly, (ticks[0]?.jobs.length ?? 0) > 5], [false, true]);
  const chained = ticks.slice(1);
  check('the clock chains: several wakes follow the first inside the cadence', chained.length >= 3, true);
  check('every chained wake runs only the job that left work', chained.filter((t) => !t.drainOnly || t.jobs.join() !== 'transcript-parse').length, 0);
  check(`every chained wake makes at most ${CHAINED_CALL_BUDGET} store calls`, chained.filter((t) => t.calls > CHAINED_CALL_BUDGET).map((t) => t.calls), []);
  check(`every chained wake ends within ${CHAINED_TICK_BUDGET_MS} ms at ${LATENCY_MS} ms a call`, chained.filter((t) => t.ended - t.started > CHAINED_TICK_BUDGET_MS).map((t) => t.ended - t.started), []);
  const gaps = ticks.slice(1).map((t, i) => ({ gap: t.started - ticks[i]!.started, bound: (ticks[i]!.ended - ticks[i]!.started) + CHAINED_WAKE_MS + SLACK_MS }));
  note('gaps between wake starts (ms)', gaps.map((g) => g.gap));
  check('every wake starts at most its predecessor\'s duration plus the chained wake after it', gaps.filter((g) => g.gap > g.bound), []);
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
