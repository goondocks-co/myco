import { expect, test } from 'bun:test';
import type { ContentStore } from '@myco-server-worker/core/adapters.js';
import { DocumentBatch, directoryStatements, type BatchDocument } from '@myco-server-worker/ingest/document-batch.js';
import { publishDocuments, PUBLISH_BACKOFF_MIN_MS } from '@myco-server-worker/ingest/publish.js';
import { rereadTranscripts } from '@myco-server-worker/ingest/parse.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { handleBlob } from '@myco-server-worker/ingest/blobs.js';
import { documentRecord } from '@myco-server-worker/content/document-records.js';
import { assertSessionMaterialReady } from '@myco-server-worker/read/material-readiness.js';
import { readDocumentStatus } from '@myco-server-worker/read/document-status.js';
import { documentBody } from '@myco-server-worker/content/session-pages.js';
import { documentPromptTools } from '@myco-server-worker/content/session-turns.js';
import { readPage, type ChunkRow, type PageRow } from '@myco-server-worker/content/document-reader.js';
import type { DocRecord } from '@myco-server-worker/content/document.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { prepareDerivedStream } from '@myco-server-worker/core/registered-content.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { captureDocumentSession, captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import worker from '@myco-server-worker/index.js';
import { asOwner, LINKED_SUB, OWNER_ENV } from './helpers/owner.js';
import { envelope, memoryBlobStore, recordingLimiter, uuid } from './helpers/fixtures.js';

const limits = () => ({ calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
const tx = 'tx_' + 'd'.repeat(32);
const codex = JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn' } }) + '\n'
  + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'retained prompt' }] } }) + '\n';

async function place(env: ContentStore, records: DocRecord[]) {
  const { db } = env;
  const [docs, chunks, pages] = await db.batch([
    db.prepare(`SELECT d.generation,d.next_chunk,d.prompts,d.first_prompt,d.open_turn_key,s.created_by_token_id token_id
      FROM session_documents d JOIN sessions s ON s.project_id=d.project_id AND s.session_id=d.session_id
      WHERE d.project_id='project' AND d.session_id='session'`),
    ...directoryStatements(db, 'project', 'session'),
  ]);
  const batch = new DocumentBatch(env, 'project', 'session', docs!.results[0] as BatchDocument, chunks!.results as ChunkRow[], pages!.results as PageRow[]);
  await batch.open();
  await batch.place(records, null);
  await batch.commit(true, 'live', Date.now(), () => ({ sql: '1', params: [] }), () => {
    const set = batch.documentSet(Date.now());
    return { before: [], after: [db.prepare(`UPDATE session_documents SET ${set.sql} WHERE project_id='project' AND session_id='session'`).bind(...set.params)] };
  });
}

test('a locator issued before a tool moves refuses stale location and a fresh locator reads its retained input', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), env = { db, blobs };
    await captureDocumentSession(db, 'project', 'session', { blobs });
    await publishDocuments(env, Date.now(), limits());
    await db.prepare(`UPDATE members SET github_id=? WHERE id='member'`).bind(LINKED_SUB).run();
    const bindings = { MYCO_DB: db, BUCKET: blobs, ...OWNER_ENV, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() };
    const input = 'i'.repeat(240_000);
    const tool = documentRecord('tool.use', { toolCallId: uuid(801), promptId: uuid(20), toolName: 'shell', input, success: true }, 1,
      { ev: uuid(802), received_at: 1, outcome: { ordinal: 0, offset: 0, origin: 'reported' } })!;
    const filler: DocRecord = { k: 'reply', id: uuid(803), prompt_id: uuid(20), created_at: 1, text: 'f'.repeat(20_000) };
    await place(env, [tool, filler]);
    const tools = await documentPromptTools(env, { projectId: 'project' }, 'session', uuid(20), undefined);
    if (tools === null || tools === 'stale') throw new Error('missing tools');
    const old = tools.rows.find(row => row.toolCallId === tool.id)!.locator;
    expect(old.revision, target).toEqual(expect.any(String));
    const fetchBody = async (at: typeof old) => {
      const query = new URLSearchParams({ session: 'session', generation: String(at.generation), owner: at.owner, page: String(at.page), revision: at.revision! });
      return worker.fetch(await asOwner(db, `/api/projects/project/processed/tool-input/${tool.id}?${query}`), bindings);
    };
    expect(await (await fetchBody(old)).text(), target).toBe(input);
    await place(env, [{ k: 'reply', id: uuid(804), prompt_id: uuid(20), created_at: 2, text: 'unrelated reply' }]);
    expect(await (await fetchBody(old)).text(), target).toBe(input);
    await place(env, [{ ...tool, output_preview: 'o'.repeat(4096), outcome_source: { ordinal: 0, offset: 1, origin: 'reported' } }]);
    const fresh = await documentPromptTools(env, { projectId: 'project' }, 'session', uuid(20), undefined);
    if (fresh === null || fresh === 'stale') throw new Error('missing tools');
    const current = fresh.rows.find(row => row.toolCallId === tool.id)!.locator;
    expect(current.generation, target).toBe(old.generation);
    expect(current.page, target).not.toBe(old.page);
    expect(current.revision, target).not.toBe(old.revision);
    expect(await documentBody(env, 'project', 'session', 'tool-input', tool.id, { ...current, revision: old.revision }), target).toBe(input);
    const stale = await fetchBody(old);
    expect(stale.status, target).toBe(409);
    expect(await stale.json(), target).toEqual({ error: 'stale_cursor' });
    expect(await documentBody(env, 'project', 'session', 'tool-input', tool.id, old), target).toBe('stale');
    expect(await documentBody(env, 'project', 'session', 'tool-input', tool.id, current), target).toBe(input);
    expect(await (await fetchBody(current)).text(), target).toBe(input);
    expect(await documentBody(env, 'project', 'session', 'tool-input', 'absent', current), target).toBeNull();
  });
});

