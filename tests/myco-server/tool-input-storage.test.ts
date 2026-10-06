import { describe, expect, it } from 'bun:test';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { prepareArchive } from '@myco-server-worker/core/event-content.js';
import { cleanupCandidate, storageCleanup } from '@myco-server-worker/core/storage-cleanup.js';
import { createBackup } from '@myco-server-worker/core/backup.js';
import { listToolCalls } from '@myco-server-worker/read/children.js';
import { processedBody } from '@myco-server-worker/read/processed.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import worker from '@myco-server-worker/index.js';
import { seedCredential } from './helpers/d1.js';
import { envelope, sqliteEnv, uuid } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';

const NOW = Date.now();

function fixture() {
  const f = sqliteEnv();
  const tokenId = seedCredential(f.sqlite, { expiresAt: NOW + 60_000 });
  const ctx = { projectId: 'proj_1', machineId: 'machine_1', tokenId, bodyBytes: 0, now: NOW };
  const send = (n: number, toolCallId: string, input: unknown, kind: 'tool.use' | 'tool.failure' = 'tool.use', toolName = 'Write') =>
    ingestEvent(f.db, ctx, envelope({
      eventId: uuid(n), sessionId: 's1', kind, createdAt: NOW - 1_000,
      payload: { toolCallId, toolName, input, success: kind === 'tool.use', ...(kind === 'tool.failure' ? { errorMessage: 'failed' } : {}) },
    }), f.serverEnv);
  return { ...f, send, tokenId };
}

