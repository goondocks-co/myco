import { expect,it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { Miniflare } from 'miniflare';
import { bundleArchiveStatements,type BundleItem,type PreparedBundle } from '@myco-server-worker/core/archive-bundle.js';
import { storageCleanup } from '@myco-server-worker/core/storage-cleanup.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { envelope,sqliteEnv,uuid } from './helpers/fixtures.js';

type Captured={sql:string;params:unknown[]};
const PROJECT='proj_1';

function item(n:number,old=false):BundleItem {
  return {kind:'tool-input',row:{project_id:PROJECT,resource_id:uuid(100+n),event_id:uuid(100+n),
    session_id:'sess_1',token_id:'token',envelope_hash:'hash',content_revision:0,bytes:1,received_at:0,
    input_bundle_id:old?n+1:null,input_bundle_entry:old?0:null,
    input_archive_key:old?`old-body-${n}`:null,input_receipt_key:old?`old-receipt-${n}`:null}};
}

function cleanupSql(sqlite:Database,items:BundleItem[]):Captured[] {
  const bundle:PreparedBundle={source:{projectId:PROJECT,sessionId:'sess_1',tokenId:'token',eventId:uuid(1),
    envelopeHash:'hash',sourceKind:'bundle',resourceId:'new-body'},
  preparationId:'test-preparation',
  body:{key:'new-body',generation:'generation',size:1,digest:'new-body'},
  receipt:{key:'new-receipt',generation:'generation',size:1,digest:'new-receipt'},
  entries:[],items:items.map(item=>({...item,preview:'x'})),metadataBytes:0};
  return bundleArchiveStatements(sqliteRelationalStore(sqlite),bundle) as unknown as Captured[];
}

function statement(statements:Captured[],table:string):Captured {
  const found=statements.find(entry=>entry.sql.startsWith(`DELETE FROM ${table} WHERE`));
  if(!found)throw new Error(`missing ${table} cleanup`);
  return found;
}

function proofStatements(statements:Captured[]):Captured[] {
  return statements.filter(entry=>entry.sql.startsWith('DELETE FROM registered_content_proofs WHERE'));
}

function plan(sqlite:Database,entry:Captured):string {
  return (sqlite.query(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...entry.params as never[]) as {detail:string}[])
    .map(row=>row.detail).join('\n');
}

function sqlLiteral(value:unknown):string {
  if(value===null)return 'NULL';
  if(typeof value==='number')return String(value);
  if(typeof value==='string')return `'${value.replaceAll("'","''")}'`;
  throw new Error('unsupported test parameter');
}

async function vmSteps(sqlite:Database,entry:Captured):Promise<number> {
  const executable=process.env.MYCO_SQLITE_VM_PYTHON==='1'?null:
    existsSync('/usr/bin/sqlite3')?'/usr/bin/sqlite3':Bun.which('sqlite3');
  const dir=await mkdtemp(join(tmpdir(),'myco-bundle-work-'));
  try {
    const file=join(dir,'work.sqlite');
    await writeFile(file,sqlite.serialize());
    let index=0;
    const sql=entry.sql.replaceAll('?',()=>sqlLiteral(entry.params[index++]));
    expect(index).toBe(entry.params.length);
    if(executable){
      const result=Bun.spawnSync([executable,'-cmd','.stats on',file,sql],{stdout:'pipe',stderr:'pipe'});
      if(result.exitCode!==0)throw new Error(new TextDecoder().decode(result.stderr));
      const steps=/Virtual Machine Steps:\s+(\d+)/.exec(new TextDecoder().decode(result.stdout));
      if(!steps)throw new Error('sqlite3 VM statistics unavailable');
      return Number(steps[1]);
    }
    const python=Bun.which('python3')??Bun.which('python');
    if(!python)throw new Error('SQLite VM work reader unavailable');
    const script=`import sqlite3, sys
from pathlib import Path
db = sqlite3.connect(':memory:')
db.deserialize(Path(sys.argv[1]).read_bytes())
db.execute('SELECT 1').fetchone()
steps = 0
def progress():
    global steps
    steps += 1
    return 0
db.set_progress_handler(progress, 1)
db.execute(sys.argv[2])
print(steps)`;
    const result=Bun.spawnSync([python,'-c',script,file,sql],{stdout:'pipe',stderr:'pipe'});
    if(result.exitCode!==0)throw new Error(new TextDecoder().decode(result.stderr));
    const steps=Number(new TextDecoder().decode(result.stdout).trim());
    if(!Number.isSafeInteger(steps))throw new Error('Python SQLite VM statistics unavailable');
    return steps;
  } finally { await rm(dir,{recursive:true,force:true}); }
}

it('starts old-key cleanup at bounded identities on a large Project',async()=>{
  const rig=sqliteEnv();
  try {
    rig.sqlite.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<30000)
      INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,
        session_id,digest,size,verified_at,durable)
      SELECT '${PROJECT}','noise-'||x,NULL,'bundle','noise-'||x,'event','hash','sess','noise-'||x,1,0,1 FROM n`);
    rig.sqlite.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<30000)
      INSERT INTO content_scan_checkpoints(project_id,source_kind,resource_id,session_id,event_id,token_id,
        envelope_hash,content_revision,bytes,scanned_bytes,hash_state,preview_bytes,updated_at)
      SELECT '${PROJECT}','tool-input','noise-'||x,'sess','event','token','hash',0,1,0,'','',0 FROM n`);
    rig.sqlite.exec('ANALYZE');
    expect(()=>cleanupSql(rig.sqlite,Array.from({length:21},(_,i)=>item(i,true))))
      .toThrow('content_bundle_page_invalid');
    const empty=cleanupSql(rig.sqlite,[item(1)]);
    const old=cleanupSql(rig.sqlite,Array.from({length:20},(_,i)=>item(i,true)));
    const checkpoint=statement(empty,'content_scan_checkpoints');
    const oldBundle=statement(old,'archive_bundles');
    const proofs=proofStatements(old);
    expect(proofs).toHaveLength(2);
    const emptyProof=proofStatements(empty)[0]!;
    const measured=await Promise.all([checkpoint,oldBundle,emptyProof,...proofs].map(entry=>vmSteps(rig.sqlite,entry)));
    if(process.env.MYCO_BUNDLE_WORK_EVIDENCE==='1')console.log('bundle_cleanup_vm_steps',JSON.stringify(measured));
    const [checkpointSteps,bundleSteps,emptyProofSteps,...proofSteps]=measured;
    expect(checkpointSteps!).toBeLessThan(2_000);
    expect(bundleSteps!).toBeLessThan(15_000);
    expect(emptyProofSteps!).toBeLessThan(500);
    for(const steps of proofSteps)expect(steps).toBeLessThan(20_000);
    expect(plan(rig.sqlite,checkpoint)).toMatch(/SEARCH c USING INDEX sqlite_autoindex_content_scan_checkpoints_1/);
    expect(plan(rig.sqlite,oldBundle)).toMatch(/SEARCH a USING INTEGER PRIMARY KEY/);
    expect(plan(rig.sqlite,oldBundle)).toMatch(/SEARCH t (?:EXISTS )?USING INDEX sqlite_autoindex_tool_calls_1 \(project_id=\? AND tool_call_id=\?\)/);
    expect(plan(rig.sqlite,oldBundle)).toMatch(/SEARCH e USING INDEX sqlite_autoindex_events_1 \(project_id=\? AND event_id=\?\)/);
    for(const proof of proofs){
      const details=plan(rig.sqlite,proof);
      expect(details).toMatch(/SEARCH p USING COVERING INDEX sqlite_autoindex_registered_content_proofs_1 \(project_id=\? AND source_kind=\? AND source_id=\? AND key=\?\)/);
      expect(details).toMatch(/SEARCH a USING COVERING INDEX (sqlite_autoindex_archive_bundles_1|idx_archive_bundles_receipt)/);
      expect(details).not.toMatch(/SCAN p\b|SCAN a\b/);
    }
  } finally { rig.sqlite.close(); }
});

