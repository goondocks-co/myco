import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { backupArtifact, BackupApplyError, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { eventContent } from '@myco-server-worker/core/event-content.js';
import { toolInputPreview } from '@myco-server-worker/core/tool-input.js';
import { processedBody } from '@myco-server-worker/read/processed.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { createRecoveryBundle, verifyRecoveryBundle } from '@myco/server/recovery-bundle.js';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const project = 'proj_archive_backup';
const session = 'sess_archive_backup';
const eventId = 'evt_archive_backup';
const envelope = digest('source envelope');
const original = '{"text":"full original payload with exact JSON spelling"}';
const bodyKey = digest(original);
const sourceGeneration = '00000000-0000-4000-8000-000000000001';
const receiptBytes = JSON.stringify({ version: 1, projectId: project, kind: 'event', resourceId: eventId,
  eventId, envelopeHash: envelope, revision: 0,
  body: { key: bodyKey, generation: sourceGeneration, size: Buffer.byteLength(original), digest: bodyKey } });
const receiptKey = digest(receiptBytes);
const toolId = 'tool_archive_backup';
const fullInput = '界'.repeat(800);
const inputKey = digest(fullInput);
const failureId = 'evt_tool_failure';
const successId = 'evt_tool_late_success';
const failureEnvelope = digest('tool failure envelope');
const successEnvelope = digest('tool late success envelope');

function seed(source: ReturnType<typeof sqliteEnv>, generation = sourceGeneration, payload = '{}') {
  const sql = source.sqlite;
  sql.query('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,?)').run(project, project, 1);
  sql.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
    VALUES(?,?,?,?,?,?)`).run(project, session, 'm', 'token', 1, 1);
  for (const [key, bytes] of [[bodyKey, original], [receiptKey, receiptBytes]] as const) {
    sql.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
      VALUES(?,?,?,?,?,?,?)`).run(project, key, Buffer.byteLength(bytes), 'application/json', 'token', 1, generation);
    source.bucket.seed(blobObjectKey(project, key, generation), { size: Buffer.byteLength(bytes), bytes: new TextEncoder().encode(bytes) });
  }
  sql.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,payload_bytes,payload_format,raw_revision)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(project, eventId, session, 'token', 'prompt', 'import', payload, envelope, 1, 1, Buffer.byteLength(original), payload === '{}' ? 'archived' : 'inline', 3);
  if (payload === '{}') {
    sql.query(`INSERT INTO event_content_refs(project_id,event_id,session_id,archive_key,receipt_key,digest,size,version,title_only_end,source_envelope_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(project, eventId, session, bodyKey, receiptKey, bodyKey, Buffer.byteLength(original), 1, 0, envelope);
    for (const [kind, sourceId, key, bytes] of [['event', eventId, bodyKey, original], ['receipt', `event:${eventId}`, receiptKey, receiptBytes]] as const) {
      sql.query(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`).run(project, key, generation, kind, sourceId, eventId, envelope, session, key, Buffer.byteLength(bytes), 1);
    }
    sql.query(`INSERT INTO raw_archive_refs(project_id,source_kind,source_id,session_id,archive_key,receipt_key,digest,size,version,
      received_at,token_id,raw_revision,disposition,eligible_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(project, 'event', eventId, session, bodyKey, receiptKey, bodyKey, Buffer.byteLength(original), 1, 1, 'token', 3, 'archived', 1);
  }
}

function seedTool(source: ReturnType<typeof sqliteEnv>, generation = sourceGeneration, input = toolInputPreview(fullInput).preview) {
  const sql = source.sqlite;
  sql.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    VALUES(?,?,?,?,?,?,?)`).run(project, inputKey, Buffer.byteLength(fullInput), 'application/json', 'token', 1, generation);
  source.bucket.seed(blobObjectKey(project, inputKey, generation), { size: Buffer.byteLength(fullInput), bytes: new TextEncoder().encode(fullInput) });
  sql.query(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`).run(project, inputKey, generation, 'tool-input', toolId, eventId, envelope, session, inputKey, Buffer.byteLength(fullInput), 1);
  sql.query(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,tool_name,input,input_blob_key,input_bytes,success,created_at,token_id,received_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(project, toolId, session, eventId, 'test.tool', input, inputKey, Buffer.byteLength(fullInput), 1, 1, 'token', 1);
  sql.query(`INSERT OR IGNORE INTO processed_resources(project_id,kind,resource_id,blob_key,source_token_id,event_id)
    VALUES(?,'tool-input',?,?,?,?)`).run(project, toolId, inputKey, 'token', eventId);
}

function seedLateSuccess(source: ReturnType<typeof sqliteEnv>) {
  const sql = source.sqlite;
  for (const [id, kind, hash, success] of [
    [failureId, 'tool.failure', failureEnvelope, false],
    [successId, 'tool.use', successEnvelope, true],
  ] as const) {
    const payload = JSON.stringify({ toolCallId: toolId, input: fullInput, success });
    sql.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,payload_bytes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(project, id, session, 'token', kind, 'cli', payload, hash, 2, 2, Buffer.byteLength(payload));
  }
  sql.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    VALUES(?,?,?,?,?,?,?)`).run(project, inputKey, Buffer.byteLength(fullInput), 'application/json', 'token', 2, sourceGeneration);
  source.bucket.seed(blobObjectKey(project, inputKey, sourceGeneration),
    { size: Buffer.byteLength(fullInput), bytes: new TextEncoder().encode(fullInput) });
  sql.query(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`).run(project, inputKey, sourceGeneration, 'tool-input', toolId,
    failureId, failureEnvelope, session, inputKey, Buffer.byteLength(fullInput), 2);
  sql.query(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,tool_name,input,input_blob_key,input_bytes,
    output_preview,success,created_at,token_id,received_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(project, toolId, session, failureId, 'test.tool',
    toolInputPreview(fullInput).preview, inputKey, Buffer.byteLength(fullInput), null, 0, 2, 'token', 2);
  sql.query(`UPDATE tool_calls SET event_id=?,success=1,output_preview=? WHERE project_id=? AND tool_call_id=?`)
    .run(successId, 'late success output', project, toolId);
}

it('restores an archived event with its reference and remapped publication generation in one transaction', async () => {
  const source = sqliteEnv();
  const target = sqliteEnv();
  try {
    seed(source);
    const saved = await createBackup(source.db, source.bucket, { producer: 'test', now: 1 });
    const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!.text;
    const sourceGeneration = source.sqlite.query<{ generation: string }, []>(`SELECT generation FROM blobs WHERE project_id = '${project}' AND key = '${bodyKey}'`).get()!.generation;
    const destinationGeneration = randomUUID();
    for (const [key, bytes] of [[bodyKey, original], [receiptKey, receiptBytes]] as const) {
      target.sqlite.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        VALUES(?,?,?,?,?,?,?)`).run(project, key, Buffer.byteLength(bytes), 'application/json', 'token', 1, destinationGeneration);
      target.bucket.seed(blobObjectKey(project, key, destinationGeneration), { size: Buffer.byteLength(bytes), bytes: new TextEncoder().encode(bytes) });
    }
    expect(sourceGeneration).not.toBe(destinationGeneration);
    const outcome = await restoreArtifact(target.db, { text: artifact, allowForeignLineage: true, authorization: { kind: 'recovery' } });
    expect(outcome.tables.events?.inserted).toBe(1);
    expect(target.sqlite.query(`SELECT payload,payload_format FROM events WHERE project_id = ? AND event_id = ?`).get(project, eventId))
      .toEqual({ payload: '{}', payload_format: 'archived' });
    expect(target.sqlite.query(`SELECT archive_key,receipt_key FROM event_content_refs WHERE project_id = ? AND event_id = ?`).get(project, eventId))
      .toEqual({ archive_key: bodyKey, receipt_key: receiptKey });
    const revision = target.sqlite.query<{ raw_revision: number }, []>(`SELECT raw_revision FROM events WHERE project_id = ? AND event_id = ?`).get(project, eventId)!.raw_revision;
    expect(revision).toBeGreaterThan(3);
    expect(target.sqlite.query(`SELECT archive_key,disposition,raw_revision FROM raw_archive_refs WHERE project_id = ? AND source_kind = 'event' AND source_id = ?`).get(project, eventId))
      .toEqual({ archive_key: bodyKey, disposition: 'archived', raw_revision: revision });
    expect(target.sqlite.query<{ generation: string }, []>(`SELECT generation FROM registered_content_proofs WHERE project_id = ? AND key = ?`).get(project, bodyKey)?.generation)
      .toBe(destinationGeneration);
    expect(await eventContent({ db: target.db, blobs: target.bucket }, project, eventId)).toBe(original);
    expect((await restoreArtifact(target.db, { text: artifact, allowForeignLineage: true, authorization: { kind: 'recovery' } })).tables.events?.inserted).toBe(0);
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

