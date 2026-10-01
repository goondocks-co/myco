/**
 * The clock's own dispatches: each gate by name, in the 1.4 order, and what
 * a wake leaves behind — a run queued for a worker, a skipped row where a
 * ceiling is met, and nothing at all where the switch is off.
 */
import { describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import type { PreparedStatement, RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import { HARNESS_AGENT_ID } from '@myco-server-worker/core/harness.js';
import { ACTIVE_WINDOW_DAYS_DEFAULT, CLOCK_ACTOR, COLD_PROJECT_THRESHOLD_DAYS_DEFAULT, decideTask, effectiveIntervalSeconds, hasUnprocessedPrompts, PRE_CONDITIONS, readScheduleFacts, resolveSchedule, runScheduledTasks, scheduledTasks, scheduleFor, scheduleLeaves } from '@myco-server-worker/core/scheduled-tasks.js';
import { TASK_SCHEDULE, type TaskSchedule } from '@myco-server-worker/core/jobs.js';
import { MAP_TASK, TASK_ADMISSION } from '@myco-server-worker/core/task-catalogue.js';
import { hasLiveTaskRun, INPUT_UNCHANGED, lastTaskEntryAt, skipContext, taskEntriesSince, taskFactsKey, taskRunFacts } from '@myco-server-worker/core/runs.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { seedCredential } from './helpers/d1.js';
import { sqliteEnv, withHarness } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ORIGIN = 'https://s';
/** The task the clock schedules on its own: extraction, which a worker serves. */
const TASK = 'extract-curate';
/** A plain daily schedule, for the gates a declared one would hide behind its precondition and reserve. */
const PLAIN: TaskSchedule = { intervalSeconds: 86_400, runIn: ['sleep'], overlap: 'skip', maxRunsPerDay: 2 };
/** An owner override that leaves extraction no reserve, so a ceiling is the ceiling it names. */
const NO_RESERVE = { reservedRunsPerDay: { count: 0, preCondition: 'has-recent-live-prompts' } };

function fixture(opts: { bound?: boolean } = {}) {
  const e = sqliteEnv();
  const launches: Array<{ runId: string; envVars: Record<string, string> }> = [];
  const base = opts.bound === false ? e.serverEnv : withHarness(() => e.serverEnv, { launch: async (spec) => { launches.push(spec); } });
  const env: ServerEnv = { ...base, wake: async () => {} };
  const setting = (leaf: string, value: unknown) => e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'mem_1')`, [leaf, JSON.stringify(value), NOW]);
  const token = seedCredential(e.sqlite, { id: 'mt_seed' });
  const receipt = (projectId: string, at: number) => e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES (?, ?, 'machine_1', ?, ?, ?, 'claude-code')`, [projectId, `s_${projectId}_${at}`, token, at, at]);
  const capability = (projectId: string, name: string, on: boolean) => e.sqlite.run(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?, 'mem_1')`, [projectId, name, on ? 1 : 0, NOW]);
  const runs = (projectId: string) => e.sqlite.query(`SELECT id, task, status, run_context AS runContext, started_at AS startedAt FROM agent_runs WHERE project_id = ? ORDER BY COALESCE(queued_at, started_at), id`).all(projectId) as Array<{ id: string; task: string; status: string; runContext: string | null; startedAt: number | null }>;
  // A Project with an ended session holding a prompt extraction has not read, last heard from at `at`.
  const backlog = (projectId: string, at: number) => {
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at) VALUES (?, ?, 'machine_1', ?, ?, ?, 'claude-code', ?, ?)`,
      [projectId, `s_backlog_${projectId}`, token, at, at, at, at]);
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at, processed) VALUES (?, ?, ?, ?, 'hello there', 'user', ?, ?, ?, ?, ?, 0)`,
      [projectId, `s_backlog_${projectId}`, `p_backlog_${projectId}`, `e_backlog_${projectId}`, `h_backlog_${projectId}`, at, at, token, at]);
  };
  setting('agent.scheduled_tasks_enabled', true);
  capability('proj_1', 'vault_evolution', true);
  capability('proj_2', 'vault_evolution', true);
  return { ...e, env, launches, setting, receipt, backlog, capability, runs };
}

describe('the schedule envelope', () => {
  it('catalogues every schedule and its precondition', () => {
    expect(scheduledTasks().map((t) => t.task)).toEqual([TASK]);
    for (const task of Object.keys(TASK_SCHEDULE)) expect({ task, catalogued: task in TASK_ADMISSION }).toEqual({ task, catalogued: true });
    for (const task of Object.keys(TASK_ADMISSION)) expect({ task, scheduled: task in TASK_SCHEDULE }).toEqual({ task, scheduled: true });
    for (const { task, schedule } of scheduledTasks()) {
      if (schedule.preCondition !== undefined) expect({ task, registered: schedule.preCondition in PRE_CONDITIONS }).toEqual({ task, registered: true });
    }
  });

  it('lays an owner override over the declared block field by field, replacing an accelerator whole and refusing a malformed field', () => {
    expect(resolveSchedule(PLAIN, undefined)).toEqual(PLAIN);
    expect(resolveSchedule(PLAIN, { intervalSeconds: 3600, runIn: ['active', 'idle'], maxRunsPerDay: 5, overlap: 'queue', runWhenCold: true })).toEqual({ intervalSeconds: 3600, runIn: ['active', 'idle'], maxRunsPerDay: 5, overlap: 'queue', runWhenCold: true });
    expect(resolveSchedule(PLAIN, { intervalSeconds: -1, runIn: ['awake'], overlap: 'never', accelerator: { name: 'x' } })).toEqual(PLAIN);
    expect(resolveSchedule(PLAIN, { accelerator: { name: 'pending', thresholds: { steady: 10, accelerated: 100 } } }).accelerator).toEqual({ name: 'pending', thresholds: { steady: 10, accelerated: 100 } });
    expect(scheduleFor(TASK, PLAIN, { [TASK]: { schedule: { intervalSeconds: 60 } } }).intervalSeconds).toBe(60);
    expect(scheduleFor(TASK, PLAIN, { [TASK]: 'nope' })).toEqual(PLAIN);
  });

  it('shortens the interval by tier under backlog', () => {
    const t = { steady: 50, accelerated: 500 };
    expect(effectiveIntervalSeconds(1200, null, t)).toBe(1200);
    expect(effectiveIntervalSeconds(1200, 50, t)).toBe(1200);
    expect(effectiveIntervalSeconds(1200, 51, t)).toBe(300);
    expect(effectiveIntervalSeconds(1200, 501, t)).toBe(100);
    expect(effectiveIntervalSeconds(1200, 999, undefined)).toBe(1200);
  });
});

describe('a schedule naming something the Deployment never registered', () => {
  const leaves = { enabled: true, coldThresholdDays: 14, activeWindowDays: 14, overrides: {} };
  const inherited = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'];

  it('refuses a precondition named after an inherited member, rather than taking it for a registration', async () => {
    const f = fixture();
    for (const name of inherited) {
      const schedule: TaskSchedule = { ...PLAIN, preCondition: name };
      expect({ name, decided: await decideTask(f.env, 'proj_1', NOW - DAY, TASK, schedule, 'sleep', leaves, NOW) })
        .toEqual({ name, decided: 'precondition' });
    }
  });

  it('shortens no interval for an accelerator named after an inherited member', async () => {
    const f = fixture();
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
    // An entry a day old: inside a day's interval, outside a shortened one.
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'earlier', ?, 'extract-curate', 'completed', ?)`, [HARNESS_AGENT_ID, NOW - 7_200_000]);
    for (const name of inherited) {
      const schedule: TaskSchedule = { ...PLAIN, accelerator: { name, thresholds: { steady: 1, accelerated: 2 } } };
      expect({ name, decided: await decideTask(f.env, 'proj_1', NOW - DAY, TASK, schedule, 'sleep', leaves, NOW) })
        .toEqual({ name, decided: 'not_yet' });
    }
  });
});

