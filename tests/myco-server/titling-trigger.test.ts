/**
 * A projected session end records a title request and dispatches nothing as it
 * arrives: the end hook sends the transcript bytes the end closes after it. The
 * wake cycle dispatches the request once the session has sent nothing for the
 * settle window and every byte it holds is read, queueing a `title-summary` run
 * for a worker that calls back to the Deployment's origin.
 */
import { backfillTitles, OWNER_TITLING_WINDOW_MS, TITLING_RUN_TIMEOUT_SECONDS, titleReadySessions } from '@myco-server-worker/core/titling.js';
import { SESSION_END_SETTLE_MS } from '@myco-server-worker/constants.js';
import { longestDeclaredHookTimeoutMs } from '@myco/member/budget.js';
import { POWER_THRESHOLDS, runTick, WAKE_INTERVALS } from '@myco-server-worker/core/tick.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { envelope, memberPost, sqliteEnv, uuid } from './helpers/fixtures.js';

describe('the events route', () => {
  it('waits for an ended session to settle longer than any member hook may run, so the end hook has sent every byte it sends', () => {
    expect(SESSION_END_SETTLE_MS).toBeGreaterThan(longestDeclaredHookTimeoutMs());
  });

  it('retries a failed automatic title through the paced convergence, after parsing, past the run window and after every title run of the session closes', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const post = async (over: Record<string, unknown>) => (await worker.fetch(memberPost(t.token, envelope(over)), e.env, e.deferred)).json();
    await post({ eventId: uuid(1), kind: 'prompt', payload: { promptId: uuid(20), text: 'first turn', origin: 'user' } });
    e.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, parsed_offset, first_received_at, last_received_at, token_id)
      VALUES ('proj_1', 'tx', 'sess_1', 'machine_1', 100, 100, 1, 2, ?)`, [t.tokenId]);
    await post({ eventId: uuid(2), kind: 'session.end', payload: { endedAt: 5_000 } });
    await e.deferred.settle();
    e.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.tasks', ?, 1, 'mem_1')`, [JSON.stringify({ 'title-summary': { schedule: { intervalSeconds: 0 } } })]);
    const env = { ...serverEnvFromBindings(e.env), origin: 'https://s' };
    const received = (e.sqlite.query(`SELECT last_received_at AS at FROM sessions WHERE session_id = 'sess_1'`).get() as { at: number }).at;
    expect(await titleReadySessions(env, received + SESSION_END_SETTLE_MS)).toBe(1);
    const first = e.sqlite.query(`SELECT id, queued_at FROM agent_runs`).get() as { id: string; queued_at: number };
    const later = first.queued_at + OWNER_TITLING_WINDOW_MS + 1_000;
    // The run still waits: nothing retries it.
    expect(await backfillTitles(env, later, 'idle')).toBe(0);
    e.sqlite.run(`UPDATE agent_runs SET status = 'failed', completed_at = ? WHERE id = ?`, [later, first.id]);
    // A request's first attempt is spent, so the end-request job never takes it again.
    expect(await titleReadySessions(env, later + 1)).toBe(0);
    // Late bytes unparsed hold the retry; inside the run window it is held too.
    e.sqlite.run(`UPDATE transcripts SET size = 200, last_received_at = ? WHERE transcript_id = 'tx'`, [later]);
    expect(await backfillTitles(env, later + 1, 'idle')).toBe(0);
    e.sqlite.run(`UPDATE transcripts SET parsed_offset = size WHERE transcript_id = 'tx'`);
    expect(await backfillTitles(env, first.queued_at + 1, 'idle')).toBe(0);
    // An owner's attempt in flight holds it.
    e.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, run_context)
      SELECT project_id, 'owner-attempt', agent_id, task, 'queued', ?, json_set(run_context, '$.mode', 'owner') FROM agent_runs WHERE id = ?`, [later + 1, first.id]);
    expect(await backfillTitles(env, later + 2, 'idle')).toBe(0);
    e.sqlite.run(`UPDATE agent_runs SET status = 'failed' WHERE id = 'owner-attempt'`);
    // Two wakes at once make one retry.
    expect((await Promise.all([backfillTitles(env, later + 3, 'idle'), backfillTitles(env, later + 3, 'idle')])).sort()).toEqual([0, 1]);
    expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM agent_runs WHERE id != 'owner-attempt'`).get()).toEqual({ n: 2 });
    // Never over a title that stands.
    e.sqlite.run(`UPDATE agent_runs SET status = 'failed', completed_at = ? WHERE status = 'queued'`, [later + 4]);
    e.sqlite.run(`UPDATE sessions SET title = 'A title already written', summary = 'Keep this result' WHERE session_id = 'sess_1'`);
    expect(await backfillTitles(env, later + 2 * OWNER_TITLING_WINDOW_MS, 'idle')).toBe(0);
  });

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
    const settled = Date.now() + SESSION_END_SETTLE_MS;
    expect(await titleReadySessions({ ...serverEnvFromBindings(e.env), origin: 'https://s' }, settled)).toBe(1);
    expect(await titleReadySessions({ ...serverEnvFromBindings(e.env), origin: 'https://s' }, settled)).toBe(0);
    expect(e.sqlite.query(`SELECT count(*) AS n FROM agent_runs`).get()).toEqual({ n: 1 });
    await post({ eventId: uuid(4), sessionId: 'imported', kind: 'session.end', channel: 'import', payload: { endedAt: 5_000 } });
    expect(e.sqlite.query(`SELECT titling_requested_at FROM sessions WHERE session_id = 'imported'`).get()).toEqual({ titling_requested_at: null });
  });

  it('dispatches no title as an end arrives, and one for its request once the session has settled, whatever a replay or a conflicting end sends', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const post = async (over: Record<string, unknown>) => (await worker.fetch(memberPost(t.token, envelope(over)), e.env, e.deferred)).json() as Promise<Record<string, unknown>>;
    const env = { ...serverEnvFromBindings(e.env), origin: 'https://s' };

    expect((await post({ eventId: uuid(1), kind: 'session.start', payload: { agent: 'claude-code', startedAt: 1_000 } })).persisted).toBe(true);
    expect((await post({ eventId: uuid(2), kind: 'prompt', payload: { promptId: uuid(20), text: 'hi', origin: 'user' } })).persisted).toBe(true);
    expect(await post({ eventId: uuid(3), kind: 'session.end', createdAt: 5_000, payload: { endedAt: 5_000 } })).toEqual({ persisted: true, projected: true });
    expect(await post({ eventId: uuid(3), kind: 'session.end', createdAt: 5_000, payload: { endedAt: 5_000 } })).toEqual({ persisted: true, duplicate: true });
    expect((await post({ eventId: uuid(3), kind: 'session.end', createdAt: 5_000, payload: { endedAt: 5_500 } })).code).toBe('event_id_conflict');
    // The one end that projected leaves a wake behind and no dispatch; a replay and a conflicting end leave nothing.
    expect(e.deferred.pending).toHaveLength(1);
    await e.deferred.settle();
    expect(e.sqlite.query(`SELECT count(*) AS n FROM agent_runs`).get()).toEqual({ n: 0 });
    const received = (e.sqlite.query(`SELECT last_received_at AS at FROM sessions WHERE session_id = 'sess_1'`).get() as { at: number }).at;
    expect(e.sqlite.query(`SELECT titled_at FROM sessions WHERE session_id = 'sess_1'`).get()).toEqual({ titled_at: null });

    expect(await titleReadySessions(env, received + SESSION_END_SETTLE_MS - 1)).toBe(0);
    expect(await titleReadySessions(env, received + SESSION_END_SETTLE_MS)).toBe(1);
    expect(await titleReadySessions(env, received + SESSION_END_SETTLE_MS + 1)).toBe(0);
    expect(e.sqlite.query(`SELECT status, task, held_by FROM agent_runs`).all()).toEqual([{ status: 'queued', task: 'title-summary', held_by: 'worker' }]);
  });

  it('wakes the clock when a live end asks for a title, so a Deployment asleep takes it on the active cadence once settled, not at its floor', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    let wakes = 0;
    const clock = { idFromName: (name: string) => name, get: () => ({ ensure: async () => { wakes += 1; } }) };
    const bound = { ...e.env, CLOCK: clock };
    const post = async (over: Record<string, unknown>) => (await worker.fetch(memberPost(t.token, envelope(over)), bound, e.deferred)).json() as Promise<Record<string, unknown>>;
    const env = { ...serverEnvFromBindings(bound), origin: 'https://s' };
    const titleRuns = (): unknown => e.sqlite.query(`SELECT count(*) AS n FROM agent_runs WHERE task = 'title-summary'`).get();

    await post({ eventId: uuid(1), kind: 'prompt', payload: { promptId: uuid(20), text: 'long ago', origin: 'user' } });
    await e.deferred.settle();
    // The quiet session stays short of idle, so the live end below is the only ask for a title.
    e.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.titling_idle_close_minutes', '10080', 1, 'mem_1')`);
    e.sqlite.run(`UPDATE sessions SET last_received_at = last_received_at - ?`, [2 * POWER_THRESHOLDS.deepSleepMs]);
    e.sqlite.run(`DELETE FROM schema_meta WHERE key = 'last_request_at'`);
    await runTick(env, Date.now());
    const asleep = await runTick(env, Date.now());
    expect({ state: asleep.state, next: asleep.nextWakeMs }).toEqual({ state: 'deep_sleep', next: null });
    const before = wakes;

    // An import's end asks for no title and wakes nothing; a live end wakes the clock.
    await post({ eventId: uuid(2), sessionId: 'imported', kind: 'session.end', channel: 'import', payload: { endedAt: 5_000 } });
    await e.deferred.settle();
    expect(wakes).toBe(before);
    await post({ eventId: uuid(3), kind: 'session.end', payload: { endedAt: 5_000 } });
    await e.deferred.settle();
    expect(wakes).toBe(before + 1);

    // The wake it asked for runs inside the settle window: nothing is dispatched, and it asks for the next wake on the active cadence.
    const woken = Date.now();
    const first = await runTick(env, woken);
    expect({ state: first.state, next: first.nextWakeMs, runs: titleRuns() }).toEqual({ state: 'active', next: WAKE_INTERVALS.activeMs, runs: { n: 0 } });
    expect(WAKE_INTERVALS.activeMs).toBeGreaterThan(SESSION_END_SETTLE_MS);
    // That next wake finds the session settled and dispatches its title.
    await runTick(env, woken + WAKE_INTERVALS.activeMs);
    expect(titleRuns()).toEqual({ n: 1 });
  });

  it('holds an end\'s title while the transcript bytes its end hook sends after the end are still arriving or unread', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const post = async (over: Record<string, unknown>) => (await worker.fetch(memberPost(t.token, envelope(over)), e.env, e.deferred)).json() as Promise<Record<string, unknown>>;
    const env = { ...serverEnvFromBindings(e.env), origin: 'https://s' };
    const receivedAt = (): number => (e.sqlite.query(`SELECT last_received_at AS at FROM sessions WHERE session_id = 'sess_1'`).get() as { at: number }).at;

    await post({ eventId: uuid(1), kind: 'prompt', payload: { promptId: uuid(20), text: 'first turn', origin: 'user' } });
    e.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, parsed_offset, first_received_at, last_received_at, token_id)
      VALUES ('proj_1', 'tx', 'sess_1', 'machine_1', 100, 100, 1, 2, ?)`, [t.tokenId]);
    // The end lands with every byte received so far read: the material reads as ready at this instant.
    await post({ eventId: uuid(2), kind: 'session.end', payload: { endedAt: 5_000 } });
    await e.deferred.settle();
    expect(e.sqlite.query(`SELECT count(*) AS n FROM agent_runs`).get()).toEqual({ n: 0 });
    const end = receivedAt();
    // The end hook then sends the transcript's tail, a moment after the end.
    const tail = end + 1_000;
    e.sqlite.run(`UPDATE sessions SET last_received_at = ? WHERE session_id = 'sess_1'`, [tail]);
    e.sqlite.run(`UPDATE transcripts SET size = 200, last_received_at = ? WHERE transcript_id = 'tx'`, [tail]);
    expect(await titleReadySessions(env, end + SESSION_END_SETTLE_MS)).toBe(0);
    // Settled but unread: still held.
    expect(await titleReadySessions(env, tail + SESSION_END_SETTLE_MS)).toBe(0);
    e.sqlite.run(`UPDATE transcripts SET parsed_offset = size WHERE transcript_id = 'tx'`);
    expect(await titleReadySessions(env, tail + SESSION_END_SETTLE_MS)).toBe(1);
  });

  it('queues the settled request\'s title for a worker, calling back to the Deployment\'s origin, and launches nothing even with a runtime bound', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const launches: Array<{ runId: string; timeoutSeconds: number; envVars: Record<string, string> }> = [];
    const bound = { ...e.env, HARNESS: { idFromName: (name: string) => ({ name }), get: () => ({ launch: async (spec: never) => { launches.push(spec); } }) } };
    const post = async (over: Record<string, unknown>) => (await worker.fetch(memberPost(t.token, envelope(over)), bound, e.deferred)).json() as Promise<Record<string, unknown>>;
    const env = { ...serverEnvFromBindings(bound), origin: 'https://s' };

    expect((await post({ eventId: uuid(1), kind: 'session.start', payload: { agent: 'claude-code', startedAt: 1_000 } })).persisted).toBe(true);
    expect((await post({ eventId: uuid(2), kind: 'prompt', payload: { promptId: uuid(20), text: 'hi', origin: 'user' } })).persisted).toBe(true);
    expect(await post({ eventId: uuid(3), kind: 'session.end', createdAt: 5_000, payload: { endedAt: 5_000 } })).toEqual({ persisted: true, projected: true });
    await e.deferred.settle();
    const settled = (e.sqlite.query(`SELECT last_received_at AS at FROM sessions WHERE session_id = 'sess_1'`).get() as { at: number }).at + SESSION_END_SETTLE_MS;
    expect(await titleReadySessions(env, settled)).toBe(1);
    // A bound runtime serves three tasks and titling is not one of them: the
    // run waits for a worker, and the Deployment's origin rides the row so a
    // worker calls back to it.
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
    expect(await titleReadySessions(env, settled + 2 * SESSION_END_SETTLE_MS)).toBe(0);
    expect(launches).toHaveLength(0);
    expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM agent_runs`).get()).toEqual({ n: 1 });
  });
});
