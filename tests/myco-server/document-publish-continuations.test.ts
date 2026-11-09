import { expect, test } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { readPage } from '@myco-server-worker/content/document-reader.js';
import { DOCUMENT_PAGE_BYTES, pageBytes, type DocRecord } from '@myco-server-worker/content/document.js';
import { documentRecord } from '@myco-server-worker/content/document-records.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { issueMemberToken } from './helpers/member-token.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { V116_STATEMENTS } from '@myco-server-worker/db/schema-v116.js';
import { CONTENT_BLOB_LIMIT, measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { documentPublicationStoppedFinding, documentPublishFailureFinding } from '@myco-server-worker/core/attention-state.js';
import { statusMetadata } from '@myco-server-worker/db/documents/failure-head.js';
import { WAKE_JOB_STATEMENT_LIMIT } from '@myco-server-worker/core/tick.js';
import { captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import { envelope, memoryBlobStore, uuid } from './helpers/fixtures.js';
import { MIN, tx, item, user, call, output, limits, one, counters, ran, seedRecords } from './helpers/document-publication.js';

test('a turn wider than one wake can read takes new records and a late result, advancing on every wake-budget pass', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const first = user('turn-1', 'long task') + ran('n-first');
    const env = await captureDocumentTranscript(db, blobs, 'wide', tx, first, t0, 0, 'codex');
    await publishDocuments(env, t0 + MIN, limits());
    const turn = String((await counters(db, 'wide'))!.open_turn_key);

    // One turn over more page chunks than a wake has blob calls, with a call whose result has not arrived on its first page.
    const late = uuid(30000);
    let firstPadding = 0;
    const fill = (i: number) => documentRecord('tool.use', { toolCallId: uuid(31000 + i), promptId: turn, toolName: 'shell',
      input: { command: 'fill', env: 'x'.repeat(i === 0 ? firstPadding : 250_000) }, success: true }, t0, { received_at: t0 })!;
    const lateRecord = documentRecord('tool.use', { toolCallId: late, promptId: turn, toolName: 'unknown', input: {}, success: true }, t0, { received_at: t0, call: null })!;
    const head = (await readPage({ db, blobs }, 'project', 'wide', turn, 0))!;
    const fitted = (record: DocRecord) => ({ ...record, harness: 'codex', files_affected: [] });
    firstPadding = DOCUMENT_PAGE_BYTES - pageBytes({ owner: turn, page: 0, records: [...head, fitted(lateRecord), fitted(fill(0))] }) - 1_000;
    const seeded = 260;
    await seedRecords(env, 'wide', [lateRecord, ...Array.from({ length: seeded }, (_, i) => fill(i))], t0 + MIN);
    const width = Number((await one(db, `SELECT COUNT(DISTINCT chunk_no) n FROM session_pages WHERE session_id='wide' AND owner=?`, turn))!.n);
    expect(width, name).toBeGreaterThan(CONTENT_BLOB_LIMIT);
    const hash = await one(db, `SELECT input_hash FROM session_prompts WHERE prompt_id=?`, turn);

    // The transcript grows inside the turn. Every pass advances, by placing records or by what it learned of the turn.
    let calls = '';
    for (let i = 0; i < 12; i++) calls += ran(`n${i}`);
    await captureDocumentTranscript(db, blobs, 'wide', tx, calls, t0 + 2 * MIN, first.length, 'codex');
    const progress = async () => Number((await counters(db, 'wide'))!.tool_calls)
      + Number((await one(db, `SELECT COUNT(*) n FROM session_pages WHERE session_id='wide' AND sealed=1`))!.n);
    const target = 1 + seeded + 1 + 12;
    let wakeBlobCalls = 0;
    for (let pass = 0, held = await progress(); Number((await counters(db, 'wide'))!.tool_calls) < target; pass += 1) {
      expect(pass, name).toBeLessThan(10);
      const measured = measuredContentEnv(env, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: CONTENT_BLOB_LIMIT });
      await publishDocuments(measured.env, t0 + 3 * MIN + pass, limits());
      wakeBlobCalls = measured.usage.blobCalls;
      const now = await progress();
      expect(now, `${name} pass ${pass}`).toBeGreaterThan(held);
      held = now;
    }
    expect((await statusMetadata(db)).documentPublishFailure, name).toBeNull();
    expect(await one(db, `SELECT published_offset,state FROM transcript_publication WHERE transcript_id=?`, tx), name)
      .toEqual({ published_offset: first.length + calls.length, state: 'active' });
    expect(await one(db, `SELECT tools FROM session_prompts WHERE prompt_id=?`, turn), name).toEqual({ tools: target });
    expect(await one(db, `SELECT input_hash FROM session_prompts WHERE prompt_id=?`, turn), name).not.toEqual(hash);
    expect(wakeBlobCalls, name).toBeLessThan(30);

    // A later growth of the transcript costs the same however wide the turn is.
    await captureDocumentTranscript(db, blobs, 'wide', tx, ran('n-more'), t0 + 40 * MIN, first.length + calls.length, 'codex');
    const appended = measuredContentEnv(env, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: CONTENT_BLOB_LIMIT });
    await publishDocuments(appended.env, t0 + 40 * MIN, limits());
    expect(await one(db, `SELECT tools FROM session_prompts WHERE prompt_id=?`, turn), name).toEqual({ tools: target + 1 });
    expect(appended.usage.blobCalls, name).toBeLessThan(24);

    // The call's result arrives on the first page: that one page is opened, and a record that outgrows it moves to the turn's last page.
    const at = t0 + 41 * MIN;
    const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, at);
    expect((await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: at }, envelope({ eventId: uuid(32000), sessionId: 'wide',
      kind: 'tool.use', createdAt: at, payload: { toolCallId: late, promptId: turn, toolName: 'shell', input: { command: 'grow', env: 'y'.repeat(2_000) }, success: true } }), env)).persisted, name).toBe(true);
    const merged = measuredContentEnv(env, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: CONTENT_BLOB_LIMIT });
    await publishDocuments(merged.env, at, limits());
    expect(merged.usage.blobCalls, name).toBeLessThan(24);
    expect(await counters(db, 'wide'), name).toMatchObject({ tool_calls: target + 1, due_at: null });
    expect(await one(db, `SELECT tools FROM session_prompts WHERE prompt_id=?`, turn), name).toEqual({ tools: target + 1 });
    expect((await readPage({ db, blobs }, 'project', 'wide', turn, 0))!.some((record) => record.id === late), name).toBe(false);
    const last = Number((await one(db, `SELECT MAX(page) p FROM session_pages WHERE session_id='wide' AND owner=?`, turn))!.p);
    expect((await readPage({ db, blobs }, 'project', 'wide', turn, last))!.filter((record) => record.id === late), name)
      .toEqual([expect.objectContaining({ summary: 'grow', call_source: expect.anything() })]);
  });
}, 180_000);

