import { expect, test } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { backupArtifact, createBackup, deploymentId, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { acquireRecoveryHold, drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { captureDocumentSession, captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';

async function artifact(db: RelationalStore, rows: { t: string; r: Record<string, unknown> }[]) {
  return [JSON.stringify({ format: 'myco-backup/1', deploymentId: await deploymentId(db), schemaVersion: 100, createdAt: 1, producer: 'test', counts: {} }),
    ...rows.map(row => JSON.stringify(row))].join('\n') + '\n';
}

async function saved(db: RelationalStore, blobs: ReturnType<typeof memoryBlobStore>) {
  const backup = await createBackup(db, blobs, { producer: 'test', now: Date.now() });
  return (await backupArtifact(db, blobs, backup.id))!.text;
}

const transcript = 'tx_' + 'a'.repeat(32);

test('restore cannot bring back the raw events or transcripts of an unpublished deleted session', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore();
    await captureDocumentSession(db, 'project', 'deleted', { blobs });
    await captureDocumentTranscript(db, blobs, 'deleted', transcript, '{"type":"session"}\n', Date.now());
    const text = await saved(db, blobs);
    await acquireRecoveryHold(db, 'retained', Date.now());
    await tombstoneSession({ db }, { projectId: 'project' }, 'deleted', 'member', Date.now());
    await restoreArtifact(db, { text, blobs, authorization: { kind: 'recovery' } });
    for (const table of ['events','transcripts','session_documents','publish_queue']) {
      expect(await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id='project' AND session_id='deleted'`).first(), target + table).toEqual({ n: 0 });
    }
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
    await restoreArtifact(db, { text, blobs, authorization: { kind: 'recovery' } });
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
    await restoreArtifact(db, { text, blobs, authorization: { kind: 'recovery' } });
    await db.prepare("UPDATE registered_content_proofs SET verified_at=2 WHERE source_id='proof'").run();
    await restoreArtifact(db, { text, blobs, authorization: { kind: 'recovery' } });
    expect(await db.prepare("SELECT verified_at FROM registered_content_proofs WHERE source_id='proof'").first(), target).toEqual({ verified_at: 2 });
    const conflict = await artifact(db, [{ t: 'blobs', r: bytes! }, { t: 'registered_content_proofs', r: { ...row, envelope_hash: 'different' } }]);
    await expect(restoreArtifact(db, { text: conflict, blobs, authorization: { kind: 'recovery' } })).rejects.toThrow();
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
  const { listSegments } = await import('@myco-server-worker/read/transcript.js');
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
    await restoreArtifact(db, { text: snapshot, blobs, authorization: { kind: 'recovery' } });
    expect(await db.prepare('SELECT COUNT(*) n FROM transcript_segments').first(), target).toEqual({ n: 0 });
    const columns = Object.keys(hot);
    await db.prepare(`INSERT INTO transcript_segments(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(column=>hot[column])).run();
    await restoreArtifact(db,{text:cold,blobs,authorization:{kind:'recovery'}});
    expect(await db.prepare('SELECT COUNT(*) n FROM transcript_segments').first(), target).toEqual({ n: 0 });
    expect((await listSegments(db, { projectId: 'project' }, transcript)).length, target).toBe(1);
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
      const text = await artifact(db, [
        { t: 'sessions', r: { project_id: 'project', session_id: 'session', machine_id: 'machine', created_by_token_id: 'token', first_received_at: 1, last_received_at: 1 } },
        { t: 'prompt_batches', r: { project_id: 'project', session_id: 'session', prompt_id: 'legacy', text: 'retained prompt', created_at: 1 } },
        { t: 'raw_resources', r: { project_id: 'project', kind: 'event', resource_id: 'invalid', reference_id: '', revision: 0.5 } },
      ]);
      await expect(restoreArtifact(db, { text, blobs, authorization: { kind: 'recovery' } })).rejects.toThrow('invalid raw provenance revision');
      expect((await db.prepare("SELECT * FROM session_documents WHERE session_id='session'").all()).results, target + prior).toEqual(before.results);
      expect((await db.prepare('SELECT * FROM transcript_publication').all()).results, target + prior).toEqual(frontier.results);
      const admitted = await artifact(db, [
        { t: 'sessions', r: { project_id: 'project', session_id: 'session', machine_id: 'machine', created_by_token_id: 'token', first_received_at: 1, last_received_at: 1 } },
        { t: 'prompt_batches', r: { project_id: 'project', session_id: 'session', prompt_id: 'legacy', text: 'retained prompt', created_at: 1 } },
      ]);
      if (prior === 'convert') {
        await db.prepare("CREATE TRIGGER refuse_document BEFORE UPDATE OF state ON session_documents WHEN NEW.state='live' BEGIN SELECT RAISE(ABORT,'document refused'); END").run();
        await expect(restoreArtifact(db, { text: admitted, blobs, authorization: { kind: 'recovery' } })).rejects.toThrow('document refused');
        expect((await db.prepare("SELECT * FROM session_documents WHERE session_id='session'").all()).results, target).toEqual(before.results);
        expect((await db.prepare('SELECT * FROM transcript_publication').all()).results, target).toEqual(frontier.results);
        await db.prepare('DROP TRIGGER refuse_document').run();
      }
      await restoreArtifact(db, { text: admitted, blobs, authorization: { kind: 'recovery' } });
      expect(await db.prepare("SELECT state,restore_hold,prompts FROM session_documents WHERE session_id='session'").first(), target)
        .toEqual({ state: 'live', restore_hold: null, prompts: 1 });
    }
  });
});

test('legacy tool-only bundle bytes remain held until document conversion consumes them', async () => {
  const { sha256Hex } = await import('@myco-server-worker/hash.js');
  const { blobObjectKey } = await import('@myco-server-worker/core/blob-objects.js');
  const { readPage } = await import('@myco-server-worker/content/document-reader.js');
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), generation = crypto.randomUUID();
    const input = 'complete retained input '.repeat(200);
    const tool = '00000000-0000-4000-8000-000000000123';
    const entry = { kind: 'tool-input', resourceId: tool, eventId: 'event', envelopeHash: 'envelope', revision: 0, rawRevision: 0,
      offset: 0, length: Buffer.byteLength(input), digest: await sha256Hex(input) };
    const header = { version: 1, projectId: 'project', sessionId: 'session', tokenId: 'token', entries: [entry] };
    const footer = JSON.stringify(header);
    const bodyText = input + footer + '\n' + Buffer.byteLength(footer).toString(16).padStart(8, '0');
    const bodyKey = await sha256Hex(bodyText);
    const receiptText = JSON.stringify({ version: 1, header, body: { key: bodyKey, generation, size: Buffer.byteLength(bodyText), digest: bodyKey } });
    const receiptKey = await sha256Hex(receiptText);
    const rows: { t: string; r: Record<string, unknown> }[] = [
      { t: 'sessions', r: { project_id: 'project', session_id: 'session', machine_id: 'machine', created_by_token_id: 'token', first_received_at: 1, last_received_at: 1 } },
      { t: 'events', r: { project_id: 'project', event_id: 'event', session_id: 'session', token_id: 'token', kind: 'tool.use', channel: 'import', payload: JSON.stringify({ toolCallId: tool, toolName: 'shell', input: 'preview' }), envelope_hash: 'envelope', created_at: 1, received_at: 1, payload_bytes: 1 } },
      { t: 'archive_bundles', r: { id: 1, project_id: 'project', session_id: 'session', token_id: 'token', event_id: 'event', envelope_hash: 'envelope',
        archive_key: bodyKey, receipt_key: receiptKey, digest: bodyKey, size: Buffer.byteLength(bodyText), version: 1, entry_count: 1 } },
      { t: 'tool_calls', r: { project_id: 'project', session_id: 'session', tool_call_id: tool, tool_name: 'shell', token_id: 'token', event_id: 'event', input: 'preview', input_bytes: Buffer.byteLength(input), input_blob_key: null, input_bundle_id: 1, input_bundle_entry: 0, created_at: 1 } },
    ];
    for (const [key, value, sourceKind, sourceId] of [[bodyKey, bodyText, 'bundle', bodyKey], [receiptKey, receiptText, 'receipt', `bundle:${bodyKey}`]]) {
      const bytes = new TextEncoder().encode(value!);
      const blob = { project_id: 'project', key, generation, size: bytes.length, media_type: 'application/json', token_id: 'token', received_at: 1 };
      await db.prepare('INSERT INTO blobs(project_id,key,generation,size,media_type,token_id,received_at) VALUES(?,?,?,?,?,?,?)')
        .bind(blob.project_id, key, generation, bytes.length, blob.media_type, 'token', 1).run();
      blobs.seed(blobObjectKey('project', key!, generation), { size: bytes.length, bytes });
      rows.push({ t: 'blobs', r: blob }, { t: 'registered_content_proofs', r: { project_id: 'project', key, generation,
        source_kind: sourceKind, source_id: sourceId, event_id: 'event', envelope_hash: 'envelope', session_id: 'session', digest: key, size: bytes.length, verified_at: 1, durable: 1 } });
    }
    const text = await artifact(db, rows);
    await expect(restoreArtifact(db, { text, blobs, authorization: { kind: 'recovery' }, documents: { plan: async () => ({
      summary: { convert:1,merge:0,records:1,refuse:[] }, apply: async () => { throw new Error('consumer unavailable'); },
    }) } })).rejects.toThrow('consumer unavailable');
    expect(await db.prepare('SELECT COUNT(*) n FROM archive_bundles').first(),target).toEqual({n:1});
    await restoreArtifact(db, { text, blobs, authorization: { kind: 'recovery' } });
    expect(await db.prepare('SELECT COUNT(*) n FROM archive_bundles').first(),target).toEqual({n:0});
    expect(await db.prepare("SELECT COUNT(*) n FROM registered_content_proofs WHERE source_kind IN ('bundle','receipt')").first(),target).toEqual({n:0});
    const records = await readPage({ db, blobs }, 'project', 'session', '', 0);
    expect(records?.find(row => row.id === tool)?.input, target).toBe(input);
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
      { t: 'prompt_batches', r: { project_id: 'project', session_id: 'deleted', prompt_id: 'prompt', text: 'deleted content', created_at: 1 } },
      { t: 'resolution_events', r: { project_id: 'project', id: 'resolution', agent_id: 'agent', spore_id: 'knowledge', action: 'superseded', session_id: 'kept', created_at: 2 } },
      { t: 'knowledge_git_provenance', r: { id: 1, project_id: 'project', identity_key: 'provenance', session_id: 'deleted', capture_point: 'turn', captured_at: 1, status_hash: 'hash', created_at: 1 } },
      { t: 'spore_injections', r: { project_id: 'project', session_id: 'kept', id: 'receipt', prompt_id: 'kept-prompt', prompt_hash: 'hash', spore_ids: '[]', created_at: 1 } },
      { t: 'injection_served_items', r: { project_id: 'project', receipt_id: 'receipt', kind: 'plan', item_id: 'plan', title: 'deleted title', session_id: 'deleted', content_hash: 'hash', unavailable: 0 } },
    ];
    await restoreArtifact(db, { text: await artifact(db, rows), blobs: memoryBlobStore(), authorization: { kind: 'recovery' } });
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
    await restoreArtifact(db, { text: await artifact(db, rows), authorization: { kind: 'recovery' } });
    expect((await db.prepare('SELECT receipt_id,title FROM injection_served_items').all()).results, target).toEqual([{ receipt_id: 'kept', title: 'retained title' }]);
    expect((await db.prepare('SELECT id FROM spore_injections').all()).results, target).toEqual([{ id: 'kept' }]);
  });
});

