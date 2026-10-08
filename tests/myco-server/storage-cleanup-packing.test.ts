import { expect,it } from 'bun:test';
import type { PreparedStatement } from '@myco-server-worker/core/adapters.js';
import { storageCleanup,storageCleanupPending,setStorageCleanupPaused,STORAGE_CLEANUP_TARGET_BYTES } from '@myco-server-worker/core/storage-cleanup.js';
import { inputArchiveStatements,cleanupCandidate } from '@myco-server-worker/core/storage-cleanup.js';
import { projectedBundleMetadata,prepareArchiveBundle } from '@myco-server-worker/core/archive-bundle.js';
import { processedBody } from '@myco-server-worker/read/processed.js';
import { measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { eventArchiveStatements,prepareArchive } from '@myco-server-worker/core/event-content.js';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { sqliteEnv,uuid } from './helpers/fixtures.js';
import { OWNER_ENV,ownerCookie,seedMemberRoleAccount,MEMBER_SUB,asOwner,asOwnerPatch } from './helpers/owner.js';

type Rig=ReturnType<typeof sqliteEnv>;
const now=Date.now();
function input(rig:Rig,n:number,bytes=5000,session='packing',token='token',project='proj_1'){
  const id=uuid(60000+n);
  rig.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
    VALUES(?,?,?,?,'tool.use','cli','{}',?,?,?)`).run(project,id,session,token,`hash-${id}`,n,now);
  rig.sqlite.query(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,tool_name,input,success,created_at,token_id,received_at)
    VALUES(?,?,?,?,'Read',?,1,?,?,?)`).run(project,id,session,id,'x'.repeat(bytes),n,token,now);
  return id;
}
async function drain(rig:Rig){
  for(let n=0;n<200&&await storageCleanupPending(rig.db);n++)await storageCleanup(rig.serverEnv,now);
  expect(await storageCleanupPending(rig.db)).toBe(false);
}

it('packs sparse identities across pages to the byte target within the invocation budget',async()=>{
  const rig=sqliteEnv();
  try{
    for(let n=0;n<600;n++)input(rig,n,n%10===0?5000:100);
    rig.sqlite.exec('DELETE FROM storage_cleanup_queue');
    const measured=measuredContentEnv(rig.serverEnv,{statements:120,blobCalls:60});
    await storageCleanup(measured.env,now);
    expect(measured.usage.statements).toBeLessThanOrEqual(120);
    expect(measured.usage.blobCalls).toBeLessThanOrEqual(60);
    const bundles=rig.sqlite.query('SELECT size,entry_count FROM archive_bundles').all() as {size:number;entry_count:number}[];
    expect(bundles.length).toBeGreaterThan(0);
    expect(bundles[0]!.entry_count).toBe(14);
    expect(bundles[0]!.size).toBeGreaterThanOrEqual(STORAGE_CLEANUP_TARGET_BYTES);
    await drain(rig);
    expect(await processedBody(rig.serverEnv,{projectId:'proj_1'},'tool-input',uuid(60000))).toBe('x'.repeat(5000));
  }finally{rig.sqlite.close();}
});

it('resumes schema-75 phase zero from a saved cursor with old bundles and partially converted rows intact',async()=>{
  const rig=sqliteEnv();
  try{
    const oldIds=[input(rig,0,16000),input(rig,1,16000)];
    for(const id of oldIds){
      const row=await cleanupCandidate(rig.db,{project_id:'proj_1',resource_kind:'tool-input',resource_id:id});
      await rig.db.batch(await inputArchiveStatements(rig.serverEnv,row!,now));
    }
    const oldBundles=rig.sqlite.query('SELECT * FROM archive_bundles').all();
    const oldProofs=rig.sqlite.query('SELECT * FROM registered_content_proofs ORDER BY source_id').all();
    const oldRows=rig.sqlite.query('SELECT * FROM tool_calls ORDER BY created_at').all();
    for(let n=2;n<40;n++)input(rig,n);
    const cursor=rig.sqlite.query('SELECT rowid AS row_id FROM tool_calls WHERE tool_call_id=?').get(oldIds[0]!) as {row_id:number};
    rig.sqlite.query(`UPDATE storage_cleanup_state SET phase=0,cursor_project='proj_1',cursor_session='packing',
      cursor_created=0,cursor_rowid=?,cursor_id=?,revision=19,converted_rows=2,cleared_bytes=27904,metadata_added_bytes=14000`)
      .run(cursor.row_id,oldIds[0]!);
    rig.sqlite.exec("DROP INDEX idx_storage_cleanup_queue_packing; UPDATE schema_meta SET value='75' WHERE key='version'");
    const saved=rig.sqlite.query('SELECT * FROM storage_cleanup_state').get();
    const migration=renderMigrationFiles().find(file=>file.name==='0076_v76.sql');expect(migration).toBeDefined();
    rig.sqlite.exec(migration!.sql);
    expect(rig.sqlite.query('SELECT * FROM storage_cleanup_state').get()).toEqual(saved);
    await drain(rig);
    expect(rig.sqlite.query('SELECT * FROM archive_bundles WHERE id<=2 ORDER BY id').all()).toEqual(oldBundles);
    expect(rig.sqlite.query('SELECT * FROM tool_calls WHERE tool_call_id IN (?,?) ORDER BY created_at').all(...oldIds)).toEqual(oldRows);
    for(const proof of oldProofs)expect(rig.sqlite.query('SELECT * FROM registered_content_proofs ORDER BY source_id').all()).toContainEqual(proof);
    for(const id of oldIds)expect(await processedBody(rig.serverEnv,{projectId:'proj_1'},'tool-input',id)).toBe('x'.repeat(16000));
    expect(rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get()).toEqual({converted_rows:40});
  }finally{rig.sqlite.close();}
});