test('a transcript whose segment object is absent waits it out, publishes the others, and resumes when the object returns', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const other = `tx_${'1'.repeat(32)}`;
    const first = user('turn-1', 'run the tests') + ran('a1');
    const opening = user('turn-2', 'a second thread');
    let env = await captureDocumentTranscript(db, blobs, 'absent', tx, first, t0, 0, 'codex');
    env = await captureDocumentTranscript(db, blobs, 'absent', other, opening, t0, 0, 'codex');
    await publishDocuments(env, t0 + MIN, limits());
    const held = Number((await counters(db, 'absent'))!.tool_calls);

    // The next segment's row and blob row stand, but the store does not answer for its object.
    const next = ran('a2');
    await captureDocumentTranscript(db, blobs, 'absent', tx, next, t0 + 2 * MIN, first.length, 'codex');
    const segment = await one(db, `SELECT b.generation,b.key FROM transcript_segments s JOIN blobs b ON b.project_id=s.project_id AND b.key=s.blob_key
      WHERE s.transcript_id=? AND s.base_offset=?`, tx, first.length);
    const objectKey = blobObjectKey('project', String(segment!.key), segment!.generation as string | null);
    const get = blobs.get.bind(blobs);
    blobs.get = async (key, options) => (key === objectKey ? null : get(key, options));
    await captureDocumentTranscript(db, blobs, 'absent', other, ran('b1'), t0 + 2 * MIN, opening.length, 'codex');

    const now = t0 + 3 * MIN;
    await publishDocuments(env, now, limits());
    expect(await one(db, `SELECT published_offset,state,failure FROM transcript_publication WHERE transcript_id=?`, tx), name)
      .toEqual({ published_offset: first.length, state: 'active', failure: null });
    expect(Number((await counters(db, 'absent'))!.tool_calls), name).toBe(held + 1);
    expect(Number((await counters(db, 'absent'))!.due_at), name).toBeGreaterThan(now);
    expect(documentPublishFailureFinding((await statusMetadata(db)).documentPublishFailure, now)?.failure, name).toBe('blob_absent');

    // The wait lengthens with the time from the last advance of the transcript.
    const later = now + 20 * MIN;
    await db.prepare(`UPDATE session_documents SET due_at=0 WHERE session_id='absent'`).run();
    await publishDocuments(env, later, limits());
    expect(Number((await counters(db, 'absent'))!.due_at), name).toBeGreaterThan(later + 5 * MIN);

    // The object is back: the publication resumes from its frontier.
    blobs.get = get;
    await db.prepare(`UPDATE session_documents SET due_at=0 WHERE session_id='absent'`).run();
    await publishDocuments(env, later + 1, limits());
    expect(await one(db, `SELECT published_offset,state,failure FROM transcript_publication WHERE transcript_id=?`, tx), name)
      .toEqual({ published_offset: first.length + next.length, state: 'active', failure: null });
    expect(await counters(db, 'absent'), name).toMatchObject({ tool_calls: held + 2, due_at: null });
  });
}, 60_000);

