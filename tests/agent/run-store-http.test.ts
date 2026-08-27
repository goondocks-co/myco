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
import { createHttpRunStore, ProjectNotAdmittedError, RunControlError, HTTP_MUTATE_ATTEMPTS } from '@myco/agent/runtime/run-store-http.js';
import { ServerClient } from '@myco/member/transport.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import worker from '@myco-server-worker/index.js';

const PROJECT = 'proj_1';
const AGENT = 'agent_1';
const BUDGET = { connectTimeoutMs: 2000, requestTimeoutMs: 4000 };

async function harness(opts: { admit?: boolean } = {}) {
  const { env, db, sqlite } = sqliteEnv();
  const now = Date.now();
  sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(PROJECT, PROJECT, now);
  sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, now);
  if (opts.admit !== false) {
    sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (?, 'cortex', 1, ?, 'test')`).run(PROJECT, now);
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
  const store = createHttpRunStore({ client, agentId: AGENT, capabilityForTask: () => 'cortex', budget: BUDGET });
  return { store, sqlite, token };
}

/** No `started_at`: the server stamps it from its own clock, which is the only clock the guard compares against. */
const insert = (id: string, task: string) => ({ id, agent_id: AGENT, task });

describe('HTTP RunStore — claim', () => {
  it('claims through the real routes and single-flights the second', async () => {
    const { store, sqlite } = await harness();
    expect(await store.claimRun(insert('r1', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 })).toEqual({ claimed: true });
    const second = await store.claimRun(insert('r2', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 });
    expect(second.claimed).toBe(false);
    expect(second.claimed === false && second.running.id).toBe('r1');
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs`).get() as { c: number }).c).toBe(1);
  });

  /**
   * The guard is expressed in seconds and every server timestamp is milliseconds.
   * Two claims a millisecond apart cannot tell those apart — an unconverted
   * window is still wide enough — so this backdates the run to a minute, which
   * an hour-long window must hold and a 3.6-second one cannot.
   */
  it('holds a run started a minute ago inside an hour-long window', async () => {
    const { store, sqlite } = await harness();
    await store.claimRun(insert('r1', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 });
    sqlite.query(`UPDATE agent_runs SET started_at = ? WHERE id = 'r1'`).run(Date.now() - 60_000);

    const second = await store.claimRun(insert('r2', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 });
    expect(second.claimed).toBe(false);
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs`).get() as { c: number }).c).toBe(1);
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

  it('reports a missing run event surface rather than dropping the event', async () => {
    const { store } = await harness();
    await expect(store.recordRunEvent({ run_id: 'r1', event_type: 'x', recorded_at: 1 } as never))
      .rejects.toBeInstanceOf(RunControlError);
  });

  it('answers admission for the capability the task needs', async () => {
    const admitted = await harness();
    expect(await admitted.store.admitProject(PROJECT)).toEqual({ admitted: true });
    const refused = await harness({ admit: false });
    expect((await refused.store.admitProject(PROJECT)).admitted).toBe(false);
  });
});
