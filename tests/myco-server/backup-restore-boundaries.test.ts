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
    await db.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,generation,session_id,published_offset,record_scheme,parser_version,state,updated_at)
      SELECT t.project_id,t.transcript_id,d.generation,t.session_id,?,'source-record-v1',1,'active',? FROM transcripts t
      JOIN session_documents d ON d.project_id=t.project_id AND d.session_id=t.session_id WHERE t.transcript_id=?`)
      .bind(text.length, now, transcript).run();
    for (let pass = 0; pass < 8; pass++) await archiveRawSources(env, now + 100 * 86_400_000, 90);
    expect(await db.prepare('SELECT COUNT(*) n FROM transcript_segments').first(), target).toEqual({ n: 0 });
    await restoreArtifact(db, { text: snapshot, blobs, authorization: { kind: 'recovery' } });
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
    await restoreArtifact(db, { text, blobs, authorization: { kind: 'recovery' } });
    const records = await readPage({ db, blobs }, 'project', 'session', '', 0);
    expect(records?.find(row => row.id === tool)?.input, target).toBe(input);
  });
});
