/**
 * The clock's own dispatches: each gate by name, in the 1.4 order, and what
 * a wake leaves behind — a launched run, a queued one, a skipped row where a
 * ceiling is met, and nothing at all where the switch is off.
 */
import { describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { HARNESS_AGENT_ID } from '@myco-server-worker/core/harness.js';
import { ACTIVE_WINDOW_DAYS_DEFAULT, CLOCK_ACTOR, COLD_PROJECT_THRESHOLD_DAYS_DEFAULT, decideTask, effectiveIntervalSeconds, hasUnprocessedPrompts, PRE_CONDITIONS, resolveSchedule, runScheduledTasks, scheduledTasks, scheduleFor, scheduleLeaves } from '@myco-server-worker/core/scheduled-tasks.js';
import { TASK_SCHEDULE, type TaskSchedule } from '@myco-server-worker/core/jobs.js';
import { TASK_ADMISSION } from '@myco-server-worker/core/task-catalogue.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { seedCredential } from './helpers/d1.js';
import { sqliteEnv, withHarness } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ORIGIN = 'https://s';
const SMOKE: TaskSchedule = TASK_SCHEDULE['container-smoke']!;

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
  setting('agent.provider.type', 'openai-compatible');
  setting('agent.provider.model', 'm');
  setting('agent.provider.base_url', 'http://models.internal/v1');
  setting('agent.scheduled_tasks_enabled', true);
  capability('proj_1', 'cortex', true);
  capability('proj_2', 'cortex', true);
  return { ...e, env, launches, setting, receipt, capability, runs };
}

