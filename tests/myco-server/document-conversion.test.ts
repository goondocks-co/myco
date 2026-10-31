import { expect, test } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { convertDocuments } from '@myco-server-worker/ingest/document-conversion.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { readPage } from '@myco-server-worker/content/document-reader.js';
import { createEmptyView, requestViewRebuild, tryPublishView } from '@myco-server-worker/ingest/view-lifecycle.js';
import { claimViewBuild, SERIAL_VIEW_BUDGET } from '@myco-server-worker/ingest/view-build-queue.js';
import { parseViewOnce } from '@myco-server-worker/ingest/view-parse.js';
import { captureViewSession, captureViewTranscript, withViewStores } from './helpers/view-stores.js';
import { memoryBlobStore, recordingLimiter } from './helpers/fixtures.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { processedBody } from '@myco-server-worker/read/processed.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { bundleArchiveStatements, prepareArchiveBundle } from '@myco-server-worker/core/archive-bundle.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';
import { BACKLOG_CHAINED_WAKE_MS, runTick, tickPacer } from '@myco-server-worker/core/tick.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
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
    // The prompt's retained body is a stored object larger than a page.
    const text = 'p'.repeat(300_000), key = await sha256Hex(text), generation = crypto.randomUUID();
    await blobs.put(blobObjectKey('project', key, generation), new Blob([text]).stream());
    await db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation) SELECT 'project',?,?,'text/plain',token_id,1,? FROM events LIMIT 1`)
      .bind(key, text.length, generation).run();
    await db.prepare(`UPDATE prompt_batches SET blob_key=?,text='ppp' WHERE session_id='hook'`).bind(key).run();
    await convertDocuments({ db, blobs }, Date.now(), limits());
    const doc = await db.prepare(`SELECT state,prompts,replies,tool_calls,plans,build FROM session_documents WHERE session_id='hook'`).first<Record<string, unknown>>();
    expect(doc, name).toMatchObject({ state: 'live', prompts: 1, replies: 1, tool_calls: 1, plans: 1 });
    const report = JSON.parse(String(doc!.build)).report;
    expect(report.classes, name).toEqual({ unplaced: 2 });
    expect(await documentIds({ db, blobs }, 'hook'), name).toEqual(await effectiveIds(db, 'hook', null));
    // Every retained body is compared as the source held it and as the document placed it, the long prompt by its body chunk.
    for (const kind of ['prompt', 'reply', 'tool', 'plan']) {
      expect(report.bodies[kind].n, `${name} ${kind}`).toBe(1);
      expect(report.bodies[kind].placed, `${name} ${kind}`).toBe(report.bodies[kind].source);
    }
    expect(report.bodies.prompt.bytes, name).toBe(300_000);
  }));
});

test('a frozen-tail session exports its frozen rows, places steering under a view parent and promotes its view-only plans', async () => {
  await withViewStores(async (db, name) => withViewWriterDriver(async () => {
    const blobs = memoryBlobStore();
    await captureViewSession(db);
    await predate(db, 'session');
    await db.batch([
      db.prepare(`INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,state,created_at) VALUES('project','frozen','session',1,'frozen','frozen',1)`),
      db.prepare(`INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,parent_instance,state,created_at) VALUES('project','tail','session',1,'tail','frozen','live',1)`),
      db.prepare(`INSERT INTO session_views(project_id,session_id,live_instance,legacy,updated_at) VALUES('project','session','tail','published',1)`),
      db.prepare(`INSERT INTO view_visible(project_id,instance_id,session_id,role,precedence) VALUES('project','tail','session','live',0),('project','frozen','session','parent',1)`),
      db.prepare(`INSERT INTO view_prompts(project_id,instance_id,session_id,prompt_id,origin,text,content_hash,created_at,updated_at,received_at)
        VALUES('project','frozen','session','parent-only','user','frozen text','hash',1,1,1),('project','tail','session','view-parent','user','top level','hash',0,0,0)`),
      db.prepare(`INSERT INTO view_plans(project_id,instance_id,session_id,plan_key,title,content,content_hash,status,created_at,updated_at,received_at)
        VALUES('project','tail','session','view-only-plan','Visible plan','retained plan body','hash','active',1,1,1)`),
      db.prepare(`UPDATE prompt_batches SET parent_prompt_id='view-parent' WHERE session_id='session'`),
    ]);
    // Two view plans hold their bodies in stored objects: one larger than a D1 value, one whose object is gone.
    const stored = await Promise.all([['large-plan', 'l'.repeat(2_100_000)], ['missing-plan', 'missing body']].map(async ([plan, text]) => {
      const key = await sha256Hex(text!), generation = crypto.randomUUID();
      if (plan === 'large-plan') await blobs.put(blobObjectKey('project', key, generation), new Blob([text!]).stream());
      return { p: plan, k: key, g: generation, n: text!.length };
    }));
    await db.batch([
      db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        SELECT 'project',json_extract(value,'$.k'),json_extract(value,'$.n'),'text/plain',(SELECT token_id FROM events LIMIT 1),1,json_extract(value,'$.g') FROM json_each(?)`)
        .bind(JSON.stringify(stored)),
      db.prepare(`INSERT INTO view_plans(project_id,instance_id,session_id,plan_key,title,content,blob_key,content_hash,status,created_at,updated_at,received_at)
        SELECT 'project','tail','session',json_extract(value,'$.p'),'Stored plan','preview',json_extract(value,'$.k'),json_extract(value,'$.k'),'active',1,1,1 FROM json_each(?)`)
        .bind(JSON.stringify(stored)),
      db.prepare(`INSERT INTO view_content_proofs(project_id,instance_id,session_id,kind,record_id,blob_key,digest,size,verified_at)
        SELECT 'project','tail','session','plan',json_extract(value,'$.p'),json_extract(value,'$.k'),json_extract(value,'$.k'),json_extract(value,'$.n'),1 FROM json_each(?)`)
        .bind(JSON.stringify(stored)),
    ]);
    await convertDocuments({ db, blobs }, 2, limits());
    expect((await db.prepare(`SELECT state FROM session_documents WHERE session_id='session'`).first())?.state, name).toBe('live');
    expect((await documentIds({ db, blobs }, 'session')).prompt, name).toContain('parent-only');
    expect(await db.prepare(`SELECT turn_key FROM session_prompts WHERE parent_hint='view-parent'`).first(), name).toEqual({ turn_key: 'view-parent' });
    expect(await db.prepare(`SELECT content FROM plans WHERE plan_key='view-only-plan'`).first(), name).toEqual({ content: 'retained plan body' });
    // A large body stays in its object, which the canonical plan adopts; a body that cannot be read leaves its plan unpromoted.
    expect(await db.prepare(`SELECT content,blob_key FROM plans WHERE plan_key='large-plan'`).first(), name).toEqual({ content: null, blob_key: stored[0]!.k });
    expect((await processedBody({ db, blobs }, { projectId: 'project' }, 'plan', 'large-plan'))?.length, name).toBe(2_100_000);
    const report = JSON.parse((await db.prepare(`SELECT build FROM session_documents WHERE session_id='session'`).first<{ build: string }>())!.build).report;
    expect(report.classes['plan_not_promoted:body_unreadable'], name).toBe(1);
  }));
});