describe('tool input storage', () => {
  it('preserves the 4096-character output prefix and tool attribution while archiving inputs', async () => {
    const f = fixture();
    try {
      const fullOutput = `first ${'é🙂'.repeat(2200)} last`;
      const events = await PARSERS['claude-code'].parse({ sessionId: 's1', now: NOW, lines: [
        { offset: 0, value: { type: 'assistant', timestamp: new Date(NOW - 2000).toISOString(), message: { content: [
          { type: 'tool_use', id: 'output-preserved', name: 'Write', input: { body: 'input '.repeat(600), file_path: '/repo/output.ts' } },
        ] } } },
        { offset: 100, value: { type: 'user', timestamp: new Date(NOW - 1000).toISOString(), message: { content: [
          { type: 'tool_result', tool_use_id: 'output-preserved', content: fullOutput },
        ] } } },
      ] });
      const tool = events.find(event => event.kind === 'tool.use')!;
      expect(tool.payload.output).toBe(fullOutput.slice(0, 4096));
      const tokenId = f.tokenId;
      expect((await ingestEvent(f.db, { projectId: 'proj_1', machineId: 'machine_1', tokenId, bodyBytes: 0,
        now: NOW, writeOrigin: 'server' }, envelope({ eventId: uuid(220), sessionId: 's1', kind: 'tool.use',
        channel: 'import', payload: { ...tool.payload, toolCallId: uuid(221), mycoTool: 'myco_context', mycoOp: 'read',
          canopyInjectionTokens: 321, durationMs: 123 } }), f.serverEnv)).persisted).toBe(true);
      const facts = f.sqlite.query('SELECT * FROM tool_calls').all();
      for (let pass = 0; pass < 16; pass++) await storageCleanup(f.serverEnv, NOW);
      expect(f.sqlite.query('SELECT * FROM tool_calls').all()).toEqual(facts);
      expect((await listToolCalls(f.db, { projectId: 'proj_1' }, 's1')).rows[0].outputPreview).toBe(fullOutput.slice(0, 4096));
    } finally { f.sqlite.close(); }
  });
  it('keeps inline inputs through 2048 UTF-8 bytes and spills complete larger inputs', async () => {
    const f = fixture();
    try {
      for (const [n, input] of [
        [1, { text: 'x'.repeat(2036) }],
        [2, { text: 'x'.repeat(2037) }],
        [3, { text: 'x'.repeat(2038) }],
        [4, { text: `${'é'.repeat(1018)}🙂tail`, file_path: '/repo/late.ts' }],
      ] as const) {
        expect(await f.send(n, uuid(100 + n), input)).toEqual({ persisted: true, projected: true });
      }
      const rows = (await listToolCalls(f.db, { projectId: 'proj_1' }, 's1')).rows;
      expect(rows.map((r) => [r.inputBytes, r.inputTruncated, r.inputBlobKey !== null])).toEqual([
        [2047, false, false], [2048, false, false], [2049, true, true],
        [new TextEncoder().encode(JSON.stringify({ text: `${'é'.repeat(1018)}🙂tail`, file_path: '/repo/late.ts' })).byteLength, true, true],
      ]);
      expect(rows[3].inputPreview).not.toContain('/repo/late.ts');
      expect(new TextEncoder().encode(rows[3].inputPreview!).byteLength).toBeLessThanOrEqual(2048);
      expect(rows[3].filesAffected).toBe('["/repo/late.ts"]');
      expect(await processedBody(f.serverEnv, { projectId: 'proj_1' }, 'tool-input', uuid(104)))
        .toBe(JSON.stringify({ text: `${'é'.repeat(1018)}🙂tail`, file_path: '/repo/late.ts' }));
      const full = await worker.fetch(await asOwner(`/api/projects/proj_1/processed/tool-input/${uuid(104)}`), { ...f.env, ...OWNER_ENV });
      expect([full.status, await full.text(), full.headers.get('cache-control')]).toEqual([
        200, JSON.stringify({ text: `${'é'.repeat(1018)}🙂tail`, file_path: '/repo/late.ts' }), 'private, no-store',
      ]);
      expect(f.bucket.puts.length).toBeGreaterThan(0);
    } finally { f.sqlite.close(); }
  });

  it('keeps the original input, blob proof, name and file facts on a late success', async () => {
    const f = fixture();
    try {
      const id = uuid(200);
      const original = { text: 'a'.repeat(2200), file_path: '/repo/original.ts' };
      expect(await f.send(201, id, original, 'tool.failure', 'Write')).toEqual({ persisted: true, projected: true });
      expect(await f.send(202, id, { text: 'b'.repeat(2200), file_path: '/repo/replacement.ts' }, 'tool.use', 'Read'))
        .toEqual({ persisted: true, projected: true });
      const row = (await listToolCalls(f.db, { projectId: 'proj_1' }, 's1')).rows[0];
      expect([row.success, row.toolName, row.filesAffected, row.inputBytes]).toEqual([
        true, 'Write', '["/repo/original.ts"]', new TextEncoder().encode(JSON.stringify(original)).byteLength,
      ]);
      expect(await processedBody(f.serverEnv, { projectId: 'proj_1' }, 'tool-input', id)).toBe(JSON.stringify(original));
      expect(f.sqlite.query(`SELECT key FROM registered_content_proofs WHERE source_kind='tool-input' AND event_id=?`).all(uuid(202))).toEqual([]);
    } finally { f.sqlite.close(); }
  });

  it('finishes clearing a legacy full input when a late success arrives after its proof', async () => {
    const f = fixture();
    try {
      const id = uuid(210);
      const failureEvent = uuid(211);
      const successEvent = uuid(212);
      const original = { text: 'é'.repeat(1500), file_path: '/repo/legacy.ts' };
      expect(await f.send(211, id, { text: 'small', file_path: original.file_path }, 'tool.failure'))
        .toEqual({ persisted: true, projected: true });

      const payload = JSON.stringify({ toolCallId: id, toolName: 'Write', input: original, success: false, errorMessage: 'failed' });
      const source = f.sqlite.query(`SELECT session_id,kind,created_at,channel,producer_adapter,producer_version
        FROM events WHERE event_id=?`).get(failureEvent) as {
        session_id: string; kind: string; created_at: number; channel: string; producer_adapter: string; producer_version: string;
      };
      const sourceHash = await sha256Hex(`${JSON.stringify([
        source.session_id, source.kind, source.created_at, source.channel, source.producer_adapter, source.producer_version,
      ])}\n${payload}`);
      f.sqlite.query(`UPDATE events SET payload=?,payload_bytes=?,envelope_hash=? WHERE event_id=?`)
        .run(payload, new TextEncoder().encode(payload).byteLength, sourceHash, failureEvent);
      f.sqlite.query(`UPDATE tool_calls SET input=?,input_bytes=NULL WHERE tool_call_id=?`).run(JSON.stringify(original), id);

      const candidate = await cleanupCandidate(f.db, { project_id: 'proj_1', resource_kind: 'tool-input', resource_id: id });
      expect(candidate).not.toBeNull();
      await prepareArchive(f.serverEnv, 'tool-input', candidate!, NOW);
      expect(await f.send(212, id, { text: 'replacement', file_path: '/repo/replacement.ts' }, 'tool.use', 'Read'))
        .toEqual({ persisted: true, projected: true });

      expect((await storageCleanup(f.serverEnv, NOW)).changed).toBe(1);
      const row = (await listToolCalls(f.db, { projectId: 'proj_1' }, 's1')).rows[0];
      expect([row.success, row.toolName, row.filesAffected, row.inputTruncated, row.inputBytes]).toEqual([
        true, 'Write', '["/repo/legacy.ts"]', true, new TextEncoder().encode(JSON.stringify(original)).byteLength,
      ]);
      expect(new TextEncoder().encode(row.inputPreview!).byteLength).toBeLessThanOrEqual(2048);
      expect(f.sqlite.query(`SELECT event_id FROM processed_resources WHERE project_id='proj_1'
        AND kind='tool-input' AND resource_id=?`).get(id)).toEqual({ event_id: failureEvent });
      expect(f.sqlite.query(`SELECT event_id FROM tool_calls WHERE tool_call_id=?`).get(id)).toEqual({ event_id: successEvent });
      expect(await processedBody(f.serverEnv, { projectId: 'proj_1' }, 'tool-input', id)).toBe(JSON.stringify(original));
      const full = await worker.fetch(await asOwner(`/api/projects/proj_1/processed/tool-input/${id}`), { ...f.env, ...OWNER_ENV });
      expect([full.status, await full.text()]).toEqual([200, JSON.stringify(original)]);
      expect((await createBackup(f.db, f.serverEnv.blobs, { producer: 'test', now: NOW })).size_bytes).toBeGreaterThan(0);
    } finally { f.sqlite.close(); }
  });

  it('refuses a missing proof and corrupt complete body even when a preview is present', async () => {
    const f = fixture();
    try {
      const id = uuid(300);
      expect(await f.send(301, id, { text: 'c'.repeat(2200) })).toEqual({ persisted: true, projected: true });
      f.sqlite.run(`DELETE FROM processed_resources WHERE project_id = 'proj_1' AND kind = 'tool-input' AND resource_id = ?`, [id]);
      expect(await processedBody(f.serverEnv, { projectId: 'proj_1' }, 'tool-input', id)).toBeNull();
      expect((await worker.fetch(await asOwner(`/api/projects/proj_1/processed/tool-input/${id}`), { ...f.env, ...OWNER_ENV })).status).toBe(404);
      const row = f.sqlite.query(`SELECT input_blob_key AS key FROM tool_calls WHERE tool_call_id = ?`).get(id) as { key: string };
      f.sqlite.run(`INSERT INTO processed_resources(project_id,kind,resource_id,blob_key,source_token_id,event_id)
        SELECT project_id,'tool-input',tool_call_id,input_blob_key,token_id,event_id FROM tool_calls WHERE tool_call_id = ?`, [id]);
      const objectKey = (f.sqlite.query(`SELECT project_id || '/' || key || '~' || generation AS object_key FROM blobs WHERE project_id = 'proj_1' AND key = ?`).get(row.key) as { object_key: string }).object_key;
      f.bucket.seed(objectKey, { size: 3, bytes: new TextEncoder().encode('bad') });
      await expect(processedBody(f.serverEnv, { projectId: 'proj_1' }, 'tool-input', id)).rejects.toThrow('does not match its registered body');
      expect((await worker.fetch(await asOwner(`/api/projects/proj_1/processed/tool-input/${id}`), { ...f.env, ...OWNER_ENV })).status).toBe(503);
    } finally { f.sqlite.close(); }
  });

  it('releases prepared proof when a member cannot write the session', async () => {
    const f = fixture();
    try {
      expect(await f.send(400, uuid(401), { text: 'first' })).toEqual({ persisted: true, projected: true });
      const otherToken = seedCredential(f.sqlite, { id: 'other-token', memberId: 'mem_machine_2', machineId: 'machine_2', expiresAt: NOW + 60_000 });
      const rejected = await ingestEvent(f.db, {
        projectId: 'proj_1', machineId: 'machine_2', tokenId: otherToken, bodyBytes: 0, now: NOW,
      }, envelope({ eventId: uuid(402), sessionId: 's1', kind: 'tool.use', createdAt: NOW - 1_000,
        payload: { toolCallId: uuid(403), toolName: 'Write', input: { text: 'x'.repeat(2300) }, success: true } }), f.serverEnv);
      expect(rejected).toMatchObject({ persisted: false, code: 'identity_mismatch' });
      expect(f.sqlite.query(`SELECT key FROM registered_content_proofs WHERE source_kind='tool-input' AND source_id=?`).all(uuid(403))).toEqual([]);
      expect(f.sqlite.query(`SELECT tool_call_id FROM tool_calls WHERE tool_call_id=?`).all(uuid(403))).toEqual([]);
    } finally { f.sqlite.close(); }
  });

  it('releases prepared proof when the event transaction fails', async () => {
    const f = sqliteEnv({ onSql: (sql) => {
      if (sql.startsWith('INSERT INTO tool_calls')) throw new Error('projection batch failed');
    } });
    try {
      const tokenId = seedCredential(f.sqlite, { expiresAt: NOW + 60_000 });
      const id = uuid(500);
      await expect(ingestEvent(f.db, { projectId: 'proj_1', machineId: 'machine_1', tokenId, bodyBytes: 0, now: NOW },
        envelope({ eventId: uuid(501), sessionId: 's1', kind: 'tool.use', createdAt: NOW - 1_000,
          payload: { toolCallId: id, toolName: 'Write', input: { text: 'x'.repeat(2300) }, success: true } }), f.serverEnv))
        .rejects.toThrow('projection batch failed');
      expect(f.sqlite.query(`SELECT key FROM registered_content_proofs WHERE source_kind='tool-input' AND source_id=?`).all(id)).toEqual([]);
      expect(f.sqlite.query(`SELECT event_id FROM events WHERE event_id=?`).all(uuid(501))).toEqual([]);
    } finally { f.sqlite.close(); }
  });
});
