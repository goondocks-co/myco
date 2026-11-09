/**
 * Publication dependencies: a child waits for its prerequisite in a typed row, a settled prerequisite wakes exactly its
 * dependents, the cycle job reports a cycle, and held retry causes translate through catch-up.
 */
import { expect, test } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { catchUpPhase } from '@myco-server-worker/db/projections/catchup.js';
import { readDocumentStatus } from '@myco-server-worker/db/documents/status.js';
import { continueWakeStatement, DEPENDENCY_PHASE, DEPENDENCY_WAKE_PAGE, inspectPublicationCycles, wakeDependentsStatement } from '@myco-server-worker/db/documents/dependencies.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from './helpers/member-token.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { handleBlob } from '@myco-server-worker/ingest/blobs.js';
import { publishDocuments, PUBLISH_BACKOFF_MAX_MS } from '@myco-server-worker/ingest/publish.js';
import { readPage } from '@myco-server-worker/content/document-reader.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { envelope, memoryBlobStore, recordingLimiter, uuid } from './helpers/fixtures.js';

const limits = () => ({ calls: 500, deadline: Date.now() + 60_000, clock: Date.now });

async function rig(db: RelationalStore) {
  const now = Date.now(), blobs = memoryBlobStore();
  await ensureMember(db, 'member', now, 'member');
  const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, now);
  const env = { ...serverEnvFromBindings({ MYCO_DB: db, BUCKET: blobs, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() }), blobs };
  const ctx = { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now };
  const upload = async (text: string) => {
    const bytes = new TextEncoder().encode(text), key = await sha256HexOf(bytes);
    const answer = await handleBlob(env, new Request('http://127.0.0.1/blobs/' + key, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: bytes }),
      { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, now, clock: () => now, contentLength: bytes.length, params: { key } });
    expect(await answer.json()).toMatchObject({ stored: true });
    return key;
  };
  const send = async (event: Parameters<typeof envelope>[0]) => expect((await ingestEvent(db, ctx, envelope(event), env)).persisted).toBe(true);
  return { now, blobs, env, ctx, upload, send };
}

const dependencies = (db: RelationalStore) => db.prepare(`SELECT child_event_id,prerequisite_kind,prerequisite_id,holder_event_id,outcome FROM publication_dependencies ORDER BY child_event_id`).all();