it('workerd D1 plans the bounded old-key deletes as point searches',async()=>{
  const mf=new Miniflare({modules:true,script:'export default { fetch() { return new Response("ok"); } }',
    compatibilityDate:'2026-08-01',d1Databases:['DB']});
  const rig=sqliteEnv();
  try {
    const d1=await mf.getD1Database('DB');
    await d1.batch([
      `CREATE TABLE content_scan_checkpoints(project_id TEXT,source_kind TEXT,resource_id TEXT,
        content_revision INTEGER,envelope_hash TEXT,PRIMARY KEY(project_id,source_kind,resource_id))`,
      `CREATE TABLE archive_bundles(id INTEGER PRIMARY KEY,project_id TEXT,entry_count INTEGER,event_id TEXT,
        archive_key TEXT,receipt_key TEXT,UNIQUE(project_id,archive_key))`,
      `CREATE INDEX idx_archive_bundles_receipt ON archive_bundles(project_id,receipt_key)`,
      `CREATE TABLE registered_content_proofs(project_id TEXT,source_kind TEXT,source_id TEXT,key TEXT,
        PRIMARY KEY(project_id,source_kind,source_id,key))`,
      `CREATE TABLE tool_calls(project_id TEXT,tool_call_id TEXT,input_bundle_id INTEGER,
        PRIMARY KEY(project_id,tool_call_id))`,
      `CREATE TABLE events(project_id TEXT,event_id TEXT,bundle_id INTEGER,PRIMARY KEY(project_id,event_id))`,
    ].map(sql=>d1.prepare(sql)));
    const entries=cleanupSql(rig.sqlite,Array.from({length:20},(_,i)=>item(i,true)));
    for(const entry of [statement(entries,'content_scan_checkpoints'),statement(entries,'archive_bundles'),
      ...proofStatements(entries)]){
      const result=await d1.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).bind(...entry.params).all<{detail:string}>();
      const details=result.results.map(row=>row.detail).join('\n');
      if(entry.sql.includes('content_scan_checkpoints'))
        expect(details).toMatch(/SEARCH c USING .*\(project_id=\? AND source_kind=\? AND resource_id=\?\)/);
      else if(entry.sql.includes('DELETE FROM archive_bundles')){
        expect(details).toMatch(/SEARCH a USING INTEGER PRIMARY KEY/);
        expect(details).toMatch(/SEARCH t USING .*\(project_id=\? AND tool_call_id=\?\)/);
        expect(details).toMatch(/SEARCH e USING .*\(project_id=\? AND event_id=\?\)/);
      } else expect(details).toMatch(/SEARCH p USING .*\(project_id=\? AND source_kind=\? AND source_id=\? AND key=\?\)/);
      expect(details).not.toMatch(/SCAN (c|a|p|e|t)\b/);
    }
  } finally {rig.sqlite.close();await mf.dispose();}
});

