import { expect, test } from 'bun:test';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { parseDiagnostic, rereadTranscripts } from '@myco-server-worker/ingest/parse.js';
import { getSession } from '@myco-server-worker/read/sessions.js';
import { PARSER_VERSION } from '@myco-server-worker/constants.js';
import { admittedDocumentEvent, RecordRefused } from '@myco-server-worker/ingest/document-admission.js';
import { captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { limits, MIN, one, reply, user } from './helpers/document-publication.js';

test.each([
  { subreason: 'kind_unsupported', kind: 'unsupported', payload: {} },
  { subreason: 'inline_body_required', kind: 'prompt', payload: { blob: 'body' } },
  { subreason: 'unpaired_surrogate', kind: 'prompt', payload: { promptId: '00000000-0000-4000-8000-000000000001', origin: 'user', text: '\ud800' } },
])('admission exposes the $subreason code independently of its message', ({ subreason, kind, payload }) => {
  let failure: unknown;
  try { admittedDocumentEvent({ kind, payload, createdAt: 1, offset: 0 }, 1); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(RecordRefused);
  expect(failure).toMatchObject({ subreason });
});

test.each(['session', 'agent'] as const)('a %s reread during a held directory cursor publishes every retained transcript', async selector => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), at = Date.now() - 60 * MIN;
    const ids = Array.from({ length: 40 }, (_, i) => `tx_${String(i).padStart(32, '0')}`);
    const bodies = ids.map((_, i) => user(`turn-${i}`, `prompt ${i}`) + reply(`reply ${i}`));
    let env = await captureDocumentTranscript(db, blobs, 'session', ids[0]!, bodies[0]!, at, 0, 'codex');
    for (let i = 1; i < ids.length; i += 1) env = await captureDocumentTranscript(db, blobs, 'session', ids[i]!, bodies[i]!, at + i, 0, 'codex');
    const sources = (await db.prepare('SELECT * FROM transcripts ORDER BY transcript_id').all()).results;
    const segments = (await db.prepare('SELECT * FROM transcript_segments ORDER BY transcript_id,base_offset').all()).results;
    expect((await publishDocuments(env, at + 20 * MIN, { ...limits(), calls: 35 })).more, target).toBe(true);
    expect((await one(db, 'SELECT publication_after FROM session_documents'))!.publication_after, target).not.toBeNull();
    const prompts = (await db.prepare('SELECT prompt_id,preview FROM session_prompts ORDER BY prompt_id').all()).results;
    expect(await rereadTranscripts(db, selector === 'agent' ? { agent: 'codex' } : { projectId: 'project', sessionId: 'session' }), target).toBe(ids.length);
    for (let pass = 0; ; pass += 1) {
      expect(pass, target).toBeLessThan(40);
      if (!(await publishDocuments(env, at + 20 * MIN, { ...limits(), calls: 35 })).more) break;
    }
    expect(await one(db, `SELECT COUNT(*) n FROM transcripts t JOIN transcript_publication p USING(project_id,transcript_id)
      WHERE p.published_offset=t.size AND p.parser_version=${PARSER_VERSION} AND p.generation=1`), target).toEqual({ n: ids.length });
    expect(await one(db, 'SELECT prompts,replies,due_at FROM session_documents'), target).toEqual({ prompts: 40, replies: 40, due_at: null });
    expect((await db.prepare('SELECT prompt_id,preview FROM session_prompts ORDER BY prompt_id').all()).results, target).toEqual(expect.arrayContaining(prompts));
    expect((await db.prepare('SELECT * FROM transcripts ORDER BY transcript_id').all()).results, target).toEqual(sources);
    expect((await db.prepare('SELECT * FROM transcript_segments ORDER BY transcript_id,base_offset').all()).results, target).toEqual(segments);
  });
});

test('input arriving during a publication read keeps its valid prefix and leaves the new input due', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), at = Date.now() - 60 * MIN;
    const id = 'tx_abcdef0123456789abcdef0123456789';
    const first = user('first', 'first prompt') + reply('first reply');
    const env = await captureDocumentTranscript(db, blobs, 'session', id, first, at, 0, 'codex');
    const get = blobs.get.bind(blobs);
    let append = true;
    blobs.get = async (...args) => {
      if (append) {
        append = false;
        await captureDocumentTranscript(db, blobs, 'session', id, user('second', 'second prompt') + reply('second reply'), at + MIN, first.length, 'codex');
      }
      return get(...args);
    };
    await publishDocuments(env, at + 20 * MIN, limits());
    expect(await one(db, 'SELECT due_at FROM session_documents'), target).toEqual({ due_at: 0 });
    expect(Number((await one(db, 'SELECT published_offset FROM transcript_publication'))!.published_offset), target).toBeGreaterThanOrEqual(first.length);
    const held = (await db.prepare('SELECT prompt_id,preview FROM session_prompts').all()).results;
    await publishDocuments(env, at + 21 * MIN, limits());
    expect(await one(db, 'SELECT prompts,replies,due_at FROM session_documents'), target).toEqual({ prompts: 2, replies: 2, due_at: null });
    expect((await db.prepare('SELECT prompt_id,preview FROM session_prompts').all()).results, target).toEqual(expect.arrayContaining(held));
  });
});

