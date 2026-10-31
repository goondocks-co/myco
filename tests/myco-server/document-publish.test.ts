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
import { prepareArchive } from '@myco-server-worker/core/event-content.js';
import { bundleArchiveStatements } from '@myco-server-worker/core/archive-bundle.js';
import { BACKUP_FORMAT, deploymentId, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { cleanupCandidate } from '@myco-server-worker/core/storage-cleanup.js';
import { prepareDerivedStream } from '@myco-server-worker/core/registered-content.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { CONTENT_BLOB_LIMIT, measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { documentPublishFailureFinding } from '@myco-server-worker/core/attention-state.js';
import { statusMetadata } from '@myco-server-worker/read/meta.js';
import { WAKE_JOB_STATEMENT_LIMIT } from '@myco-server-worker/core/tick.js';
import { captureViewSession, captureViewTranscript, withViewStores } from './helpers/view-stores.js';
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
  await withViewStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const first = user('turn-1', 'run the tests') + reply('running') + call;
    const env = await captureViewTranscript(db, blobs, 'session', tx, first, t0, 0, 'codex');

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
    await captureViewTranscript(db, blobs, 'session', tx, output + user('turn-2', 'ship it'), t0 + 12 * MIN, first.length, 'codex');
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
  await withViewStores(async (db, name) => {
    const blobs = memoryBlobStore();
    const issued = await captureViewSession(db, 'project', 'hook', { blobs });
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
  await withViewStores(async (db, name) => {
    const blobs = memoryBlobStore();
    await captureViewSession(db, 'project', 'ack', { blobs });
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

    await captureViewSession(db, 'project', 'ack', { blobs, idOffset: 100 });
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
  await withViewStores(async (db, name) => {
    const blobs = memoryBlobStore();
    await captureViewSession(db, 'project', 'archived', { blobs });
    const row = await cleanupCandidate(db, { project_id: 'project', resource_id: uuid(2), resource_kind: 'event' }, true);
    await db.batch(bundleArchiveStatements(db, (await prepareArchive({ db, blobs }, 'event', row!, Date.now())).bundle));
    const rows: { t: string; r: Record<string, unknown> }[] = [];
    for (const t of ['members', 'member_credentials', 'sessions', 'blobs', 'archive_bundles', 'registered_content_proofs', 'events', 'raw_credentials'])
      for (const r of (await db.prepare(`SELECT * FROM ${t}`).all<Record<string, unknown>>()).results) rows.push({ t, r });
    artifacts.set(name, { rows, blobs });
  });
  await withViewStores(async (db, name) => {
    const { rows, blobs } = artifacts.get(name)!;
    const issued = await captureViewSession(db, 'project', 'bootstrap', { blobs, idOffset: 10_000 });
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
  const env = await captureViewTranscript(db, blobs, session, `tx_${[...session].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(32, '0').slice(0, 32)}`, text, t0, 0, 'codex');
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
  await withViewStores(async (db, name) => {
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
  await withViewStores(async (db, name) => {
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
  await withViewStores(async (db, name) => {
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
        env = await captureViewTranscript(db, blobs, 'session', t, bytes, at, offsets.get(t) ?? 0, 'codex');
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
  await withViewStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const first = user('turn-1', 'run the tests') + reply('running');
    const env = await captureViewTranscript(db, blobs, 'session', tx, first, t0, 0, 'codex');
    await publishDocuments(env, t0 + MIN, limits());
    await captureViewTranscript(db, blobs, 'session', tx, reply('still running'), t0 + 2 * MIN, first.length, 'codex');
    await captureViewSession(db, 'project', 'old', { blobs });
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
  await withViewStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const transcripts = Array.from({ length: 60 }, (_, i) => `tx_${String(i).padStart(32, '0')}`);
    let env: Pick<ServerEnv, 'db' | 'blobs'> = { db, blobs };
    const opened = new Map(transcripts.map((t, i) => [t, user(`turn-${i}`, `small task ${i}`)]));
    for (const [t, text] of opened) env = await captureViewTranscript(db, blobs, 'packed', t, text, t0, 0, 'codex');
    for (let more = true; more;) more = (await publishDocuments(env, t0 + MIN, limits())).more;
    expect(await one(db, `SELECT prompts,next_chunk FROM session_documents WHERE session_id='packed'`), name).toEqual({ prompts: 60, next_chunk: 1 });

    // Each turn gains one call too large to share a chunk with many others, so rewriting the one chunk spills into many.
    for (const [i, t] of transcripts.entries()) {
      const big = item('response_item', { type: 'function_call', call_id: `big-${i}`, name: 'shell', arguments: JSON.stringify({ command: 'run', env: 'x'.repeat(250_000) }) });
      env = await captureViewTranscript(db, blobs, 'packed', t, big, t0 + 2 * MIN, opened.get(t)!.length, 'codex');
    }
    await convergesUnderWakeBudget(env, 'packed', t0 + 40 * MIN, 'tool_calls', 60, name);
  });
}, 120_000);

test('queued events with stored bodies commit progress on every wake-budget pass', async () => {
  await withViewStores(async (db, name) => {
    const blobs = memoryBlobStore(), t0 = Date.now();
    const issued = await captureViewSession(db, 'project', 'queue', { blobs });
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
  await withViewStores(async (db, name) => {
    const blobs = memoryBlobStore(), t0 = Date.now();
    const issued = await captureViewSession(db, 'project', 'race', { blobs });
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

test('a merge whose page reflows across chunks read during its placement is refused before the commit it cannot pay', async () => {
  await withViewStores(async (db, name) => {
    const blobs = memoryBlobStore(), t0 = Date.now();
    const issued = await captureViewSession(db, 'project', 'reflow', { blobs });
    const env = { db, blobs };
    await publishDocuments(env, t0, limits());
    // The session's turn holds an outcome-only tool record on its first page, then pages of large calls over many chunks.
    const doc = await one(db, `SELECT d.*,s.created_by_token_id token_id FROM session_documents d JOIN sessions s USING(project_id,session_id) WHERE d.session_id='reflow'`);
    const [chunks, pages] = await db.batch(directoryStatements(db, 'project', 'reflow'));
    const seed = new DocumentBatch(env, 'project', 'reflow', doc as never, chunks!.results as ChunkRow[], pages!.results as PageRow[]);
    await seed.open();
    const target = uuid(20000);
    await seed.place([
      documentRecord('tool.use', { toolCallId: target, promptId: uuid(20), toolName: 'unknown', input: {}, success: true }, t0, { received_at: t0, call: null })!,
      ...Array.from({ length: 80 }, (_, i) => documentRecord('tool.use', { toolCallId: uuid(21000 + i), promptId: uuid(20), toolName: 'shell',
        input: { command: 'fill', env: 'x'.repeat(250_000) }, success: true }, t0, { received_at: t0 })!),
    ], null);
    await seed.commit(true, 'live', t0 + 1, () => ({ sql: '1', params: [] }), () => {
      const set = seed.documentSet(t0 + 1);
      return { before: [], after: [db.prepare(`UPDATE session_documents SET ${set.sql} WHERE project_id='project' AND session_id='reflow'`).bind(...set.params)] };
    });
    expect(Number((await one(db, `SELECT COUNT(*) n FROM session_chunks WHERE session_id='reflow' AND kind='page'`))!.n), name).toBeLessThan(50);

    // A short reply no turn holds, then the call with a large input: merging it grows the turn's first page and reflows
    // the turn through chunks read only during that placement, more than one wake can rewrite. The reply still commits.
    const at = t0 + 40 * MIN;
    const ctx = { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: at };
    expect((await ingestEvent(db, ctx, envelope({ eventId: uuid(22001), sessionId: 'reflow', kind: 'response', createdAt: at,
      payload: { responseId: uuid(22002), promptId: uuid(22003), text: 'short' } }), env)).persisted, name).toBe(true);
    expect((await ingestEvent(db, ctx, envelope({ eventId: uuid(22000), sessionId: 'reflow', kind: 'tool.use', createdAt: at + 1,
      payload: { toolCallId: target, promptId: uuid(20), toolName: 'shell', input: { command: 'grow', env: 'y'.repeat(50_000) }, success: true } }), env)).persisted, name).toBe(true);
    await publishDocuments(measuredContentEnv(env, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: CONTENT_BLOB_LIMIT }).env, at, limits());
    expect(await counters(db, 'reflow'), name).toMatchObject({ replies: 2 });
    expect(await one(db, `SELECT COUNT(*) n FROM publish_queue WHERE session_id='reflow'`), name).toEqual({ n: 1 });
    expect((await statusMetadata(db)).documentPublishFailure, name).toBeNull();
  });
}, 120_000);

test('a failed pass leaves the session due when its queued event was consumed and replaced', async () => {
  await withViewStores(async (db, name) => {
    const blobs = memoryBlobStore(), t0 = Date.now();
    const issued = await captureViewSession(db, 'project', 'aba', { blobs });
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
