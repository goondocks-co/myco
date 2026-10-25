import { expect, it } from 'bun:test';
import { withViewStores } from './helpers/view-stores.js';
import { V102_STATEMENTS } from '@myco-server-worker/db/schema-v102.js';
import { memberRunsPerDay } from '@myco-server-worker/core/schedule-rules.js';
import { taskOverridesResolution, settingsWriter } from '@myco-server-worker/core/settings.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { legacyWorker } from './helpers/worker-principal.js';
import { createBackup, backupArtifact, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { claimNextRun, expireLeases } from '@myco-server-worker/core/harness.js';

it('preserves extraction choices and unrelated preferences through the pause migration on both stores', async () => {
  await withViewStores(async db => {
    const tasks = { 'extract-curate': { harness: 'claude-code', schedule: { enabled: false, memberRunsPerDay: 7, intervalSeconds: 12 } },
      'canopy-map': { schedule: { enabled: true } } };
    await db.prepare("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by,write_id) VALUES('agent.tasks',?,123,'owner','old')")
      .bind(JSON.stringify(tasks)).run();
    await db.batch(V102_STATEMENTS.map(sql => db.prepare(sql)));
    const row = (await db.prepare("SELECT value FROM deployment_settings WHERE leaf='agent.tasks'").first<{ value: string }>())!;
    expect(JSON.parse(row.value)).toEqual({ 'extract-curate': { harness: 'claude-code', enabled: false, memberRunsPerDay: 7 },
      'canopy-map': tasks['canopy-map'] });
    expect(taskOverridesResolution(JSON.parse(row.value)).effective).toMatchObject({ 'extract-curate': { enabled: false, memberRunsPerDay: 7 } });
    expect(await memberRunsPerDay({ db } as Parameters<typeof memberRunsPerDay>[0], 'extract-curate')).toBe(7);
    expect(await db.prepare("SELECT value,updated_at,updated_by FROM retired_deployment_settings WHERE leaf='agent.tasks.extract-curate.schedule'").first())
      .toEqual({ value: JSON.stringify(tasks), updated_at: 123, updated_by: 'owner' });
    const pause = await db.prepare("SELECT value FROM schema_meta WHERE key='learning_paused_at'").first();
    await db.batch(V102_STATEMENTS.map(sql => db.prepare(sql)));
    expect(await db.prepare("SELECT value FROM schema_meta WHERE key='learning_paused_at'").first()).toEqual(pause);
    expect(await db.prepare("SELECT value FROM deployment_settings WHERE leaf='agent.tasks'").first()).toEqual(row);
  }, 101);
}, 30_000);

it('ends queued rows and retires only their credentials while preserving held attempts on both stores', async () => {
  await withViewStores(async db => {
    await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,1)").run();
    await ensureMember(db,'mem_harness',1,'member');
    const credentials = new Map<string,string>();
    for (const [id, status, task] of [['queued','queued','extract-curate'], ['held','running','extract-curate'], ['title','queued','title-summary']]) {
      const token=await issueMemberToken(db,{memberId:'mem_harness',machineId:'harness'},1);
      credentials.set(id!,token.tokenId);
      await db.prepare("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at,lease_expires_at,instruction,dispatched_by) VALUES('project',?,'myco-agent',?,?,1,2,999,'kept',?)")
        .bind(id, task, status,token.tokenId).run();
    }
    await db.batch(V102_STATEMENTS.map(sql => db.prepare(sql)));
    expect(await db.prepare("SELECT status,run_context FROM agent_runs WHERE id='queued'").first())
      .toEqual({ status: 'skipped', run_context: '{"reason":"learning_paused"}' });
    expect(await db.prepare("SELECT status,started_at,lease_expires_at,instruction FROM agent_runs WHERE id='held'").first())
      .toEqual({ status: 'running', started_at: 2, lease_expires_at: 999, instruction: 'kept' });
    expect(await db.prepare("SELECT status FROM agent_runs WHERE id='title'").first()).toEqual({ status: 'queued' });
    for(const [id,tokenId] of credentials) {
      const row=await db.prepare('SELECT revoked_at FROM member_credentials WHERE id=?').bind(tokenId).first<{revoked_at:number|null}>();
      expect(row!==null).toBe(true);
      expect(row!.revoked_at===null).toBe(id!=='queued');
    }
  }, 101);
}, 30_000);