test('bounded directory passes reach later transcripts and revisit earlier input without changing stored identities', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), at = Date.now() - 60 * MIN;
    const ids = Array.from({ length: 40 }, (_, i) => `tx_${String(i).padStart(32, '0')}`);
    const bodies = ids.map((_, i) => user(`turn-${i}`, `prompt ${i}`) + reply(`reply ${i}`));
    let env = await captureDocumentTranscript(db, blobs, 'session', ids[0]!, bodies[0]!, at, 0, 'codex');
    for (let i = 1; i < ids.length; i += 1) env = await captureDocumentTranscript(db, blobs, 'session', ids[i]!, bodies[i]!, at + i, 0, 'codex');
    const source = (await db.prepare('SELECT transcript_id,size FROM transcripts ORDER BY transcript_id').all()).results;
    const before = await getSession(db, { projectId: 'project' }, 'session');
    const first = await publishDocuments(env, at + 20 * MIN, { ...limits(), calls: 35 });
    expect(first.more, target).toBe(true);
    expect((await one(db, 'SELECT publication_after FROM session_documents'))!.publication_after, target).not.toBeNull();
    const published = await getSession(db, { projectId: 'project' }, 'session');
    expect(published!.publishedRevision, target).toBeGreaterThan(before!.publishedRevision);
    expect(published!.lastReceivedAt, target).toBe(before!.lastReceivedAt);
    const landed = (await db.prepare('SELECT prompt_id,preview FROM session_prompts ORDER BY prompt_id').all()).results;
    const addition = user('late-turn', 'late input') + reply('late reply');
    env = await captureDocumentTranscript(db, blobs, 'session', ids[0]!, addition, at + 21 * MIN, bodies[0]!.length, 'codex');
    expect((await one(db, 'SELECT publication_after FROM session_documents'))!.publication_after, target).toBeNull();
    expect((await getSession(db, { projectId: 'project' }, 'session'))!.publishedRevision, target).toBe(published!.publishedRevision);
    for (let pass = 0; ; pass += 1) {
      expect(pass, target).toBeLessThan(40);
      if (!(await publishDocuments(env, at + 40 * MIN, { ...limits(), calls: 35 })).more) break;
    }
    expect(await one(db, 'SELECT prompts,replies,due_at FROM session_documents'), target).toEqual({ prompts: 41, replies: 41, due_at: null });
    expect((await db.prepare('SELECT prompt_id,preview FROM session_prompts ORDER BY prompt_id').all()).results, target).toEqual(expect.arrayContaining(landed));
    expect((await db.prepare('SELECT transcript_id,size FROM transcripts ORDER BY transcript_id').all()).results, target)
      .toEqual(source.map((row, i) => i === 0 ? { ...row, size: bodies[0]!.length + addition.length } : row));
    expect(await one(db, `SELECT COUNT(*) n FROM transcripts t JOIN transcript_publication p USING(project_id,transcript_id)
      WHERE p.published_offset=t.size AND p.generation=1`), target).toEqual({ n: 40 });
  });
});

test('admission stops retain a content-free subreason and their source identity', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), at = Date.now() - 60 * MIN;
    const text = user('bad-turn', '\ud800');
    const id = 'tx_abcdef0123456789abcdef0123456789';
    const env = await captureDocumentTranscript(db, blobs, 'session', id, text, at, 0, 'codex');
    await publishDocuments(env, at + 20 * MIN, limits());
    const stopped = await one(db, 'SELECT state,failure,diagnostic,published_offset,prompt_scheme,record_scheme FROM transcript_publication');
    expect(stopped, target).toMatchObject({ state: 'failed', failure: 'event_refused', published_offset: 0 });
    expect(parseDiagnostic(JSON.parse(String(stopped!.diagnostic))), target).toEqual({ branch: 'event_refused', offset: 0, lineKind: 'unknown', subreason: 'unpaired_surrogate' });
    expect(await one(db, 'SELECT transcript_id,size FROM transcripts'), target).toEqual({ transcript_id: id, size: text.length });
    expect(await one(db, 'SELECT state,parser_version FROM transcript_publication'), target).toEqual({ state: 'failed', parser_version: PARSER_VERSION });
  });
});

test('a receipt-order correction during publication keeps the moved transcript due', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), at = Date.now() - 60 * MIN;
    const ids = Array.from({ length: 20 }, (_, i) => `tx_${String(i).padStart(32, '0')}`);
    let env = await captureDocumentTranscript(db, blobs, 'session', ids[0]!, user('turn-0', 'prompt 0') + reply('reply 0'), at, 0, 'codex');
    for (let i = 1; i < ids.length; i += 1) env = await captureDocumentTranscript(db, blobs, 'session', ids[i]!, user(`turn-${i}`, `prompt ${i}`) + reply(`reply ${i}`), at + i, 0, 'codex');
    const get = blobs.get.bind(blobs);
    let correct = true;
    blobs.get = async (...args) => {
      if (correct) {
        correct = false;
        await db.prepare('UPDATE transcripts SET first_received_at=? WHERE project_id=? AND transcript_id=?').bind(at - 1, 'project', ids.at(-1)!).run();
      }
      return get(...args);
    };
    await publishDocuments(env, at + 20 * MIN, { ...limits(), calls: 35 });
    expect(await one(db, 'SELECT publication_after,due_at FROM session_documents'), target).toEqual({ publication_after: null, due_at: 0 });
    for (let pass = 0; ; pass += 1) {
      expect(pass, target).toBeLessThan(20);
      if (!(await publishDocuments(env, at + 20 * MIN, { ...limits(), calls: 35 })).more) break;
    }
    expect(await one(db, 'SELECT prompts,replies,due_at FROM session_documents'), target).toEqual({ prompts: 20, replies: 20, due_at: null });
    expect((await db.prepare('SELECT transcript_id FROM transcripts ORDER BY transcript_id').all()).results, target).toEqual(ids.map(transcript_id => ({ transcript_id })));
  });
});
