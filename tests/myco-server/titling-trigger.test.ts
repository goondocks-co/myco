/**
 * The events route schedules a title past its answer for exactly the ends it
 * projects: a start, a replayed end and a conflicting end leave nothing behind.
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
    expect((e.sqlite.query(`SELECT titled_at FROM sessions WHERE session_id = 'sess_1'`).get() as { titled_at: number | null }).titled_at).not.toBeNull();

    expect((await post({ eventId: uuid(4), kind: 'session.end', createdAt: 6_000, payload: { endedAt: 6_000 } })).projected).toBe(true);
    expect(e.deferred.pending).toHaveLength(2);
    await e.deferred.settle();
  });
});
