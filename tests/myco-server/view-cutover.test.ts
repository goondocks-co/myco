import { expect, test } from 'bun:test';
import type { PreparedStatement, RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import { parseTranscripts, PARSER_VERSION } from '@myco-server-worker/ingest/parse.js';
import { runViewCutoverWake, readViewCutover, VIEW_CUTOVER_PAUSE_BYTES } from '@myco-server-worker/ingest/view-cutover.js';
import { measuredContentEnv, remainingInvocationBudget, CONTENT_WAKE_JOB_RESERVE, CONTENT_BLOB_LIMIT } from '@myco-server-worker/core/content-budget.js';
import { changePlanStatus } from '@myco-server-worker/core/plans.js';
import { processedBody } from '@myco-server-worker/read/processed.js';
import { engineAssertions } from '@myco-server-worker/core/tick.js';
import { VIEW_BUILD_LEASE_MS } from '@myco-server-worker/ingest/view-build-queue.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { withViewStores, captureViewSession, captureViewTranscript } from './helpers/view-stores.js';
import { beforeViewWriteBatch } from './helpers/view-instances.js';
import { memoryBlobStore, uuid } from './helpers/fixtures.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';

const DAY = 86_400_000;
const bytes = (text: string) => new TextEncoder().encode(text).length;
let seq = 0;
const id = () => uuid(900_000 + ++seq);

/** Claude Code lines: one prompt, its tool call with a result of `output` characters, and a reply. */
function turn(session: string, prompt: string, output: number, reply = 'Reading.'): string {
  const promptId = id(),
    tool = 'toolu_' + id().slice(-12),
    at = new Date(Date.UTC(2026, 9, 1, 10, 0, ++seq)).toISOString();
  return [
    { type: 'user', promptId, message: { content: prompt }, uuid: id(), timestamp: at, sessionId: session },
    { type: 'assistant', message: { content: [{ type: 'text', text: reply }, { type: 'tool_use', id: tool, name: 'Read', input: { file_path: '/repo/a.ts' } }] }, uuid: id(), timestamp: at, sessionId: session },
    { type: 'user', promptId, message: { content: [{ type: 'tool_result', tool_use_id: tool, content: 'r'.repeat(output) }] }, uuid: id(), timestamp: at, sessionId: session },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done: ' + prompt }] }, uuid: id(), timestamp: at, sessionId: session },
  ].map((line) => JSON.stringify(line) + '\n').join('');
}

async function legacySession(db: RelationalStore, blobs: ReturnType<typeof memoryBlobStore>, session: string, at: number, segments: string[]) {
  await captureViewSession(db, 'project', session, { idOffset: 5000 + seq++ * 100 });
  const transcript = 'tx_' + Buffer.from(session).toString('hex').padEnd(32, '0').slice(0, 32);
  let env: Awaited<ReturnType<typeof captureViewTranscript>> | undefined, offset = 0;
  for (const text of segments) {
    env = await captureViewTranscript(db, blobs, session, transcript, text, at, offset, 'claude-code');
    offset += bytes(text);
  }
  for (let pass = 0; pass < 20 && (await parseTranscripts(env!, at + DAY)).more; pass++);
  return { env: env! as unknown as ServerEnv, transcript, size: offset };
}

async function drain(env: ServerEnv, now: number, wakes = 40) {
  for (let wake = 0; wake < wakes; wake++) if (!(await runViewCutoverWake(env, now)).more) return wake + 1;
  throw new Error('cutover did not converge');
}

const n = async (statement: PreparedStatement) => Number((await statement.first<{ n: number }>())?.n);

test('the batch classifies parser rows, builds and publishes every session, and caps inline tool output on both stores', async () => {
  await withViewStores(async (db) =>
    withViewWriterDriver(async () => {
      const blobs = memoryBlobStore(), now = Date.now(), at = now - 2 * DAY;
      const first = await legacySession(db, blobs, 'cut-a', at, [turn('cut-a', 'first', 9000), turn('cut-a', 'second', 200)]);
      await legacySession(db, blobs, 'cut-b', at, [turn('cut-b', 'third', 300)]);
      const legacy = await n(db.prepare(`SELECT COUNT(*) n FROM fact_classes WHERE class='legacy'`));
      expect(legacy).toBeGreaterThan(0);
      expect(await n(db.prepare(`SELECT COUNT(*) n FROM tool_calls t JOIN events e ON e.project_id=t.project_id AND e.event_id=t.event_id
        WHERE e.producer_adapter='transcript-parse' AND NOT EXISTS(SELECT 1 FROM fact_classes c WHERE c.project_id=t.project_id
          AND c.table_name='tool_calls' AND c.record_id=t.tool_call_id AND c.class='legacy')`))).toBe(0);
      await db.prepare(`DELETE FROM fact_classes`).run();
      await drain(first.env, now);
      expect(await n(db.prepare(`SELECT COUNT(*) n FROM fact_classes WHERE class='legacy'`))).toBe(legacy);
      expect(await n(db.prepare(`SELECT COUNT(*) n FROM fact_classes WHERE class<>'legacy'`))).toBe(0);
      expect(await n(db.prepare(`SELECT COUNT(*) n FROM session_views s JOIN view_instances i ON i.project_id=s.project_id
        AND i.instance_id=s.live_instance WHERE i.parser_version=? AND s.legacy='published'`).bind(PARSER_VERSION))).toBe(2);
      expect(await n(db.prepare(`SELECT COUNT(*) n FROM view_prompts p JOIN view_visible v ON v.project_id=p.project_id AND v.instance_id=p.instance_id`))).toBe(3);
      const tool = await db.prepare(`SELECT t.output_preview,t.output_blob_key FROM view_tool_calls t JOIN view_visible v
        ON v.project_id=t.project_id AND v.instance_id=t.instance_id WHERE length(t.output_preview)=4096`).first<{ output_blob_key: string | null }>();
      expect(tool?.output_blob_key).toMatch(/^[a-f0-9]{64}$/);
      const status = await readViewCutover(db);
      expect(status).toMatchObject({ classified: true, swept: true, remaining: 0, built: 2, frozenTails: 0, paused: null });
    }),
  );
}, 120000);

test('a killed wake resumes from its checkpoints after the lease and capture during the build lands before the flip', async () => {
  await withViewStores(async (db) =>
    withViewWriterDriver(async () => {
      const blobs = memoryBlobStore(), now = Date.now(), at = now - 2 * DAY;
      const session = await legacySession(db, blobs, 'cut-r', at, [turn('cut-r', 'one', 100), turn('cut-r', 'two', 100)]);
      let killed = 0;
      const dying = beforeViewWriteBatch(db, (sql) => sql.includes('UPDATE view_checkpoints SET parsed_offset='), async () => {
        killed++;
        throw new Error('wake killed');
      }, true);
      await expect(drain({ ...session.env, db: dying }, now)).rejects.toThrow('wake killed');
      expect(killed).toBe(1);
      const appended = turn('cut-r', 'three', 100);
      await captureViewTranscript(db, blobs, 'cut-r', session.transcript, appended, at, session.size, 'claude-code');
      await drain(session.env, now + VIEW_BUILD_LEASE_MS + 1);
      expect(await n(db.prepare(`SELECT COUNT(*) n FROM view_prompts p JOIN view_visible v ON v.project_id=p.project_id
        AND v.instance_id=p.instance_id WHERE v.session_id='cut-r'`))).toBe(3);
      expect(await n(db.prepare(`SELECT c.parsed_offset n FROM view_checkpoints c JOIN view_visible v ON v.project_id=c.project_id
        AND v.instance_id=c.instance_id WHERE c.transcript_id=?`).bind(session.transcript))).toBe(session.size + bytes(appended));
    }),
  );
}, 120000);

test('a session that lost bytes keeps its legacy derivation frozen and publishes a tail from the frontier', async () => {
  await withViewStores(async (db) =>
    withViewWriterDriver(async () => {
      const blobs = memoryBlobStore(), now = Date.now(), at = now - 2 * DAY;
      const session = await legacySession(db, blobs, 'cut-f', at, [turn('cut-f', 'pruned ' + 'p'.repeat(20000), 100), turn('cut-f', 'kept', 100)]);
      await db.prepare(`DELETE FROM transcript_segments WHERE transcript_id=? AND base_offset=0`).bind(session.transcript).run();
      const appended = turn('cut-f', 'after the loss', 100);
      await captureViewTranscript(db, blobs, 'cut-f', session.transcript, appended, at, session.size, 'claude-code');
      for (let wake = 0, more = true; more; wake++) {
        expect(wake).toBeLessThan(40);
        more = (await runViewCutoverWake(session.env, now)).more;
        expect(await n(db.prepare(`SELECT COUNT(*) n FROM view_visible v JOIN view_instances i ON i.project_id=v.project_id
          AND i.instance_id=v.instance_id WHERE v.session_id='cut-f' AND v.role='parent' AND i.state<>'frozen'`))).toBe(0);
      }
      const visible = (await db.prepare(`SELECT v.role,i.base,i.state FROM view_visible v JOIN view_instances i
        ON i.project_id=v.project_id AND i.instance_id=v.instance_id WHERE v.session_id='cut-f' ORDER BY v.role`).all()).results;
      expect(visible).toEqual([{ role: 'live', base: 'tail', state: 'live' }, { role: 'parent', base: 'frozen', state: 'frozen' }]);
      const texts = async (role: string) => (await db.prepare(`SELECT p.text,p.blob_key FROM view_prompts p JOIN view_visible v
        ON v.project_id=p.project_id AND v.instance_id=p.instance_id WHERE v.session_id='cut-f' AND v.role=? ORDER BY p.created_at`)
        .bind(role).all<{ text: string; blob_key: string | null }>()).results;
      const parent = await texts('parent');
      expect(parent.map((row) => row.text.slice(0, 6))).toEqual(['pruned', 'kept']);
      expect(parent[0]!.blob_key).toMatch(/^[a-f0-9]{64}$/);
      expect(await n(db.prepare(`SELECT COUNT(*) n FROM view_content_proofs c JOIN view_visible v ON v.project_id=c.project_id
        AND v.instance_id=c.instance_id WHERE v.role='parent' AND c.kind='prompt'`))).toBe(1);
      expect((await texts('live')).map((row) => row.text)).toEqual(['after the loss']);
      expect(await n(db.prepare(`SELECT c.start_offset n FROM view_checkpoints c JOIN view_visible v ON v.project_id=c.project_id
        AND v.instance_id=c.instance_id WHERE v.role='live'`))).toBe(session.size);
      expect((await readViewCutover(db)).frozenTails).toBe(1);
    }),
  );
}, 120000);

test('the batch pauses building at the headroom limit and keeps waiting without chaining', async () => {
  await withViewStores(async (db) =>
    withViewWriterDriver(async () => {
      const blobs = memoryBlobStore(), now = Date.now(), at = now - 2 * DAY;
      const session = await legacySession(db, blobs, 'cut-h', at, [turn('cut-h', 'held', 100)]);
      for (let wake = 0; wake < 3; wake++) expect((await runViewCutoverWake(session.env, now, async () => VIEW_CUTOVER_PAUSE_BYTES)).more).toBe(false);
      expect(await n(db.prepare(`SELECT COUNT(*) n FROM session_views`))).toBe(0);
      expect(await readViewCutover(db)).toMatchObject({ paused: 'd1_headroom', databaseBytes: VIEW_CUTOVER_PAUSE_BYTES, remaining: 1 });
      await drain(session.env, now);
      expect(await readViewCutover(db)).toMatchObject({ paused: null, remaining: 0, built: 1 });
    }),
  );
}, 120000);

test('a published session keeps the legacy cursor, so legacy rows stay complete while the view extends', async () => {
  await withViewStores(async (db) =>
    withViewWriterDriver(async () => {
      const blobs = memoryBlobStore(), now = Date.now(), at = now - 2 * DAY;
      const session = await legacySession(db, blobs, 'cut-l', at, [turn('cut-l', 'opening', 100)]);
      await drain(session.env, now);
      const appended = Array.from({ length: 6 }, (_, i) => turn('cut-l', 'appended' + i, 100)).join('');
      await captureViewTranscript(db, blobs, 'cut-l', session.transcript, appended, at, session.size, 'claude-code');
      await drain(session.env, now);
      for (let pass = 0; pass < 20 && (await parseTranscripts(session.env, now)).more; pass++);
      expect(await n(db.prepare(`SELECT COUNT(*) n FROM prompt_batches WHERE text LIKE 'appended%'`))).toBe(6);
      expect(await n(db.prepare(`SELECT COUNT(*) n FROM view_prompts p JOIN view_visible v ON v.project_id=p.project_id
        AND v.instance_id=p.instance_id WHERE p.text LIKE 'appended%'`))).toBe(6);
    }),
  );
}, 120000);

test('a tail after a lost segment keeps the complete record that opens the next retained segment', async () => {
  await withViewStores(async (db) =>
    withViewWriterDriver(async () => {
      const blobs = memoryBlobStore(), now = Date.now(), at = now - 2 * DAY;
      const first = turn('cut-g', 'before', 100), lost = turn('cut-g', 'lost', 100), kept = turn('cut-g', 'kept', 100);
      const session = await legacySession(db, blobs, 'cut-g', at, [first]);
      await captureViewTranscript(db, blobs, 'cut-g', session.transcript, lost, at, session.size, 'claude-code');
      await captureViewTranscript(db, blobs, 'cut-g', session.transcript, kept, at, session.size + bytes(lost), 'claude-code');
      await db.prepare(`DELETE FROM transcript_segments WHERE transcript_id=? AND base_offset=?`).bind(session.transcript, session.size).run();
      await drain(session.env, now);
      expect((await db.prepare(`SELECT p.text FROM view_prompts p JOIN view_visible v ON v.project_id=p.project_id
        AND v.instance_id=p.instance_id WHERE v.role='live'`).all<{ text: string }>()).results.map((row) => row.text)).toEqual(['kept']);
    }),
  );
}, 120000);

test('a status edit of a published parser plan promotes it to a fact and applies the edit', async () => {
  await withViewStores(async (db) =>
    withViewWriterDriver(async () => {
      const blobs = memoryBlobStore(), now = Date.now(), at = now - 2 * DAY;
      const session = await legacySession(db, blobs, 'cut-p', at, [turn('cut-p', 'plan it', 100, '<ultraplan># Plan\nDo work.</ultraplan>')]);
      await drain(session.env, now);
      const key = (await db.prepare(`SELECT p.plan_key FROM view_plans p JOIN view_visible v ON v.project_id=p.project_id
        AND v.instance_id=p.instance_id`).first<{ plan_key: string }>())!.plan_key;
      const row = await changePlanStatus({ db, blobs }, { projectId: 'project' }, key, 'completed', 'member', now);
      expect({ status: row?.status, content: row?.content }).toEqual({ status: 'completed', content: '# Plan\nDo work.' });
      expect(await n(db.prepare(`SELECT COUNT(*) n FROM fact_classes WHERE table_name='plans' AND record_id=? AND class='promoted'`).bind(key))).toBe(1);
    }),
  );
}, 120000);

test('promoting over a legacy plan row keeps the complete view body beyond the legacy bound', async () => {
  await withViewStores(async (db) =>
    withViewWriterDriver(async () => {
      const blobs = memoryBlobStore(), now = Date.now(), at = now - 2 * DAY;
      const body = '# Plan\n' + 'x'.repeat(400_000);
      const session = await legacySession(db, blobs, 'cut-q', at, [turn('cut-q', 'long plan', 100, '<ultraplan>' + body + '</ultraplan>')]);
      await drain(session.env, now);
      const key = (await db.prepare(`SELECT p.plan_key FROM plans p JOIN fact_classes f ON f.project_id=p.project_id
        AND f.table_name='plans' AND f.record_id=p.plan_key AND f.class='legacy'`).first<{ plan_key: string }>())!.plan_key;
      expect((await changePlanStatus({ db, blobs }, { projectId: 'project' }, key, 'completed', 'member', now))?.status).toBe('completed');
      expect(await processedBody({ db, blobs }, { projectId: 'project' }, 'plan', key)).toBe(body);
    }),
  );
}, 120000);

test('a long build leaves the shared wake its housekeeping admission', async () => {
  await withViewStores(async (db) =>
    withViewWriterDriver(async () => {
      const blobs = memoryBlobStore(), now = Date.now(), at = now - 2 * DAY;
      await captureViewSession(db, 'project', 'cut-b', { idOffset: 7000 });
      const text = Array.from({ length: 1500 }, (_, i) => turn('cut-b', 'long' + i, 100)).join('');
      const env = await captureViewTranscript(db, blobs, 'cut-b', 'tx_' + 'b'.repeat(32), text, at, 0, 'claude-code');
      for (let wake = 0; wake < 3; wake++) {
        const outer = measuredContentEnv(env, { statements: 800, blobCalls: 240, wallMs: 15000 });
        await runViewCutoverWake(outer.env as unknown as ServerEnv, now);
        const left = remainingInvocationBudget(outer.env.db)!;
        expect(left.statements).toBeGreaterThanOrEqual(CONTENT_WAKE_JOB_RESERVE);
        expect(left.blobCalls).toBeGreaterThanOrEqual(CONTENT_BLOB_LIMIT);
      }
    }),
  );
}, 120000);

test('unfinished cutover work keeps the Deployment at idle until the batch completes or pauses', async () => {
  await withViewStores(async (db) =>
    withViewWriterDriver(async () => {
      const blobs = memoryBlobStore(), now = Date.now(), at = now - 2 * DAY;
      const session = await legacySession(db, blobs, 'cut-w', at, [turn('cut-w', 'awake', 100)]);
      const held = async () => (await engineAssertions(session.env, now)).some((a) => a.name === 'view-cutover:pending' && a.maxDepth === 'idle');
      expect(await held()).toBe(true);
      await runViewCutoverWake(session.env, now, async () => VIEW_CUTOVER_PAUSE_BYTES);
      expect(await held()).toBe(false);
      await drain(session.env, now);
      expect(await held()).toBe(false);
    }),
  );
}, 120000);

test('a parse resuming mid-turn on rows written before the upgrade lands beside a parser row that already holds a class', async () => {
  await withViewStores(async (db) => {
    const blobs = memoryBlobStore(), now = Date.now(), at = now - 2 * DAY;
    const lines = turn('cut-u', 'resumed', 100).split(/(?<=\n)/), head = lines.slice(0, 2).join('');
    const session = await legacySession(db, blobs, 'cut-u', at, [head]);
    for (const step of SCHEMA_STEPS.filter((step) => step.version > 105)) await db.batch(step.statements.map((sql) => db.prepare(sql)));
    await db.prepare(`INSERT INTO fact_classes(project_id,table_name,record_id,session_id,class,classified_at)
      SELECT project_id,'tool_calls',tool_call_id,session_id,'unverified',? FROM tool_calls`).bind(now).run();
    await captureViewTranscript(db, blobs, 'cut-u', session.transcript, lines.slice(2).join(''), at, bytes(head), 'claude-code');
    for (let pass = 0; pass < 20 && (await parseTranscripts(session.env, at + DAY)).more; pass++);
    expect(await n(db.prepare(`SELECT parsed_offset n FROM transcripts WHERE transcript_id=?`).bind(session.transcript))).toBe(bytes(lines.join('')));
    expect((await db.prepare(`SELECT DISTINCT table_name,class FROM fact_classes WHERE table_name IN ('prompt_batches','tool_calls')`).all()).results)
      .toEqual([{ table_name: 'tool_calls', class: 'unverified' }]);
  }, 105);
}, 120000);
