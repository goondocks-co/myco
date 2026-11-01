import { BACKUP_FORMAT, deploymentId, restoreArtifact, createBackup, backupArtifact } from '@myco-server-worker/core/backup.js';
import { expect, test } from 'bun:test';
import type { PreparedStatement, RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import { publishDocuments, RETIRED_OBJECT_GRACE_MS } from '@myco-server-worker/ingest/publish.js';
import { LOCATE_CHUNKS_PER_WAKE, locatePrompts } from '@myco-server-worker/ingest/document-locators.js';
import { readPage } from '@myco-server-worker/content/document-reader.js';
import { SESSION_OWNER, type DocRecord } from '@myco-server-worker/content/document.js';
import { documentRecord } from '@myco-server-worker/content/document-records.js';
import type { ChunkRow, PageRow } from '@myco-server-worker/content/document-reader.js';
import { DocumentBatch, directoryStatements } from '@myco-server-worker/ingest/document-batch.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { prepareArchive } from '@myco-server-worker/core/event-content.js';
import { bundleArchiveStatements } from '@myco-server-worker/core/archive-bundle.js';
import { BACKUP_FORMAT, deploymentId, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { cleanupCandidate } from '@myco-server-worker/core/storage-cleanup.js';
import { prepareDerivedStream } from '@myco-server-worker/core/registered-content.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { V116_STATEMENTS } from '@myco-server-worker/db/schema-v116.js';
import { CONTENT_BLOB_LIMIT, measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { documentPublicationStoppedFinding, documentPublishFailureFinding } from '@myco-server-worker/core/attention-state.js';
import { statusMetadata } from '@myco-server-worker/read/meta.js';
import { WAKE_JOB_STATEMENT_LIMIT } from '@myco-server-worker/core/tick.js';
import { captureDocumentSession, captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import { envelope, memoryBlobStore, uuid } from './helpers/fixtures.js';

const MIN = 60_000;
const tx = 'tx_0123456789abcdef0123456789abcdef';
const item = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload }) + '\n';
const user = (turn: string, text: string) =>
  item('turn_context', { turn_id: turn }) + item('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const reply = (text: string) => item('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const call = item('response_item', { type: 'function_call', call_id: 'c1', name: 'shell', arguments: JSON.stringify({ command: 'npm test', env: 'x'.repeat(300_000) }) });
const output = item('response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' });
const limits = () => ({ calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
const one = async (db: RelationalStore, sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params).first<Record<string, unknown>>();
const counters = (db: RelationalStore, session: string) =>
  one(db, `SELECT prompts,user_prompts,replies,tool_calls,failed_tools,plans,open_turn_key,due_at FROM session_documents WHERE session_id=?`, session);

test('a transcript publishes after a failed pass, its closed turn takes a late result in place, and the old version retires', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const first = user('turn-1', 'run the tests') + reply('running') + call;
    const env = await captureDocumentTranscript(db, blobs, 'session', tx, first, t0, 0, 'codex');

    // A pass that fails after registering the body that left its record makes nothing live and leaves nothing registered.
    const put = blobs.put.bind(blobs);
    let puts = 0;
    blobs.put = async (...args: Parameters<typeof put>) => { if (++puts === 2) blobs.failNextPut = 'store unavailable'; return put(...args); };
    await expect(publishDocuments(env, t0 + 11 * MIN, limits())).rejects.toThrow('store unavailable');
    blobs.put = put;
    expect(await one(db, `SELECT (SELECT COUNT(*) FROM session_chunks)+(SELECT COUNT(*) FROM transcript_publication)
      +(SELECT COUNT(*) FROM registered_content_proofs WHERE source_kind='document') n`), name).toEqual({ n: 0 });

    // The next pass resumes from the same frontier; the idle turn closes with its unanswered call recorded.
    await publishDocuments(env, t0 + 11 * MIN, limits());
    const closed = await counters(db, 'session');
    expect(closed, name).toMatchObject({ prompts: 1, user_prompts: 1, replies: 1, tool_calls: 1, failed_tools: 1, due_at: null });
    const turn = String(closed!.open_turn_key);
    const page = (await readPage({ db, blobs }, 'project', 'session', turn, 0))!;
    expect(page.map((record) => record.k), name).toEqual(['prompt', 'reply', 'tool']);
    expect(page[2], name).toMatchObject({ summary: 'npm test', success: 0, result_reason: 'no_result', src: [tx, expect.any(Number), expect.any(Number)] });
    expect(page[2]!.bodies?.input?.bytes, name).toBeGreaterThan(300_000);
    const hash = await one(db, `SELECT input_hash FROM session_prompts WHERE prompt_id=?`, turn);
    expect(await one(db, `SELECT published_offset,state FROM transcript_publication WHERE transcript_id=?`, tx), name)
      .toEqual({ published_offset: first.length, state: 'active' });

    // The result arrives after the turn closed, with the next prompt: the same call is upgraded in its own page.
    await captureDocumentTranscript(db, blobs, 'session', tx, output + user('turn-2', 'ship it'), t0 + 12 * MIN, first.length, 'codex');
    await publishDocuments(env, t0 + 12 * MIN + 1, limits());
    const upgraded = (await readPage({ db, blobs }, 'project', 'session', turn, 0))!;
    expect(upgraded.filter((record) => record.k === 'tool'), name).toEqual([expect.objectContaining({ id: page[2]!.id, success: 1, output_preview: 'ok' })]);
    expect(await counters(db, 'session'), name).toMatchObject({ prompts: 2, tool_calls: 1, failed_tools: 0 });
    expect(await one(db, `SELECT input_hash FROM session_prompts WHERE prompt_id=?`, turn), name).not.toEqual(hash);

    // A superseded chunk version stays held through the reader grace, then its holder and proofs go.
    expect(Number((await one(db, `SELECT COUNT(*) n FROM retired_objects`))!.n), name).toBeGreaterThan(0);
    await publishDocuments(env, t0 + 12 * MIN + RETIRED_OBJECT_GRACE_MS + 2, limits());
    expect(await one(db, `SELECT COUNT(*) n FROM retired_objects`), name).toEqual({ n: 0 });
    expect(await one(db, `SELECT COUNT(*) n FROM registered_content_proofs p WHERE p.source_kind='document'
      AND NOT EXISTS (SELECT 1 FROM session_chunks c WHERE c.project_id=p.project_id AND c.source_id=p.source_id)`), name).toEqual({ n: 0 });
    expect((await readPage({ db, blobs }, 'project', 'session', turn, 0))!.length, name).toBe(3);
  });
});

test('a hook-only session publishes its queued events, and records no turn holds go to the session pages', async () => {
  await withDocumentStores(async (db, name) => {
    const blobs = memoryBlobStore();
    const issued = await captureDocumentSession(db, 'project', 'hook', { blobs });
    expect(await one(db, `SELECT COUNT(*) n FROM publish_queue WHERE session_id='hook'`), name).toEqual({ n: 4 });
    const env = { db, blobs };
    await publishDocuments(env, Date.now(), limits());
    const turn = (await readPage(env, 'project', 'hook', uuid(20), 0))!;
    expect(turn.map((record: DocRecord) => [record.k, record.id]), name).toEqual([['prompt', uuid(20)], ['reply', uuid(30)]]);
    expect(turn[0], name).toMatchObject({ text: 'factcanary', ev: expect.any(String) });
    const unplaced = (await readPage(env, 'project', 'hook', SESSION_OWNER, 0))!;
    expect(unplaced.map((record: DocRecord) => [record.k, record.id]), name).toEqual([['tool', uuid(40)], ['plan', uuid(5)]]);
    expect(await counters(db, 'hook'), name).toMatchObject({ prompts: 1, replies: 1, tool_calls: 1, plans: 1 });
    expect((await db.prepare(`SELECT prompt_id,turn_key,preview,replies FROM session_prompts WHERE session_id='hook'`).all()).results, name)
      .toEqual([{ prompt_id: uuid(20), turn_key: uuid(20), preview: 'factcanary', replies: 1 }]);
    expect(await one(db, `SELECT COUNT(*) n FROM publish_queue`), name).toEqual({ n: 0 });
    expect(await one(db, `SELECT path,tool_calls FROM session_paths WHERE session_id='hook'`), name).toEqual({ path: 'test', tool_calls: 1 });

    // A reply queued beside its prompt at the same instant, under an event id that sorts first, joins the prompt's turn;
    // a later appearance of the plan is kept beside the first.
    const at = Date.now();
    const ctx = { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: at };
    for (const event of [
      envelope({ eventId: uuid(601), sessionId: 'hook', kind: 'prompt', createdAt: at, payload: { promptId: uuid(602), text: 'next', origin: 'user' } }),
      envelope({ eventId: uuid(600), sessionId: 'hook', kind: 'response', createdAt: at, payload: { responseId: uuid(603), promptId: uuid(602), text: 'done' } }),
      envelope({ eventId: uuid(604), sessionId: 'hook', kind: 'plan', createdAt: at, payload: { planKey: uuid(50), content: 'revised plan', status: 'active' } }),
    ]) expect((await ingestEvent(db, ctx, event, env)).persisted, name).toBe(true);
    await publishDocuments(env, at, limits());
    expect((await readPage(env, 'project', 'hook', uuid(602), 0))!.map((record: DocRecord) => record.id), name).toEqual([uuid(602), uuid(603)]);
    expect((await readPage(env, 'project', 'hook', SESSION_OWNER, 0))!.filter((record: DocRecord) => record.k === 'plan')
      .map((record: DocRecord) => [record.plan_key, record.content]), name).toEqual([[uuid(50), 'factcanary'], [uuid(50), 'revised plan']]);
    expect(await counters(db, 'hook'), name).toMatchObject({ prompts: 2, replies: 2, plans: 1, due_at: null });
  });
});

test('a lost commit acknowledgement keeps the live version, and a version whose pass was lost is released after the grace', async () => {
  await withDocumentStores(async (db, name) => {
    const blobs = memoryBlobStore();
    await captureDocumentSession(db, 'project', 'ack', { blobs });
    // The commit lands but its answer is lost, and the pass releases what it holds. Then a pass dies at its commit, and
    // every later batch it sends fails as a dead process's would.
    const sql = new WeakMap<object, string>();
    const raw = new WeakMap<object, object>();
    const wrap = (statement: object, text: string): object => {
      const wrapped = new Proxy(statement, { get: (target, key) => {
        const value = (target as Record<PropertyKey, unknown>)[key];
        if (key === 'bind') return (...args: unknown[]) => wrap((value as (...a: unknown[]) => object).apply(target, args), text);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      sql.set(wrapped, text);
      raw.set(wrapped, statement);
      return wrapped;
    };
    let fault: 'ack' | 'lost' = 'ack';
    let dead = false;
    const faulty = { prepare: (text: string) => wrap(db.prepare(text), text), batch: async (statements: object[]) => {
      if (dead) throw new Error('process lost');
      const commit = statements.some((statement) => sql.get(statement)?.startsWith('INSERT INTO session_chunks'));
      if (commit && fault === 'lost') { dead = true; throw new Error('process lost'); }
      const results = await db.batch(statements.map((statement) => raw.get(statement) ?? statement) as never);
      if (commit) throw new Error('commit answer lost');
      return results;
    } } as unknown as RelationalStore;
    const t0 = Date.now();
    await expect(publishDocuments({ db: faulty, blobs }, t0, limits())).rejects.toThrow('commit answer lost');
    const live = async () => (await readPage({ db, blobs }, 'project', 'ack', uuid(20), 0))!.map((record) => record.k);
    expect(await live(), name).toEqual(['prompt', 'reply']);

    await captureDocumentSession(db, 'project', 'ack', { blobs, idOffset: 100 });
    fault = 'lost';
    await expect(publishDocuments({ db: faulty, blobs }, t0 + 1, limits())).rejects.toThrow('process lost');
    expect(Number((await one(db, `SELECT COUNT(*) n FROM registered_content_proofs p WHERE p.source_kind='document'
      AND NOT EXISTS (SELECT 1 FROM session_chunks c WHERE c.source_id=p.source_id)`))!.n), name).toBeGreaterThan(0);
    await publishDocuments({ db, blobs }, t0 + RETIRED_OBJECT_GRACE_MS + 2, limits());
    await publishDocuments({ db, blobs }, t0 + 2 * RETIRED_OBJECT_GRACE_MS + 4, limits());
    expect(await live(), name).toEqual(['prompt', 'reply']);
    expect(await one(db, `SELECT COUNT(*) n FROM registered_content_proofs p WHERE p.source_kind='document'
      AND NOT EXISTS (SELECT 1 FROM session_chunks c WHERE c.source_id=p.source_id)`), name).toEqual({ n: 0 });
    expect(await one(db, `SELECT COUNT(*) n FROM retired_objects`), name).toEqual({ n: 0 });
  });
});

test('a restored session whose prompt was archived publishes the prompt read from its bundle', async () => {
  const artifacts = new Map<string, { rows: { t: string; r: Record<string, unknown> }[]; blobs: ReturnType<typeof memoryBlobStore> }>();
  await withDocumentStores(async (db, name) => {
    const blobs = memoryBlobStore();
    await captureDocumentSession(db, 'project', 'archived', { blobs });
    const row = await cleanupCandidate(db, { project_id: 'project', resource_id: uuid(2), resource_kind: 'event' }, true);
    await db.batch(bundleArchiveStatements(db, (await prepareArchive({ db, blobs }, 'event', row!, Date.now())).bundle));
    const rows: { t: string; r: Record<string, unknown> }[] = [];
    for (const t of ['members', 'member_credentials', 'sessions', 'blobs', 'archive_bundles', 'registered_content_proofs', 'events', 'raw_credentials'])
      for (const r of (await db.prepare(`SELECT * FROM ${t}`).all<Record<string, unknown>>()).results) rows.push({ t, r });
    artifacts.set(name, { rows, blobs });
  });
  await withDocumentStores(async (db, name) => {
    const { rows, blobs } = artifacts.get(name)!;
    const issued = await captureDocumentSession(db, 'project', 'bootstrap', { blobs, idOffset: 10_000 });
    for (const { r } of rows.filter((row) => row.t === 'blobs')) {
      const bytes = blobs.objects.get(blobObjectKey(String(r.project_id), String(r.key), r.generation as string | null))!.bytes;
      const id = crypto.randomUUID();
      await prepareDerivedStream({ db, blobs }, { projectId: String(r.project_id), sessionId: 'bootstrap', tokenId: issued.tokenId, sourceKind: 'event',
        eventId: id, resourceId: id, envelopeHash: id }, { size: Number(r.size), digest: String(r.key), stream: () => new Blob([bytes as Uint8Array<ArrayBuffer>]).stream() }, Date.now());
    }
    const counts: Record<string, number> = {};
    for (const { t } of rows) counts[t] = (counts[t] ?? 0) + 1;
    const header = { format: BACKUP_FORMAT, deploymentId: await deploymentId(db), schemaVersion: SCHEMA_STEPS.at(-1)!.version, createdAt: Date.now(), producer: 'test', counts };
    await restoreArtifact(db, { authorization: { kind: 'recovery' }, blobs, text: [header, ...rows].map((line) => JSON.stringify(line)).join('\n') + '\n' });
    expect(await one(db, `SELECT payload_format FROM events WHERE event_id=?`, uuid(2)), name).toEqual({ payload_format: 'archived' });
    await publishDocuments({ db, blobs }, Date.now(), limits());
    expect((await db.prepare(`SELECT prompt_id,preview FROM session_prompts WHERE session_id='archived'`).all()).results, name)
      .toEqual([{ prompt_id: uuid(20), preview: 'factcanary' }]);
    expect((await readPage({ db, blobs }, 'project', 'archived', uuid(20), 0))!.map((record) => [record.k, record.id, record.text]), name)
      .toEqual([['prompt', uuid(20), 'factcanary'], ['reply', uuid(30), 'factcanary']]);
  });
});

/** A published codex session of `turns` turns, one large reply each, with its prompts' locators cleared as a document written before them. */
async function unlocated(db: RelationalStore, session: string, turns: number) {
  const t0 = Date.now() - 2 * 60 * MIN, blobs = memoryBlobStore();
  let text = '';
  for (let i = 0; i < turns; i += 1) text += user(`turn-${i}`, `step ${i}`) + reply('x'.repeat(240_000));
  const env = await captureDocumentTranscript(db, blobs, session, `tx_${[...session].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(32, '0').slice(0, 32)}`, text, t0, 0, 'codex');
  await publishDocuments(env, t0 + 11 * MIN, limits());
  const pages = (await db.prepare(`SELECT owner,page FROM session_pages WHERE session_id=?`).bind(session).all<{ owner: string; page: number }>()).results;
  const expected: Record<string, number> = {};
  for (const at of pages) for (const record of (await readPage(env, 'project', session, at.owner, at.page))!) if (record.k === 'prompt') expected[record.id] = at.page;
  await db.prepare(`UPDATE session_prompts SET page=NULL WHERE session_id=?`).bind(session).run();
  await db.prepare(`UPDATE session_documents SET locate_after=NULL WHERE session_id=?`).bind(session).run();
  return { env, blobs, expected, at: t0 + 11 * MIN };
}

/** A store that sums the rows each statement reports reading (D1 reports them; the native store reports none). */
function rowsRead(db: RelationalStore) {
  let read = 0;
  const add = (meta: unknown) => { read += Number((meta as { rows_read?: number } | undefined)?.rows_read ?? 0); };
  const own = new WeakMap<PreparedStatement, PreparedStatement>();
  const wrap = (statement: PreparedStatement): PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: async <T,>() => { const result = await statement.all<T>(); add((result as { meta?: unknown }).meta); return (result.results[0] ?? null) as T | null; },
      all: async <T,>() => { const result = await statement.all<T>(); add((result as { meta?: unknown }).meta); return result; },
      run: async () => { const result = await statement.run(); add(result.meta); return result; },
    } as PreparedStatement;
    own.set(wrapped, statement);
    return wrapped;
  };
  const store = { ...db, prepare: (sql: string) => wrap(db.prepare(sql)), batch: async (statements: PreparedStatement[]) => {
    const results = await db.batch(statements.map((statement) => own.get(statement) ?? statement));
    for (const result of results) add(result.meta);
    return results;
  } } as RelationalStore;
  return { store, read: () => read };
}

test('a document written before page locators has every prompt located by publisher wakes, each reading a bounded share', async () => {
  await withDocumentStores(async (db, name) => {
    const { env, blobs, expected, at } = await unlocated(db, 'session', 20);
    const get = blobs.get.bind(blobs);
    let gets = 0;
    blobs.get = async (...args: Parameters<typeof get>) => { gets += 1; return get(...args); };
    const perWake: number[] = [];
    for (let wake = 0; wake < 10; wake += 1) {
      gets = 0;
      const report = await publishDocuments(env, at, limits());
      perWake.push(gets);
      if (!report.more) break;
    }
    const located = Object.fromEntries((await db.prepare(`SELECT prompt_id,page FROM session_prompts WHERE session_id='session'`)
      .all<{ prompt_id: string; page: number }>()).results.map((row) => [row.prompt_id, row.page]));
    expect({ located, wakes: perWake.length > 1, bounded: perWake.every((n) => n <= LOCATE_CHUNKS_PER_WAKE) }, name)
      .toEqual({ located: expected, wakes: true, bounded: true });
  });
});

test('a locator wake reads the same catalog rows for the same prompts however many the document still holds', async () => {
  await withDocumentStores(async (db, name) => {
    const wake = async (session: string, turns: number) => {
      const { env } = await unlocated(db, session, turns);
      const counted = rowsRead(db);
      const report = await locatePrompts({ ...env, db: counted.store }, limits());
      return { located: report.changed, rowsRead: counted.read() };
    };
    const short = await wake('short', 20);
    await db.prepare(`UPDATE session_prompts SET page=0 WHERE session_id='short'`).run();
    expect(await wake('long', 60), name).toEqual(short);
  });
});

test('a session too large for one pass commits progress on every pass under the wake budget and converges', async () => {
  await withDocumentStores(async (db, name) => {
    // Sixty transcripts, each its own turn, whose pages fill more chunks than one wake's blob calls can rewrite.
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const shell = (id: string, bytes: number) => item('response_item', { type: 'function_call', call_id: id, name: 'shell',
      arguments: JSON.stringify({ command: `npm test ${id}`, env: 'x'.repeat(bytes) }) }) + item('response_item', { type: 'function_call_output', call_id: id, output: 'ok' });
    const transcripts = Array.from({ length: 60 }, (_, i) => `tx_${String(i).padStart(32, '0')}`);
    const offsets = new Map<string, number>();
    let calls = 0;
    let env: Pick<ServerEnv, 'db' | 'blobs'> = { db, blobs };
    const grow = async (text: (t: number) => string, at: number) => {
      for (const [i, t] of transcripts.entries()) {
        const bytes = text(i);
        env = await captureDocumentTranscript(db, blobs, 'session', t, bytes, at, offsets.get(t) ?? 0, 'codex');
        offsets.set(t, (offsets.get(t) ?? 0) + bytes.length);
      }
    };
    await grow((i) => user(`turn-${i}`, `task ${i}`) + shell(`c${calls++}`, 50_000) + shell(`c${calls++}`, 50_000) + shell(`c${calls++}`, 50_000), t0);
    for (let more = true; more;) more = (await publishDocuments(env, t0 + MIN, limits())).more;
    expect(Number((await one(db, `SELECT COUNT(DISTINCT chunk_no) n FROM session_pages`))!.n), name).toBeGreaterThan(8);

    // Every transcript grows by one call: the pass touches every turn's chunk, more than one wake's blob calls can rewrite.
    await grow(() => shell(`c${calls++}`, 2_000), t0 + 2 * MIN);
    let published = Number((await counters(db, 'session'))!.tool_calls);
    for (let pass = 0; ; pass += 1) {
      expect(pass, name).toBeLessThan(10);
      const measured = measuredContentEnv(env, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: CONTENT_BLOB_LIMIT });
      const report = await publishDocuments(measured.env, t0 + 2 * MIN + pass, limits());
      const held = Number((await counters(db, 'session'))!.tool_calls);
      if (published < calls) expect(held, `${name} pass ${pass}`).toBeGreaterThan(published);
      published = held;
      if (!report.more) break;
    }
    expect(await counters(db, 'session'), name).toMatchObject({ tool_calls: calls, prompts: 60, due_at: null });
    expect((await statusMetadata(db)).documentPublishFailure, name).toBeNull();
  });
}, 120_000);

test('a session whose publication keeps failing backs off and is recorded while another session converts in the same wake', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const first = user('turn-1', 'run the tests') + reply('running');
    const env = await captureDocumentTranscript(db, blobs, 'session', tx, first, t0, 0, 'codex');
    await publishDocuments(env, t0 + MIN, limits());
    await captureDocumentTranscript(db, blobs, 'session', tx, reply('still running'), t0 + 2 * MIN, first.length, 'codex');
    await captureDocumentSession(db, 'project', 'old', { blobs });
    await db.prepare(`UPDATE session_documents SET state='convert',generation=NULL,due_at=NULL WHERE session_id='old'`).run();
    await db.prepare(`DELETE FROM publish_queue WHERE session_id='old'`).run();

    // The live session's chunk objects can no longer be read, so every pass over it fails by name.
    const lost = new Set((await db.prepare(`SELECT b.generation,c.blob_key FROM session_chunks c JOIN blobs b ON b.project_id=c.project_id AND b.key=c.blob_key
      WHERE c.session_id='session'`).all<{ generation: string | null; blob_key: string }>()).results.map((row) => blobObjectKey('project', row.blob_key, row.generation)));
    const get = blobs.get.bind(blobs);
    blobs.get = async (key, options) => (lost.has(key) ? null : get(key, options));

    const now = t0 + 3 * MIN;
    await publishDocuments(env, now, limits());
    expect(await one(db, `SELECT state FROM session_documents WHERE session_id='old'`), name).toEqual({ state: 'live' });
    expect(Number((await counters(db, 'session'))!.due_at), name).toBeGreaterThan(now);
    expect(documentPublishFailureFinding((await statusMetadata(db)).documentPublishFailure, now), name)
      .toEqual({ kind: 'document_publish_failed', tone: 'warn', failures: 1, lastFailedAt: now, failure: 'document_object_missing' });
  });
});

