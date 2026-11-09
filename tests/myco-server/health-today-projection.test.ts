import { unresolvedFailures } from '@myco-server-worker/db/runs/outcomes.js';
import { readSetupProgress } from '@myco-server-worker/db/identity/setup.js';
import { describe, expect, it } from 'bun:test';
import { passedOverHealth } from '@myco-server-worker/db/embeddings/health.js';
import { passedOverTriggers } from '@myco-server-worker/db/embeddings/passed-over.js';
import { todayMarks, changeMarkTriggers } from '@myco-server-worker/db/meta/marks.js';
import { catchUpPhase, catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { todayQueued, todayRunning, todayProjects } from '@myco-server-worker/db/runs/now.js';
import { recentMachineCapture } from '@myco-server-worker/db/runners/harness-health.js';
import { V712_STATEMENTS } from '@myco-server-worker/db/schema-v712.js';
import { recordDispatch } from '@myco-server-worker/db/runs/claim.js';
import { recordQueueHolder, failQueuedRun } from '@myco-server-worker/db/runs/queue.js';
import { commitRunChange } from '@myco-server-worker/db/runs/change.js';
import { readWorkNow } from '@myco-server-worker/read/work-now.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
function fixture() {
  const f = sqliteEnv();
  f.sqlite.run("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('a','a','built-in',1,0)");
  const source = (id: string) => f.sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,summary) VALUES('proj_1',?,'machine_1','tok_1',1,1,'source')", [id]);
  const fail = (id: string, model = 'm', at = NOW, reason = 'refused') => f.sqlite.run(`INSERT INTO embedding_source_failures(project_id,type,record_id,model_key,revision,reason,recorded_at)
    SELECT project_id,type,record_id,?,revision,?,? FROM embedding_versions WHERE project_id='proj_1' AND type='session' AND record_id=?
    ON CONFLICT(project_id,type,record_id,model_key) DO UPDATE SET revision=excluded.revision,reason=excluded.reason,recorded_at=excluded.recorded_at`, [model, reason, at, id]);
  const run = (id: string, status: string, at = NOW, task = 'extract-curate') => f.sqlite.run(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at,completed_at,error)
    VALUES('proj_1',?,'a',?,?,?, ?,?,'stored failure')`, [id, task, status, at, status === 'queued' ? null : at, status === 'failed' || status === 'completed' ? at : null]);
  return { ...f, source, fail, run };
}

describe('maintained Health and Today contracts', () => {
  it('generated triggers maintain the same Health counts and Today marks after replay', async () => {
    const f = fixture();
    try {
      for (const trigger of [...passedOverTriggers(), ...changeMarkTriggers()]) {
        f.sqlite.run(`DROP TRIGGER ${trigger.name}`);
        f.sqlite.run(trigger.sql);
      }
      f.source('generated'); f.fail('generated');
      expect(await passedOverHealth(f.db, ['m'], NOW)).toMatchObject({ state: 'ready', count: 1 });
      f.fail('generated');
      expect(await passedOverHealth(f.db, ['m'], NOW)).toMatchObject({ count: 1 });
      f.sqlite.run("UPDATE sessions SET summary='edited' WHERE session_id='generated'");
      expect(await passedOverHealth(f.db, ['m'], NOW)).toMatchObject({ count: 0 });
      f.run('generated', 'running');
      const before = await readWorkNow(f.serverEnv, { projectId: 'proj_1' }, NOW, false);
      f.sqlite.run("UPDATE agent_runs SET status='completed',completed_at=? WHERE id='generated'", [NOW]);
      const after = await readWorkNow(f.serverEnv, { projectId: 'proj_1' }, NOW, false);
      expect(after.running).toEqual([]);
      expect(after.marks.runs).not.toBe(before.marks.runs);
    } finally { f.sqlite.close(); }
  });

  it('counts distinct current sources exactly across model switches, expiry, success, edits and deletion', async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 105; i++) { f.source(`s${i}`); f.fail(`s${i}`); }
      f.fail('s0', 'switch', NOW + 1, 'latest reason');
      let result = await passedOverHealth(f.db, ['m', 'switch'], NOW + 2);
      expect(result.state).toBe('ready');
      if (result.state !== 'ready') throw new Error('not ready');
      expect(result.count).toBe(105);
      expect(result.sources).toHaveLength(100);
      expect(result.sources[0]).toMatchObject({ recordId: 's0', reason: 'latest reason', modelKey: 'switch' });
      expect(await passedOverHealth(f.db, ['other'], NOW)).toMatchObject({ count: 0 });
      f.fail('s1', '', NOW - 2 * DAY);
      expect(await passedOverHealth(f.db, ['m'], NOW + DAY)).toMatchObject({ count: 1 });
      f.sqlite.run("DELETE FROM embedding_source_failures WHERE record_id='s2'");
      expect(await passedOverHealth(f.db, ['m'], NOW)).toMatchObject({ count: 104 });
      f.sqlite.run("UPDATE sessions SET summary='edited' WHERE session_id='s0'");
      expect(await passedOverHealth(f.db, ['m','switch'], NOW)).toMatchObject({ count: 103 });
      f.sqlite.run("DELETE FROM sessions WHERE session_id='s1'");
      expect(await passedOverHealth(f.db, ['m'], NOW)).toMatchObject({ count: 102 });
    } finally { f.sqlite.close(); }
  });

  it('keeps catch-up building through interleaved source writes and replays current keys idempotently', async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 55; i++) { f.source(`s${String(i).padStart(2,'0')}`); f.fail(`s${String(i).padStart(2,'0')}`); }
      f.sqlite.run('DELETE FROM embedding_passed_over');
      f.sqlite.run("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='passed_over'");
      expect(await passedOverHealth(f.db, ['m'], NOW)).toEqual({ state: 'building' });
      expect(await catchUpPhase(f.db, 'failures')).toBe(50);
      f.sqlite.run("UPDATE sessions SET summary='edited' WHERE session_id='s00'");
      f.sqlite.run("DELETE FROM sessions WHERE session_id='s54'");
      f.fail('s53', 'm', NOW + 1, 'new failure');
      expect(await passedOverHealth(f.db, ['m'], NOW + 2)).toEqual({ state: 'building' });
      await catchUpProjections(f.db, { budget: { calls: 200, wallMs: 10_000 } });
      expect(await passedOverHealth(f.db, ['m'], NOW + 2)).toMatchObject({ state: 'ready', count: 53 });
      await catchUpProjections(f.db);
      expect(await passedOverHealth(f.db, ['m'], NOW + 2)).toMatchObject({ count: 53 });
    } finally { f.sqlite.close(); }
  });

  it('reports the whole live queue and oldest identity, not the first 200 rows', async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 205; i++) f.run(`q${i}`, 'queued', NOW + i);
      f.run('z_oldest', 'queued', NOW - 1);
      expect(await todayQueued(f.db, { all: true })).toMatchObject([{ count: 206, since: NOW - 1, oldest_id: 'z_oldest' }]);
      const result = await readWorkNow(f.serverEnv, { projectId: 'proj_1' }, NOW, false);
      expect(result.waiting.find(row => row.what === 'Learn from sessions')?.count).toBe(206);
    } finally { f.sqlite.close(); }
  });

  it('counts all running work while bounding its page', async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 23; i++) f.run(`r${i}`, 'running', NOW + i, i === 22 ? 'retired-task' : 'extract-curate');
      const page = await todayRunning(f.db, { all: true });
      expect(page.rows).toHaveLength(20);
      expect(page).toMatchObject({ total: 23, hasMore: true });
    } finally { f.sqlite.close(); }
  });

  it('finds a failure behind newer non-terminal runs and a failed group behind healthy groups', async () => {
    const f = fixture();
    try {
      f.run('failed', 'failed', NOW - 100);
      for (let i = 0; i < 6; i++) f.run(`q${i}`, 'queued', NOW - i);
      f.sqlite.run("INSERT INTO project_capabilities VALUES('proj_1','spore_curation',1,1,'fixture')");
      for (let i = 0; i < 55; i++) f.sqlite.run("INSERT INTO spore_curation_work(project_id,cluster_key,members,due_at) VALUES('proj_1',?,'[]',?)", [`ok${i}`, NOW - 100]);
      f.sqlite.run("INSERT INTO spore_curation_work(project_id,cluster_key,members,due_at,failures,run_id) VALUES('proj_1','bad','[]',?,1,'failed')", [NOW + 100]);
      const result = await readWorkNow(f.serverEnv, { projectId: 'proj_1' }, NOW, false);
      expect(result.unavailable).toEqual([]);
      expect(result.needsYou.map(row => row.key)).toContain('failed:proj_1:extract-curate');
      expect(result.needsYou.map(row => row.key)).toContain('curation-group:proj_1:bad');
      f.run('success', 'completed', NOW);
      expect((await readWorkNow(f.serverEnv, { projectId: 'proj_1' }, NOW, false)).needsYou.map(row => row.key)).not.toContain('failed:proj_1:extract-curate');
    } finally { f.sqlite.close(); }
  });

  it('advances opaque marks on completion, same-millisecond updates and deletion of the max', async () => {
    const f = fixture();
    try {
      f.run('r', 'running');
      let marks = await todayMarks(f.db);
      for (const sql of ["UPDATE agent_runs SET status='completed',completed_at=1 WHERE id='r'", "UPDATE agent_runs SET held_by='worker',completed_at=1 WHERE id='r'", "DELETE FROM agent_runs WHERE id='r'"]) {
        f.sqlite.run(sql); const next = await todayMarks(f.db); expect(next[0]).not.toBe(marks[0]); marks = next;
      }
      f.sqlite.run("INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at) VALUES('proj_1','p','s','e','m','p','body','h','active',1,1,'tok_1',1)");
      marks = await todayMarks(f.db);
      for (const sql of ["UPDATE plans SET title='changed',updated_at=1 WHERE plan_key='p'", "DELETE FROM plans WHERE plan_key='p'"]) {
        f.sqlite.run(sql); const next = await todayMarks(f.db); expect(next[3]).not.toBe(marks[3]); marks = next;
      }
      f.sqlite.run("INSERT INTO spore_curation_changes(project_id,revision,dirty) VALUES('proj_1',1,1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1");
      marks = await todayMarks(f.db);
      f.sqlite.run("DELETE FROM spore_curation_changes WHERE project_id='proj_1'");
      expect((await todayMarks(f.db))[2]).not.toBe(marks[2]);
    } finally { f.sqlite.close(); }
  });

  it('reports the latest live receipt for each recently active machine', async () => {
    const f = fixture();
    try {
      for (const [id, machine, at] of [
        ['old', 'old-machine', NOW - 1], ['early', 'active-machine', NOW + 1],
        ['late', 'active-machine', NOW + 2], ['other', 'other-machine', NOW + 3],
      ] as const) {
        f.source(id);
        f.sqlite.run('UPDATE sessions SET machine_id=?,last_live_received_at=? WHERE session_id=?', [machine, at, id]);
      }
      f.source('imported');
      expect((await recentMachineCapture(f.db, NOW)).sort((a, b) => a.machine_id.localeCompare(b.machine_id)))
        .toEqual([{ machine_id: 'active-machine', at: NOW + 2 }, { machine_id: 'other-machine', at: NOW + 3 }]);
    } finally { f.sqlite.close(); }
  });

  it('answers recorded on the first dispatch despite trigger writes and refuses the repeat', async () => {
    const f = fixture();
    try {
      const record = { id: 'recorded', agentId: 'a', task: 'extract-curate', provider: null, model: null, runContext: null, dispatchedBy: null, startedAt: NOW };
      expect(await recordDispatch(f.db, { projectId: 'proj_1' }, record)).toBe(true);
      const marks = await todayMarks(f.db);
      expect(await recordDispatch(f.db, { projectId: 'proj_1' }, record)).toBe(false);
      expect(await todayMarks(f.db)).toEqual(marks);
      expect(f.sqlite.query("SELECT id FROM agent_runs WHERE id='recorded'").all()).toEqual([{ id: 'recorded' }]);
    } finally { f.sqlite.close(); }
  });
  it('preserves source rows through installation and rebuilds late versions and proof eligibility', async () => {
    const f = fixture();
    try {
      f.source('s'); f.fail('s');
      const tables = ['sessions','embedding_versions','embedding_source_failures','plans','agent_runs','spore_curation_changes'];
      const snapshot = () => tables.map(table => f.sqlite.query(`SELECT * FROM ${table}`).all());
      const before = snapshot();
      for (const trigger of [...passedOverTriggers(), ...changeMarkTriggers()]) f.sqlite.run(`DROP TRIGGER ${trigger.name}`);
      f.sqlite.run('DROP TABLE embedding_passed_over');
      f.sqlite.run('DROP TABLE change_marks');
      f.sqlite.run("DELETE FROM projection_catchup WHERE projection='passed_over'");
      for (const sql of V712_STATEMENTS) f.sqlite.run(sql);
      expect(snapshot()).toEqual(before);
      expect(await passedOverHealth(f.db, ['m'], NOW)).toEqual({ state: 'building' });
      await catchUpProjections(f.db, { budget: { calls: 200, wallMs: 10_000 } });
      expect(await passedOverHealth(f.db, ['m'], NOW)).toMatchObject({ state: 'ready', count: 1 });
      const version = f.sqlite.query("SELECT * FROM embedding_versions WHERE record_id='s'").get() as Record<string, string | number>;
      f.sqlite.run("DELETE FROM embedding_versions WHERE record_id='s'");
      expect(await passedOverHealth(f.db, ['m'], NOW)).toMatchObject({ count: 0 });
      f.sqlite.run(`INSERT INTO embedding_versions(${Object.keys(version).join(',')}) VALUES(${Object.keys(version).map(() => '?').join(',')})`, Object.values(version));
      expect(await passedOverHealth(f.db, ['m'], NOW)).toMatchObject({ count: 1 });
      f.sqlite.run("INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,blob_key,content_hash,status,created_at,updated_at,token_id,received_at) VALUES('proj_1','p','s','e','m','p',NULL,'proof-blob','h','active',1,1,'tok_1',1)");
      f.sqlite.run("INSERT INTO embedding_source_failures(project_id,type,record_id,model_key,revision,reason,recorded_at) SELECT project_id,type,record_id,'',revision,'unreadable',1 FROM embedding_versions WHERE type='plan' AND record_id='p'");
      f.sqlite.run("INSERT OR IGNORE INTO processed_resources(project_id,kind,resource_id,blob_key,source_token_id,event_id) VALUES('proj_1','plan','p','proof-blob','tok_1','e')");
      expect(await passedOverHealth(f.db, ['m'], NOW)).toMatchObject({ count: 2 });
      f.sqlite.run("DELETE FROM processed_resources WHERE kind='plan' AND resource_id='p'");
      expect(await passedOverHealth(f.db, ['m'], NOW)).toMatchObject({ count: 1 });
    } finally { f.sqlite.close(); }
  });


  it('shows a queued admission failure until a later completion clears it', async () => {
    const f = fixture();
    try {
      f.run('older', 'failed', NOW - 20);
      f.run('queued', 'queued', NOW - 10);
      expect((await failQueuedRun(f.db, { projectId: 'proj_1' }, 'queued', NOW, 'Could not start the task.', 'task_start_failed')).applied).toBe(true);
      expect(await unresolvedFailures(f.db, [{ projectId: 'proj_1', task: 'extract-curate' }])).toMatchObject([{ runId: 'queued', failures: 2 }]);
      expect((await readWorkNow(f.serverEnv, { projectId: 'proj_1' }, NOW, false)).needsYou).toMatchObject([{ runId: 'queued', why: 'Could not start the task.' }]);
      f.run('success', 'completed', NOW + 1);
      expect(await unresolvedFailures(f.db, [{ projectId: 'proj_1', task: 'extract-curate' }])).toEqual([]);
    } finally { f.sqlite.close(); }
  });

  it('preserves the queue holder and marks on replay while accepting a changed quote', async () => {
    const f = fixture();
    try {
      f.run('q', 'queued');
      await recordQueueHolder(f.db, { projectId: 'proj_1' }, 'q', 'worker');
      const before = f.sqlite.query("SELECT * FROM agent_runs WHERE id='q'").get();
      const marks = await todayMarks(f.db);
      await recordQueueHolder(f.db, { projectId: 'proj_1' }, 'q', 'worker');
      expect(f.sqlite.query("SELECT * FROM agent_runs WHERE id='q'").get()).toEqual(before);
      expect(await todayMarks(f.db)).toEqual(marks);
      f.sqlite.run("UPDATE agent_runs SET status=status,held_by=held_by,completed_at=completed_at WHERE id='q'");
      expect(await todayMarks(f.db)).toEqual(marks);
      f.sqlite.run("INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin) VALUES('proj_1','budget','a','extract-curate','queued','automatic')");
      await recordQueueHolder(f.db, { projectId: 'proj_1' }, 'budget', 'budget', { usd: 1, at: NOW });
      const budgetMarks = await todayMarks(f.db);
      await recordQueueHolder(f.db, { projectId: 'proj_1' }, 'budget', 'budget', { usd: 2, at: NOW + 1 });
      expect(await todayMarks(f.db)).toEqual(budgetMarks);
      expect(f.sqlite.query("SELECT json_extract(run_context,'$.budgetEstimateUsd') AS usd FROM agent_runs WHERE id='budget'").get()).toEqual({ usd: 2 });
    } finally { f.sqlite.close(); }
  });

  it('finds retained setup output behind empty completed work', async () => {
    const f = fixture();
    try {
      f.run('run_old-output', 'completed', NOW - 90 * DAY);
      for (const author of ['mem_importer', 'grant_editor']) {
        f.sqlite.run(`INSERT INTO spores(project_id,id,agent_id,observation_type,status,content,author,created_at)
          VALUES('proj_1',?,'a','gotcha','active','Member knowledge',?,?)`, [author, author, NOW]);
      }
      for (let i = 0; i < 205; i++) f.run(`empty-${i}`, 'completed', NOW - i);
      expect((await readSetupProgress(f.serverEnv, { all: true }, NOW)).workProduced).toBe(false);
      f.sqlite.run(`INSERT INTO spores(project_id,id,agent_id,observation_type,status,content,author,created_at)
        VALUES('proj_1','output','a','gotcha','active','retained output','run_old-output',?)`, [NOW - 90 * DAY]);
      expect((await readSetupProgress(f.serverEnv, { all: true }, NOW)).workProduced).toBe(true);
      f.sqlite.run("DELETE FROM spores WHERE id='output'");
      expect((await readSetupProgress(f.serverEnv, { all: true }, NOW)).workProduced).toBe(false);
    } finally { f.sqlite.close(); }
  });

  it('prioritizes live and failing Projects and pages without repetition', async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 30; i++) f.sqlite.run('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,?)', [`p${i}`, `p${i}`, NOW]);
      f.run('failure', 'failed', NOW);
      f.sqlite.run("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at) VALUES('p0','q','a','retired-task','queued',1)");
      const first = await todayProjects(f.db, { all: true });
      expect(first.read.slice(0, 2).sort()).toEqual(['p0', 'proj_1']);
      const next = await todayProjects(f.db, { all: true }, first.cursor);
      expect(new Set([...first.read, ...next.read]).size).toBe(first.total);
    } finally { f.sqlite.close(); }
  });

  it('refuses a run change without RETURNING before executing it or its companions', async () => {
    const f = fixture();
    try {
      f.run('r', 'running');
      const statement = f.db.prepare("UPDATE agent_runs SET status='failed' WHERE id='r'");
      await expect(commitRunChange(f.db, statement, [f.db.prepare("DELETE FROM agent_runs WHERE id='r'")])).rejects.toThrow('RETURNING');
      expect(f.sqlite.query("SELECT status FROM agent_runs WHERE id='r'").get()).toEqual({ status: 'running' });
    } finally { f.sqlite.close(); }
  });

});
