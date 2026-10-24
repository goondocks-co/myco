import { oldClaim } from '../fixtures/vault-evolution/pre-pause-claim.js';
import { expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { captureViewSession } from './helpers/view-stores.js';
import { archiveRawSources as oldArchive } from '../fixtures/vault-evolution/pre-pause-archive.js';
import { oldRequeueLapsedLease } from '../fixtures/vault-evolution/pre-pause-lease.js';
import { V102_STATEMENTS } from '@myco-server-worker/db/schema-v102.js';
import { settingsWriter as oldSettingsWriter } from '../fixtures/vault-evolution/pre-pause-settings.js';
import { scheduledTasks as oldScheduledTasks } from '../fixtures/vault-evolution/pre-pause-schedule.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { learningHolds } from '@myco-server-worker/core/learning-hold.js';
import { runScheduledTasks } from '@myco-server-worker/core/scheduled-tasks.js';
import { dispatchTask } from '@myco-server-worker/core/harness.js';

const NOW=1_800_000_000_000;
const DAY=86_400_000;
const WINDOW=5*60_000;

/** The model admits later dispatch gates after the frozen clock's global and task switches. */
async function oldClockQueueModel(db: ReturnType<typeof sqliteEnv>['db'], now: number): Promise<number> {
  const leaves=await oldSettingsWriter(db).leaves();
  if(leaves['agent.scheduled_tasks_enabled']?.value!==true) return 0;
  const tasks=leaves['agent.tasks']?.value as Record<string,unknown>|undefined;
  if(!oldScheduledTasks(tasks).some(({task})=>task==='extract-curate')) return 0;
  return oldQueueModel(db,'old-clock',now);
}

async function oldQueueModel(db: ReturnType<typeof sqliteEnv>['db'], id: string, now: number): Promise<number> {
  await db.prepare("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,1)").run();
  const result=await db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,instruction)
    VALUES('proj_1',?,'myco-agent','extract-curate','queued',?,'pre-pause thin instruction')`).bind(id,now).run();
  return result.meta.changes;
}

it('keeps the old clock disabled across migration while preserving the owner task document and restoring the global switch',async()=>{
  const f=sqliteEnv();
  try {
    await captureViewSession(f.db,'proj_1','fresh');
    f.sqlite.run('UPDATE events SET received_at=?',[NOW]);
    const writer=oldSettingsWriter(f.db);
    const originalTasks={'extract-curate':{schedule:{memberRunsPerDay:7}},'title-summary':{reasoningLevel:'high'}};
    expect(await writer.setLeaf('agent.tasks',originalTasks,'owner',NOW)).toEqual({applied:true});
    expect(await writer.setLeaf('agent.scheduled_tasks_enabled',true,'owner',NOW)).toEqual({applied:true});
    const ownerTasks=f.sqlite.query("SELECT value,updated_at,updated_by FROM deployment_settings WHERE leaf='agent.tasks'").get();
    expect(await writer.setLeaf('agent.scheduled_tasks_enabled',false,'operator',NOW+1)).toEqual({applied:true});
    expect(await oldClockQueueModel(f.db,NOW+2)).toBe(0);
    expect(f.sqlite.query("SELECT value,updated_at,updated_by FROM deployment_settings WHERE leaf='agent.tasks'").get()).toEqual(ownerTasks);
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_runs WHERE task='extract-curate' AND status IN ('queued','pending','running')").get()).toEqual({n:0});
    expect(f.sqlite.query('SELECT COUNT(*) AS n FROM events WHERE received_at<=?').get(NOW-90*DAY+WINDOW)).toEqual({n:0});
    await f.db.batch(V102_STATEMENTS.map(sql=>f.db.prepare(sql)));
    expect(f.sqlite.query("SELECT value,updated_at,updated_by FROM retired_deployment_settings WHERE leaf='agent.tasks.extract-curate.schedule'").get()).toEqual(ownerTasks);
    expect(await oldClockQueueModel(f.db,NOW+4)).toBe(0);
    expect(await oldClaim(f.db,'proj_1','old-clock',NOW+5)).toBe(false);
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_runs WHERE task='extract-curate'").get()).toEqual({n:0});
    const migrated=(await settingsWriter(f.db).leaves())['agent.tasks']!.value as Record<string,Record<string,unknown>>;
    expect(migrated).toEqual({'extract-curate':{memberRunsPerDay:7},'title-summary':{reasoningLevel:'high'}});
    expect(await learningHolds(f.db,'proj_1','fresh')).toBe(false);
    expect(await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled',true,'operator',NOW+7)).toEqual({applied:true});
    expect((await settingsWriter(f.db).leaves())['agent.tasks']!.value)
      .toEqual({'extract-curate':{memberRunsPerDay:7},'title-summary':{reasoningLevel:'high'}});
    expect(await learningHolds(f.db,'proj_1','fresh')).toBe(true);
    await runScheduledTasks(f.serverEnv,'idle',NOW+8,'https://fixture.test');
    expect(await dispatchTask(f.serverEnv,'extract-curate','proj_1',{serverUrl:'https://fixture.test',actor:'operator'},NOW+9))
      .toMatchObject({dispatched:false,refusal:'not_landed'});
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_runs WHERE task='extract-curate'").get()).toEqual({n:0});
  } finally {f.sqlite.close();}
});

it('shows that the task-only operator switch is removed from the old clock path by migration',async()=>{
  const f=sqliteEnv();
  try {
    const writer=oldSettingsWriter(f.db);
    expect(await writer.setLeaf('agent.scheduled_tasks_enabled',true,'owner',NOW)).toEqual({applied:true});
    expect(await writer.setTaskSwitch('extract-curate',false,'operator',NOW+1)).toEqual({applied:true});
    expect(await oldClockQueueModel(f.db,NOW+2)).toBe(0);
    await f.db.batch(V102_STATEMENTS.map(sql=>f.db.prepare(sql)));
    expect(await oldClockQueueModel(f.db,NOW+3)).toBe(1);
    expect(await oldClaim(f.db,'proj_1','old-clock',NOW+4)).toBe(true);
  } finally {f.sqlite.close();}
});

it('keeps the clock barrier claim separate from an old hand dispatch admitted during the cutover window',async()=>{
  const f=sqliteEnv();
  try {
    const writer=oldSettingsWriter(f.db);
    expect(await writer.setLeaf('agent.scheduled_tasks_enabled',false,'operator',NOW)).toEqual({applied:true});
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_runs WHERE task='extract-curate' AND status IN ('queued','pending','running')").get()).toEqual({n:0});
    await f.db.batch(V102_STATEMENTS.map(sql=>f.db.prepare(sql)));
    expect(await oldClockQueueModel(f.db,NOW+1)).toBe(0);
    expect(await oldQueueModel(f.db,'old-manual',NOW+2)).toBe(1);
    expect(await oldClaim(f.db,'proj_1','old-manual',NOW+3)).toBe(true);
    expect(f.sqlite.query("SELECT status FROM agent_runs WHERE id='old-manual'").get()).toEqual({status:'running'});
  } finally {f.sqlite.close();}
});

it('models migrate-then-deploy old-code writes and admits only a preflight with no lapse or archive candidate', async () => {
  for(const admitted of [false,true]) {
    const f=sqliteEnv();
    try {
      await captureViewSession(f.db,'proj_1','held-source');
      f.sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')");
      if(admitted) f.sqlite.run("UPDATE events SET received_at=?",[NOW]);
      f.sqlite.run("UPDATE raw_archive_state SET phase=2 WHERE id=1");
      if(!admitted) {
        f.sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,1)");
        f.sqlite.run("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at,lease_expires_at) VALUES('proj_1','lapsed','myco-agent','extract-curate','running',1,1,2)");
      }
      const live=f.sqlite.query("SELECT COUNT(*) AS n FROM agent_runs WHERE task='extract-curate' AND status IN ('queued','pending','running')").get() as {n:number};
      const aged=f.sqlite.query("SELECT COUNT(*) AS n FROM events WHERE session_id='held-source' AND received_at<=?").get(NOW-90*DAY+WINDOW) as {n:number};
      expect(live.n===0 && aged.n===0).toBe(admitted);
      await f.db.batch(V102_STATEMENTS.map(sql=>f.db.prepare(sql)));
      expect(await oldRequeueLapsedLease(f.db,{projectId:'proj_1'},'lapsed',null,NOW)).toBe(!admitted);
      let archived=0;
      for(let pass=0;pass<3;pass++) archived+=await oldArchive(f.serverEnv,NOW+WINDOW,90);
      expect(archived>0).toBe(!admitted);
      if(admitted) {
        expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_runs WHERE task='extract-curate' AND status IN ('queued','pending','running')").get()).toEqual({n:0});
        expect(f.sqlite.query("SELECT COUNT(*) AS n FROM events WHERE payload_format='archived'").get()).toEqual({n:0});
      }
    } finally {f.sqlite.close();}
  }
});

it('exposes a clock and already-admitted poll crossing a snapshot-only preflight', async () => {
  const f=sqliteEnv();
  try {
    await captureViewSession(f.db,'proj_1','fresh');
    f.sqlite.run("UPDATE events SET received_at=?",[NOW]);
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_runs WHERE task='extract-curate' AND status IN ('queued','pending','running')").get()).toEqual({n:0});
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM events WHERE received_at<=?").get(NOW-90*DAY+WINDOW)).toEqual({n:0});
    await f.db.batch(V102_STATEMENTS.map(sql=>f.db.prepare(sql)));
    expect(await oldSettingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled',true,'owner',NOW)).toEqual({applied:true});
    expect(await oldClockQueueModel(f.db,NOW+1)).toBe(1);
    expect(await oldClaim(f.db,'proj_1','old-clock',NOW+2)).toBe(true);
    expect(f.sqlite.query("SELECT status,instruction FROM agent_runs WHERE id='old-clock'").get())
      .toEqual({status:'running',instruction:'pre-pause thin instruction'});
  } finally {f.sqlite.close();}
});