/** Drives wake-budget passes over unchanged input: every pass must add to `field` until it reaches `target`. */
async function convergesUnderWakeBudget(env: Pick<ServerEnv, 'db' | 'blobs'>, session: string, at: number, field: 'tool_calls' | 'replies', target: number, name: string) {
  for (let pass = 0, held = Number((await counters(env.db, session))![field]); held < target; pass += 1) {
    expect(pass, name).toBeLessThan(20);
    const measured = measuredContentEnv(env, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: CONTENT_BLOB_LIMIT });
    await publishDocuments(measured.env, at + pass, limits());
    const now = Number((await counters(env.db, session))![field]);
    expect(now, `${name} pass ${pass}`).toBeGreaterThan(held);
    held = now;
  }
  expect((await statusMetadata(env.db)).documentPublishFailure, name).toBeNull();
}

test('turns packed in one chunk whose pages each grow past it commit progress on every wake-budget pass', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const transcripts = Array.from({ length: 60 }, (_, i) => `tx_${String(i).padStart(32, '0')}`);
    let env: Pick<ServerEnv, 'db' | 'blobs'> = { db, blobs };
    const opened = new Map(transcripts.map((t, i) => [t, user(`turn-${i}`, `small task ${i}`)]));
    for (const [t, text] of opened) env = await captureDocumentTranscript(db, blobs, 'packed', t, text, t0, 0, 'codex');
    for (let more = true; more;) more = (await publishDocuments(env, t0 + MIN, limits())).more;
    expect(await one(db, `SELECT prompts,next_chunk FROM session_documents WHERE session_id='packed'`), name).toEqual({ prompts: 60, next_chunk: 1 });

    // Each turn gains one call too large to share a chunk with many others, so rewriting the one chunk spills into many.
    for (const [i, t] of transcripts.entries()) {
      const big = item('response_item', { type: 'function_call', call_id: `big-${i}`, name: 'shell', arguments: JSON.stringify({ command: 'run', env: 'x'.repeat(250_000) }) });
      env = await captureDocumentTranscript(db, blobs, 'packed', t, big, t0 + 2 * MIN, opened.get(t)!.length, 'codex');
    }
    await convergesUnderWakeBudget(env, 'packed', t0 + 40 * MIN, 'tool_calls', 60, name);
  });
}, 120_000);

