import { describe, expect, it, spyOn } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { EXTRACTION_PAGE } from '@myco-server-worker/core/extraction-input.js';
import { extractionRamp } from '@myco-server-worker/core/extraction-ramp.js';
import { CLOCK_ACTOR, runScheduledTasks } from '@myco-server-worker/core/scheduled-tasks.js';
import { dispatchTask, HARNESS_AGENT_ID } from '@myco-server-worker/core/harness.js';
import { EXTRACTION_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { ensureAgent, recordQueued } from '@myco-server-worker/core/runs.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

function backlog(established = false, options: Parameters<typeof sqliteEnv>[0] = {}) {
  const f = sqliteEnv(options);
  for (const project of ['proj_1', 'proj_2']) {
    f.sqlite.run(`INSERT INTO sessions (project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,ended_at)
      VALUES (?,'backlog','m','t',1,?,?)`, [project, NOW, NOW - 1_000]);
    for (let i = 0; i < EXTRACTION_PAGE * 5; i++) {
      f.sqlite.run(`INSERT INTO prompt_batches (project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at,processed)
        VALUES (?,'backlog',?,?,'finding','user','h',1,1,'t',1,?)`, [project, 'p_' + i, 'e_' + i, established && i === 0 ? 1 : 0]);
    }
  }
  return f;
}

describe('first automatic extraction ramp', () => {
  it('allows two runs per rolling day per Project across days and the first processed prompts, then permanently releases when its history drains', async () => {
    const f = backlog();
    try {
      await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled', true, 'test', NOW);
      const wake = async (at: number, expected: number) => {
        expect((await runScheduledTasks(f.serverEnv, 'idle', at, 'https://s')).dispatched).toBe(expected);
        f.sqlite.run("UPDATE agent_runs SET status='completed', completed_at=? WHERE status='queued'", [at]);
      };
      await wake(NOW, 2);
      f.sqlite.run("UPDATE prompt_batches SET processed=1 WHERE prompt_id='p_0'");
      await wake(NOW + 2 * HOUR, 2);
      await wake(NOW + 4 * HOUR, 0);
      expect(await extractionRamp(f.serverEnv, 'proj_1', NOW + 4 * HOUR)).toBe(2);
      expect(await dispatchTask(f.serverEnv, EXTRACTION_TASK, 'proj_1', { serverUrl: 'https://s', actor: 'owner' }, NOW + 5 * HOUR)).toMatchObject({ dispatched: true });
      f.sqlite.run("UPDATE agent_runs SET status='completed' WHERE status='queued'");
      await wake(NOW + DAY + 5 * HOUR, 2);
      await wake(NOW + DAY + 7 * HOUR, 2);
      await wake(NOW + DAY + 9 * HOUR, 0);
      f.sqlite.run("UPDATE prompt_batches SET received_at=? WHERE CAST(substr(prompt_id,3) AS INTEGER) < ?", [NOW + DAY + 10 * HOUR, EXTRACTION_PAGE]);
      f.sqlite.run("UPDATE prompt_batches SET processed=1 WHERE CAST(substr(prompt_id,3) AS INTEGER) >= ?", [EXTRACTION_PAGE]);
      await wake(NOW + DAY + 11 * HOUR, 2);
      expect(await extractionRamp(f.serverEnv, 'proj_1', NOW + DAY + 11 * HOUR)).toBeNull();
      f.sqlite.run('UPDATE prompt_batches SET processed=0');
      await wake(NOW + DAY + 13 * HOUR, 2);
    } finally { f.sqlite.close(); }
  });

  it('leaves established extraction at the configured schedule ceiling', async () => {
    const f = backlog(true);
    try {
      await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled', true, 'test', NOW);
      expect(await extractionRamp(f.serverEnv, 'proj_1', NOW)).toBeNull();
      for (const at of [NOW, NOW + 2 * HOUR, NOW + 4 * HOUR]) {
        expect((await runScheduledTasks(f.serverEnv, 'idle', at, 'https://s')).dispatched).toBe(2);
        f.sqlite.run("UPDATE agent_runs SET status='completed' WHERE status='queued'");
      }
    } finally { f.sqlite.close(); }
  });

  it('carries each Project rolling-day ceiling into the atomic queue write', async () => {
    const f = backlog();
    try {
      await ensureAgent(f.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: null, model: null, enabled: true }, NOW);
      for (const projectId of ['proj_1', 'proj_2']) {
        const results = await Promise.all(['a', 'b', 'c'].map((id) => recordQueued(f.db, { projectId }, {
          id, agentId: HARNESS_AGENT_ID, task: EXTRACTION_TASK, provider: null, model: null, heldBy: 'worker', queuedAt: NOW,
          dispatchSpec: JSON.stringify({ actor: CLOCK_ACTOR }),
        }, { ceiling: { actor: CLOCK_ACTOR, task: EXTRACTION_TASK, perDay: 2, sinceMs: NOW - DAY, projectId } })));
        expect(results.filter(Boolean)).toHaveLength(2);
      }
    } finally { f.sqlite.close(); }
  });
});


