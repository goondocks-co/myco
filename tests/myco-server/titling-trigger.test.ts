/**
 * The events route schedules a title past its answer for exactly the ends it
 * projects: a start, a replayed end and a conflicting end leave nothing behind.
 * The deferred work is a dispatch: with no runtime bound it stamps nothing, and
 * with one bound it launches a `title-summary` run for the ended session,
 * calling back to the request's own origin.
 */
import { TITLING_RUN_TIMEOUT_SECONDS, titleReadySessions } from '@myco-server-worker/core/titling.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { envelope, memberPost, sqliteEnv, uuid } from './helpers/fixtures.js';

describe('the events route', () => {
  it('persists a deferred title with the admitted live end and retries after parsing, while import creates no request', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const post = async (over: Record<string, unknown>) => (await worker.fetch(memberPost(t.token, envelope(over)), e.env, e.deferred)).json() as Promise<Record<string, unknown>>;
    await post({ eventId: uuid(1), kind: 'prompt', payload: { promptId: uuid(20), text: 'first turn', origin: 'user' } });
    e.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, parsed_offset, first_received_at, last_received_at, token_id)
      VALUES ('proj_1', 'tx', 'sess_1', 'machine_1', 200, 100, 1, 2, ?)`, [t.tokenId]);
    expect(await post({ eventId: uuid(2), kind: 'session.end', payload: { endedAt: 5_000 } })).toEqual({ persisted: true, projected: true });
    const pending = () => e.sqlite.query(`SELECT titling_requested_at, titled_at FROM sessions WHERE session_id = 'sess_1'`).get() as { titling_requested_at: number | null; titled_at: number | null };
    expect(pending().titling_requested_at).not.toBeNull();
    await e.deferred.settle();
    expect(pending().titled_at).toBeNull();
    expect(e.sqlite.query(`SELECT count(*) AS n FROM agent_runs`).get()).toEqual({ n: 0 });
    await post({ eventId: uuid(3), kind: 'prompt', payload: { promptId: uuid(21), text: 'second turn', origin: 'user' } });
    e.sqlite.run(`UPDATE transcripts SET parsed_offset = size WHERE transcript_id = 'tx'`);
    expect(await titleReadySessions({ ...serverEnvFromBindings(e.env), origin: 'https://s' }, Date.now())).toBe(1);
    expect(await titleReadySessions({ ...serverEnvFromBindings(e.env), origin: 'https://s' }, Date.now())).toBe(0);
    expect(e.sqlite.query(`SELECT count(*) AS n FROM agent_runs`).get()).toEqual({ n: 1 });
    await post({ eventId: uuid(4), sessionId: 'imported', kind: 'session.end', channel: 'import', payload: { endedAt: 5_000 } });
    expect(e.sqlite.query(`SELECT titling_requested_at FROM sessions WHERE session_id = 'imported'`).get()).toEqual({ titling_requested_at: null });
  });

  it('defers one titling for a projected session end, and none for a start, a replay, or a conflicting end', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const post = async (over: Record<string, unknown>) => (await worker.fetch(memberPost(t.token, envelope(over)), e.env, e.deferred)).json() as Promise<Record<string, unknown>>;

    expect((await post({ eventId: uuid(1), kind: 'session.start', payload: { agent: 'claude-code', startedAt: 1_000 } })).persisted).toBe(true);
    expect(e.deferred.pending).toHaveLength(0);
    expect((await post({ eventId: uuid(2), kind: 'prompt', payload: { promptId: uuid(20), text: 'hi', origin: 'user' } })).persisted).toBe(true);
    expect(e.deferred.pending).toHaveLength(0);

    expect(await post({ eventId: uuid(3), kind: 'session.end', createdAt: 5_000, payload: { endedAt: 5_000 } })).toEqual({ persisted: true, projected: true });
    expect(e.deferred.pending).toHaveLength(1);
    expect(await post({ eventId: uuid(3), kind: 'session.end', createdAt: 5_000, payload: { endedAt: 5_000 } })).toEqual({ persisted: true, duplicate: true });
    expect(e.deferred.pending).toHaveLength(1);
    expect((await post({ eventId: uuid(3), kind: 'session.end', createdAt: 5_000, payload: { endedAt: 5_500 } })).code).toBe('event_id_conflict');
    expect(e.deferred.pending).toHaveLength(1);
    await e.deferred.settle();
    // Titling runs on a worker, so a Deployment with no runtime bound still
    // schedules it: the claim is spent and the run waits to be claimed.
    expect((e.sqlite.query(`SELECT titled_at FROM sessions WHERE session_id = 'sess_1'`).get() as { titled_at: number | null }).titled_at).not.toBeNull();
    expect(e.sqlite.query(`SELECT status, task, held_by FROM agent_runs`).all()).toEqual([{ status: 'queued', task: 'title-summary', held_by: 'worker' }]);

    expect((await post({ eventId: uuid(4), kind: 'session.end', createdAt: 6_000, payload: { endedAt: 6_000 } })).projected).toBe(true);
    expect(e.deferred.pending).toHaveLength(2);
    await e.deferred.settle();
  });

  it('queues one titling run for an ended session, carrying the request\'s own origin, and launches nothing even with a runtime bound', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    e.sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.provider.type', '"openai-compatible"', 1, 'test'), ('agent.provider.base_url', '"http://models.internal/v1"', 1, 'test')`).run();
    const launches: Array<{ runId: string; timeoutSeconds: number; envVars: Record<string, string> }> = [];
    const bound = { ...e.env, HARNESS: { idFromName: (name: string) => ({ name }), get: () => ({ launch: async (spec: never) => { launches.push(spec); } }) } };
    const post = async (over: Record<string, unknown>) => (await worker.fetch(memberPost(t.token, envelope(over)), bound, e.deferred)).json() as Promise<Record<string, unknown>>;

    expect((await post({ eventId: uuid(1), kind: 'session.start', payload: { agent: 'claude-code', startedAt: 1_000 } })).persisted).toBe(true);
    expect((await post({ eventId: uuid(2), kind: 'prompt', payload: { promptId: uuid(20), text: 'hi', origin: 'user' } })).persisted).toBe(true);
    expect(await post({ eventId: uuid(3), kind: 'session.end', createdAt: 5_000, payload: { endedAt: 5_000 } })).toEqual({ persisted: true, projected: true });
    await e.deferred.settle();
    // A bound runtime serves three tasks and titling is not one of them: the
    // run waits for a worker, and the origin the request arrived on rides the
    // row so a worker calls back to the Deployment that asked.
    expect(launches).toHaveLength(0);
    expect((e.sqlite.query(`SELECT titled_at FROM sessions WHERE session_id = 'sess_1'`).get() as { titled_at: number | null }).titled_at).not.toBeNull();
    const row = e.sqlite.query(`SELECT id, status, task, held_by, dispatched_by, run_context, dispatch_spec FROM agent_runs`).all() as Array<Record<string, unknown>>;
    expect(row).toHaveLength(1);
    expect({ status: row[0]!.status, task: row[0]!.task, held_by: row[0]!.held_by, dispatched_by: row[0]!.dispatched_by })
      .toEqual({ status: 'queued', task: 'title-summary', held_by: 'worker', dispatched_by: null });
    expect(JSON.parse(String(row[0]!.run_context)))
      .toEqual({ session_id: 'sess_1', mode: 'claim', timeoutSeconds: TITLING_RUN_TIMEOUT_SECONDS });
    expect(JSON.parse(String(row[0]!.dispatch_spec)))
      .toEqual({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: TITLING_RUN_TIMEOUT_SECONDS, params: { session_id: 'sess_1', mode: 'claim' } });
    // A second end of the same session finds the claim spent and queues nothing.
    expect((await post({ eventId: uuid(4), kind: 'session.end', createdAt: 6_000, payload: { endedAt: 6_000 } })).projected).toBe(true);
    await e.deferred.settle();
    expect(launches).toHaveLength(0);
    expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM agent_runs`).get()).toEqual({ n: 1 });
  });
});