describe('the schedule envelope', () => {
  it('schedules the harness health probe daily while sleeping and nothing else yet, every scheduled task being catalogued', () => {
    expect(scheduledTasks().map((t) => t.task)).toEqual(['container-smoke']);
    expect(SMOKE).toEqual({ intervalSeconds: 86_400, runIn: ['sleep'], overlap: 'skip', maxRunsPerDay: 2 });
    for (const task of Object.keys(TASK_SCHEDULE)) expect({ task, catalogued: task in TASK_ADMISSION }).toEqual({ task, catalogued: true });
    for (const task of Object.keys(TASK_ADMISSION)) expect({ task, scheduled: task in TASK_SCHEDULE }).toEqual({ task, scheduled: true });
    for (const { task, schedule } of scheduledTasks()) {
      if (schedule.preCondition !== undefined) expect({ task, registered: schedule.preCondition in PRE_CONDITIONS }).toEqual({ task, registered: true });
    }
  });

  it('lays an owner override over the declared block field by field, replacing an accelerator whole and refusing a malformed field', () => {
    expect(resolveSchedule(SMOKE, undefined)).toEqual(SMOKE);
    expect(resolveSchedule(SMOKE, { intervalSeconds: 3600, runIn: ['active', 'idle'], maxRunsPerDay: 5, overlap: 'queue', runWhenCold: true })).toEqual({ intervalSeconds: 3600, runIn: ['active', 'idle'], maxRunsPerDay: 5, overlap: 'queue', runWhenCold: true });
    expect(resolveSchedule(SMOKE, { intervalSeconds: -1, runIn: ['awake'], overlap: 'never', accelerator: { name: 'x' } })).toEqual(SMOKE);
    expect(resolveSchedule(SMOKE, { accelerator: { name: 'pending', thresholds: { steady: 10, accelerated: 100 } } }).accelerator).toEqual({ name: 'pending', thresholds: { steady: 10, accelerated: 100 } });
    expect(scheduleFor('container-smoke', SMOKE, { 'container-smoke': { schedule: { intervalSeconds: 60 } } }).intervalSeconds).toBe(60);
    expect(scheduleFor('container-smoke', SMOKE, { 'container-smoke': 'nope' })).toEqual(SMOKE);
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
      const schedule: TaskSchedule = { ...SMOKE, preCondition: name };
      expect({ name, decided: await decideTask(f.env, 'proj_1', NOW - DAY, 'container-smoke', schedule, 'sleep', leaves, NOW) })
        .toEqual({ name, decided: 'precondition' });
    }
  });

  it('shortens no interval for an accelerator named after an inherited member', async () => {
    const f = fixture();
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
    // An entry a day old: inside a day's interval, outside a shortened one.
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'earlier', ?, 'container-smoke', 'completed', ?)`, [HARNESS_AGENT_ID, NOW - 7_200_000]);
    for (const name of inherited) {
      const schedule: TaskSchedule = { ...SMOKE, accelerator: { name, thresholds: { steady: 1, accelerated: 2 } } };
      expect({ name, decided: await decideTask(f.env, 'proj_1', NOW - DAY, 'container-smoke', schedule, 'sleep', leaves, NOW) })
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
    expect(await check!({ db: f.env.db, projectId: 'proj_1' })).toBe(false);
    const gated: TaskSchedule = { ...SMOKE, preCondition: 'has-unprocessed-prompts' };
    expect(await decideTask(f.env, 'proj_1', NOW - DAY, 'container-smoke', gated, 'sleep', { enabled: true, coldThresholdDays: 14, activeWindowDays: 14, overrides: {} }, NOW)).toBe('precondition');
    seedSession(f, 'proj_1', 's_done', NOW);
    seedPrompt(f, 'proj_1', 's_done', 'p_waiting', 0);
    expect(await decideTask(f.env, 'proj_1', NOW - DAY, 'container-smoke', gated, 'sleep', { enabled: true, coldThresholdDays: 14, activeWindowDays: 14, overrides: {} }, NOW)).toBeNull();
  });
});

describe('the leaves the clock reads', () => {
  it('is off until the owner turns scheduling on, with the 1.4 defaults for the recency gates', async () => {
    const f = fixture();
    f.sqlite.run(`DELETE FROM deployment_settings WHERE leaf = 'agent.scheduled_tasks_enabled'`);
    expect(await scheduleLeaves(f.env)).toEqual({ enabled: false, coldThresholdDays: COLD_PROJECT_THRESHOLD_DAYS_DEFAULT, activeWindowDays: ACTIVE_WINDOW_DAYS_DEFAULT, overrides: { 'canopy-map': { schedule: { enabled: true, intervalSeconds: 3600 } } } });
    f.setting('agent.scheduled_tasks_enabled', true);
    f.setting('agent.cold_project_threshold_days', 3);
    f.setting('agent.tasks', { 'container-smoke': { schedule: { intervalSeconds: 60 } } });
    expect(await scheduleLeaves(f.env)).toMatchObject({ enabled: true, coldThresholdDays: 3, overrides: { 'container-smoke': { schedule: { intervalSeconds: 60 } } } });
    f.setting('cortex.canopy.refresh.background_enabled', false);
    f.setting('agent.tasks', { 'canopy-map': { schedule: { enabled: true } } });
    expect((await scheduleLeaves(f.env)).overrides['canopy-map']).toMatchObject({ schedule: { enabled: false } });
  });
});

describe('each gate, by name, in order', () => {
  const leaves = { enabled: true, coldThresholdDays: 14, activeWindowDays: 14, overrides: {} };
  const decide = (f: ReturnType<typeof fixture>, last: number | null, schedule: TaskSchedule = SMOKE, state: 'active' | 'idle' | 'sleep' = 'sleep', now = NOW, project = 'proj_1') =>
    decideTask(f.env, project, last, 'container-smoke', schedule, state, leaves, now);

  it('leaves a quiet Project, a cold one, and one without the capability alone', async () => {
    const f = fixture();
    expect(await decide(f, null)).toBe('quiet');
    expect(await decide(f, NOW - 15 * DAY)).toBe('quiet');
    expect(await decide(f, NOW - 10 * DAY, SMOKE, 'sleep', NOW, 'proj_1')).toBeNull();
    expect(await decide(f, NOW - 10 * DAY, SMOKE, 'sleep', NOW, 'proj_1')).toBeNull();
    const cold = { ...leaves, coldThresholdDays: 5 };
    expect(await decideTask(f.env, 'proj_1', NOW - 10 * DAY, 'container-smoke', SMOKE, 'sleep', cold, NOW)).toBe('cold');
    expect(await decideTask(f.env, 'proj_1', NOW - 10 * DAY, 'container-smoke', { ...SMOKE, runWhenCold: true }, 'sleep', cold, NOW)).toBeNull();
    f.capability('proj_1', 'cortex', false);
    expect(await decide(f, NOW - DAY)).toBe('capability_off');
  });

  it('skips a task already live under the skip policy, waits out the interval, keeps to its states, honours a named precondition, and meets its ceiling once a day', async () => {
    const f = fixture();
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'live', ?, 'container-smoke', 'running', ?)`, [HARNESS_AGENT_ID, NOW - 60_000]);
    expect(await decide(f, NOW - DAY)).toBe('already_running');
    expect(await decide(f, NOW - DAY, { ...SMOKE, enabled: false })).toBe('disabled');
    expect(await decide(f, NOW - DAY, { ...SMOKE, overlap: 'queue' })).toBe('not_yet');
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE id = 'live'`, [NOW - 59_000]);
    expect(await decide(f, NOW - DAY)).toBe('not_yet');
    expect(await decide(f, NOW - DAY, SMOKE, 'sleep', NOW + DAY)).toBeNull();
    expect(await decide(f, NOW - DAY, SMOKE, 'active', NOW + DAY)).toBe('not_in_state');
    expect(await decide(f, NOW - DAY, { ...SMOKE, preCondition: 'never-registered' }, 'sleep', NOW + DAY)).toBe('precondition');
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'earlier', ?, 'container-smoke', 'completed', ?)`, [HARNESS_AGENT_ID, NOW + DAY - 3_600_000]);
    expect(await decide(f, NOW - DAY, { ...SMOKE, intervalSeconds: 1, maxRunsPerDay: 1 }, 'sleep', NOW + DAY)).toBe('max_runs_per_day');
    expect(await decide(f, NOW - DAY, { ...SMOKE, intervalSeconds: 1, maxRunsPerDay: 3 }, 'sleep', NOW + DAY)).toBeNull();
  });
});

