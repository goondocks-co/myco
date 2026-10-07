import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { backupArtifact, BackupApplyError, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { eventContent } from '@myco-server-worker/core/event-content.js';
import { processedBody } from '@myco-server-worker/read/processed.js';
import { reconcileArchivePreparations, verifyBundleArtifact } from '@myco-server-worker/core/archive-bundle.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { toolInputPreview } from '@myco-server-worker/core/tool-input.js';
import { createRecoveryBundle, verifyRecoveryBundle } from '@myco/server/recovery-bundle.js';
import { sqliteEnv } from './helpers/fixtures.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const project = 'proj_archive_backup';
const session = 'sess_archive_backup';
const eventId = 'evt_archive_backup';
const toolId = 'tool_archive_backup';
const envelope = hash('source envelope');
const original = '{ "text" : "the exact original JSON bytes" }';
const fullInput = '界'.repeat(800);
const sourceGeneration = '00000000-0000-4000-8000-000000000001';
type Fixture = ReturnType<typeof sqliteEnv>;
type StoredBundle = { bodyKey: string; bodyText: string; receiptKey: string; receiptText: string; id: number };

function register(f: Fixture, key: string, value: string, generation = sourceGeneration): void {
  f.sqlite.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    VALUES(?,?,?,?,?,?,?)`).run(project,key,Buffer.byteLength(value),'application/json','token',1,generation);
  f.bucket.seed(blobObjectKey(project,key,generation),{size:Buffer.byteLength(value),bytes:new TextEncoder().encode(value)});
}

function bundle(f: Fixture, kind: 'event'|'tool-input', resourceId: string, text: string,
  revision = 0, entryDigest = hash(text)): StoredBundle {
  const entry = {kind,resourceId,eventId,envelopeHash:envelope,revision,rawRevision:3,
    offset:0,length:Buffer.byteLength(text),digest:entryDigest};
  const header = {version:1,projectId:project,sessionId:session,tokenId:'token',entries:[entry]};
  const footer = JSON.stringify(header);
  const bodyText = text+footer+'\n'+Buffer.byteLength(footer).toString(16).padStart(8,'0');
  const bodyKey = hash(bodyText);
  const body = {key:bodyKey,generation:sourceGeneration,size:Buffer.byteLength(bodyText),digest:bodyKey};
  const receiptText = JSON.stringify({version:1,header,body});
  const receiptKey = hash(receiptText);
  register(f,bodyKey,bodyText);
  register(f,receiptKey,receiptText);
  f.sqlite.query(`INSERT INTO archive_bundles(project_id,session_id,token_id,event_id,envelope_hash,
    archive_key,receipt_key,digest,size,version,entry_count) VALUES(?,?,?,?,?,?,?,?,?,1,1)`)
    .run(project,session,'token',eventId,envelope,bodyKey,receiptKey,bodyKey,body.size);
  const id = (f.sqlite.query(`SELECT id FROM archive_bundles WHERE project_id=? AND archive_key=?`)
    .get(project,bodyKey) as {id:number}).id;
  for(const [sourceKind,sourceId,key,value] of [
    ['bundle',bodyKey,bodyKey,bodyText],['receipt',`bundle:${bodyKey}`,receiptKey,receiptText],
  ] as const) {
    f.sqlite.query(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,
      event_id,envelope_hash,session_id,digest,size,verified_at,durable)
      VALUES(?,?,?,?,?,?,?,?,?,?,1,1)`)
      .run(project,key,sourceGeneration,sourceKind,sourceId,eventId,envelope,session,key,Buffer.byteLength(value));
  }
  return {bodyKey,bodyText,receiptKey,receiptText,id};
}

