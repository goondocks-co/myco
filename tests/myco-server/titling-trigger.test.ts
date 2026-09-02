/**
 * The events route schedules a title past its answer for exactly the ends it
 * projects: a start, a replayed end and a conflicting end leave nothing behind.
 * The deferred work is a dispatch: with no runtime bound it stamps nothing, and
 * with one bound it launches a `title-summary` run for the ended session,
 * calling back to the request's own origin.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { envelope, memberPost, sqliteEnv, uuid } from './helpers/fixtures.js';

describe('the events route', () => {
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
    // No runtime is bound: the attempt is answered by name and the session keeps its claim.
    expect((e.sqlite.query(`SELECT titled_at FROM sessions WHERE session_id = 'sess_1'`).get() as { titled_at: number | null }).titled_at).toBeNull();

    expect((await post({ eventId: uuid(4), kind: 'session.end', createdAt: 6_000, payload: { endedAt: 6_000 } })).projected).toBe(true);
    expect(e.deferred.pending).toHaveLength(2);
    await e.deferred.settle();
  });

  it('launches one titling run for an ended session when a runtime is bound, calling back to the request\'s own origin', async () => {
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
    expect(launches).toHaveLength(1);
    const vars = launches[0]!.envVars;
    expect({ task: vars.MYCO_TASK, url: vars.MYCO_SERVER_URL, admission: vars.MYCO_TASK_ADMISSION, params: JSON.parse(vars.MYCO_TASK_PARAMS!) })
      .toEqual({ task: 'title-summary', url: 'https://s', admission: 'captureDriven', params: { session_id: 'sess_1', mode: 'claim' } });
    expect((e.sqlite.query(`SELECT titled_at FROM sessions WHERE session_id = 'sess_1'`).get() as { titled_at: number | null }).titled_at).not.toBeNull();
    // A second end of the same session finds the claim spent and launches nothing.
    expect((await post({ eventId: uuid(4), kind: 'session.end', createdAt: 6_000, payload: { endedAt: 6_000 } })).projected).toBe(true);
    await e.deferred.settle();
    expect(launches).toHaveLength(1);
  });
});
