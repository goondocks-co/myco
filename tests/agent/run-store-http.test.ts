/**
 * The HTTP `RunStore`, driven against the real server.
 *
 * The client's `fetch` is wired straight to the worker's entry, so these
 * exercise the actual routes, the actual pipeline and the actual store rather
 * than a mock of them. A mocked server would let the adapter and the routes
 * drift apart while both stayed green, which is the divergence this whole port
 * exists to make impossible.
 */
import { describe, expect, it } from 'bun:test';
import { createHttpRunStore, NoProviderConfiguredError, ProjectNotAdmittedError, RunControlError, HTTP_MUTATE_ATTEMPTS, type RunClaimAdmission } from '@myco/agent/runtime/run-store-http.js';
import { ServerClient } from '@myco/member/transport.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import worker from '@myco-server-worker/index.js';

const PROJECT = 'proj_1';
const AGENT = 'agent_1';
const BUDGET = { connectTimeoutMs: 2000, requestTimeoutMs: 4000 };

async function harness(opts: { admit?: boolean; admission?: RunClaimAdmission; provider?: string } = {}) {
  const { env, db, sqlite } = sqliteEnv();
  const now = Date.now();
  sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(PROJECT, PROJECT, now);
  sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, now);
  if (opts.admit !== false) {
    sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (?, 'cortex', 1, ?, 'test')`).run(PROJECT, now);
  }
  if (opts.provider !== undefined) {
    sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.provider.type', ?, ?, 'test')`).run(JSON.stringify(opts.provider), now);
  }
  const token = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);

  // The client's transport IS the worker: no mock between them.
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const headers = new Headers(req.headers);
    headers.set('cf-connecting-ip', '1.2.3.4');
    return worker.fetch(new Request(req.url, { method: req.method, headers, body: req.body ? await req.text() : undefined }), env);
  };
  const client = new ServerClient({ serverUrl: 'https://s', token: token.token, projectId: PROJECT }, fetchImpl as never);
  const store = createHttpRunStore({ client, agentId: AGENT, admissionForTask: () => opts.admission ?? { capability: 'cortex' }, budget: BUDGET });
  return { store, sqlite, token };
}

/** No `started_at`: the server stamps it from its own clock, which is the only clock the guard compares against. */
const insert = (id: string, task: string) => ({ id, agent_id: AGENT, task });