test('queued events with stored bodies commit progress on every wake-budget pass', async () => {
  await withDocumentStores(async (db, name) => {
    const blobs = memoryBlobStore(), t0 = Date.now();
    const issued = await captureDocumentSession(db, 'project', 'queue', { blobs });
    const env = { db, blobs };
    await publishDocuments(env, t0, limits());
    const stored = async (text: string) => {
      const key = await sha256Hex(text), source = crypto.randomUUID();
      await prepareDerivedStream(env, { projectId: 'project', sessionId: 'queue', tokenId: issued.tokenId, sourceKind: 'event', eventId: source, resourceId: source, envelopeHash: source },
        { size: new TextEncoder().encode(text).length, digest: key, stream: () => new Blob([text]).stream() }, t0);
      return key;
    };
    const queue = async (n: number, kind: 'prompt' | 'response', payload: (i: number) => Record<string, unknown>) => {
      for (let i = 0; i < n; i++) {
        const event = envelope({ eventId: uuid(8000 + i + (kind === 'prompt' ? 500 : 0)), sessionId: 'queue', kind, createdAt: t0 + i, payload: payload(i) });
        expect((await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: t0 }, event, env)).persisted, name).toBe(true);
      }
    };
    // Later turns fill chunks past the one holding the session's first turn.
    const filler = await stored('later turn '.repeat(20_000));
    await queue(6, 'prompt', (i) => ({ promptId: uuid(9500 + i), origin: 'user', blob: filler }));
    for (let more = true; more;) more = (await publishDocuments(env, t0 + 1, limits())).more;
    expect(Number((await one(db, `SELECT next_chunk n FROM session_documents WHERE session_id='queue'`))!.n), name).toBeGreaterThan(1);

    // Sixty replies to the first turn, each reading a stored body larger than a page: every one rewrites that turn's
    // chunk and adds a body chunk.
    const body = await stored('large queued reply '.repeat(16_000));
    await queue(60, 'response', (i) => ({ responseId: uuid(9000 + i), promptId: uuid(20), blob: body }));
    await convergesUnderWakeBudget(env, 'queue', t0 + 40 * MIN, 'replies', 61, name);
    expect(await one(db, `SELECT COUNT(*) n FROM publish_queue WHERE session_id='queue'`), name).toEqual({ n: 0 });
  });
}, 120_000);