describe('a named precondition reads the Project it is a condition on', () => {
  const seedSession = (f: ReturnType<typeof fixture>, project: string, session: string, endedAt: number | null) =>
    f.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at) VALUES (?, ?, 'm1', 'tok_1', ?, ?, 'claude-code', ?, ?)`,
      [project, session, NOW - 10_000, NOW, NOW - 10_000, endedAt]);
  const seedPrompt = (f: ReturnType<typeof fixture>, project: string, session: string, prompt: string, processed: number) =>
    f.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at, processed) VALUES (?, ?, ?, ?, 'hello there', 'user', ?, ?, ?, 'tok_1', ?, ?)`,
      [project, session, prompt, `e_${prompt}`, `h_${prompt}`, NOW - 5_000, NOW - 5_000, NOW - 5_000, processed]);

  it('answers the backlog: nothing, a prompt already read, a live session, then one waiting', async () => {
    const f = fixture();
    expect(await hasUnprocessedPrompts(f.env.db, 'proj_1')).toBe(false);
    seedSession(f, 'proj_1', 's_done', NOW);
    seedPrompt(f, 'proj_1', 's_done', 'p_read', 1);
    expect(await hasUnprocessedPrompts(f.env.db, 'proj_1')).toBe(false);
    // A prompt of a session still being written is no backlog yet.
    seedSession(f, 'proj_1', 's_live', null);
    seedPrompt(f, 'proj_1', 's_live', 'p_live', 0);
    expect(await hasUnprocessedPrompts(f.env.db, 'proj_1')).toBe(false);
    seedPrompt(f, 'proj_1', 's_done', 'p_waiting', 0);
    expect(await hasUnprocessedPrompts(f.env.db, 'proj_1')).toBe(true);
    // One Project's backlog is not another's.
    expect(await hasUnprocessedPrompts(f.env.db, 'proj_2')).toBe(false);
  });

  it('is reached through the registry the clock consults, and holds a task back while the backlog is empty', async () => {
    const f = fixture();
    const check = PRE_CONDITIONS['has-unprocessed-prompts'];
    expect(typeof check).toBe('function');
    expect(await check!({ db: f.env.db, projectId: 'proj_1', now: NOW })).toBe(false);
    const gated: TaskSchedule = { ...PLAIN, preCondition: 'has-unprocessed-prompts' };
    expect(await decideTask(f.env, 'proj_1', NOW - DAY, TASK, gated, 'sleep', { enabled: true, coldThresholdDays: 14, activeWindowDays: 14, overrides: {} }, NOW)).toBe('precondition');
    seedSession(f, 'proj_1', 's_done', NOW);
    seedPrompt(f, 'proj_1', 's_done', 'p_waiting', 0);
    expect(await decideTask(f.env, 'proj_1', NOW - DAY, TASK, gated, 'sleep', { enabled: true, coldThresholdDays: 14, activeWindowDays: 14, overrides: {} }, NOW)).toBeNull();
  });

  it('queues extraction from its declared schedule only after an ended session has unread prompts', async () => {
    const f = fixture();
    seedSession(f, 'proj_1', 's_done', NOW);
    expect(await runScheduledTasks(f.env, 'idle', NOW, ORIGIN)).toEqual({ dispatched: 0, skipped: 0 });
    seedPrompt(f, 'proj_1', 's_done', 'p_waiting', 0);
    expect(await runScheduledTasks(f.env, 'idle', NOW, ORIGIN)).toEqual({ dispatched: 1, skipped: 0 });
    expect(f.runs('proj_1')).toMatchObject([{ task: 'extract-curate', status: 'queued' }]);
    expect(f.launches).toEqual([]);
    expect(await runScheduledTasks(f.env, 'idle', NOW + 1, ORIGIN)).toEqual({ dispatched: 0, skipped: 0 });
  });
});

