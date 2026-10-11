import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { EXTRACTION_PAGE } from '@myco-server-worker/core/extraction-input.js';
import { EXTRACTION_RAMP_RUNS_PER_DAY, extractionRamp } from '@myco-server-worker/core/extraction-ramp.js';
import { CLOCK_ACTOR, runScheduledTasks } from '@myco-server-worker/core/scheduled-tasks.js';
import { dispatchTask, HARNESS_AGENT_ID } from '@myco-server-worker/core/harness.js';
import { EXTRACTION_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { ensureAgent, recordQueued } from '@myco-server-worker/core/runs.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

function backlog(established = false) {
  const f = sqliteEnv();
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
  it('allows two runs per rolling day per Project across days and the first processed prompts, then permanently releases at one page', async () => {
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
      expect(await extractionRamp(f.db, 'proj_1', NOW + 4 * HOUR)).toBe(EXTRACTION_RAMP_RUNS_PER_DAY);
      expect(await dispatchTask(f.serverEnv, EXTRACTION_TASK, 'proj_1', { serverUrl: 'https://s', actor: 'owner' }, NOW + 5 * HOUR)).toMatchObject({ dispatched: true });
      f.sqlite.run("UPDATE agent_runs SET status='completed' WHERE status='queued'");
      await wake(NOW + DAY + 5 * HOUR, 2);
      await wake(NOW + DAY + 7 * HOUR, 2);
      await wake(NOW + DAY + 9 * HOUR, 0);
      f.sqlite.run("UPDATE prompt_batches SET processed=1 WHERE CAST(substr(prompt_id,3) AS INTEGER) >= ?", [EXTRACTION_PAGE]);
      await wake(NOW + DAY + 11 * HOUR, 2);
      expect(await extractionRamp(f.db, 'proj_1', NOW + DAY + 11 * HOUR)).toBeNull();
      f.sqlite.run('UPDATE prompt_batches SET processed=0');
      await wake(NOW + DAY + 13 * HOUR, 2);
    } finally { f.sqlite.close(); }
  });

  it('leaves established extraction at the configured schedule ceiling', async () => {
    const f = backlog(true);
    try {
      await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled', true, 'test', NOW);
      expect(await extractionRamp(f.db, 'proj_1', NOW)).toBeNull();
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