describe('HTTP RunStore — claim', () => {
  it('claims through the real routes: a second run of the task claims too, and the same id claimed twice is refused', async () => {
    const { store, sqlite } = await harness();
    expect(await store.claimRun(insert('r1', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 })).toEqual({ claimed: true });
    expect(await store.claimRun(insert('r2', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 })).toEqual({ claimed: true });
    const again = await store.claimRun(insert('r1', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 });
    expect(again.claimed).toBe(false);
    expect(again.claimed === false && again.running.id).toBe('r1');
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs`).get() as { c: number }).c).toBe(2);
  });

  it('serves no running-run read: the claim guards the id alone, and the port method throws by name', async () => {
    const { store } = await harness();
    await expect(store.getRunningRunForTask('digest', 60)).rejects.toBeInstanceOf(RunControlError);
  });

  it('claims a capture-driven task on the provider gate alone, carrying the run context, and throws by name when no provider is configured', async () => {
    const provided = await harness({ admit: false, admission: { captureDriven: true }, provider: 'anthropic' });
    const context = JSON.stringify({ session_id: 'sess_1', mode: 'claim' });
    expect(await provided.store.claimRun({ ...insert('r1', 'title-summary'), run_context: context }, { taskName: 'title-summary', maxAgeSeconds: 0 })).toEqual({ claimed: true });
    expect(provided.sqlite.query(`SELECT run_context c FROM agent_runs WHERE id = 'r1'`).get()).toEqual({ c: context });

    const unprovided = await harness({ admit: false, admission: { captureDriven: true } });
    await expect(unprovided.store.claimRun(insert('r1', 'title-summary'), { taskName: 'title-summary', maxAgeSeconds: 0 }))
      .rejects.toBeInstanceOf(NoProviderConfiguredError);
  });

  it('throws on a Project the Deployment has not admitted, rather than reporting contention', async () => {
    const { store } = await harness({ admit: false });
    await expect(store.claimRun(insert('r1', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 }))
      .rejects.toBeInstanceOf(ProjectNotAdmittedError);
  });
});

describe('HTTP RunStore — state', () => {
  it('carries an atomic read-modify-write over the wire', async () => {
    const { store } = await harness();
    const append = (entry: string) => (current: string | null): string =>
      JSON.stringify([...(current ? (JSON.parse(current) as string[]) : []), entry]);

    await store.mutateState('decisions', append('phase-a'), PROJECT);
    await store.mutateState('decisions', append('phase-b'), PROJECT);
    expect(JSON.parse((await store.getState('decisions', PROJECT))!.value)).toEqual(['phase-a', 'phase-b']);
  });

  it('keeps both concurrent appends, retrying the loser from its own read', async () => {
    const { store } = await harness();
    const append = (entry: string) => (current: string | null): string =>
      JSON.stringify([...(current ? (JSON.parse(current) as string[]) : []), entry]);
    await store.mutateState('decisions', () => JSON.stringify(['seed']), PROJECT);

    await Promise.all([
      store.mutateState('decisions', append('phase-a'), PROJECT),
      store.mutateState('decisions', append('phase-b'), PROJECT),
    ]);
    expect(JSON.parse((await store.getState('decisions', PROJECT))!.value).sort()).toEqual(['phase-a', 'phase-b', 'seed']);
  });

  it('reports contention rather than a write that did not land, once attempts are spent', async () => {
    const { store, sqlite } = await harness();
    await store.mutateState('k', () => 'v0', PROJECT);
    let calls = 0;
    // Another writer moves the value between this caller's read and its write,
    // every round. Written straight to the store so the move is synchronous and
    // the race is deterministic rather than a matter of scheduling.
    await expect(store.mutateState('k', (current) => {
      calls += 1;
      sqlite.query(`UPDATE agent_state SET value = ? WHERE project_id = ? AND key = 'k'`).run(`moved-${calls}`, PROJECT);
      return `${current}!`;
    }, PROJECT)).rejects.toBeInstanceOf(RunControlError);
    expect(calls).toBe(HTTP_MUTATE_ATTEMPTS);
  });

  it('answers an unset key as absent rather than an empty value', async () => {
    const { store } = await harness();
    expect(await store.getState('never-written', PROJECT)).toBeNull();
  });
});

describe('HTTP RunStore — lifecycle', () => {
  it('updates a run and reads it back', async () => {
    const { store } = await harness();
    await store.claimRun(insert('r1', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 });
    await store.updateRunStatus('r1', 'completed', { completed_at: 42 });
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });

  it('refuses an update that would reattribute a run, and says so', async () => {
    const { store, sqlite, token } = await harness();
    await store.claimRun(insert('r1', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 });
    await expect(store.applyRunUpdate('r1', { status: 'failed', dispatched_by: 'someone' } as never))
      .rejects.toBeInstanceOf(RunControlError);
    const row = sqlite.query(`SELECT dispatched_by AS d, status FROM agent_runs WHERE id = 'r1'`).get() as { d: string; status: string };
    expect(row).toEqual({ d: token.tokenId, status: 'running' });
  });

  it('records a run event against a claimed run, and an unknown run records nothing without failing the run', async () => {
    const { store, sqlite } = await harness();
    await store.claimRun(insert('r1', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 });
    await store.recordRunEvent({ runId: 'r1', eventType: 'phase_start', phaseName: 'p1' });
    await store.recordRunEvent({ runId: 'r_unknown', eventType: 'phase_end' });
    const rows = sqlite.query(`SELECT run_id AS r, event_type AS e FROM agent_run_events ORDER BY id`).all() as Array<{ r: string; e: string }>;
    expect(rows).toEqual([{ r: 'r1', e: 'phase_start' }]);
  });

  it('answers admission for the capability the task needs', async () => {
    const admitted = await harness();
    expect(await admitted.store.admitProject(PROJECT)).toEqual({ admitted: true });
    const refused = await harness({ admit: false });
    expect((await refused.store.admitProject(PROJECT)).admitted).toBe(false);
  });
});