test('a pass that fails while new input arrives leaves the session due', async () => {
  await withDocumentStores(async (db, name) => {
    const blobs = memoryBlobStore(), t0 = Date.now();
    const issued = await captureDocumentSession(db, 'project', 'race', { blobs });
    const env = { db, blobs };
    await publishDocuments(env, t0, limits());
    const enqueue = (i: number) => ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: t0 + i },
      envelope({ eventId: uuid(10000 + i), sessionId: 'race', kind: 'response', createdAt: t0 + i, payload: { responseId: uuid(11000 + i), promptId: uuid(20), text: 'later' } }), env);
    await enqueue(1);
    // The pass's document read is held while another event is queued, then fails as missing.
    let started!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    const pass = publishDocuments({ db, blobs: { ...blobs, get: async () => { started(); await held; return null; } } }, t0 + 40 * MIN, limits());
    await reading;
    await enqueue(2);
    release();
    await pass;
    expect(documentPublishFailureFinding((await statusMetadata(db)).documentPublishFailure, t0 + 40 * MIN)?.failure, name).toBe('document_object_missing');
    expect((await counters(db, 'race'))!.due_at, name).toBe(0);
  });
}, 60_000);

test('a merge that outgrows its page moves that record alone, so the rest of the turn stays unwritten', async () => {
  await withDocumentStores(async (db, name) => {
    const blobs = memoryBlobStore(), t0 = Date.now();
    const issued = await captureDocumentSession(db, 'project', 'grown', { blobs });
    const env = { db, blobs };
    await publishDocuments(env, t0, limits());
    // The session's turn holds an outcome-only tool record on its first page, then pages of large calls over many chunks.
    const target = uuid(20000);
    await seedRecords(env, 'grown', [
      documentRecord('tool.use', { toolCallId: target, promptId: uuid(20), toolName: 'unknown', input: {}, success: true }, t0, { received_at: t0, call: null })!,
      ...Array.from({ length: 80 }, (_, i) => documentRecord('tool.use', { toolCallId: uuid(21000 + i), promptId: uuid(20), toolName: 'shell',
        input: { command: 'fill', env: 'x'.repeat(250_000) }, success: true }, t0, { received_at: t0 })!),
    ], t0 + 1);
    const at = t0 + 40 * MIN;
    const ctx = { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: at };
    expect((await ingestEvent(db, ctx, envelope({ eventId: uuid(22000), sessionId: 'grown', kind: 'tool.use', createdAt: at + 1,
      payload: { toolCallId: target, promptId: uuid(20), toolName: 'shell', input: { command: 'grow', env: 'y'.repeat(50_000) }, success: true } }), env)).persisted, name).toBe(true);
    const held = new Set((await db.prepare(`SELECT chunk_no n FROM session_chunks WHERE session_id='grown' AND kind='page'`).all<{ n: number }>()).results.map((row) => row.n));
    await publishDocuments(env, at, limits());
    expect(await one(db, `SELECT COUNT(*) n FROM publish_queue WHERE session_id='grown'`), name).toEqual({ n: 0 });
    const written = (await db.prepare(`SELECT COUNT(*) n FROM retired_objects WHERE session_id='grown' AND retired_at=?`).bind(at).first<{ n: number }>())!.n;
    expect(written, name).toBeLessThanOrEqual(3);
    expect(held.size, name).toBeGreaterThan(written);
    const last = Number((await one(db, `SELECT MAX(page) p FROM session_pages WHERE session_id='grown' AND owner=?`, uuid(20)))!.p);
    expect((await readPage({ db, blobs }, 'project', 'grown', uuid(20), last))!.at(-1), name).toMatchObject({ id: target, summary: 'grow' });
    expect(await counters(db, 'grown'), name).toMatchObject({ tool_calls: 82 });
  });
}, 120_000);