it('ends the ramp when the original history drains despite faster fresh-session inflow', async () => {
  const f = backlog();
  try {
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW)).toBe(2);
    f.sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,ended_at) VALUES('proj_1','fresh','m','t',?,?,?)", [NOW + HOUR, NOW + HOUR, NOW + HOUR]);
    f.sqlite.run("INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at,processed) SELECT project_id,'fresh','fresh_'||prompt_id,'fresh_'||event_id,text,origin,content_hash,?,?,token_id,?,0 FROM prompt_batches WHERE project_id='proj_1'", [NOW + HOUR, NOW + HOUR, NOW + HOUR]);
    f.sqlite.run("UPDATE prompt_batches SET processed=1 WHERE project_id='proj_1' AND session_id='backlog'");
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW + 2 * HOUR)).toBeNull();
    expect(f.sqlite.query("SELECT count(*) AS n FROM prompt_batches WHERE project_id='proj_1' AND processed=0").get()).toEqual({ n: 100 });
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW + 4 * HOUR)).toBeNull();
  } finally { f.sqlite.close(); }
});

it('ends the history ramp at the active-window deadline with unread history and ongoing inflow', async () => {
  const f = backlog();
  try {
    await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_active_window_days', 1, 'test', NOW);
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW)).toBe(2);
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW + DAY - 1)).toBe(2);
    f.sqlite.run('UPDATE sessions SET last_received_at=?', [NOW + DAY]);
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW + DAY)).toBeNull();
    expect(f.sqlite.query("SELECT count(*) AS n FROM prompt_batches WHERE project_id='proj_1' AND processed=0").get()).toEqual({ n: 100 });
  } finally { f.sqlite.close(); }
});

it('enforces the ramp ceiling through scheduler dispatch after the decision snapshot becomes stale', async () => {
  let raced = false;
  const f = backlog(false, { onSql(sql, sqlite) {
    if (!raced && sql.startsWith('INSERT INTO agent_runs') && sql.includes('queued_at')) {
      raced = true;
      for (const id of ['race_a', 'race_b']) sqlite.run("INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,dispatch_spec) VALUES('proj_1',?,'myco-agent','extract-curate','completed',?,?,?)", [id, NOW - HOUR, NOW, JSON.stringify({ actor: CLOCK_ACTOR })]);
    }
  } });
  try {
    await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled', true, 'test', NOW);
    expect((await runScheduledTasks(f.serverEnv, 'idle', NOW, 'https://s')).dispatched).toBe(1);
    expect(raced).toBe(true);
    expect(f.sqlite.query("SELECT project_id FROM agent_runs WHERE status='queued'").all()).toEqual([{ project_id: 'proj_2' }]);
  } finally { f.sqlite.close(); }
});

for (const value of ['oops', '{"phase":"ramping","startedAt":"bad"}', JSON.stringify({ phase: 'ramping', startedAt: NOW + DAY, historyThrough: NOW, sessionIds: ['backlog'] })]) it(`resets unreadable or invalid ramp state ${value}`, async () => {
  const f = backlog();
  const events: Array<{ kind: string; projectId?: string }> = [];
  const log = spyOn(console, 'log').mockImplementation(message => { events.push(JSON.parse(message)); });
  try {
    await ensureAgent(f.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: null, model: null, enabled: true }, NOW);
    f.sqlite.run("INSERT INTO agent_state(project_id,agent_id,key,value,updated_at) VALUES('proj_1','myco-agent','server.schedule.extract-curate.ramp',?,?)", [value, NOW]);
    await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled', true, 'test', NOW);
    expect((await runScheduledTasks(f.serverEnv, 'idle', NOW, 'https://s')).dispatched).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'schedule_state_reset', projectId: 'proj_1' }));
  } finally { log.mockRestore(); f.sqlite.close(); }
});

for (const platform of [true, false]) it(`continues other Projects when one Project control-state read fails with platform=${platform}`, async () => {
  let reads = 0;
  const f = backlog(false, { onSql(sql) {
    if (sql.includes('FROM agent_state') && ++reads === 1) throw new Error('synthetic state read failure');
  } });
  const env = f.serverEnv;
  if (!platform) Reflect.deleteProperty(env, 'platform');
  const events: Array<{ kind: string; projectId?: string }> = [];
  const log = spyOn(console, 'log').mockImplementation(message => { events.push(JSON.parse(message)); });
  try {
    await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled', true, 'test', NOW);
    expect((await runScheduledTasks(env, 'idle', NOW, 'https://s')).dispatched).toBe(1);
    expect(f.sqlite.query("SELECT project_id FROM agent_runs WHERE status='queued'").all()).toEqual([{ project_id: 'proj_2' }]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'schedule_project_failed', projectId: 'proj_1' }));
  } finally { log.mockRestore(); f.sqlite.close(); }
});


