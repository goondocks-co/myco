import { expect, test } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { createEmptyView, requestViewRebuild, tryPublishView } from '@myco-server-worker/ingest/view-lifecycle.js';
import { claimViewBuild, SERIAL_VIEW_BUDGET } from '@myco-server-worker/ingest/view-build-queue.js';
import { parseViewOnce } from '@myco-server-worker/ingest/view-parse.js';
import { PARSER_VERSION } from '@myco-server-worker/ingest/parse.js';
import { acknowledgeViewPrompt } from '@myco-server-worker/ingest/view-acknowledgements.js';
import { ensureAgent, recordDispatch } from '@myco-server-worker/core/runs.js';
import { recordServedPrompts } from '@myco-server-worker/core/served-material.js';
import { contentAssertion } from '@myco-server-worker/core/registered-content.js';
import {
  publicationVersionStatements,
  finishVersionStatements,
  VIEW_HASH_SCHEME,
} from '@myco-server-worker/core/material-versions.js';
import { viewContentHash } from '@myco-server-worker/core/material-content.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { withViewStores, captureViewSession, captureViewTranscript } from './helpers/view-stores.js';
import { completeViewConversion, beforeViewWriteBatch } from './helpers/view-instances.js';
import { memoryBlobStore, uuid } from './helpers/fixtures.js';
import { fixtureFlipEnvelope } from '../helpers/view-flip-envelope.js';
import { withViewWriterDriver, statementRecorder } from '../helpers/statement-recorder.js';

const tx = (n: number) => 'tx_' + String(n).padStart(32, '0');
const scope = { projectId: 'project' },
  promptId = uuid(20);
const count = async (db: RelationalStore) =>
  (await db
    .prepare(`SELECT eligible_prompts n FROM session_read_facts WHERE project_id=? AND session_id=?`)
    .bind('project', 'session')
    .first<{ n: number }>())!.n;
const sources = async (db: RelationalStore) =>
  (
    await db
      .prepare(
        `SELECT source_transcript_id,source_offset,source_end FROM extraction_acks WHERE project_id=? AND session_id=? AND kind='source' ORDER BY source_transcript_id`,
      )
      .bind('project', 'session')
      .all<{ source_transcript_id: string; source_offset: number; source_end: number }>()
  ).results;

async function serve(db: RelationalStore, now: number) {
  await ensureAgent(db, { id: 'ack-agent', name: 'Ack agent', provider: null, model: null, enabled: true }, now);
  const run = crypto.randomUUID();
  expect(
    await recordDispatch(db, scope, {
      id: run,
      agentId: 'ack-agent',
      task: 'title-summary',
      provider: null,
      model: null,
      runContext: null,
      dispatchedBy: null,
      startedAt: now,
    }),
  ).toBe(true);
  const [item] = await recordServedPrompts(
    db,
    scope,
    run,
    [{ promptId, sessionId: 'session', createdAt: 1, endedAt: null }],
    now,
  );
  return { run, target: { servedId: item!.servedId } };
}

async function unrelatedPrompts(db: RelationalStore, instance: string, amount: number) {
  const bodyHash = await sha256Hex('nuisance');
  for (let offset = 0; offset < amount; offset += 512) {
    const rows = await Promise.all(
      Array.from({ length: Math.min(512, amount - offset) }, async (_, index) => {
        const id = 'unrelated-' + (offset + index);
        return {
          kind: 'prompt',
          identity: JSON.stringify(['prompt', id, 'synthetic']),
          recordId: id,
          hash: await viewContentHash('prompt', { prompt_id: id, origin: 'user', text: 'nuisance', created_at: 1 }),
        };
      }),
    );
    const attempt = crypto.randomUUID();
    await db.batch([
      ...publicationVersionStatements(db, 'project', 'session', attempt, rows, false),
      db
        .prepare(
          `INSERT INTO view_prompts(project_id,instance_id,session_id,prompt_id,origin,text,content_hash,created_at,updated_at,received_at,
      canonical_identity,view_content_hash,hash_scheme,material_seq)
     SELECT project_id,?,session_id,record_id,'user','nuisance',?,1,1,1,identity,content_hash,?,material_seq
     FROM view_publication_material WHERE project_id=? AND session_id=? AND attempt_id=?`,
        )
        .bind(instance, bodyHash, VIEW_HASH_SCHEME, 'project', 'session', attempt),
      ...finishVersionStatements(db, 'project', 'session', attempt),
    ]);
  }
  await db
    .prepare(`UPDATE session_read_facts SET eligible_prompts=eligible_prompts+? WHERE project_id=? AND session_id=?`)
    .bind(amount, 'project', 'session')
    .run();
}

