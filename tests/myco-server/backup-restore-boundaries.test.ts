import { commit } from '@myco-server-worker/db/index.js';
import { expect, test } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { backupArtifact, createBackup, deploymentId } from '@myco-server-worker/core/backup.js';
import { restoreArtifact } from './helpers/restore-artifact.js';
import { restoreThroughJob } from './helpers/restore-through-job.js';
import { drainSessionDeletions, tombstoneSession } from './helpers/session-deletion.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { acquireRecoveryHold, releaseRecoveryHold } from '@myco-server-worker/db/recovery/holds.js';
import { captureDocumentSession, captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import { envelope, memoryBlobStore, uuid } from './helpers/fixtures.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { eventContent } from '@myco-server-worker/core/event-content.js';
import { EVENT_INLINE_PAYLOAD_BYTES } from '@myco-server-worker/ingest/event-payload.js';
import { latestRestore } from '@myco-server-worker/core/restore-job.js';
import { observing } from './helpers/store-faults.js';

async function artifact(db: RelationalStore, rows: { t: string; r: Record<string, unknown> }[]) {
  return [JSON.stringify({ format: 'myco-backup/1', deploymentId: await deploymentId(db), schemaVersion: 100, createdAt: 1, producer: 'test', counts: {} }),
    ...rows.map(row => JSON.stringify(row))].join('\n') + '\n';
}

async function saved(db: RelationalStore, blobs: ReturnType<typeof memoryBlobStore>) {
  const backup = await createBackup(db, blobs, { producer: 'test', now: Date.now() });
  return (await backupArtifact(db, blobs, backup.id))!.text;
}

const transcript = 'tx_' + 'a'.repeat(32);

test('a backup and restore keeps an event whose payload lives in the object store readable byte for byte', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore();
    const issued = await captureDocumentSession(db, 'project', 'session', { blobs, idOffset: 900 });
    const payload = { promptId: uuid(5001), text: 'y'.repeat(EVENT_INLINE_PAYLOAD_BYTES + 1), origin: 'user' };
    const landed = await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: Date.now() },
      envelope({ eventId: uuid(5002), sessionId: 'session', kind: 'prompt', payload }), { db, blobs });
    expect(landed, target).toEqual({ persisted: true, projected: true });
    const text = await saved(db, blobs);
    await db.batch([db.prepare(`DELETE FROM events WHERE event_id='${uuid(5002)}'`),
      db.prepare(`DELETE FROM registered_content_proofs WHERE source_kind='event' AND source_id='${uuid(5002)}'`)]);
    await restoreThroughJob(db, { text, blobs, authorization: { kind: 'recovery' } });
    expect(await eventContent({ db, blobs }, 'project', uuid(5002)), target).toBe(JSON.stringify(payload));
  });
});

