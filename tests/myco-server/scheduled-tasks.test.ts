/**
 * The clock's own dispatches: each gate by name, in the 1.4 order, and what
 * a wake leaves behind — a launched run, a queued one, a skipped row where a
 * ceiling is met, and nothing at all where the switch is off.
 */
import { describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import type { PreparedStatement, RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import { HARNESS_AGENT_ID } from '@myco-server-worker/core/harness.js';
import { ACTIVE_WINDOW_DAYS_DEFAULT, CLOCK_ACTOR, COLD_PROJECT_THRESHOLD_DAYS_DEFAULT, decideTask as decide, effectiveIntervalSeconds, PRE_CONDITIONS, readScheduleFacts, resolveSchedule, runScheduledTasks as runClock, scheduledTasks, scheduleFor, scheduleLeaves } from '@myco-server-worker/core/scheduled-tasks.js';
import { TASK_SCHEDULE, type TaskSchedule } from '@myco-server-worker/core/jobs.js';
import { TASK_ADMISSION } from '@myco-server-worker/core/task-catalogue.js';
import { hasLiveTaskRun, INPUT_UNCHANGED, lastTaskEntryAt, skipContext, taskEntriesSince, taskFactsKey, taskRunFacts } from '@myco-server-worker/core/runs.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { capabilitiesRequiredBy } from '@goondocks/myco-shared/repository';
import { seedCredential } from './helpers/d1.js';
import { sqliteEnv, withHarness } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ORIGIN = 'https://s';
const SMOKE: TaskSchedule = { intervalSeconds: 86_400, runIn: ['sleep'], overlap: 'skip', maxRunsPerDay: 2 };

async function freshWorker(env: ServerEnv, now: number) {
  await env.db.prepare('UPDATE worker_contacts SET last_seen_at=?,updated_at=?').bind(now,now).run();
}
async function runScheduledTasks(...args: Parameters<typeof runClock>) {
  await freshWorker(args[0],args[2]);
  return runClock(...args);
}
async function decideTask(...args: Parameters<typeof decide>) {
  await freshWorker(args[0],args[7]);
  return decide(...args);
}

function fixture(opts: { bound?: boolean } = {}) {
  const e = sqliteEnv({ workerLogin: true });
  const launches: Array<{ runId: string; envVars: Record<string, string> }> = [];
  const base = opts.bound === false ? e.serverEnv : withHarness(() => e.serverEnv, { launch: async (spec) => { launches.push(spec); } });
  const env: ServerEnv = { ...base, wake: async () => {} };
  const setting = (leaf: string, value: unknown) => e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'mem_1')`, [leaf, JSON.stringify(value), NOW]);
  const token = seedCredential(e.sqlite, { id: 'mt_seed', expiresAt: NOW + 100 * DAY });
  for (const project of ['proj_1','proj_2']) e.sqlite.run(`INSERT INTO project_repositories(project_id,revision,url,branch,updated_at,updated_by)
    VALUES(?,'fixture','https://example.test/repo','main',1,'fixture')`, [project]);
  e.sqlite.run(`INSERT INTO worker_contacts(credential_id,machine_id,offers,capabilities,last_seen_at,updated_at)
    VALUES(?,'machine_1',?,?,?,?)`, [token,JSON.stringify([offeredHarness('claude-code')]),JSON.stringify(capabilitiesRequiredBy('canopy-map')),NOW,NOW]);
  e.sqlite.run("UPDATE members SET role='admin' WHERE id=(SELECT member_id FROM member_credentials WHERE id=?)", [token]);
  const receipt = (projectId: string, at: number) => e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES (?, ?, 'machine_1', ?, ?, ?, 'claude-code')`, [projectId, `s_${projectId}_${at}`, token, at, at]);
  const capability = (projectId: string, name: string, on: boolean) => e.sqlite.run(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?, 'mem_1')`, [projectId, name, on ? 1 : 0, NOW]);
  const runs = (projectId: string) => e.sqlite.query(`SELECT id, task, status, run_context AS runContext, started_at AS startedAt FROM agent_runs WHERE project_id = ? ORDER BY COALESCE(queued_at, started_at), id`).all(projectId) as Array<{ id: string; task: string; status: string; runContext: string | null; startedAt: number | null }>;
  setting('agent.scheduled_tasks_enabled', true);
  capability('proj_1', 'cortex', true);
  capability('proj_2', 'cortex', true);
  return { ...e, env, launches, setting, receipt, capability, runs };
}


function scheduledFixture() {
  const f = fixture();
  f.setting('cortex.canopy.refresh.background_enabled', true);
  f.capability('proj_1', 'canopy', true);
  f.capability('proj_2', 'canopy', true);
  f.setting('agent.tasks', { 'canopy-map': { schedule: { ...SMOKE, enabled: true, preCondition: 'has-capture-since-map', reservedRunsPerDay: { count: 0, preCondition: 'has-capture-since-map' } } } });
  for (const [project, at] of [['proj_1', NOW - 3_600_000], ['proj_2', NOW - 20 * DAY]] as const) {
    f.sqlite.run(`INSERT INTO sessions (project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,ended_at) VALUES (?, 's_clock','m1','tok_1',?,?, 'claude-code',?)`, [project, at, at, at]);
    f.sqlite.run(`INSERT INTO prompt_batches (project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at,processed) VALUES (?,'s_clock','p_clock','e_clock','scheduled extraction input','user','h_clock',?,?,'tok_1',?,0)`, [project, at, at, at]);
  }
  return f;
}

describe('the schedule envelope', () => {
  it('catalogues every schedule and its precondition, excluding deterministic embedding work', () => {
    expect(scheduledTasks().map((t) => t.task)).toEqual([]);
    expect(TASK_SCHEDULE['embedding-reconcile']).toBeNull();
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
    expect(scheduleFor('canopy-map', SMOKE, { 'canopy-map': { schedule: { intervalSeconds: 60 } } }).intervalSeconds).toBe(60);
    expect(scheduleFor('canopy-map', SMOKE, { 'canopy-map': 'nope' })).toEqual(SMOKE);
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
      expect({ name, decided: await decideTask(f.env, 'proj_1', NOW - DAY, 'canopy-map', schedule, 'sleep', leaves, NOW) })
        .toEqual({ name, decided: 'precondition' });
    }
  });

  it('shortens no interval for an accelerator named after an inherited member', async () => {
    const f = fixture();
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
    // An entry a day old: inside a day's interval, outside a shortened one.
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'earlier', ?, 'canopy-map', 'completed', ?)`, [HARNESS_AGENT_ID, NOW - 7_200_000]);
    for (const name of inherited) {
      const schedule: TaskSchedule = { ...SMOKE, accelerator: { name, thresholds: { steady: 1, accelerated: 2 } } };
      expect({ name, decided: await decideTask(f.env, 'proj_1', NOW - DAY, 'canopy-map', schedule, 'sleep', leaves, NOW) })
        .toEqual({ name, decided: 'not_yet' });
    }
  });
});

