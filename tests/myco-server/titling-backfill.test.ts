/**
 * The bounded backfill of imported sessions: off until an operator
 * turns it on, newest first over untitled imported sessions with parsed
 * material, one `claim` attempt per session through the live titling gate,
 * inside the block's interval and the Deployment-wide daily ceiling, and
 * stoppable through the same override the operator's switch writes.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import type { PreparedStatement, RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import {
  backfillTitles, freshReserve, sessionMaterial, titleReadySessions, titleSession, titlingBackfillPolicy, titlingBackfillProgress, titlingIdleCloseMinutes, TITLING_BACKFILL_ACTOR, TITLING_BACKFILL_BATCH, TITLING_TASK,
} from '@myco-server-worker/core/titling.js';
import { deploymentTaskCeilingWindow } from '@myco-server-worker/core/runs.js';
import { TITLING_BACKFILL_SCHEDULE, SERVER_JOBS } from '@myco-server-worker/core/jobs.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import worker from '@myco-server-worker/index.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { overwriteTitle } from '@myco-server-worker/read/sessions.js';
import { listTitleCandidates, untitledReason, type TitleCandidateWindow } from '@myco-server-worker/read/children.js';
import { count, sqliteEnv, withHarness } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ORIGIN = 'https://s';
const HOUR = 3_600_000;

/** The instants a wake at `now` reads candidates by, under the default idle bound and every imported session admitted. */
const windowAt = (now: number): TitleCandidateWindow => ({
  retryBefore: now - 600_000, idleBefore: now - 2 * HOUR, freshAfter: now - DAY, refreshBefore: now - 4 * HOUR, refreshPrompts: 10, imported: true,
});

function rig() {
  const e = sqliteEnv();
  const launches: Array<{ runId: string }> = [];
  const env: ServerEnv = { ...withHarness(() => e.serverEnv, { launch: async (spec) => { launches.push(spec); } }), origin: ORIGIN, wake: async () => {} };
  const setting = (leaf: string, value: unknown) =>
    e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'mem_1')`, [leaf, JSON.stringify(value), NOW]);
  /** An ended session with one inline user prompt and one transcript; by default imported and parsed. */
  const session = (id: string, over: { project?: string; endedAt?: number; imported?: boolean; parsed?: boolean; title?: string; material?: boolean; transcript?: boolean } = {}) => {
    const project = over.project ?? 'proj_1';
    const endedAt = over.endedAt ?? NOW - 1000;
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at, title)
                  VALUES (?, ?, 'm1', 'tok_1', ?, ?, 'claude-code', ?, ?, ?)`, [project, id, endedAt - 10_000, endedAt, endedAt - 10_000, endedAt, over.title ?? null]);
    if (over.material !== false) {
      e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                    VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, 'tok_1', ?)`, [project, id, `p_${id}`, `e_${id}`, `Please fix the build for ${id}`, `h_${id}`, endedAt - 5000, endedAt - 5000, endedAt - 5000]);
    }
    if (over.transcript !== false) {
      e.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, parsed_offset, first_received_at, last_received_at, token_id, imported_at)
                    VALUES (?, ?, ?, 'm1', 100, ?, ?, ?, 'tok_1', ?)`, [project, `tx_${id}`, id, over.parsed === false ? 40 : 100, endedAt, endedAt, over.imported === false ? null : endedAt]);
    }
  };
  const runs = () => e.sqlite.query(`SELECT id, project_id AS projectId, status, json_extract(run_context, '$.session_id') AS sessionId, json_extract(run_context, '$.mode') AS mode, json_extract(dispatch_spec, '$.actor') AS actor
                                     FROM agent_runs WHERE task = ? ORDER BY COALESCE(queued_at, started_at), id`).all(TITLING_TASK) as Array<{ id: string; projectId: string; status: string; sessionId: string; mode: string; actor: string }>;
  const titledAt = (id: string) => (e.sqlite.query(`SELECT titled_at FROM sessions WHERE session_id = ?`).get(id) as { titled_at: number | null }).titled_at;
  const on = () => { setting('agent.scheduled_tasks_enabled', true); setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true } } }); };
  return { ...e, bindings: e.env, env, launches, setting, session, runs, titledAt, on };
}

