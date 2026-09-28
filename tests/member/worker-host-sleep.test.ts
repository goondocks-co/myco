/**
 * Two workers, one run, and a host that sleeps (#1424).
 *
 * The defect as it was observed: the Mac and the macOS VM it hosts both ran a
 * worker, and the Mac spent an afternoon in clamshell sleep, waking for a few
 * seconds at a time. Every such wake let a worker claim the queued run and start
 * a harness; the machine slept again within seconds; the lease lapsed while it
 * slept; the Deployment's sweep returned the run to the queue; and the next wake
 * claimed it again — 46 claims and 45 lapsed leases for one run that took 105
 * seconds once the machine stayed up.
 *
 * Sleep is modelled the way a worker experiences it: the wall clock jumps and
 * nothing ran in between. The Deployment's clock jumps with it (both machines'
 * clocks keep time through a sleep) and its lease sweep runs, as the hosted
 * clock does while the laptop is asleep. The harness is the stub on PATH from
 * `tests/helpers/stub-acp-harness.ts`, held open until the test releases it, so
 * a run is in flight because it has not been released rather than because a
 * read arrived in time.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, type WorkerOptions, type WorkerOutcome } from '@myco/runner/loop.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { expireLeases } from '@myco-server-worker/core/harness.js';
import { WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.ts';
import { stubAcpHarness, STUB_DETECTED, STUB_HARNESS } from '../helpers/stub-acp-harness.ts';
import { withRunMcp } from '../helpers/run-mcp-fetch.ts';

const NOW = 1_800_000_000_000;
const PROJECT_ID = 'proj_1';
const SERVER_URL = 'https://deployment.example';
/** How long a machine must be awake before its worker claims, scaled down for the test. */
const SETTLE_MS = 5_000;
/** A dark wake: longer than the two seconds a worker waits between polls, shorter than the settle. */
const DARK_WAKE_MS = 2_500;
/** A sleep long enough that any lease a worker held lapses in it. */
const SLEEP_MS = 5 * 60_000;

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function until(what: string, pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

/**
 * One host: a Deployment reached in-process, a clock that sleeps, and workers
 * that share it. `heartbeatMs`, when given, replaces the cadence the claim
 * answers with, so a run renews many times inside a short test; the lease the
 * Deployment grants is its own and unchanged.
 */
async function host(options: { heartbeatMs?: number } = {}) {
  const e = sqliteEnv();
  let offset = 0;
  /** While set, a renewal reaches nothing and is answered never: a network still coming back after a wake. */
  let offline = false;
  const clock = (): number => Date.now() + offset;
  const server = createServer({ now: clock, sourceOf: () => '1.2.3.4', fetchImpl: (input, init) => fetch(input, init) });
  const sent: Array<{ path: string; body: Record<string, unknown> | null; answer: Record<string, unknown> | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(typeof input === 'string' || input instanceof URL ? String(input) : input.url, init);
    const path = new URL(request.url).pathname;
    if (offline && path === '/worker/lease') {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) { reject(signal.reason); return; }
        signal?.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
      });
    }
    const body = request.method === 'POST' ? await request.clone().json().catch(() => null) as Record<string, unknown> | null : null;
    const response = await server.handleRequest(request, e.serverEnv);
    const answer = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
    sent.push({ path, body, answer });
    if (path === '/worker/claim' && answer?.claimed === true && options.heartbeatMs !== undefined) {
      return Response.json({ ...answer, heartbeatMs: options.heartbeatMs }, { headers: response.headers });
    }
    return response;
  }) as unknown as typeof fetch;

  const member = async (id: string) => {
    await ensureMember(e.db, id, NOW, 'admin', id);
    return issueMemberToken(e.db, { memberId: id, machineId: `machine_${id}` }, NOW);
  };
  const queueRun = (id: string) => {
    e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    e.sqlite.run(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
       VALUES (?, ?, 'myco-agent', 'extract-curate', 'queued', ?, 'worker', ?, ?, 'do it')`,
      [PROJECT_ID, id, clock(), JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })],
    );
  };
  const row = (id: string) => e.sqlite.query(`SELECT status, leased_by AS leasedBy, dispatched_by AS dispatchedBy FROM agent_runs WHERE id = ?`).get(id) as { status: string; leasedBy: string | null; dispatchedBy: string | null };

  /** The host sleeps: both clocks jump, nothing on the host runs, and the Deployment's lease sweep does. */
  const sleep = async (ms: number) => {
    offset += ms;
    await expireLeases(e.serverEnv, clock());
  };

  const workers: Array<{ name: string; lines: string[]; outcome: Promise<WorkerOutcome> }> = [];
  const stopping = new AbortController();
  const attach = (name: string, token: string, extra: Partial<WorkerOptions> = {}) => {
    const lines: string[] = [];
    const outcome = runWorker({
      serverUrl: SERVER_URL,
      token,
      lockDir: null,
      runRoot: mkdtempSync(join(tmpdir(), `myco-sleep-${name}-`)),
      only: [STUB_HARNESS],
      pollIdleMs: 50,
      log: (line) => { lines.push(line); },
      fetchImpl,
      signal: stopping.signal,
      clock,
      wakeSettleMs: SETTLE_MS,
      ...extra,
    });
    workers.push({ name, lines, outcome });
    return lines;
  };
  const claims = () => workers.flatMap((w) => w.lines.filter((l) => l.startsWith('claimed ')).map((l) => `${w.name}: ${l}`));
  const lost = () => workers.flatMap((w) => w.lines.filter((l) => l.includes('lease lost')).map((l) => `${w.name}: ${l}`));
  const report = () => workers.map((w) => `${w.name}:\n${w.lines.map((l) => `    ${l}`).join('\n')}`).join('\n');
  const stop = async () => {
    stopping.abort();
    await Promise.all(workers.map((w) => w.outcome.catch(() => undefined)));
  };
  /** The run's MCP server, answered by the same Deployment, for the driver's tool listing. */
  const mcp = <T>(fn: () => Promise<T>): Promise<T> => withRunMcp(SERVER_URL, (request) => server.handleRequest(request, e.serverEnv), fn);
  const goOffline = () => { offline = true; };
  return { e, clock, sleep, goOffline, member, queueRun, row, attach, claims, lost, report, stop, sent, mcp };
}

function turnRelease() {
  const release = join(mkdtempSync(join(tmpdir(), 'myco-sleep-release-')), 'release');
  expect(stubAcpHarness({ holdUntil: release })).toEqual(STUB_DETECTED);
  return () => { if (!existsSync(release)) writeFileSync(release, ''); };
}

describe('two workers on a host that sleeps', () => {
  it('claims nothing in wakes too short to finish a run, then runs it once when the host stays up', async () => {
    const release = turnRelease();
    const h = await host();
    const [a, b] = [await h.member('mem_mac'), await h.member('mem_vm')];
    await h.mcp(async () => {
      try {
        h.attach('mac', a.token);
        h.attach('vm', b.token);
        await wait(200);
        // The lid closes; the run is queued while the host is asleep.
        await h.sleep(SLEEP_MS);
        h.queueRun('run_sleepy');
        // Three dark wakes, each a few moments long, each followed by more sleep.
        for (let i = 0; i < 3; i += 1) {
          await wait(DARK_WAKE_MS);
          await h.sleep(SLEEP_MS);
        }
        // The host stays up. Exactly one worker takes the run once it has been
        // awake long enough, and the other takes nothing.
        await until('the run to be claimed once the host stayed up', () => h.claims().length > 0 || h.row('run_sleepy').status !== 'queued', SETTLE_MS * 4);
        await wait(300);
        release();
        await until('the run to end', () => !['queued', 'running'].includes(h.row('run_sleepy').status));
        await wait(200);
        expect({ claims: h.claims(), lost: h.lost() }, h.report()).toEqual({ claims: [expect.stringContaining('claimed run_sleepy')], lost: [] });
      } finally {
        release();
        await h.stop();
      }
    });
  }, 60_000);

  it('stops a harness whose lease lapsed while the host slept, from its own clock, and reports nothing on the run', async () => {
    const release = turnRelease();
    const h = await host({ heartbeatMs: 200 });
    const a = await h.member('mem_mac');
    await h.mcp(async () => {
      try {
        h.queueRun('run_napped');
        const lines = h.attach('mac', a.token);
        await until('the run to be driven', () => h.row('run_napped').status === 'running');
        await wait(200);
        // The host sleeps past the lease; the Deployment returns the run to the
        // queue; and the network is not back yet when the host wakes, so no
        // renewal is answered.
        h.goOffline();
        await h.sleep(WORKER_LEASE_MS + SLEEP_MS);
        expect(h.row('run_napped').status).toBe('queued');
        // The worker knows on waking, from its own clock and the expiry the
        // Deployment last gave it, that it no longer holds the run, and stops
        // the harness without waiting on an answer that is not coming.
        await until('the worker to stop the harness it no longer holds', () => lines.some((l) => l.includes('slept past')), 3_000)
          .catch((error: Error) => { throw new Error(`${error.message}\n${h.report()}`); });
        // It reported nothing on a run it no longer holds.
        expect(h.sent.filter((s) => s.path === '/worker/end')).toEqual([]);
      } finally {
        release();
        await h.stop();
      }
    });
  }, 30_000);

  it('has one of two polling workers drive a slow run through many renewals while the other takes nothing', async () => {
    const release = turnRelease();
    const h = await host({ heartbeatMs: 100 });
    const [a, b] = [await h.member('mem_mac'), await h.member('mem_vm')];
    await h.mcp(async () => {
      try {
        h.queueRun('run_slow');
        // Each worker holds its machine awake while it drives, and lets go when the run ends.
        const held = { mac: { holds: 0, releases: 0 }, vm: { holds: 0, releases: 0 } };
        const keepAwake = (name: 'mac' | 'vm') => () => { held[name].holds += 1; return () => { held[name].releases += 1; }; };
        h.attach('mac', a.token, { keepAwake: keepAwake('mac') });
        h.attach('vm', b.token, { keepAwake: keepAwake('vm') });
        await until('the run to be driven', () => h.row('run_slow').status === 'running');
        // The run is held open long enough to renew many times.
        await until('several renewals', () => h.sent.filter((s) => s.path === '/worker/lease').length >= 8);
        release();
        await until('the run to end', () => !['queued', 'running'].includes(h.row('run_slow').status));
        await wait(200);
        expect({ claims: h.claims().length, lost: h.lost() }, h.report()).toEqual({ claims: 1, lost: [] });
        expect([held.mac, held.vm].sort((x, y) => y.holds - x.holds)).toEqual([{ holds: 1, releases: 1 }, { holds: 0, releases: 0 }]);
      } finally {
        release();
        await h.stop();
      }
    });
  }, 30_000);
});