/** A session that predates documents, holding 258 tool calls: 130 inputs each in its own stored object, 128 in two bundles. */
async function heldToolInputs(db: RelationalStore, blobs: ReturnType<typeof memoryBlobStore>) {
  await captureViewSession(db, 'project', 'session', { blobs });
  await predate(db, 'session');
  const event = (await db.prepare(`SELECT event_id,token_id FROM events WHERE kind='tool.use'`).first<{ event_id: string; token_id: string }>())!;
  await db.prepare(`DELETE FROM tool_calls`).run();
  await db.prepare(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,token_id,tool_name,input,input_bytes,success,created_at,received_at)
    SELECT 'project','tool-'||value,'session',?,?,'Read','bundled input',13,1,value,value FROM json_each(?)`)
    .bind(event.event_id, event.token_id, JSON.stringify(Array.from({ length: 258 }, (_, i) => i))).run();
  const tools = (await db.prepare(`SELECT t.project_id,t.tool_call_id resource_id,t.session_id,t.event_id,t.token_id,e.envelope_hash,
      t.content_revision,t.input_bytes bytes,t.received_at,e.raw_revision
    FROM tool_calls t JOIN events e ON e.project_id=t.project_id AND e.event_id=t.event_id WHERE t.created_at>=130 ORDER BY t.created_at`).all<Record<string, unknown>>()).results;
  for (let i = 0; i < tools.length; i += 64) {
    const bundle = await prepareArchiveBundle({ db, blobs }, tools.slice(i, i + 64).map((row) => ({ kind: 'tool-input' as const, row: row as never, text: 'bundled input' })), Date.now());
    await db.batch(bundleArchiveStatements(db, bundle));
  }
  const stored = await Promise.all(Array.from({ length: 130 }, async (_, i) => {
    const text = `stored input ${i}`, key = await sha256Hex(text), generation = crypto.randomUUID();
    await blobs.put(blobObjectKey('project', key, generation), new Blob([text]).stream());
    return { t: `tool-${i}`, k: key, g: generation, n: text.length };
  }));
  await db.batch([
    db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
      SELECT 'project',json_extract(value,'$.k'),json_extract(value,'$.n'),'text/plain',?,1,json_extract(value,'$.g') FROM json_each(?)`).bind(event.token_id, JSON.stringify(stored)),
    db.prepare(`UPDATE tool_calls SET input_blob_key=(SELECT json_extract(value,'$.k') FROM json_each(?1) WHERE json_extract(value,'$.t')=tool_calls.tool_call_id)
      WHERE created_at<130`).bind(JSON.stringify(stored)),
  ]);
  return stored.map((body) => body.k);
}

