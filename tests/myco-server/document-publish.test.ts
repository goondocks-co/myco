import { expect, test } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { publishDocuments, RETIRED_OBJECT_GRACE_MS } from '@myco-server-worker/ingest/publish.js';
import { readPage } from '@myco-server-worker/content/document-reader.js';
import { SESSION_OWNER, type DocRecord } from '@myco-server-worker/content/document.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
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
