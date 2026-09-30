/**
 * Runtime proof that exactly one clock ticks once the clock is kept under a new name (#1510), on real workerd.
 *
 * `wrangler dev --local` runs the product's own `DeploymentClock` with its real alarms. A clock placed in a region is
 * a clock under a name, and an object under a retired name still holds the alarm it last armed. The
 * scenario arms that alarm on every retired name, then wakes the clock the way the product does (`ensure`, and the
 * cron floor's `wakeClock`), and reads both: the retired object's alarm fires, is deleted, and runs no tick, while
 * the clock under `CLOCK_NAME` ticks and keeps its alarm. The tick is replaced by a recorder, so what is counted is
 * which object ticked, not what a tick did.
 *
 * Every process it starts is stopped by its exact PID. Usage: bun tests/myco-server/runtime/clock-placement-runtime.ts
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { RETIRED_CLOCK_NAMES } from '../../../packages/myco-server/src/platform/cloudflare/clock-name.js';

const ROOT = path.resolve(import.meta.dir, '../../..');
const WRANGLER = path.join(ROOT, 'node_modules/.bin/wrangler');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-clock-placement-runtime-'));
const EVIDENCE = process.env.MYCO_CLOCK_PLACEMENT_EVIDENCE ?? path.join(RUN, 'result.json');
const STATE = path.join(RUN, 'state');
const checks: Array<Record<string, unknown>> = [];
const owned: Array<{ what: string; pid: number }> = [];

/** How soon the retired object's leftover alarm fires. */
const LEFTOVER_ALARM_MS = 1_500;
/** How long the scenario watches both objects: past the leftover alarm and a few of the clock's own wakes. */
const WATCH_MS = 8_000;

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

/**
 * The product's clock, with its tick replaced by a recorder that answers a short next wake. `leaveAlarm` stands in for
 * the alarm an object under a retired name still holds; nothing in the product calls it.
 */
const ENTRY = `
import { clockStub, DeploymentClock as ProductClock, wakeClock } from '${path.join(ROOT, 'packages/myco-server/src/platform/cloudflare/deployment-clock.ts')}';
const RETIRED = ${JSON.stringify(RETIRED_CLOCK_NAMES)};
export class DeploymentClock extends ProductClock {
  async tick(now) {
    const ticks = (await this.ctx.storage.get('ticks')) ?? [];
    ticks.push(Date.now());
    await this.ctx.storage.put('ticks', ticks);
    return { state: 'active', heldBy: null, drained: 0, scheduled: { dispatched: 0, skipped: 0 }, idleMs: 0, jobs: [], nextWakeMs: 2000, backlog: { transcripts: 0, bytes: 0, imported: { transcripts: 0, bytes: 0 } } };
  }
  async leaveAlarm(inMs) { await this.ctx.storage.setAlarm(Date.now() + inMs); return this.ctx.storage.getAlarm(); }
  async record() { return { ticks: (await this.ctx.storage.get('ticks')) ?? [], alarm: await this.ctx.storage.getAlarm() }; }
}
const retired = (env, name) => env.CLOCK.get(env.CLOCK.idFromName(name));
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/leave-alarms') return Response.json(Object.fromEntries(await Promise.all(RETIRED.map(async (name) => [name, await retired(env, name).leaveAlarm(${LEFTOVER_ALARM_MS})]))));
    if (url.pathname === '/start') { await clockStub(env.CLOCK).ensure(); return Response.json({ started: true }); }
    if (url.pathname === '/cron') { await wakeClock(env); return Response.json({ woke: true }); }
    if (url.pathname === '/record') return Response.json({
      current: await clockStub(env.CLOCK).record(),
      retired: Object.fromEntries(await Promise.all(RETIRED.map(async (name) => [name, await retired(env, name).record()]))),
    });
    return new Response('not found', { status: 404 });
  },
};
`;

let worker: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
function writeConfig(): void {
  fs.writeFileSync(path.join(RUN, 'wrangler.toml'), [
    'name = "myco-clock-placement-runtime"',
    'main = "entry.ts"',
    'compatibility_date = "2026-08-01"',
    '',
    '[[durable_objects.bindings]]', 'name = "CLOCK"', 'class_name = "DeploymentClock"', '',
    '[[migrations]]', 'tag = "v1-clock"', 'new_sqlite_classes = [ "DeploymentClock" ]', '',
  ].join('\n'));
  fs.writeFileSync(path.join(RUN, 'entry.ts'), ENTRY);
}

async function startWorker(): Promise<void> {
  port = await freePort();
  const inspector = await freePort();
  const log = fs.openSync(path.join(RUN, 'wrangler.log'), 'a');
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
const call = async (route: string): Promise<any> => (await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(30_000) })).json();

let failure: unknown = null;
try {
  writeConfig();
  await startWorker();
  const left = await call('/leave-alarms');
  check('every retired name holds an alarm before the switch', RETIRED_CLOCK_NAMES.map((name) => typeof left[name] === 'number'), RETIRED_CLOCK_NAMES.map(() => true));
  await call('/start');
  await call('/cron');
  await Bun.sleep(WATCH_MS);
  const record = await call('/record');
  note('current clock ticks', record.current.ticks.length);
  check('the clock under the current name ticks', record.current.ticks.length >= 2, true);
  check('the clock under the current name keeps its alarm', typeof record.current.alarm, 'number');
  check('no retired clock ever ticks', RETIRED_CLOCK_NAMES.map((name) => record.retired[name].ticks.length), RETIRED_CLOCK_NAMES.map(() => 0));
  check('every retired clock deleted the alarm it held once it fired', RETIRED_CLOCK_NAMES.map((name) => record.retired[name].alarm), RETIRED_CLOCK_NAMES.map(() => null));
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