describe('retired schedule conditions', () => {
  it('refuses both old conditions instead of scheduling work without its guard', async () => {
    const f = scheduledFixture();
    for (const preCondition of ['has-unprocessed-prompts', 'has-recent-live-prompts']) {
      expect(Object.hasOwn(PRE_CONDITIONS, preCondition)).toBe(false);
      expect(await decideTask(f.env, 'proj_1', NOW-DAY, 'canopy-map', {...SMOKE,preCondition}, 'sleep', {coldThresholdDays:14,activeWindowDays:14}, NOW)).toBe('precondition');
    }
  });
});

describe('the leaves the clock reads', () => {
  it('is off until the owner turns scheduling on, with the 1.4 defaults for the recency gates', async () => {
    const f = fixture();
    f.sqlite.run(`DELETE FROM deployment_settings WHERE leaf = 'agent.scheduled_tasks_enabled'`);
    expect(await scheduleLeaves(f.env)).toEqual({ enabled: false, coldThresholdDays: COLD_PROJECT_THRESHOLD_DAYS_DEFAULT, activeWindowDays: ACTIVE_WINDOW_DAYS_DEFAULT, overrides: { 'canopy-map': { schedule: { enabled: false } } },
      mapRefresh: { enabled: false, intervalSeconds: 21_600, overridden: { enabled: false, interval: false } } });
    f.setting('agent.scheduled_tasks_enabled', true);
    f.setting('agent.cold_project_threshold_days', 3);
    f.setting('agent.tasks', { 'canopy-map': { schedule: { intervalSeconds: 60 } } });
    expect(await scheduleLeaves(f.env)).toMatchObject({ enabled: true, coldThresholdDays: 3, overrides: { 'canopy-map': { schedule: { intervalSeconds: 60 } } } });
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
  const decide = (f: ReturnType<typeof fixture>, last: number | null, schedule: TaskSchedule = SMOKE, state: 'active' | 'idle' | 'sleep' = 'sleep', now = NOW, project = 'proj_1') =>
    decideTask(f.env, project, last, 'canopy-map', schedule, state, leaves, now);

  it('leaves a quiet Project, a cold one, and one without the capability alone', async () => {
    const f = fixture();
    expect(await decide(f, null)).toBe('quiet');
    expect(await decide(f, NOW - 15 * DAY)).toBe('quiet');
    expect(await decide(f, NOW - 10 * DAY, SMOKE, 'sleep', NOW, 'proj_1')).toBeNull();
    expect(await decide(f, NOW - 10 * DAY, SMOKE, 'sleep', NOW, 'proj_1')).toBeNull();
    const cold = { ...leaves, coldThresholdDays: 5 };
    expect(await decideTask(f.env, 'proj_1', NOW - 10 * DAY, 'canopy-map', SMOKE, 'sleep', cold, NOW)).toBe('cold');
    expect(await decideTask(f.env, 'proj_1', NOW - 10 * DAY, 'canopy-map', { ...SMOKE, runWhenCold: true }, 'sleep', cold, NOW)).toBeNull();
    f.capability('proj_1', 'canopy', false);
    expect(await decide(f, NOW - DAY)).toBe('capability_off');
  });

  it('skips a task already live under the skip policy, waits out the interval, keeps to its states, honours a named precondition, and meets its ceiling once a day', async () => {
    const f = fixture();
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'live', ?, 'canopy-map', 'running', ?)`, [HARNESS_AGENT_ID, NOW - 60_000]);
    expect(await decide(f, NOW - DAY)).toBe('already_running');
    expect(await decide(f, NOW - DAY, { ...SMOKE, enabled: false })).toBe('disabled');
    expect(await decide(f, NOW - DAY, { ...SMOKE, overlap: 'queue' })).toBe('not_yet');
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed', started_at = COALESCE(started_at, queued_at), completed_at = ? WHERE id = 'live'`, [NOW - 59_000]);
    expect(await decide(f, NOW - DAY)).toBe('not_yet');
    expect(await decide(f, NOW - DAY, SMOKE, 'sleep', NOW + DAY)).toBeNull();
    expect(await decide(f, NOW - DAY, SMOKE, 'active', NOW + DAY)).toBe('not_in_state');
    expect(await decide(f, NOW - DAY, { ...SMOKE, preCondition: 'never-registered' }, 'sleep', NOW + DAY)).toBe('precondition');
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'earlier', ?, 'canopy-map', 'completed', ?)`, [HARNESS_AGENT_ID, NOW + DAY - 3_600_000]);
    expect(await decide(f, NOW - DAY, { ...SMOKE, intervalSeconds: 1, maxRunsPerDay: 1 }, 'sleep', NOW + DAY)).toBe('max_runs_per_day');
    expect(await decide(f, NOW - DAY, { ...SMOKE, intervalSeconds: 1, maxRunsPerDay: 3 }, 'sleep', NOW + DAY)).toBeNull();
  });
});

describe('one wake of the clock', () => {
  it('dispatches map work for each Project that qualifies, attributes it to the clock, and does nothing twice', async () => {
    const f = scheduledFixture();
    f.receipt('proj_1', NOW - 3_600_000);
    f.receipt('proj_2', NOW - 20 * DAY);
    const first = await runScheduledTasks(f.env, 'sleep', NOW, ORIGIN);
    expect(first).toEqual({ dispatched: 1, skipped: 0 });
    expect(f.runs('proj_1').map((r) => [r.task, r.status])).toEqual([['canopy-map', 'queued']]);
    expect(f.runs('proj_2')).toEqual([]);
    const spec = f.sqlite.query(`SELECT dispatch_spec FROM agent_runs WHERE task = 'canopy-map'`).get() as { dispatch_spec: string };
    expect(JSON.parse(spec.dispatch_spec)).toMatchObject({ serverUrl: ORIGIN, actor: CLOCK_ACTOR });
    expect(await runScheduledTasks(f.env, 'sleep', NOW + 1, ORIGIN)).toEqual({ dispatched: 0, skipped: 0 });
    expect(f.runs('proj_1')).toHaveLength(1);
  });

  it('refuses at the ceiling rather than queueing, records one row per episode however many wakes ask, and dispatches again when the window has room', async () => {
    const f = scheduledFixture();
    f.receipt('proj_1', NOW - 3_600_000);
    f.setting('agent.tasks', { 'canopy-map': { schedule: { preCondition: 'has-capture-since-map', reservedRunsPerDay: { count: 0, preCondition: 'has-capture-since-map' }, intervalSeconds: 1, maxRunsPerDay: 1 } } });
    expect(await runScheduledTasks(f.env, 'sleep', NOW, ORIGIN)).toEqual({ dispatched: 1, skipped: 0 });
    // Extraction finishes; the interval is past; the day's one run is spent.
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed', started_at = COALESCE(started_at, queued_at), completed_at = ? WHERE task = 'canopy-map'`, [NOW + 1_000]);
    f.receipt('proj_1', NOW + 2_000);
    expect(await runScheduledTasks(f.env, 'sleep', NOW + 5_000, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    const rows = f.runs('proj_1');
    expect(rows.map((r) => r.status)).toEqual(['completed', 'skipped']);
    expect(JSON.parse(rows[1]!.runContext!)).toEqual({ reason: 'max_runs_per_day' });
    // A ceiling is not a queue: nothing waits for capacity, and nothing launched.
    expect(rows.filter((r) => r.status === 'queued')).toEqual([]);
    expect(f.launches).toHaveLength(0);

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
    expect(f.runs('proj_1').map((r) => r.status)).toEqual(['completed', 'skipped', 'queued']);
    expect(f.launches).toHaveLength(0);

    // A SECOND episode leaves a second row: the record is once per episode, not
    // once per Project and task for all time.
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed', started_at = COALESCE(started_at, queued_at), completed_at = ? WHERE status = 'queued'`, [NOW + DAY + 6_000]);
    f.receipt('proj_1', NOW + DAY + 7_000);
    expect(await runScheduledTasks(f.env, 'sleep', NOW + DAY + 10_000, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    expect(f.runs('proj_1').map((r) => r.status)).toEqual(['completed', 'skipped', 'completed', 'skipped']);

    f.setting('agent.scheduled_tasks_enabled', false);
    expect(await runScheduledTasks(f.env, 'sleep', NOW + 2 * DAY, ORIGIN)).toEqual({ dispatched: 0, skipped: 0 });
  });

  it('keeps two episodes apart when both fall on one calendar day, a ceiling above one letting them sit minutes apart', async () => {
    const f = scheduledFixture();
    f.receipt('proj_1', NOW - 3_600_000);
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
    // Two entries just under a day apart: both sit inside the trailing window
    // until the older one ages out of it, ten minutes later.
    const older = NOW + 3_600_000;
    const newer = older + DAY - 10 * 60_000;
    for (const [id, at] of [['e_older', older], ['e_newer', newer]] as const) {
      f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at) VALUES ('proj_1', ?, ?, 'canopy-map', 'completed', ?, ?)`, [id, HARNESS_AGENT_ID, at, at]);
    }
    f.setting('agent.tasks', { 'canopy-map': { schedule: { preCondition: 'has-capture-since-map', reservedRunsPerDay: { count: 0, preCondition: 'has-capture-since-map' }, intervalSeconds: 1, maxRunsPerDay: 2 } } });

    // The first episode: both entries in the window, so the ceiling is met.
    const firstRefusal = newer + 60_000;
    f.receipt('proj_1', newer + 1);
    expect(await runScheduledTasks(f.env, 'sleep', firstRefusal, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    expect(f.runs('proj_1').filter((r) => r.status === 'skipped')).toHaveLength(1);

    // The older entry ages out, a run goes through, and the ceiling closes again
    // — a second episode, on the same calendar day as the first.
    const freed = older + DAY + 60_000;
    expect(await runScheduledTasks(f.env, 'sleep', freed, ORIGIN)).toEqual({ dispatched: 1, skipped: 0 });
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed', started_at = COALESCE(started_at, queued_at), completed_at = ? WHERE status = 'queued'`, [freed + 1_000]);
    f.receipt('proj_1', freed + 1_500);
    expect(await runScheduledTasks(f.env, 'sleep', freed + 2_000, ORIGIN)).toEqual({ dispatched: 0, skipped: 1 });
    expect(Math.floor(newer / DAY)).toBe(Math.floor(freed / DAY));
    expect(f.runs('proj_1').filter((r) => r.status === 'skipped')).toHaveLength(2);
  });

  it('refuses a ceiling of zero with no entry to name, and records that once however many wakes ask', async () => {
    const f = scheduledFixture();
    f.receipt('proj_1', NOW - 3_600_000);
    f.setting('agent.tasks', { 'canopy-map': { schedule: { preCondition: 'has-capture-since-map', reservedRunsPerDay: { count: 0, preCondition: 'has-capture-since-map' }, intervalSeconds: 1, maxRunsPerDay: 0 } } });
    for (const at of [NOW, NOW + 60_000, NOW + DAY + 60_000]) {
      expect({ at, report: await runScheduledTasks(f.env, 'sleep', at, ORIGIN) }).toEqual({ at, report: { dispatched: 0, skipped: 1 } });
    }
    const rows = f.runs('proj_1');
    expect(rows.map((r) => r.status)).toEqual(['skipped']);
    expect(JSON.parse(rows[0]!.runContext!)).toEqual({ reason: 'max_runs_per_day' });
    expect(f.launches).toHaveLength(0);
  });

  it('writes one row for one task when two wakes decide at once: the write refuses beside a live run', async () => {
    const f = scheduledFixture();
    f.receipt('proj_1', NOW - 3_600_000);
    // The second wake reads the same answers the first read, and its write meets the first's row.
    let raced = false;
    const racing: ServerEnv = { ...f.env, db: { ...f.env.db, prepare: (sql: string) => {
      if (!raced && sql.startsWith(`INSERT INTO agent_runs`) && sql.includes(`'queued'`)) {
        raced = true;
        f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?) ON CONFLICT DO NOTHING`, [HARNESS_AGENT_ID, NOW]);
        f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'other-wake', ?, 'canopy-map', 'queued', ?)`, [HARNESS_AGENT_ID, NOW]);
      }
      return f.env.db.prepare(sql);
    } } };
    expect(await runScheduledTasks(racing, 'sleep', NOW, ORIGIN)).toEqual({ dispatched: 0, skipped: 0 });
    expect(raced).toBe(true);
    expect(f.runs('proj_1').map((r) => r.id)).toEqual(['other-wake']);
    expect(f.launches).toHaveLength(0);
    expect((f.sqlite.query(`SELECT COUNT(*) c FROM member_credentials WHERE member_id = 'mem_harness' AND revoked_at IS NULL`).get() as { c: number }).c).toBe(0);
  });

  it('queues map work past a limit like any dispatch', async () => {
    const f = scheduledFixture();
    f.receipt('proj_1', NOW - 3_600_000);
    f.setting('agent.limits.concurrent_runs', 1);
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'busy', ?, 'title-summary', 'running', ?)`, [HARNESS_AGENT_ID, NOW]);
    expect(await runScheduledTasks(f.env, 'sleep', NOW, ORIGIN)).toEqual({ dispatched: 1, skipped: 0 });
    expect(f.runs('proj_1').map((r) => [r.task, r.status])).toEqual([['title-summary', 'running'], ['canopy-map', 'queued']]);
    expect(f.launches).toHaveLength(0);
  });
});

describe('the tick and the clock', () => {
  it('schedules from the origin the operator declared, and schedules nothing where none is declared', async () => {
    const f = scheduledFixture();
    f.receipt('proj_1', NOW - 40 * 60_000);
    expect((await runTick(f.env, NOW)).scheduled).toEqual({ dispatched: 0, skipped: 0 });
    f.env.origin = 'https://myco.example';
    const report = await runTick(f.env, NOW);
    expect(report.state).toBe('sleep');
    expect(report.scheduled).toEqual({ dispatched: 1, skipped: 0 });
    const spec = f.sqlite.query(`SELECT dispatch_spec FROM agent_runs WHERE task = 'canopy-map'`).get() as { dispatch_spec: string };
    expect(JSON.parse(spec.dispatch_spec)).toMatchObject({ serverUrl: 'https://myco.example', actor: CLOCK_ACTOR });
    expect(f.runs('proj_1')[0]).toMatchObject({ task: 'canopy-map', status: 'queued' });
    expect(JSON.parse(spec.dispatch_spec).timeoutSeconds).toBe(900);
    void CLOCK_ACTOR;
  });
});

describe('a schedule reserves capacity', () => {
  it('reserves automatic slots by a registered condition and applies the full ceiling to ready work', async () => {
    const f = scheduledFixture();
    let ready = false;
    const name = 'fixture-reserved-capacity';
    Object.defineProperty(PRE_CONDITIONS,name,{value:Object.assign(async()=>ready,{description:'Fixture capacity'}),configurable:true});
    try {
      f.sqlite.run(`INSERT INTO agents(id,name,source,enabled,created_at) VALUES(?,'a','built-in',1,?)`,[HARNESS_AGENT_ID,NOW]);
      const entry=(id:string,actor:string)=>f.sqlite.run(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,dispatch_spec)
        VALUES('proj_1',?,?,'canopy-map','completed',?,?)`,[id,HARNESS_AGENT_ID,NOW-7_200_000,JSON.stringify({actor})]);
      for(let i=0;i<9;i++)entry('auto-'+i,CLOCK_ACTOR);
      for(let i=0;i<10;i++)entry('manual-'+i,'owner');
      const schedule:TaskSchedule={...SMOKE,intervalSeconds:3600,maxRunsPerDay:12,reservedRunsPerDay:{count:3,preCondition:name}};
      const leaves=await scheduleLeaves(f.env);
      const decide=()=>decideTask(f.env,'proj_1',NOW,'canopy-map',schedule,'sleep',leaves,NOW);
      expect(await decide()).toBe('reserved_runs_per_day');
      ready=true;
      expect(await decide()).toBeNull();
      for(let i=9;i<12;i++)entry('auto-'+i,CLOCK_ACTOR);
      expect(await decide()).toBe('max_runs_per_day');
      expect(resolveSchedule(schedule,{reservedRunsPerDay:{count:0,preCondition:name}}).reservedRunsPerDay?.count).toBe(0);
      expect(resolveSchedule(schedule,{reservedRunsPerDay:{count:-1,preCondition:name}}).reservedRunsPerDay?.count).toBe(3);
    } finally { Reflect.deleteProperty(PRE_CONDITIONS,name);f.sqlite.close(); }
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
    f.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [NOW]);
    for (let n = 0; n < projects; n += 1) {
      const projectId = `proj_many_${n}`;
      f.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [projectId, projectId, NOW]);
      f.receipt(projectId, NOW - 60_000);
      f.capability(projectId, 'cortex', true);
      f.capability(projectId, 'canopy', false);
      // A clock-dispatched run of the probe a day old: the interval has passed, so the wake reads it and goes on.
      f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec) VALUES (?, ?, 'myco-agent', 'embedding-reconcile', 'completed', ?, ?, ?)`,
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
    f.capability('proj_2', 'canopy', true);
    f.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [NOW]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, dispatch_spec) VALUES ('proj_1', 'run_live', 'myco-agent', 'embedding-reconcile', 'running', ?, ?)`, [NOW - 1_000, JSON.stringify({ actor: CLOCK_ACTOR })]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec) VALUES ('proj_2', 'run_done', 'myco-agent', 'embedding-reconcile', 'completed', ?, ?, ?)`, [NOW - 2 * DAY, NOW - 2 * DAY, JSON.stringify({ actor: CLOCK_ACTOR })]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec) VALUES ('proj_2', 'run_owner', 'myco-agent', 'embedding-reconcile', 'completed', ?, ?, ?)`, [NOW - 1_000, NOW - 500, JSON.stringify({ actor: 'mem_owner' })]);
    // Each live status alone in its Project and task, so a read that misses one answers a different fact.
    f.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_3', 'proj_3', ?)`, [NOW]);
    f.receipt('proj_3', NOW - 60_000);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, dispatch_spec) VALUES ('proj_3', 'run_pending', 'myco-agent', 'embedding-reconcile', 'pending', ?)`, [JSON.stringify({ actor: CLOCK_ACTOR })]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, dispatch_spec) VALUES ('proj_1', 'run_queued', 'myco-agent', 'canopy-map', 'queued', ?, ?)`, [NOW - 2_000, JSON.stringify({ actor: CLOCK_ACTOR })]);
    // The clock's entry the platform replaced: the interval reads it, the day's ceiling does not.
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec, run_context) VALUES ('proj_2', 'run_replaced', 'myco-agent', 'embedding-reconcile', 'completed', ?, ?, ?, ?)`, [NOW - 3_000, NOW - 2_500, JSON.stringify({ actor: CLOCK_ACTOR }), JSON.stringify({ replaced: true })]);
    // A skip for unchanged input is the interval's entry; a skip for any other reason is nobody's.
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, run_context) VALUES ('proj_2', 'run_unchanged', 'myco-agent', 'canopy-map', 'skipped', ?, ?, ?)`, [NOW - 500, NOW - 500, skipContext(INPUT_UNCHANGED)]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, run_context) VALUES ('proj_2', 'run_ceiling', 'myco-agent', 'canopy-map', 'skipped', ?, ?, ?)`, [NOW - 100, NOW - 100, skipContext('max_runs_per_day')]);
    // Another actor's entries, newer than the clock's own and inside the day.
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec) VALUES ('proj_3', 'run_clock', 'myco-agent', 'canopy-map', 'completed', ?, ?, ?)`, [NOW - 4_000, NOW - 3_500, JSON.stringify({ actor: CLOCK_ACTOR })]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, dispatch_spec) VALUES ('proj_3', 'run_other', 'myco-agent', 'canopy-map', 'completed', ?, ?, ?)`, [NOW - 1_000, NOW - 900, JSON.stringify({ actor: 'mem_owner' })]);
    const tasks = ['embedding-reconcile', 'canopy-map'];
    expect(scheduledTasks().map(({ task }) => task)).toEqual([]);
    const whole = await readScheduleFacts(f.env, tasks, NOW);
    // The fixture holds each case the reads tell apart, so agreeing below is agreeing on each of them.
    expect([
      whole.runs.get(taskFactsKey('proj_3', 'embedding-reconcile'))?.live,
      whole.runs.get(taskFactsKey('proj_1', 'canopy-map'))?.live,
      whole.runs.get(taskFactsKey('proj_2', 'embedding-reconcile')),
      whole.runs.get(taskFactsKey('proj_2', 'canopy-map')),
      whole.runs.get(taskFactsKey('proj_3', 'canopy-map')),
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
    expect([...whole.capabilities].sort()).toEqual(['proj_1', 'proj_2', 'proj_3'].flatMap((id) => ['canopy'].map((capability) => taskFactsKey(id, capability))).sort());
  });

  it('reads every Project\'s runs through the Project-and-task index, never by scanning the runs', () => {
    const f = fixture();
    const facts = taskRunFacts(f.env.db, ['canopy-map'], NOW - DAY, CLOCK_ACTOR);
    const sql = (facts.statement as unknown as { sql?: string }).sql;
    const text = sql ?? '';
    const plan = f.sqlite.query(`EXPLAIN QUERY PLAN ${text}`).all(...(Array.from({ length: (text.match(/\?/g) ?? []).length }, () => null) as never[])) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail);
    expect({ index: details.some((d) => d.includes('idx_agent_runs_task')), scans: details.filter((d) => /^SCAN agent_runs/.test(d)) }).toEqual({ index: true, scans: [] });
  });
});

it('floors a stored fractional daily cap even when a task declares no cap', () => {
  const { maxRunsPerDay: _cap, ...uncapped } = SMOKE;
  for (const declared of [SMOKE, uncapped]) {
    expect(resolveSchedule(declared, { maxRunsPerDay: 2.5 }).maxRunsPerDay).toBe(2);
    expect(resolveSchedule(declared, { maxRunsPerDay: 0.5 }).maxRunsPerDay).toBe(0);
  }
});
