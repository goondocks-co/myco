import { expect, test } from 'bun:test';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { handleBlob } from '@myco-server-worker/ingest/blobs.js';
import { publishDocuments, PUBLISH_BACKOFF_MIN_MS, PUBLISH_BACKOFF_MAX_MS } from '@myco-server-worker/ingest/publish.js';
import { rereadTranscripts } from '@myco-server-worker/ingest/parse.js';
import { documentPromptTools } from '@myco-server-worker/content/session-turns.js';
import { readPage } from '@myco-server-worker/content/document-reader.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import { envelope, memoryBlobStore, recordingLimiter, uuid } from './helpers/fixtures.js';

const limits = () => ({ calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
const tx = 'tx_' + 'e'.repeat(32);
const codex = JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn' } }) + '\n'
  + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'retained prompt' }] } }) + '\n';

async function queuedTurn(db: RelationalStore) {
  const now = Date.now(), blobs = memoryBlobStore();
  await ensureMember(db, 'member', now, 'member');
  const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, now);
  const env = { ...serverEnvFromBindings({ MYCO_DB: db, BUCKET: blobs, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() }), blobs };
  const bytes = new TextEncoder().encode('retained prompt'), key = await sha256HexOf(bytes);
  const uploaded = await handleBlob(env, new Request('http://127.0.0.1/blobs/' + key, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: bytes }),
    { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, now, clock: () => now, contentLength: bytes.length, params: { key } });
  expect(await uploaded.json()).toMatchObject({ stored: true });
  const ctx = { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now };
  for (const event of [
    envelope({ eventId: uuid(1), sessionId: 'session', kind: 'session.start', payload: { agent: 'claude-code', startedAt: now } }),
    envelope({ eventId: uuid(2), sessionId: 'session', kind: 'prompt', payload: { promptId: uuid(20), blob: key, origin: 'user' } }),
    envelope({ eventId: uuid(3), sessionId: 'session', kind: 'response', payload: { responseId: uuid(30), promptId: uuid(20), text: 'retained reply' } }),
    envelope({ eventId: uuid(4), sessionId: 'session', kind: 'tool.use', payload: { toolCallId: uuid(40), promptId: uuid(20), toolName: 'Read', input: { path: 'x' }, success: true } }),
  ]) expect((await ingestEvent(db, ctx, event, env)).persisted).toBe(true);
  return { now, env, blobs, key, bytes, ctx };
}

test('a transient queued prompt holds its descendants while independent turns publish, then preserves turn ownership', async () => {
  await withDocumentStores(async (db, target) => {
    const { now, env, blobs, key, ctx } = await queuedTurn(db);
    for (const event of [
      envelope({ eventId: uuid(5), sessionId: 'session', kind: 'prompt', payload: { promptId: uuid(21), text: 'independent', origin: 'user' } }),
      envelope({ eventId: uuid(6), sessionId: 'session', kind: 'prompt', payload: { promptId: uuid(22), parentPromptId: uuid(20), text: 'steering', origin: 'user' } }),
      envelope({ eventId: uuid(7), sessionId: 'session', kind: 'response', payload: { responseId: uuid(31), promptId: uuid(21), text: 'independent reply' } }),
      envelope({ eventId: uuid(8), sessionId: 'session', kind: 'response', payload: { responseId: uuid(32), promptId: uuid(22), text: 'steering reply' } }),
    ]) expect((await ingestEvent(db, ctx, event, env)).persisted, target).toBe(true);
    const get = blobs.get.bind(blobs);
    let fail = true;
    blobs.get = async physical => { if (fail && physical.includes(key)) { fail = false; throw new Error('prompt store unavailable'); } return get(physical); };
    await expect(publishDocuments(env, now, limits())).rejects.toThrow('prompt store unavailable');
    expect(await db.prepare(`SELECT prompts,replies,tool_calls FROM session_documents WHERE session_id='session'`).first(), target)
      .toEqual({ prompts: 1, replies: 1, tool_calls: 0 });
    expect(await readPage(env, 'project', 'session', '', 0), target).toBeNull();
    blobs.get = get;
    await publishDocuments(env, now + PUBLISH_BACKOFF_MAX_MS, limits());
    const records = (await readPage(env, 'project', 'session', uuid(20), 0))!;
    expect(records.map(record => record.id).sort(), target).toEqual([20, 22, 30, 32, 40].map(uuid).sort());
    const tools = await documentPromptTools(env, { projectId: 'project' }, 'session', uuid(20), undefined);
    if (tools === null || tools === 'stale') throw new Error('published turn missing');
    expect(tools.rows.map(row => row.toolCallId), target).toEqual([uuid(40)]);
    expect(await db.prepare(`SELECT COUNT(*) n FROM publish_queue`).first(), target).toEqual({ n: 0 });
    expect(await readPage(env, 'project', 'session', '', 0), target).toBeNull();
  });
});