async function abandonedCopies(db: RelationalStore, instance: string, amount: number) {
  for (let offset = 0; offset < amount; offset += 512) {
    const page = JSON.stringify(Array.from({ length: Math.min(512, amount - offset) }, (_, index) => offset + index));
    await db.batch([
      db
        .prepare(
          `INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,state,created_at)
     SELECT ?,'abandoned-'||value,?,?,'full','abandoned',1 FROM json_each(?)`,
        )
        .bind('project', 'session', PARSER_VERSION, page),
      db
        .prepare(
          `INSERT INTO view_prompts(project_id,instance_id,session_id,prompt_id,origin,text,content_hash,created_at,updated_at,received_at,
      canonical_identity,view_content_hash,hash_scheme,source_transcript_id,source_offset,source_end)
     SELECT p.project_id,'abandoned-'||j.value,p.session_id,p.prompt_id,p.origin,p.text,p.content_hash,p.created_at,p.updated_at,p.received_at,
      p.canonical_identity,p.view_content_hash,p.hash_scheme,p.source_transcript_id,p.source_offset,p.source_end
     FROM view_prompts p CROSS JOIN json_each(?) j WHERE p.project_id=? AND p.instance_id=? AND p.prompt_id=?`,
        )
        .bind(page, 'project', instance, promptId),
    ]);
  }
}

async function fixture(db: RelationalStore, store: 'native' | 'D1') {
  const now = Date.now(),
    blobs = memoryBlobStore();
  await captureViewSession(db);
  await createEmptyView(db, 'project', 'session', now);
  const text = (value = 'factcanary') =>
    JSON.stringify({ v: 1, type: 'prompt', promptId, text: value, at: now }) + '\n';
  const env = await captureViewTranscript(db, blobs, 'session', tx(1), text(), now, 0, 'opencode');
  const build = async (at: number) => {
    await requestViewRebuild(db, 'project', 'session', at);
    const target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, at))!;
    for (let pass = 0; pass < 8; pass++)
      if (
        (await parseViewOnce(env, target, at, {
          calls: 500,
          deadline: Date.now() + 10000,
          clock: Date.now,
          completeFile: true,
        })) === null
      )
        break;
    return target;
  };
  const first = await build(now);
  await completeViewConversion(db, 'project', 'session', promptId);
  expect((await tryPublishView(db, first, now, fixtureFlipEnvelope(store))).published).toBe(true);
  const preferred = async (n: number) => {
    await captureViewTranscript(db, blobs, 'session', tx(n), text(), now - n, 0, 'opencode');
    return build(now + n);
  };
  return { now, env, text, first, preferred };
}

test('late legacy coverage decrements a newly selected source even when an older run already acknowledged the raw record', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const f = await fixture(db, store);
      expect(await count(db), store).toBe(1);
      const old = await serve(db, f.now);
      expect(await acknowledgeViewPrompt(db, scope, old.run, old.target, f.now)).toMatchObject({ marked: true });
      expect(await count(db)).toBe(0);
      expect((await sources(db)).map((row) => row.source_transcript_id)).toEqual([tx(1)]);
      const next = await f.preferred(2);
      expect((await tryPublishView(db, next, f.now + 2, fixtureFlipEnvelope(store))).published).toBe(true);
      expect(await count(db)).toBe(1);
      await unrelatedPrompts(db, next.instanceId, 10000);
      expect(await count(db)).toBe(10001);
      await abandonedCopies(db, next.instanceId, 10000);
      const current = await serve(db, f.now + 3);
      const observed = statementRecorder(db, { accounting: store === 'D1' ? 'd1' : 'native' });
      expect(await acknowledgeViewPrompt(observed.db, scope, current.run, current.target, f.now + 3)).toMatchObject({
        marked: true,
      });
      expect(await count(db)).toBe(10000);
      expect((await sources(db)).map((row) => row.source_transcript_id)).toEqual([tx(1), tx(2)]);
      expect(await acknowledgeViewPrompt(db, scope, current.run, current.target, f.now + 4)).toMatchObject({
        marked: false,
      });
      expect(await count(db)).toBe(10000);
      console.log(
        JSON.stringify({
          measurement: 'late-view-ack',
          store,
          statements: observed.statements.length,
          rowsRead: store === 'D1' ? observed.statements.reduce((sum, row) => sum + (row.rowsRead ?? 0), 0) : null,
        }),
      );
      if (store === 'D1')
        expect(observed.statements.reduce((sum, row) => sum + (row.rowsRead ?? 0), 0)).toBeLessThan(250);
      for (const statement of observed.statements.filter((row) => row.sql.startsWith('UPDATE session_read_facts'))) {
        const plan = (
          await db
            .prepare('EXPLAIN QUERY PLAN ' + statement.sql)
            .bind(...statement.binds)
            .all<{ detail: string }>()
        ).results.map((row) => row.detail);
        expect(
          plan.some((detail) =>
            /SEARCH r USING (?:COVERING )?INDEX (?:sqlite_autoindex_prompt_batches_1 \(project_id=\? AND prompt_id=\?\)|idx_preflight_prompt_session \(project_id=\? AND session_id=\? AND prompt_id=\?\))/.test(
              detail,
            ),
          ),
          store + '\n' + plan.join('\n'),
        ).toBe(true);
        expect(
          plan.some((detail) =>
            /SEARCH r USING INDEX .* \(project_id=\? AND instance_id=\? AND prompt_id=\?/.test(detail),
          ),
          store + '\n' + plan.join('\n'),
        ).toBe(true);
      }
    }),
  );
}, 120000);

