import { storageCleanup } from '@myco-server-worker/core/storage-cleanup.js';
import { CONTENT_STATEMENT_LIMIT,CONTENT_BLOB_LIMIT,measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { runTick,type TickPacer } from '@myco-server-worker/core/tick.js';
import { expect,it } from 'bun:test';
import type { PreparedStatement } from '@myco-server-worker/core/adapters.js';
import { storageCleanupPending } from '@myco-server-worker/core/storage-cleanup.js';







import worker from '@myco-server-worker/entry/cloudflare.js';
import { sqliteEnv,uuid } from './helpers/fixtures.js';
import { changingAtStatement } from './helpers/store-faults.js';
import { OWNER_ENV,ownerCookie,seedMemberRoleAccount,MEMBER_SUB,asOwner,asOwnerPatch } from './helpers/owner.js';

type Rig=ReturnType<typeof sqliteEnv>;
const now=Date.now();
it('bounds admin status by examined omission identities even when every source is gone',async()=>{
  const rig=sqliteEnv();
  try{
    const readSizes:number[]=[];
    const observe=(statement:PreparedStatement):PreparedStatement=>({
      ...statement,bind:(...values)=>observe(statement.bind(...values)),
      async all<T>(){const result=await statement.all<T>();readSizes.push(result.results.length);return result;},
    });
    rig.env.MYCO_DB={...rig.db,prepare:(sql:string)=>{
      const statement=rig.db.prepare(sql);
      return sql.includes('WITH page AS MATERIALIZED')?observe(statement):statement;
    },async batch(statements:PreparedStatement[]){
      const results=await rig.db.batch(statements);
      statements.forEach((statement,index)=>{
        if('sql' in statement&&typeof statement.sql==='string'&&statement.sql.includes('WITH page AS MATERIALIZED'))
          readSizes.push(results[index]!.results.length);
      });
      return results;
    }};
    for(let n=0;n<250;n++)rig.sqlite.query(`INSERT INTO storage_cleanup_omissions
      VALUES('proj_1','event',?,'retained-inline:net-gain',0)`).run(uuid(75000+n));
    let after:unknown=null,total=0;
    do{
      const path='/api/storage-cleanup'+(after?'?retainedAfter='+encodeURIComponent(JSON.stringify(after)):'');
      const response=await worker.fetch(await asOwner(rig.db, path),{...rig.env,...OWNER_ENV});
      expect(response.status).toBe(200);
      const body=await response.json() as {retainedInline:unknown[];retainedInlinePage:{examined:number;next:unknown}};
      expect(body.retainedInline).toEqual([]);expect(body.retainedInlinePage.examined).toBeLessThanOrEqual(100);
      total+=body.retainedInlinePage.examined;after=body.retainedInlinePage.next;
    }while(after);
    expect(total).toBe(250);
    expect(readSizes).toEqual([101,101,50]);
    expect((await worker.fetch(await asOwner(rig.db, '/api/storage-cleanup?retainedAfter=bad'),{...rig.env,...OWNER_ENV})).status).toBe(400);
  }finally{rig.sqlite.close();}
});

it('declares admin control, refuses other actors, validates the body and rechecks authority at write execution',async()=>{
  const rig=sqliteEnv();
  try{
    seedMemberRoleAccount(rig.sqlite);
    const env={...rig.env,...OWNER_ENV};
    const before=rig.sqlite.query('SELECT * FROM storage_cleanup_state').get();
    for(const method of ['GET','PATCH']){
      const response=await worker.fetch(new Request('https://s/api/storage-cleanup',{method,
        headers:{cookie:await ownerCookie(rig.db, now,MEMBER_SUB),origin:'https://s','cf-connecting-ip':'1.2.3.4'},
        ...(method==='PATCH'?{body:'{"paused":true}'}:{})}),env);
      expect(response.status).toBe(403);
    }
    const unauth=await worker.fetch(new Request('https://s/api/storage-cleanup',{headers:{'cf-connecting-ip':'1.2.3.4'}}),env);
    expect(unauth.status).toBe(401);
    for(const body of [{paused:'yes'},{paused:true,phase:0},{}])expect((await worker.fetch(await asOwnerPatch(rig.db, '/api/storage-cleanup',body),env)).status).toBe(400);
    expect(rig.sqlite.query('SELECT * FROM storage_cleanup_state').get()).toEqual(before);
    expect((await worker.fetch(await asOwnerPatch(rig.db, '/api/storage-cleanup',{paused:true}),env)).status).toBe(200);
    expect(await storageCleanupPending(rig.db)).toBe(false);
    expect((await worker.fetch(await asOwnerPatch(rig.db, '/api/storage-cleanup',{paused:false}),env)).status).toBe(200);
    const raced=sqliteEnv();
    try{
      const landing=changingAtStatement(raced.db,'storage.cleanupSetPaused',()=>{
        raced.sqlite.exec("UPDATE members SET role='member' WHERE id='mem_machine_1'");
      });
      raced.env.MYCO_DB=landing.store;
      expect((await worker.fetch(await asOwnerPatch(raced.db, '/api/storage-cleanup',{paused:true}),{...raced.env,...OWNER_ENV})).status).toBe(403);
      expect(landing.landed()).toBe(true);
      expect(raced.sqlite.query('SELECT paused FROM storage_cleanup_state').get()).toEqual({paused:0});
    }finally{raced.sqlite.close();}
  }finally{rig.sqlite.close();}
});

function sparseSessions(){
  const rig=sqliteEnv();let n=0;
  const input=(bytes:number,session:string)=>{
    const id=uuid(90000+n);
    const payload=JSON.stringify({toolCallId:id,input:'x'.repeat(bytes)});
    rig.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,payload_bytes)
      VALUES('proj_1',?,?,'token','tool.use','import',?,'hash',?,0,?)`).run(id,session,payload,n,new TextEncoder().encode(payload).length);
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
    expect(rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get()).toEqual({converted_rows:54});
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
    expect(next.jobs).toEqual([{name:'storage-content-cleanup',changed:0,more:true,failed:null}]);
    expect(pacer.draining).toEqual(['storage-content-cleanup']);
    expect(next.nextWakeMs).toBe(2000);
    const last=await runTick(rig.serverEnv,now+6000,{pacer});
    expect(last.jobs).toMatchObject([{name:'storage-content-cleanup',changed:51,failed:null}]);
    expect(rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get()).toEqual({converted_rows:54});
  }finally{rig.sqlite.close();}
});