describe('one wake of the clock', () => {
  it('dispatches the probe for each Project that qualifies, attributes it to the clock, and does nothing twice', async () => {
    const f = fixture();
    f.receipt('proj_1', NOW - 3_600_000);
    f.receipt('proj_2', NOW - 20 * DAY);
    const first = await runScheduledTasks(f.env, 'sleep', NOW, ORIGIN);
    expect(first).toEqual({ dispatched: 1, skipped: 0 });
    expect(f.runs('proj_1').map((r) => [r.task, r.status])).toEqual([['container-smoke', 'pending']]);
    expect(f.runs('proj_2')).toEqual([]);
    expect(f.launches[0]!.envVars.MYCO_SERVER_URL).toBe(ORIGIN);
    expect(f.launches[0]!.envVars.MYCO_TASK).toBe('container-smoke');
    expect(await runScheduledTasks(f.env, 'sleep', NOW + 1, ORIGIN)).toEqual({ dispatched: 0, skipped: 0 });
    expect(f.runs('proj_1')).toHaveLength(1);
  });

  it('refuses at the ceiling rather than queueing, records one row per episode however many wakes ask, and dispatches again when the window has room', async () => {
    const f = fixture();
    f.receipt('proj_1', NOW - 3_600_000);
    f.setting('agent.tasks', { 'container-smoke': { schedule: { intervalSeconds: 1, maxRunsPerDay: 1 } } });
    expect(await runScheduledTasks(f.env, 'sleep', NOW, ORIGIN)).toEqual({ dispatched: 1, skipped: 0 });
    // The probe finishes; the interval is past; the day's one run is spent.
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE task = 'container-smoke'`, [NOW + 1_000]);
    expect(await runScheduledTasks(f.env, 'sleep', NOW + 5_000, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    const rows = f.runs('proj_1');
    expect(rows.map((r) => r.status)).toEqual(['completed', 'skipped']);
    expect(JSON.parse(rows[1]!.runContext!)).toEqual({ reason: 'max_runs_per_day' });
    // A ceiling is not a queue: nothing waits for capacity, and nothing launched.
    expect(rows.filter((r) => r.status === 'queued')).toEqual([]);
    expect(f.launches).toHaveLength(1);

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

    // The trailing day has room again: the next wake dispatches, with no queue
    // to drain and nothing owed for the wakes that refused.
    expect(await runScheduledTasks(f.env, 'sleep', NOW + DAY + 5_000, ORIGIN)).toEqual({ dispatched: 1, skipped: 0 });
    expect(f.runs('proj_1').map((r) => r.status)).toEqual(['completed', 'skipped', 'pending']);
    expect(f.launches).toHaveLength(2);

    // A SECOND episode leaves a second row: the record is once per episode, not
    // once per Project and task for all time.
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE status = 'pending'`, [NOW + DAY + 6_000]);
    expect(await runScheduledTasks(f.env, 'sleep', NOW + DAY + 10_000, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    expect(f.runs('proj_1').map((r) => r.status)).toEqual(['completed', 'skipped', 'completed', 'skipped']);

    f.setting('agent.scheduled_tasks_enabled', false);
    expect(await runScheduledTasks(f.env, 'sleep', NOW + 2 * DAY, ORIGIN)).toEqual({ dispatched: 0, skipped: 0 });
  });

  it('keeps two episodes apart when both fall on one calendar day, a ceiling above one letting them sit minutes apart', async () => {
    const f = fixture();
    f.receipt('proj_1', NOW - 3_600_000);
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
    // Two entries just under a day apart: both sit inside the trailing window
    // until the older one ages out of it, ten minutes later.
    const older = NOW + 3_600_000;
    const newer = older + DAY - 10 * 60_000;
    for (const [id, at] of [['e_older', older], ['e_newer', newer]] as const) {
      f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at) VALUES ('proj_1', ?, ?, 'container-smoke', 'completed', ?, ?)`, [id, HARNESS_AGENT_ID, at, at]);
    }
    f.setting('agent.tasks', { 'container-smoke': { schedule: { intervalSeconds: 1, maxRunsPerDay: 2 } } });

    // The first episode: both entries in the window, so the ceiling is met.
    const firstRefusal = newer + 60_000;
    expect(await runScheduledTasks(f.env, 'sleep', firstRefusal, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    expect(f.runs('proj_1').filter((r) => r.status === 'skipped')).toHaveLength(1);

    // The older entry ages out, a run goes through, and the ceiling closes again
    // — a second episode, on the same calendar day as the first.
    const freed = older + DAY + 60_000;
    expect(await runScheduledTasks(f.env, 'sleep', freed, ORIGIN)).toEqual({ dispatched: 1, skipped: 0 });
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE status = 'pending'`, [freed + 1_000]);
    expect(await runScheduledTasks(f.env, 'sleep', freed + 2_000, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    expect(Math.floor(newer / DAY)).toBe(Math.floor(freed / DAY));
    expect(f.runs('proj_1').filter((r) => r.status === 'skipped')).toHaveLength(2);
  });

  it('refuses a ceiling of zero with no entry to name, and records that once however many wakes ask', async () => {
    const f = fixture();
    f.receipt('proj_1', NOW - 3_600_000);
    f.setting('agent.tasks', { 'container-smoke': { schedule: { intervalSeconds: 1, maxRunsPerDay: 0 } } });
    for (const at of [NOW, NOW + 60_000, NOW + DAY + 60_000]) {
      expect({ at, report: await runScheduledTasks(f.env, 'sleep', at, ORIGIN) }).toEqual({ at, report: { dispatched: 0, skipped: 1 } });
    }
    const rows = f.runs('proj_1');
    expect(rows.map((r) => r.status)).toEqual(['skipped']);
    expect(JSON.parse(rows[0]!.runContext!)).toEqual({ reason: 'max_runs_per_day' });
    expect(f.launches).toHaveLength(0);
  });

  it('writes one row for one task when two wakes decide at once: the write refuses beside a live run', async () => {
    const f = fixture();
    f.receipt('proj_1', NOW - 3_600_000);
    // The second wake reads the same answers the first read, and its write meets the first's row.
    let raced = false;
    const racing: ServerEnv = { ...f.env, db: { ...f.env.db, prepare: (sql: string) => {
      if (!raced && sql.includes(`?, 'pending', ?`)) {
        raced = true;
        f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?) ON CONFLICT DO NOTHING`, [HARNESS_AGENT_ID, NOW]);
        f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'other-wake', ?, 'container-smoke', 'pending', ?)`, [HARNESS_AGENT_ID, NOW]);
      }
      return f.env.db.prepare(sql);
    } } };
    expect(await runScheduledTasks(racing, 'sleep', NOW, ORIGIN)).toEqual({ dispatched: 0, skipped: 0 });
    expect(f.runs('proj_1').map((r) => r.id)).toEqual(['other-wake']);
    expect(f.launches).toHaveLength(0);
    expect((f.sqlite.query(`SELECT COUNT(*) c FROM member_credentials WHERE member_id = 'mem_harness' AND revoked_at IS NULL`).get() as { c: number }).c).toBe(0);
  });

  it('queues the probe past a limit like any dispatch', async () => {
    const f = fixture();
    f.receipt('proj_1', NOW - 3_600_000);
    f.setting('agent.limits.concurrent_runs', 1);
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'busy', ?, 'digest-only', 'running', ?)`, [HARNESS_AGENT_ID, NOW]);
    expect(await runScheduledTasks(f.env, 'sleep', NOW, ORIGIN)).toEqual({ dispatched: 1, skipped: 0 });
    expect(f.runs('proj_1').map((r) => [r.task, r.status])).toEqual([['digest-only', 'running'], ['container-smoke', 'queued']]);
    expect(f.launches).toHaveLength(0);
  });
});

describe('the tick and the clock', () => {
  it('schedules from the origin the operator declared, and schedules nothing where none is declared', async () => {
    const f = fixture();
    f.receipt('proj_1', NOW - 40 * 60_000);
    expect((await runTick(f.env, NOW)).scheduled).toEqual({ dispatched: 0, skipped: 0 });
    f.env.origin = 'https://myco.example';
    const report = await runTick(f.env, NOW);
    expect(report.state).toBe('sleep');
    expect(report.scheduled).toEqual({ dispatched: 1, skipped: 0 });
    expect(f.launches[0]!.envVars.MYCO_SERVER_URL).toBe('https://myco.example');
    expect(f.runs('proj_1')[0]).toMatchObject({ task: 'container-smoke', status: 'pending' });
    expect(JSON.parse(f.launches[0]!.envVars.MYCO_TASK_PARAMS!)).toEqual({ timeoutSeconds: 300 });
    void CLOCK_ACTOR;
  });
});