test('the late acknowledgement resolves a concurrent flip inside its own batch and rolls back its counter balance on failure', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const f = await fixture(db, store),
        old = await serve(db, f.now);
      await acknowledgeViewPrompt(db, scope, old.run, old.target, f.now);
      expect(await count(db)).toBe(0);
      const next = await f.preferred(2),
        current = await serve(db, f.now + 3);
      const racing = beforeViewWriteBatch(
        db,
        (sql) => sql.includes('INSERT INTO extraction_acks') && sql.includes("'record'"),
        async () => {
          expect((await tryPublishView(db, next, f.now + 3, fixtureFlipEnvelope(store))).published).toBe(true);
        },
        true,
      );
      expect(await acknowledgeViewPrompt(racing, scope, current.run, current.target, f.now + 3)).toMatchObject({
        marked: true,
      });
      expect(await count(db)).toBe(0);
      expect((await sources(db)).map((row) => row.source_transcript_id)).toEqual([tx(1), tx(2)]);
      const third = await f.preferred(3);
      expect((await tryPublishView(db, third, f.now + 4, fixtureFlipEnvelope(store))).published).toBe(true);
      expect(await count(db)).toBe(1);
      const failing = await serve(db, f.now + 5),
        before = await sources(db);
      const interrupted: RelationalStore = {
        prepare: (sql) => db.prepare(sql),
        batch: (statements) => db.batch([...statements, ...contentAssertion(db, '0', [])]),
      };
      await expect(acknowledgeViewPrompt(interrupted, scope, failing.run, failing.target, f.now + 5)).rejects.toThrow();
      expect(await count(db)).toBe(1);
      expect(await sources(db)).toEqual(before);
      expect(await acknowledgeViewPrompt(db, scope, failing.run, failing.target, f.now + 6)).toMatchObject({
        marked: true,
      });
      expect(await count(db)).toBe(0);
    }),
  );
}, 120000);