it('seeks queued inputs in session order when resource IDs from two sessions interleave',async()=>{
  const rig=sqliteEnv();
  try{
    rig.sqlite.exec('UPDATE storage_cleanup_state SET phase=4,complete=1');
    for(let n=0;n<80;n++)input(rig,n,5000,n%2===0?'a':'b');
    const plan=rig.sqlite.query(`EXPLAIN QUERY PLAN SELECT project_id,session_id,resource_id,resource_kind
      FROM storage_cleanup_queue INDEXED BY idx_storage_cleanup_queue_packing
      WHERE (project_id,session_id,resource_kind,resource_id)>(?,?,?,?)
      ORDER BY project_id,session_id,resource_kind,resource_id LIMIT 100`).all('','','','');
    expect(JSON.stringify(plan)).toContain('SEARCH');
    expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
    await drain(rig);
    expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM tool_calls WHERE input_bundle_id IS NOT NULL').get()).toEqual({n:80});
    expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM storage_cleanup_omissions').get()).toEqual({n:0});
  }finally{rig.sqlite.close();}
});

it('retained-inline admission requires the declared margin, beyond a positive estimate',async()=>{
  const rig=sqliteEnv();
  try{
    const id=input(rig,0,16000);
    const row=await cleanupCandidate(rig.db,{project_id:'proj_1',resource_kind:'tool-input',resource_id:id});
    const metadata=projectedBundleMetadata([{kind:'tool-input',row:row!}]);
    const bytes=2048+Math.ceil(metadata*1.1);
    rig.sqlite.query('UPDATE tool_calls SET input=? WHERE tool_call_id=?').run('x'.repeat(bytes),id);
    await drain(rig);
    expect(rig.bucket.puts).toHaveLength(0);
    expect(rig.sqlite.query('SELECT reason FROM storage_cleanup_omissions').get()).toEqual({reason:'retained-inline:net-gain'});
  }finally{rig.sqlite.close();}
});

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

it('removes retained-inline omissions through archival and session deletion, and reports only live inline rows',async()=>{
  const rig=sqliteEnv();
  try{
    const id=input(rig,0,2500);
    const eventId=uuid(70100);
    rig.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','packing','machine_1','token',0,0)`).run();
    rig.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      VALUES('proj_1',?,'packing','token','response','import','{"text":"small"}','hash',0,?)`).run(eventId,now);
    await drain(rig);
    const row=await cleanupCandidate(rig.db,{project_id:'proj_1',resource_kind:'event',resource_id:eventId});
    await rig.db.batch(eventArchiveStatements(rig.db,row!,await prepareArchive(rig.serverEnv,'event',row!,now)));
    expect(rig.sqlite.query('SELECT resource_id FROM storage_cleanup_omissions').all()).toEqual([{resource_id:id}]);
    rig.sqlite.query(`INSERT INTO storage_cleanup_omissions VALUES('proj_1','event','missing','retained-inline:net-gain',0)`).run();
    const status=await worker.fetch(await asOwner(rig.db, '/api/storage-cleanup'),{...rig.env,...OWNER_ENV});
    expect(await status.json()).toMatchObject({retainedInline:[{resource_kind:'tool-input',rows:1}]});
    await tombstoneSession(rig.serverEnv,{projectId:'proj_1'},'packing','mem_machine_1',now);
    expect(rig.sqlite.query('SELECT resource_id FROM storage_cleanup_omissions').all()).toEqual([{resource_id:'missing'}]);
    const after=await worker.fetch(await asOwner(rig.db, '/api/storage-cleanup'),{...rig.env,...OWNER_ENV});
    expect(await after.json()).toMatchObject({retainedInline:[]});
  }finally{rig.sqlite.close();}
});

it('retains unprofitable inputs and events inline, records the reason, and publishes no objects',async()=>{
  const rig=sqliteEnv();
  try{
    input(rig,0,2500);
    rig.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      VALUES('proj_1',?,'small','token','response','import',?,'hash',0,?)`).run(uuid(70000),'{"text":"small"}',now);
    await drain(rig);
    expect(rig.bucket.puts).toHaveLength(0);
    expect(rig.sqlite.query('SELECT input FROM tool_calls').get()).toEqual({input:'x'.repeat(2500)});
    expect(rig.sqlite.query('SELECT reason FROM storage_cleanup_omissions').all()).toEqual([
      {reason:'retained-inline:net-gain'},{reason:'retained-inline:net-gain'}]);
    const response=await worker.fetch(await asOwner(rig.db, '/api/storage-cleanup'),{...rig.env,...OWNER_ENV});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({retainedInline:[{resource_kind:'event',rows:1},{resource_kind:'tool-input',rows:1}]});
  }finally{rig.sqlite.close();}
});

