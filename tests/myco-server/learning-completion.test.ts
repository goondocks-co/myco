import { afterEach, beforeEach, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { buildLearningAssignment, completeLearning, type LearningAssignment } from '@myco-server-worker/core/learning-sessions.js';
import { ensureAgent } from '@myco-server-worker/db/runs/state.js';
import { recordDispatch } from '@myco-server-worker/db/runs/claim.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { learningCompletedBy } from '@myco-server-worker/core/run-postconditions.js';
import { taskTools } from '@myco-server-worker/core/task-catalogue.js';
import { isRunCall, runAllowlist } from '@myco-server-worker/mcp/run-allowlist.js';
import { seedCredential, seededSqlite, sqliteD1 } from './helpers/d1.js';
import { beforeWriteBatch } from './helpers/prepared.js';

const NOW = 1_800_000_000_000;
let sqlite: Database;
let db: RelationalStore;
let assignment: LearningAssignment;

async function setup() {
  sqlite = seededSqlite();
  db = sqliteD1(sqlite);
  const token = seedCredential(sqlite);
  sqlite.query(`INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at)
    VALUES('proj_1','session',?,1,1)`).run(token);
  sqlite.query(`INSERT INTO learning_sessions(project_id,session_id,init_state,max_seq,failures)
    VALUES('proj_1','session','ready',20,3)`).run();
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
}

beforeEach(setup);
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

it('completes surviving cards when a card goes pending before the batch', async () => {
  for (const timing of ['before_read', 'before_batch'] as const) {
    if (timing === 'before_batch') { sqlite.close(); await setup(); }
    const pending = async () => { sqlite.query(`UPDATE turn_cards SET state='pending' WHERE turn_key='second'`).run(); };
    if (timing === 'before_read') await pending();
    const raced = timing === 'before_read' ? db : beforeWriteBatch(db,
      sql => sql.startsWith('UPDATE learning_sessions SET revision'), pending, true);
    expect(await completeLearning(raced, 'proj_1', 'session', 'run', assignment, 'handoff', NOW))
      .toEqual({ completed: true, covered: 1 });
    expect(sqlite.query('SELECT record_id FROM extraction_acks').all()).toEqual([{ record_id: 'first' }]);
    expect(sqlite.query('SELECT turn_key,state,covered FROM turn_cards ORDER BY turn_key').all()).toEqual([
      { turn_key: 'first', state: 'carded', covered: 1 }, { turn_key: 'second', state: 'pending', covered: 0 },
    ]);
    expect(progress()).toMatchObject({ revision: 1, learned_seq: 10, due_cards: 0, pending_cards: 1,
      handoff: 'handoff', failures: 0, last_completed_run: 'run' });
    expect(await learningCompletedBy(db, { projectId: 'proj_1' }, (await getRun(db, { projectId: 'proj_1' }, 'run'))!)).toBe(true);
  }
});

it('keeps the prior handoff and failures when every card changes before the batch', async () => {
  sqlite.query(`UPDATE learning_sessions SET handoff='prior'`).run();
  const raced = beforeWriteBatch(db, sql => sql.startsWith('UPDATE learning_sessions SET revision'),
    async () => { sqlite.query(`UPDATE turn_cards SET state='pending'`).run(); }, true);
  expect(await completeLearning(raced, 'proj_1', 'session', 'run', assignment, 'new', NOW)).toEqual({ completed: true, covered: 0 });
  expect(progress()).toMatchObject({ revision: 1, handoff: 'prior', failures: 3, last_completed_run: 'run' });
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
  expect([...allow.keys()]).not.toContain('myco_run_prompts');
});