it('refuses an artifact missing its archive reference or receipt proof before inserting the event', async () => {
  const source = sqliteEnv();
  const target = sqliteEnv();
  try {
    seed(source);
    const saved = await createBackup(source.db, source.bucket, { producer: 'test', now: 1 });
    const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!.text;
    for (const table of ['event_content_refs', 'registered_content_proofs']) {
      const altered = artifact.trimEnd().split('\n').filter(line => {
        const entry = JSON.parse(line) as { t?: string; r?: Record<string, unknown> };
        return entry.t !== table || (table === 'registered_content_proofs' && entry.r?.key !== receiptKey);
      }).join('\n') + '\n';
      await expect(restoreArtifact(target.db, { text: altered, allowForeignLineage: true, authorization: { kind: 'recovery' } })).rejects.toThrow(BackupApplyError);
      expect(target.sqlite.query(`SELECT 1 FROM events WHERE project_id = ? AND event_id = ?`).get(project, eventId)).toBeNull();
      expect(target.sqlite.query('SELECT 1 FROM projects WHERE project_id=?').get(project)).toBeNull();
    }
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

it('keeps a held inline event and its raw row unchanged when an archive artifact overlaps', async () => {
  const source = sqliteEnv();
  const target = sqliteEnv();
  try {
    seed(source);
    seed(target, randomUUID(), original);
    const saved = await createBackup(source.db, source.bucket, { producer: 'test', now: 1 });
    const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!.text;
    const outcome = await restoreArtifact(target.db, { text: artifact, allowForeignLineage: true, authorization: { kind: 'recovery' } });
    expect(outcome.tables.events?.inserted).toBe(0);
    expect(target.sqlite.query(`SELECT payload,payload_format FROM events WHERE project_id = ? AND event_id = ?`).get(project, eventId))
      .toEqual({ payload: original, payload_format: 'inline' });
    expect(target.sqlite.query(`SELECT 1 FROM event_content_refs WHERE project_id = ? AND event_id = ?`).get(project, eventId)).toBeNull();
    expect(target.sqlite.query(`SELECT 1 FROM registered_content_proofs WHERE project_id = ? AND event_id = ?`).get(project, eventId)).toBeNull();
    expect(target.sqlite.query(`SELECT archive_key,disposition FROM raw_archive_refs WHERE project_id = ? AND source_kind = 'event' AND source_id = ?`).get(project, eventId))
      .toEqual({ archive_key: null, disposition: 'hot' });
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

it('rolls back a newly inserted event when its reference cannot match the destination', async () => {
  const source = sqliteEnv();
  const target = sqliteEnv();
  try {
    seed(source);
    const saved = await createBackup(source.db, source.bucket, { producer: 'test', now: 1 });
    const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!.text;
    const destinationGeneration = randomUUID();
    for (const [key, bytes] of [[bodyKey, original], [receiptKey, receiptBytes]] as const) {
      target.sqlite.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        VALUES(?,?,?,?,?,?,?)`).run(project, key, Buffer.byteLength(bytes), 'application/json', 'token', 1, destinationGeneration);
    }
    target.sqlite.query(`INSERT INTO event_content_refs(project_id,event_id,session_id,archive_key,receipt_key,digest,size,version,title_only_end,source_envelope_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(project, eventId, session, receiptKey, bodyKey, receiptKey, Buffer.byteLength(receiptBytes), 1, 0, envelope);
    await expect(restoreArtifact(target.db, { text: artifact, allowForeignLineage: true, authorization: { kind: 'recovery' } }))
      .rejects.toThrow(BackupApplyError);
    expect(target.sqlite.query('SELECT 1 FROM events WHERE project_id = ? AND event_id = ?').get(project, eventId)).toBeNull();
    expect(target.sqlite.query('SELECT 1 FROM registered_content_proofs WHERE project_id = ?').get(project)).toBeNull();
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

it('restores a displayed tool input with its full body proof and processed reference atomically', async () => {
  const source = sqliteEnv();
  const target = sqliteEnv();
  try {
    seed(source);
    seedTool(source);
    const saved = await createBackup(source.db, source.bucket, { producer: 'test', now: 1 });
    const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!.text;
    const destinationGeneration = randomUUID();
    for (const [key, bytes] of [[bodyKey, original], [receiptKey, receiptBytes], [inputKey, fullInput]] as const) {
      target.sqlite.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        VALUES(?,?,?,?,?,?,?)`).run(project, key, Buffer.byteLength(bytes), 'application/json', 'token', 1, destinationGeneration);
      target.bucket.seed(blobObjectKey(project, key, destinationGeneration), { size: Buffer.byteLength(bytes), bytes: new TextEncoder().encode(bytes) });
    }
    const outcome = await restoreArtifact(target.db, { text: artifact, allowForeignLineage: true, authorization: { kind: 'recovery' } });
    expect(outcome.tables.tool_calls?.inserted).toBe(1);
    expect(target.sqlite.query(`SELECT input,input_blob_key,input_bytes FROM tool_calls WHERE project_id = ? AND tool_call_id = ?`).get(project, toolId))
      .toEqual({ input: toolInputPreview(fullInput).preview, input_blob_key: inputKey, input_bytes: Buffer.byteLength(fullInput) });
    expect(target.sqlite.query(`SELECT blob_key,event_id FROM processed_resources WHERE project_id = ? AND kind = 'tool-input' AND resource_id = ?`).get(project, toolId))
      .toEqual({ blob_key: inputKey, event_id: eventId });
    expect(target.sqlite.query<{ generation: string }, []>(`SELECT generation FROM registered_content_proofs WHERE project_id = ? AND source_kind = 'tool-input' AND source_id = ?`).get(project, toolId)?.generation)
      .toBe(destinationGeneration);
    expect(await processedBody({ db: target.db, blobs: target.bucket }, { projectId: project }, 'tool-input', toolId)).toBe(fullInput);
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

it('backs up and restores a late-success tool outcome with its earlier immutable input source', async () => {
  const source = sqliteEnv();
  const target = sqliteEnv();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-late-tool-backup-'));
  try {
    seed(source);
    seedLateSuccess(source);
    const saved = await createBackup(source.db, source.bucket, { producer: 'test', now: 2 });
    const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!.text;
    const destinationGeneration = randomUUID();
    for (const [key, bytes] of [[bodyKey, original], [receiptKey, receiptBytes], [inputKey, fullInput]] as const) {
      target.sqlite.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        VALUES(?,?,?,?,?,?,?)`).run(project, key, Buffer.byteLength(bytes), 'application/json', 'token', 2, destinationGeneration);
      target.bucket.seed(blobObjectKey(project, key, destinationGeneration),
        { size: Buffer.byteLength(bytes), bytes: new TextEncoder().encode(bytes) });
    }
    const outcome = await restoreArtifact(target.db, { text: artifact, allowForeignLineage: true, authorization: { kind: 'recovery' } });
    expect(outcome.tables.tool_calls?.inserted).toBe(1);
    expect(target.sqlite.query(`SELECT event_id,success,output_preview FROM tool_calls WHERE project_id=? AND tool_call_id=?`).get(project, toolId))
      .toEqual({ event_id: successId, success: 1, output_preview: 'late success output' });
    expect(target.sqlite.query(`SELECT event_id FROM processed_resources WHERE project_id=? AND kind='tool-input' AND resource_id=?`).get(project, toolId))
      .toEqual({ event_id: failureId });
    expect(target.sqlite.query(`SELECT event_id,envelope_hash,generation FROM registered_content_proofs
      WHERE project_id=? AND source_kind='tool-input' AND source_id=?`).get(project, toolId))
      .toEqual({ event_id: failureId, envelope_hash: failureEnvelope, generation: destinationGeneration });
    expect(await processedBody({ db: target.db, blobs: target.bucket }, { projectId: project }, 'tool-input', toolId)).toBe(fullInput);

    const bundle = path.join(scratch, 'bundle');
    await createRecoveryBundle(bundle, {
      source: { target: 'local', locator: 'late-tool-fixture' },
      snapshot: async file => { source.sqlite.query('VACUUM INTO ?').run(file); return { configuration: {}, credentialsRequired: [] }; },
      blob: async object => {
        const stored = source.bucket.objects.get(object.source);
        if (stored === undefined) throw new Error('source object is unavailable');
        return new Response(new Uint8Array(stored.bytes).buffer).body!;
      },
    });
    source.bucket.objects.clear();
    await verifyRecoveryBundle(bundle);
    const recovered = new Database(path.join(bundle, 'myco.sqlite'), { readonly: true });
    try {
      expect(recovered.query(`SELECT event_id,output_preview FROM tool_calls WHERE project_id=? AND tool_call_id=?`).get(project, toolId))
        .toEqual({ event_id: successId, output_preview: 'late success output' });
      expect(recovered.query(`SELECT event_id FROM processed_resources WHERE project_id=? AND kind='tool-input' AND resource_id=?`).get(project, toolId))
        .toEqual({ event_id: failureId });
      expect(fs.readFileSync(path.join(bundle, 'blobs', project, inputKey), 'utf8')).toBe(fullInput);
    } finally { recovered.close(); }
  } finally { source.sqlite.close(); target.sqlite.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it('restores a schema-74 full tool input row without a displayed-input proof', async () => {
  const source = sqliteEnv();
  const target = sqliteEnv();
  try {
    seed(source, sourceGeneration, original);
    source.sqlite.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
      VALUES(?,?,?,?,?,?,?)`).run(project, inputKey, Buffer.byteLength(fullInput), 'application/json', 'token', 1, sourceGeneration);
    source.bucket.seed(blobObjectKey(project, inputKey, sourceGeneration),
      { size: Buffer.byteLength(fullInput), bytes: new TextEncoder().encode(fullInput) });
    source.sqlite.query(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,tool_name,input,input_blob_key,
      success,created_at,token_id,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(project, toolId, session, eventId, 'test.tool', fullInput, inputKey, 1, 1, 'token', 1);
    expect(source.sqlite.query(`SELECT input_bytes FROM tool_calls WHERE project_id=? AND tool_call_id=?`).get(project, toolId))
      .toEqual({ input_bytes: null });
    expect(source.sqlite.query(`SELECT event_id FROM processed_resources WHERE project_id=? AND kind='tool-input' AND resource_id=?`).get(project, toolId))
      .toEqual({ event_id: eventId });
    const saved = await createBackup(source.db, source.bucket, { producer: 'legacy input fixture', now: 1 });
    const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!.text;
    const [header, ...records] = artifact.trim().split('\n');
    const prior = JSON.parse(header!) as Record<string, unknown>;
    prior.schemaVersion = 74;
    const oldArtifact = [JSON.stringify(prior), ...records.flatMap(line => {
      const record = JSON.parse(line) as { t: string; r: Record<string, unknown> };
      if (record.t === 'raw_archive_refs') return [];
      if (record.t === 'tool_calls') { delete record.r.input_bytes; delete record.r.content_revision; }
      if (record.t === 'events') { delete record.r.payload_format; delete record.r.content_revision; }
      return [JSON.stringify(record)];
    })].join('\n') + '\n';
    for (const [key, bytes] of [[bodyKey, original], [receiptKey, receiptBytes], [inputKey, fullInput]] as const) {
      target.sqlite.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        VALUES(?,?,?,?,?,?,?)`).run(project, key, Buffer.byteLength(bytes), 'application/json', 'token', 1, randomUUID());
    }
    const generation = target.sqlite.query<{ generation: string }, []>(`SELECT generation FROM blobs WHERE project_id=? AND key=?`).get(project, inputKey)!.generation;
    target.bucket.seed(blobObjectKey(project, inputKey, generation),
      { size: Buffer.byteLength(fullInput), bytes: new TextEncoder().encode(fullInput) });
    const outcome = await restoreArtifact(target.db, { text: oldArtifact, allowForeignLineage: true, authorization: { kind: 'recovery' } });
    expect(outcome.tables.tool_calls?.inserted).toBe(1);
    expect(target.sqlite.query(`SELECT input,input_blob_key,input_bytes FROM tool_calls WHERE project_id=? AND tool_call_id=?`).get(project, toolId))
      .toEqual({ input: fullInput, input_blob_key: inputKey, input_bytes: null });
    expect(target.sqlite.query(`SELECT event_id FROM processed_resources WHERE project_id=? AND kind='tool-input' AND resource_id=?`).get(project, toolId))
      .toEqual({ event_id: eventId });
    expect(await processedBody({ db: target.db, blobs: target.bucket }, { projectId: project }, 'tool-input', toolId)).toBe(fullInput);
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

it('refuses a late-success input whose original source event is absent', async () => {
  const source = sqliteEnv();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-late-tool-refusal-'));
  try {
    seed(source);
    seedLateSuccess(source);
    source.sqlite.query('DELETE FROM events WHERE project_id=? AND event_id=?').run(project, failureId);
    await expect(createBackup(source.db, source.bucket, { producer: 'test', now: 2 })).rejects.toThrow();
    await expect(createRecoveryBundle(path.join(scratch, 'refused'), {
      source: { target: 'local', locator: 'late-tool-fixture' },
      snapshot: async file => { source.sqlite.query('VACUUM INTO ?').run(file); return { configuration: {}, credentialsRequired: [] }; },
      blob: async object => new Response(new Uint8Array(source.bucket.objects.get(object.source)!.bytes).buffer).body!,
    })).rejects.toThrow();
  } finally { source.sqlite.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it('remaps archive proofs to legacy registrations without a generation', async () => {
  const source = sqliteEnv();
  const target = sqliteEnv();
  try {
    seed(source);
    const saved = await createBackup(source.db, source.bucket, { producer: 'test', now: 1 });
    const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!.text;
    for (const [key, bytes] of [[bodyKey, original], [receiptKey, receiptBytes]] as const) {
      target.sqlite.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        VALUES(?,?,?,?,?,?,?)`).run(project, key, Buffer.byteLength(bytes), 'application/json', 'token', 1, randomUUID());
      target.sqlite.query('UPDATE blobs SET generation = NULL WHERE project_id = ? AND key = ?').run(project, key);
      target.bucket.seed(blobObjectKey(project, key, null), { size: Buffer.byteLength(bytes), bytes: new TextEncoder().encode(bytes) });
    }
    await restoreArtifact(target.db, { text: artifact, allowForeignLineage: true, authorization: { kind: 'recovery' } });
    expect(target.sqlite.query(`SELECT generation FROM registered_content_proofs WHERE project_id = ? AND key = ?`).get(project, bodyKey))
      .toEqual({ generation: null });
    expect(await eventContent({ db: target.db, blobs: target.bucket }, project, eventId)).toBe(original);
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

it('preserves a held divergent tool input without importing its artifact proof', async () => {
  const source = sqliteEnv();
  const target = sqliteEnv();
  try {
    seed(source);
    seedTool(source);
    const saved = await createBackup(source.db, source.bucket, { producer: 'test', now: 1 });
    const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!.text;
    const destinationGeneration = randomUUID();
    seed(target, destinationGeneration, original);
    target.sqlite.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
      VALUES(?,?,?,?,?,?,?)`).run(project, inputKey, Buffer.byteLength(fullInput), 'application/json', 'token', 1, destinationGeneration);
    target.sqlite.query(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,tool_name,input,input_bytes,success,created_at,token_id,received_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(project, toolId, session, eventId, 'test.tool', 'held input', Buffer.byteLength('held input'), 1, 1, 'token', 1);
    const outcome = await restoreArtifact(target.db, { text: artifact, allowForeignLineage: true, authorization: { kind: 'recovery' } });
    expect(outcome.tables.tool_calls?.inserted).toBe(0);
    expect(target.sqlite.query(`SELECT input,input_blob_key FROM tool_calls WHERE project_id = ? AND tool_call_id = ?`).get(project, toolId))
      .toEqual({ input: 'held input', input_blob_key: null });
    expect(target.sqlite.query(`SELECT 1 FROM processed_resources WHERE project_id = ? AND kind = 'tool-input' AND resource_id = ?`).get(project, toolId)).toBeNull();
    expect(target.sqlite.query(`SELECT 1 FROM registered_content_proofs WHERE project_id = ? AND source_kind = 'tool-input' AND source_id = ?`).get(project, toolId)).toBeNull();
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

it('refuses a displayed input artifact missing its processed reference or full body proof before writes', async () => {
  const source = sqliteEnv();
  const target = sqliteEnv();
  try {
    seed(source);
    seedTool(source);
    const saved = await createBackup(source.db, source.bucket, { producer: 'test', now: 1 });
    const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!.text;
    for (const missing of ['processed_resources', 'registered_content_proofs'] as const) {
      const altered = artifact.trimEnd().split('\n').filter(line => {
        const entry = JSON.parse(line) as { t?: string; r?: Record<string, unknown> };
        return entry.t !== missing || (missing === 'registered_content_proofs' && entry.r?.key !== inputKey);
      }).join('\n') + '\n';
      await expect(restoreArtifact(target.db, { text: altered, allowForeignLineage: true, authorization: { kind: 'recovery' } }))
        .rejects.toThrow(BackupApplyError);
      expect(target.sqlite.query('SELECT 1 FROM events WHERE project_id = ? AND event_id = ?').get(project, eventId)).toBeNull();
      expect(target.sqlite.query('SELECT 1 FROM tool_calls WHERE project_id = ? AND tool_call_id = ?').get(project, toolId)).toBeNull();
    }
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

it('refuses a displayed input whose inline prefix exceeds its byte bound', async () => {
  const source = sqliteEnv();
  try {
    seed(source);
    seedTool(source, sourceGeneration, fullInput);
    await expect(createBackup(source.db, source.bucket, { producer: 'malformed preview', now: 1 })).rejects.toThrow();
  } finally { source.sqlite.close(); }
});

it('rolls back a new tool row when a held processed reference conflicts', async () => {
  const source = sqliteEnv();
  const target = sqliteEnv();
  try {
    seed(source);
    seedTool(source);
    const saved = await createBackup(source.db, source.bucket, { producer: 'test', now: 1 });
    const artifact = (await backupArtifact(source.db, source.bucket, saved.id))!.text;
    for (const [key, bytes] of [[bodyKey, original], [receiptKey, receiptBytes], [inputKey, fullInput]] as const) {
      target.sqlite.query(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        VALUES(?,?,?,?,?,?,?)`).run(project, key, Buffer.byteLength(bytes), 'application/json', 'token', 1, randomUUID());
    }
    target.sqlite.query(`INSERT INTO processed_resources(project_id,kind,resource_id,blob_key,source_token_id,event_id)
      VALUES(?,'tool-input',?,?,?,?)`).run(project, toolId, inputKey, 'different-token', eventId);
    await expect(restoreArtifact(target.db, { text: artifact, allowForeignLineage: true, authorization: { kind: 'recovery' } }))
      .rejects.toThrow(BackupApplyError);
    expect(target.sqlite.query('SELECT 1 FROM tool_calls WHERE project_id = ? AND tool_call_id = ?').get(project, toolId)).toBeNull();
    expect(target.sqlite.query(`SELECT 1 FROM registered_content_proofs WHERE project_id = ? AND source_kind = 'tool-input' AND source_id = ?`).get(project, toolId)).toBeNull();
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

it('verifies a complete recovery with its source unavailable and refuses missing or corrupt archive closure', async () => {
  const source = sqliteEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-recovery-'));
  try {
    seed(source);
    seedTool(source);
    const adapter = {
      source: { target: 'local' as const, locator: 'archive-fixture' },
      snapshot: async (file: string) => {
        source.sqlite.query('VACUUM INTO ?').run(file);
        return { configuration: {}, credentialsRequired: [] };
      },
      blob: async (object: { source: string }) => {
        const stored = source.bucket.objects.get(object.source);
        if (stored === undefined) throw new Error('original source unavailable');
        return new Response(new Uint8Array(stored.bytes).buffer).body!;
      },
    };
    const destination = path.join(root, 'complete');
    await createRecoveryBundle(destination, adapter);
    source.bucket.objects.clear();
    await verifyRecoveryBundle(destination);
    const restored = new Database(path.join(destination, 'myco.sqlite'), { readonly: true });
    try {
      expect(restored.query(`SELECT payload,payload_format FROM events WHERE project_id = ? AND event_id = ?`).get(project, eventId))
        .toEqual({ payload: '{}', payload_format: 'archived' });
      expect(fs.readFileSync(path.join(destination, 'blobs', project, bodyKey), 'utf8')).toBe(original);
      expect(fs.readFileSync(path.join(destination, 'blobs', project, receiptKey), 'utf8')).toBe(receiptBytes);
      expect(fs.readFileSync(path.join(destination, 'blobs', project, inputKey), 'utf8')).toBe(fullInput);
      expect(restored.query(`SELECT input_blob_key,input_bytes FROM tool_calls WHERE project_id = ? AND tool_call_id = ?`).get(project, toolId))
        .toEqual({ input_blob_key: inputKey, input_bytes: Buffer.byteLength(fullInput) });
    } finally { restored.close(); }
  } finally { source.sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); }

  for (const mutate of ['missing-receipt-proof', 'missing-receipt-blob', 'corrupt-body', 'corrupt-input'] as const) {
    const altered = sqliteEnv();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-recovery-mutant-'));
    try {
      seed(altered);
      seedTool(altered);
      if (mutate === 'missing-receipt-proof') altered.sqlite.query('DELETE FROM registered_content_proofs WHERE project_id = ? AND key = ?').run(project, receiptKey);
      else if (mutate === 'missing-receipt-blob') {
        altered.sqlite.run('DROP TRIGGER blobs_release_through_journal');
        altered.sqlite.query('DELETE FROM blobs WHERE project_id = ? AND key = ?').run(project, receiptKey);
      }
      else {
        const physical = [...altered.bucket.objects.keys()].find(key => key.includes(mutate === 'corrupt-input' ? inputKey : bodyKey))!;
        const stored = altered.bucket.objects.get(physical)!;
        const text = mutate === 'corrupt-input' ? fullInput : original;
        altered.bucket.objects.set(physical, { ...stored, bytes: new TextEncoder().encode('X' + text.slice(1)) });
      }
      await expect(createRecoveryBundle(path.join(scratch, 'refused'), {
        source: { target: 'local', locator: 'archive-fixture' },
        snapshot: async file => { altered.sqlite.query('VACUUM INTO ?').run(file); return { configuration: {}, credentialsRequired: [] }; },
        blob: async object => new Response(new Uint8Array(altered.bucket.objects.get(object.source)!.bytes).buffer).body!,
      })).rejects.toThrow();
    } finally { altered.sqlite.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
  }
});