test('a publication stopped by an absent blob resumes, and one stopped for good stays stopped and shows on status', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const lasting = `tx_${'2'.repeat(32)}`;
    const first = user('turn-1', 'run the tests') + ran('a1');
    const opening = user('turn-2', 'other');
    let env = await captureDocumentTranscript(db, blobs, 'stopped', tx, first, t0, 0, 'codex');
    env = await captureDocumentTranscript(db, blobs, 'stopped', lasting, opening, t0, 0, 'codex');
    await publishDocuments(env, t0 + MIN, limits());
    const next = ran('a2');
    await captureDocumentTranscript(db, blobs, 'stopped', tx, next, t0 + 2 * MIN, first.length, 'codex');
    await captureDocumentTranscript(db, blobs, 'stopped', lasting, ran('b1'), t0 + 2 * MIN, opening.length, 'codex');
    await db.prepare(`UPDATE transcript_publication SET state='failed',failure='blob_absent' WHERE transcript_id=?`).bind(tx).run();
    await db.prepare(`UPDATE transcript_publication SET state='failed',failure='record_too_large' WHERE transcript_id=?`).bind(lasting).run();

    await publishDocuments(env, t0 + 3 * MIN, limits());
    expect(await one(db, `SELECT published_offset,state,failure FROM transcript_publication WHERE transcript_id=?`, tx), name)
      .toEqual({ published_offset: first.length + next.length, state: 'active', failure: null });
    expect(await one(db, `SELECT published_offset,state,failure FROM transcript_publication WHERE transcript_id=?`, lasting), name)
      .toEqual({ published_offset: opening.length, state: 'failed', failure: 'record_too_large' });
    expect(await counters(db, 'stopped'), name).toMatchObject({ tool_calls: 2, due_at: null });
    expect(await documentPublicationStoppedFinding(db), name).toEqual({ kind: 'document_publication_stopped', tone: 'warn', transcripts: 1,
      lastStoppedAt: expect.any(Number), failure: 'record_too_large' });

    // Schema step 116 makes a quiet session with such a stop due, which no arriving byte would.
    await db.prepare(`UPDATE transcript_publication SET state='failed',failure='blob_absent' WHERE transcript_id=?`).bind(tx).run();
    await db.prepare(`UPDATE session_documents SET due_at=NULL WHERE session_id='stopped'`).run();
    await db.prepare(V116_STATEMENTS.at(-1)!).run();
    expect((await counters(db, 'stopped'))!.due_at, name).toBe(0);
  });
}, 60_000);