it('deletes cleanup queue identities by key even with unrelated queued history',async()=>{
  const rig=sqliteEnv();
  try {
    await storageCleanup(rig.serverEnv,1000);
    const sql=rig.executed.find(text=>text.startsWith('DELETE FROM storage_cleanup_queue WHERE rowid IN'));
    expect(sql).toBeDefined();
    rig.sqlite.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<30000)
      INSERT INTO storage_cleanup_queue(project_id,resource_kind,resource_id,session_id)
      SELECT '${PROJECT}','event','noise-'||x,'sess' FROM n`);
    rig.sqlite.exec('ANALYZE');
    const entries=Array.from({length:20},(_,i)=>({project_id:PROJECT,resource_kind:'event',resource_id:`old-${i}`}));
    const empty={sql:sql!,params:['[]']};
    const twenty={sql:sql!,params:[JSON.stringify(entries)]};
    expect(plan(rig.sqlite,twenty)).toMatch(/SEARCH q USING COVERING INDEX sqlite_autoindex_storage_cleanup_queue_1 \(project_id=\? AND resource_kind=\? AND resource_id=\?\)/);
    const steps=await Promise.all([empty,twenty].map(entry=>vmSteps(rig.sqlite,entry)));
    expect(steps[0]).toBeLessThan(500);
    expect(steps[1]).toBeLessThan(5_000);
  } finally {rig.sqlite.close();}
});

it('deletes only a relocated singleton and its exact proofs, retaining other sources',async()=>{
  const rig=sqliteEnv();
  try {
    const issued=await issueMemberToken(rig.db,{memberId:'mem_machine_1',machineId:'machine_1'},1000);
    const eventId=uuid(101);
    await ingestEvent(rig.db,{projectId:PROJECT,machineId:'machine_1',tokenId:issued.tokenId,bodyBytes:0,now:1000},
      envelope({eventId,kind:'tool.use',payload:{toolCallId:eventId,toolName:'Read',input:{path:'a'},success:true}}),rig.serverEnv);
    const insert=rig.sqlite.query(`INSERT INTO archive_bundles(project_id,session_id,token_id,event_id,envelope_hash,
      archive_key,receipt_key,digest,size,version,entry_count) VALUES(?,?,?,?,?,?,?,?,?,1,?)`);
    for(const [body,receipt,count] of [['old-body','old-receipt',1],['new-body','new-receipt',1],
      ['held-body','held-receipt',2]] as const)
      insert.run(PROJECT,'sess_1',issued.tokenId,eventId,'hash',body,receipt,body,1,count);
    const ids=rig.sqlite.query('SELECT id,archive_key FROM archive_bundles').all() as {id:number;archive_key:string}[];
    const id=(key:string)=>ids.find(row=>row.archive_key===key)!.id;
    rig.sqlite.query('UPDATE tool_calls SET input_bundle_id=?,input_bundle_entry=0 WHERE project_id=? AND tool_call_id=?')
      .run(id('new-body'),PROJECT,eventId);
    const proof=rig.sqlite.query(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,
      event_id,envelope_hash,session_id,digest,size,verified_at,durable) VALUES(?,?,NULL,?,?,?,'hash','sess_1',?,1,0,1)`);
    proof.run(PROJECT,'old-body','bundle','old-body',eventId,'old-body');
    proof.run(PROJECT,'old-receipt','receipt','bundle:old-body',eventId,'old-receipt');
    proof.run(PROJECT,'old-body','event','other-source',eventId,'old-body');
    proof.run(PROJECT,'held-body','bundle','held-body',eventId,'held-body');
    const one=item(1,true);one.row.resource_id=eventId;one.row.event_id=eventId;
    one.row.input_bundle_id=id('old-body');one.row.input_archive_key='old-body';one.row.input_receipt_key='old-receipt';
    const held=item(1,true);held.row.resource_id=eventId;held.row.event_id=eventId;
    held.row.input_bundle_id=id('held-body');held.row.input_archive_key='held-body';held.row.input_receipt_key='held-receipt';
    for(const entry of [statement(cleanupSql(rig.sqlite,[one]),'archive_bundles'),...proofStatements(cleanupSql(rig.sqlite,[one]))])
      rig.sqlite.query(entry.sql).run(...entry.params as never[]);
    expect(rig.sqlite.query("SELECT archive_key FROM archive_bundles WHERE archive_key='old-body'").get()).toBeNull();
    expect(rig.sqlite.query("SELECT source_kind FROM registered_content_proofs WHERE key='old-body'").all())
      .toEqual([{source_kind:'event'}]);
    expect(rig.sqlite.query("SELECT 1 FROM registered_content_proofs WHERE key='old-receipt'").get()).toBeNull();
    for(const entry of [statement(cleanupSql(rig.sqlite,[held]),'archive_bundles'),...proofStatements(cleanupSql(rig.sqlite,[held]))])
      rig.sqlite.query(entry.sql).run(...entry.params as never[]);
    expect(rig.sqlite.query("SELECT archive_key FROM archive_bundles WHERE archive_key='held-body'").get())
      .toEqual({archive_key:'held-body'});
    expect(rig.sqlite.query("SELECT source_kind FROM registered_content_proofs WHERE key='held-body'").get())
      .toEqual({source_kind:'bundle'});
  } finally { rig.sqlite.close(); }
});
