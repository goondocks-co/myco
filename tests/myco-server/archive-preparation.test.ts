import { describe, expect, it } from 'bun:test';
import { prepareArchive, eventArchiveStatements, eventContent } from '@myco-server-worker/core/event-content.js';
import { cleanupCandidate, storageCleanup, storageCleanupPending } from '@myco-server-worker/core/storage-cleanup.js';
import { ARCHIVE_PREPARATION_PAGE, ARCHIVE_PREPARATION_WALL_MS,
  discardArchiveBundle, reconcileArchivePreparations } from '@myco-server-worker/core/archive-bundle.js';
import { prepareDerivedContent } from '@myco-server-worker/core/registered-content.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { BLOB_RESERVATION_TTL_MS } from '@myco-server-worker/constants.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { sha256HexOf, utf8 } from '@myco-server-worker/hash.js';
import { envelope, sqliteEnv, uuid } from './helpers/fixtures.js';

const now=Date.now();
const projectId='proj_1';
const eventId=uuid(710);

async function source(rig:ReturnType<typeof sqliteEnv>) {
  const token=await issueMemberToken(rig.db,{memberId:'mem_machine_1',machineId:'machine_1'},now);
  const body=envelope({eventId,kind:'response',channel:'import',payload:{responseId:eventId,text:'original'.repeat(1400)}});
  expect((await ingestEvent(rig.db,{projectId,machineId:'machine_1',tokenId:token.tokenId,
    bodyBytes:0,now,writeOrigin:'server'},body)).persisted).toBe(true);
  const row=await cleanupCandidate(rig.db,{project_id:projectId,resource_kind:'event',resource_id:eventId});
  expect(row).not.toBeNull();
  return row!;
}

function agedAt(rig:ReturnType<typeof sqliteEnv>,preparationId:string):number {
  const row=rig.sqlite.query('SELECT expires_at FROM prepared_archive_bundles WHERE preparation_id=?')
    .get(preparationId) as {expires_at:number}|null;
  if(row===null)throw new Error('archive_preparation_missing');
  return row.expires_at+1;
}

async function settle(rig:ReturnType<typeof sqliteEnv>,clock=now) {
  for(let pass=0;pass<8;pass++)await drainObjectReleases(rig.serverEnv,clock);
}

async function finishCleanup(rig:ReturnType<typeof sqliteEnv>) {
  for(let pass=0;pass<16&&await storageCleanupPending(rig.db);pass++)await storageCleanup(rig.serverEnv,now);
  expect(await storageCleanupPending(rig.db)).toBe(false);
}

