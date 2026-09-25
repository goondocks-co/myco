/**
 * The bounded backfill of imported sessions: off until an operator
 * turns it on, newest first over untitled imported sessions with parsed
 * material, one `claim` attempt per session through the live titling gate,
 * inside the block's interval and the Deployment-wide daily ceiling, and
 * stoppable through the same override the operator's switch writes.
 */
import { describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import type { PreparedStatement, RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import {
  backfillTitles, titleReadySessions, titleSession, titlingBackfillPolicy, titlingBackfillProgress, TITLING_BACKFILL_ACTOR, TITLING_BACKFILL_BATCH, TITLING_TASK,
} from '@myco-server-worker/core/titling.js';
import { TITLING_BACKFILL_SCHEDULE, SERVER_JOBS } from '@myco-server-worker/core/jobs.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import worker from '@myco-server-worker/index.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { listConvergenceTitleSessions, untitledReason } from '@myco-server-worker/read/children.js';
import { count, sqliteEnv, withHarness } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ORIGIN = 'https://s';

function rig() {
  const e = sqliteEnv();
  const launches: Array<{ runId: string }> = [];
  const env: ServerEnv = { ...withHarness(() => e.serverEnv, { launch: async (spec) => { launches.push(spec); } }), origin: ORIGIN, wake: async () => {} };
  const setting = (leaf: string, value: unknown) =>
    e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'mem_1')`, [leaf, JSON.stringify(value), NOW]);
  setting('agent.provider.type', 'openai-compatible');
  setting('agent.provider.model', 'm');
  setting('agent.provider.base_url', 'http://models.internal/v1');
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
    expect(TITLING_BACKFILL_SCHEDULE).toEqual({ enabled: false, intervalSeconds: 900, runIn: ['active', 'idle'], overlap: 'queue', maxRunsPerDay: 24 });
  });

  it('dispatches nothing while scheduling is off, or while its own block is off, and leaves no claim behind', async () => {
    const r = rig();
    r.session('s1');
    expect(await titlingBackfillPolicy(r.env)).toEqual({ scheduledTasksEnabled: false, backfillEnabled: false, runsPerDay: 24, intervalSeconds: 900, runIn: ['active', 'idle'], overlap: 'queue', enabled: false });
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
    r.session('older', { endedAt: NOW - DAY });
    r.session('newest', { endedAt: NOW - 1000 });
    r.session('middle', { endedAt: NOW - 3600_000, project: 'proj_2' });
    r.session('unparsed', { parsed: false });
    r.session('titled', { title: 'Already titled' });
    r.session('silent', { material: false });
    r.session('deleted');
    r.sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES ('proj_1', 'deleted', NULL, ?, 'mem_1')`, [NOW]);

    expect((await listConvergenceTitleSessions(r.env.db, 10, NOW, true)).map((c) => c.sessionId)).toEqual(['newest', 'middle', 'older']);
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

  it('reads the ended, untitled sessions through their own partial index', () => {
    const r = rig();
    const plan = (sql: string, binds: unknown[]) => (r.sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as { detail: string }[]).map((row) => row.detail);
    let captured = '';
    const store = { prepare: (sql: string) => { captured = sql; return { bind: () => ({ all: async () => ({ results: [] }), first: async () => null }) }; } } as unknown as RelationalStore;
    void listConvergenceTitleSessions(store, 5, NOW, true);
    expect(plan(captured, [NOW, 1, 5])[0]).toContain('USING INDEX idx_sessions_untitled_ended');
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
    const gate = (sql: string, kind: 'first' | 'all' | 'run'): Promise<void> | undefined => {
      const key = `${kind}:${sql}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return hold(sql, kind, n);
    };
    const wrap = (statement: PreparedStatement, sql: string): PreparedStatement => ({
      ...statement,
      bind: (...values) => wrap(statement.bind(...values), sql),
      first: async <T,>(...args: unknown[]) => { await gate(sql, 'first'); return (statement.first as (...a: unknown[]) => Promise<T | null>)(...args); },
      all: async <T,>(...args: unknown[]) => { await gate(sql, 'all'); return (statement.all as (...a: unknown[]) => Promise<{ results: T[] }>)(...args); },
      run: async (...args: unknown[]) => { await gate(sql, 'run'); return (statement.run as (...a: unknown[]) => Promise<never>)(...args); },
    } as PreparedStatement);
    return { ...db, prepare: (sql: string) => wrap(db.prepare(sql), sql) };
  }

  const isCeilingCount = (sql: string) => sql.includes('COUNT(*) AS c FROM agent_runs') && sql.includes("status != 'skipped'");
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
    const insertLanded: Array<() => void> = [];
    const afterInsert = (n: number) => new Promise<void>((resolve) => { if (inserts >= n) resolve(); else insertLanded[n] = resolve; });
    const env: ServerEnv = { ...r.env, db: staged(r.env.db, (sql, kind, n) => {
      if (kind === 'first' && isCeilingCount(sql)) { counted += 1; if (counted === wakes) releaseCounts(); return allCounted; }
      if (kind === 'all' && isCandidateList(sql) && n > 1) return afterInsert(n - 1);
      if (kind === 'run' && isRunInsert(sql)) return Promise.resolve().then(() => { inserts += 1; insertLanded[inserts]?.(); });
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
    const cookie = await ownerCookie();
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
    r.setting('agent.tasks', { 'extract-curate': { schedule: { maxRunsPerDay: 3 } }, [TITLING_TASK]: { model: 'small', schedule: { maxRunsPerDay: 9 } } });
    expect(await (await request('PUT', { enabled: true })).json()).toMatchObject({ enabled: true, backfillEnabled: true, runsPerDay: 9 });
    expect(JSON.parse(stored()!)).toEqual({ 'extract-curate': { schedule: { maxRunsPerDay: 3 } }, [TITLING_TASK]: { model: 'small', schedule: { maxRunsPerDay: 9, enabled: true } } });
    const tick = await runTick(r.env, NOW);
    expect(tick.jobs.find((j) => j.name === 'titling-backfill')).toEqual({ name: 'titling-backfill', changed: 1, failed: null });
    expect(await (await request('PUT', { enabled: false })).json()).toMatchObject({ enabled: false, backfillEnabled: false, inFlight: 1 });
    r.session('b');
    expect((await runTick(r.env, NOW + 1)).jobs.find((j) => j.name === 'titling-backfill')).toEqual({ name: 'titling-backfill', changed: 0, failed: null });
    expect(r.runs().length).toBe(1);
  });
});
