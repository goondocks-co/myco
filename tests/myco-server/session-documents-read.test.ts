import { expect, test } from 'bun:test';
import type { ContentStore, PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { listCatalogTurns } from '@myco-server-worker/read/document-catalog.js';
import { documentPromptTools, documentTurnCollection, documentTurnDetail, documentUnplacedRecords } from '@myco-server-worker/content/session-turns.js';
import { DocumentBatch, directoryStatements, type BatchDocument } from '@myco-server-worker/ingest/document-batch.js';
import type { ChunkRow, PageRow } from '@myco-server-worker/content/document-reader.js';
import type { DocRecord } from '@myco-server-worker/content/document.js';
import { documentBody } from '@myco-server-worker/content/session-pages.js';
import { documentSessionActivity } from '@myco-server-worker/content/session-activity.js';
import { listSessionSummaries } from '@myco-server-worker/read/sessions.js';
import { listUnplacedHookRecords } from '@myco-server-worker/read/hook-placement.js';
import { searchProject } from '@myco-server-worker/read/search.js';
import { captureViewTranscript, withViewStores } from './helpers/view-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';

const MIN = 60_000;
const scope = { projectId: 'project' };
const item = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload }) + '\n';
const user = (turn: string, text: string) =>
  item('turn_context', { turn_id: turn }) + item('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const reply = (text: string) => item('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const call = (id: string, name: string, args: Record<string, unknown>) =>
  item('response_item', { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const output = (id: string, text: string) => item('response_item', { type: 'function_call_output', call_id: id, output: text });
const limits = () => ({ calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
/** Attachments `<session>-001…` on a prompt, all at `from`. */
const attach = (db: RelationalStore, session: string, prompt: string, n: number, from: number) => db.prepare(`INSERT INTO attachments(project_id,attachment_id,session_id,prompt_id,event_id,blob_key,media_type,byte_size,created_at,token_id,received_at)
  SELECT 'project',?1||printf('-%03d',value),?1,?2,event_id,'key','text/plain',1,?3,token_id,1 FROM json_each(?4) CROSS JOIN (SELECT event_id,token_id FROM events LIMIT 1)`)
  .bind(session, prompt, from, JSON.stringify(Array.from({ length: n }, (_, i) => i + 1))).run();

/** Places records into a session's live document as a publisher pass would. */
async function place(env: ContentStore, session: string, records: DocRecord[]) {
  const db = env.db;
  const [docs, chunks, pages] = await db.batch([
    db.prepare(`SELECT d.generation,d.next_chunk,d.prompts,d.first_prompt,d.open_turn_key,s.created_by_token_id token_id FROM session_documents d
      JOIN sessions s ON s.project_id=d.project_id AND s.session_id=d.session_id WHERE d.project_id='project' AND d.session_id=?`).bind(session),
    ...directoryStatements(db, 'project', session),
  ]);
  const batch = new DocumentBatch(env, 'project', session, docs!.results[0] as BatchDocument, chunks!.results as ChunkRow[], pages!.results as PageRow[]);
  await batch.open();
  await batch.place(records, null);
  await batch.commit(true, 'live', Date.now(), () => ({ sql: '1', params: [] }), () => {
    const set = batch.documentSet(Date.now());
    return { before: [], after: [db.prepare(`UPDATE session_documents SET ${set.sql} WHERE project_id='project' AND session_id=?`).bind(...set.params, session)] };
  });
}

/** A codex session of `turns` turns, published: the first turn calls a tool whose input is larger than a page. */
async function published(db: RelationalStore, session: string, tx: string, turns: number, blobs = memoryBlobStore(), opening = '') {
  const t0 = Date.now() - 2 * 60 * MIN;
  let text = opening + user('turn-0', 'run the tests') + reply('running') + call('c1', 'shell', { command: 'npm test', env: 'x'.repeat(300_000) }) + output('c1', 'ok');
  for (let i = 1; i < turns; i += 1) text += user(`turn-${i}`, `step ${i}`) + reply(`done ${i}`) + (i === 1 ? call('c2', 'shell', { command: 'ls' }) : '');
  const env = await captureViewTranscript(db, blobs, session, tx, text, t0, 0, 'codex');
  await publishDocuments(env, t0 + 11 * MIN, limits());
  return { ...env, blobs } as ContentStore;
}

test('a published session reads its turns, a turn with its tools and their full input, and its activity from the document', async () => {
  await withViewStores(async (db, name) => withViewWriterDriver(async () => {
    // A call before the first prompt belongs to no turn.
    const env = await published(db, 'session', 'tx_' + 'a'.repeat(32), 2, memoryBlobStore(), call('c0', 'shell', { command: 'pwd' }));
    const turns = await listCatalogTurns(db, scope, 'session', { origins: ['user'] });
    expect(turns.rows.map((row) => [row.preview, row.toolCallCount, row.responseCount]), name).toEqual([['run the tests', 1, 1], ['step 1', 1, 1]]);

    const first = turns.rows[0]!.promptId;
    const detail = (await documentTurnDetail(env, scope, 'session', first))!;
    expect(detail.prompt.text, name).toBe('run the tests');
    expect(detail.responses.map((row) => row.text), name).toEqual(['running']);
    expect(detail.tools, name).toMatchObject({ total: 1, failed: 0, byTool: [{ toolName: 'shell', count: 1 }] });

    const tools = await documentPromptTools(env, scope, 'session', first, undefined);
    if (tools === null || tools === 'stale') throw new Error('tool page missing');
    const shell = tools.rows[0]!;
    expect(shell, name).toMatchObject({ toolName: 'shell', inputTruncated: true, outputPreview: 'ok', success: true });
    expect(shell.inputBlobKey, name).not.toBeNull();
    const input = await documentBody(env, 'project', 'session', 'tool-input', shell.toolCallId, shell.locator);
    expect(typeof input === 'string' && input.length > 300_000 && JSON.parse(input).command === 'npm test', name).toBe(true);
    expect(await documentBody(env, 'project', 'session', 'tool-input', shell.toolCallId, { ...shell.locator, generation: shell.locator.generation + 1 }), name).toBe('stale');

    // The call the transcript never answered is the session's one activity row, placed on its turn.
    const activity = await documentSessionActivity(env, scope, 'session', {});
    if (activity === null || activity === 'stale') throw new Error('activity missing');
    expect(activity.rows.map((row) => [row.type, row.toolName, row.promptId]).sort(), name).toEqual([['no_result', 'shell', turns.rows[1]!.promptId], ['no_result', 'shell', null]].sort());
    const unplaced = await documentUnplacedRecords(env, scope, 'session', undefined);
    if (unplaced === null || unplaced === 'stale') throw new Error('unplaced records missing');
    expect(unplaced.rows.map((row) => [row.kind, row.label, row.failed]), name).toEqual([['tool', 'shell', true]]);

    // Hook records are placed by the prompts the document holds.
    for (const [id, prompt] of [['placed', first], ['unplaced', 'absent']] as const) {
      await db.prepare(`INSERT INTO attachments(project_id,attachment_id,session_id,prompt_id,event_id,blob_key,media_type,byte_size,created_at,token_id,received_at)
        SELECT 'project',?,'session',?,event_id,'key','text/plain',1,1,token_id,1 FROM events LIMIT 1`).bind(id, prompt).run();
    }
    expect((await documentTurnDetail(env, scope, 'session', first))!.attachments.map((row) => row.attachmentId), name).toEqual(['placed']);
    expect((await listUnplacedHookRecords(db, scope, 'session', {})).rows.map((row) => row.id), name).toContain('unplaced');
    // A collection past its first page continues from the first row that page did not show.
    await attach(db, 'session', first, 51, 1);
    const opened = (await documentTurnDetail(env, scope, 'session', first))!;
    const rest = await documentTurnCollection(env, scope, 'session', first, 'attachments', opened.cursors.attachments!);
    expect([...opened.attachments, ...(rest as { rows: readonly unknown[] }).rows].length, name).toBe(52);

    // The session list labels and counts the session from its catalog row; a card answers a prompt search with its turn.
    const listed = (await listSessionSummaries(db, scope, {}, Date.now())).rows.find((row) => row.sessionId === 'session')!;
    expect([listed.label, listed.promptCount, listed.toolCallCount], name).toEqual(['run the tests', 2, 3]);
    await db.prepare(`UPDATE turn_cards SET state='carded',card='Ran the flaky suite twice' WHERE project_id='project' AND session_id='session' AND turn_key=?`).bind(first).run();
    const hits = await searchProject(db, scope, { query: 'flaky', type: 'prompt', session_id: 'session' });
    expect(hits.results.map((hit) => [hit.id, hit.turn?.prompt_id, hit.turn?.preview]), name).toEqual([[first, first, 'run the tests']]);
    expect((await searchProject(db, scope, { query: 'flaky', type: 'response' })).results.map((hit) => [hit.id, hit.turn?.prompt_id]), name).toEqual([[first, first]]);

    // Every related session is reached, a page at a time.
    await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,launch_parent_session_id)
      SELECT 'project','child'||value,'machine','token',value,value,'session' FROM json_each(?)`).bind(JSON.stringify(Array.from({ length: 60 }, (_, i) => i + 1))).run();
    const related: string[] = [];
    for (let cursor: string | undefined; ;) {
      const read = await documentSessionActivity(env, scope, 'session', { type: 'child_session', limit: 50, cursor });
      if (read === null || read === 'stale') throw new Error('activity page missing');
      related.push(...read.rows.map((row) => row.id));
      if (read.cursor === null) break;
      cursor = read.cursor;
    }
    expect(new Set(related).size, name).toBe(60);

    // A steering prompt past the turn's first pages arrives with the children's continuation.
    await place(env, 'session', [...Array.from({ length: 6 }, (_, i): DocRecord => ({ k: 'reply', id: `large-${i}`, prompt_id: first, text: 'x'.repeat(240_000), created_at: 100 + i })),
      { k: 'prompt', id: 'late-child', prompt_id: null, parent_prompt_id: first, text: 'late steering', origin: 'user', created_at: 110 } as DocRecord]);
    const long = (await documentTurnDetail(env, scope, 'session', first))!;
    const steering = await documentTurnCollection(env, scope, 'session', first, 'children', long.cursors.children!);
    expect((steering as { rows: readonly { prompt: { promptId: string } }[] }).rows.map((row) => row.prompt.promptId), name).toEqual(['late-child']);
    // A steering prompt opens from its own page, at the same cost after 6 large replies as after 40.
    const openCost = async (id: string) => {
      const measured = measuredContentEnv(env, { statements: 10_000, blobCalls: 10_000 });
      const found = (await documentTurnDetail(measured.env, scope, 'session', id))?.prompt.promptId;
      return { found: found === id, statements: measured.usage.statements, blobCalls: measured.usage.blobCalls };
    };
    const afterSix = await openCost('late-child');
    await place(env, 'session', [...Array.from({ length: 34 }, (_, i): DocRecord => ({ k: 'reply', id: `later-${i}`, prompt_id: first, text: 'x'.repeat(240_000), created_at: 200 + i })),
      { k: 'prompt', id: 'later-child', prompt_id: null, parent_prompt_id: first, text: 'later steering', origin: 'user', created_at: 250 } as DocRecord]);
    expect([afterSix, await openCost('later-child')], name).toEqual([{ ...afterSix, found: true }, afterSix]);
  }));
});

test('the session page and its list row read the same statements and rows whatever the session holds', async () => {
  await withViewStores(async (db, name) => {
    const statements = async (env: ContentStore, session: string, attachments: number) => {
      const measured = measuredContentEnv(env, { statements: 10_000, blobCalls: 10_000 });
      let rows = 0;
      const own = new WeakMap<PreparedStatement, PreparedStatement>();
      const counted = (statement: PreparedStatement): PreparedStatement => {
        const wrapped = {
          bind: (...values: unknown[]) => counted(statement.bind(...values)),
          first: async <T,>() => { const row = await statement.first<T>(); if (row !== null) rows += 1; return row; },
          all: async <T,>() => { const result = await statement.all<T>(); rows += result.results.length; return result; },
          run: () => statement.run(),
        } as PreparedStatement;
        own.set(wrapped, statement);
        return wrapped;
      };
      const store = { ...measured.env.db, prepare: (sql: string) => counted(measured.env.db.prepare(sql)),
        batch: async (batch: PreparedStatement[]) => {
          const results = await measured.env.db.batch(batch.map((statement) => own.get(statement) ?? statement));
          for (const result of results) rows += result.results.length;
          return results;
        } } as RelationalStore;
      const turns = await listCatalogTurns(store, scope, session, { origins: ['user'], limit: 5 });
      await attach(env.db, session, turns.rows[0]!.promptId, attachments, 0);
      await documentTurnDetail({ ...measured.env, db: store }, scope, session, turns.rows[0]!.promptId);
      await listSessionSummaries(store, scope, { sessionId: session }, Date.now());
      return { statements: measured.usage.statements, blobCalls: measured.usage.blobCalls, rows, turns: turns.rows.length };
    };
    const blobs = memoryBlobStore();
    // Each session's list row and opening turn, whose attachments share one time and run past one page, cost the same however much either holds.
    const small = await statements(await published(db, 'small', 'tx_' + 'b'.repeat(32), 6, blobs), 'small', 51);
    const large = await statements(await published(db, 'large', 'tx_' + 'c'.repeat(32), 40, blobs), 'large', 120);
    expect(large, name).toEqual({ ...small, turns: 5 });
  });
});
