import { expect, test } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { convertDocuments } from '@myco-server-worker/ingest/document-conversion.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { readPage } from '@myco-server-worker/content/document-reader.js';
import { createEmptyView, requestViewRebuild, tryPublishView } from '@myco-server-worker/ingest/view-lifecycle.js';
import { claimViewBuild, SERIAL_VIEW_BUDGET } from '@myco-server-worker/ingest/view-build-queue.js';
import { parseViewOnce } from '@myco-server-worker/ingest/view-parse.js';
import { captureViewSession, captureViewTranscript, withViewStores } from './helpers/view-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';
import { fixtureFlipEnvelope } from '../helpers/view-flip-envelope.js';

const tx = 'tx_0123456789abcdef0123456789abcdef';
const item = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload }) + '\n';
const transcript = item('turn_context', { turn_id: 'turn-1' })
  + item('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the tests' }] })
  + item('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'running' }] })
  + item('response_item', { type: 'function_call', call_id: 'c1', name: 'shell', arguments: JSON.stringify({ command: 'npm test' }) })
  + item('response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' });
const limits = () => ({ calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
/** The ids today's readers see, by kind: legacy rows, and the live view's rows (`?2`) when the session is published. */
const EFFECTIVE = {
  prompt: 'SELECT prompt_id id FROM prompt_batches WHERE session_id=?1 UNION SELECT prompt_id FROM view_prompts WHERE instance_id=?2',
  reply: 'SELECT response_id id FROM responses WHERE session_id=?1 UNION SELECT response_id FROM view_responses WHERE instance_id=?2',
  tool: 'SELECT tool_call_id id FROM tool_calls WHERE session_id=?1 UNION SELECT tool_call_id FROM view_tool_calls WHERE instance_id=?2',
  plan: 'SELECT plan_key id FROM plans WHERE session_id=?1 UNION SELECT plan_key FROM view_plans WHERE instance_id=?2',
} as const;

/** Marks a session as one that existed before documents: it waits for conversion and has no queued events. */
async function predate(db: RelationalStore, session: string) {
  await db.prepare(`UPDATE session_documents SET state='convert',generation=NULL,due_at=NULL WHERE session_id=?`).bind(session).run();
  await db.prepare(`DELETE FROM publish_queue WHERE session_id=?`).bind(session).run();
}

/** Every record id of a session's live document, by kind. */
async function documentIds(env: { db: RelationalStore; blobs: ReturnType<typeof memoryBlobStore> }, session: string) {
  const pages = (await env.db.prepare(`SELECT owner,page FROM session_pages WHERE session_id=?`).bind(session).all<{ owner: string; page: number }>()).results;
  const ids: Record<string, string[]> = { prompt: [], reply: [], tool: [], plan: [] };
  for (const page of pages) for (const record of (await readPage(env, 'project', session, page.owner, page.page))!) ids[record.k]!.push(record.k === 'plan' ? String(record.plan_key) : record.id);
  return Object.fromEntries(Object.entries(ids).map(([kind, held]) => [kind, held.sort()]));
}

async function effectiveIds(db: RelationalStore, session: string, instance: string | null) {
  const out: Record<string, string[]> = {};
  for (const kind of Object.keys(EFFECTIVE) as (keyof typeof EFFECTIVE)[])
    out[kind] = (await db.prepare(EFFECTIVE[kind]).bind(session, instance).all<{ id: string }>()).results.map((row) => row.id).sort();
  return out;
}

test('a published-view session converts with the ids its readers see and resumes from the view frontier', async () => {
  await withViewStores(async (db, name) => withViewWriterDriver(async () => {
    const now = Date.now(), blobs = memoryBlobStore();
    await captureViewSession(db);
    await createEmptyView(db, 'project', 'session', now);
    const env = await captureViewTranscript(db, blobs, 'session', tx, transcript, now, 0, 'codex');
    const instance = await requestViewRebuild(db, 'project', 'session', now);
    const target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
    for (let pass = 0; pass < 8; pass += 1)
      if (await parseViewOnce(env, target, now, { calls: 500, deadline: Date.now() + 10_000, clock: Date.now, completeFile: true }) === null) break;
    expect((await tryPublishView(db, target, now, fixtureFlipEnvelope(name))).published, name).toBe(true);
    await predate(db, 'session');
    // The legacy cursor stands behind the view's frontier, as it does while the legacy pass lags.
    await db.prepare(`UPDATE transcripts SET parsed_offset=0,parser_context=NULL WHERE transcript_id=?`).bind(tx).run();

    await convertDocuments({ db, blobs }, now, limits());
    const doc = await db.prepare(`SELECT state,generation,build FROM session_documents WHERE session_id='session'`).first<{ state: string; generation: number; build: string }>();
    expect(doc, name).toMatchObject({ state: 'live', generation: 1 });
    expect(JSON.parse(doc!.build).report.classes, name).toEqual({ unplaced: 2 });
    const expected = await effectiveIds(db, 'session', instance);
    expect(expected.tool!.length, name).toBe(2);
    expect(await documentIds({ db, blobs }, 'session'), name).toEqual(expected);
    const frontier = await db.prepare(`SELECT c.parsed_offset FROM view_checkpoints c WHERE c.instance_id=? AND c.transcript_id=?`).bind(instance, tx).first();
    expect(await db.prepare(`SELECT published_offset,prompt_scheme,record_scheme FROM transcript_publication WHERE transcript_id=?`).bind(tx).first(), name)
      .toMatchObject({ published_offset: (frontier as { parsed_offset: number }).parsed_offset, record_scheme: 'source-record-v1' });

    // The publisher resumes from the adopted frontier and adds nothing the export already holds.
    const before = await db.prepare(`SELECT prompts,replies,tool_calls,plans FROM session_documents WHERE session_id='session'`).first();
    await publishDocuments({ db, blobs }, now + 1, limits());
    expect(await db.prepare(`SELECT prompts,replies,tool_calls,plans FROM session_documents WHERE session_id='session'`).first(), name).toEqual(before);
    expect(await documentIds({ db, blobs }, 'session'), name).toEqual(expected);
  }));
});

test('a hook-only session converts its legacy rows with their ids, reporting the records no turn holds', async () => {
  await withViewStores(async (db, name) => withViewWriterDriver(async () => {
    const blobs = memoryBlobStore();
    await captureViewSession(db, 'project', 'hook', { blobs });
    await predate(db, 'hook');
    await convertDocuments({ db, blobs }, Date.now(), limits());
    const doc = await db.prepare(`SELECT state,prompts,replies,tool_calls,plans,build FROM session_documents WHERE session_id='hook'`).first<Record<string, unknown>>();
    expect(doc, name).toMatchObject({ state: 'live', prompts: 1, replies: 1, tool_calls: 1, plans: 1 });
    expect(JSON.parse(String(doc!.build)).report.classes, name).toEqual({ unplaced: 2 });
    expect(await documentIds({ db, blobs }, 'hook'), name).toEqual(await effectiveIds(db, 'hook', null));
  }));
});