describe('the imported-session backfill', () => {
  it('is declared as a job at idle depth, with a block that is off until an operator turns it on', () => {
    expect(SERVER_JOBS.find((j) => j.name === 'titling-backfill')?.runsThrough).toBe('idle');
    expect(TITLING_BACKFILL_SCHEDULE).toEqual({ enabled: false, intervalSeconds: 900, runIn: ['active', 'idle'], overlap: 'queue', maxRunsPerDay: 36 });
  });

  it('dispatches nothing while scheduling is off, or while its own block is off, and leaves no claim behind', async () => {
    const r = rig();
    r.session('s1');
    expect(await titlingBackfillPolicy(r.env)).toEqual({ scheduledTasksEnabled: false, backfillEnabled: false, runsPerDay: 36, intervalSeconds: 900, runIn: ['active', 'idle'], overlap: 'queue', enabled: false });
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(0);
    r.setting('agent.scheduled_tasks_enabled', true);
    expect((await titlingBackfillPolicy(r.env)).enabled).toBe(false);
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(0);
    r.setting('agent.scheduled_tasks_enabled', false);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true } } });
    expect((await titlingBackfillPolicy(r.env)).enabled).toBe(false);
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(0);
    expect(r.runs()).toEqual([]);
    expect(r.titledAt('s1')).toBeNull();
  });

  it('titles untitled imported sessions with parsed material, newest first, as a claim attributed to the backfill; every other session is left alone', async () => {
    const r = rig();
    r.on();
    r.session('older', { endedAt: NOW - 2 * DAY });
    r.session('newest', { endedAt: NOW - 1000 });
    r.session('middle', { endedAt: NOW - 3600_000, project: 'proj_2' });
    r.session('unparsed', { parsed: false });
    r.session('titled', { title: 'Already titled' });
    r.session('silent', { material: false });
    r.session('deleted');
    r.sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES ('proj_1', 'deleted', NULL, ?, 'mem_1')`, [NOW]);

    expect((await listTitleCandidates(r.env.db, windowAt(NOW), 10)).freshClaims.map((c) => c.sessionId)).toEqual(['newest', 'middle']);
    expect((await listTitleCandidates(r.env.db, windowAt(NOW), 10)).backlogClaims.map((c) => c.sessionId)).toEqual(['older']);
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(3);
    expect(r.runs().map((run) => [run.projectId, run.sessionId, run.mode, run.actor]).sort()).toEqual([
      ['proj_1', 'newest', 'claim', TITLING_BACKFILL_ACTOR], ['proj_1', 'older', 'claim', TITLING_BACKFILL_ACTOR], ['proj_2', 'middle', 'claim', TITLING_BACKFILL_ACTOR],
    ]);
    for (const id of ['unparsed', 'titled', 'silent', 'deleted']) expect({ id, titledAt: r.titledAt(id) }).toEqual({ id, titledAt: null });
    // A second wake inside the interval dispatches nothing; one past it finds every candidate already attempted.
    expect(await backfillTitles(r.env, NOW + 1, 'idle')).toBe(0);
    expect(await backfillTitles(r.env, NOW + 901_000, 'idle')).toBe(0);
    expect(r.runs().length).toBe(3);
  });

  it('titles a session its own capture owes a title with scheduled intelligence and the backfill off: a live or transcript-less session that ended unrequested, and an end request whose attempt ended untitled', async () => {
    const r = rig();
    r.session('imported', { endedAt: NOW - 1000 });
    r.session('live', { imported: false, endedAt: NOW - 2000 });
    r.session('mixed', { endedAt: NOW - 3000 });
    r.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, parsed_offset, first_received_at, last_received_at, token_id, imported_at)
                  VALUES ('proj_1', 'tx_mixed_live', 'mixed', 'm1', 10, 10, ?, ?, 'tok_1', NULL)`, [NOW, NOW]);
    r.session('no-transcript', { transcript: false, endedAt: NOW - 4000 });
    r.session('requested', { imported: false, endedAt: NOW - 5000 });
    r.sqlite.run(`UPDATE sessions SET titling_requested_at = ?, titled_at = ? WHERE session_id = 'requested'`, [NOW - 5000, NOW - DAY]);
    r.session('fresh-request', { imported: false, endedAt: NOW - 6000 });
    r.sqlite.run(`UPDATE sessions SET titling_requested_at = ? WHERE session_id = 'fresh-request'`, [NOW - 6000]);

    // Scheduled intelligence is off, as it is on a Deployment nobody configured: what live capture owes is still titled.
    expect((await titlingBackfillProgress(r.env, NOW)).scheduledTasksEnabled).toBe(false);
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(4);
    expect(r.runs().map((run) => run.sessionId).sort()).toEqual(['live', 'mixed', 'no-transcript', 'requested']);
    expect(r.titledAt('imported')).toBeNull();
    // A live request's first attempt is `session-titling`'s, never the convergence's.
    expect(r.titledAt('fresh-request')).toBeNull();
    expect(await titlingBackfillProgress(r.env, NOW + 1)).toMatchObject({ remaining: 1, owed: 0 });
  });

  it('titles an imported session only while scheduled intelligence and the backfill are both on', async () => {
    const r = rig();
    r.session('imported');
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true, intervalSeconds: 0 } } });
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(0);
    r.setting('agent.scheduled_tasks_enabled', true);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: false, intervalSeconds: 0 } } });
    expect(await backfillTitles(r.env, NOW + 1, 'idle')).toBe(0);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true, intervalSeconds: 0 } } });
    expect(await backfillTitles(r.env, NOW + 2, 'idle')).toBe(1);
  });

  it('counts an attempt only when a worker claims the run: a queued run that expires unclaimed is re-queued, and a session workers took the bound on is left', async () => {
    const r = rig();
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { intervalSeconds: 0 } } });
    r.session('s', { imported: false });
    const attempts = () => (r.sqlite.query(`SELECT titling_attempts AS n FROM sessions WHERE session_id = 's'`).get() as { n: number }).n;
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(1);
    // Nothing claims it: the stale sweep fails it a day on, and the session keeps every attempt.
    expect((await runTick(r.env, NOW + DAY + 1)).jobs.find((j) => j.name === 'run-stale-sweep')?.changed).toBeGreaterThanOrEqual(1);
    expect(attempts()).toBe(0);
    expect(r.runs().map((run) => run.status)).toContain('queued');
    expect(r.runs().filter((run) => run.status === 'failed').length).toBe(1);
    // Each logical run a worker claims counts once; a lease that lapses and is claimed again, a successor of a
    // counted run, and an owner-mode claim add nothing.
    const claim = (mode: string, opts: { lapses?: number; replaces?: string } = {}) => {
      const id = `run_${mode}_${Math.random()}`;
      const context = { session_id: 's', mode, ...(opts.replaces === undefined ? {} : { replaces: opts.replaces }) };
      r.sqlite.run(`INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, run_context) SELECT ?, project_id, agent_id, task, 'queued', ?, ? FROM agent_runs LIMIT 1`, [id, NOW, JSON.stringify(context)]);
      for (let i = 0; i <= (opts.lapses ?? 0); i += 1) {
        r.sqlite.run(`UPDATE agent_runs SET status = 'running', started_at = ? WHERE id = ?`, [NOW, id]);
        if (i < (opts.lapses ?? 0)) r.sqlite.run(`UPDATE agent_runs SET status = 'queued', started_at = NULL WHERE id = ?`, [id]);
      }
      r.sqlite.run(`UPDATE agent_runs SET status = 'failed', completed_at = ? WHERE id = ?`, [NOW, id]);
      return id;
    };
    claim('owner');
    expect(attempts()).toBe(0);
    const lapsed = claim('claim', { lapses: 3 });
    expect(attempts()).toBe(1);
    const successor = claim('claim', { replaces: lapsed });
    expect(attempts()).toBe(1);
    claim('claim', { replaces: successor });
    expect(attempts()).toBe(1);
    claim('claim');
    claim('claim');
    expect(attempts()).toBe(3);
    r.sqlite.run(`UPDATE agent_runs SET status = 'failed' WHERE status = 'queued'`);
    expect(await backfillTitles(r.env, NOW + 3 * DAY, 'idle')).toBe(0);
  });

  it('takes a bounded page per wake, counts its ceiling across the Deployment, and reports where it stands', async () => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true, intervalSeconds: 0, maxRunsPerDay: TITLING_BACKFILL_BATCH + 2 } } });
    for (let i = 0; i < TITLING_BACKFILL_BATCH + 4; i += 1) r.session(`s${i}`, { project: i % 2 === 0 ? 'proj_1' : 'proj_2', endedAt: NOW - i * 1000 });

    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(TITLING_BACKFILL_BATCH);
    expect(await backfillTitles(r.env, NOW + 1, 'idle')).toBe(2);
    expect(await backfillTitles(r.env, NOW + 2, 'idle')).toBe(0);
    expect(await titlingBackfillProgress(r.env, NOW + 2)).toMatchObject({ enabled: true, runsPerDay: TITLING_BACKFILL_BATCH + 2, usedToday: TITLING_BACKFILL_BATCH + 2, remaining: 2, inFlight: TITLING_BACKFILL_BATCH + 2, completedToday: 0, failedToday: 0 });
    // The window rolls: a day later the same ceiling admits the rest.
    expect(await backfillTitles(r.env, NOW + DAY + 3, 'idle')).toBe(2);
    expect(await titlingBackfillProgress(r.env, NOW + DAY + 3)).toMatchObject({ usedToday: 2, remaining: 0 });
  });

  it('honors the block\'s states and overlap: out of state it dispatches nothing, and under skip it waits for the run in flight', async () => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true, intervalSeconds: 0, runIn: ['idle'], overlap: 'skip' } } });
    r.session('a', { endedAt: NOW - 1000 });
    r.session('b', { endedAt: NOW - 2000 });
    expect(await backfillTitles(r.env, NOW, 'active')).toBe(0);
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(TITLING_BACKFILL_BATCH > 2 ? 2 : TITLING_BACKFILL_BATCH);
    r.session('c', { endedAt: NOW - 3000 });
    expect(await backfillTitles(r.env, NOW + 1, 'idle')).toBe(0);
    r.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE task = ?`, [NOW + 2, TITLING_TASK]);
    expect(await backfillTitles(r.env, NOW + 3, 'idle')).toBe(1);
  });

  it('never counts a person\'s own ask against the ceiling, and the ask is admitted at the ceiling', async () => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true, intervalSeconds: 0, maxRunsPerDay: 1 } } });
    r.session('a', { endedAt: NOW - 1000 });
    r.session('b', { endedAt: NOW - 2000 });
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(1);
    expect(await backfillTitles(r.env, NOW + 1, 'idle')).toBe(0);
    const ask = await titleSession(r.env, { projectId: 'proj_1', sessionId: 'b', now: NOW + 2, origin: ORIGIN }, { mode: 'owner', by: 'mem_1' });
    expect(['dispatched', 'queued']).toContain(ask.outcome);
    expect(r.runs().map((run) => [run.sessionId, run.actor])).toEqual([['a', TITLING_BACKFILL_ACTOR], ['b', 'mem_1']]);
    expect((await titlingBackfillProgress(r.env, NOW + 3)).usedToday).toBe(1);
  });

  it('claims each session once under concurrent wakes, and keeps no state of its own', async () => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true, intervalSeconds: 0 } } });
    r.session('a'); r.session('b');
    const tables = () => (r.sqlite.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
    const before = tables();
    const dispatched = await Promise.all([backfillTitles(r.env, NOW, 'idle'), backfillTitles(r.env, NOW, 'idle')]);
    expect(dispatched.reduce((a, b) => a + b, 0)).toBe(2);
    expect(r.runs().map((run) => run.sessionId).sort()).toEqual(['a', 'b']);
    expect(tables()).toEqual(before);
    expect(count(r.sqlite, 'agent_runs')).toBe(2);
  });

  it('keeps a retry the ceiling refused as the retry it was, so the end-request job never takes it outside the ceiling', async () => {
    const r = rig();
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { intervalSeconds: 0, maxRunsPerDay: 1 } } });
    for (const [id, endedAt] of [['a', NOW - 1000], ['b', NOW - 2000]] as const) {
      r.session(id, { imported: false, endedAt });
      r.sqlite.run(`UPDATE sessions SET titling_requested_at = ?, titled_at = ? WHERE session_id = ?`, [endedAt, NOW - DAY, id]);
    }
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(1);
    // A session's own end, like the end-request job, makes a first attempt only.
    expect((await titleSession(r.env, { projectId: 'proj_1', sessionId: 'b', now: NOW, origin: ORIGIN })).outcome).toBe('already');
    // A wake that sized its page before another filled the ceiling: the run write refuses the retry.
    const refused = await titleSession(r.env, { projectId: 'proj_1', sessionId: 'b', now: NOW, origin: ORIGIN },
      { mode: 'claim', actor: TITLING_BACKFILL_ACTOR, retry: true, ceiling: { actor: TITLING_BACKFILL_ACTOR, task: TITLING_TASK, perDay: 1, sinceMs: NOW - DAY } });
    expect(refused.outcome).toBe('ceiling');
    expect(r.titledAt('b')).toBe(NOW - DAY);
    expect(await titleReadySessions(r.env, NOW + 1)).toBe(0);
    expect(r.runs().map((run) => [run.sessionId, run.actor])).toEqual([['a', TITLING_BACKFILL_ACTOR]]);
  });

  it('reads every candidate kind through its own partial index, and counts a refresh\'s new prompts through the receipt index', async () => {
    const r = rig();
    const plan = (sql: string, binds: unknown[]) => (r.sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as { detail: string }[]).map((row) => row.detail).join('\n');
    const statements: Array<{ sql: string; binds: unknown[] }> = [];
    const store = { prepare: (sql: string) => ({ bind: (...binds: unknown[]) => { statements.push({ sql, binds }); return { all: async () => ({ results: [] }) }; } }) } as unknown as RelationalStore;
    await listTitleCandidates(store, windowAt(NOW), 5);
    const plans = statements.map((st) => plan(st.sql, st.binds));
    const using = (index: string) => plans.filter((p) => p.includes(`SEARCH s USING INDEX ${index}`) || p.includes(`SCAN s USING INDEX ${index}`));
    expect(statements).toHaveLength(5);
    expect(using('idx_sessions_untitled_ended')).toHaveLength(2);
    expect(using('idx_sessions_untitled_open')).toHaveLength(2);
    expect(using('idx_sessions_titled_recent')).toHaveLength(1);
    expect(plans.find((p) => p.includes('idx_sessions_titled_recent'))).toMatch(/idx_prompt_batches_user_received/);
    for (const p of plans) expect(p).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('names why each ended session is untitled, and nothing for a titled or open one', async () => {
    const r = rig();
    const reason = (id: string) => untitledReason(r.env.db, 'proj_1', id);
    r.session('capture', { parsed: false, material: false });
    r.session('silent', { material: false, imported: false });
    r.session('imported');
    r.session('waiting', { imported: false });
    r.session('requested-import');
    r.sqlite.run(`UPDATE sessions SET titling_requested_at = ended_at WHERE session_id = 'requested-import'`);
    r.session('flight', { imported: false });
    r.session('stopped', { imported: false });
    r.sqlite.run(`UPDATE sessions SET titling_attempts = 3 WHERE session_id = 'stopped'`);
    r.session('stopped-in-flight', { imported: false });
    r.sqlite.run(`UPDATE sessions SET titling_attempts = 3 WHERE session_id = 'stopped-in-flight'`);
    r.on();
    for (const id of ['flight', 'stopped-in-flight']) {
      r.sqlite.run(`UPDATE sessions SET titling_attempts = 0 WHERE session_id = ?`, [id]);
      await titleSession(r.env, { projectId: 'proj_1', sessionId: id, now: NOW, origin: ORIGIN });
    }
    r.sqlite.run(`UPDATE sessions SET titling_attempts = 3 WHERE session_id = 'stopped-in-flight'`);
    r.session('titled', { title: 'Named', imported: false });
    r.session('open', { imported: false });
    r.sqlite.run(`UPDATE sessions SET ended_at = NULL WHERE session_id = 'open'`);
    const expected: Record<string, string | null> = {
      capture: 'capture_pending', silent: 'no_material', imported: 'imported', waiting: 'waiting', 'requested-import': 'waiting',
      flight: 'in_progress', 'stopped-in-flight': 'in_progress', stopped: 'stopped', titled: null, open: null, absent: null,
    };
    const answered: Record<string, string | null> = {};
    for (const id of Object.keys(expected)) answered[id] = await reason(id);
    expect(answered).toEqual(expected);
  });

  /**
   * A store whose statements pause where a test says: `hold(sql, kind, n)`
   * answers a promise the nth call of that kind waits on before it runs, or
   * undefined to let it through. What a wake reads and writes is unchanged;
   * only the order in which concurrent wakes reach the store is decided here.
   */
  function staged(db: RelationalStore, hold: (sql: string, kind: 'first' | 'all' | 'run', n: number) => Promise<void> | undefined): RelationalStore {
    const seen = new Map<string, number>();
    const originals = new WeakMap<PreparedStatement, { statement: PreparedStatement; sql: string }>();
    const gate = (sql: string, kind: 'first' | 'all' | 'run'): Promise<void> | undefined => {
      const key = `${kind}:${sql}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return hold(sql, kind, n);
    };
    const wrap = (statement: PreparedStatement, sql: string): PreparedStatement => {
      const wrapped: PreparedStatement = {
        bind: (...values) => wrap(statement.bind(...values), sql),
        first: async <T,>() => { await gate(sql, 'first'); return statement.first<T>(); },
        all: async <T,>() => { await gate(sql, 'all'); return statement.all<T>(); },
        run: async () => { await gate(sql, 'run'); return statement.run(); },
      };
      originals.set(wrapped, { statement, sql });
      return wrapped;
    };
    return {
      ...db, prepare: sql => wrap(db.prepare(sql), sql),
      batch: async statements => {
        const captured = statements.map(statement => originals.get(statement));
        for (const entry of captured) if (entry !== undefined) await gate(entry.sql, 'run');
        return db.batch(statements.map((statement, index) => captured[index]?.statement ?? statement));
      },
    };
  }

  const isCeilingCount = (sql: string) => sql.includes('MIN(at) AS pivot') && sql.includes("status != 'skipped'");
  const isCandidateList = (sql: string) => sql.includes('ORDER BY s.ended_at DESC');
  const isRunInsert = (sql: string) => sql.startsWith('INSERT INTO agent_runs');

  it.each([2, 3])('holds a ceiling of one under %i staggered wakes that each read free capacity and each select an unclaimed session', async (wakes) => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true, intervalSeconds: 0, maxRunsPerDay: 1 } } });
    for (let i = 0; i < wakes + 1; i += 1) r.session(`s${i}`, { endedAt: NOW - i * 1000 });

    // Every wake reads the ceiling count before any of them writes; each later
    // candidate select waits for the previous wake's run insert, so it sees that
    // wake's claim and picks the next session.
    let counted = 0;
    let releaseCounts!: () => void;
    const allCounted = new Promise<void>((resolve) => { releaseCounts = resolve; });
    let inserts = 0;
    const insertLanded: Array<Array<() => void>> = [];
    const afterInsert = (n: number) => new Promise<void>((resolve) => { if (inserts >= n) resolve(); else (insertLanded[n] ??= []).push(resolve); });
    const env: ServerEnv = { ...r.env, db: staged(r.env.db, (sql, kind, n) => {
      if (kind === 'first' && isCeilingCount(sql)) { counted += 1; if (counted === wakes) releaseCounts(); return allCounted; }
      if (kind === 'all' && isCandidateList(sql) && n > 1) return afterInsert(n - 1);
      if (kind === 'run' && isRunInsert(sql)) return Promise.resolve().then(() => { inserts += 1; for (const release of insertLanded[inserts] ?? []) release(); });
      return undefined;
    }) };

    const dispatched = await Promise.all(Array.from({ length: wakes }, () => backfillTitles(env, NOW, 'idle')));
    expect(dispatched.reduce((a, b) => a + b, 0)).toBe(1);
    expect(r.runs().length).toBe(1);
    // The sessions the refused wakes selected keep their attempt for a later day.
    expect(r.sqlite.query(`SELECT COUNT(*) AS n FROM sessions WHERE titled_at IS NOT NULL`).get()).toEqual({ n: 1 });
    expect((await titlingBackfillProgress(r.env, NOW + 1)).usedToday).toBe(1);
  });

  it('is stopped and started by the operator\'s switch, which writes the task override and reports the state, and runs under the tick', async () => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.session('a');
    const cookie = await ownerCookie(r.env.db);
    const request = (method: string, body?: unknown) => worker.fetch(new Request('https://s/api/titling-backfill', {
      method, headers: { cookie, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { ...r.bindings, ...OWNER_ENV });
    const read = async () => (await request('GET')).json() as Promise<{ enabled: boolean; backfillEnabled: boolean; remaining: number }>;
    expect(await read()).toMatchObject({ enabled: false, backfillEnabled: false, remaining: 1 });
    expect((await request('PUT', { enabled: 'yes' })).status).toBe(400);
    const stored = () => (r.sqlite.query(`SELECT value FROM deployment_settings WHERE leaf = 'agent.tasks'`).get() as { value: string } | null)?.value ?? null;
    // An override the switch cannot merge into is refused and left as it is: unreadable JSON, and readable JSON of the wrong shape at any level, null included.
    for (const held of ['{not json', '["title-summary"]', JSON.stringify({ [TITLING_TASK]: 'fast' }), JSON.stringify({ [TITLING_TASK]: null }), JSON.stringify({ [TITLING_TASK]: { schedule: 5 } }), JSON.stringify({ [TITLING_TASK]: { schedule: null } })]) {
      r.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.tasks', ?, ?, 'mem_1')`, [held, NOW]);
      const refused = await request('PUT', { enabled: true });
      expect({ held, status: refused.status, stored: stored() }).toEqual({ held, status: 400, stored: held });
    }
    // Other tasks, the task's other fields and the block's other fields survive the switch.
    r.setting('agent.tasks', { 'extract-curate': { schedule: { maxRunsPerDay: 3 } }, [TITLING_TASK]: { model: 'haiku', harness: 'claude-code', schedule: { maxRunsPerDay: 9 } } });
    expect(await (await request('PUT', { enabled: true })).json()).toMatchObject({ enabled: true, backfillEnabled: true, runsPerDay: 9 });
    expect(JSON.parse(stored()!)).toEqual({ 'extract-curate': { schedule: { maxRunsPerDay: 3 } }, [TITLING_TASK]: { model: 'haiku', harness: 'claude-code', schedule: { maxRunsPerDay: 9, enabled: true } } });
    const tick = await runTick(r.env, NOW);
    expect(tick.jobs.find((j) => j.name === 'titling-backfill')).toEqual({ name: 'titling-backfill', changed: 1, failed: null, more: false });
    expect(await (await request('PUT', { enabled: false })).json()).toMatchObject({ enabled: false, backfillEnabled: false, inFlight: 1 });
    r.session('b');
    expect((await runTick(r.env, NOW + 1)).jobs.find((j) => j.name === 'titling-backfill')).toEqual({ name: 'titling-backfill', changed: 0, failed: null, more: false });
    expect(r.runs().length).toBe(1);
  });
});