test('restore cannot bring back the raw events or transcripts of an unpublished deleted session', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore();
    await captureDocumentSession(db, 'project', 'deleted', { blobs });
    await captureDocumentTranscript(db, blobs, 'deleted', transcript, '{"type":"session"}\n', Date.now());
    const text = await saved(db, blobs);
    await acquireRecoveryHold(db, 'retained', Date.now());
    await tombstoneSession({ db }, { projectId: 'project' }, 'deleted', 'member', Date.now());
    const held = async (table: string) => (await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id='project' AND session_id='deleted'`).first<{ n: number }>())!.n;
    const before = await held('events');
    await restoreThroughJob(db, { text, blobs, authorization: { kind: 'recovery' } });
    expect(await held('events'), target).toBe(before);
    await releaseRecoveryHold(db, 'retained', Date.now(), 'closed');
    await drainSessionDeletions({ db }, Date.now());
    for (const table of ['events','transcripts','session_documents','publish_queue']) expect(await held(table), target + table).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) n FROM transcript_segments').first(), target).toEqual({ n: 0 });
  });
});

test('a missing blob needed only by deleted content does not block unrelated additive rows', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore();
    await captureDocumentTranscript(db, blobs, 'deleted', transcript, 'retained bytes\n', Date.now());
    const text = await saved(db, blobs);
    await tombstoneSession({ db }, { projectId: 'project' }, 'deleted', 'member', Date.now());
    await db.prepare("DELETE FROM projects WHERE project_id='other'").run();
    await restoreThroughJob(db, { text, blobs, authorization: { kind: 'recovery' } });
    expect(await db.prepare("SELECT name FROM projects WHERE project_id='other'").first(), target).toEqual({ name: 'other' });
    expect(await db.prepare('SELECT COUNT(*) n FROM transcript_segments').first(), target).toEqual({ n: 0 });
  });
});

test('proof content equality admits a different verification time while preserving destination evidence', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore();
    await captureDocumentTranscript(db, blobs, 'session', transcript, 'proof bytes\n', Date.now());
    const bytes = await db.prepare('SELECT * FROM blobs LIMIT 1').first<Record<string, unknown>>();
    const row = { project_id: 'project', key: bytes!.key, generation: bytes!.generation, source_kind: 'transcript', source_id: 'proof',
      event_id: 'event', envelope_hash: 'envelope', session_id: 'session', digest: bytes!.key, size: bytes!.size, verified_at: 1, durable: 1 };
    const text = await artifact(db, [{ t: 'blobs', r: bytes! }, { t: 'registered_content_proofs', r: row }]);
    await restoreThroughJob(db, { text, blobs, authorization: { kind: 'recovery' } });
    await db.prepare("UPDATE registered_content_proofs SET verified_at=2 WHERE source_id='proof'").run();
    await restoreThroughJob(db, { text, blobs, authorization: { kind: 'recovery' } });
    expect(await db.prepare("SELECT verified_at FROM registered_content_proofs WHERE source_id='proof'").first(), target).toEqual({ verified_at: 2 });
    const conflict = await artifact(db, [{ t: 'blobs', r: bytes! }, { t: 'registered_content_proofs', r: { ...row, envelope_hash: 'different' } }]);
    await expect(restoreThroughJob(db, { text: conflict, blobs, authorization: { kind: 'recovery' } })).rejects.toThrow();
  });
});

test('a backup whose index write fails retains durable release ownership for the uploaded object', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore();
    const put = blobs.put.bind(blobs);
    let expire = false;
    blobs.put = async (...args) => {
      expect(await db.prepare('SELECT key FROM backup_publications WHERE key=?').bind(args[0]).first(), target).toEqual({ key: args[0] });
      const uploaded = await put(...args);
      const pending = await db.prepare('SELECT expires_at FROM backup_publications WHERE key=?').bind(args[0]).first<{ expires_at: number }>();
      await drainObjectReleases({ db, blobs }, expire ? pending!.expires_at : Date.now());
      expect(blobs.objects.has(args[0]), target).toBe(!expire);
      return uploaded;
    };
    await db.prepare("CREATE TRIGGER reject_backup BEFORE INSERT ON backups BEGIN SELECT RAISE(ABORT,'index unavailable'); END").run();
    await expect(createBackup(db, blobs, { producer: 'test', now: Date.now() })).rejects.toThrow('index unavailable');
    expect(blobs.objects.size, target).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) n FROM object_releases').first(), target).toEqual({ n: 1 });
    await drainObjectReleases({ db, blobs }, Date.now());
    expect(blobs.objects.size, target).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) n FROM backups').first(), target).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) n FROM backup_publications').first(), target).toEqual({ n: 0 });
    await db.prepare('DROP TRIGGER reject_backup').run();
    expire = true;
    await expect(createBackup(db, blobs, { producer: 'test', now: Date.now() })).rejects.toThrow();
    await drainObjectReleases({ db, blobs }, Date.now());
    expect(blobs.objects.size, target).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) n FROM backup_publications').first(), target).toEqual({ n: 0 });
  });
});

test('restoring a hot transcript range after archival keeps one selected range', async () => {
  const { archiveRawSources } = await import('@myco-server-worker/core/raw-archive.js');
  const { pageSegments } = await import('@myco-server-worker/read/transcript.js');
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), now = Date.now();
    const text = 'retained source bytes';
    const env = await captureDocumentTranscript(db, blobs, 'session', transcript, text, now);
    const snapshot = await saved(db, blobs);
    const hot = (await db.prepare('SELECT * FROM transcript_segments').first<Record<string,unknown>>())!;
    const originalEvent = (await db.prepare('SELECT * FROM events WHERE event_id=?').bind(hot.event_id).first<Record<string,unknown>>())!;
    await db.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,generation,session_id,published_offset,record_scheme,parser_version,state,updated_at)
      SELECT t.project_id,t.transcript_id,d.generation,t.session_id,?,'source-record-v1',1,'active',? FROM transcripts t
      JOIN session_documents d ON d.project_id=t.project_id AND d.session_id=t.session_id WHERE t.transcript_id=?`)
      .bind(text.length, now, transcript).run();
    for (let pass = 0; pass < 8; pass++) await archiveRawSources(env, now + 100 * 86_400_000, 90);
    expect(await db.prepare('SELECT COUNT(*) n FROM transcript_segments').first(), target).toEqual({ n: 0 });
    const { planKind } = await import('@myco-server-worker/ingest/projections.js');
    const { kindSpec } = await import('@myco-server-worker/ingest/kinds.js');
    const { envelope } = await import('./helpers/fixtures.js');
    const payload = JSON.parse(String(originalEvent.payload));
    const { parseEnvelope } = await import('@myco-server-worker/ingest/envelope.js');
    const parsed = parseEnvelope(envelope({eventId:String(hot.event_id),sessionId:'session',kind:'transcript.segment',payload}),now);
    if (!parsed.ok) throw new Error(parsed.reason);
    const plan = planKind(kindSpec('transcript.segment')!, { db, ctx: { projectId:'project', machineId:'machine', tokenId:String(hot.token_id), now,
      nonce:String(originalEvent.ingest_nonce), actor:null }, e:parsed.value, p:payload, contentHash:null });
    await db.batch(plan.projections);
    expect(await db.prepare('SELECT COUNT(*) n FROM transcript_segments').first(), target).toEqual({ n: 0 });
    const coldRows = (await Promise.all(['raw_archive_refs','blobs','registered_content_proofs'].map(async t =>
      (await db.prepare(`SELECT * FROM ${t}`).all<Record<string,unknown>>()).results.map(r => ({t,r}))))).flat();
    const cold = await artifact(db,coldRows);
    await restoreThroughJob(db, { text: snapshot, blobs, authorization: { kind: 'recovery' } });
    expect(await db.prepare('SELECT COUNT(*) n FROM transcript_segments').first(), target).toEqual({ n: 0 });
    const columns = Object.keys(hot);
    await db.prepare(`INSERT INTO transcript_segments(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(column=>hot[column])).run();
    await restoreThroughJob(db,{text:cold,blobs,authorization:{kind:'recovery'}});
    expect(await db.prepare('SELECT COUNT(*) n FROM transcript_segments').first(), target).toEqual({ n: 0 });
    expect((await pageSegments(db, { projectId: 'project' }, transcript)).rows.length, target).toBe(1);
  });
});

test('a refused restore preserves the prior document and frontier without leaving a conversion fence', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore();
    for (const prior of ['absent','convert']) {
      if (prior === 'convert') {
        await captureDocumentTranscript(db, blobs, 'session', transcript, 'prior bytes', Date.now());
        await db.prepare("UPDATE session_documents SET state='convert',generation=7 WHERE session_id='session'").run();
        await db.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,generation,session_id,published_offset,record_scheme,parser_version,state,updated_at)
          VALUES('project',?,7,'session',5,'source-record-v1',1,'active',1)`).bind(transcript).run();
      }
      const before = await db.prepare("SELECT * FROM session_documents WHERE session_id='session'").all();
      const frontier = await db.prepare('SELECT * FROM transcript_publication').all();
      const session = { t: 'sessions', r: { project_id: 'project', session_id: 'session', machine_id: 'machine', created_by_token_id: 'token', first_received_at: 1, last_received_at: 1 } };
      const invalid = await artifact(db, [session, { t: 'raw_resources', r: { project_id: 'project', kind: 'event', resource_id: 'invalid', reference_id: '', revision: 0.5 } }]);
      await expect(restoreThroughJob(db, { text: invalid, blobs, authorization: { kind: 'recovery' } })).rejects.toThrow('invalid raw provenance revision');
      const retired = await artifact(db, [session, { t: 'prompt_batches', r: { project_id: 'project', session_id: 'session', prompt_id: 'legacy', text: 'retained prompt', created_at: 1 } }]);
      await expect(restoreThroughJob(db, { text: retired, blobs, authorization: { kind: 'recovery' } })).rejects.toMatchObject({ code: 'artifact_format_retired' });
      expect((await db.prepare("SELECT * FROM session_documents WHERE session_id='session'").all()).results, target + prior).toEqual(before.results);
      expect((await db.prepare('SELECT * FROM transcript_publication').all()).results, target + prior).toEqual(frontier.results);
    }
  });
});