function seed(f: Fixture, withTool = false, badEventDigest = false): {event:StoredBundle;tool?:StoredBundle} {
  const sql=f.sqlite;
  sql.query('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,?)').run(project,project,1);
  sql.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
    VALUES(?,?,?,?,?,?)`).run(project,session,'m','token',1,1);
  sql.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
    created_at,received_at,payload_bytes,payload_format,raw_revision,archived_title_only_end)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)`)
    .run(project,eventId,session,'token','prompt','import','{}',envelope,1,1,0,'archived',3);
  const event=bundle(f,'event',eventId,original,0,badEventDigest ? hash('wrong entry') : hash(original));
  sql.query(`UPDATE events SET bundle_id=?,bundle_entry=0 WHERE project_id=? AND event_id=?`).run(event.id,project,eventId);
  if(!withTool)return {event};
  const tool=bundle(f,'tool-input',toolId,fullInput);
  sql.query(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,tool_name,input,input_bytes,
    input_bundle_id,input_bundle_entry,success,created_at,token_id,received_at)
    VALUES(?,?,?,?,?,?,?,?,0,1,1,?,1)`)
    .run(project,toolId,session,eventId,'test.tool',toolInputPreview(fullInput).preview,
      Buffer.byteLength(fullInput),tool.id,'token');
  return {event,tool};
}

async function artifactOf(f:Fixture):Promise<string> {
  const saved=await createBackup(f.db,f.bucket,{producer:'test',now:1});
  return (await backupArtifact(f.db,f.bucket,saved.id))!.text;
}

function registerTarget(target:Fixture, stored:StoredBundle, generation:string):void {
  register(target,stored.bodyKey,stored.bodyText,generation);
  register(target,stored.receiptKey,stored.receiptText,generation);
}

it('restores shared bundle entries with destination generations and exact bytes',async()=>{
  const source=sqliteEnv();const target=sqliteEnv();
  try {
    const stored=seed(source,true);
    const artifact=await artifactOf(source);
    const generation=randomUUID();
    registerTarget(target,stored.event,generation);
    registerTarget(target,stored.tool!,generation);
    const outcome=await restoreArtifact(target.db,{blobs:target.bucket,text:artifact,allowForeignLineage:true,authorization:{kind:'recovery'}});
    expect(outcome.tables.events?.inserted).toBe(1);
    expect(outcome.tables.tool_calls?.inserted).toBe(1);
    expect((target.sqlite.query(`SELECT generation FROM registered_content_proofs WHERE project_id=? AND key=?`)
      .get(project,stored.event.bodyKey) as {generation:string}).generation).toBe(generation);
    expect(await eventContent({db:target.db,blobs:target.bucket},project,eventId)).toBe(original);
    expect(await processedBody({db:target.db,blobs:target.bucket},{projectId:project},'tool-input',toolId)).toBe(fullInput);
    expect((await restoreArtifact(target.db,{blobs:target.bucket,text:artifact,allowForeignLineage:true,authorization:{kind:'recovery'}})).tables.events?.inserted).toBe(0);
  } finally {source.sqlite.close();target.sqlite.close();}
});

it('restores an unadopted preparation for aged release and preserves a destination reservation conflict',async()=>{
  const source=sqliteEnv();const target=sqliteEnv();
  try {
    const adopted=seed(source).event;
    const orphanText='{"unadopted":true}';const orphanKey=hash(orphanText);
    register(source,orphanKey,orphanText);
    source.sqlite.query(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,
      event_id,envelope_hash,session_id,digest,size,verified_at,durable)
      VALUES(?,?,?,'bundle',?,?,?,?,?,?,1,1)`)
      .run(project,orphanKey,sourceGeneration,orphanKey,eventId,envelope,session,orphanKey,Buffer.byteLength(orphanText));
    for(const id of ['prep-import','prep-conflict'])source.sqlite.query(`INSERT INTO prepared_archive_bundles
      (preparation_id,project_id,archive_key,expires_at) VALUES(?,?,?,1)`).run(id,project,orphanKey);
    const artifact=await artifactOf(source);
    registerTarget(target,adopted,randomUUID());
    const orphanGeneration=randomUUID();
    register(target,orphanKey,orphanText,orphanGeneration);
    const destinationExpiry=Date.now()+60_000;
    target.sqlite.query(`INSERT INTO prepared_archive_bundles(preparation_id,project_id,archive_key,expires_at)
      VALUES('prep-conflict',?,?,?)`).run(project,adopted.bodyKey,destinationExpiry);
    await restoreArtifact(target.db,{blobs:target.bucket,text:artifact,allowForeignLineage:true,
      authorization:{kind:'recovery'}});
    expect(target.sqlite.query(`SELECT archive_key,expires_at FROM prepared_archive_bundles WHERE preparation_id='prep-conflict'`).get())
      .toEqual({archive_key:adopted.bodyKey,expires_at:destinationExpiry});
    expect(target.sqlite.query(`SELECT archive_key FROM prepared_archive_bundles WHERE preparation_id='prep-import'`).get())
      .toEqual({archive_key:orphanKey});
    expect(await reconcileArchivePreparations(target.db,Date.now(),16)).toBe(1);
    for(let pass=0;pass<4;pass++)await drainObjectReleases(target.serverEnv,Date.now());
    expect(target.sqlite.query('SELECT 1 FROM registered_content_proofs WHERE project_id=? AND key=?').get(project,orphanKey)).toBeNull();
    expect(target.sqlite.query('SELECT 1 FROM blobs WHERE project_id=? AND key=?').get(project,orphanKey)).toBeNull();
    expect(target.bucket.objects.has(blobObjectKey(project,orphanKey,orphanGeneration))).toBe(false);
    expect(target.sqlite.query(`SELECT archive_key FROM prepared_archive_bundles WHERE preparation_id='prep-conflict'`).get())
      .toEqual({archive_key:adopted.bodyKey});
    expect(await eventContent({db:target.db,blobs:target.bucket},project,eventId)).toBe(original);
  } finally {source.sqlite.close();target.sqlite.close();}
});