it('pause on a cross-page boundary stops publication and resume keeps the cursor',async()=>{
  let rig:Rig;let pages=0;
  rig=sqliteEnv({onSql(sql){if(sql.includes('SELECT rowid AS source_rowid,project_id,tool_call_id')&&++pages===2)
    rig.sqlite.exec('UPDATE storage_cleanup_state SET paused=1,revision=revision+1');}});
  try{
    for(let n=0;n<400;n++)input(rig,n,n%10===0?5000:100);
    rig.sqlite.exec('DELETE FROM storage_cleanup_queue');
    const cursor=rig.sqlite.query('SELECT cursor_project,cursor_session,cursor_created,cursor_rowid FROM storage_cleanup_state').get();
    expect(await storageCleanup(rig.serverEnv,now)).toEqual({changed:0,more:false});
    expect(pages).toBe(2);
    expect(rig.bucket.puts).toHaveLength(0);
    expect(rig.sqlite.query('SELECT cursor_project,cursor_session,cursor_created,cursor_rowid FROM storage_cleanup_state').get()).toEqual(cursor);
    await setStorageCleanupPaused(rig.db,false,now);
    await drain(rig);
    expect(rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get()).toEqual({converted_rows:40});
  }finally{rig.sqlite.close();}
});

it('pause after preparation discards unadopted objects and leaves source bytes and cursor unchanged',async()=>{
  const rig=sqliteEnv();
  try{
    input(rig,0,16000);let puts=0;
    const env={...rig.serverEnv,blobs:{...rig.bucket,put:async(...args:Parameters<typeof rig.bucket.put>)=>{
      const result=await rig.bucket.put(...args);if(++puts===2)await setStorageCleanupPaused(rig.db,true,now);return result;
    }}};
    expect(await storageCleanup(env,now)).toEqual({changed:0,more:false});
    expect(rig.sqlite.query('SELECT input_bundle_id FROM tool_calls').get()).toEqual({input_bundle_id:null});
    expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM prepared_archive_bundles').get()).toEqual({n:0});
    await setStorageCleanupPaused(rig.db,false,now);await drain(rig);
    expect(await processedBody(rig.serverEnv,{projectId:'proj_1'},'tool-input',uuid(60000))).toBe('x'.repeat(16000));
  }finally{rig.sqlite.close();}
});

it('never mixes Project, session or uploader evidence when packing',async()=>{
  const rig=sqliteEnv();
  try{
    for(const [group,project,session,token] of [[0,'proj_1','a','first'],[1,'proj_1','a','second'],[2,'proj_1','b','first'],[3,'proj_2','a','first']] as const)
      for(let n=0;n<20;n++)input(rig,group*20+n,5000,session,token,project);
    await drain(rig);
    expect(rig.sqlite.query(`SELECT COUNT(*) AS n FROM tool_calls t JOIN archive_bundles a ON a.id=t.input_bundle_id
      WHERE a.project_id<>t.project_id OR a.session_id<>t.session_id OR a.token_id<>t.token_id`).get()).toEqual({n:0});
    expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM tool_calls WHERE input_bundle_id IS NOT NULL').get()).toEqual({n:80});
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
    let intercepted=false;
    const raced=sqliteEnv({onSql(sql,sqlite){if(sql.startsWith('UPDATE storage_cleanup_state SET paused=')&&!intercepted){
      intercepted=true;sqlite.exec("UPDATE members SET role='member' WHERE id='mem_machine_1'");
    }}});
    try{
      expect((await worker.fetch(await asOwnerPatch(raced.db, '/api/storage-cleanup',{paused:true}),{...raced.env,...OWNER_ENV})).status).toBe(403);
      expect(raced.sqlite.query('SELECT paused FROM storage_cleanup_state').get()).toEqual({paused:0});
    }finally{raced.sqlite.close();}
  }finally{rig.sqlite.close();}
});

it('the prepublication metadata projection bounds the adopted accounting',async()=>{
  const rig=sqliteEnv();
  try{
    const id=input(rig,0,16000);
    const row=await cleanupCandidate(rig.db,{project_id:'proj_1',resource_kind:'tool-input',resource_id:id});
    const items=[{kind:'tool-input' as const,row:row!}];
    const bundle=await prepareArchiveBundle(rig.serverEnv,items,now);
    expect(projectedBundleMetadata(items)).toBeGreaterThanOrEqual(bundle.metadataBytes);
  }finally{rig.sqlite.close();}
});