test('restore retains saved knowledge and anonymizes served snapshots when their source session is deleted', async () => {
  await withDocumentStores(async (db, target) => {
    const rows = [
      { t: 'sessions', r: { project_id: 'project', session_id: 'deleted', machine_id: 'machine', created_by_token_id: 'token', first_received_at: 1, last_received_at: 1 } },
      { t: 'sessions', r: { project_id: 'project', session_id: 'kept', machine_id: 'machine', created_by_token_id: 'token', first_received_at: 1, last_received_at: 1 } },
      { t: 'session_tombstones', r: { project_id: 'project', session_id: 'deleted', created_at: 1, created_by: 'member' } },
      { t: 'agents', r: { id: 'agent', name: 'agent', created_at: 1 } },
      { t: 'spores', r: { project_id: 'project', id: 'knowledge', agent_id: 'agent', session_id: 'deleted', prompt_id: 'prompt', observation_type: 'gotcha', content: 'retained knowledge', created_at: 1 } },
      { t: 'event_refs', r: { project_id: 'project', event_id: 'prompt-event', session_id: 'deleted', kind: 'prompt', record_id: 'prompt' } },
      { t: 'resolution_events', r: { project_id: 'project', id: 'resolution', agent_id: 'agent', spore_id: 'knowledge', action: 'superseded', session_id: 'kept', created_at: 2 } },
      { t: 'knowledge_git_provenance', r: { id: 1, project_id: 'project', identity_key: 'provenance', session_id: 'deleted', capture_point: 'turn', captured_at: 1, status_hash: 'hash', created_at: 1 } },
      { t: 'spore_injections', r: { project_id: 'project', session_id: 'kept', id: 'receipt', prompt_id: 'kept-prompt', prompt_hash: 'hash', spore_ids: '[]', created_at: 1 } },
      { t: 'injection_served_items', r: { project_id: 'project', receipt_id: 'receipt', kind: 'plan', item_id: 'plan', title: 'deleted title', session_id: 'deleted', content_hash: 'hash', unavailable: 0 } },
    ];
    await restoreThroughJob(db, { text: await artifact(db, rows), blobs: memoryBlobStore(), authorization: { kind: 'recovery' } });
    expect(await db.prepare("SELECT content,session_id,prompt_id FROM spores WHERE id='knowledge'").first(), target)
      .toEqual({ content: 'retained knowledge', session_id: 'deleted', prompt_id: null });
    expect(await db.prepare("SELECT spore_id FROM resolution_events WHERE id='resolution'").first(), target).toEqual({ spore_id: 'knowledge' });
    expect(await db.prepare("SELECT identity_key FROM knowledge_git_provenance").first(), target).toEqual({ identity_key: 'provenance' });
    expect(await db.prepare('SELECT receipt_id,title,session_id,content_hash,unavailable FROM injection_served_items').first(), target)
      .toEqual({ receipt_id: 'receipt', title: null, session_id: null, content_hash: null, unavailable: 1 });
  });
});