test('a failed pass leaves the session due when its queued event was consumed and replaced', async () => {
  await withDocumentStores(async (db, name) => {
    const blobs = memoryBlobStore(), t0 = Date.now();
    const issued = await captureDocumentSession(db, 'project', 'aba', { blobs });
    const env = { db, blobs };
    await publishDocuments(env, t0, limits());
    const enqueue = (i: number) => ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: t0 + i },
      envelope({ eventId: uuid(23000 + i), sessionId: 'aba', kind: 'response', createdAt: t0 + i, payload: { responseId: uuid(24000 + i), promptId: uuid(20), text: 'later' } }), env);
    await enqueue(1);
    // While a pass's document read is held, another pass consumes the queued event and a new one takes its place.
    let started!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    const pass = publishDocuments({ db, blobs: { ...blobs, get: async () => { started(); await held; return null; } } }, t0 + 40 * MIN, limits());
    await reading;
    await publishDocuments(env, t0 + 40 * MIN + 1, limits());
    await enqueue(2);
    release();
    await pass;
    expect(await one(db, `SELECT COUNT(*) n FROM publish_queue WHERE session_id='aba'`), name).toEqual({ n: 1 });
    expect((await counters(db, 'aba'))!.due_at, name).toBe(0);
  });
}, 60_000);