describe('why a wake of the titling convergence dispatched nothing', () => {
  let log: ReturnType<typeof spyOn> | undefined;
  afterEach(() => { log?.mockRestore(); log = undefined; });
  /** The `titling_backfill_waiting` events emitted from here on. */
  const waits = () => {
    const events: Array<Record<string, unknown>> = [];
    log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      try {
        const event = JSON.parse(String(args[0])) as Record<string, unknown>;
        if (event.kind === 'titling_backfill_waiting') events.push(event);
      } catch { /* not an event */ }
    });
    return events;
  };
  /** Every run still queued is claimed by a worker (the attempt counts) and closes with a title written. */
  const workersTitle = (r: ReturnType<typeof rig>, at: number) => {
    for (const run of r.runs().filter((x) => x.status === 'queued')) {
      r.sqlite.run(`UPDATE agent_runs SET status = 'running', started_at = ? WHERE id = ?`, [at, run.id]);
      r.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE id = ?`, [at, run.id]);
      r.sqlite.run(`UPDATE sessions SET title = 'Titled' WHERE project_id = ? AND session_id = ?`, [run.projectId, run.sessionId]);
    }
  };

  it('spends the default daily ceiling on the newest owed sessions, names the wait once with the instant it lifts, and takes the older live shapes the wake it lifts', async () => {
    // The Deployment as it stood when #1381 went live: scheduled intelligence on, the backfill block untouched, a
    // backlog of 24 owed live sessions newer than seven more: a live session that ended unrequested and never got a
    // stamp, one stamped long ago whose title never landed, and synthetic live sessions in a second project.
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    for (let i = 0; i < 24; i += 1) r.session(`backlog-${i}`, { imported: false, endedAt: NOW - 3 * DAY - i * 1000 });
    r.session('never-stamped', { imported: false, endedAt: NOW - 15 * DAY });
    r.session('stamped-untitled', { imported: false, endedAt: NOW - 26 * DAY });
    r.sqlite.run(`UPDATE sessions SET titled_at = ? WHERE session_id = 'stamped-untitled'`, [NOW - 25 * DAY]);
    for (let i = 0; i < 5; i += 1) {
      r.session(`titling-live-${i}`, { project: 'proj_2', imported: false, endedAt: NOW - 25 * DAY - i * 1000 });
      r.sqlite.run(`UPDATE sessions SET titled_at = ? WHERE session_id = ?`, [NOW - 25 * DAY, `titling-live-${i}`]);
    }
    const events = waits();
    const policy = await titlingBackfillPolicy(r.env);
    expect(policy).toMatchObject({ runsPerDay: 36, intervalSeconds: 900 });

    // A wake a minute, as the hosted clock delivers them while the Deployment is in use.
    let now = NOW;
    let firstEntry: number | null = null;
    const wake = async () => { const n = await backfillTitles(r.env, now, 'active'); if (n > 0) firstEntry ??= now; workersTitle(r, now + 30_000); now += 60_000; return n; };
    let dispatched = 0;
    for (let i = 0; i < 120; i += 1) dispatched += await wake();
    expect(dispatched).toBe(24);
    expect(r.runs().every((run) => run.sessionId.startsWith('backlog-'))).toBe(true);
    const lastEntry = Math.max(...(r.sqlite.query(`SELECT queued_at AS at FROM agent_runs WHERE task = ?`).all(TITLING_TASK) as { at: number }[]).map((row) => row.at));
    // One report per wait, not one per wake: each interval between dispatches, then the ceiling with when it lifts.
    const ceiling = events.filter((e) => e.wait === 'reserved');
    expect(ceiling).toEqual([{ kind: 'titling_backfill_waiting', wait: 'reserved', until: firstEntry! + DAY + 1, runsPerDay: 36 }]);
    expect(events.filter((e) => e.wait === 'interval').map((e) => e.until)).toEqual(
      [...new Set((r.sqlite.query(`SELECT queued_at AS at FROM agent_runs WHERE task = ? ORDER BY queued_at`).all(TITLING_TASK) as { at: number }[]).map((row) => row.at))].map((at) => at + 900_000),
    );
    expect(lastEntry).toBeLessThan(firstEntry! + DAY);
    expect(await titlingBackfillProgress(r.env, now)).toMatchObject({ owed: 7, usedToday: 24, waiting: { reason: 'reserved', until: firstEntry! + DAY + 1 } });

    // Nothing moves, and nothing more is reported, until the window frees a place; that wake takes the older shapes.
    now = firstEntry! + DAY;
    expect(await backfillTitles(r.env, now, 'active')).toBe(0);
    expect(events.length).toBe(ceiling.length + events.filter((e) => e.wait === 'interval').length);
    now += 1;
    expect(await backfillTitles(r.env, now, 'active')).toBe(5);
    const taken = () => r.runs().slice(24).map((run) => run.sessionId).sort();
    expect(taken()).toEqual(['never-stamped', 'titling-live-0', 'titling-live-1', 'titling-live-2', 'titling-live-3']);
    // The window is full again; the next place frees as the second page of the backlog leaves it, and the rest go.
    const second = [...new Set((r.sqlite.query(`SELECT queued_at AS at FROM agent_runs WHERE task = ? ORDER BY queued_at`).all(TITLING_TASK) as { at: number }[]).map((row) => row.at))][1]!;
    expect(await titlingBackfillProgress(r.env, now + 1)).toMatchObject({ owed: 2, waiting: { reason: 'reserved', until: second + DAY + 1 } });
    expect(await backfillTitles(r.env, second + DAY + 1, 'active')).toBe(2);
    expect(taken()).toEqual(['never-stamped', 'stamped-untitled', 'titling-live-0', 'titling-live-1', 'titling-live-2', 'titling-live-3', 'titling-live-4']);
  });

  it('names each gate that held it, reports a wait only when it changes, and forgets it once a wake dispatches', async () => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { runIn: ['idle'], overlap: 'skip', maxRunsPerDay: 2 } } });
    r.session('a', { imported: false, endedAt: NOW - 1000 });
    r.session('b', { imported: false, endedAt: NOW - 2000 });
    r.session('c', { imported: false, endedAt: NOW - 3000 });
    const events = waits();

    expect(await backfillTitles(r.env, NOW, 'active')).toBe(0);
    expect(await backfillTitles(r.env, NOW + 1, 'active')).toBe(0);
    expect(events).toEqual([{ kind: 'titling_backfill_waiting', wait: 'state', until: null, state: 'active' }]);
    expect(await backfillTitles(r.env, NOW + 2, 'idle')).toBe(2);
    // Inside the interval: named once with its end, however many wakes it holds.
    for (let i = 3; i < 10; i += 1) expect(await backfillTitles(r.env, NOW + i, 'idle')).toBe(0);
    expect(events.slice(1)).toEqual([{ kind: 'titling_backfill_waiting', wait: 'interval', until: NOW + 2 + 900_000 }]);
    expect(await titlingBackfillProgress(r.env, NOW + 10)).toMatchObject({ owed: 1, inFlight: 2, waiting: { reason: 'ceiling', until: NOW + 2 + DAY + 1 } });
    // Past it, the runs still in flight hold it under `skip`; once they close, the ceiling does.
    expect(await backfillTitles(r.env, NOW + 900_002, 'idle')).toBe(0);
    expect(events.slice(2)).toEqual([{ kind: 'titling_backfill_waiting', wait: 'overlap', until: null }]);
    r.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE task = ?`, [NOW + 900_003, TITLING_TASK]);
    expect(await titlingBackfillProgress(r.env, NOW + 900_004)).toMatchObject({ inFlight: 0, waiting: { reason: 'ceiling', until: NOW + 2 + DAY + 1 } });
    expect(await backfillTitles(r.env, NOW + 900_004, 'idle')).toBe(0);
    expect(await backfillTitles(r.env, NOW + 900_005, 'idle')).toBe(0);
    expect(events.slice(3)).toEqual([{ kind: 'titling_backfill_waiting', wait: 'ceiling', until: NOW + 2 + DAY + 1, runsPerDay: 2 }]);
    // The ceiling lifts on the dot and the wake dispatches its page again; the next hold is reported afresh.
    expect(await backfillTitles(r.env, NOW + 2 + DAY + 1, 'idle')).toBe(2);
    expect(await backfillTitles(r.env, NOW + 3 + DAY + 1, 'idle')).toBe(0);
    expect(events.slice(4)).toEqual([{ kind: 'titling_backfill_waiting', wait: 'interval', until: NOW + 2 + DAY + 1 + 900_000 }]);
  });

  it('reports the ceiling again when only the instant it lifts moves: another wake\'s entry, and a lowered limit', async () => {
    const r = rig();
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { intervalSeconds: 0, maxRunsPerDay: 2 } } });
    for (let i = 0; i < 2; i += 1) {
      r.session(`s${i}`, { imported: false, endedAt: NOW - 1000 - i });
      expect(await backfillTitles(r.env, NOW + i * 10, 'idle')).toBe(1);
    }
    r.session('waiting', { imported: false, endedAt: NOW - 5000 });
    const events = waits();
    expect(await backfillTitles(r.env, NOW + 20, 'idle')).toBe(0);
    expect(await backfillTitles(r.env, NOW + 21, 'idle')).toBe(0);
    expect(events).toEqual([{ kind: 'titling_backfill_waiting', wait: 'ceiling', until: NOW + DAY + 1, runsPerDay: 2 }]);
    // A wake elsewhere that sized its page before this one entered a run: same limit, a later lift.
    r.sqlite.run(`INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, run_context, dispatch_spec)
                  SELECT 'run_elsewhere', project_id, agent_id, task, 'queued', ?, run_context, dispatch_spec FROM agent_runs WHERE task = ? LIMIT 1`, [NOW + 30, TITLING_TASK]);
    expect(await backfillTitles(r.env, NOW + 40, 'idle')).toBe(0);
    expect(await backfillTitles(r.env, NOW + 41, 'idle')).toBe(0);
    expect(events.slice(1)).toEqual([{ kind: 'titling_backfill_waiting', wait: 'ceiling', until: NOW + 10 + DAY + 1, runsPerDay: 2 }]);
    // The limit lowered while at it: the newest entry now decides.
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { intervalSeconds: 0, maxRunsPerDay: 1 } } });
    expect(await backfillTitles(r.env, NOW + 50, 'idle')).toBe(0);
    expect(events.slice(2)).toEqual([{ kind: 'titling_backfill_waiting', wait: 'ceiling', until: NOW + 30 + DAY + 1, runsPerDay: 1 }]);
    // A limit of 0 holds with no instant to lift at.
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { intervalSeconds: 0, maxRunsPerDay: 0 } } });
    expect(await backfillTitles(r.env, NOW + 60, 'idle')).toBe(0);
    expect(events.slice(3)).toEqual([{ kind: 'titling_backfill_waiting', wait: 'ceiling', until: null, runsPerDay: 0 }]);
    expect(await titlingBackfillProgress(r.env, NOW + 61)).toMatchObject({ runsPerDay: 0, waiting: { reason: 'ceiling', until: null } });
  });

  it('reports the ceiling again when the limit is lowered and the instant it lifts stays: one wake\'s page shares an entry time', async () => {
    const r = rig();
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { intervalSeconds: 0, maxRunsPerDay: 2 } } });
    r.session('a', { imported: false, endedAt: NOW - 1000 });
    r.session('b', { imported: false, endedAt: NOW - 2000 });
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(2);
    r.session('c', { imported: false, endedAt: NOW - 3000 });
    const events = waits();
    expect(await backfillTitles(r.env, NOW + 1, 'idle')).toBe(0);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { intervalSeconds: 0, maxRunsPerDay: 1 } } });
    expect(await backfillTitles(r.env, NOW + 2, 'idle')).toBe(0);
    expect(await backfillTitles(r.env, NOW + 3, 'idle')).toBe(0);
    expect(events).toEqual([
      { kind: 'titling_backfill_waiting', wait: 'ceiling', until: NOW + DAY + 1, runsPerDay: 2 },
      { kind: 'titling_backfill_waiting', wait: 'ceiling', until: NOW + DAY + 1, runsPerDay: 1 },
    ]);
  });

  it('reports no wait for imported sessions while the backfill is stopped, and the hold once it is on', async () => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { maxRunsPerDay: 0 } } });
    r.session('imported');
    expect(await titlingBackfillProgress(r.env, NOW)).toMatchObject({ owed: 0, remaining: 1, enabled: false, waiting: null });
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true, maxRunsPerDay: 0 } } });
    expect(await titlingBackfillProgress(r.env, NOW)).toMatchObject({ owed: 0, remaining: 1, enabled: true, waiting: { reason: 'ceiling', until: null } });
    // Scheduled intelligence off stops it too.
    r.setting('agent.scheduled_tasks_enabled', false);
    expect(await titlingBackfillProgress(r.env, NOW)).toMatchObject({ remaining: 1, enabled: false, waiting: null });
  });

  it('takes a schedule count only as a whole number of 0 or more: a fraction held already reads as the declared limit, and a write of one is refused by name', async () => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.session('a', { imported: false });
    const declaredLimit = TITLING_BACKFILL_SCHEDULE.maxRunsPerDay ?? null;
    for (const held of [2.5, -1, '3', Number.MAX_SAFE_INTEGER + 2]) {
      r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { maxRunsPerDay: held } } });
      expect({ held, runsPerDay: (await titlingBackfillPolicy(r.env)).runsPerDay }).toEqual({ held, runsPerDay: declaredLimit });
      expect((await titlingBackfillProgress(r.env, NOW)).runsPerDay).toBe(declaredLimit);
    }
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { maxRunsPerDay: 2.5, intervalSeconds: 0 } } });
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(1);

    const cookie = await ownerCookie(r.env.db);
    const request = (method: string, path: string, body?: unknown) => worker.fetch(new Request(`https://s${path}`, {
      method, headers: { cookie, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { ...r.bindings, ...OWNER_ENV });
    expect((await request('GET', '/api/titling-backfill')).status).toBe(200);
    const stored = () => (r.sqlite.query(`SELECT value FROM deployment_settings WHERE leaf = 'agent.tasks'`).get() as { value: string }).value;
    const before = JSON.parse(stored()) as Record<string, { schedule: Record<string, unknown> }>;
    // A switch changes only enabled, leaving a held invalid count for a separate repair.
    const switched = await request('PUT', '/api/titling-backfill', { enabled: true });
    expect(switched.status).toBe(200);
    expect(JSON.parse(stored())).toEqual({ ...before, [TITLING_TASK]: { ...before[TITLING_TASK], schedule: { ...before[TITLING_TASK]!.schedule, enabled: true } } });
    // The settings write refuses a changed count that is not a whole number of 0 or more, and takes one that is.
    for (const count of [3.5, -1, '3', null]) {
      const res = await request('PUT', '/api/settings/agent.tasks', { value: { [TITLING_TASK]: { schedule: { maxRunsPerDay: count } } } });
      const body: unknown = await res.json();
      expect({ count, status: res.status, body }).toEqual({ count, status: 400, body: { applied: false, reason: 'invalid_value', leaf: 'agent.tasks', detail: `${TITLING_TASK}.schedule.maxRunsPerDay: expected a whole number of 0 or more` } });
    }
    const accepted: Array<Record<string, unknown>> = [{ [TITLING_TASK]: { schedule: { maxRunsPerDay: 0 } } }, { [TITLING_TASK]: { model: 'haiku', harness: 'claude-code' } }, { 'extract-curate': { schedule: { intervalSeconds: 60 } } }];
    for (const value of accepted) {
      const answer: unknown = await (await request('PUT', '/api/settings/agent.tasks', { value })).json();
      expect(answer).toEqual({ applied: true });
    }
    expect((await request('PUT', '/api/settings/agent.tasks', { value: ['title-summary'] })).status).toBe(400);
  });

  it('names a wake whose every candidate was refused before a run started, with the outcomes, once', async () => {
    const r = rig();
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { intervalSeconds: 0 } } });
    r.session('orphan', { project: 'proj_gone', imported: false });
    const events = waits();
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(0);
    expect(await backfillTitles(r.env, NOW + 1, 'idle')).toBe(0);
    expect(events).toEqual([{ kind: 'titling_backfill_waiting', wait: 'skipped', until: null, outcomes: { error: 1 } }]);
    // Nothing to title reports nothing, and a wait after it is reported again.
    r.sqlite.run(`UPDATE sessions SET title = 'Named' WHERE session_id = 'orphan'`);
    expect(await backfillTitles(r.env, NOW + 2, 'idle')).toBe(0);
    r.sqlite.run(`UPDATE sessions SET title = NULL WHERE session_id = 'orphan'`);
    expect(await backfillTitles(r.env, NOW + 3, 'idle')).toBe(0);
    expect(events.length).toBe(2);
    expect(await titlingBackfillProgress(r.env, NOW + 4)).toMatchObject({ owed: 1, waiting: null });
    // A wake that dispatches forgets the wait: the same refusal after it is reported again.
    r.session('good', { imported: false, endedAt: NOW - 500 });
    expect(await backfillTitles(r.env, NOW + 5, 'idle')).toBe(1);
    expect(await backfillTitles(r.env, NOW + 6, 'idle')).toBe(0);
    expect(events.length).toBe(3);
    expect(events[2]).toEqual(events[0]);
  });

  it('reads the ceiling\'s window as the entry whose leaving frees a place, a lowered ceiling included, and reports no wait while nothing waits', async () => {
    const r = rig();
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { intervalSeconds: 0, maxRunsPerDay: 5 } } });
    for (let i = 0; i < 5; i += 1) {
      r.session(`s${i}`, { imported: false, endedAt: NOW - i * 1000 });
      expect(await backfillTitles(r.env, NOW + i * 10, 'idle')).toBe(1);
    }
    const window = (perDay: number) => deploymentTaskCeilingWindow(r.env.db, TITLING_TASK, NOW - DAY + 50, TITLING_BACKFILL_ACTOR, perDay);
    expect(await window(5)).toEqual({ used: 5, pivotAt: NOW });
    // Lowered to 3: the third newest entry is the one whose leaving brings the window under it.
    expect(await window(3)).toEqual({ used: 3, pivotAt: NOW + 20 });
    expect(await window(6)).toEqual({ used: 5, pivotAt: null });
    expect(await window(0)).toEqual({ used: 0, pivotAt: null });
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { intervalSeconds: 0, maxRunsPerDay: 3 } } });
    // Every session has its attempt: the ceiling holds, but nothing waits on it.
    expect(await titlingBackfillProgress(r.env, NOW + 50)).toMatchObject({ owed: 0, usedToday: 5, waiting: null });
    r.session('late', { imported: false, endedAt: NOW + 40 });
    expect(await titlingBackfillProgress(r.env, NOW + 50)).toMatchObject({ owed: 1, waiting: { reason: 'ceiling', until: NOW + 20 + DAY + 1 } });
  });
});