test('restore excludes served items through a deleted receiving receipt while retaining unrelated receipts', async () => {
  await withDocumentStores(async (db, target) => {
    const rows: { t:string; r:Record<string,unknown> }[] = ['deleted','kept'].flatMap(session => [
      { t: 'sessions', r: { project_id: 'project', session_id: session, machine_id: 'machine', created_by_token_id: 'token', first_received_at: 1, last_received_at: 1 } },
      { t: 'spore_injections', r: { project_id: 'project', session_id: session, id: session, prompt_id: session, prompt_hash: 'hash', spore_ids: '[]', created_at: 1 } },
      { t: 'injection_served_items', r: { project_id: 'project', receipt_id: session, kind: 'plan', item_id: session, title: 'retained title', session_id: 'source', content_hash: 'hash', unavailable: 0 } },
    ]);
    rows.push({ t: 'session_tombstones', r: { project_id: 'project', session_id: 'deleted', created_at: 1, created_by: 'member' } });
    await restoreThroughJob(db, { text: await artifact(db, rows), authorization: { kind: 'recovery' } });
    expect((await db.prepare('SELECT receipt_id,title FROM injection_served_items').all()).results, target).toEqual([{ receipt_id: 'kept', title: 'retained title' }]);
    expect((await db.prepare('SELECT id FROM spore_injections').all()).results, target).toEqual([{ id: 'kept' }]);
  });
});