it('maps bundle ids across a populated destination without confusing unrelated rows',async()=>{
  const source=sqliteEnv();const target=sqliteEnv();
  try {
    const stored=seed(source);
    const artifact=await artifactOf(source);
    registerTarget(target,stored.event,randomUUID());
    target.sqlite.query(`INSERT INTO archive_bundles(project_id,session_id,token_id,event_id,envelope_hash,
      archive_key,receipt_key,digest,size,version,entry_count) VALUES(?,?,?,?,?,?,?,?,?,1,1)`)
      .run('proj_unrelated','other','other','other','other','unrelated','unrelated','unrelated',1);
    await restoreArtifact(target.db,{blobs:target.bucket,text:artifact,allowForeignLineage:true,authorization:{kind:'recovery'}});
    const actual=target.sqlite.query(`SELECT a.id FROM events e JOIN archive_bundles a ON a.project_id=e.project_id AND a.id=e.bundle_id
      WHERE e.project_id=? AND e.event_id=?`).get(project,eventId) as {id:number}|null;
    expect(actual?.id).toBeGreaterThan(stored.event.id);
    expect(await eventContent({db:target.db,blobs:target.bucket},project,eventId)).toBe(original);
  } finally {source.sqlite.close();target.sqlite.close();}
});

it('reads a bundled input after a later success changes the tool outcome event',async()=>{
  const source=sqliteEnv();const target=sqliteEnv();
  try {
    const stored=seed(source,true);
    const successId='evt_tool_later_success';
    const successHash=hash('later success envelope');
    source.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,
      envelope_hash,created_at,received_at,payload_bytes,raw_revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(project,successId,session,'token','tool.use','import',
        '{"success":true}',successHash,2,2,16,4);
    source.sqlite.query(`UPDATE tool_calls SET event_id=? WHERE project_id=? AND tool_call_id=?`).run(successId,project,toolId);
    const artifact=await artifactOf(source);
    const generation=randomUUID();
    registerTarget(target,stored.event,generation);
    registerTarget(target,stored.tool!,generation);
    await restoreArtifact(target.db,{blobs:target.bucket,text:artifact,allowForeignLineage:true,authorization:{kind:'recovery'}});
    expect((target.sqlite.query(`SELECT event_id FROM tool_calls WHERE project_id=? AND tool_call_id=?`)
      .get(project,toolId) as {event_id:string}).event_id).toBe(successId);
    expect(await processedBody({db:target.db,blobs:target.bucket},{projectId:project},'tool-input',toolId)).toBe(fullInput);
  } finally {source.sqlite.close();target.sqlite.close();}
});