test('a publication whose cursor no held segment covers waits for those bytes, and what it held before them survives', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const pending = item('response_item', { type: 'function_call', call_id: 'pending', name: 'shell', arguments: JSON.stringify({ command: 'must survive' }) });
    const first = user('turn-1', 'first') + pending;
    let env = await captureDocumentTranscript(db, blobs, 'gap', tx, first, t0, 0, 'codex');
    await publishDocuments(env, t0 + MIN, limits());
    expect((await counters(db, 'gap'))!.tool_calls, name).toBe(0);
    const late = ran('late'), kept = user('turn-2', 'after the gap') + ran('kept');
    await captureDocumentTranscript(db, blobs, 'gap', tx, late, t0 + 2 * MIN, first.length, 'codex');
    env = await captureDocumentTranscript(db, blobs, 'gap', tx, kept, t0 + 2 * MIN, first.length + late.length, 'codex');

    // The segment at the cursor is not stored yet.
    const row = await one(db, `SELECT * FROM transcript_segments WHERE transcript_id=? AND base_offset=?`, tx, first.length);
    await db.prepare(`DELETE FROM transcript_segments WHERE transcript_id=? AND base_offset=?`).bind(tx, first.length).run();
    const now = t0 + 3 * MIN;
    await publishDocuments(env, now, limits());
    expect(await one(db, `SELECT published_offset,state,failure FROM transcript_publication WHERE transcript_id=?`, tx), name)
      .toEqual({ published_offset: first.length, state: 'active', failure: null });
    expect(Number((await counters(db, 'gap'))!.due_at), name).toBeGreaterThan(now);
    expect(documentPublishFailureFinding((await statusMetadata(db)).documentPublishFailure, now)?.failure, name).toBe('blob_absent');

    // It arrives: everything publishes in order, the call held from before the gap included.
    const columns = Object.keys(row!);
    await db.prepare(`INSERT INTO transcript_segments (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...columns.map((column) => row![column])).run();
    await db.prepare(`UPDATE session_documents SET due_at=0 WHERE session_id='gap'`).run();
    for (let more = true, at = now + 1; more; at += 1) more = (await publishDocuments(env, at, limits())).more;
    expect(await one(db, `SELECT published_offset,state FROM transcript_publication WHERE transcript_id=?`, tx), name)
      .toEqual({ published_offset: first.length + late.length + kept.length, state: 'active' });
    expect(await counters(db, 'gap'), name).toMatchObject({ prompts: 2, tool_calls: 2 });

    // The transcript goes idle, and the unanswered call from before the gap closes with its outcome.
    await publishDocuments(env, t0 + 30 * MIN, limits());
    expect(await counters(db, 'gap'), name).toMatchObject({ prompts: 2, tool_calls: 3, due_at: null });
    const turn = (await db.prepare(`SELECT prompt_id FROM session_prompts WHERE session_id='gap' ORDER BY ord LIMIT 1`).first<{ prompt_id: string }>())!.prompt_id;
    expect((await readPage({ db, blobs }, 'project', 'gap', turn, 0))!.map((record) => record.summary).filter(Boolean), name).toContain('must survive');
  });
}, 60_000);

test('a compact window of results for many old chunks commits a shorter prefix, advancing on every wake-budget pass', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN, blobs = memoryBlobStore();
    const outputs = (value: string) => Array.from({ length: 120 }, (_, i) =>
      item('response_item', { type: 'function_call_output', call_id: `old-${i}`, output: value })).join('');
    const first = user('turn-wide', 'update all old tools') + outputs('before');
    const env = await captureDocumentTranscript(db, blobs, 'mergewide', tx, first, t0, 0, 'codex');
    await publishDocuments(env, t0 + MIN, limits());
    const turn = String((await counters(db, 'mergewide'))!.open_turn_key);
    const tools = (await readPage(env, 'project', 'mergewide', turn, 0))!.filter((record) => record.k === 'tool');
    expect(tools.length, name).toBe(120);
    // Each tool grows past a page, so the turn spreads over many chunks; the second pass seals its older pages.
    const grown = tools.map((record) => documentRecord('tool.use', { toolCallId: record.id, promptId: turn, toolName: 'shell',
      input: { command: 'old', env: 'x'.repeat(250_000) }, success: true }, t0, { received_at: t0 })!);
    await seedRecords(env, 'mergewide', grown, t0 + MIN);
    await seedRecords(env, 'mergewide', grown, t0 + MIN + 1);
    expect(Number((await one(db, `SELECT SUM(sealed) n FROM session_pages WHERE session_id='mergewide'`))!.n), name).toBeGreaterThan(60);

    // One small window names all of them. Unchanged input, each pass run once its session is due.
    const next = outputs('after');
    await captureDocumentTranscript(db, blobs, 'mergewide', tx, next, t0 + 2 * MIN, first.length, 'codex');
    let at = t0 + 3 * MIN, held = first.length;
    for (let pass = 0; held < first.length + next.length; pass += 1) {
      expect(pass, name).toBeLessThan(30);
      at = Math.max(at, Number((await counters(db, 'mergewide'))!.due_at)) + 1;
      const measured = measuredContentEnv(env, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: CONTENT_BLOB_LIMIT });
      await publishDocuments(measured.env, at, limits());
      const now = Number((await one(db, `SELECT published_offset n FROM transcript_publication WHERE transcript_id=?`, tx))!.n);
      expect(now, `${name} pass ${pass}`).toBeGreaterThan(held);
      held = now;
    }
    expect((await statusMetadata(db)).documentPublishFailure, name).toBeNull();
    expect(await counters(db, 'mergewide'), name).toMatchObject({ tool_calls: 120, due_at: null });
    const last = (await db.prepare(`SELECT page FROM session_pages WHERE session_id='mergewide' AND owner=? AND records>0 ORDER BY page LIMIT 40`).bind(turn).all<{ page: number }>()).results;
    const updated = (await Promise.all(last.map(({ page }) => readPage({ db, blobs }, 'project', 'mergewide', turn, page)))).flatMap((records) => records ?? []).filter((record) => record.k === 'tool');
    expect(updated.length, name).toBeGreaterThan(0);
    expect(new Set(updated.map((record) => record.output_preview)), name).toEqual(new Set(['after']));
  });
}, 180_000);

/** A Claude turn of `width` tools over many sealed chunks, then one line of results naming them all and three new calls, and one line after it. */
async function wideResultLine(db: RelationalStore, blobs: ReturnType<typeof memoryBlobStore>, session: string, t0: number, width: number,
  appended?: (ids: readonly string[], results: (id: number, content: string, ids: readonly string[]) => string) => string) {
  const results = (id: number, content: string, ids: readonly string[]) => JSON.stringify({ type: 'user', uuid: uuid(id), message: { role: 'user',
    content: ids.map((tool) => ({ type: 'tool_result', tool_use_id: tool, content })) } }) + '\n';
  const old = Array.from({ length: width }, (_, i) => `old-${i}`);
  const first = JSON.stringify({ type: 'user', uuid: uuid(60000), promptId: uuid(60100), message: { role: 'user', content: [{ type: 'text', text: 'update them' }] } }) + '\n'
    + results(60200, 'before', old);
  const env = await captureDocumentTranscript(db, blobs, session, tx, first, t0, 0, 'claude-code');
  await publishDocuments(env, t0 + MIN, limits());
  const turn = String((await counters(db, session))!.open_turn_key);
  const tools = (await readPage(env, 'project', session, turn, 0))!.filter((record) => record.k === 'tool');
  const grown = tools.map((record) => documentRecord('tool.use', { toolCallId: record.id, promptId: turn, toolName: 'shell',
    input: { command: 'old', env: 'x'.repeat(250_000) }, success: true }, t0, { received_at: t0 })!);
  await seedRecords(env, session, grown, t0 + MIN);
  await seedRecords(env, session, grown, t0 + MIN + 1);
  const line = appended?.(old, results) ?? results(60201, 'after', [...old, 'new-0', 'new-1', 'new-2']) + results(60202, 'after', ['new-3']);
  await captureDocumentTranscript(db, blobs, session, tx, line, t0 + 2 * MIN, first.length, 'claude-code');
  /** One pass under the wake budget, run once the session is due. */
  let at = t0 + 3 * MIN;
  const pass = async () => {
    at = Math.max(at, Number((await counters(db, session))!.due_at)) + 1;
    await publishDocuments(measuredContentEnv(env, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: CONTENT_BLOB_LIMIT }).env, at, limits());
  };
  const frontier = () => one(db, `SELECT published_offset o,placed_records n FROM transcript_publication WHERE transcript_id=? AND generation=1`, tx);
  /** Every tool of the turn once, each with the line's result, and each counted once. */
  const expectEveryResult = async (name: string) => {
    expect(await frontier(), name).toEqual({ o: first.length + line.length, n: null });
    expect((await counters(db, session))!.tool_calls, name).toBe(width + 4);
    const pages = (await db.prepare(`SELECT page FROM session_pages WHERE session_id=? AND owner=?`).bind(session, turn).all<{ page: number }>()).results;
    const held = (await Promise.all(pages.map(({ page }) => readPage(env, 'project', session, turn, page)))).flatMap((records) => records ?? []).filter((record) => record.k === 'tool');
    expect(held.length, name).toBe(width + 4);
    expect(new Set(held.map((record) => record.id)).size, name).toBe(width + 4);
    expect(new Set(held.map((record) => record.output_preview)), name).toEqual(new Set(['after']));
  };
  return { first, line, results, pass, frontier, expectEveryResult };
}

test('one line of results for more old chunks than a wake can read commits a part of its records on every wake-budget pass, and places each once', async () => {
  await withDocumentStores(async (db, name) => {
    const { first, line, pass, frontier, expectEveryResult } = await wideResultLine(db, memoryBlobStore(), 'oneline', Date.now() - 2 * 60 * MIN, 240);
    let placed = 0;
    for (let round = 0; Number((await frontier())!.o) < first.length + line.length; round += 1) {
      expect(round, name).toBeLessThan(30);
      await pass();
      const now = await frontier();
      if (Number(now!.o) === first.length) {
        expect(Number(now!.n), `${name} pass ${round}`).toBeGreaterThan(placed);
        placed = Number(now!.n);
      }
    }
    expect(placed, name).toBeGreaterThan(0);
    expect((await statusMetadata(db)).documentPublishFailure, name).toBeNull();
    await expectEveryResult(name);
  });
}, 180_000);

test('a line part placed survives a failed commit, a derivation that no longer matches and a publication the generation does not hold', async () => {
  await withDocumentStores(async (db, name) => {
    const blobs = memoryBlobStore();
    const { first, line, pass, frontier, expectEveryResult } = await wideResultLine(db, blobs, 'resume', Date.now() - 2 * 60 * MIN, 120);
    await pass();
    const started = await frontier();
    expect(Number(started!.n), name).toBeGreaterThan(0);
    const counted = await counters(db, 'resume');

    // A commit that fails records nothing: the count and the catalog stand.
    blobs.failNextPut = 'store unavailable';
    await expect(pass(), name).rejects.toThrow('store unavailable');
    expect(await frontier(), name).toEqual(started);
    expect(await counters(db, 'resume'), name).toEqual({ ...counted, due_at: expect.any(Number) });
    expect(Number((await counters(db, 'resume'))!.due_at), name).toBeGreaterThan(Number(counted!.due_at));

    // A count whose digest does not name what the line derives skips nothing.
    await db.prepare(`UPDATE transcript_publication SET placed_records=119,placed_digest='other' WHERE transcript_id=?`).bind(tx).run();
    await pass();
    expect(Number((await frontier())!.n), name).toBeLessThan(119);

    // A generation with no publication reads none of another's: it starts over, and every record merges into itself.
    await db.prepare(`UPDATE transcript_publication SET generation=2 WHERE transcript_id=?`).bind(tx).run();
    for (let round = 0; Number((await frontier())?.o ?? 0) < first.length + line.length; round += 1) {
      expect(round, name).toBeLessThan(40);
      await pass();
    }
    await expectEveryResult(name);
  });
}, 240_000);

test('a line part placed keeps its count while the transcript grows, when its results close calls of an earlier line', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN, blobs = memoryBlobStore();
    const { first, line, results, pass, frontier } = await wideResultLine(db, blobs, 'growing', t0, 240, (ids, results) =>
      JSON.stringify({ type: 'assistant', uuid: uuid(60300), message: { role: 'assistant', content: ids.map((id) => ({ type: 'tool_use', id, name: 'shell', input: { command: 'run' } })) } }) + '\n'
      + results(60201, 'after', ids));
    const end = first.length + line.length;
    let size = end, offset = first.length, placed = 0, parts = 0;
    for (let round = 0; Number((await frontier())!.o) < end; round += 1) {
      expect(round, name).toBeLessThan(30);
      await pass();
      const held = (await frontier())!;
      const nextOffset = Number(held.o), now = Number(held.n);
      expect(nextOffset, `${name} pass ${round}`).toBeGreaterThanOrEqual(offset);
      if (now > 0) {
        expect(now, `${name} pass ${round}`).toBeGreaterThan(nextOffset === offset ? placed : 0);
        parts += 1;
      }
      offset = nextOffset;
      placed = now;
      const grown = results(61000 + round, 'after', [`grown-${round}`]);
      await captureDocumentTranscript(db, blobs, 'growing', tx, grown, t0 + 2 * MIN + round + 1, size, 'claude-code');
      size += grown.length;
    }
    expect(parts, name).toBeGreaterThan(0);
    const counted = await counters(db, 'growing');
    expect(Number(counted!.tool_calls), name).toBeGreaterThanOrEqual(240);
    expect(counted!.failed_tools, name).toBe(0);
  });
}, 180_000);

test('real results that arrive during a partial turn close replace the failures it placed', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN, blobs = memoryBlobStore();
    const ids = Array.from({ length: 32 }, (_, i) => `pending-${i}`);
    const first = JSON.stringify({ type: 'user', uuid: uuid(63000), promptId: uuid(63001), message: { role: 'user', content: [{ type: 'text', text: 'run these' }] } }) + '\n'
      + JSON.stringify({ type: 'assistant', uuid: uuid(63002), message: { role: 'assistant', content: ids.map((id) => ({ type: 'tool_use', id, name: 'shell', input: { command: id, env: 'x'.repeat(300_000) } })) } }) + '\n';
    const env = await captureDocumentTranscript(db, blobs, 'closing', tx, first, t0, 0, 'claude-code');
    await publishDocuments(env, t0 + MIN, limits());
    expect((await counters(db, 'closing'))!.tool_calls, name).toBe(0);
    const budgeted = (at: number) => publishDocuments(measuredContentEnv(env, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: CONTENT_BLOB_LIMIT }).env, at, limits());
    const frontier = () => one(db, `SELECT published_offset o,placed_records n FROM transcript_publication WHERE transcript_id=? AND generation=1`, tx);

    // The idle close is too wide for one commit: part of it is placed as calls that never got a result.
    await budgeted(t0 + 11 * MIN);
    const partial = await frontier();
    expect(partial!.o, name).toBe(first.length);
    expect(Number(partial!.n), name).toBeGreaterThan(0);
    expect(Number(partial!.n), name).toBeLessThan(32);
    expect(Number((await counters(db, 'closing'))!.failed_tools), name).toBe(Number(partial!.n));

    const results = JSON.stringify({ type: 'user', uuid: uuid(63003), message: { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'real success' })) } }) + '\n';
    await captureDocumentTranscript(db, blobs, 'closing', tx, results, t0 + 12 * MIN, first.length, 'claude-code');
    for (let round = 0; Number((await frontier())!.o) < first.length + results.length; round += 1) {
      expect(round, name).toBeLessThan(10);
      await budgeted(t0 + 12 * MIN + round);
    }
    expect(await counters(db, 'closing'), name).toMatchObject({ tool_calls: 32, failed_tools: 0 });
    const turn = String((await counters(db, 'closing'))!.open_turn_key);
    const tools = (await readPage(env, 'project', 'closing', turn, 0))!.filter((record) => record.k === 'tool');
    expect(tools.length, name).toBe(32);
    expect(tools.filter((record) => record.success === 0).length, name).toBe(0);
    expect(tools.filter((record) => record.output_preview === 'real success').length, name).toBe(32);
  });
}, 120_000);

test('a wide turn whose prompt is on no page a pass reads still commits, its counts grow and its card stands', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN, blobs = memoryBlobStore();
    const env = await captureDocumentTranscript(db, blobs, 'midprompt', tx, user('turn-0', 'first') + ran('first'), t0, 0, 'codex');
    await publishDocuments(env, t0 + MIN, limits());
    const turn = 'mid-turn';
    const tools = (from: number, n: number) => Array.from({ length: n }, (_, i) => documentRecord('tool.use', { toolCallId: `mid-${from + i}`, promptId: turn, toolName: 'shell',
      input: { command: 'x', env: 'x'.repeat(250_000) }, success: true }, t0, { received_at: t0 })!);
    // One batch places the turn's tools before its prompt, so the prompt sits past the leading pages; later batches seal it behind them.
    await seedRecords(env, 'midprompt', [...tools(0, 20), documentRecord('prompt', { promptId: turn, text: 'late prompt', origin: 'user' }, t0, { received_at: t0 })!], t0 + MIN);
    await seedRecords(env, 'midprompt', tools(20, 40), t0 + MIN + 1);
    await seedRecords(env, 'midprompt', tools(60, 1), t0 + MIN + 2);
    const prompt = await one(db, `SELECT page FROM session_prompts WHERE session_id='midprompt' AND prompt_id=?`, turn);
    expect(await one(db, `SELECT sealed FROM session_pages WHERE session_id='midprompt' AND owner=? AND page=?`, turn, prompt!.page), name).toEqual({ sealed: 1 });
    const card = () => one(db, `SELECT settle_at,changes,state FROM turn_cards WHERE session_id='midprompt' AND turn_key=?`, turn);
    const held = await card();
    const counted = await one(db, `SELECT tools FROM session_prompts WHERE session_id='midprompt' AND prompt_id=?`, turn);

    await seedRecords(env, 'midprompt', tools(61, 1), t0 + MIN + 3);
    expect(await card(), name).toEqual(held);
    expect(await one(db, `SELECT tools FROM session_prompts WHERE session_id='midprompt' AND prompt_id=?`, turn), name).toEqual({ tools: Number(counted!.tools) + 1 });
  });
}, 120_000);