test('a deletion landing once the restore is admitted keeps the session\'s raw rows out, and retry excludes the session', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore();
    await captureDocumentSession(db, 'project', 'session', { blobs });
    const text = await saved(db, blobs);
    let deleted = false;
    const observed = observing(db, async (_call, moment) => {
      if (deleted || moment !== 'after' || (await latestRestore({ db })) === null) return;
      deleted = true;
      await tombstoneSession({ db }, { projectId: 'project' }, 'session', 'member', Date.now());
    });
    await restoreThroughJob(observed.store, { text, blobs, authorization: { kind: 'recovery' } }).catch(() => undefined);
    expect(deleted, target).toBe(true);
    expect(await db.prepare("SELECT COUNT(*) n FROM events WHERE session_id='session'").first(), target).toEqual({ n: 0 });
    await restoreThroughJob(db, { text, blobs, authorization: { kind: 'recovery' } });
    expect(await db.prepare("SELECT COUNT(*) n FROM events WHERE session_id='session'").first(), target).toEqual({ n: 0 });
    expect(await db.prepare("SELECT COUNT(*) n FROM publish_queue WHERE session_id='session'").first(), target).toEqual({ n: 0 });
  });
});

test('restore guard reads per restored row stay the same as the artifact grows', async () => {
  const { observeRestoreStore } = await import('./helpers/restore-observer.js');
  const perRow: number[] = [];
  for (const sessionCount of [500, 2_000]) await withDocumentStores(async (db,target) => {
    if (target !== 'D1') return;
    const tagCount=sessionCount*2;
    const rows=[...Array.from({length:sessionCount},(_,i)=>({t:'sessions',r:{project_id:'project',session_id:`session-${i}`,machine_id:'machine',created_by_token_id:'token',first_received_at:1,last_received_at:1}})),
      ...Array.from({length:tagCount},(_,i)=>({t:'tags',r:{project_id:'project',entity_kind:'spore',entity_id:`spore-${i}`,tag:'tag'}}))];
    const text=await artifact(db,rows), observed=observeRestoreStore(db);
    await restoreArtifact(observed.db,{text,authorization:{kind:'recovery'}});
    expect(await db.prepare('SELECT COUNT(*) n FROM tags').first()).toEqual({n:tagCount});
    perRow.push(observed.reads()/rows.length);
    console.log(JSON.stringify({kind:'restore_guard_cost',sessions:sessionCount,tags:tagCount,reads:observed.reads()}));
  });
  if (perRow.length === 2) expect(perRow[1]!).toBeLessThanOrEqual(perRow[0]!);
});