test('a child waits behind a queued prerequisite and only its own holder settling wakes it', async () => {
  await withDocumentStores(async (db, target) => {
    const { now, blobs, env, upload, send } = await rig(db);
    const [one, two] = [await upload('first prompt body'), await upload('second prompt body')];
    await send({ eventId: uuid(1), sessionId: 'session', kind: 'session.start', payload: { agent: 'claude-code', startedAt: now } });
    await send({ eventId: uuid(2), sessionId: 'session', kind: 'prompt', createdAt: now + 1, payload: { promptId: uuid(20), blob: one, origin: 'user' } });
    await send({ eventId: uuid(3), sessionId: 'session', kind: 'response', createdAt: now + 2, payload: { responseId: uuid(30), promptId: uuid(20), text: 'first reply' } });
    await send({ eventId: uuid(4), sessionId: 'session', kind: 'prompt', createdAt: now + 3, payload: { promptId: uuid(21), blob: two, origin: 'user' } });
    await send({ eventId: uuid(5), sessionId: 'session', kind: 'response', createdAt: now + 4, payload: { responseId: uuid(31), promptId: uuid(21), text: 'second reply' } });
    const get = blobs.get.bind(blobs), held = new Set([one, two]);
    blobs.get = async physical => { if ([...held].some(key => physical.includes(key))) throw new Error('prompt store unavailable'); return get(physical); };
    await publishDocuments(env, now, limits()).catch(() => undefined);
    expect((await dependencies(db)).results, target).toEqual([
      { child_event_id: uuid(2), prerequisite_kind: 'read', prerequisite_id: '', holder_event_id: null, outcome: 'waiting' },
      { child_event_id: uuid(3), prerequisite_kind: 'prompt', prerequisite_id: uuid(20), holder_event_id: uuid(2), outcome: 'waiting' },
      { child_event_id: uuid(4), prerequisite_kind: 'read', prerequisite_id: '', holder_event_id: null, outcome: 'waiting' },
      { child_event_id: uuid(5), prerequisite_kind: 'prompt', prerequisite_id: uuid(21), holder_event_id: uuid(4), outcome: 'waiting' },
    ]);
    await db.prepare(`UPDATE publish_queue SET retry_at=? WHERE event_id=?`).bind(now + 10 * PUBLISH_BACKOFF_MAX_MS, uuid(3)).run();
    held.delete(one);
    await publishDocuments(env, now + 2 * PUBLISH_BACKOFF_MAX_MS, limits()).catch(() => undefined);
    expect(await db.prepare(`SELECT retry_at FROM publish_queue WHERE event_id=?`).bind(uuid(3)).first(), target).toEqual({ retry_at: 0 });
    expect((await db.prepare(`SELECT retry_at FROM publish_queue WHERE event_id=?`).bind(uuid(5)).first<{ retry_at: number }>())!.retry_at, target).toBeGreaterThan(0);
    expect((await dependencies(db)).results.map(row => row.child_event_id), target).toEqual([uuid(4), uuid(5)]);
    held.delete(two);
    for (let pass = 0; pass < 3; pass++) await publishDocuments(env, now + (3 + pass) * PUBLISH_BACKOFF_MAX_MS, limits());
    expect((await readPage(env, 'project', 'session', uuid(21), 0))!.map(record => record.id), target).toContain(uuid(31));
    expect((await dependencies(db)).results, target).toEqual([]);
  });
});

