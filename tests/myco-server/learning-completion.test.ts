import { afterEach, beforeEach, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { buildLearningAssignment, completeLearning, type LearningAssignment } from '@myco-server-worker/core/learning-sessions.js';
import { ensureAgent, recordDispatch } from '@myco-server-worker/core/runs.js';
import { taskTools } from '@myco-server-worker/core/task-catalogue.js';
import { isRunCall, runAllowlist } from '@myco-server-worker/mcp/run-allowlist.js';
import { seedCredential, seededSqlite, sqliteD1 } from './helpers/d1.js';
import { beforeWriteBatch } from './helpers/prepared.js';

const NOW = 1_800_000_000_000;
let sqlite: Database;
let db: RelationalStore;
let assignment: LearningAssignment;

beforeEach(async () => {
  sqlite = seededSqlite();
  db = sqliteD1(sqlite);
  const token = seedCredential(sqlite);
  sqlite.query(`INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at)
    VALUES('proj_1','session',?,1,1)`).run(token);
  sqlite.query(`INSERT INTO learning_sessions(project_id,session_id,init_state,max_seq,due_cards,failures)
    VALUES('proj_1','session','ready',20,2,3)`).run();
  for (const [turn, seq] of [['first', 10], ['second', 20]] as const) {
    sqlite.query(`INSERT INTO turn_cards(project_id,session_id,turn_key,state,input_hash,card,signal,records,last_seq,created_at,carded_at)
      VALUES('proj_1','session',?,'carded',?,'card','high',?,?,1,?)`)
      .run(turn, turn, JSON.stringify([['prompt', turn]]), seq, NOW + 1);
  }
  await ensureAgent(db, { id: 'learner', name: 'learner', provider: null, model: null, enabled: true }, NOW);
  await recordDispatch(db, { projectId: 'proj_1' }, { id: 'run', agentId: 'learner', task: 'extract-curate', provider: null,
    model: null, runContext: null, dispatchedBy: null, startedAt: NOW });
  for (const turn of ['first', 'second']) {
    sqlite.query(`INSERT INTO run_served_material(project_id,served_id,run_id,session_id,record_id,served_at)
      VALUES('proj_1',?,'run','session',?,?)`).run(`served-${turn}`, turn, NOW);
  }
  assignment = (await buildLearningAssignment(db, 'proj_1', 'session'))!;
});

afterEach(() => sqlite.close());

const progress = () => sqlite.query(`SELECT * FROM learning_sessions WHERE project_id='proj_1' AND session_id='session'`).get();

async function expectRefused(store = db) {
  const before = progress();
  expect(await completeLearning(store, 'proj_1', 'session', 'run', assignment, 'handoff', NOW))
    .toEqual({ completed: false, covered: 0 });
  expect(sqlite.query('SELECT record_id FROM extraction_acks').all()).toEqual([]);
  expect(progress()).toEqual(before);
  expect(sqlite.query('SELECT covered FROM turn_cards').all()).toEqual([{ covered: 0 }, { covered: 0 }]);
  expect(sqlite.query('SELECT id FROM agent_run_events').all()).toEqual([]);
}

it('refuses stale revisions without acknowledgements, coverage or progress writes', async () => {
  sqlite.query(`UPDATE learning_sessions SET revision=1,due_cards=7`).run();
  await expectRefused();
});

it('refuses a rival completion in the same millisecond without dependent writes', async () => {
  sqlite.query(`UPDATE learning_sessions SET revision=1,last_completed_at=?,last_completed_reason='completed',due_cards=0`).run(NOW);
  await expectRefused();
});

it('refuses cards changed between reading and the completion batch without acknowledging or advancing', async () => {
  let before: unknown;
  const raced = beforeWriteBatch(db, sql => sql.startsWith('UPDATE learning_sessions SET revision'), async () => {
    sqlite.query(`UPDATE turn_cards SET input_hash='changed' WHERE turn_key='first'`).run();
    before = progress();
  }, true);
  await expectRefused(raced);
  expect(progress()).toEqual(before);
});

it('completes unchanged cards, acknowledges their served prompts and keeps the handoff', async () => {
  expect(await completeLearning(db, 'proj_1', 'session', 'run', assignment, 'handoff', NOW))
    .toEqual({ completed: true, covered: 2 });
  expect(sqlite.query('SELECT record_id FROM extraction_acks ORDER BY record_id').all())
    .toEqual([{ record_id: 'first' }, { record_id: 'second' }]);
  expect(sqlite.query('SELECT covered FROM turn_cards').all()).toEqual([{ covered: 1 }, { covered: 1 }]);
  expect(progress()).toMatchObject({ revision: 1, learned_seq: 20, due_cards: 0, eligible_at: null,
    handoff: 'handoff', failures: 0, last_completed_at: NOW, last_completed_reason: 'completed' });
});

it('admits learning completion and refuses a separate prompt acknowledgement on a learning run', () => {
  const allow = runAllowlist(taskTools('extract-curate'), { dryRun: false });
  expect(isRunCall(allow, 'myco_run_learning', 'complete')).toBe(true);
  expect(isRunCall(allow, 'myco_run_prompts', 'mark_processed')).toBe(false);
});