describe('sessions that never end', () => {
  /** An open session: no `ended_at`, `prompts` user prompts spread over its last hour, and its last receipt `quietFor` ms ago. */
  function open(r: ReturnType<typeof rig>, id: string, over: { quietFor?: number; prompts?: number; title?: string; titledAt?: number; materialAt?: number; clockBehind?: number; endedAt?: number } = {}) {
    const lastReceivedAt = NOW - (over.quietFor ?? 1000);
    r.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, title, summary, titled_at, title_material_at, ended_at)
                  VALUES ('proj_1', ?, 'm1', 'tok_1', ?, ?, 'codex', ?, ?, ?, ?, ?, ?)`,
      [id, lastReceivedAt - 2 * DAY, lastReceivedAt, lastReceivedAt - 2 * DAY, over.title ?? null, over.title === undefined ? null : 'Standing summary', over.titledAt ?? null, over.materialAt ?? null, over.endedAt ?? null]);
    for (let i = 0; i < (over.prompts ?? 1); i += 1) {
      const at = lastReceivedAt - i * 1000;
      r.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                    VALUES ('proj_1', ?, ?, ?, ?, 'user', ?, ?, ?, 'tok_1', ?)`, [id, `p_${id}_${i}`, `e_${id}_${i}`, `Work on ${id} step ${i}`, `h_${id}_${i}`, at - (over.clockBehind ?? 0), at - (over.clockBehind ?? 0), at]);
    }
  }
  const endedAt = (r: ReturnType<typeof rig>, id: string) => (r.sqlite.query(`SELECT ended_at FROM sessions WHERE session_id = ?`).get(id) as { ended_at: number | null }).ended_at;

  it('titles an open session once it has been quiet past the idle bound, and leaves its ended_at alone', async () => {
    const r = rig();
    open(r, 'pane-removed', { quietFor: 3 * HOUR });
    open(r, 'just-working', { quietFor: HOUR });
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(1);
    expect(r.runs().map((run) => [run.sessionId, run.mode, run.actor])).toEqual([['pane-removed', 'claim', TITLING_BACKFILL_ACTOR]]);
    expect(r.titledAt('pane-removed')).toBe(NOW);
    expect(endedAt(r, 'pane-removed')).toBeNull();
    expect(r.titledAt('just-working')).toBeNull();
  });

  it('takes the idle bound from the Deployment\'s setting, falling back to the default for a value its rule refuses', async () => {
    const r = rig();
    open(r, 'forty', { quietFor: 40 * 60_000 });
    expect(await titlingIdleCloseMinutes(r.env)).toBe(120);
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(0);
    r.setting('agent.titling_idle_close_minutes', 4);
    expect(await titlingIdleCloseMinutes(r.env)).toBe(120);
    r.setting('agent.titling_idle_close_minutes', 30);
    expect(await titlingIdleCloseMinutes(r.env)).toBe(30);
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(1);
    expect(endedAt(r, 'forty')).toBeNull();
  });

  it('counts a quiet open session as owed, and leaves a session whose capture is still unread', async () => {
    const r = rig();
    open(r, 'quiet', { quietFor: 3 * HOUR });
    open(r, 'unread', { quietFor: 3 * HOUR });
    r.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, parsed_offset, first_received_at, last_received_at, token_id)
                  VALUES ('proj_1', 'tx_unread', 'unread', 'm1', 100, 40, ?, ?, 'tok_1')`, [NOW, NOW]);
    expect(await titlingBackfillProgress(r.env, NOW)).toMatchObject({ owed: 1, remaining: 0 });
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(1);
    expect(r.runs().map((run) => run.sessionId)).toEqual(['quiet']);
  });

  it('refreshes the title of a live session after enough new prompts and enough time, as a refresh that never counts as an attempt', async () => {
    const r = rig();
    open(r, 'long', { title: 'Wire the build', titledAt: NOW - 5 * HOUR, prompts: 12 });
    open(r, 'few-prompts', { title: 'Wire the build', titledAt: NOW - 5 * HOUR, prompts: 9 });
    open(r, 'just-titled', { title: 'Wire the build', titledAt: NOW - HOUR, prompts: 12 });
    open(r, 'nothing-since', { title: 'Wire the build', titledAt: NOW + 10, prompts: 12 });
    // Only a session due a refresh is offered, so one the claim would refuse never takes a place in the page.
    expect((await listTitleCandidates(r.env.db, windowAt(NOW), 5)).freshRefreshes.map((c) => [c.sessionId, c.mode])).toEqual([['long', 'refresh']]);
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(1);
    expect(r.runs().map((run) => [run.sessionId, run.mode, run.actor])).toEqual([['long', 'refresh', TITLING_BACKFILL_ACTOR]]);
    expect(r.titledAt('long')).toBe(NOW);
    // A worker taking the run costs no attempt: only a `claim` is bounded.
    r.sqlite.run(`UPDATE agent_runs SET status = 'running' WHERE status = 'queued'`);
    expect((r.sqlite.query(`SELECT titling_attempts AS n FROM sessions WHERE session_id = 'long'`).get() as { n: number }).n).toBe(0);
    // A second wake finds the stamp new: the refresh waits out the interval.
    expect(await backfillTitles(r.env, NOW + 1000, 'idle')).toBe(0);
    expect(r.runs()).toHaveLength(1);
  });

  it('reads a refresh\'s material from both ends of a long session, where a first title reads its opening', async () => {
    const r = rig();
    open(r, 'long', { title: 'Wire the build', titledAt: NOW - 5 * HOUR, prompts: 30 });
    const texts = async (mode: 'claim' | 'refresh') => (await sessionMaterial(r.env.db, 'proj_1', 'long', mode)).map((line) => line.prompt);
    const opening = await texts('claim');
    expect(opening).toContain('Work on long step 29');
    expect(opening).not.toContain('Work on long step 0');
    const both = await texts('refresh');
    expect(both).toContain('Work on long step 29');
    expect(both).toContain('Work on long step 0');
    expect(both).not.toContain('Work on long step 15');
  });

  it('refuses a refresh inside the interval at the claim itself, whoever asks', async () => {
    const r = rig();
    open(r, 'recent', { title: 'Wire the build', titledAt: NOW - HOUR, prompts: 12 });
    const refused = await titleSession(r.env, { projectId: 'proj_1', sessionId: 'recent', now: NOW, origin: ORIGIN }, { mode: 'refresh', actor: TITLING_BACKFILL_ACTOR });
    expect(refused.outcome).toBe('already');
    expect(r.titledAt('recent')).toBe(NOW - HOUR);
    expect(r.runs()).toEqual([]);
  });

  it('offers a refresh only to a session active within the day, however long ago it was titled', async () => {
    const r = rig();
    open(r, 'active', { title: 'Wire the build', titledAt: NOW - 5 * HOUR, prompts: 12 });
    open(r, 'dormant', { title: 'Wire the build', titledAt: NOW - 4 * DAY, prompts: 12, quietFor: 3 * DAY });
    const candidates = await listTitleCandidates(r.env.db, windowAt(NOW), 5);
    expect(candidates.freshRefreshes.map((c) => [c.sessionId, c.mode])).toEqual([['active', 'refresh']]);
    expect(candidates.freshClaims).toEqual([]);
    expect(candidates.backlogClaims).toEqual([]);
  });

  it('selects the most recently active refreshes before it limits, so older titled sessions never hide newer ones', async () => {
    const r = rig();
    // The oldest titling stamp belongs to the session least recently active.
    open(r, 'a-day-ago', { title: 'T', titledAt: NOW - 10 * HOUR, prompts: 12, quietFor: 20 * HOUR });
    open(r, 'hours-ago', { title: 'T', titledAt: NOW - 9 * HOUR, prompts: 12, quietFor: 3 * HOUR });
    open(r, 'just-now', { title: 'T', titledAt: NOW - 5 * HOUR, prompts: 12, quietFor: 1000 });
    expect((await listTitleCandidates(r.env.db, windowAt(NOW), 2)).freshRefreshes.map((c) => c.sessionId)).toEqual(['just-now', 'hours-ago']);
  });

  it('gives a fresh session its first title before any refresh, and keeps the last third of the ceiling from refreshes', async () => {
    const r = rig();
    settle(r, 3);
    for (const id of ['r1', 'r2', 'r3']) open(r, id, { title: 'T', titledAt: NOW - 5 * HOUR, prompts: 12 });
    open(r, 'never-titled', { quietFor: 3 * HOUR });
    // Three refreshes are due, but the quiet untitled session is taken first and the refreshes stop at two runs in all.
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(2);
    const taken = r.runs().map((run) => [run.sessionId.startsWith('r') ? 'refresh' : run.sessionId, run.mode]).sort();
    expect(taken).toEqual([['never-titled', 'claim'], ['refresh', 'refresh']]);
    // The held run is still there for the next session to end.
    r.session('just-ended', { imported: false, endedAt: NOW + 1000 });
    expect(await backfillTitles(r.env, NOW + 2000, 'idle')).toBe(1);
    expect(r.runs().map((run) => run.sessionId)).toContain('just-ended');
  });

  it('keeps a refresh that closed without its write due, since only a written title moves the material it counts from', async () => {
    const r = rig();
    open(r, 'long', { title: 'Wire the build', titledAt: NOW - 5 * HOUR, prompts: 12 });
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(1);
    r.sqlite.run(`UPDATE agent_runs SET status = 'failed', completed_at = ? WHERE status = 'queued'`, [NOW + 1000]);
    expect((r.sqlite.query(`SELECT title_material_at AS at FROM sessions WHERE session_id = 'long'`).get() as { at: number }).at).toBe(NOW - 5 * HOUR);
    // Inside the interval the stamp holds it off; past the interval it is due again on the same prompts.
    expect(await backfillTitles(r.env, NOW + HOUR, 'idle')).toBe(0);
    expect(await backfillTitles(r.env, NOW + 5 * HOUR, 'idle')).toBe(1);
    expect(r.runs().map((run) => run.mode)).toEqual(['refresh', 'refresh']);
  });

  it('records what a written title read, so the next refresh counts only the prompts after it', async () => {
    const r = rig();
    open(r, 'long', { title: 'Wire the build', titledAt: NOW - 5 * HOUR, prompts: 12 });
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(1);
    await overwriteTitle(r.env.db, 'proj_1', 'long', 'Wired the build', 'Done.', null);
    expect((r.sqlite.query(`SELECT title_material_at AS at, titled_at AS stamp FROM sessions WHERE session_id = 'long'`).get() as { at: number; stamp: number })).toEqual({ at: NOW, stamp: NOW });
    r.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ?`, [NOW + 1000]);
    expect(await backfillTitles(r.env, NOW + 5 * HOUR, 'idle')).toBe(0);
  });

  it('counts new prompts by the server\'s receipt time, so a member whose clock runs behind still gets its refresh', async () => {
    const r = rig();
    open(r, 'behind', { title: 'Wire the build', titledAt: NOW - 5 * HOUR, prompts: 12, clockBehind: 6 * HOUR });
    expect((await listTitleCandidates(r.env.db, windowAt(NOW), 5)).freshRefreshes.map((c) => c.sessionId)).toEqual(['behind']);
  });

  it('refreshes a session that was titled while idle, resumed, and then ended, leaving its end as it is', async () => {
    const r = rig();
    open(r, 'resumed', { title: 'Wire the build', titledAt: NOW - 5 * HOUR, prompts: 12, endedAt: NOW - 500 });
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(1);
    expect(r.runs().map((run) => [run.sessionId, run.mode])).toEqual([['resumed', 'refresh']]);
    expect(endedAt(r, 'resumed')).toBe(NOW - 500);
  });

  it('classifies a quiet session of imported transcripts as imported, as it does an ended one', async () => {
    const r = rig();
    open(r, 'quiet-import', { quietFor: 3 * HOUR });
    r.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, parsed_offset, first_received_at, last_received_at, token_id, imported_at)
                  VALUES ('proj_1', 'tx_qi', 'quiet-import', 'm1', 100, 100, ?, ?, 'tok_1', ?)`, [NOW, NOW, NOW]);
    expect(await titlingBackfillProgress(r.env, NOW)).toMatchObject({ owed: 0, remaining: 1 });
  });

  it('puts the stamp back when the ceiling refuses a refresh, and leaves the standing title alone', async () => {
    const r = rig();
    open(r, 'long', { title: 'Wire the build', titledAt: NOW - 5 * HOUR, prompts: 12 });
    const refused = await titleSession(r.env, { projectId: 'proj_1', sessionId: 'long', now: NOW, origin: ORIGIN },
      { mode: 'refresh', actor: TITLING_BACKFILL_ACTOR, ceiling: { actor: TITLING_BACKFILL_ACTOR, task: TITLING_TASK, perDay: 0, sinceMs: NOW - DAY } });
    expect(refused.outcome).toBe('ceiling');
    expect(r.titledAt('long')).toBe(NOW - 5 * HOUR);
    expect(r.runs()).toEqual([]);
    expect(await backfillTitles(r.env, NOW, 'idle')).toBe(1);
  });

  const settle = (r: ReturnType<typeof rig>, perDay: number) => r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { intervalSeconds: 0, maxRunsPerDay: perDay } } });

  describe('with the daily ceiling held by backlog', () => {
    /** An ended session more than a day old: backlog to the convergence. */
    const backlog = (r: ReturnType<typeof rig>, id: string, ago: number) => r.session(id, { imported: false, endedAt: NOW - 2 * DAY - ago });

    it('takes fresh work before backlog in the same wake, whatever the backlog\'s size', async () => {
      const r = rig();
      settle(r, 3);
      for (let i = 0; i < 8; i += 1) backlog(r, `old${i}`, i * 1000);
      r.session('new', { imported: false, endedAt: NOW - 1000 });
      // Fresh work is not capped by the share backlog may use, and backlog takes what that share leaves.
      expect(await backfillTitles(r.env, NOW, 'idle')).toBe(2);
      expect(r.runs().map((run) => run.sessionId).sort()).toEqual(['new', 'old0']);
      // With more fresh work than a page holds, no backlog goes.
      const crowded = rig();
      for (let i = 0; i < 7; i += 1) crowded.session(`fresh${i}`, { imported: false, endedAt: NOW - 1000 - i });
      for (let i = 0; i < 4; i += 1) backlog(crowded, `old${i}`, i * 1000);
      expect(await backfillTitles(crowded.env, NOW, 'idle')).toBe(TITLING_BACKFILL_BATCH);
      expect(crowded.runs().every((run) => run.sessionId.startsWith('fresh'))).toBe(true);
    });

    it('holds a third of the ceiling for fresh work, so a session ending after the backlog drained the rest is still titled the same day', async () => {
      const r = rig();
      settle(r, 6);
      for (let i = 0; i < 12; i += 1) backlog(r, `old${i}`, i * 1000);
      expect(freshReserve(6)).toBe(2);
      // Backlog alone may use four of the six runs.
      expect(await backfillTitles(r.env, NOW, 'idle')).toBe(4);
      expect(await backfillTitles(r.env, NOW + 1000, 'idle')).toBe(0);
      expect(r.runs()).toHaveLength(4);
      // New work, an ended session and a quiet open one, takes the two held runs.
      r.session('ended-later', { imported: false, endedAt: NOW + 2000 });
      open(r, 'went-quiet', { quietFor: -3000 + 3 * HOUR });
      expect(await backfillTitles(r.env, NOW + 3 * HOUR, 'idle')).toBe(2);
      expect(r.runs().slice(4).map((run) => run.sessionId).sort()).toEqual(['ended-later', 'went-quiet']);
      // The ceiling itself still holds.
      r.session('one-too-many', { imported: false, endedAt: NOW + 4000 });
      expect(await backfillTitles(r.env, NOW + 3 * HOUR + 1000, 'idle')).toBe(0);
      expect(r.runs()).toHaveLength(6);
    });
  });
});
