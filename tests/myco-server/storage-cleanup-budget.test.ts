import { expect,it } from 'bun:test';
import { storageCleanup,storageCleanupPending } from '@myco-server-worker/core/storage-cleanup.js';
import { CONTENT_STATEMENT_LIMIT,CONTENT_BLOB_LIMIT,measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { runTick,type TickPacer } from '@myco-server-worker/core/tick.js';
import { sqliteEnv,uuid } from './helpers/fixtures.js';

function sparseSessions(){
  const rig=sqliteEnv();let n=0;
  const input=(bytes:number,session:string)=>{
    const id=uuid(90000+n);
    rig.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      VALUES('proj_1',?,?,'token','tool.use','cli','{}','hash',?,0)`).run(id,session,n);
    rig.sqlite.query(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,tool_name,input,success,created_at,token_id,received_at)
      VALUES('proj_1',?,?,?,'Read',?,1,?,'token',0)`).run(id,session,id,'x'.repeat(bytes),n);
    n++;
  };
  for(let i=0;i<3;i++)input(5000,'a');
  for(let i=0;i<298;i++)input(100,'b');
  for(let i=0;i<3;i++)input(5000,'b');
  rig.sqlite.exec('DELETE FROM storage_cleanup_queue');
  return rig;
}

it('reserves final pending reads after sparse bundle adoption within the default budget',async()=>{
  const rig=sparseSessions();
  try{
    const measured=measuredContentEnv(rig.serverEnv,{statements:CONTENT_STATEMENT_LIMIT,blobCalls:CONTENT_BLOB_LIMIT});
    const report=await storageCleanup(measured.env,Date.now());
    expect(report).toEqual({changed:3,more:true});
    expect(measured.usage.statements).toBeLessThanOrEqual(CONTENT_STATEMENT_LIMIT);
    expect(measured.usage.blobCalls).toBeLessThanOrEqual(CONTENT_BLOB_LIMIT);
    expect(rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get()).toEqual({converted_rows:report.changed});
    expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM prepared_archive_bundles').get()).toEqual({n:0});
    for(let i=0;i<100&&await storageCleanupPending(rig.db);i++)await storageCleanup(rig.serverEnv,Date.now());
    expect(await storageCleanupPending(rig.db)).toBe(false);
    expect(rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get()).toEqual({converted_rows:6});
  }finally{rig.sqlite.close();}
});

it('reports committed cleanup progress and keeps the tick draining after a sparse cohort',async()=>{
  const rig=sparseSessions();const now=Date.now();
  try{
    const pacer:TickPacer={fullAt:now,state:'idle',heldBy:'storage-cleanup:pending',idleMs:300000,
      draining:['storage-content-cleanup']};
    const report=await runTick(rig.serverEnv,now+2000,{pacer});
    expect(report.jobs).toEqual([{name:'storage-content-cleanup',changed:3,more:true,failed:null}]);
    expect(rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get()).toEqual({converted_rows:3});
    expect(pacer.draining).toEqual(['storage-content-cleanup']);
    expect(report.nextWakeMs).toBe(2000);
    const next=await runTick(rig.serverEnv,now+4000,{pacer});
    expect(next.jobs).toMatchObject([{name:'storage-content-cleanup',changed:3,failed:null}]);
    expect(rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get()).toEqual({converted_rows:6});
  }finally{rig.sqlite.close();}
});
