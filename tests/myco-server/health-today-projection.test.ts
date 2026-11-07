import { unresolvedFailures } from '@myco-server-worker/db/runs/outcomes.js';
import { readSetupProgress } from '@myco-server-worker/db/identity/setup.js';
import { describe, expect, it } from 'bun:test';
import { passedOverHealth } from '@myco-server-worker/db/embeddings/health.js';
import { passedOverTriggers } from '@myco-server-worker/db/embeddings/passed-over.js';
import { todayMarks, changeMarkTriggers } from '@myco-server-worker/db/meta/marks.js';
import { catchUpKpiPhase, catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { todayQueued, todayRunning, todayProjects } from '@myco-server-worker/db/runs/now.js';
import { recentMachineCapture } from '@myco-server-worker/db/runners/harness-health.js';
import { VNEXT_STATEMENTS } from '@myco-server-worker/db/schema-vNEXT.js';
import { recordDispatch, recordQueueHolder, failQueuedRun, commitRunChange } from '@myco-server-worker/core/runs.js';
import { readWorkNow } from '@myco-server-worker/read/work-now.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
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

function captureSql(store: RelationalStore) {
  const sqls: Array<{sql:string; params:unknown[]}> = [];
  const db: RelationalStore = { ...store, prepare(sql) {
    const item = { sql, params: [] as unknown[] }; sqls.push(item);
    const wrap = (stmt: PreparedStatement): PreparedStatement => ({ ...stmt, bind(...params) { item.params=params; return wrap(stmt.bind(...params)); } });
    return wrap(store.prepare(sql));
  } };
  return { sqls, db };
}

describe('maintained Health and Today contracts', () => {
  it('pins every frozen trigger to its generator', () => {
    expect(VNEXT_STATEMENTS.filter(sql => sql.startsWith('CREATE TRIGGER'))).toEqual([...passedOverTriggers(), ...changeMarkTriggers()].map(t => t.sql));
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
      expect(await catchUpKpiPhase(f.db, 'failures')).toBe(50);
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

  it('drives recent machine capture through its live time range', async () => {
    const f = fixture();
    const { sqls, db } = captureSql(f.db);
    try {
      await recentMachineCapture(db, NOW);
      const item = sqls[0]!;
      const plan = f.sqlite.query(`EXPLAIN QUERY PLAN ${item.sql}`).all(...item.params as never[]);
      expect(JSON.stringify(plan)).toContain('idx_sessions_machine_live (last_live_received_at>?)');
    } finally { f.sqlite.close(); }
  });

  it('answers recorded on the first dispatch despite trigger writes and refuses the repeat', async () => {
    const f = fixture();
    try {
      const record = { id: 'recorded', agentId: 'a', task: 'extract-curate', provider: null, model: null, runContext: null, dispatchedBy: null, startedAt: NOW };
      expect(await recordDispatch(f.db, { projectId: 'proj_1' }, record)).toBe(true);
      expect(await recordDispatch(f.db, { projectId: 'proj_1' }, record)).toBe(false);
      expect((await todayMarks(f.db))[0]).toBe('1');
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
      for (const sql of VNEXT_STATEMENTS) f.sqlite.run(sql);
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

  it('measures the extra writes for membership and each mark mechanism', () => {
    const f = fixture();
    try {
      f.source('s'); f.fail('s');
      f.run('r','running');
      f.sqlite.run("INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at) VALUES('proj_1','p','s','e','m','p','body','h','active',1,1,'tok_1',1)");
      f.sqlite.run("INSERT INTO spore_curation_changes(project_id,revision,dirty) VALUES('proj_1',1,1) ON CONFLICT(project_id) DO NOTHING");
      const total = () => (f.sqlite.query('SELECT total_changes() AS n').get() as { n: number }).n;
      const extra = (operation: () => void) => {
        const measure = (enabled: boolean) => {
          f.sqlite.run('SAVEPOINT measure');
          if (!enabled) for (const trigger of [...passedOverTriggers(), ...changeMarkTriggers()]) f.sqlite.run(`DROP TRIGGER ${trigger.name}`);
          const before = total(); operation(); const writes = total() - before;
          f.sqlite.run('ROLLBACK TO measure'); f.sqlite.run('RELEASE measure');
          return writes;
        };
        return measure(true) - measure(false);
      };
      const measured = {
        failureInsert: extra(() => f.fail('s','new')),
        failureRepeat: extra(() => f.fail('s')),
        failureUpdate: extra(() => f.fail('s','m',NOW+1,'changed')),
        failureDelete: extra(() => f.sqlite.run("DELETE FROM embedding_source_failures WHERE record_id='s'")),
        sourceEdit: extra(() => f.sqlite.run("UPDATE sessions SET summary='edited' WHERE session_id='s'")),
        sourceDelete: extra(() => f.sqlite.run("DELETE FROM sessions WHERE session_id='s'")),
        runInsert: extra(() => f.run('new','queued')),
        runTransition: extra(() => f.sqlite.run("UPDATE agent_runs SET status='completed' WHERE id='r'")),
        runDelete: extra(() => f.sqlite.run("DELETE FROM agent_runs WHERE id='r'")),
        runNoop: extra(() => f.sqlite.run("UPDATE agent_runs SET status=status,held_by=held_by,completed_at=completed_at WHERE id='r'")),
        planNoop: extra(() => f.sqlite.run("UPDATE plans SET title=title,updated_at=updated_at WHERE plan_key='p'")),
        curationNoop: extra(() => f.sqlite.run("UPDATE spore_curation_changes SET revision=revision,dirty=dirty WHERE project_id='proj_1'")),
        planUpdate: extra(() => f.sqlite.run("UPDATE plans SET updated_at=updated_at+1 WHERE plan_key='p'")),
        planDelete: extra(() => f.sqlite.run("DELETE FROM plans WHERE plan_key='p'")),
        curationUpdate: extra(() => f.sqlite.run("UPDATE spore_curation_changes SET revision=revision+1 WHERE project_id='proj_1'")),
        curationDelete: extra(() => f.sqlite.run("DELETE FROM spore_curation_changes WHERE project_id='proj_1'")),
      };
      console.info('S3B_EXTRA_WRITES', JSON.stringify(measured));
      expect(measured).toEqual({ failureInsert: 1, failureRepeat: 0, failureUpdate: 1, failureDelete: 1, sourceEdit: 1, sourceDelete: 1,
        runInsert: 1, runTransition: 1, runDelete: 1, runNoop: 0, planNoop: 0, curationNoop: 0, planUpdate: 1, planDelete: 1, curationUpdate: 1, curationDelete: 1 });
    } finally { f.sqlite.close(); }
  });

  it('shows a queued admission failure through indexed ranges until a later completion clears it', async () => {
    const f = fixture();
    try {
      f.run('older', 'failed', NOW - 20);
      f.run('queued', 'queued', NOW - 10);
      expect((await failQueuedRun(f.db, { projectId: 'proj_1' }, 'queued', NOW, 'Could not start the task.', 'task_start_failed')).applied).toBe(true);
      const { db, sqls } = captureSql(f.db);
      expect(await unresolvedFailures(db, [{ projectId: 'proj_1', task: 'extract-curate' }])).toMatchObject([{ runId: 'queued', failures: 2 }]);
      const item = sqls[0]!;
      const plan = JSON.stringify(f.sqlite.query(`EXPLAIN QUERY PLAN ${item.sql}`).all(...item.params as never[]));
      expect(plan).toContain('idx_agent_runs_task (project_id=? AND task=? AND status=? AND started_at>?)');
      expect(plan).toContain('idx_agent_runs_task (project_id=? AND task=? AND status=? AND started_at=?)');
      expect(plan).not.toContain('SCAN r');
      expect((await readWorkNow(f.serverEnv, { projectId: 'proj_1' }, NOW, false)).needsYou).toMatchObject([{ runId: 'queued', why: 'Could not start the task.' }]);
      f.run('success', 'completed', NOW + 1);
      expect(await unresolvedFailures(f.db, [{ projectId: 'proj_1', task: 'extract-curate' }])).toEqual([]);
    } finally { f.sqlite.close(); }
  });

  it('writes nothing for a repeated queue holder and keeps no-op marks stable', async () => {
    const f = fixture();
    try {
      f.run('q', 'queued');
      await recordQueueHolder(f.db, { projectId: 'proj_1' }, 'q', 'worker');
      const before = f.sqlite.query('SELECT total_changes() AS n').get();
      const marks = await todayMarks(f.db);
      await recordQueueHolder(f.db, { projectId: 'proj_1' }, 'q', 'worker');
      expect(f.sqlite.query('SELECT total_changes() AS n').get()).toEqual(before);
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

  it('seeks setup output only for tasks that can publish output', async () => {
    const f = fixture();
    try {
      const { db, sqls } = captureSql(f.db);
      await readSetupProgress({ ...f.serverEnv, db }, { all: true }, NOW);
      const item = sqls.find(item => item.sql.includes(' AS produced'))!;
      expect(item).toBeDefined();
      expect(item.sql).not.toMatch(/curate-spores|turn-cards|embedding-reconcile/);
      const plan = JSON.stringify(f.sqlite.query(`EXPLAIN QUERY PLAN ${item.sql}`).all(...item.params as never[]));
      expect(plan).toContain('idx_agent_runs_task (project_id=? AND task=? AND status=?)');
      expect(plan).not.toContain('SCAN a');
    } finally { f.sqlite.close(); }
  });

  it('prioritizes live and failing Projects with bounded seeks and pages without repetition', async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 30; i++) f.sqlite.run('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,?)', [`p${i}`, `p${i}`, NOW]);
      f.run('failure', 'failed', NOW);
      f.sqlite.run("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at) VALUES('p0','q','a','retired-task','queued',1)");
      const { db, sqls } = captureSql(f.db);
      const first = await todayProjects(db, { all: true });
      expect(first.read.slice(0, 2).sort()).toEqual(['p0', 'proj_1']);
      const next = await todayProjects(f.db, { all: true }, first.cursor);
      expect(new Set([...first.read, ...next.read]).size).toBe(first.total);
      const item = sqls[0]!;
      const plan = JSON.stringify(f.sqlite.query(`EXPLAIN QUERY PLAN ${item.sql}`).all(...item.params as never[]));
      expect(plan).toContain('idx_agent_runs_claimable (status=?)');
      expect(plan).toContain('idx_agent_runs_task (project_id=? AND task=? AND status=? AND started_at>?)');
      expect(plan).not.toContain('SCAN r');
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
