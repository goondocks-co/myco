/**
 * The events route schedules a title past its answer for exactly the ends it
 * projects: a start, a replayed end and a conflicting end leave nothing behind.
 * The deferred work is a dispatch: with no runtime bound it stamps nothing, and
 * with one bound it launches a `title-summary` run for the ended session,
 * calling back to the request's own origin.
 */
import { TITLING_RUN_TIMEOUT_SECONDS } from '@myco-server-worker/core/titling.js';
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

  it('dispatches one titling run for an ended session, and the session\'s second end dispatches nothing', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    e.sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.provider.type', '"openai-compatible"', 1, 'test'), ('agent.provider.base_url', '"http://models.internal/v1"', 1, 'test')`).run();
    const bound = { ...e.env, HARNESS_LAUNCH_MODE: 'record' };
    const post = async (over: Record<string, unknown>) => (await worker.fetch(memberPost(t.token, envelope(over)), bound, e.deferred)).json() as Promise<Record<string, unknown>>;

    expect((await post({ eventId: uuid(1), kind: 'session.start', payload: { agent: 'claude-code', startedAt: 1_000 } })).persisted).toBe(true);
    expect((await post({ eventId: uuid(2), kind: 'prompt', payload: { promptId: uuid(20), text: 'hi', origin: 'user' } })).persisted).toBe(true);
    expect(await post({ eventId: uuid(3), kind: 'session.end', createdAt: 5_000, payload: { endedAt: 5_000 } })).toEqual({ persisted: true, projected: true });
    await e.deferred.settle();
    // The recorder marks the row it took, so the dispatch is read where it lands
    // rather than from a runtime the entry cannot be given. The environment a
    // dispatch carries is asserted against the dispatcher itself in titling.test.ts.
    const runs = () => e.sqlite.query(`SELECT status, task, harness, run_context AS runContext FROM agent_runs`).all() as Array<Record<string, unknown>>;
    expect(runs()).toEqual([{
      status: 'pending', task: 'title-summary', harness: 'record',
      runContext: JSON.stringify({ session_id: 'sess_1', mode: 'claim', timeoutSeconds: TITLING_RUN_TIMEOUT_SECONDS }),
    }]);
    expect((e.sqlite.query(`SELECT titled_at FROM sessions WHERE session_id = 'sess_1'`).get() as { titled_at: number | null }).titled_at).not.toBeNull();
    // A second end of the same session finds the claim spent and dispatches nothing.
    expect((await post({ eventId: uuid(4), kind: 'session.end', createdAt: 6_000, payload: { endedAt: 6_000 } })).projected).toBe(true);
    await e.deferred.settle();
    expect(runs()).toHaveLength(1);
  });
});
