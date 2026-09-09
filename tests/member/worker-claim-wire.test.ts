/**
 * The shipped worker against the real server pipeline.
 *
 * Every other worker test stubs `fetchImpl` with a hand-written answer, which
 * proves what the loop does with an answer and nothing about whether a
 * Deployment would give it one: a worker that declared no member protocol was
 * answered 409 by every Deployment and passed every one of those tests. So the
 * fetch here IS the server — `createServer(...).handleRequest` over the same
 * SQLite-backed fixture `tests/myco-server/worker-routes.test.ts` boots — and
 * the protocol window, the credential, the machine identity and the
 * administrator check all run on each request the worker actually sends.
 *
 * The harness is the stub on PATH from `tests/helpers/stub-acp-harness.ts`, so a
 * run is claimed, driven and ended without a real agent. Nothing here reaches
 * the network.
 *
 * Two things keep a failure legible rather than a timeout: the detection the
 * worker's offer is built from is asserted before anything is claimed, and the
 * attachment is bounded by a signal of this test's own. A worker that cannot
 * claim polls by design, so without the bound an unoffered harness reads as a
 * hung test with no output at all.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, type WorkerOutcome } from '@myco/runner/loop.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { RUN_CLOSE_ERROR } from '@myco-server-worker/core/run-postconditions.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.ts';
import { stubAcpHarness, STUB_DETECTED, STUB_HARNESS } from '../helpers/stub-acp-harness.ts';

const NOW = 1_800_000_000_000;
const PROJECT_ID = 'proj_1';
/** Well under the per-test timeout, so a worker that cannot claim fails with its own log rather than with a timeout. */
const ATTACH_BOUND_MS = 10_000;