it('reads the ramp daily ceiling from the extraction task Settings override', async () => {
  const f = backlog();
  try {
    const writer = settingsWriter(f.db);
    expect(await writer.setLeaf('agent.tasks', { 'extract-curate': { schedule: { rampRunsPerDay: 1.5 } } }, 'test', NOW)).toMatchObject({ applied: false });
    expect(await writer.setLeaf('agent.tasks', { 'extract-curate': { schedule: { rampRunsPerDay: 3 } } }, 'test', NOW)).toEqual({ applied: true });
    await writer.setLeaf('agent.scheduled_tasks_enabled', true, 'test', NOW);
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW)).toBe(3);
    for (const at of [NOW, NOW + 2 * HOUR, NOW + 4 * HOUR]) {
      expect((await runScheduledTasks(f.serverEnv, 'idle', at, 'https://s')).dispatched).toBe(2);
      f.sqlite.run("UPDATE agent_runs SET status='completed' WHERE status='queued'");
    }
    expect((await runScheduledTasks(f.serverEnv, 'idle', NOW + 6 * HOUR, 'https://s')).dispatched).toBe(0);
  } finally { f.sqlite.close(); }
});


for (const pending of ['active', 'unparsed']) it(`excludes a ${pending} session that becomes eligible after the history snapshot`, async () => {
  const f = backlog();
  try {
    f.sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,ended_at) VALUES('proj_1','late','m','t',1,?,?)", [NOW, pending === 'active' ? null : NOW - HOUR]);
    if (pending === 'unparsed') f.sqlite.run("INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,parsed_offset,first_received_at,last_received_at,token_id) VALUES('proj_1','late','late','m',100,0,1,1,'t')");
    f.sqlite.run("INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at,processed) SELECT project_id,'late','late_'||prompt_id,'late_'||event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at,0 FROM prompt_batches WHERE project_id='proj_1' AND session_id='backlog'");
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW)).toBe(2);
    f.sqlite.run("UPDATE prompt_batches SET processed=1 WHERE project_id='proj_1' AND session_id='backlog'");
    f.sqlite.run("UPDATE sessions SET ended_at=? WHERE session_id='late'", [NOW + HOUR]);
    f.sqlite.run("UPDATE transcripts SET parsed_offset=size WHERE transcript_id='late'");
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW + 2 * HOUR)).toBeNull();
    expect(f.sqlite.query("SELECT count(*) AS n FROM prompt_batches WHERE project_id='proj_1' AND processed=0").get()).toEqual({ n: 100 });
  } finally { f.sqlite.close(); }
});


it('resets a corrupted in-progress ramp conservatively after some history has been processed', async () => {
  const f = backlog();
  try {
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW)).toBe(2);
    f.sqlite.run("UPDATE prompt_batches SET processed=1 WHERE project_id='proj_1' AND prompt_id='p_0'");
    f.sqlite.run("UPDATE agent_state SET value='oops' WHERE project_id='proj_1' AND key='server.schedule.extract-curate.ramp'");
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW + HOUR)).toBe(2);
    await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled', true, 'test', NOW);
    for (const at of [NOW + HOUR, NOW + 3 * HOUR]) {
      expect((await runScheduledTasks(f.serverEnv, 'idle', at, 'https://s')).dispatched).toBe(2);
      f.sqlite.run("UPDATE agent_runs SET status='completed' WHERE status='queued'");
    }
    expect((await runScheduledTasks(f.serverEnv, 'idle', NOW + 5 * HOUR, 'https://s')).dispatched).toBe(0);
  } finally { f.sqlite.close(); }
});

it('writes ramp state only when it starts or completes, including concurrent evaluations', async () => {
  const f = backlog();
  f.sqlite.run('CREATE TABLE ramp_writes (at INTEGER)');
  for (const operation of ['INSERT', 'UPDATE']) f.sqlite.run(`CREATE TRIGGER ramp_${operation} AFTER ${operation} ON agent_state BEGIN INSERT INTO ramp_writes VALUES (NEW.updated_at); END`);
  const writes = () => f.sqlite.query('SELECT count(*) AS n FROM ramp_writes').get();
  try {
    expect(await Promise.all([extractionRamp(f.serverEnv, 'proj_1', NOW), extractionRamp(f.serverEnv, 'proj_1', NOW)])).toEqual([2, 2]);
    expect(writes()).toEqual({ n: 1 });
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW + HOUR)).toBe(2);
    expect(writes()).toEqual({ n: 1 });
    expect(f.sqlite.query("SELECT updated_at FROM agent_state WHERE project_id='proj_1'").get()).toEqual({ updated_at: NOW });
    f.sqlite.run("UPDATE prompt_batches SET processed=1 WHERE project_id='proj_1'");
    expect(await Promise.all([extractionRamp(f.serverEnv, 'proj_1', NOW + 2 * HOUR), extractionRamp(f.serverEnv, 'proj_1', NOW + 2 * HOUR)])).toEqual([null, null]);
    expect(writes()).toEqual({ n: 2 });
    expect(await extractionRamp(f.serverEnv, 'proj_1', NOW + 3 * HOUR)).toBeNull();
    expect(writes()).toEqual({ n: 2 });
  } finally { f.sqlite.close(); }
});