for (const mode of ['parent', 'live', 'fact'] as const)
  test(
    'late coverage follows ' + mode + ' precedence with a frozen parent',
    async () => {
      await withViewStores(async (db, store) =>
        withViewWriterDriver(async () => {
          const f = await fixture(db, store),
            parent = f.first.instanceId,
            tail = crypto.randomUUID(),
            size = new TextEncoder().encode(f.text()).length;
          await db
            .prepare(`UPDATE view_prompts SET material_seq=NULL WHERE project_id=? AND instance_id=?`)
            .bind('project', parent)
            .run();
          const frozen = (
            await db
              .prepare(`SELECT * FROM view_prompts WHERE project_id=? AND instance_id=?`)
              .bind('project', parent)
              .all()
          ).results;
          await db.batch([
            db
              .prepare(`UPDATE view_instances SET state='frozen',base='frozen' WHERE project_id=? AND instance_id=?`)
              .bind('project', parent),
            db
              .prepare(
                `INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,parent_instance,state,created_at,published_at)
     VALUES(?,?,?,?,'tail',?,'live',?,?)`,
              )
              .bind('project', tail, 'session', PARSER_VERSION, parent, f.now, f.now),
            db
              .prepare(
                `INSERT INTO view_checkpoints(project_id,instance_id,session_id,transcript_id,ordinal,start_offset,parsed_offset,parser_context,lost_context)
     VALUES(?,?,?,?,0,?,?,'{"mycoParserViewCheckpoint":1,"mycoParserState":{}}',1)`,
              )
              .bind('project', tail, 'session', tx(1), size, size),
            db
              .prepare(`UPDATE session_views SET live_instance=?,fence=fence+1 WHERE project_id=? AND session_id=?`)
              .bind(tail, 'project', 'session'),
            db
              .prepare(`UPDATE view_visible SET role='parent',precedence=1 WHERE project_id=? AND instance_id=?`)
              .bind('project', parent),
            db
              .prepare(
                `INSERT INTO view_visible(project_id,instance_id,session_id,role,precedence) VALUES(?,?,?,'live',0)`,
              )
              .bind('project', tail, 'session'),
          ]);
          if (mode === 'live') {
            await captureViewTranscript(
              db,
              f.env.blobs,
              'session',
              tx(2),
              f.text('tail version'),
              f.now + 1,
              0,
              'opencode',
            );
            const state = (await db
              .prepare(`SELECT fence FROM session_views WHERE project_id=? AND session_id=?`)
              .bind('project', 'session')
              .first<{ fence: number }>())!;
            await parseViewOnce(
              f.env,
              {
                projectId: 'project',
                sessionId: 'session',
                instanceId: tail,
                liveInstance: tail,
                fence: state.fence,
                leaseToken: null,
              },
              f.now + 1,
              { calls: 500, deadline: Date.now() + 10000, clock: Date.now, completeFile: true },
            );
          }
          if (mode === 'fact')
            await db
              .prepare(
                `UPDATE fact_classes SET class='unverified' WHERE project_id=? AND table_name='prompt_batches' AND record_id=?`,
              )
              .bind('project', promptId)
              .run();
          expect(await count(db), store).toBe(1);
          const run = await serve(db, f.now + 2);
          expect(await acknowledgeViewPrompt(db, scope, run.run, run.target, f.now + 2)).toMatchObject({
            marked: true,
          });
          expect(await count(db)).toBe(0);
          expect((await sources(db)).map((row) => row.source_transcript_id)).toEqual(
            mode === 'fact' ? [] : [tx(mode === 'live' ? 2 : 1)],
          );
          expect(
            (
              await db
                .prepare(`SELECT * FROM view_prompts WHERE project_id=? AND instance_id=?`)
                .bind('project', parent)
                .all()
            ).results,
          ).toEqual(frozen);
          expect(await acknowledgeViewPrompt(db, scope, run.run, run.target, f.now + 3)).toMatchObject({
            marked: false,
          });
          expect(await count(db)).toBe(0);
        }),
      );
    },
    120000,
  );

test('a late record ack with mixed pins leaves its unread view counterpart eligible and re-offered', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const now = Date.now(),
        blobs = memoryBlobStore();
      await captureViewSession(db);
      await createEmptyView(db, 'project', 'session', now);
      const env = await captureViewTranscript(
        db,
        blobs,
        'session',
        tx(1),
        JSON.stringify({ v: 1, type: 'prompt', promptId, text: 'factcanary', at: now }) + '\n',
        now,
        0,
        'opencode',
      );
      await requestViewRebuild(db, 'project', 'session', now);
      const target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
      for (let pass = 0; pass < 8; pass++)
        if (
          (await parseViewOnce(env, target, now, {
            calls: 500,
            deadline: Date.now() + 10000,
            clock: Date.now,
            completeFile: true,
          })) === null
        )
          break;
      await completeViewConversion(db, 'project', 'session', promptId);
      expect((await tryPublishView(db, target, now, fixtureFlipEnvelope(store))).published).toBe(true);
      await captureViewTranscript(
        db,
        blobs,
        'session',
        tx(2),
        JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'other agent' }] } }) + '\n',
        now + 1,
        0,
        'cursor',
      );
      const before = await count(db),
        served = await serve(db, now);
      expect(before, store).toBe(1);
      expect(await acknowledgeViewPrompt(db, scope, served.run, served.target, now)).toMatchObject({ marked: true });
      expect(await count(db), store).toBe(before);
      expect(await sources(db)).toEqual([]);
      const offered = await serve(db, now);
      expect(offered.target.servedId).toBeString();
    }),
  );
}, 120000);