describe('the leaves the clock reads', () => {
  it('is off until the owner turns scheduling on, with the 1.4 defaults for the recency gates', async () => {
    const f = fixture();
    f.sqlite.run(`DELETE FROM deployment_settings WHERE leaf = 'agent.scheduled_tasks_enabled'`);
    expect(await scheduleLeaves(f.env)).toEqual({ enabled: false, coldThresholdDays: COLD_PROJECT_THRESHOLD_DAYS_DEFAULT, activeWindowDays: ACTIVE_WINDOW_DAYS_DEFAULT, overrides: { 'canopy-map': { schedule: { enabled: false } } } });
    f.setting('agent.scheduled_tasks_enabled', true);
    f.setting('agent.cold_project_threshold_days', 3);
    f.setting('agent.tasks', { [TASK]: { schedule: { intervalSeconds: 60 } } });
    expect(await scheduleLeaves(f.env)).toMatchObject({ enabled: true, coldThresholdDays: 3, overrides: { [TASK]: { schedule: { intervalSeconds: 60 } } } });
    // The map refresh stays off until its own leaf turns it on, whatever the task override says.
    f.setting('agent.tasks', { 'canopy-map': { schedule: { enabled: true } } });
    expect((await scheduleLeaves(f.env)).overrides['canopy-map']).toEqual({ schedule: { enabled: false } });
    f.setting('cortex.canopy.refresh.background_enabled', true);
    expect((await scheduleLeaves(f.env)).overrides['canopy-map']).toEqual({ schedule: { enabled: true } });
    f.setting('cortex.canopy.refresh.background_period_minutes', 90);
    expect((await scheduleLeaves(f.env)).overrides['canopy-map']).toEqual({ schedule: { intervalSeconds: 5400, enabled: true } });
    f.setting('cortex.canopy.refresh.background_enabled', false);
    expect((await scheduleLeaves(f.env)).overrides['canopy-map']).toMatchObject({ schedule: { enabled: false } });
  });
});