it('preserves explicit destinations, zero allowances and malformed preferences on both stores',async()=>{
  await withViewStores(async db=>{
    for(const [held,wanted] of [
      [{enabled:true,memberRunsPerDay:0,schedule:{enabled:false,memberRunsPerDay:7}},{enabled:true,memberRunsPerDay:0}],
      [{schedule:{enabled:false,memberRunsPerDay:0}},{enabled:false,memberRunsPerDay:0}],
      [{schedule:{enabled:'invalid',memberRunsPerDay:'invalid'}},{enabled:'invalid',memberRunsPerDay:'invalid'}],
    ]) {
      const value=JSON.stringify({'extract-curate':held});
      await db.prepare("DELETE FROM retired_deployment_settings WHERE leaf='agent.tasks.extract-curate.schedule'").run();
      await db.prepare("INSERT OR REPLACE INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.tasks',?,123,'owner')").bind(value).run();
      await db.batch(V102_STATEMENTS.map(sql=>db.prepare(sql)));
      const saved=await db.prepare("SELECT value FROM deployment_settings WHERE leaf='agent.tasks'").first<{value:string}>();
      expect(JSON.parse(saved!.value)).toEqual({'extract-curate':wanted});
      expect(await db.prepare("SELECT value FROM retired_deployment_settings WHERE leaf='agent.tasks.extract-curate.schedule'").first()).toEqual({value});
    }
    await db.prepare("DELETE FROM retired_deployment_settings WHERE leaf='agent.tasks.extract-curate.schedule'").run();
    await db.prepare("UPDATE deployment_settings SET value='malformed-json' WHERE leaf='agent.tasks'").run();
    await db.batch(V102_STATEMENTS.map(sql=>db.prepare(sql)));
    expect(await db.prepare("SELECT value FROM deployment_settings WHERE leaf='agent.tasks'").first()).toEqual({value:'malformed-json'});
    expect(taskOverridesResolution('malformed-json').effective).toBeNull();
  },101);
},30_000);

it('reports stored ramp preferences as retired and refuses a new ramp write', async () => {
  await withViewStores(async db => {
    const stored={'title-summary':{schedule:{rampRunsPerDay:3}}};
    expect(taskOverridesResolution(stored)).toMatchObject({reasons:expect.arrayContaining([
      'title-summary.schedule.rampRunsPerDay: no scheduling consumer uses this field.',
    ])});
    expect(await settingsWriter(db).setLeaf('agent.tasks',stored,'owner',1)).toMatchObject({applied:false,refusal:{reason:'invalid_value'}});
  });
},30_000);

it('keeps the destination pause and preferences when portable artifacts restore older extraction rows', async () => {
  const source=sqliteEnv();
  const target=sqliteEnv();
  try {
    source.sqlite.run("INSERT INTO schema_meta(key,value) VALUES('learning_resumed_at','2')");
    source.sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.tasks','{\"extract-curate\":{\"memberRunsPerDay\":7}}',1,'source-owner')");
    target.sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.tasks','{\"extract-curate\":{\"memberRunsPerDay\":9}}',1,'target-owner')");
    source.sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,1)");
    for(const [id,status] of [['queued','queued'],['held','running']]) {
      source.sqlite.run("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at,lease_expires_at,instruction) VALUES('proj_1',?,'myco-agent','extract-curate',?,1,1,2,'old instruction')",[id!,status!]);
    }
    const backup=await createBackup(source.db,source.bucket,{producer:'test',now:10});
    const artifact=(await backupArtifact(source.db,source.bucket,backup.id))!;
    expect(artifact.text).not.toContain('learning_resumed_at');
    const pause=target.sqlite.query("SELECT value FROM schema_meta WHERE key='learning_paused_at'").get();
    await expect(restoreArtifact(target.db,{authorization:{kind:'recovery'},text:artifact.text,allowForeignLineage:true})).rejects.toThrow('thin_learning_not_drained');
    expect(target.sqlite.query("SELECT value FROM schema_meta WHERE key='learning_paused_at'").get()).toEqual(pause);
    expect(target.sqlite.query("SELECT value FROM schema_meta WHERE key='learning_resumed_at'").get()).toBeNull();
    expect(await memberRunsPerDay(target.serverEnv,'extract-curate')).toBe(9);
    expect(target.sqlite.query("SELECT * FROM agent_runs WHERE task='extract-curate'").all()).toEqual([]);
  } finally {source.sqlite.close();target.sqlite.close();}
});