test('a session with untranslated held causes waits for its translation, other sessions keep publishing, and order holds when it finishes', async () => {
  await withDocumentStores(async (db, target) => {
    const { now, blobs, env, upload, send } = await rig(db);
    const blob = await upload('unavailable earlier prompt');
    await send({ eventId: uuid(101), sessionId: 'building', kind: 'session.start', createdAt: 100, payload: { agent: 'claude-code', startedAt: 100 } });
    await send({ eventId: uuid(102), sessionId: 'building', kind: 'prompt', createdAt: 200, payload: { promptId: uuid(120), blob, origin: 'user' } });
    const get = blobs.get.bind(blobs);
    let offline = true;
    blobs.get = async key => { if (offline && key.includes(blob)) throw new Error('store offline'); return get(key); };
    await publishDocuments(env, now, limits()).catch(() => undefined);
    await db.batch([db.prepare('DELETE FROM publication_dependencies'),
      db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='publication_dependencies'")]);
    await send({ eventId: uuid(103), sessionId: 'building', kind: 'prompt', createdAt: 300, payload: { promptId: uuid(121), text: 'later prompt', origin: 'user' } });
    await send({ eventId: uuid(104), sessionId: 'moving', kind: 'session.start', createdAt: 100, payload: { agent: 'claude-code', startedAt: 100 } });
    await send({ eventId: uuid(105), sessionId: 'moving', kind: 'prompt', createdAt: 200, payload: { promptId: uuid(122), text: 'other session', origin: 'user' } });

    await publishDocuments(env, now + 1, limits());
    expect((await db.prepare(`SELECT prompts FROM session_documents WHERE session_id='moving'`).first<{ prompts: number }>())!.prompts, target).toBe(1);
    expect((await db.prepare(`SELECT prompt_id FROM session_prompts WHERE session_id='building'`).all()).results, target).toEqual([]);
    expect((await db.prepare(`SELECT due_at FROM session_documents WHERE session_id='building'`).first<{ due_at: number }>())!.due_at, target).toBeGreaterThan(now);

    while (await catchUpPhase(db, DEPENDENCY_PHASE as never) > 0);
    expect((await db.prepare(`SELECT due_at FROM session_documents WHERE session_id='building'`).first<{ due_at: number }>())!.due_at, target).toBe(0);
    await publishDocuments(env, now + 2, limits());
    expect((await db.prepare(`SELECT prompt_id FROM session_prompts WHERE session_id='building'`).all()).results, target).toEqual([]);
    offline = false;
    for (let pass = 0; pass < 4; pass++) await publishDocuments(env, now + (3 + pass) * PUBLISH_BACKOFF_MAX_MS, limits());
    expect((await db.prepare(`SELECT prompt_id,ord FROM session_prompts WHERE session_id='building' ORDER BY ord`).all()).results, target)
      .toEqual([{ prompt_id: uuid(120), ord: 0 }, { prompt_id: uuid(121), ord: 1 }]);
    expect(await db.prepare(`SELECT COUNT(*) n FROM publish_queue WHERE session_id='building'`).first(), target).toEqual({ n: 0 });
  });
});

test('the cycle job reports a closed wait, frees it to publish, and leaves a long chain pending', async () => {
  await withDocumentStores(async (db, target) => {
    const { now, env, send } = await rig(db);
    await send({ eventId: uuid(1), sessionId: 'cycle', kind: 'session.start', payload: { agent: 'claude-code', startedAt: now } });
    await send({ eventId: uuid(2), sessionId: 'cycle', kind: 'prompt', payload: { promptId: uuid(20), parentPromptId: uuid(21), text: 'a', origin: 'user' } });
    await send({ eventId: uuid(3), sessionId: 'cycle', kind: 'prompt', payload: { promptId: uuid(21), parentPromptId: uuid(20), text: 'b', origin: 'user' } });
    await db.prepare(`INSERT INTO publish_queue(project_id,session_id,rank,created_at,event_id,retry_at,retry_cause) VALUES('project','filler',0,1,'filler',0,NULL) ON CONFLICT DO NOTHING`).run();
    await db.prepare(`UPDATE publish_queue SET retry_at=0,retry_cause=NULL WHERE session_id='filler'`).run();
    await publishDocuments(env, now, limits());
    const held = (await dependencies(db)).results;
    expect(held.map(row => row.prerequisite_kind), target).toEqual(['prompt', 'prompt']);
    expect((await inspectPublicationCycles(db, now)).changed, target).toBeGreaterThan(0);
    expect((await dependencies(db)).results.map(row => row.outcome), target).toEqual(['cycle', 'cycle']);
    expect(await readDocumentStatus(db), target).toMatchObject({ dependencies: { waiting: 0, inspecting: 0, cycles: 2 } });
    for (let pass = 0; pass < 2; pass++) await publishDocuments(env, now, limits());
    expect((await dependencies(db)).results, target).toEqual([]);
    expect(await db.prepare(`SELECT prompts FROM session_documents WHERE session_id='cycle'`).first(), target).toEqual({ prompts: 2 });

    // A chain longer than one walk checkpoints, keeps its inspection pending, and settles with no false cycle.
    const edges = Array.from({ length: 150 }, (_, i) => db.prepare(`INSERT INTO publication_dependencies(project_id,session_id,child_event_id,child_rank,child_created_at,prerequisite_kind,prerequisite_id,holder_event_id,inspect_due)
      VALUES('project','chain',?,0,?,'prompt',?,?,?)`).bind(`node-${i}`, i, `prompt-${i + 1}`, i === 149 ? null : `node-${i + 1}`, i === 0 ? now : null));
    await db.batch(edges);
    const first = await inspectPublicationCycles(db, now);
    expect(first.more, target).toBe(true);
    expect(await db.prepare(`SELECT inspect_hops,inspect_after FROM publication_dependencies WHERE child_event_id='node-0'`).first(), target).toEqual({ inspect_hops: 64, inspect_after: 'node-65' });
    expect(await readDocumentStatus(db), target).toMatchObject({ dependencies: { inspecting: 1 } });
    await inspectPublicationCycles(db, now);
    await inspectPublicationCycles(db, now);
    expect(await db.prepare(`SELECT outcome,inspect_due FROM publication_dependencies WHERE child_event_id='node-0'`).first(), target).toEqual({ outcome: 'waiting', inspect_due: null });
  });
});

test('a holder with more dependents than one page wakes them across commits', async () => {
  await withDocumentStores(async (db, target) => {
    const rows = Array.from({ length: DEPENDENCY_WAKE_PAGE + 5 }, (_, i) => db.prepare(`INSERT INTO publication_dependencies(project_id,session_id,child_event_id,child_rank,child_created_at,prerequisite_kind,prerequisite_id,holder_event_id)
      VALUES('project','s',?,0,?,'prompt','p','holder')`).bind(`child-${i}`, i));
    await db.batch(rows);
    await db.prepare(`INSERT INTO session_documents(project_id,session_id,state,generation,updated_at,due_at) VALUES('project','s','live',1,1,NULL)`).run();
    const holders = JSON.stringify(['holder']);
    await db.batch([wakeDependentsStatement(db, 'project', 's', holders), continueWakeStatement(db, 'project', 's', holders)]);
    expect(await db.prepare(`SELECT COUNT(*) n FROM publication_dependencies`).first(), target).toEqual({ n: 5 });
    expect(await db.prepare(`SELECT publication_wake,due_at FROM session_documents WHERE session_id='s'`).first(), target).toEqual({ publication_wake: holders, due_at: 0 });
    await db.batch([wakeDependentsStatement(db, 'project', 's', holders), continueWakeStatement(db, 'project', 's', holders)]);
    expect(await db.prepare(`SELECT COUNT(*) n FROM publication_dependencies`).first(), target).toEqual({ n: 0 });
    expect(await db.prepare(`SELECT publication_wake FROM session_documents WHERE session_id='s'`).first(), target).toEqual({ publication_wake: null });
  });
});

test('held retry causes translate to typed rows, keeping the source id when a prompt cannot be named, and status reports building until done', async () => {
  await withDocumentStores(async (db, target) => {
    const { now, send } = await rig(db);
    await send({ eventId: uuid(1), sessionId: 'old', kind: 'session.start', payload: { agent: 'claude-code', startedAt: now } });
    await send({ eventId: uuid(2), sessionId: 'old', kind: 'response', payload: { responseId: uuid(30), promptId: uuid(20), text: 'held reply' } });
    await send({ eventId: uuid(3), sessionId: 'old', kind: 'prompt', payload: { promptId: uuid(31), text: 'unreadable', origin: 'user' } });
    await db.batch([
      db.prepare(`UPDATE publish_queue SET retry_at=?,retry_cause=json_object('kind','prompt','eventId','holder-event') WHERE event_id=?`).bind(now, uuid(2)),
      db.prepare(`UPDATE publish_queue SET retry_at=?,retry_cause=json_object('kind','read','parentId',NULL) WHERE event_id=?`).bind(now, uuid(3)),
      db.prepare(`UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='publication_dependencies'`),
    ]);
    expect(await readDocumentStatus(db), target).toMatchObject({ dependencies: { state: 'building' } });
    await catchUpPhase(db, DEPENDENCY_PHASE as never);
    expect((await dependencies(db)).results, target).toEqual([
      { child_event_id: uuid(2), prerequisite_kind: 'prompt', prerequisite_id: uuid(20), holder_event_id: 'holder-event', outcome: 'waiting' },
      { child_event_id: uuid(3), prerequisite_kind: 'read', prerequisite_id: '', holder_event_id: null, outcome: 'waiting' },
    ]);
    expect(await readDocumentStatus(db), target).toMatchObject({ dependencies: { waiting: 2 } });
  });
});
