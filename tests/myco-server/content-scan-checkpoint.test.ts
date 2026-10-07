import { describe,expect,it } from 'bun:test';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { cleanupCandidate,storageCleanup } from '@myco-server-worker/core/storage-cleanup.js';
import { eventArchiveStatements,eventContent,prepareArchiveStep,sourceBytes } from '@myco-server-worker/core/event-content.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { sqliteEnv,envelope,uuid } from './helpers/fixtures.js';

const NOW=Date.now();
const PROJECT='proj_1';

async function historical(bodyBytes:number) {
  const f=sqliteEnv();
  const id=uuid(999);
  const issued=await issueMemberToken(f.db,{memberId:'mem_machine_1',machineId:'machine_1'},NOW);
  const event=envelope({eventId:id,kind:'response',channel:'import',payload:{responseId:id,text:'small'}});
  expect((await ingestEvent(f.db,{projectId:PROJECT,machineId:'machine_1',tokenId:issued.tokenId,
    bodyBytes:0,now:NOW,writeOrigin:'server'},event)).persisted).toBe(true);
  const body=JSON.stringify({text:'é'.repeat(Math.ceil(bodyBytes/2))});
  f.sqlite.query('UPDATE events SET payload=?,payload_bytes=?,envelope_hash=? WHERE event_id=?')
    .run(body,new TextEncoder().encode(body).length,await sha256Hex(body),id);
  return {f,id,body};
}

describe('resumable content scan',()=>{
  it('streams historical bodies in byte pages no larger than one MiB',async()=>{
    const {f,id,body}=await historical(2_200_000);
    try {
      const row=await cleanupCandidate(f.db,{project_id:PROJECT,resource_kind:'event',resource_id:id});
      const stream=sourceBytes(f.db,'event',row!)().getReader();
      let bytes=0,pages=0;
      try {
        for(;;){
          const next=await stream.read();
          if(next.done)break;
          expect(next.value.byteLength).toBeLessThanOrEqual(1024*1024);
          bytes+=next.value.byteLength;pages++;
        }
      }finally{stream.releaseLock();}
      expect(bytes).toBe(new TextEncoder().encode(body).byteLength);
      expect(pages).toBeGreaterThan(2);
    }finally{f.sqlite.close();}
  });
  it('advances a 50 MiB native source through bounded cleanup wakes',async()=>{
    const {f,id,body}=await historical(50*1024*1024);
    try {
      let changed=0;
      for(let pass=0;pass<80;pass++) {
        const outcome=await storageCleanup(f.serverEnv,NOW);
        changed+=outcome.changed;
        if(changed===1) break;
      }
      expect(changed).toBe(1);
      expect(f.sqlite.query('SELECT payload_format FROM events WHERE event_id=?').get(id))
        .toEqual({payload_format:'archived'});
      expect(await eventContent(f.serverEnv,PROJECT,id)).toBe(body);
    } finally {f.sqlite.close();}
  });

  it('persists a 6 MiB hash and preview across new store adapters, then clears only after durable publication',async()=>{
    const {f,id,body}=await historical(6_000_000);
    try {
      const row=await cleanupCandidate(f.db,{project_id:PROJECT,resource_kind:'event',resource_id:id});
      expect(row).not.toBeNull();
      let db=sqliteRelationalStore(f.sqlite);
      let pending=0;
      for(;;) {
        const measured=measuredContentEnv({...f.serverEnv,db},{statements:120,blobCalls:60});
        const step=await prepareArchiveStep(measured.env,'event',row!,NOW);
        expect(measured.usage.statements).toBeLessThanOrEqual(120);
        expect(measured.usage.blobCalls).toBeLessThanOrEqual(60);
        if(step.status==='ready') {
          expect(body.startsWith(step.archive.preview)).toBe(true);
          expect(new TextEncoder().encode(step.archive.preview).byteLength).toBeLessThanOrEqual(2048);
          await db.batch(eventArchiveStatements(db,row!,step.archive));
          break;
        }
        pending++;
        expect(step.scanned).toBeLessThanOrEqual(1024*1024);
        expect(f.sqlite.query('SELECT payload_format FROM events WHERE event_id=?').get(id))
          .toEqual({payload_format:'inline'});
        db=sqliteRelationalStore(f.sqlite);
      }
      expect(pending).toBeGreaterThan(1);
      expect(await eventContent(f.serverEnv,PROJECT,id)).toBe(body);
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM content_scan_checkpoints').get()).toEqual({n:0});
    } finally {f.sqlite.close();}
  });

  it('restarts from byte zero when the source revision changes, and retries an interrupted final put',async()=>{
    const {f,id}=await historical(2_200_000);
    try {
      const first=await cleanupCandidate(f.db,{project_id:PROJECT,resource_kind:'event',resource_id:id});
      expect((await prepareArchiveStep(f.serverEnv,'event',first!,NOW)).status).toBe('pending');
      const changed=JSON.stringify({text:'λ'.repeat(1_300_000)});
      f.sqlite.query('UPDATE events SET payload=?,payload_bytes=?,envelope_hash=? WHERE event_id=?')
        .run(changed,new TextEncoder().encode(changed).length,await sha256Hex(changed),id);
      const row=await cleanupCandidate(f.db,{project_id:PROJECT,resource_kind:'event',resource_id:id});
      expect((await prepareArchiveStep(f.serverEnv,'event',row!,NOW)).status).toBe('pending');
      expect(f.sqlite.query('SELECT scanned_bytes,content_revision FROM content_scan_checkpoints').get())
        .toEqual({scanned_bytes:1024*1024,content_revision:row!.content_revision});
      for(let pass=0;pass<10;pass++) {
        const step=await prepareArchiveStep(f.serverEnv,'event',row!,NOW);
        if(step.status==='ready') throw new Error('finalization ran before interruption was installed');
        if((f.sqlite.query('SELECT scanned_bytes FROM content_scan_checkpoints').get() as {scanned_bytes:number}).scanned_bytes===row!.bytes) {
          f.bucket.failNextPut='interrupted';
          await expect(prepareArchiveStep(f.serverEnv,'event',row!,NOW)).rejects.toThrow('interrupted');
          const retry=await prepareArchiveStep(f.serverEnv,'event',row!,NOW);
          expect(retry.status).toBe('ready');
          if(retry.status==='ready') await f.db.batch(eventArchiveStatements(f.db,row!,retry.archive));
          expect(await eventContent(f.serverEnv,PROJECT,id)).toBe(changed);
          return;
        }
      }
      throw new Error('scan did not complete');
    } finally {f.sqlite.close();}
  });
});