/** A shell call and its result, which the parser publishes whole. */
const ran = (id: string) => item('response_item', { type: 'function_call', call_id: id, name: 'shell', arguments: JSON.stringify({ command: `step ${id}` }) })
  + item('response_item', { type: 'function_call_output', call_id: id, output: 'ok' });

/** Places records on a session's live document with no budget, as an earlier publisher would have. */
async function seedRecords(env: Pick<ServerEnv, 'db' | 'blobs'>, session: string, records: readonly DocRecord[], at: number) {
  const db = env.db;
  const doc = await one(db, `SELECT d.*,s.created_by_token_id token_id FROM session_documents d JOIN sessions s USING(project_id,session_id) WHERE d.session_id=?`, session);
  const [chunks, pages] = await db.batch(directoryStatements(db, 'project', session));
  const seed = new DocumentBatch(env, 'project', session, doc as never, chunks!.results as ChunkRow[], pages!.results as PageRow[]);
  await seed.open();
  await seed.place(records, null);
  await seed.commit(true, 'live', at, () => ({ sql: '1', params: [] }), () => {
    const set = seed.documentSet(at);
    return { before: [], after: [db.prepare(`UPDATE session_documents SET ${set.sql} WHERE project_id='project' AND session_id=?`).bind(...set.params, session)] };
  });
}

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
    const fill = (i: number) => documentRecord('tool.use', { toolCallId: uuid(31000 + i), promptId: turn, toolName: 'shell',
      input: { command: 'fill', env: 'x'.repeat(i === 0 ? 260_000 : 250_000) }, success: true }, t0, { received_at: t0 })!;
    const seeded = 260;
    await seedRecords(env, 'wide', [
      documentRecord('tool.use', { toolCallId: late, promptId: turn, toolName: 'unknown', input: {}, success: true }, t0, { received_at: t0, call: null })!,
      ...Array.from({ length: seeded }, (_, i) => fill(i)),
    ], t0 + MIN);
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
    expect(await counters(db, 'resume'), name).toEqual(counted);

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
    let size = end, placed = 0, parts = 0;
    for (let round = 0; Number((await frontier())!.o) < end; round += 1) {
      expect(round, name).toBeLessThan(30);
      await pass();
      const now = Number((await frontier())!.n);
      if (now > 0) {
        expect(now, `${name} pass ${round}`).toBeGreaterThan(placed);
        placed = now;
        parts += 1;
      }
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

test('step 116 makes a quiet session due for every clearable stop, and the publication resumes', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN, blobs = memoryBlobStore();
    const first = user('turn-1', 'first') + ran('a1');
    const env = await captureDocumentTranscript(db, blobs, 'receipt', tx, first, t0, 0, 'codex');
    await publishDocuments(env, t0 + MIN, limits());
    await captureDocumentTranscript(db, blobs, 'receipt', tx, ran('a2'), t0 + 2 * MIN, first.length, 'codex');
    await db.prepare(`UPDATE transcript_publication SET state='failed',failure='receipt_absent' WHERE transcript_id=?`).bind(tx).run();
    await db.prepare(`UPDATE session_documents SET due_at=NULL WHERE session_id='receipt'`).run();
    expect((await documentPublicationStoppedFinding(db))?.failure, name).toBe('receipt_absent');
    await db.prepare(V116_STATEMENTS.at(-1)!).run();
    await publishDocuments(env, t0 + 3 * MIN, limits());
    expect(await counters(db, 'receipt'), name).toMatchObject({ tool_calls: 2, due_at: null });
    expect(await documentPublicationStoppedFinding(db), name).toBeNull();
  });
}, 60_000);