test('reread before first publication initializes policy once and retains it on later rereads', async () => {
  await withDocumentStores(async (db, target) => {
    const now = Date.now(), blobs = memoryBlobStore();
    const env = await captureDocumentTranscript(db, blobs, 'session', tx, codex, now, 0, 'codex');
    for (let pass = 0; pass < 2; pass += 1) {
      expect(await rereadTranscripts(db, { projectId: 'project', sessionId: 'session' }), target).toBe(1);
      await publishDocuments(env, now + pass, limits());
      expect(await db.prepare(`SELECT published_offset,prompt_scheme,record_scheme,state FROM transcript_publication WHERE transcript_id=?`).bind(tx).first(), target)
        .toEqual({ published_offset: codex.length, prompt_scheme: 'codex-turn-v1', record_scheme: 'source-record-v1', state: 'active' });
      expect(await db.prepare(`SELECT prompts FROM session_documents WHERE session_id='session'`).first(), target).toEqual({ prompts: 1 });
    }
  });
});

test('a prose parser failure settles scheduling and lets later due sessions publish', async () => {
  await withDocumentStores(async (db, target) => {
    const now = Date.now(), blobs = memoryBlobStore();
    const env = await captureDocumentTranscript(db, blobs, 'broken', tx, JSON.stringify({ v: 999, type: 'prompt', text: 'future format' }) + '\n', now, 0, 'opencode');
    await publishDocuments(env, now, limits());
    expect(await db.prepare(`SELECT state,failure FROM transcript_publication WHERE transcript_id=?`).bind(tx).first(), target)
      .toEqual({ state: 'failed', failure: 'format_unsupported' });
    const due = await db.prepare(`SELECT due_at FROM session_documents WHERE session_id='broken'`).first<{ due_at: number }>();
    expect(due!.due_at, target).toBeNull();
    await captureDocumentSession(db, 'project', 'broken', { blobs });
    blobs.failNextPut = 'prose store unavailable';
    await expect(publishDocuments(env, now + 1, limits())).rejects.toThrow('prose store unavailable');
    const retry = (await db.prepare(`SELECT due_at FROM session_documents WHERE session_id='broken'`).first<{ due_at: number }>())!.due_at;
    expect(retry, target).toBeGreaterThanOrEqual(now + 1 + PUBLISH_BACKOFF_MIN_MS);
    await captureDocumentSession(db, 'project', 'healthy', { blobs, idOffset: 1000 });
    await publishDocuments(env, now + 2, limits());
    expect(await db.prepare(`SELECT prompts FROM session_documents WHERE session_id='healthy'`).first(), target).toEqual({ prompts: 1 });
    expect(await db.prepare(`SELECT prompts,due_at FROM session_documents WHERE session_id='broken'`).first(), target).toEqual({ prompts: 0, due_at: retry });
    await publishDocuments(env, retry, limits());
    expect(await db.prepare(`SELECT prompts FROM session_documents WHERE session_id='broken'`).first(), target).toEqual({ prompts: 1 });
  });
});

