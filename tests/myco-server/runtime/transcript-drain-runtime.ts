/**
 * Runtime proof that the Deployment's clock keeps its chained cadence while work a tick launched is still running,
 * on real workerd.
 *
 * `wrangler dev --local` runs the product's own `DeploymentClock` with its real alarms (no manual clock mode). A
 * subclass stands in for one tick: it records when it starts, answers the chained wake, and, on its first tick,
 * launches a slow piece of work through the same deferral a clock-owned embedding run is launched through. What it
 * proves cannot be proven in process: while that work runs, the next alarm fires and the next tick starts at most the
 * tick's own duration plus the chained wake after the one before; and the work, left running past the alarm that
 * launched it, still finishes.
 *
 * Every process it starts is stopped by its exact PID. Usage: bun tests/myco-server/runtime/transcript-drain-runtime.ts
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CHAINED_WAKE_MS } from '../../../packages/myco-server/src/core/tick.js';

const ROOT = path.resolve(import.meta.dir, '../../..');
const WRANGLER = path.join(ROOT, 'node_modules/.bin/wrangler');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-transcript-drain-runtime-'));
const EVIDENCE = process.env.MYCO_TRANSCRIPT_DRAIN_EVIDENCE ?? path.join(RUN, 'result.json');
const STATE = path.join(RUN, 'state');
const checks: Array<Record<string, unknown>> = [];
const owned: Array<{ what: string; pid: number }> = [];

/** How long the launched work runs: far longer than a chained wake, as a clock-owned embedding run is. */
const WORK_MS = 20_000;
/** How long a tick itself takes: a stand-in for its store round trips. */
const TICK_MS = 300;
/** Scheduling slack a local alarm is allowed on top of the bound. */
const SLACK_MS = 750;

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
 * The product's clock, with its tick replaced by a recorder. Its first tick launches the slow work through the clock
 * environment's deferral, which is where a clock-owned embedding run's launch goes; every tick answers the chained
 * wake until told to stop.
 */
const ENTRY = `
import { DeploymentClock as ProductClock } from '${path.join(ROOT, 'packages/myco-server/src/platform/cloudflare/deployment-clock.ts')}';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export class DeploymentClock extends ProductClock {
  async tick(now) {
    const started = Date.now();
    const ticks = (await this.ctx.storage.get('ticks')) ?? [];
    if (ticks.length === 0) {
      this.clockEnv().afterResponse(async () => {
        await this.ctx.storage.put('work', { started: Date.now() });
        await sleep(${WORK_MS});
        await this.ctx.storage.put('work', { started: (await this.ctx.storage.get('work')).started, ended: Date.now() });
      });
    }
    await sleep(${TICK_MS});
    ticks.push({ started, ended: Date.now() });
    await this.ctx.storage.put('ticks', ticks);
    const stopped = (await this.ctx.storage.get('stop')) === true;
    return { state: 'active', heldBy: null, drained: 0, scheduled: { dispatched: 0, skipped: 0 }, idleMs: 0, jobs: [], nextWakeMs: stopped ? null : ${CHAINED_WAKE_MS}, backlog: { transcripts: 0, bytes: 0, imported: { transcripts: 0, bytes: 0 } } };
  }
  async record() { return { ticks: (await this.ctx.storage.get('ticks')) ?? [], work: (await this.ctx.storage.get('work')) ?? null, alarm: await this.ctx.storage.getAlarm() }; }
  async halt() { await this.ctx.storage.put('stop', true); }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const clock = env.CLOCK.get(env.CLOCK.idFromName('deployment'));
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/start') { await clock.ensure(); return Response.json({ started: true }); }
    if (url.pathname === '/record') return Response.json(await clock.record());
    if (url.pathname === '/halt') { await clock.halt(); return Response.json({ halted: true }); }
    return new Response('not found', { status: 404 });
  },
};
`;

let worker: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
function writeConfig(): void {
  fs.writeFileSync(path.join(RUN, 'wrangler.toml'), [
    'name = "myco-transcript-drain-runtime"',
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
  await call('/start');

  // Long enough for the work to finish and a few ticks after it.
  let record = await call('/record');
  const until = Date.now() + WORK_MS + 15_000;
  while (Date.now() < until && !(record.work?.ended !== undefined && record.ticks.some((t: { started: number }) => t.started > record.work.ended))) {
    await Bun.sleep(1_000);
    record = await call('/record');
  }
  await call('/halt');
  record = await call('/record');

  const ticks: Array<{ started: number; ended: number }> = record.ticks;
  const work: { started: number; ended?: number } | null = record.work;
  check('the first tick launched the work', work !== null, true);
  check('the work ran to its end although the alarm that launched it had returned', work?.ended !== undefined && work.ended - work.started >= WORK_MS, true);
  const during = ticks.filter((t) => work !== null && t.started > work.started && t.started < (work.ended ?? Number.POSITIVE_INFINITY));
  note('ticks while the work ran', during.length);
  check('ticks kept starting while the work ran', during.length >= Math.floor(WORK_MS / (CHAINED_WAKE_MS + TICK_MS + SLACK_MS)) - 1, true);
  const gaps = ticks.slice(1).map((t, i) => ({ gap: t.started - ticks[i].started, bound: (ticks[i].ended - ticks[i].started) + CHAINED_WAKE_MS + SLACK_MS }));
  note('gaps between tick starts (ms)', gaps.map((g) => g.gap));
  check('every gap between tick starts is at most the tick duration plus the chained wake', gaps.filter((g) => g.gap > g.bound), []);
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