test('restores legacy artifact rows directly into documents and keeps a repeated restore idempotent', async () => {
  await withDocumentStores(async (db, name) => {
    const blobs = memoryBlobStore();
    const env = await captureDocumentSession(db, 'project', 'source', { blobs });
    const source = (await db.prepare(`SELECT * FROM sessions WHERE project_id='project' AND session_id='source'`).first<Record<string, unknown>>())!;
    const prompt = { project_id:'project', session_id:'restored', prompt_id:uuid(980), parent_prompt_id:null, text:'Retained artifact content',
      blob_key:null, origin:'user', created_at:100, received_at:100, content_hash:await sha256Hex('Retained artifact content') };
    const continuation = JSON.stringify({planPosition:3});
    const rows = [{t:'sessions',r:{...source,session_id:'restored'}},{t:'prompt_batches',r:prompt},
      {t:'transcripts',r:{project_id:'project',session_id:'restored',transcript_id:tx,machine_id:'machine',token_id:source.created_by_token_id,
        first_received_at:100,last_received_at:100,agent:'opencode',size:42,segment_count:0,parsed_offset:42,parse_segment_lines:1,
        prompt_identity_scheme:'stamp-or-offset-v1',record_identity_scheme:'legacy-session-v1',
        parser_context:JSON.stringify({mycoParserState:{chunked:true,digest:await sha256Hex(continuation)}})}},
      {t:'transcript_parser_state_chunks',r:{project_id:'project',transcript_id:tx,cursor_offset:42,chunk_index:0,chunk_count:1,payload:continuation}}];
    const header = {format:BACKUP_FORMAT,deploymentId:await deploymentId(db),schemaVersion:115,createdAt:100,producer:'test',
      counts:{sessions:1,prompt_batches:1,transcripts:1,transcript_parser_state_chunks:1}};
    const text = [header,...rows].map(row=>JSON.stringify(row)).join('\n')+'\n';
    const first = await restoreArtifact(db, {text,blobs,authorization:{kind:'recovery'}});
    expect(first.documents, name).toMatchObject({convert:1,merge:0});
    expect(await counters(db,'restored'), name).toMatchObject({prompts:1,user_prompts:1});
    expect(await db.prepare(`SELECT published_offset FROM transcript_publication WHERE project_id='project' AND session_id='restored'`).first(),name)
      .toEqual({published_offset:42});
    await publishDocuments({db,blobs},Date.now(),limits());
    await restoreArtifact(db, {text,blobs,authorization:{kind:'recovery'}});
    expect(await counters(db,'restored'), name).toMatchObject({prompts:1,user_prompts:1});
    expect(await db.prepare(`SELECT 1 FROM sqlite_master WHERE name='prompt_batches'`).first(), name).toBeNull();
  });
});

