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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, type WorkerOutcome } from '@myco/runner/loop.js';
import workerServer from '@myco-server-worker/index.js';
import { asOwnerPost, OWNER_ENV } from '../myco-server/helpers/owner.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { RUN_CLOSE_ERROR } from '@myco-server-worker/core/run-postconditions.js';
import { sqliteEnv, turnOnGatedCapabilities } from '../myco-server/helpers/fixtures.ts';
import { stubAcpHarness, STUB_DETECTED, STUB_HARNESS } from '../helpers/stub-acp-harness.ts';
import { PROFILE_STUB_DETECTED, PROFILE_STUB_HARNESS, STUB_PROFILE, stubProfileHarness } from '../helpers/stub-profile-harness.ts';
import { MODEL_CATALOG_FEATURE } from '@goondocks/myco-shared/execution-profile';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';
import { withRunMcp } from '../helpers/run-mcp-fetch.ts';

const NOW = 1_800_000_000_000;
const PROJECT_ID = 'proj_1';
/** Well under the per-test timeout, so a worker that cannot claim fails with its own log rather than with a timeout. */
const ATTACH_BOUND_MS = 10_000;

async function rig(before: (path: string, n: number) => Response | null = () => null) {
  const e = sqliteEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite, [PROJECT_ID]);
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
       VALUES (?, ?, 'myco-agent', 'extract-curate', 'queued', ?, 'worker', ?, ?, 'do it')`,
      [PROJECT_ID, id, NOW, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })],
    );
  };
  const runRow = (id: string) => e.sqlite.query(`SELECT status, harness, error FROM agent_runs WHERE id = ?`).get(id) as { status: string; harness: string | null; error: string | null } | null;

  /** Attach a worker, bounded by this test's own signal, and answer what it did with the lines it logged. */
  const attach = async (
    token: string,
    opts: { once?: boolean; stopping?: AbortController; only?: string } = {},
  ): Promise<WorkerOutcome & { lines: string[] }> => {
    const lines: string[] = [];
    const stopping = opts.stopping ?? new AbortController();
    const bound = setTimeout(() => { stopping.abort(); }, ATTACH_BOUND_MS);
    const runRoot = mkdtempSync(join(tmpdir(), 'myco-wire-runs-'));
    try {
      // The driver lists the run's tools over the run's credential before it
      // opens a session, from the same Deployment.
      const outcome = await withRunMcp('https://deployment.example', (request) => server.handleRequest(request, e.serverEnv), () => runWorker({
        serverUrl: 'https://deployment.example',
        token,
        lockDir: null,
        runRoot,
        only: [opts.only ?? PROFILE_STUB_HARNESS],
        once: opts.once ?? true,
        pollIdleMs: 50,
        log: (line) => { lines.push(line); },
        fetchImpl,
        signal: stopping.signal,
      }));
      return { ...outcome, lines };
    } finally {
      clearTimeout(bound);
      rmSync(runRoot, { recursive: true, force: true });
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
  it('waits for execution-profile advertisement without claiming or failing an old server run', async () => {
    expect(stubProfileHarness()).toEqual(PROFILE_STUB_DETECTED);
    const stopping = new AbortController();
    const r = await rig((path, n) => {
      if (n >= 3) stopping.abort();
      if (path === '/members/status') return Response.json({ persisted: true }, { headers: { 'x-myco-protocol': '1', 'x-myco-features': 'worker-accounting-v1' } });
      if (path === '/worker/claim') return Response.json({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 1 });
      return null;
    });
    const admin = await r.member('mem_admin', 'admin');
    r.queueRun('run_old_server');
    const attached = await r.attach(admin, { once: false, stopping });
    expect(r.sent.filter((sent) => sent.path === '/worker/claim' || sent.path === '/worker/end')).toEqual([]);
    expect(r.runRow('run_old_server')?.status).toBe('queued');
    expect(attached.driven).toBe(0);
    expect(attached.lines.filter((line) => line === 'this server needs updating before it can give this worker work')).toHaveLength(1);
  });

  it('rechecks execution-profile support before the next claim when the server needs updating', async () => {
    expect(stubProfileHarness()).toEqual(PROFILE_STUB_DETECTED);
    const stopping = new AbortController();
    const r = await rig((path, n) => {
      if (path === '/members/status' && n >= 2) {
        if (n >= 3) stopping.abort();
        return Response.json({ persisted: true }, { headers: { 'x-myco-protocol': '1' } });
      }
      if (path === '/worker/claim' && n >= 3) stopping.abort();
      return null;
    });
    const admin = await r.member('mem_admin', 'admin');
    r.queueRun('run_before_skew');
    r.queueRun('run_after_skew');
    const attached = await r.attach(admin, { once: false, stopping });
    expect(attached.driven).toBe(1);
    expect(r.sent.filter((sent) => sent.path === '/worker/claim')).toHaveLength(1);
    expect(r.runRow('run_after_skew')?.status).toBe('queued');
    expect(attached.lines.filter((line) => line === 'this server needs updating before it can give this worker work')).toHaveLength(1);
  });

  it('advertises execution-profile before a worker can take a run', async () => {
    const r = await rig();
    const admin = await r.member('mem_admin', 'admin');
    const response = await workerServer.fetch(new Request('https://s/members/status', {
      method: 'POST', headers: { authorization: `Bearer ${admin}`, 'cf-connecting-ip': '1.2.3.4', 'x-myco-protocol': '1', 'content-type': 'application/json' }, body: '{}',
    }), r.e.env);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-myco-features')?.split(',')).toContain('execution-profile');
  });

  it('applies changed Settings and task tier overrides through the real claim and driver', async () => {
    const evidence = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-profile-wire-')));
    const argsPath = join(evidence, 'arguments');
    expect(stubProfileHarness({ argumentsFile: argsPath })).toEqual(PROFILE_STUB_DETECTED);
    const r = await rig();
    const admin = await r.member('mem_admin', 'admin');
    const change = async (leaf: string, value: unknown) => {
      const owner = await asOwnerPost(`/api/settings/${leaf}`);
      const response = await workerServer.fetch(new Request(owner.url, {
        method: 'PUT', headers: owner.headers, body: JSON.stringify({ value }),
      }), { ...r.e.env, ...OWNER_ENV });
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { applied: true } });
    };
    for (const [id, model, effort] of [['initial', 'sonnet', 'medium'], ['configured', 'claude-sonnet-fixture', 'high'], ['low', 'haiku', 'low'], ['override', 'opus', 'high']]) {
      if (id === 'configured') {
        await change('agent.reasoning_map.claude-code.default', model);
        await change('agent.effort_map.claude-code.default', effort);
      }
      if (id === 'low' || id === 'override') {
        const tier = id === 'low' ? 'low' : 'high';
        await change(`agent.reasoning_map.claude-code.${tier}`, model);
        await change(`agent.effort_map.claude-code.${tier}`, effort);
        await change('agent.tasks', { 'extract-curate': { reasoningLevel: tier } });
      }
      r.queueRun(`run_${id}`);
      expect(await r.attach(admin)).toMatchObject({ driven: 1, refused: null });
      const args = readFileSync(argsPath, 'utf8').trim().split('\n');
      expect(args.filter((arg) => arg === '--model')).toHaveLength(1);
      expect(args.filter((arg) => arg === '--effort')).toHaveLength(1);
      expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', model]);
      expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', effort]);
      const stored = r.e.sqlite.query(`SELECT execution_overrides FROM agent_runs WHERE id=?`).get(`run_${id}`) as { execution_overrides: string };
      expect(JSON.parse(stored.execution_overrides).requested).toMatchObject({ model, effort });
    }
    r.e.sqlite.close();
  }, 30_000);

  it('offers the harness this machine reports as logged in', () => {
    // The offer a claim carries is built from this, so a claim answered
    // `no_harness` is a detection failure rather than a wire failure. Asserted
    // on its own, ahead of every test that needs a run claimed.
    expect(stubProfileHarness()).toEqual(PROFILE_STUB_DETECTED);
  });

  it('speaks the member protocol, so an administrator\'s claim is answered and the run is driven to completion', async () => {
    expect(stubProfileHarness()).toEqual(PROFILE_STUB_DETECTED);
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
    expect(r.runRow('run_wire')).toEqual({ status: 'failed', harness: PROFILE_STUB_HARNESS, error: RUN_CLOSE_ERROR });
    // The worker reported what the harness did; the Deployment recorded what the
    // task left behind. A worker that logged only its own report would show a
    // clean drive against a run the Deployment failed, so it says both.
    expect(attached.lines).toContain('reported run_wire as completed; the Deployment recorded it failed');
    // Every request the worker made declared the protocol: the header is on the
    // claim and on the end, not only on the first call.
    expect(paths).toEqual(['/members/status', '/worker/claim', '/worker/steps', '/worker/end']);
    expect([...new Set(r.sent.map((s) => s.protocol))]).toEqual(['1']);
  }, 30_000);

  it('fails a run the Deployment handed it without an instruction, launching no harness', async () => {
    // A Deployment ends such a run at the claim; this one is stubbed to hand it
    // out anyway, which is the case the worker's own refusal exists for.
    const bare = {
      persisted: true, claimed: true, heartbeatMs: 30_000,
      run: { projectId: PROJECT_ID, id: 'run_bare', task: 'skill-survey', instruction: null, harness: PROFILE_STUB_HARNESS, runToken: 'run_token', credentialEnv: {}, profile: STUB_PROFILE, leaseExpiresAt: Date.now() + 60_000, timeoutSeconds: 60 },
    };
    const r = await rig((path) => (path === '/worker/claim' ? Response.json(bare, { headers: { 'x-myco-protocol': '1', 'x-myco-features': 'execution-profile' } }) : null));
    const token = await r.member('mem_admin', 'admin');
    const attached = await r.attach(token);
    const paths = r.sent.map((s) => s.path);
    // No lease was ever renewed and no run directory was written: the harness never started.
    const failed = attached.lines.some((l) => l.includes('supplied no instruction'));
    if (!failed) throw new Error(reportOf('the worker did not refuse the bare run', attached, paths));
    expect({ paths, driven: attached.driven, refused: attached.refused }).toEqual({ paths: ['/members/status', '/worker/claim', '/worker/end'], driven: 1, refused: null });
  });

  it('ends an unsupported claimed profile before spawning its harness', async () => {
    const spawnedFile = join(removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-profile-'))), 'spawned');
    expect(stubAcpHarness({ spawnedFile })).toEqual(STUB_DETECTED);
    const claim = {
      persisted: true, claimed: true, heartbeatMs: 30_000,
      run: {
        projectId: PROJECT_ID, id: 'run_profile_refused', task: 'extract-curate', instruction: 'do it',
        harness: STUB_HARNESS, runToken: 'run_token', credentialEnv: {}, timeoutSeconds: 60,
        profile: { tier: 'default', model: 'sonnet', effort: 'medium', sources: { tier: 'task', model: 'default' } },
      },
    };
    const r = await rig((path) => path === '/worker/claim' ? Response.json(claim, { headers: { 'x-myco-protocol': '1', 'x-myco-features': 'execution-profile' } }) : null);
    const token = await r.member('mem_admin', 'admin');
    const attached = await r.attach(token, { only: STUB_HARNESS });
    expect(existsSync(spawnedFile)).toBe(false);
    expect(attached.lines.some((line) => line.includes('profile_unapplied'))).toBe(true);
    expect(r.sent.map((sent) => sent.path)).toEqual(['/members/status', '/worker/claim', '/worker/end']);
  });

  it('refuses a missing or malformed claimed profile before preparing or spawning a run', async () => {
    for (const profile of [undefined, null, { tier: 'default', model: '', effort: 'medium', sources: null }]) {
      const spawnedFile = join(removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-profile-'))), 'spawned');
      expect(stubProfileHarness({ spawnedFile })).toEqual(PROFILE_STUB_DETECTED);
      const claim = {
        persisted: true, claimed: true, heartbeatMs: 30_000,
        run: {
          projectId: PROJECT_ID, id: 'run_bad_profile', task: 'extract-curate', instruction: 'do it',
          harness: PROFILE_STUB_HARNESS, runToken: 'run_token', credentialEnv: {}, timeoutSeconds: 60,
          ...(profile === undefined ? {} : { profile }),
        },
      };
      const r = await rig((path) => path === '/worker/claim' ? Response.json(claim, { headers: { 'x-myco-protocol': '1', 'x-myco-features': 'execution-profile' } }) : null);
      const token = await r.member('mem_admin', 'admin');
      const attached = await r.attach(token);
      expect(existsSync(spawnedFile)).toBe(false);
      expect(attached.lines.some((line) => line.includes('profile_unapplied'))).toBe(true);
    }
  });

  it('ends on a refusal, naming it, rather than polling silently against it', async () => {
    expect(stubProfileHarness()).toEqual(PROFILE_STUB_DETECTED);
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
    expect(paths).toEqual(['/members/status', '/worker/claim']);
    expect(r.runRow('run_unclaimed')?.status).toBe('queued');
  }, 30_000);

  it('rides out a Deployment restart: a 503 keeps it polling, and the next claim is taken', async () => {
    expect(stubProfileHarness()).toEqual(PROFILE_STUB_DETECTED);
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
    expect(r.runRow('run_after_503')).toEqual({ status: 'failed', harness: PROFILE_STUB_HARNESS, error: RUN_CLOSE_ERROR });
    // Two claims: the faulted one and the one that was answered, then the run's step log ahead of its end. The model list it reports beside them is its own.
    expect(paths.filter((path) => path !== '/worker/models')).toEqual(['/members/status', '/worker/claim', '/members/status', '/worker/claim', '/worker/steps', '/worker/end']);
    expect(attached.lines.filter((l) => l.includes('cannot reach'))).toHaveLength(1);
    expect(attached.lines.filter((l) => l.includes('again'))).toHaveLength(1);
  }, 30_000);

  it('says what a claim answered when it answers nothing, so an unrunnable queue is not silence', async () => {
    expect(stubProfileHarness()).toEqual(PROFILE_STUB_DETECTED);
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
      lockDir: null,
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

  it('lists its harness\'s models for a Deployment that stores them, and the next claim records what the requested alias resolves to', async () => {
    expect(stubProfileHarness()).toEqual(PROFILE_STUB_DETECTED);
    const stopping = new AbortController();
    let listing = true;
    let reported = false;
    const r = await rig((path) => {
      if (!listing) return null;
      if (path === '/members/status' && reported) stopping.abort();
      if (path === '/worker/models') reported = true;
      if (path === '/worker/claim') return Response.json({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 1 });
      return null;
    });
    const admin = await r.member('mem_admin', 'admin');
    const attached = await r.attach(admin, { once: false, stopping });
    if (!reported) throw new Error(reportOf('the worker reported no models', attached, r.sent.map((s) => s.path)));
    const rows = r.e.sqlite.query(`SELECT harness, catalog FROM worker_model_catalogs`).all() as Array<{ harness: string; catalog: string }>;
    // `default` is no model id Claude Code's settings accept, so it is not offered.
    expect(rows.map((row) => ({ harness: row.harness, models: JSON.parse(row.catalog).models }))).toEqual([{ harness: 'claude-code', models: [
      { id: 'sonnet', label: 'Sonnet 5.5', resolvesTo: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'] },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    ] }]);

    listing = false;
    r.queueRun('run_alias');
    expect(await r.attach(admin)).toMatchObject({ driven: 1, refused: null });
    const stored = r.e.sqlite.query(`SELECT execution_overrides, usage_data FROM agent_runs WHERE id = 'run_alias'`).get() as { execution_overrides: string; usage_data: string };
    expect(JSON.parse(stored.execution_overrides).requested).toMatchObject({ model: 'sonnet', resolvesTo: 'claude-sonnet-5-5' });
    const identity = JSON.parse(stored.usage_data).identity as { primary: { model: string }; warnings?: string[] };
    expect({ model: identity.primary.model, mismatch: (identity.warnings ?? []).includes('model_mismatch') }).toEqual({ model: 'claude-sonnet-5-5', mismatch: false });
    r.e.sqlite.close();
  }, 30_000);

  it('neither lists nor reports models to a Deployment that does not advertise storing them, and still claims', async () => {
    const evidence = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-unlisted-')));
    const listedFile = join(evidence, 'listed');
    expect(stubProfileHarness({ listedFile })).toEqual(PROFILE_STUB_DETECTED);
    const stopping = new AbortController();
    const r = await rig((path, n) => {
      if (path === '/members/status') {
        if (n >= 6) stopping.abort();
        return Response.json({ persisted: true }, { headers: { 'x-myco-protocol': '1', 'x-myco-features': 'turn,worker-accounting-v1,execution-profile,profile-outcome-v1' } });
      }
      return null;
    });
    const admin = await r.member('mem_admin', 'admin');
    r.queueRun('run_older_deployment');
    const attached = await r.attach(admin, { once: false, stopping });
    expect(attached).toMatchObject({ driven: 1, refused: null });
    expect(r.sent.filter((sent) => sent.path === '/members/status').length).toBeGreaterThanOrEqual(5);
    expect(r.sent.filter((sent) => sent.path === '/worker/models')).toEqual([]);
    expect(existsSync(listedFile)).toBe(false);
    expect(r.e.sqlite.query(`SELECT COUNT(*) AS n FROM worker_model_catalogs`).get()).toEqual({ n: 0 });
    r.e.sqlite.close();
  }, 30_000);

  it('advertises storing model lists, so a worker reports them', async () => {
    const r = await rig();
    const admin = await r.member('mem_admin', 'admin');
    const response = await workerServer.fetch(new Request('https://s/members/status', {
      method: 'POST', headers: { authorization: `Bearer ${admin}`, 'cf-connecting-ip': '1.2.3.4', 'x-myco-protocol': '1', 'content-type': 'application/json' }, body: '{}',
    }), r.e.env);
    expect(response.headers.get('x-myco-features')?.split(',')).toContain(MODEL_CATALOG_FEATURE);
  });

});