test('a deletion between restore admission and its raw write refuses the write and retry excludes the session', async () => {
  const { observeRestoreStore } = await import('./helpers/restore-observer.js');
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore();
    await captureDocumentSession(db, 'project', 'session', { blobs });
    const text = await saved(db, blobs);
    let deleted = false;
    const observed = observeRestoreStore(db, async statements => {
      if (!deleted && statements.some(sql => /INSERT OR IGNORE INTO events\b/.test(sql))) {
        deleted = true;
        await tombstoneSession({ db }, { projectId: 'project' }, 'session', 'member', Date.now());
      }
    });
    await expect(restoreArtifact(observed.db, { text, blobs, authorization: { kind: 'recovery' } })).rejects.toThrow();
    expect(deleted, target).toBe(true);
    expect(await db.prepare("SELECT COUNT(*) n FROM events WHERE session_id='session'").first(), target).toEqual({ n: 0 });
    await restoreArtifact(db, { text, blobs, authorization: { kind: 'recovery' } });
    expect(await db.prepare("SELECT COUNT(*) n FROM publish_queue WHERE session_id='session'").first(), target).toEqual({ n: 0 });
  });
});

test('restore guard reads remain linear across sessions and additive rows', async () => {
  const { observeRestoreStore } = await import('./helpers/restore-observer.js');
  await withDocumentStores(async (db,target) => {
    if (target !== 'D1') return;
    const sessionCount=2_000, tagCount=4_000;
    const rows=[...Array.from({length:sessionCount},(_,i)=>({t:'sessions',r:{project_id:'project',session_id:`session-${i}`,machine_id:'machine',created_by_token_id:'token',first_received_at:1,last_received_at:1}})),
      ...Array.from({length:tagCount},(_,i)=>({t:'tags',r:{project_id:'project',entity_kind:'spore',entity_id:`spore-${i}`,tag:'tag'}}))];
    const text=await artifact(db,rows), observed=observeRestoreStore(db);
    await restoreArtifact(observed.db,{text,authorization:{kind:'recovery'}});
    expect(await db.prepare('SELECT COUNT(*) n FROM tags').first()).toEqual({n:tagCount});
    expect(observed.reads()).toBeLessThan(100_000);
    console.log(JSON.stringify({kind:'restore_guard_cost',sessions:sessionCount,tags:tagCount,reads:observed.reads()}));
  });
});