test('referenced document text is admitted as UTF-8 for every text-bearing kind', async () => {
  await withDocumentStores(async (db, target) => {
    const now = Date.now(), blobs = memoryBlobStore();
    const env = await captureDocumentTranscript(db, blobs, 'session', tx, codex, now, 0, 'codex');
    const token = await db.prepare(`SELECT created_by_token_id tokenId FROM sessions WHERE session_id='session'`).first<{ tokenId: string }>();
    const bytes = new Uint8Array([0xff]), key = await sha256HexOf(bytes);
    const uploaded = await handleBlob(env, new Request('http://127.0.0.1/blobs/' + key, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes }),
      { projectId: 'project', machineId: 'machine', tokenId: token!.tokenId, now, clock: () => now, contentLength: bytes.length, params: { key } });
    expect(await uploaded.json(), target).toMatchObject({ stored: true });
    const payloads = [
      ['prompt', { promptId: uuid(901), blob: key, origin: 'user' }],
      ['response', { responseId: uuid(902), blob: key }],
      ['plan', { planKey: uuid(903), blob: key }],
      ['tool.use', { toolCallId: uuid(904), toolName: 'shell', blob: key, success: true }],
      ['tool.failure', { toolCallId: uuid(905), toolName: 'shell', outputBlob: key, success: false }],
    ] as const;
    for (const [kind, payload] of payloads) {
      const result = await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: token!.tokenId, bodyBytes: 1, now },
        envelope({ eventId: crypto.randomUUID(), sessionId: 'session', kind, payload }), env);
      expect(result, target + ' ' + kind).toMatchObject({ persisted: false, code: 'invalid_field' });
    }
    expect(await db.prepare(`SELECT COUNT(*) n FROM publish_queue`).first(), target).toEqual({ n: 0 });
    const valid = await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: token!.tokenId, bodyBytes: 1, now },
      envelope({ eventId: uuid(910), sessionId: 'session', kind: 'prompt', payload: { promptId: uuid(911), blob: await sha256HexOf(new TextEncoder().encode(codex)), origin: 'user' } }), env);
    expect(valid, target).toMatchObject({ persisted: true });
  });
});

test('retained invalid text is held per event while transient reads retry and later content publishes', async () => {
  await withDocumentStores(async (db, target) => {
    const now = Date.now(), blobs = memoryBlobStore(), env = { db, blobs };
    const issued = await captureDocumentSession(db, 'project', 'session', { blobs });
    const bytes = new Uint8Array([0xff]), key = await sha256HexOf(bytes);
    const source = crypto.randomUUID();
    const registered = await prepareDerivedStream(env, { projectId: 'project', sessionId: 'session', tokenId: issued.tokenId, sourceKind: 'event', eventId: source, resourceId: source, envelopeHash: source },
      { size: bytes.length, digest: key, stream: () => new Blob([bytes]).stream() }, now);
    const payload = JSON.stringify({ promptId: uuid(20), blob: key, origin: 'user' });
    await db.prepare(`UPDATE events SET payload=? WHERE event_id=?`).bind(payload, uuid(2)).run();
    const original = await db.prepare(`SELECT payload,envelope_hash FROM events WHERE event_id=?`).bind(uuid(2)).first();
    const get = blobs.get.bind(blobs);
    const physical = blobObjectKey('project', key, registered.generation);
    blobs.get = async (key) => { if (key === physical) throw new Error('temporarily unavailable'); return get(key); };
    await expect(publishDocuments(env, now, limits())).rejects.toThrow('temporarily unavailable');
    expect(await db.prepare(`SELECT COUNT(*) n FROM publish_queue`).first(), target).toEqual({ n: 2 });
    expect((await db.prepare(`SELECT due_at FROM session_documents WHERE session_id='session'`).first<{ due_at: number }>())!.due_at, target)
      .toBeGreaterThanOrEqual(now + PUBLISH_BACKOFF_MIN_MS);
    expect(await db.prepare(`SELECT replies FROM session_documents WHERE session_id='session'`).first(), target).toEqual({ replies: 0 });
    blobs.get = get;
    await publishDocuments(env, now + 60 * 60_000, limits());
    expect(await db.prepare(`SELECT replies FROM session_documents WHERE session_id='session'`).first(), target).toEqual({ replies: 1 });
    expect(await db.prepare(`SELECT event_id,failure FROM publish_queue`).all().then(r => r.results), target)
      .toEqual([{ event_id: uuid(2), failure: 'content_text_invalid' }]);
    expect(await db.prepare(`SELECT payload,envelope_hash FROM events WHERE event_id=?`).bind(uuid(2)).first(), target).toEqual(original);
    expect((await readPage(env, 'project', 'session', '', 0))!.map(record => record.k), target).toContain('reply');
    expect(await db.prepare(`SELECT replies,tool_calls,plans,due_at FROM session_documents WHERE session_id='session'`).first(), target)
      .toEqual({ replies: 1, tool_calls: 1, plans: 1, due_at: null });
    expect(await blobs.get(blobObjectKey('project', key, registered.generation)), target).not.toBeNull();
    await assertSessionMaterialReady(db, 'project', 'session');
    expect((await readDocumentStatus(db)).queued, target).toBe(0);
  });
});