test('repeating transcript store failures retain the frontier backoff after their publication outcome commits', async () => {
  await withDocumentStores(async (db, target) => {
    const now = Date.now(), blobs = memoryBlobStore();
    const env = await captureDocumentTranscript(db, blobs, 'session', tx, codex, now, 0, 'codex');
    const key = await sha256HexOf(new TextEncoder().encode(codex)), get = blobs.get.bind(blobs);
    blobs.get = async physical => { if (physical.includes(key)) throw new Error('content_archive_missing'); return get(physical); };
    let at = now;
    for (const expected of [PUBLISH_BACKOFF_MIN_MS, PUBLISH_BACKOFF_MAX_MS, PUBLISH_BACKOFF_MAX_MS]) {
      await publishDocuments(env, at, limits());
      const row = (await db.prepare(`SELECT due_at FROM session_documents WHERE session_id='session'`).first<{ due_at: number }>())!;
      expect(row.due_at - at, target).toBe(expected);
      at = row.due_at + 60 * 60_000;
    }
  });
});

test('reread repairs an incomplete retained frontier without replacing a valid identity policy', async () => {
  await withDocumentStores(async (db, target) => {
    const now = Date.now(), blobs = memoryBlobStore();
    const env = await captureDocumentTranscript(db, blobs, 'session', tx, codex, now, 0, 'codex');
    await rereadTranscripts(db, { projectId: 'project', sessionId: 'session' });
    await db.prepare(`UPDATE transcript_publication SET prompt_scheme=NULL WHERE transcript_id=?`).bind(tx).run();
    await rereadTranscripts(db, { projectId: 'project', sessionId: 'session' });
    await publishDocuments(env, now, limits());
    expect(await db.prepare(`SELECT prompt_scheme,published_offset,state FROM transcript_publication WHERE transcript_id=?`).bind(tx).first(), target)
      .toEqual({ prompt_scheme: 'codex-turn-v1', published_offset: codex.length, state: 'active' });
    expect(await db.prepare(`SELECT prompts FROM session_documents WHERE session_id='session'`).first(), target).toEqual({ prompts: 1 });
  });
});

test('undecodable bytes with the wrong registered digest remain retryable and publish after storage recovers', async () => {
  await withDocumentStores(async (db, target) => {
    const { now, env, blobs, key, bytes } = await queuedTurn(db), get = blobs.get.bind(blobs);
    blobs.get = async physical => {
      const object = await get(physical);
      return object === null || !physical.includes(key) ? object : { ...object, body: new Blob([new Uint8Array(bytes.length).fill(255)]).stream() };
    };
    await publishDocuments(env, now, limits());
    expect(await db.prepare(`SELECT failure FROM publish_queue WHERE event_id=?`).bind(uuid(2)).first(), target).toEqual({ failure: null });
    expect(await db.prepare(`SELECT retry_at>? waiting FROM publish_queue WHERE event_id=?`).bind(now, uuid(2)).first(), target).toEqual({ waiting: 1 });
    blobs.get = get;
    await publishDocuments(env, now + PUBLISH_BACKOFF_MAX_MS, limits());
    expect((await readPage(env, 'project', 'session', uuid(20), 0))!.map(record => record.k), target).toEqual(['prompt', 'reply', 'tool']);
  });
});

test('a failed publication deferral surfaces its persistence error and preserves captured records', async () => {
  await withDocumentStores(async (db, target) => {
    const { now, env, blobs } = await queuedTurn(db);
    const fail = (statement: PreparedStatement): PreparedStatement => ({ ...statement,
      bind: (...params) => fail(statement.bind(...params)), run: async () => { throw new Error('deferral persistence unavailable'); },
    });
    const faulty: RelationalStore = { prepare: sql => sql.startsWith('UPDATE session_documents SET due_at=') ? fail(db.prepare(sql)) : db.prepare(sql),
      batch: statements => db.batch(statements) };
    blobs.failNextPut = 'chunk commit unavailable';
    await expect(publishDocuments({ ...env, db: faulty }, now, limits())).rejects.toThrow('deferral persistence unavailable');
    expect(await db.prepare(`SELECT COUNT(*) n FROM publish_queue`).first(), target).toEqual({ n: 3 });
    expect(await db.prepare(`SELECT COUNT(*) n FROM session_chunks`).first(), target).toEqual({ n: 0 });
  });
});