test('archive selection clears only its named range at the same store cost as the transcript grows', async () => {
  const { clearArchivedTranscriptRanges } = await import('@myco-server-worker/db/documents/ranges.js');
  const { observeRestoreStore } = await import('./helpers/restore-observer.js');
  await withDocumentStores(async (db,target)=>{
    const blobs=memoryBlobStore();
    await captureDocumentTranscript(db,blobs,'session',transcript,'x',Date.now());
    const row=(await db.prepare('SELECT * FROM transcript_segments').first<Record<string,unknown>>())!;
    const reads:number[]=[];
    let segments=1;
    for(const [scale,segmentCount] of [500,2_000].entries()){
      await db.prepare(`INSERT INTO transcript_segments(project_id,transcript_id,base_offset,length,blob_key,event_id,created_at,received_at,token_id)
        SELECT 'project',?,value,1,?,?,1,1,? FROM json_each(?)`).bind(transcript,row.blob_key,row.event_id,row.token_id,
        JSON.stringify(Array.from({length:segmentCount-segments},(_,i)=>segments+i))).run();
      segments=segmentCount;
      // Each size clears its own archived range: offsets 0 and 1, then 2 and 3.
      const from=scale*2;
      for(const offset of [from,from+1])await db.prepare(`INSERT INTO raw_archive_refs(project_id,source_kind,source_id,session_id,size,received_at,transcript_id,base_offset,length,token_id,eligible_at,disposition)
        VALUES('project','transcript',?,'session',1,1,?,?,1,?,1,'archived') ON CONFLICT(project_id,source_kind,source_id) DO UPDATE SET disposition='archived'`).bind(`${transcript}:${offset}`,transcript,offset,row.token_id).run();
      const observed=observeRestoreStore(db);
      await commit(observed.db,clearArchivedTranscriptRanges('project',transcript,from));
      expect(await db.prepare('SELECT COUNT(*) n FROM transcript_segments').first(),target).toEqual({n:segmentCount-scale-1});
      expect(await db.prepare('SELECT base_offset FROM transcript_segments WHERE base_offset=?').bind(from+1).first(),target).toEqual({base_offset:from+1});
      reads.push(observed.reads());
    }
    expect(reads[1]!,target).toBeLessThanOrEqual(reads[0]!);
  });
});

test('release drain reads do not multiply by retained backup count', async()=>{
  const { observeRestoreStore }=await import('./helpers/restore-observer.js');
  await withDocumentStores(async(db,target)=>{
    if(target!=='D1')return;
    const releases=2_000;
    await db.prepare(`INSERT INTO object_releases(physical,kind,created_at) SELECT 'object-'||value,'blob',1 FROM json_each(?)`)
      .bind(JSON.stringify(Array.from({length:releases},(_,i)=>i))).run();
    const reads:number[]=[];
    for(const backups of [3,30]){
      await db.prepare(`INSERT OR IGNORE INTO backups(id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned)
        SELECT 'backup-'||value,'backups/'||value,1,1,'{}',1,'test',0 FROM json_each(?)`).bind(JSON.stringify(Array.from({length:backups},(_,i)=>i))).run();
      const observed=observeRestoreStore(db);
      const drained=await drainObjectReleases({db:observed.db,blobs:memoryBlobStore()},Date.now());
      expect(drained.deleted).toBeGreaterThan(0);
      expect(await db.prepare('SELECT COUNT(*) n FROM backups').first()).toEqual({n:backups});
      reads.push(observed.reads());
      console.log(JSON.stringify({kind:'release_drain_cost',backups,releases,reads:observed.reads()}));
    }
    expect(reads[1]!).toBeLessThanOrEqual(reads[0]!);
  });
});