async function rig(before: (path: string, n: number) => Response | null = () => null) {
  const e = sqliteEnv();
  // `createServer` takes the source identity as a dependency, so the edge header
  // a deployed Worker reads is supplied here instead of stamped on the worker's
  // own requests: nothing a worker sends is invented by this fixture.
  const server = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: (input, init) => fetch(input, init) });
  const sent: Array<{ path: string; protocol: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(typeof input === 'string' || input instanceof URL ? String(input) : input.url, init);
    const path = new URL(request.url).pathname;
    sent.push({ path, protocol: request.headers.get('x-myco-protocol') });
    // A fault standing in front of the Deployment, answered before it: the
    // Deployment itself is still the thing every other request reaches.
    return before(path, sent.filter((s) => s.path === path).length) ?? await server.handleRequest(request, e.serverEnv);
  }) as unknown as typeof fetch;

  const member = async (id: string, role: 'admin' | 'member') => {
    await ensureMember(e.db, id, NOW, role, id);
    return (await issueMemberToken(e.db, { memberId: id, machineId: id }, NOW)).token;
  };
  const queueRun = (id: string) => {
    e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    e.sqlite.run(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
       VALUES (?, ?, 'myco-agent', 'title-summary', 'queued', ?, 'worker', ?, ?, 'do it')`,
      [PROJECT_ID, id, NOW, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })],
    );
  };
  const runRow = (id: string) => e.sqlite.query(`SELECT status, harness, error FROM agent_runs WHERE id = ?`).get(id) as { status: string; harness: string | null; error: string | null } | null;

  /** Attach a worker, bounded by this test's own signal, and answer what it did with the lines it logged. */
  const attach = async (
    token: string,
    opts: { once?: boolean; stopping?: AbortController } = {},
  ): Promise<WorkerOutcome & { lines: string[] }> => {
    const lines: string[] = [];
    const stopping = opts.stopping ?? new AbortController();
    const bound = setTimeout(() => { stopping.abort(); }, ATTACH_BOUND_MS);
    try {
      const outcome = await runWorker({
        serverUrl: 'https://deployment.example',
        token,
        runRoot: mkdtempSync(join(tmpdir(), 'myco-wire-runs-')),
        only: [STUB_HARNESS],
        once: opts.once ?? true,
        pollIdleMs: 50,
        log: (line) => { lines.push(line); },
        fetchImpl,
        signal: stopping.signal,
      });
      return { ...outcome, lines };
    } finally {
      clearTimeout(bound);
    }
  };
  return { e, member, queueRun, runRow, attach, sent };
}

/** A failure that names what the worker did and said, so a stalled attachment is readable without a rerun. */
function reportOf(what: string, attached: WorkerOutcome & { lines: string[] }, paths: string[]): string {
  return `${what}: drove ${attached.driven}, refused ${String(attached.refused)}`
    + `\n  asked: ${paths.join(', ') || '(nothing)'}`
    + `\n  worker log:\n${attached.lines.map((l) => `    ${l}`).join('\n') || '    (nothing)'}`;
}

describe('a worker on the real claim wire', () => {
  it('offers the harness this machine reports as logged in', () => {
    // The offer a claim carries is built from this, so a claim answered
    // `no_harness` is a detection failure rather than a wire failure. Asserted
    // on its own, ahead of every test that needs a run claimed.
    expect(stubAcpHarness()).toEqual(STUB_DETECTED);
  });

  it('speaks the member protocol, so an administrator\'s claim is answered and the run is driven to completion', async () => {
    expect(stubAcpHarness()).toEqual(STUB_DETECTED);
    const r = await rig();
    const admin = await r.member('mem_admin', 'admin');
    r.queueRun('run_wire');

    const attached = await r.attach(admin);
    const paths = r.sent.map((s) => s.path);
    // Claimed, driven and ended — through the pipeline that refuses a request
    // declaring no protocol. A worker whose headers carry none never gets here.
    if (attached.driven !== 1 || attached.refused !== null) throw new Error(reportOf('the worker drove no run', attached, paths));
    expect(attached.lines.some((l) => l.startsWith('claimed run_wire'))).toBe(true);
    // The row reached a terminal status over the wire. It is `failed` rather than
    // `completed` on the Deployment's own judgement: the stub ends its turn
    // without calling back, and a titling run owes a report and a title.
    expect(r.runRow('run_wire')).toEqual({ status: 'failed', harness: STUB_HARNESS, error: RUN_CLOSE_ERROR });
    // Every request the worker made declared the protocol: the header is on the
    // claim and on the end, not only on the first call.
    expect(paths).toEqual(['/worker/claim', '/worker/end']);
    expect([...new Set(r.sent.map((s) => s.protocol))]).toEqual(['1']);
  }, 30_000);

  it('ends on a refusal, naming it, rather than polling silently against it', async () => {
    expect(stubAcpHarness()).toEqual(STUB_DETECTED);
    const r = await rig();
    const plain = await r.member('mem_plain', 'member');
    r.queueRun('run_unclaimed');

    const attached = await r.attach(plain);
    const paths = r.sent.map((s) => s.path);
    // A membership that does not administer the Deployment is refused every
    // claim it will ever make, so the worker says so once and stops. It polled
    // exactly once: a second claim would be the silent loop this replaces.
    if (attached.refused !== 'not_admin') throw new Error(reportOf('the worker was not refused not_admin', attached, paths));
    expect(attached.driven).toBe(0);
    expect(attached.lines.filter((l) => l.includes('not_admin'))).toHaveLength(1);
    expect(paths).toEqual(['/worker/claim']);
    expect(r.runRow('run_unclaimed')?.status).toBe('queued');
  }, 30_000);

  it('rides out a Deployment restart: a 503 keeps it polling, and the next claim is taken', async () => {
    expect(stubAcpHarness()).toEqual(STUB_DETECTED);
    // A Deployment coming back up answers 503 with a retry-after. That is the
    // shape a restart has, and it must not end an attachment: the worker that
    // treated it as a refusal would detach from a Deployment that was about to
    // serve it. Only the first claim is faulted; the Deployment answers the rest.
    const r = await rig((path, n) => (path === '/worker/claim' && n === 1
      ? Response.json({ error: 'unavailable' }, { status: 503, headers: { 'retry-after': '0' } })
      : null));
    const admin = await r.member('mem_admin', 'admin');
    r.queueRun('run_after_503');

    const attached = await r.attach(admin);
    const paths = r.sent.map((s) => s.path);
    if (attached.driven !== 1 || attached.refused !== null) throw new Error(reportOf('a 503 ended the attachment', attached, paths));
    expect(r.runRow('run_after_503')).toEqual({ status: 'failed', harness: STUB_HARNESS, error: RUN_CLOSE_ERROR });
    // Two claims: the faulted one and the one that was answered.
    expect(paths).toEqual(['/worker/claim', '/worker/claim', '/worker/end']);
    expect(attached.lines.filter((l) => l.includes('cannot reach'))).toHaveLength(1);
    expect(attached.lines.filter((l) => l.includes('again'))).toHaveLength(1);
  }, 30_000);

  it('says what a claim answered when it answers nothing, so an unrunnable queue is not silence', async () => {
    expect(stubAcpHarness()).toEqual(STUB_DETECTED);
    // The worker is stopped on its third claim from inside the fetch, so the
    // count is decided by the stub rather than by how long the test ran. The
    // Deployment still answers every one of them.
    const stopping = new AbortController();
    const r = await rig((path, n) => {
      if (path === '/worker/claim' && n >= 3) stopping.abort();
      return null;
    });
    const admin = await r.member('mem_admin', 'admin');
    // No run is queued, so every claim is answered `no_work` — named once across
    // all three rather than once each.
    const attached = await r.attach(admin, { once: false, stopping });
    expect({
      said: attached.lines.filter((l) => l === 'nothing claimed: no_work').length,
      claims: r.sent.filter((s) => s.path === '/worker/claim').length,
    }).toEqual({ said: 1, claims: 3 });
  }, 30_000);

  it('keeps polling a Deployment it cannot reach, and says so once', async () => {
    const stopping = new AbortController();
    let polls = 0;
    const lines: string[] = [];
    const fetchImpl = (async () => {
      polls += 1;
      if (polls >= 3) stopping.abort();
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const { driven, refused } = await runWorker({
      serverUrl: 'https://deployment.example',
      token: 'x'.repeat(43),
      runRoot: mkdtempSync(join(tmpdir(), 'myco-wire-runs-')),
      only: [STUB_HARNESS],
      pollIdleMs: 10,
      log: (line) => { lines.push(line); },
      fetchImpl,
      signal: stopping.signal,
    });

    // A dead socket is transient: the worker stays attached, and the diagnostic
    // is one line rather than one per poll.
    expect({ driven, refused, polls }).toEqual({ driven: 0, refused: null, polls: 3 });
    expect(lines.filter((l) => l.includes('cannot reach'))).toHaveLength(1);
  }, 30_000);
});
