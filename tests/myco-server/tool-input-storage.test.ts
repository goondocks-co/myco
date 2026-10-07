import { describe, expect, it } from 'bun:test';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { prepareArchive } from '@myco-server-worker/core/event-content.js';
import { cleanupCandidate, storageCleanup } from '@myco-server-worker/core/storage-cleanup.js';
import { createBackup } from '@myco-server-worker/core/backup.js';
import { listToolCalls } from '@myco-server-worker/read/children.js';
import { listSegments } from '@myco-server-worker/read/transcript.js';
import { processedBody } from '@myco-server-worker/read/processed.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import worker from '@myco-server-worker/index.js';
import { seedCredential } from './helpers/d1.js';
import { envelope, sqliteEnv, uuid } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import { storageCleanupPending } from '@myco-server-worker/core/storage-cleanup.js';
import { measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';

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
  it('leaves an oversized archived singleton readable while draining later compactable inputs', async () => {
    const f=fixture();
    try{
      const input={text:'λ'.repeat(600_000)};
      const largeId=uuid(590);
      expect((await f.send(590,largeId,{text:'inline'})).persisted).toBe(true);
      f.sqlite.query('UPDATE tool_calls SET input=? WHERE tool_call_id=?').run(JSON.stringify(input),largeId);
      for(let pass=0;pass<10&&await storageCleanupPending(f.db);pass++)await storageCleanup(f.serverEnv,NOW);
      expect(await storageCleanupPending(f.db)).toBe(false);
      const before=f.sqlite.query('SELECT input_bundle_id FROM tool_calls WHERE tool_call_id=?').get(largeId);
      expect(before).not.toEqual({input_bundle_id:null});
      f.sqlite.query('UPDATE tool_calls SET input_bundle_id=input_bundle_id WHERE tool_call_id=?').run(largeId);
      expect(await storageCleanupPending(f.db)).toBe(true);
      for(let n=591;n<595;n++)expect((await f.send(n,uuid(n),{text:'x'.repeat(2300)})).persisted).toBe(true);
      for(let pass=0;pass<10&&await storageCleanupPending(f.db);pass++)await storageCleanup(f.serverEnv,NOW);
      expect(await storageCleanupPending(f.db)).toBe(false);
      expect(f.sqlite.query('SELECT input_bundle_id FROM tool_calls WHERE tool_call_id=?').get(largeId)).toEqual(before);
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM content_scan_checkpoints').get()).toEqual({n:0});
      expect(await processedBody(f.serverEnv,{projectId:'proj_1'},'tool-input',largeId)).toBe(JSON.stringify(input));
      const [row]=(await listToolCalls(f.db,{projectId:'proj_1'},'s1')).rows;
      expect(new TextEncoder().encode(row.inputPreview!).byteLength).toBeLessThanOrEqual(2048);
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get()).toEqual({n:2});
    }finally{f.sqlite.close();}
  });
  it('packs a bounded recent-input queue page forward through one session', async () => {
    const f = fixture();
    try {
      f.sqlite.query('UPDATE storage_cleanup_state SET phase=4,complete=1 WHERE id=1').run();
      const originals = new Map<string, string>();
      for (let n = 600; n < 620; n++) {
        const id = uuid(n + 100);
        const input = { text: 'q'.repeat(2300), file_path: `/repo/recent-${n}.ts` };
        originals.set(id, JSON.stringify(input));
        expect((await f.send(n, id, input)).persisted).toBe(true);
      }
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM storage_cleanup_queue').get()).toEqual({ n: 20 });
      for (let pass = 0; pass < 20 && await storageCleanupPending(f.db); pass++) {
        const measured = measuredContentEnv(f.serverEnv, { statements: 120, blobCalls: 60 });
        await storageCleanup(measured.env, NOW);
        expect(measured.usage.statements).toBeLessThanOrEqual(120);
        expect(measured.usage.blobCalls).toBeLessThanOrEqual(60);
      }
      expect(await storageCleanupPending(f.db)).toBe(false);
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM storage_cleanup_queue').get()).toEqual({ n: 0 });
      const bundles = f.sqlite.query('SELECT COUNT(*) AS n,MAX(entry_count) AS largest FROM archive_bundles').get() as {
        n: number; largest: number;
      };
      expect(bundles.n).toBeLessThan(10);
      expect(bundles.largest).toBeGreaterThan(2);
      for (const [id, input] of originals) {
        expect(await processedBody(f.serverEnv, { projectId: 'proj_1' }, 'tool-input', id)).toBe(input);
      }
    } finally { f.sqlite.close(); }
  });

  it('keeps an independent transcript proof and shared blob generation when singleton bundles are compacted', async () => {
    const f = fixture();
    try {
      const first = uuid(580);
      const second = uuid(581);
      expect((await f.send(580, first, { text: 'a'.repeat(2300) })).persisted).toBe(true);
      const old = f.sqlite.query(`SELECT a.id, a.archive_key, a.receipt_key, b.generation, b.size
        FROM archive_bundles a JOIN tool_calls t ON t.project_id=a.project_id AND t.input_bundle_id=a.id
        JOIN blobs b ON b.project_id=a.project_id AND b.key=a.archive_key
        WHERE t.project_id='proj_1' AND t.tool_call_id=?`).get(first) as {
          id: number; archive_key: string; receipt_key: string; generation: string; size: number;
        };
      const physical = `proj_1/${old.archive_key}~${old.generation}`;
      const original = await f.serverEnv.blobs.get(physical);
      expect(original).not.toBeNull();
      const originalBytes = await new Response(original!.body).arrayBuffer();
      expect(originalBytes.byteLength).toBe(old.size);

      const transcriptEvent = uuid(582);
      const transcriptId = 'tx-shared-bundle-bytes';
      const envelopeHash = await sha256Hex(`transcript:${transcriptId}`);
      f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
        created_at,received_at,payload_bytes) VALUES('proj_1',?,'s1',?,'transcript.segment','import','{}',?,1,1,2)`)
        .run(transcriptEvent, f.tokenId, envelopeHash);
      f.sqlite.query(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,segment_count,
        first_received_at,last_received_at,token_id,parsed_offset)
        VALUES('proj_1',?,'s1','machine_1',?,1,1,1,?,0)`)
        .run(transcriptId, old.size, f.tokenId);
      f.sqlite.query(`INSERT INTO transcript_segments(project_id,transcript_id,base_offset,length,blob_key,event_id,
        created_at,received_at,token_id) VALUES('proj_1',?,0,?,?,?,1,1,?)`)
        .run(transcriptId, old.size, old.archive_key, transcriptEvent, f.tokenId);
      f.sqlite.query(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,
        event_id,envelope_hash,session_id,digest,size,verified_at,durable)
        VALUES('proj_1',?,?,'transcript',?,?,?,'s1',?,?,1,1)`)
        .run(old.archive_key, old.generation, `${transcriptId}:0`, transcriptEvent, envelopeHash,
          old.archive_key, old.size);

      expect((await f.send(581, second, { text: 'b'.repeat(2300) })).persisted).toBe(true);
      for (let pass = 0; pass < 20 && await storageCleanupPending(f.db); pass++) {
        await storageCleanup(f.serverEnv, NOW);
      }
      expect(await storageCleanupPending(f.db)).toBe(false);
      expect(f.sqlite.query('SELECT id FROM archive_bundles WHERE id=?').get(old.id)).toBeNull();
      expect(f.sqlite.query(`SELECT source_kind,source_id,generation FROM registered_content_proofs
        WHERE project_id='proj_1' AND key=?`).all(old.archive_key))
        .toEqual([{ source_kind: 'transcript', source_id: `${transcriptId}:0`, generation: old.generation }]);
      for (let pass = 0; pass < 10; pass++) await drainObjectReleases(f.serverEnv, NOW);
      expect(f.sqlite.query(`SELECT generation FROM blobs WHERE project_id='proj_1' AND key=?`).get(old.archive_key))
        .toEqual({ generation: old.generation });
      expect(f.sqlite.query(`SELECT 1 AS held FROM raw_resources WHERE project_id='proj_1' AND kind='blob' AND resource_id=?`)
        .get(old.archive_key)).toEqual({ held: 1 });
      expect(await listSegments(f.db, { projectId: 'proj_1' }, transcriptId))
        .toEqual([{ baseOffset: 0, length: old.size, blobKey: old.archive_key, createdAt: 1, availability: 'hot' }]);
      const retained = await f.serverEnv.blobs.get(physical);
      expect(retained).not.toBeNull();
      expect(await new Response(retained!.body).arrayBuffer()).toEqual(originalBytes);
      expect(await processedBody(f.serverEnv, { projectId: 'proj_1' }, 'tool-input', first))
        .toBe(JSON.stringify({ text: 'a'.repeat(2300) }));
    } finally { f.sqlite.close(); }
  });

  it('combines captured inputs into bounded session bundles and journals replaced objects',async()=>{
    const f=fixture();
    try{
      const originals=new Map<string,string>();
      for(let n=600;n<620;n++){
        const id=uuid(n+100);const input={text:'é'.repeat(1600),file_path:`/repo/${n}.ts`};
        originals.set(id,JSON.stringify(input));
        expect((await f.send(n,id,input)).persisted).toBe(true);
        expect(await processedBody(f.serverEnv,{projectId:'proj_1'},'tool-input',id)).toBe(originals.get(id)!);
      }
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get()).toEqual({n:20});
      for(let pass=0;pass<80&&await storageCleanupPending(f.db);pass++){
        const measured=measuredContentEnv(f.serverEnv,{statements:120,blobCalls:60});
        await storageCleanup(measured.env,NOW);
        expect(measured.usage.statements).toBeLessThanOrEqual(120);
        expect(measured.usage.blobCalls).toBeLessThanOrEqual(60);
      }
      expect(await storageCleanupPending(f.db)).toBe(false);
      const bundles=f.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get() as {n:number};
      expect(bundles.n).toBeLessThan(10);
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM registered_content_proofs').get()).toEqual({n:bundles.n*2});
      for(let pass=0;pass<10;pass++)await drainObjectReleases(f.serverEnv,NOW);
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM blobs').get()).toEqual({n:bundles.n*2});
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM raw_resources WHERE kind=\'blob\'').get()).toEqual({n:bundles.n*2});
      for(const [id,text] of originals)expect(await processedBody(f.serverEnv,{projectId:'proj_1'},'tool-input',id)).toBe(text);
    }finally{f.sqlite.close();}
  });
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
        [5, { text: `${'é🙂'.repeat(2200)}tail`, file_path: '/repo/late.ts' }],
      ] as const) {
        expect(await f.send(n, uuid(100 + n), input)).toEqual({ persisted: true, projected: true });
      }
      const rows = (await listToolCalls(f.db, { projectId: 'proj_1' }, 's1')).rows;
      const locators = f.sqlite.query(`SELECT input_bundle_id FROM tool_calls WHERE project_id='proj_1' AND session_id='s1'
        ORDER BY created_at,tool_call_id`).all() as Array<{ input_bundle_id: number | null }>;
      expect(rows.map((r, index) => [r.inputBytes, r.inputTruncated, locators[index]!.input_bundle_id !== null])).toEqual([
        [2047, false, false], [2048, false, false], [2049, true, true],
        [new TextEncoder().encode(JSON.stringify({ text: `${'é'.repeat(1018)}🙂tail`, file_path: '/repo/late.ts' })).byteLength, true, true],
        [new TextEncoder().encode(JSON.stringify({ text: `${'é🙂'.repeat(2200)}tail`, file_path: '/repo/late.ts' })).byteLength, true, true],
      ]);
      expect(rows[3].inputPreview).not.toContain('/repo/late.ts');
      expect(new TextEncoder().encode(rows[3].inputPreview!).byteLength).toBeLessThanOrEqual(2048);
      expect(new TextEncoder().encode(rows[4].inputPreview!).byteLength).toBeLessThanOrEqual(2048);
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
      expect(f.sqlite.query(`SELECT key FROM registered_content_proofs WHERE source_kind='bundle' AND event_id=?`).all(uuid(202))).toEqual([]);
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
      expect(f.sqlite.query(`SELECT entry_count FROM archive_bundles a JOIN tool_calls t ON t.input_bundle_id=a.id WHERE t.tool_call_id=?`).get(id)).toEqual({entry_count:1});
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
      const row=f.sqlite.query(`SELECT a.archive_key AS key FROM archive_bundles a JOIN tool_calls t ON t.input_bundle_id=a.id
        WHERE t.tool_call_id=?`).get(id) as {key:string};
      const proof=f.sqlite.query('SELECT * FROM registered_content_proofs WHERE key=?').get(row.key) as Record<string,unknown>;
      f.sqlite.run('DELETE FROM registered_content_proofs WHERE key=?',[row.key]);
      await expect(processedBody(f.serverEnv,{projectId:'proj_1'},'tool-input',id)).rejects.toThrow('event_content_reference_invalid');
      expect((await worker.fetch(await asOwner(`/api/projects/proj_1/processed/tool-input/${id}`),{...f.env,...OWNER_ENV})).status).toBe(503);
      const columns=Object.keys(proof);
      f.sqlite.query(`INSERT INTO registered_content_proofs(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(key=>proof[key]));
      const objectKey = (f.sqlite.query(`SELECT project_id || '/' || key || '~' || generation AS object_key FROM blobs WHERE project_id = 'proj_1' AND key = ?`).get(row.key) as { object_key: string }).object_key;
      f.bucket.seed(objectKey, { size: 3, bytes: new TextEncoder().encode('bad') });
      await expect(processedBody(f.serverEnv, { projectId: 'proj_1' }, 'tool-input', id)).rejects.toThrow('event_content_archive_invalid');
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
      expect(f.sqlite.query(`SELECT key FROM registered_content_proofs WHERE source_kind='bundle' AND event_id=?`).all(uuid(402))).toEqual([]);
      expect(f.sqlite.query(`SELECT tool_call_id FROM tool_calls WHERE tool_call_id=?`).all(uuid(402))).toEqual([]);
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
      expect(f.sqlite.query(`SELECT key FROM registered_content_proofs WHERE source_kind='bundle' AND event_id=?`).all(uuid(501))).toEqual([]);
      expect(f.sqlite.query(`SELECT event_id FROM events WHERE event_id=?`).all(uuid(501))).toEqual([]);
    } finally { f.sqlite.close(); }
  });
});