test('portable backups restore published document bodies and frontiers into destination blob generations', async () => {
  const artifacts=new Map<string,{text:string;blobs:ReturnType<typeof memoryBlobStore>;rows:Record<string,unknown>[];prompt:string}>();
  const body='retained document body '.repeat(16000);
  await withDocumentStores(async(db,name)=>{
    const blobs=memoryBlobStore();
    const env=await captureDocumentTranscript(db,blobs,'portable',tx,user('portable-turn',body),Date.now(),0,'codex');
    for(let pass=0;pass<20;pass++)if(!(await publishDocuments(env,Date.now()+TRANSCRIPT_IDLE_MS*2,limits())).more)break;
    const prompt=await db.prepare(`SELECT prompt_id FROM session_prompts WHERE session_id='portable'`).first<{prompt_id:string}>();
    expect(prompt,name).not.toBeNull();
    const backup=await createBackup(db,blobs,{producer:'test',now:Date.now()});
    artifacts.set(name,{text:(await backupArtifact(db,blobs,backup.id))!.text,blobs,
      rows:(await db.prepare('SELECT * FROM blobs').all<Record<string,unknown>>()).results,prompt:prompt!.prompt_id});
  });
  await withDocumentStores(async(db,name)=>{
    const source=artifacts.get(name)!,blobs=memoryBlobStore();
    for(const row of source.rows){
      const generation=uuid(99000),columns=Object.keys(row),original=source.blobs.objects.get(blobObjectKey(String(row.project_id),String(row.key),row.generation as string|null))!;
      await db.prepare(`INSERT INTO blobs(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`)
        .bind(...columns.map(column=>column==='generation'?generation:row[column])).run();
      blobs.seed(blobObjectKey(String(row.project_id),String(row.key),generation),original);
    }
    await restoreArtifact(db,{text:source.text,blobs,allowForeignLineage:true,authorization:{kind:'recovery'}});
    await db.prepare('DELETE FROM events').run();
    await db.prepare('DELETE FROM transcript_segments').run();
    const locator=(await db.prepare(`SELECT generation,turn_key AS owner,page FROM session_prompts WHERE session_id='portable' AND prompt_id=?`).bind(source.prompt).first<{generation:number;owner:string;page:number}>())!;
    const restoredBody=await documentBody({db,blobs},'project','portable','prompt',source.prompt,locator);
    expect(restoredBody?.length,name).toBe(body.length);
    expect(restoredBody===body,name).toBe(true);
    const frontier=await db.prepare(`SELECT published_offset FROM transcript_publication WHERE session_id='portable'`).first();
    expect(frontier,name).not.toBeNull();
    await restoreArtifact(db,{text:source.text,blobs,allowForeignLineage:true,authorization:{kind:'recovery'}});
    expect(await counters(db,'portable'),name).toMatchObject({prompts:1,user_prompts:1});
    expect(await db.prepare(`SELECT published_offset FROM transcript_publication WHERE session_id='portable'`).first(),name).toEqual(frontier);
  });
});