describe('archive preparation lifecycle',()=>{
  it('discards a deadline page, then archives changed bytes and physically releases the abandoned pair',async()=>{
    const rig=sqliteEnv();
    try {
      await source(rig);
      let puts=0;
      const env={...rig.serverEnv,blobs:{...rig.bucket,
        put:async(...args:Parameters<typeof rig.bucket.put>)=>{puts++;return rig.bucket.put(...args);}}};
      const result=await storageCleanup(env,now,{clock:()=>puts>=2?now+100:now,wallMs:10});
      expect(result.changed).toBe(0);
      expect(rig.sqlite.query('SELECT payload_format FROM events WHERE event_id=?').get(eventId)).toEqual({payload_format:'inline'});
      expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM prepared_archive_bundles').get()).toEqual({n:0});
      expect(rig.sqlite.query("SELECT COUNT(*) AS n FROM registered_content_proofs WHERE source_kind IN ('bundle','receipt')").get()).toEqual({n:0});
      const abandoned=[...rig.bucket.objects.keys()];
      expect(abandoned).toHaveLength(2);
      const changed=JSON.stringify({responseId:eventId,text:'changed'.repeat(2000)});
      rig.sqlite.query('UPDATE events SET payload=?,payload_bytes=? WHERE event_id=?')
        .run(changed,utf8(changed).byteLength,eventId);
      await finishCleanup(rig);
      expect(await eventContent(rig.serverEnv,projectId,eventId)).toBe(changed);
      await settle(rig);
      for(const key of abandoned)expect(rig.bucket.objects.has(key)).toBe(false);
    } finally {rig.sqlite.close();}
  });

  it('reconciles a crashed full preparation after a changed-page retry and retains the adopted exact read',async()=>{
    const rig=sqliteEnv();
    try {
      const row=await source(rig);
      const abandoned=await prepareArchive(rig.serverEnv,'event',row,now);
      const oldKeys=[abandoned.body,abandoned.receipt].map(content=>blobObjectKey(projectId,content.key,content.generation));
      const aged=agedAt(rig,abandoned.bundle.preparationId);
      const changed=JSON.stringify({responseId:eventId,text:'retry'.repeat(1000)});
      rig.sqlite.query('UPDATE events SET payload=?,payload_bytes=? WHERE event_id=?')
        .run(changed,utf8(changed).byteLength,eventId);
      await finishCleanup(rig);
      expect(await eventContent(rig.serverEnv,projectId,eventId)).toBe(changed);
      expect(await reconcileArchivePreparations(rig.db,aged,16)).toBe(1);
      await settle(rig,aged);
      for(const key of oldKeys)expect(rig.bucket.objects.has(key)).toBe(false);
      expect(await eventContent(rig.serverEnv,projectId,eventId)).toBe(changed);
      expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM prepared_archive_bundles').get()).toEqual({n:0});
    } finally {rig.sqlite.close();}
  });

  it('reconciles the body-only crash window and fences adoption after reclamation',async()=>{
    const rig=sqliteEnv();
    try {
      const row=await source(rig);
      const text='body before receipt';const digest=await sha256HexOf(utf8(text));
      const preparationId=crypto.randomUUID();
      rig.sqlite.query(`INSERT INTO prepared_archive_bundles(preparation_id,project_id,archive_key,expires_at)
        VALUES(?,?,?,?)`).run(preparationId,projectId,digest,now+BLOB_RESERVATION_TTL_MS);
      const body=await prepareDerivedContent(rig.serverEnv,{projectId,sessionId:row.session_id,eventId,
        tokenId:row.token_id,envelopeHash:row.envelope_hash,sourceKind:'bundle',resourceId:digest},text,now,
      {sql:'EXISTS (SELECT 1 FROM prepared_archive_bundles WHERE preparation_id=?)',params:[preparationId]});
      const physical=blobObjectKey(projectId,body.key,body.generation);
      expect(rig.bucket.objects.has(physical)).toBe(true);
      expect(await reconcileArchivePreparations(rig.db,now+BLOB_RESERVATION_TTL_MS+1,16)).toBe(1);
      await settle(rig,now+BLOB_RESERVATION_TTL_MS+1);
      expect(rig.bucket.objects.has(physical)).toBe(false);
      expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM registered_content_proofs WHERE key=?').get(digest)).toEqual({n:0});
      const archive=await prepareArchive(rig.serverEnv,'event',row,now);
      expect(await reconcileArchivePreparations(rig.db,agedAt(rig,archive.bundle.preparationId),16)).toBe(1);
      await expect(rig.db.batch(eventArchiveStatements(rig.db,row,archive))).rejects.toThrow();
      expect(rig.sqlite.query('SELECT payload_format FROM events WHERE event_id=?').get(eventId)).toEqual({payload_format:'inline'});
    } finally {rig.sqlite.close();}
  });

  it('keeps a shared generation and adopted bundle proofs while removing an unrelated abandoned receipt',async()=>{
    const rig=sqliteEnv();
    try {
      const row=await source(rig);
      const abandoned=await prepareArchive(rig.serverEnv,'event',row,now);
      rig.sqlite.query(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,
        event_id,envelope_hash,session_id,digest,size,verified_at,durable) VALUES(?,?,?,'event',?,?,?,?,?,?,?,1)`)
        .run(projectId,abandoned.body.key,abandoned.body.generation,'other-source',eventId,row.envelope_hash,
          row.session_id,abandoned.body.key,abandoned.body.size,now);
      const bodyPhysical=blobObjectKey(projectId,abandoned.body.key,abandoned.body.generation);
      const receiptPhysical=blobObjectKey(projectId,abandoned.receipt.key,abandoned.receipt.generation);
      const aged=agedAt(rig,abandoned.bundle.preparationId);
      expect(await reconcileArchivePreparations(rig.db,aged,16)).toBe(1);
      await settle(rig,aged);
      expect(rig.bucket.objects.has(bodyPhysical)).toBe(true);
      expect(rig.bucket.objects.has(receiptPhysical)).toBe(false);
      expect(rig.sqlite.query("SELECT COUNT(*) AS n FROM registered_content_proofs WHERE source_kind='event' AND source_id='other-source'").get()).toEqual({n:1});
      const adopted=await prepareArchive(rig.serverEnv,'event',row,now);
      await rig.db.batch(eventArchiveStatements(rig.db,row,adopted));
      expect(await reconcileArchivePreparations(rig.db,now+BLOB_RESERVATION_TTL_MS+1,16)).toBe(0);
      await settle(rig,now+BLOB_RESERVATION_TTL_MS+1);
      expect(await eventContent(rig.serverEnv,projectId,eventId)).toBe(JSON.stringify({responseId:eventId,text:'original'.repeat(1400)}));
      expect(rig.bucket.objects.has(blobObjectKey(projectId,adopted.receipt.key,adopted.receipt.generation))).toBe(true);
    } finally {rig.sqlite.close();}
  });

  it('lets a concurrent preparation adopt after the older attempt is discarded',async()=>{
    const rig=sqliteEnv();
    try {
      const row=await source(rig);
      const older=await prepareArchive(rig.serverEnv,'event',row,now);
      const newer=await prepareArchive(rig.serverEnv,'event',row,now);
      expect(newer.body.key).toBe(older.body.key);
      expect(newer.receipt.key).toBe(older.receipt.key);
      await discardArchiveBundle(rig.serverEnv,older.bundle,now);
      expect(rig.sqlite.query("SELECT COUNT(*) AS n FROM registered_content_proofs WHERE source_kind IN ('bundle','receipt')").get()).toEqual({n:2});
      await rig.db.batch(eventArchiveStatements(rig.db,row,newer));
      await settle(rig,now+BLOB_RESERVATION_TTL_MS+1);
      expect(await eventContent(rig.serverEnv,projectId,eventId)).toBe(JSON.stringify({responseId:eventId,text:'original'.repeat(1400)}));
    } finally {rig.sqlite.close();}
  });

  it('keeps adopted evidence when a sibling preparation ages out after adoption',async()=>{
    const rig=sqliteEnv();
    try {
      const row=await source(rig);
      const adopted=await prepareArchive(rig.serverEnv,'event',row,now);
      const sibling=await prepareArchive(rig.serverEnv,'event',row,now);
      await rig.db.batch(eventArchiveStatements(rig.db,row,adopted));
      expect(rig.sqlite.query('SELECT preparation_id FROM prepared_archive_bundles').get()).toEqual({preparation_id:sibling.bundle.preparationId});
      const aged=agedAt(rig,sibling.bundle.preparationId);
      expect(await reconcileArchivePreparations(rig.db,aged,16)).toBe(1);
      await settle(rig,aged);
      expect(await eventContent(rig.serverEnv,projectId,eventId)).toBe(JSON.stringify({responseId:eventId,text:'original'.repeat(1400)}));
      expect(rig.sqlite.query("SELECT COUNT(*) AS n FROM registered_content_proofs WHERE source_kind IN ('bundle','receipt')").get()).toEqual({n:2});
    } finally {rig.sqlite.close();}
  });

  it('seeks one expired preparation page and exact held keys through indexes in a large backlog',async()=>{
    const rig=sqliteEnv();
    try {
      rig.sqlite.query(`WITH RECURSIVE digits(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM digits WHERE n<999)
        INSERT INTO prepared_archive_bundles(preparation_id,project_id,archive_key,receipt_key,expires_at)
        SELECT printf('prep-%06d',a.n*1000+b.n),?,printf('body-%06d',a.n*1000+b.n),
          printf('receipt-%06d',a.n*1000+b.n),? FROM digits a CROSS JOIN digits b LIMIT 30000`)
        .run(projectId,now+2*BLOB_RESERVATION_TTL_MS);
      rig.sqlite.query(`UPDATE prepared_archive_bundles SET expires_at=? WHERE preparation_id<'prep-000016'`).run(now-1);
      const plan=(sql:string,...params:unknown[])=>JSON.stringify(rig.sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
      expect(plan(`SELECT preparation_id FROM prepared_archive_bundles WHERE expires_at<=?
        ORDER BY expires_at,preparation_id LIMIT ?`,now,16)).toContain('idx_prepared_archive_bundles_expiry');
      expect(plan(`SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM prepared_archive_bundles
        WHERE project_id=? AND archive_key=? AND preparation_id<>?)`,projectId,'body-000001','prep-000000'))
        .toContain('idx_prepared_archive_bundles_archive');
      expect(plan(`SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM prepared_archive_bundles
        WHERE project_id=? AND receipt_key=? AND preparation_id<>?)`,projectId,'receipt-000001','prep-000000'))
        .toContain('idx_prepared_archive_bundles_receipt');
      expect(await reconcileArchivePreparations(rig.db,now,16)).toBe(16);
      expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM prepared_archive_bundles').get()).toEqual({n:29984});
      expect(await reconcileArchivePreparations(rig.db,now,16)).toBe(0);
      rig.sqlite.query(`UPDATE prepared_archive_bundles SET expires_at=? WHERE preparation_id<'prep-001016'`).run(now-1);
      expect(await reconcileArchivePreparations(rig.db,now,undefined,()=>now)).toBe(ARCHIVE_PREPARATION_PAGE);
      expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM prepared_archive_bundles').get())
        .toEqual({n:29984-ARCHIVE_PREPARATION_PAGE});
      let clockReads=0;
      expect(await reconcileArchivePreparations(rig.db,now,undefined,
        ()=>now+clockReads++*ARCHIVE_PREPARATION_WALL_MS)).toBe(1);
    } finally {rig.sqlite.close();}
  });

  it('leaves a selected preparation intact when publication renews its reservation before release',async()=>{
    const rig=sqliteEnv();
    try {
      const row=await source(rig);
      const archive=await prepareArchive(rig.serverEnv,'event',row,now);
      const aged=agedAt(rig,archive.bundle.preparationId);
      let renewed=false;
      const db={...rig.db,batch:async(statements:Parameters<typeof rig.db.batch>[0])=>{
        if(!renewed){
          renewed=true;
          rig.sqlite.query('UPDATE prepared_archive_bundles SET expires_at=? WHERE preparation_id=?')
            .run(now+2*BLOB_RESERVATION_TTL_MS,archive.bundle.preparationId);
        }
        return rig.db.batch(statements);
      }};
      expect(await reconcileArchivePreparations(db,aged,16)).toBe(0);
      expect(renewed).toBe(true);
      expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM prepared_archive_bundles').get()).toEqual({n:1});
      expect(rig.sqlite.query("SELECT COUNT(*) AS n FROM registered_content_proofs WHERE source_kind IN ('bundle','receipt')").get()).toEqual({n:2});
      await rig.db.batch(eventArchiveStatements(rig.db,row,archive));
      expect(await eventContent(rig.serverEnv,projectId,eventId)).toBe(JSON.stringify({responseId:eventId,text:'original'.repeat(1400)}));
    } finally {rig.sqlite.close();}
  });

  it('does not recreate a proof when reused bytes finish read-back after their preparation expires',async()=>{
    const rig=sqliteEnv();
    try {
      const row=await source(rig);
      const first=await prepareArchive(rig.serverEnv,'event',row,now);
      rig.sqlite.query("DELETE FROM registered_content_proofs WHERE project_id=? AND source_kind='bundle' AND key=?")
        .run(projectId,first.body.key);
      let expired=false;
      const env={...rig.serverEnv,blobs:{...rig.bucket,get:async(...args:Parameters<typeof rig.bucket.get>)=>{
        const read=await rig.bucket.get(...args);
        if(!expired){
          expired=true;
          rig.sqlite.query(`UPDATE prepared_archive_bundles SET expires_at=0 WHERE preparation_id=
            (SELECT preparation_id FROM prepared_archive_bundles ORDER BY rowid DESC LIMIT 1)`).run();
        }
        return read;
      }}};
      await expect(prepareArchive(env,'event',row,now)).rejects.toThrow();
      expect(expired).toBe(true);
      expect(rig.sqlite.query("SELECT COUNT(*) AS n FROM registered_content_proofs WHERE project_id=? AND source_kind='bundle' AND key=?")
        .get(projectId,first.body.key)).toEqual({n:0});
      expect(rig.sqlite.query('SELECT COUNT(*) AS n FROM prepared_archive_bundles').get()).toEqual({n:1});
    } finally {rig.sqlite.close();}
  });
});