test('tool inputs read from bundles and stored objects convert across fresh wake budgets', async () => {
  await withViewStores(async (db, name) => withViewWriterDriver(async () => {
    const blobs = memoryBlobStore();
    await heldToolInputs(db, blobs);
    let wakes = 0;
    while ((await db.prepare(`SELECT state FROM session_documents WHERE session_id='session'`).first<{ state: string }>())!.state === 'convert' && wakes < 4) {
      await convertDocuments(measuredContentEnv({ db, blobs }, { statements: 800, blobCalls: 120 }).env, 2, limits());
      wakes += 1;
    }
    const report = JSON.parse((await db.prepare(`SELECT build FROM session_documents WHERE session_id='session' AND state='live'`).first<{ build: string }>())!.build).report;
    expect(report.bodies.tool, name).toMatchObject({ n: 258, placed: report.bodies.tool.source });
    expect(report.classes.body_unreadable, name).toBeUndefined();
  }));
});

test('an export page reads the stored bodies of all its rows with one blobs read', async () => {
  await withViewStores(async (db, name) => withViewWriterDriver(async () => {
    const blobs = memoryBlobStore();
    const keys = await heldToolInputs(db, blobs);
    // Counts the blobs reads that name a stored body, whether one key at a time or a page's keys together.
    let reads = 0;
    const counted: RelationalStore = { prepare: (sql) => {
      const statement = db.prepare(sql);
      return /FROM blobs/.test(sql) ? { ...statement, bind: (...values: unknown[]) => {
        if (values.some((value) => typeof value === 'string' && keys.some((key) => value.includes(key)))) reads += 1;
        return statement.bind(...values);
      } } : statement;
    }, batch: (statements) => db.batch(statements) };
    await convertDocuments({ db: counted, blobs }, 2, limits());
    const report = JSON.parse((await db.prepare(`SELECT build FROM session_documents WHERE session_id='session' AND state='live'`).first<{ build: string }>())!.build).report;
    expect(report.bodies.tool, name).toMatchObject({ n: 258, placed: report.bodies.tool.source });
    expect(reads, name).toBe(1);
  }));
});

test('a conversion backlog chains each clock wake at the backlog cadence and converts on every one', async () => {
  await withViewStores(async (db, name) => withViewWriterDriver(async () => {
    const blobs = memoryBlobStore();
    await heldToolInputs(db, blobs);
    const configured = serverEnvFromBindings({ MYCO_DB: db, BUCKET: blobs, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() });
    const env = { ...configured, blobs, platform: { ...configured.platform, name: name === 'native' ? 'bun' as const : 'cloudflare' as const } };
    const document = async () => (await db.prepare(`SELECT state,build FROM session_documents WHERE session_id='session'`).first<{ state: string; build: string | null }>())!;
    const pacer = tickPacer();
    let at = Date.now(), before = await document(), wakes = 0;
    while (before.state === 'convert') {
      const report = await runTick(env, at, { wake: 'clock', pacer });
      const after = await document();
      expect(after.build, name).not.toBe(before.build);
      if (wakes > 0) expect(report.drainOnly, name).toBe(true);
      if (after.state === 'convert') expect(report.nextWakeMs, name).toBe(BACKLOG_CHAINED_WAKE_MS);
      at += report.nextWakeMs!;
      before = after;
      wakes += 1;
      expect(wakes, name).toBeLessThan(10);
    }
    expect(wakes, name).toBeGreaterThan(2);
  }));
});