it('preserves an existing inline event and releases an unused imported bundle',async()=>{
  const source=sqliteEnv();const target=sqliteEnv();
  try {
    const stored=seed(source);
    const artifact=await artifactOf(source);
    registerTarget(target,stored.event,randomUUID());
    target.sqlite.query('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,?)').run(project,project,1);
    target.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES(?,?,?,?,?,?)`).run(project,session,'m','token',1,1);
    target.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
      created_at,received_at,payload_bytes,raw_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(project,eventId,session,'token','prompt','import',original,envelope,1,1,Buffer.byteLength(original),3);
    const outcome=await restoreArtifact(target.db,{blobs:target.bucket,text:artifact,allowForeignLineage:true,authorization:{kind:'recovery'}});
    expect(outcome.tables.events?.inserted).toBe(0);
    expect(outcome.tables.archive_bundles?.inserted).toBe(0);
    expect(target.sqlite.query(`SELECT 1 FROM archive_bundles WHERE project_id=?`).get(project)).toBeNull();
    expect(target.sqlite.query(`SELECT 1 FROM registered_content_proofs WHERE project_id=? AND source_kind='bundle'`).get(project)).toBeNull();
    expect(await eventContent({db:target.db,blobs:target.bucket},project,eventId)).toBe(original);
  } finally {source.sqlite.close();target.sqlite.close();}
});

it('refuses missing bundle or proof closure before restoring any table',async()=>{
  const source=sqliteEnv();const target=sqliteEnv();
  try {
    const stored=seed(source,true);
    const artifact=await artifactOf(source);
    for(const missing of ['archive_bundles','registered_content_proofs'] as const){
      const altered=artifact.trimEnd().split('\n').filter(line=>{
        const parsed=JSON.parse(line) as {t?:string;r?:Record<string,unknown>};
        return parsed.t!==missing || (missing==='registered_content_proofs'&&parsed.r?.key!==stored.event.receiptKey);
      }).join('\n')+'\n';
      await expect(restoreArtifact(target.db,{blobs:target.bucket,text:altered,allowForeignLineage:true,authorization:{kind:'recovery'}}))
        .rejects.toThrow(BackupApplyError);
      expect(target.sqlite.query(`SELECT 1 FROM projects WHERE project_id=?`).get(project)).toBeNull();
    }
  } finally {source.sqlite.close();target.sqlite.close();}
});

it('refuses a valid bundle index that names a different logical source',async()=>{
  const source=sqliteEnv();const target=sqliteEnv();
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'archive-entry-mismatch-'));
  try {
    const stored=seed(source,true);
    const artifact=await artifactOf(source);
    const altered=artifact.trimEnd().split('\n').map(line=>{
      const parsed=JSON.parse(line) as {t?:string;r?:Record<string,unknown>};
      if(parsed.t==='events'&&parsed.r?.event_id===eventId)parsed.r.bundle_id=stored.tool!.id;
      return JSON.stringify(parsed);
    }).join('\n')+'\n';
    const generation=randomUUID();
    registerTarget(target,stored.event,generation);
    registerTarget(target,stored.tool!,generation);
    await expect(restoreArtifact(target.db,{blobs:target.bucket,text:altered,allowForeignLineage:true,
      authorization:{kind:'recovery'}})).rejects.toThrow(BackupApplyError);
    expect(target.sqlite.query(`SELECT 1 FROM projects WHERE project_id=?`).get(project)).toBeNull();

    source.sqlite.query(`UPDATE events SET bundle_id=? WHERE project_id=? AND event_id=?`)
      .run(stored.tool!.id,project,eventId);
    await expect(createBackup(source.db,source.bucket,{producer:'invalid entry',now:2})).rejects.toThrow();
    const destination=path.join(scratch,'refused');
    await expect(createRecoveryBundle(destination,{
      source:{target:'local',locator:'invalid-entry'},
      snapshot:async file=>{source.sqlite.query('VACUUM INTO ?').run(file);return {configuration:{},credentialsRequired:[]};},
      blob:async object=>new Response(new Uint8Array(source.bucket.objects.get(object.source)!.bytes).buffer).body!,
    })).rejects.toThrow();
    await expect(verifyRecoveryBundle(destination)).rejects.toThrow();
  } finally {source.sqlite.close();target.sqlite.close();fs.rmSync(scratch,{recursive:true,force:true});}
});

it('refuses an entry digest mismatch even when the whole object and receipt agree',async()=>{
  const source=sqliteEnv();
  try {
    seed(source,false,true);
    await expect(createBackup(source.db,source.bucket,{producer:'invalid digest',now:2})).rejects.toThrow('content_bundle_entry_digest_mismatch');
  } finally {source.sqlite.close();}
});

it('requires an artifact receipt proof before opening its bundle object',async()=>{
  const source=sqliteEnv();
  try {
    const stored=seed(source);
    const row=source.sqlite.query(`SELECT * FROM archive_bundles WHERE project_id=? AND id=?`)
      .get(project,stored.event.id) as Parameters<typeof verifyBundleArtifact>[1];
    const bodyProof=source.sqlite.query(`SELECT * FROM registered_content_proofs WHERE project_id=? AND key=?`)
      .get(project,stored.event.bodyKey) as Record<string,unknown>;
    await expect(verifyBundleArtifact({db:source.db,blobs:source.bucket},row,[bodyProof],[
      {projectId:project,entry:0,kind:'event',resourceId:eventId,eventId,envelopeHash:envelope,tokenId:'token'},
    ])).rejects.toThrow('event_content_reference_invalid');
  } finally {source.sqlite.close();}
});

it('verifies a full recovery after its original object source is unavailable',async()=>{
  const source=sqliteEnv();
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'archive-recovery-'));
  try {
    const stored=seed(source,true);
    const destination=path.join(scratch,'complete');
    await createRecoveryBundle(destination,{
      source:{target:'local',locator:'archive-fixture'},
      snapshot:async file=>{source.sqlite.query('VACUUM INTO ?').run(file);return {configuration:{},credentialsRequired:[]};},
      blob:async object=>new Response(new Uint8Array(source.bucket.objects.get(object.source)!.bytes).buffer).body!,
    });
    source.bucket.objects.clear();
    await verifyRecoveryBundle(destination);
    const recovered=new Database(path.join(destination,'myco.sqlite'),{readonly:true});
    try {
      expect(recovered.query(`SELECT bundle_id,bundle_entry FROM events WHERE project_id=? AND event_id=?`)
        .get(project,eventId)).toEqual({bundle_id:stored.event.id,bundle_entry:0});
      expect(fs.readFileSync(path.join(destination,'blobs',project,stored.event.bodyKey),'utf8')).toBe(stored.event.bodyText);
      expect(fs.readFileSync(path.join(destination,'blobs',project,stored.tool!.bodyKey),'utf8')).toBe(stored.tool!.bodyText);
    } finally {recovered.close();}
  } finally {source.sqlite.close();fs.rmSync(scratch,{recursive:true,force:true});}
});
