import { memberWriteStore, MemberWriteRefused } from '@myco-server-worker/auth/member-write-store.js';
import { OBJECT_PUT_IN_FLIGHT_MS } from '@myco-server-worker/constants.js';
import { Database } from 'bun:sqlite';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { backupArtifact, createBackup, pruneBackups, setBackupPinned } from '@myco-server-worker/core/backup.js';
import { drainObjectReleases, consumeUploadAuthority, releaseBackups, DRAIN_PAGE } from '@myco-server-worker/core/object-release.js';
import { reconcileObjectIntents } from '@myco-server-worker/db/storage/object-lifecycle.js';
import { retentionDecision } from '@myco-server-worker/core/backup-retention.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { sha256HexOf, utf8 } from '@myco-server-worker/hash.js';
import { d1StoreMaintenance, D1_QUERY_LIMIT_MS } from '@myco-server-worker/platform/cloudflare/store-maintenance.js';
import { latestOutcome, runMaintenance, type StoreMaintenancePort } from '@myco-server-worker/core/store-maintenance.js';
import { asOwner, asOwnerPost, OWNER_ENV } from './helpers/owner.js';
import { blobPost, count, journaled, registeredObject, sqliteEnv } from './helpers/fixtures.js';

function keepOne(e: ReturnType<typeof sqliteEnv>) {
  e.sqlite.run(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by)
    VALUES('backup.retention.keep_daily','1',0,'test'),('backup.retention.keep_weekly','0',0,'test')`);
}

it('B6: a failed prune is a typed failure in the create response and the persistent Health backup read', async () => {
  const e = sqliteEnv();
  try {
    const backup = await createBackup(e.db,e.bucket,{producer:'test',now:Date.now()});
    let unavailable=true;
    const fault: RelationalStore = {...e.db,batch:async statements=>{
      if (unavailable) { unavailable=false; throw new Error('store unavailable'); }
      return e.db.batch(statements);
    }};
    const outcome=await pruneBackups(fault,Date.now());
    expect(outcome).toEqual({state:'failed',errorClass:'unknown'});
    expect(outcome).not.toHaveProperty('pruned');
    expect(e.bucket.objects.has(backup.key)).toBe(true);
    const health = await worker.fetch(await asOwner(e.db,'/api/backups'),{...e.env,...OWNER_ENV});
    expect(await health.json()).toMatchObject({retention:{outcome:{state:'failed',errorClass:'unknown'}}});
    const retried=await worker.fetch(await asOwnerPost(e.db,'/api/backups',{}),{...e.env,...OWNER_ENV});
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({retention:{state:'pruned',pruned:0}});
    expect(e.bucket.objects.has(backup.key)).toBe(true);
  } finally { e.sqlite.close(); }
});

it('a published backup stays successful when its retention outcome cannot be recorded',async()=>{
  const e=sqliteEnv();
  try {
    keepOne(e);
    const old=await createBackup(e.db,e.bucket,{producer:'test',now:1});
    const db=e.env.MYCO_DB;
    let outage=false;
    e.env.MYCO_DB={...db,batch:async (statements:Parameters<RelationalStore['batch']>[0])=>{
      const rows=e.sqlite.query('SELECT id FROM backups').all() as {id:string}[];
      if(rows.length===1 && rows[0]!.id!==old.id && !outage) {outage=true;throw new Error('store unavailable');}
      return db.batch(statements);
    }};
    const answer=await worker.fetch(await asOwnerPost(e.db,'/api/backups',{}),{...e.env,...OWNER_ENV});
    expect(answer.status).toBe(200);
    const created=await answer.json() as {backup:{key:string};retention:unknown};
    expect(created.retention).toEqual({state:'pruned',pruned:1,deferred:0,recordingErrorClass:'unknown'});
    expect(e.bucket.objects.has(created.backup.key)).toBe(true);
  } finally {e.sqlite.close();}
});

it('a store outage bounds a drain and keeps the remaining journal for later wakes',async()=>{
  for(const classified of [false,true]) {
  const e=sqliteEnv();
  try {
    for(let i=0;i<DRAIN_PAGE;i++) {
      const key=`outage-${i}`;
      e.sqlite.run("INSERT INTO object_releases(physical,kind,created_at) VALUES(?,'blob',1)",[key]);
      e.bucket.seed(key,{size:1});
    }
    const healthy=e.bucket.delete.bind(e.bucket);
    e.bucket.delete=async()=>{throw new Error('unavailable');};
    const now=Date.now();
    const drainEnv=classified ? {...e.serverEnv,platform:{...e.serverEnv.platform!,classifyError:()=>'rpc' as const}} : e.serverEnv;
    const failures=classified?1:2;
    expect(await drainObjectReleases(drainEnv,now)).toMatchObject({deleted:0,unacknowledged:failures});
    expect(e.sqlite.query('SELECT COUNT(*) n FROM object_releases WHERE retry_at>0').get()).toEqual({n:failures});
    expect(e.bucket.objects.size).toBe(DRAIN_PAGE);
    e.bucket.delete=healthy;
    await drainObjectReleases(e.serverEnv,now);
    expect(e.bucket.objects.size).toBe(failures);
    const due=(e.sqlite.query('SELECT MAX(retry_at) at FROM object_releases').get() as {at:number}).at;
    await drainObjectReleases(e.serverEnv,due);
    expect(journaled(e.sqlite)).toEqual([]);
    expect(e.bucket.objects.size).toBe(0);
  } finally {e.sqlite.close();}
  }
});

it('B8: a poison first delete has its own retry deadline and cannot starve keys past the first page', async () => {
  const e = sqliteEnv();
  try {
    const keys = Array.from({length:DRAIN_PAGE+2},(_,i)=>`object-${String(i).padStart(3,'0')}`);
    for (const key of keys) {
      e.sqlite.run("INSERT INTO object_releases(physical,kind,created_at) VALUES(?,'blob',1)",[key]);
      e.bucket.seed(key,{size:1});
    }
    const real = e.bucket.delete.bind(e.bucket);
    e.bucket.delete=async key=>{ if(key===keys[0]) throw new Error('store unavailable'); await real(key); };
    const now=Date.now();
    expect(await drainObjectReleases(e.serverEnv,now)).toMatchObject({deleted:DRAIN_PAGE-1,unacknowledged:1});
    expect(await drainObjectReleases(e.serverEnv,now)).toMatchObject({deleted:2,unacknowledged:0});
    expect(journaled(e.sqlite)).toEqual([keys[0]!]);
    const pending=e.sqlite.query('SELECT retry_at FROM object_releases WHERE physical=?').get(keys[0]!) as {retry_at:number};
    expect(pending.retry_at).toBeGreaterThan(now);
    e.bucket.delete=real;
    await drainObjectReleases(e.serverEnv,pending.retry_at-1);
    expect(e.bucket.objects.has(keys[0]!)).toBe(true);
    await drainObjectReleases(e.serverEnv,pending.retry_at);
    expect(journaled(e.sqlite)).toEqual([]);
    expect(e.bucket.objects.size).toBe(0);

    e.sqlite.run("INSERT INTO object_releases(physical,kind,created_at) VALUES('overlap','blob',1)");
    e.bucket.seed('overlap',{size:1});
    e.bucket.delete=async key=>{
      await real(key);
      e.sqlite.query('DELETE FROM object_releases WHERE physical=?').run(key);
    };
    const alreadyAcknowledged=await drainObjectReleases(e.serverEnv,pending.retry_at);
    expect(alreadyAcknowledged.deleted).toBe(0);
    expect(journaled(e.sqlite)).toEqual([]);
    expect(e.bucket.objects.size).toBe(0);
  } finally { e.sqlite.close(); }
});

it('B9: policy revision, pin and keep-set races abort the whole backup release batch', async () => {
  for (const race of ['revision','pin','keep-set'] as const) {
    const e = sqliteEnv();
    try {
      keepOne(e);
      const old = await createBackup(e.db,e.bucket,{producer:'test',now:1});
      const fresh = await createBackup(e.db,e.bucket,{producer:'test',now:2});
      const decision=await retentionDecision(e.db);
      if (race==='revision') {
        e.sqlite.run("UPDATE deployment_settings SET value='2' WHERE leaf='backup.retention.keep_daily'");
        e.sqlite.run("UPDATE deployment_settings SET value='1' WHERE leaf='backup.retention.keep_daily'");
      } else if (race==='pin') await setBackupPinned(e.db,old.id,true);
      else await setBackupPinned(e.db,fresh.id,true);
      let conflict: unknown;
      try { await releaseBackups(e.db,[...decision.victims],decision.victims,3,decision.observed); }
      catch(error) { conflict=error; }
      expect(conflict).toBeInstanceOf(Error);
      let first=true;
      const fault={...e.db,batch:async (statements:Parameters<RelationalStore['batch']>[0])=>{
        if(first){first=false;throw conflict;}return e.db.batch(statements);
      }};
      expect(await pruneBackups(fault,3)).toEqual({state:'changed',reason:'retention_changed'});
      expect(count(e.sqlite,'backups')).toBe(2);
      expect(journaled(e.sqlite)).toEqual([]);
      expect(e.bucket.objects.has(old.key)).toBe(true);
      expect(e.bucket.objects.has(fresh.key)).toBe(true);
      expect(count(e.sqlite,'backup_release_candidates')).toBe(0);
      const current=await pruneBackups(e.db,4);
      expect(current).toMatchObject({state:'pruned',pruned:race==='revision'?1:0});
      expect(count(e.sqlite,'backups')).toBe(race==='revision'?1:2);
      expect(e.bucket.objects.has(fresh.key)).toBe(true);
    } finally { e.sqlite.close(); }
  }
});

it('B10: reconciliation revisits an uncertain PUT after authority and journal drains, preserving a later registered generation', async () => {
  const revival = sqliteEnv();
  try {
    const bytes=utf8('reservation renewal');
    const real=revival.bucket.put.bind(revival.bucket);
    const token=await issueMemberToken(revival.db,{memberId:'mem_machine_1',machineId:'machine_1'},Date.now());
    revival.bucket.put=async (...args)=>{
      const object=await real(...args);
      revival.sqlite.run('UPDATE blob_reservations SET expires_at=0');
      revival.sqlite.run('UPDATE object_settlement_intents SET expires_at=?',[Date.now()-OBJECT_PUT_IN_FLIGHT_MS-1]);
      await reconcileObjectIntents(revival.db,Date.now(),DRAIN_PAGE);
      revival.sqlite.run('UPDATE blob_reservations SET expires_at=?',[Date.now()+60_000]);
      await drainObjectReleases(revival.serverEnv,Date.now());
      return object;
    };
    const answer=await worker.fetch(blobPost(token.token,await sha256HexOf(bytes),bytes),revival.env);
    expect(await answer.json()).toMatchObject({stored:true});
    expect(revival.bucket.objects.size).toBe(1);
    expect(journaled(revival.sqlite)).toEqual([]);
  } finally { revival.sqlite.close(); }
  for (const kind of ['upload','backup','consumed authority'] as const) {
    const e = sqliteEnv();
    try {
      const body=utf8('late bytes');
      const real=e.bucket.put.bind(e.bucket);
      let land: (()=>Promise<unknown>) | undefined;
      let physical='';
      e.bucket.put=async(key,value,options)=>{
        physical=key;
        const bytes=await new Response(value).arrayBuffer();
        land=()=>real(key,new Response(bytes).body,options);
        throw new Error('PUT answer lost');
      };
      const token=await issueMemberToken(e.db,{memberId:'mem_machine_1',machineId:'machine_1'},Date.now());
      const key=await sha256HexOf(body);
      if (kind==='upload') await worker.fetch(blobPost(token.token,key,body),e.env);
      else if(kind==='backup') await expect(createBackup(e.db,e.bucket,{producer:'test',now:Date.now()})).rejects.toThrow('PUT answer lost');
      else {
        const reservation=crypto.randomUUID();
        e.sqlite.query(`INSERT INTO blob_reservations(reservation_id,project_id,key,token_id,size,expires_at)
          VALUES(?,'proj_1',?,?,?,?)`).run(reservation,key,token.tokenId,body.byteLength,Date.now()+60_000);
        await expect(e.bucket.put(blobObjectKey('proj_1',key,reservation),new Response(body).body,{sha256:key})).rejects.toThrow('PUT answer lost');
        await e.db.batch(consumeUploadAuthority(e.db,reservation,Date.now()));
      }
      const now=Date.now()+1;
      const expiry=(e.sqlite.query('SELECT expires_at FROM object_settlement_intents WHERE physical=?').get(physical) as {expires_at:number}).expires_at;
      await drainObjectReleases(e.serverEnv,now);
      expect(journaled(e.sqlite)).toEqual([]);
      expect(count(e.sqlite,'object_settlement_intents')).toBe(1);
      await land!();
      expect(e.bucket.objects.has(physical)).toBe(true);
      e.bucket.put=real;
      if (kind!=='backup') {
        const retry=await worker.fetch(blobPost(token.token,key,body),e.env);
        expect(await retry.json()).toMatchObject({stored:true,duplicate:false});
      }
      for(let pass=1;pass<=20;pass++) await drainObjectReleases(e.serverEnv,now+pass,()=>now+pass);
      expect(e.bucket.objects.has(physical)).toBe(true);
      expect(e.bucket.deletes.filter(key=>key===physical)).toHaveLength(1);
      const terminal=expiry+OBJECT_PUT_IN_FLIGHT_MS+1;
      for(let pass=0;pass<40;pass++) await drainObjectReleases(e.serverEnv,terminal+pass,()=>terminal+pass);
      expect(count(e.sqlite,'object_settlement_intents')).toBe(0);
      expect(e.bucket.deletes.filter(key=>key===physical)).toHaveLength(2);
      expect(e.bucket.objects.has(physical)).toBe(false);
      expect(e.bucket.objects.size).toBe(kind!=='backup'?1:0);
      expect(count(e.sqlite,'blobs')).toBe(kind!=='backup'?1:0);
      if(kind!=='backup') {
        const owned=registeredObject(e.sqlite,'proj_1',key)!;
        expect(e.bucket.objects.has(owned)).toBe(true);
        e.sqlite.run(`INSERT INTO object_settlement_intents(physical,kind,project_id,key,generation,expires_at)
          SELECT ?,'upload',project_id,key,generation,? FROM blobs WHERE project_id='proj_1' AND key=?`,[owned,terminal+60_000,key]);
        await drainObjectReleases(e.serverEnv,terminal+41,()=>terminal+41);
        expect(count(e.sqlite,'object_settlement_intents')).toBe(0);
        expect(e.bucket.objects.has(owned)).toBe(true);
      }
    } finally { e.sqlite.close(); }
  }
});

it('B28: hosted integrity reports the tables it checked and keeps a competing run refused during slow work', async () => {
  const e=sqliteEnv();
  const sqlite=new Database(':memory:');
  try {
    const tables=40;
    sqlite.run('CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    for(let n=0;n<tables;n++) sqlite.run(`CREATE TABLE sample_${n}(id INTEGER PRIMARY KEY CHECK(id>0))`);
    sqlite.exec('PRAGMA ignore_check_constraints=ON');
    sqlite.run('INSERT INTO sample_0(id) VALUES(-1)');
    sqlite.exec('PRAGMA ignore_check_constraints=OFF');
    const db=sqliteRelationalStore(sqlite);
    const actual=d1StoreMaintenance(db);
    let now=1_000;
    let lastCompleted=0;
    let competed=false;
    const port: StoreMaintenancePort={...actual,run:async(check,report)=>{
      if(report===undefined) throw new Error('progress recorder missing');
      return actual.run(check,async progress=>{
        now+=(progress.completedTables-lastCompleted)*D1_QUERY_LIMIT_MS;
        lastCompleted=progress.completedTables;
        await report(progress);
        if(progress.completedTables>0 && !competed) {
          competed=true;
          expect(await latestOutcome({...e.serverEnv,db},'integrity')).toMatchObject({
            state:'running',progress:{totalTables:tables+1,completedTables:progress.completedTables},
          });
          expect(await runMaintenance({...e.serverEnv,db,storeMaintenance:port},'integrity','owner',now,{clock:()=>now}))
            .toMatchObject({outcome:'refused',refusal:'already_running'});
        }
      });
    }};
    const result=await runMaintenance({...e.serverEnv,db,storeMaintenance:port},'integrity','owner',now,{clock:()=>now});
    expect(result).toMatchObject({outcome:'ran',record:{state:'findings',progress:{completedTables:tables+1,totalTables:tables+1}}});
    if(result.outcome!=='ran') throw new Error('integrity check did not finish');
    expect(result.record.findings).toEqual(expect.arrayContaining([expect.stringContaining('sample_0')]));
    expect(competed).toBe(true);
  } finally {sqlite.close();e.sqlite.close();}
});

it('keeps an admitted backup readable if authority is revoked after publication',async()=>{
  const e=sqliteEnv();
  try {
    e.sqlite.run("UPDATE members SET role='admin' WHERE id='mem_machine_1'");
    let revoked=false;
    const transport:RelationalStore={...e.db,batch:async statements=>{
      const result=await e.db.batch(statements);
      if(!revoked && count(e.sqlite,'backups')===1) {
        revoked=true;
        e.sqlite.run("UPDATE members SET revoked_at=1 WHERE id='mem_machine_1'");
      }
      return result;
    }};
    const guarded=memberWriteStore(transport,'mem_machine_1','admin');
    await createBackup(guarded,e.bucket,{producer:'mem_machine_1',now:Date.now()}).catch(error=>{
      if(!(error instanceof MemberWriteRefused)) throw error;
    });
    const row=e.sqlite.query('SELECT id,key FROM backups').get() as {id:string;key:string};
    expect(row).not.toBeNull();
    expect(e.sqlite.query("SELECT revoked_at FROM members WHERE id='mem_machine_1'").get()).toEqual({revoked_at:1});
    expect(e.bucket.objects.has(row.key)).toBe(true);
    expect(await backupArtifact(e.db,e.bucket,row.id)).toMatchObject({row:{id:row.id,key:row.key},text:expect.any(String)});
  } finally {e.sqlite.close();}
});