test('archive selection clears only its named range with bounded store reads', async () => {
  const { clearArchivedTranscriptRanges } = await import('@myco-server-worker/db/documents/ranges.js');
  const { observeRestoreStore } = await import('./helpers/restore-observer.js');
  await withDocumentStores(async (db,target)=>{
    const blobs=memoryBlobStore();
    await captureDocumentTranscript(db,blobs,'session',transcript,'x',Date.now());
    const row=(await db.prepare('SELECT * FROM transcript_segments').first<Record<string,unknown>>())!;
    const segmentCount=2_000;
    await db.prepare(`INSERT INTO transcript_segments(project_id,transcript_id,base_offset,length,blob_key,event_id,created_at,received_at,token_id)
      SELECT 'project',?,value,1,?,?,1,1,? FROM json_each(?)`).bind(transcript,row.blob_key,row.event_id,row.token_id,JSON.stringify(Array.from({length:segmentCount-1},(_,i)=>i+1))).run();
    for(const offset of [0,1])await db.prepare(`INSERT INTO raw_archive_refs(project_id,source_kind,source_id,session_id,size,received_at,transcript_id,base_offset,length,token_id,eligible_at,disposition)
      VALUES('project','transcript',?,'session',1,1,?,?,1,?,1,'archived') ON CONFLICT(project_id,source_kind,source_id) DO UPDATE SET disposition='archived'`).bind(`${transcript}:${offset}`,transcript,offset,row.token_id).run();
    const observed=observeRestoreStore(db);
    await clearArchivedTranscriptRanges(observed.db,'project',transcript,0).run();
    expect(await db.prepare('SELECT COUNT(*) n FROM transcript_segments').first(),target).toEqual({n:segmentCount-1});
    expect(await db.prepare('SELECT base_offset FROM transcript_segments WHERE base_offset=1').first(),target).toEqual({base_offset:1});
    if(target==='D1')expect(observed.reads()).toBeLessThan(20);
  });
});

test('release drain reads do not multiply by retained backup count', async()=>{
  const { observeRestoreStore }=await import('./helpers/restore-observer.js');
  await withDocumentStores(async(db,target)=>{
    if(target!=='D1')return;
    const backups=30, releases=2_000;
    await db.prepare(`INSERT INTO backups(id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned)
      SELECT 'backup-'||value,'backups/'||value,1,1,'{}',1,'test',0 FROM json_each(?)`).bind(JSON.stringify(Array.from({length:backups},(_,i)=>i))).run();
    await db.prepare(`INSERT INTO object_releases(physical,kind,created_at) SELECT 'object-'||value,'blob',1 FROM json_each(?)`)
      .bind(JSON.stringify(Array.from({length:releases},(_,i)=>i))).run();
    const observed=observeRestoreStore(db);
    const drained=await drainObjectReleases({db:observed.db,blobs:memoryBlobStore()},Date.now());
    expect(drained.deleted).toBe(16);
    expect(await db.prepare('SELECT COUNT(*) n FROM backups').first()).toEqual({n:backups});
    expect(observed.reads()).toBeLessThan(10_000);
    console.log(JSON.stringify({kind:'release_drain_cost',backups,releases,reads:observed.reads()}));
  });
});