describe('each gate, by name, in order', () => {
  const leaves = { enabled: true, coldThresholdDays: 14, activeWindowDays: 14, overrides: {} };
  const decide = (f: ReturnType<typeof fixture>, last: number | null, schedule: TaskSchedule = PLAIN, state: 'active' | 'idle' | 'sleep' = 'sleep', now = NOW, project = 'proj_1') =>
    decideTask(f.env, project, last, TASK, schedule, state, leaves, now);

  it('leaves a quiet Project, a cold one, and one without the capability alone', async () => {
    const f = fixture();
    expect(await decide(f, null)).toBe('quiet');
    expect(await decide(f, NOW - 15 * DAY)).toBe('quiet');
    expect(await decide(f, NOW - 10 * DAY, PLAIN, 'sleep', NOW, 'proj_1')).toBeNull();
    expect(await decide(f, NOW - 10 * DAY, PLAIN, 'sleep', NOW, 'proj_1')).toBeNull();
    const cold = { ...leaves, coldThresholdDays: 5 };
    expect(await decideTask(f.env, 'proj_1', NOW - 10 * DAY, TASK, PLAIN, 'sleep', cold, NOW)).toBe('cold');
    expect(await decideTask(f.env, 'proj_1', NOW - 10 * DAY, TASK, { ...PLAIN, runWhenCold: true }, 'sleep', cold, NOW)).toBeNull();
    f.capability('proj_1', 'vault_evolution', false);
    expect(await decide(f, NOW - DAY)).toBe('capability_off');
  });

  it('skips a task already live under the skip policy, waits out the interval, keeps to its states, honours a named precondition, and meets its ceiling once a day', async () => {
    const f = fixture();
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'live', ?, 'extract-curate', 'running', ?)`, [HARNESS_AGENT_ID, NOW - 60_000]);
    expect(await decide(f, NOW - DAY)).toBe('already_running');
    expect(await decide(f, NOW - DAY, { ...PLAIN, enabled: false })).toBe('disabled');
    expect(await decide(f, NOW - DAY, { ...PLAIN, overlap: 'queue' })).toBe('not_yet');
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE id = 'live'`, [NOW - 59_000]);
    expect(await decide(f, NOW - DAY)).toBe('not_yet');
    expect(await decide(f, NOW - DAY, PLAIN, 'sleep', NOW + DAY)).toBeNull();
    expect(await decide(f, NOW - DAY, PLAIN, 'active', NOW + DAY)).toBe('not_in_state');
    expect(await decide(f, NOW - DAY, { ...PLAIN, preCondition: 'never-registered' }, 'sleep', NOW + DAY)).toBe('precondition');
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'earlier', ?, 'extract-curate', 'completed', ?)`, [HARNESS_AGENT_ID, NOW + DAY - 3_600_000]);
    expect(await decide(f, NOW - DAY, { ...PLAIN, intervalSeconds: 1, maxRunsPerDay: 1 }, 'sleep', NOW + DAY)).toBe('max_runs_per_day');
    expect(await decide(f, NOW - DAY, { ...PLAIN, intervalSeconds: 1, maxRunsPerDay: 3 }, 'sleep', NOW + DAY)).toBeNull();
  });
});

describe('one wake of the clock', () => {
  it('queues extraction for each Project that qualifies, attributes it to the clock, and does nothing twice', async () => {
    const f = fixture();
    f.backlog('proj_1', NOW - 3_600_000);
    f.backlog('proj_2', NOW - 20 * DAY);
    const first = await runScheduledTasks(f.env, 'sleep', NOW, ORIGIN);
    expect(first).toEqual({ dispatched: 1, skipped: 0 });
    expect(f.runs('proj_1').map((r) => [r.task, r.status])).toEqual([[TASK, 'queued']]);
    expect(f.runs('proj_2')).toEqual([]);
    expect(await taskEntriesSince(f.env.db, { projectId: 'proj_1' }, TASK, 0, CLOCK_ACTOR)).toBe(1);
    // A worker serves the run: the clock launches nothing in this process.
    expect(f.launches).toEqual([]);
    expect(await runScheduledTasks(f.env, 'sleep', NOW + 1, ORIGIN)).toEqual({ dispatched: 0, skipped: 0 });
    expect(f.runs('proj_1')).toHaveLength(1);
  });

  it('refuses at the ceiling rather than queueing, records one row per episode however many wakes ask, and dispatches again when the window has room', async () => {
    const f = fixture();
    f.backlog('proj_1', NOW - 3_600_000);
    f.setting('agent.tasks', { [TASK]: { schedule: { intervalSeconds: 1, maxRunsPerDay: 1, ...NO_RESERVE } } });
    expect(await runScheduledTasks(f.env, 'sleep', NOW, ORIGIN)).toEqual({ dispatched: 1, skipped: 0 });
    // The run finishes; the interval is past; the day's one run is spent.
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE task = 'extract-curate'`, [NOW + 1_000]);
    expect(await runScheduledTasks(f.env, 'sleep', NOW + 5_000, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    const rows = f.runs('proj_1');
    expect(rows.map((r) => r.status)).toEqual(['completed', 'skipped']);
    expect(JSON.parse(rows[1]!.runContext!)).toEqual({ reason: 'max_runs_per_day' });
    // A ceiling is not a queue: nothing waits for capacity.
    expect(rows.filter((r) => r.status === 'queued')).toEqual([]);

    // Two more wakes inside the same episode: each answers the ceiling, and the
    // record of it stays one row rather than one per wake.
    expect(await runScheduledTasks(f.env, 'sleep', NOW + 60_000, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    expect(await runScheduledTasks(f.env, 'sleep', NOW + 120_000, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    expect(f.runs('proj_1').map((r) => r.status)).toEqual(['completed', 'skipped']);

    // An episode is not a calendar day: a wake on the far side of the next UTC
    // midnight, with the same window still full, adds no second row.
    const midnight = Math.ceil((NOW + 120_000) / DAY) * DAY;
    expect(await runScheduledTasks(f.env, 'sleep', midnight + 1_000, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    expect(f.runs('proj_1').map((r) => r.status)).toEqual(['completed', 'skipped']);

    // The trailing day has room again: the next wake dispatches, with nothing
    // owed for the wakes that refused.
    expect(await runScheduledTasks(f.env, 'sleep', NOW + DAY + 5_000, ORIGIN)).toEqual({ dispatched: 1, skipped: 0 });
    expect(f.runs('proj_1').map((r) => r.status)).toEqual(['completed', 'skipped', 'queued']);

    // A SECOND episode leaves a second row: the record is once per episode, not
    // once per Project and task for all time.
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE status = 'queued'`, [NOW + DAY + 6_000]);
    expect(await runScheduledTasks(f.env, 'sleep', NOW + DAY + 10_000, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    expect(f.runs('proj_1').map((r) => r.status)).toEqual(['completed', 'skipped', 'completed', 'skipped']);

    f.setting('agent.scheduled_tasks_enabled', false);
    expect(await runScheduledTasks(f.env, 'sleep', NOW + 2 * DAY, ORIGIN)).toEqual({ dispatched: 0, skipped: 0 });
  });

  it('keeps two episodes apart when both fall on one calendar day, a ceiling above one letting them sit minutes apart', async () => {
    const f = fixture();
    f.backlog('proj_1', NOW - 3_600_000);
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
    // Two entries just under a day apart: both sit inside the trailing window
    // until the older one ages out of it, ten minutes later.
    const older = NOW + 3_600_000;
    const newer = older + DAY - 10 * 60_000;
    for (const [id, at] of [['e_older', older], ['e_newer', newer]] as const) {
      f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec) VALUES ('proj_1', ?, ?, 'extract-curate', 'completed', ?, ?, ?)`, [id, HARNESS_AGENT_ID, at, at, JSON.stringify({ actor: CLOCK_ACTOR })]);
    }
    f.setting('agent.tasks', { [TASK]: { schedule: { intervalSeconds: 1, maxRunsPerDay: 2, ...NO_RESERVE } } });

    // The first episode: both entries in the window, so the ceiling is met.
    const firstRefusal = newer + 60_000;
    expect(await runScheduledTasks(f.env, 'sleep', firstRefusal, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    expect(f.runs('proj_1').filter((r) => r.status === 'skipped')).toHaveLength(1);

    // The older entry ages out, a run goes through, and the ceiling closes again
    // — a second episode, on the same calendar day as the first.
    const freed = older + DAY + 60_000;
    expect(await runScheduledTasks(f.env, 'sleep', freed, ORIGIN)).toEqual({ dispatched: 1, skipped: 0 });
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE status = 'queued'`, [freed + 1_000]);
    expect(await runScheduledTasks(f.env, 'sleep', freed + 2_000, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    expect(Math.floor(newer / DAY)).toBe(Math.floor(freed / DAY));
    expect(f.runs('proj_1').filter((r) => r.status === 'skipped')).toHaveLength(2);
  });

  it('refuses a ceiling of zero with no entry to name, and records that once however many wakes ask', async () => {
    const f = fixture();
    f.backlog('proj_1', NOW - 3_600_000);
    f.setting('agent.tasks', { [TASK]: { schedule: { intervalSeconds: 1, maxRunsPerDay: 0, ...NO_RESERVE } } });
    for (const at of [NOW, NOW + 60_000, NOW + DAY + 60_000]) {
      expect({ at, report: await runScheduledTasks(f.env, 'sleep', at, ORIGIN) }).toEqual({ at, report: { dispatched: 0, skipped: 1 } });
    }
    const rows = f.runs('proj_1');
    expect(rows.map((r) => r.status)).toEqual(['skipped']);
    expect(JSON.parse(rows[0]!.runContext!)).toEqual({ reason: 'max_runs_per_day' });
  });

  it('writes one row for one task when two wakes decide at once: the write refuses beside a live run', async () => {
    const f = fixture();
    f.backlog('proj_1', NOW - 3_600_000);
    // The second wake reads the same answers the first read, and its write meets the first's row.
    let raced = false;
    const racing: ServerEnv = { ...f.env, db: { ...f.env.db, prepare: (sql: string) => {
      if (!raced && sql.includes(`?, 'queued', ?`)) {
        raced = true;
        f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?) ON CONFLICT DO NOTHING`, [HARNESS_AGENT_ID, NOW]);
        f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at) VALUES ('proj_1', 'other-wake', ?, 'extract-curate', 'queued', ?)`, [HARNESS_AGENT_ID, NOW]);
      }
      return f.env.db.prepare(sql);
    } } };
    expect(await runScheduledTasks(racing, 'sleep', NOW, ORIGIN)).toEqual({ dispatched: 0, skipped: 0 });
    expect(f.runs('proj_1').map((r) => r.id)).toEqual(['other-wake']);
  });
});

describe('the tick and the clock', () => {
  it('schedules from the origin the operator declared, and schedules nothing where none is declared', async () => {
    const f = fixture();
    f.backlog('proj_1', NOW - 40 * 60_000);
    expect((await runTick(f.env, NOW)).scheduled).toEqual({ dispatched: 0, skipped: 0 });
    f.env.origin = 'https://myco.example';
    const report = await runTick(f.env, NOW);
    expect(report.state).toBe('sleep');
    expect(report.scheduled).toEqual({ dispatched: 1, skipped: 0 });
    expect(f.runs('proj_1')[0]).toMatchObject({ task: TASK, status: 'queued' });
    void CLOCK_ACTOR;
  });
});

describe('automatic extraction reserves capacity for recent live sessions', () => {
  it('holds history after nine automatic runs, admits ready live capture, and stops all automatic work at twelve', async () => {
    const f = fixture();
    f.capability('proj_1', 'vault_evolution', true);
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
    const entry = (id: string, actor: string, at = NOW - 7_200_000) => f.sqlite.run(`INSERT INTO agent_runs
      (project_id,id,agent_id,task,status,started_at,dispatch_spec) VALUES ('proj_1',?,?,'extract-curate','completed',?,?)`,
      [id, HARNESS_AGENT_ID, at, JSON.stringify({ actor })]);
    for (let i = 0; i < 9; i++) entry(`automatic_${i}`, CLOCK_ACTOR);
    for (let i = 0; i < 10; i++) entry(`manual_${i}`, 'mem_owner', NOW - 1);
    f.sqlite.run(`INSERT INTO sessions (project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,ended_at)
      VALUES ('proj_1','recent','m','t',1,?,?)`, [NOW, NOW - 1_000]);
    f.sqlite.run(`INSERT INTO prompt_batches (project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at)
      VALUES ('proj_1','recent','p','e','a durable finding','user','h',1,1,'t',1)`);
    const schedule = TASK_SCHEDULE['extract-curate']!;
    const leaves = await scheduleLeaves(f.env);
    const decide = () => decideTask(f.env, 'proj_1', NOW, 'extract-curate', schedule, 'idle', leaves, NOW);
    expect(await taskEntriesSince(f.db, { projectId: 'proj_1' }, 'extract-curate', NOW - DAY, CLOCK_ACTOR)).toBe(9);
    expect(await lastTaskEntryAt(f.db, { projectId: 'proj_1' }, 'extract-curate', CLOCK_ACTOR)).toBe(NOW - 7_200_000);
    expect(await decide()).toBe('reserved_runs_per_day');
    f.sqlite.run(`INSERT INTO transcripts (project_id,transcript_id,session_id,machine_id,size,parsed_offset,first_received_at,last_received_at,token_id,fidelity,imported_at)
      VALUES ('proj_1','tx','recent','m',100,100,1,1,'t','full',1)`);
    expect(await decide()).toBe('reserved_runs_per_day');
    f.sqlite.run(`UPDATE transcripts SET imported_at = NULL, parsed_offset = 50 WHERE transcript_id = 'tx'`);
    expect(await decide()).toBe('precondition');
    f.sqlite.run(`UPDATE transcripts SET parsed_offset = size WHERE transcript_id = 'tx'`);
    expect(await decide()).toBeNull();
    f.sqlite.run(`UPDATE sessions SET ended_at = ? WHERE session_id = 'recent'`, [NOW - DAY - 1]);
    expect(await decide()).toBe('reserved_runs_per_day');
    f.sqlite.run(`UPDATE sessions SET ended_at = ? WHERE session_id = 'recent'`, [NOW - 1_000]);
    for (let i = 9; i < 12; i++) entry(`automatic_${i}`, CLOCK_ACTOR);
    expect(await decide()).toBe('max_runs_per_day');
    expect(f.sqlite.query(`SELECT processed FROM prompt_batches WHERE prompt_id = 'p'`).get()).toEqual({ processed: 0 });
    f.sqlite.run(`UPDATE agent_runs SET started_at = ? WHERE id = 'automatic_0'`, [NOW - DAY - 1]);
    expect(await decide()).toBeNull();
    expect(resolveSchedule(schedule, { reservedRunsPerDay: { count: 0, preCondition: 'has-recent-live-prompts' } }).reservedRunsPerDay?.count).toBe(0);
    expect(resolveSchedule(schedule, { reservedRunsPerDay: { count: -1, preCondition: 'has-recent-live-prompts' } }).reservedRunsPerDay?.count).toBe(3);
  });
});

describe('one wake\'s scheduling across many Projects (#1510)', () => {
  /** The store calls a wake's scheduling makes: each statement run alone, and each batch as one. */
  function counted(f: ReturnType<typeof fixture>) {
    let trips = 0;
    const statement = (inner: PreparedStatement): PreparedStatement => ({
      ...inner,
      bind: (...values: unknown[]) => statement(inner.bind(...values)),
      first: <T,>() => { trips += 1; return inner.first<T>(); },
      all: <T,>() => { trips += 1; return inner.all<T>(); },
      run: () => { trips += 1; return inner.run(); },
    });
    const db: RelationalStore = { prepare: (sql) => statement(f.env.db.prepare(sql)), batch: (statements) => { trips += 1; return f.env.db.batch(statements); } };
    return { env: { ...f.env, db }, trips: () => trips };
  }

  /** A wake's store calls with `projects` live Projects, each with one of the scheduled tasks' capabilities on and one off. */
  async function tripsWith(projects: number, state: 'active' | 'idle'): Promise<number> {
    const f = fixture();
    f.setting('cortex.canopy.refresh.background_enabled', true);
    f.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [NOW]);
    for (let n = 0; n < projects; n += 1) {
      const projectId = `proj_many_${n}`;
      f.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [projectId, projectId, NOW]);
      f.receipt(projectId, NOW - 60_000);
      f.capability(projectId, 'canopy', true);
      f.capability(projectId, 'vault_evolution', false);
      // A clock-dispatched map run two days old: the interval has passed, so the wake reads it and goes on.
      f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec) VALUES (?, ?, 'myco-agent', 'canopy-map', 'completed', ?, ?, ?)`,
        [projectId, `run_old_${n}`, NOW - 2 * DAY, NOW - 2 * DAY, JSON.stringify({ actor: CLOCK_ACTOR })]);
    }
    const { env, trips } = counted(f);
    expect(await runScheduledTasks(env, state, NOW, ORIGIN)).toEqual({ dispatched: 0, skipped: 0 });
    return trips();
  }

  it('reads the same number of times whether it holds one Project or twelve', async () => {
    // No scheduled task runs at `active`: every one is decided on what the wake read up front, and none reaches a
    // condition of its own.
    expect(scheduledTasks().filter(({ schedule }) => schedule.runIn.includes('active'))).toEqual([]);
    const one = await tripsWith(1, 'active');
    const twelve = await tripsWith(12, 'active');
    expect({ one, twelve }).toEqual({ one, twelve: one });
    expect(one).toBeLessThanOrEqual(4);
  });

  it('decides each Project and task on the same facts a read of that Project alone answers', async () => {
    const f = fixture();
    f.receipt('proj_1', NOW - 60_000);
    f.receipt('proj_2', NOW - 60_000);
    f.capability('proj_1', 'canopy', true);
    f.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [NOW]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, dispatch_spec) VALUES ('proj_1', 'run_live', 'myco-agent', 'canopy-map', 'running', ?, ?)`, [NOW - 1_000, JSON.stringify({ actor: CLOCK_ACTOR })]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec) VALUES ('proj_2', 'run_done', 'myco-agent', 'canopy-map', 'completed', ?, ?, ?)`, [NOW - 2 * DAY, NOW - 2 * DAY, JSON.stringify({ actor: CLOCK_ACTOR })]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec) VALUES ('proj_2', 'run_owner', 'myco-agent', 'canopy-map', 'completed', ?, ?, ?)`, [NOW - 1_000, NOW - 500, JSON.stringify({ actor: 'mem_owner' })]);
    // Each live status alone in its Project and task, so a read that misses one answers a different fact.
    f.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_3', 'proj_3', ?)`, [NOW]);
    f.receipt('proj_3', NOW - 60_000);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, dispatch_spec) VALUES ('proj_3', 'run_pending', 'myco-agent', 'canopy-map', 'pending', ?)`, [JSON.stringify({ actor: CLOCK_ACTOR })]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, dispatch_spec) VALUES ('proj_1', 'run_queued', 'myco-agent', 'extract-curate', 'queued', ?, ?)`, [NOW - 2_000, JSON.stringify({ actor: CLOCK_ACTOR })]);
    // The clock's entry the platform replaced: the interval reads it, the day's ceiling does not.
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec, run_context) VALUES ('proj_2', 'run_replaced', 'myco-agent', 'canopy-map', 'completed', ?, ?, ?, ?)`, [NOW - 3_000, NOW - 2_500, JSON.stringify({ actor: CLOCK_ACTOR }), JSON.stringify({ replaced: true })]);
    // A skip for unchanged input is the interval's entry; a skip for any other reason is nobody's.
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, run_context) VALUES ('proj_2', 'run_unchanged', 'myco-agent', 'extract-curate', 'skipped', ?, ?, ?)`, [NOW - 500, NOW - 500, skipContext(INPUT_UNCHANGED)]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, run_context) VALUES ('proj_2', 'run_ceiling', 'myco-agent', 'extract-curate', 'skipped', ?, ?, ?)`, [NOW - 100, NOW - 100, skipContext('max_runs_per_day')]);
    // Another actor's entries, newer than the clock's own and inside the day.
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec) VALUES ('proj_3', 'run_clock', 'myco-agent', 'extract-curate', 'completed', ?, ?, ?)`, [NOW - 4_000, NOW - 3_500, JSON.stringify({ actor: CLOCK_ACTOR })]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec) VALUES ('proj_3', 'run_other', 'myco-agent', 'extract-curate', 'completed', ?, ?, ?)`, [NOW - 1_000, NOW - 900, JSON.stringify({ actor: 'mem_owner' })]);
    const tasks = scheduledTasks({ [MAP_TASK]: { schedule: { enabled: true } } }).map(({ task }) => task);
    expect(tasks).toEqual([MAP_TASK, TASK]);
    const whole = await readScheduleFacts(f.env, tasks, NOW);
    // The fixture holds each case the reads tell apart, so agreeing below is agreeing on each of them.
    expect([
      whole.runs.get(taskFactsKey('proj_3', 'canopy-map'))?.live,
      whole.runs.get(taskFactsKey('proj_1', 'extract-curate'))?.live,
      whole.runs.get(taskFactsKey('proj_2', 'canopy-map')),
      whole.runs.get(taskFactsKey('proj_2', 'extract-curate')),
      whole.runs.get(taskFactsKey('proj_3', 'extract-curate')),
    ]).toEqual([
      true,
      true,
      { live: false, lastEntryAt: NOW - 3_000, entriesSince: 0 },
      { live: false, lastEntryAt: NOW - 500, entriesSince: 0 },
      { live: false, lastEntryAt: NOW - 4_000, entriesSince: 1 },
    ]);
    for (const projectId of ['proj_1', 'proj_2', 'proj_3']) {
      const alone = await readScheduleFacts(f.env, tasks, NOW, projectId);
      for (const task of tasks) {
        const key = taskFactsKey(projectId, task);
        expect({ key, facts: whole.runs.get(key) ?? null }).toEqual({ key, facts: alone.runs.get(key) ?? null });
        const perProject = {
          lastEntryAt: await lastTaskEntryAt(f.env.db, { projectId }, task, CLOCK_ACTOR),
          entriesSince: await taskEntriesSince(f.env.db, { projectId }, task, NOW - DAY, CLOCK_ACTOR),
          live: await hasLiveTaskRun(f.env.db, { projectId }, task),
        };
        expect({ key, facts: whole.runs.get(key) ?? { live: false, lastEntryAt: null, entriesSince: 0 } }).toEqual({ key, facts: perProject });
      }
    }
    expect([...whole.capabilities].sort()).toEqual([taskFactsKey('proj_1', 'canopy'), taskFactsKey('proj_1', 'vault_evolution'), taskFactsKey('proj_2', 'vault_evolution')]);
  });

  it('reads every Project\'s runs through the Project-and-task index, never by scanning the runs', () => {
    const f = fixture();
    const facts = taskRunFacts(f.env.db, scheduledTasks().map(({ task }) => task), NOW - DAY, CLOCK_ACTOR);
    const sql = (facts.statement as unknown as { sql?: string }).sql;
    const text = sql ?? '';
    const plan = f.sqlite.query(`EXPLAIN QUERY PLAN ${text}`).all(...(Array.from({ length: (text.match(/\?/g) ?? []).length }, () => null) as never[])) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail);
    expect({ index: details.some((d) => d.includes('idx_agent_runs_task')), scans: details.filter((d) => /^SCAN agent_runs/.test(d)) }).toEqual({ index: true, scans: [] });
  });
});
