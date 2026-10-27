import { expect, test, spyOn } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import {
  MaterialWriteRetryableError,
  setPublishedPlanStatus,
  ingestPublishedPlanEvent,
  ingestPublishedMaterialEvent,
  planPublishedPlanEvent,
  savePublishedPlan,
  changePublishedPlanStatus,
} from '@myco-server-worker/core/material-fact-writer.js';
import { viewContentHash } from '@myco-server-worker/core/material-content.js';
import { contentAssertion } from '@myco-server-worker/core/registered-content.js';
import { setPlanStatus } from '@myco-server-worker/read/plans.js';
import { withViewStores, captureViewSession } from './helpers/view-stores.js';
import { memoryBlobStore, uuid, envelope, recordingLimiter } from './helpers/fixtures.js';
import { withViewWriterDriver, withStatementSpan, observeStatementSpans, statementRecorder, type StatementFrame } from '../helpers/statement-recorder.js';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { TokenRevokedError } from '@myco-server-worker/telemetry.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { handleBlob } from '@myco-server-worker/ingest/blobs.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { measuredContentEnv, CONTENT_STATEMENT_LIMIT, CONTENT_BLOB_LIMIT } from '@myco-server-worker/core/content-budget.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { processedBody } from '@myco-server-worker/read/processed.js';

const scope = { projectId: 'project' },
  key = uuid(50);

function beforeBatch(db: RelationalStore, run: () => Promise<void>): RelationalStore {
  let armed = true;
  return {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      if (armed) {
        armed = false;
        await run();
      }
      return db.batch(statements);
    },
  };
}

test('a reported tool outcome versions its complete original input after canonical bundle adoption on native and D1', async () => {
  await withViewStores(async (db, target) =>
    withViewWriterDriver(async () => {
      await captureViewSession(db);
      const now = Date.now(),
        issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, now),
        env = { db, blobs: memoryBlobStore() };
      const ctx = { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now },
        toolCallId = uuid(90),
        input = { content: 'full input 😀 '.repeat(300) };
      const event = (n: number, kind: 'tool.failure' | 'tool.use', output: string) =>
        envelope({
          eventId: uuid(n),
          sessionId: 'session',
          kind,
          createdAt: now - 100,
          payload: {
            toolCallId,
            toolName: 'Read',
            input: kind === 'tool.failure' ? input : { wrong: 'replacement input' },
            success: kind === 'tool.use',
            output,
            ...(kind === 'tool.failure' ? { errorMessage: 'failed', resultReason: 'reported' } : {}),
          },
        });
      const version = () =>
        db
          .prepare(
            `SELECT material_seq,content_hash FROM material_versions WHERE project_id=? AND session_id=? AND kind='tool' AND record_id=? AND owner='fact'`,
          )
          .bind('project', 'session', toolCallId)
          .first<{ material_seq: number; content_hash: string }>();
      expect(
        (await ingestPublishedMaterialEvent(env, ctx, event(650, 'tool.failure', 'initial'))).persisted,
        target,
      ).toBe(true);
      const initial = (await version())!;
      const archived = await db
        .prepare(`SELECT * FROM tool_calls WHERE project_id=? AND tool_call_id=?`)
        .bind('project', toolCallId)
        .first<Record<string, unknown>>();
      expect(archived?.input_bundle_id).not.toBeNull();
      expect(archived?.input).not.toBe(JSON.stringify(input));
      expect(await processedBody(env, scope, 'tool-input', toolCallId)).toBe(JSON.stringify(input));
      expect(initial.content_hash).toBe(await viewContentHash('tool', { ...archived, input: JSON.stringify(input) }));
      expect((await ingestPublishedMaterialEvent(env, ctx, event(651, 'tool.use', 'reported'))).persisted).toBe(true);
      const updated = (await version())!;
      expect(updated.material_seq).toBeGreaterThan(initial.material_seq);
      const raw = await db
        .prepare(`SELECT * FROM tool_calls WHERE project_id=? AND tool_call_id=?`)
        .bind('project', toolCallId)
        .first<Record<string, unknown>>();
      expect(raw?.input_bundle_id).toBe(archived?.input_bundle_id);
      expect(raw?.tool_name).toBe('Read');
      expect(raw?.output_preview).toBe('reported');
      expect(updated.content_hash).toBe(await viewContentHash('tool', { ...raw, input: JSON.stringify(input) }));
      expect(updated.content_hash).not.toBe(await viewContentHash('tool', raw!));
      expect(await processedBody(env, scope, 'tool-input', toolCallId)).toBe(JSON.stringify(input));
      await ingestPublishedMaterialEvent(env, ctx, event(651, 'tool.use', 'reported'));
      expect(await version()).toEqual(updated);
    }),
  );
}, 60000);

test('parser metadata replay versions an applied reason change and leaves an identical replay unchanged', async () => {
  await withViewStores(async (db, target) =>
    withViewWriterDriver(async () => {
      await captureViewSession(db);
      const now = Date.now(),
        issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, now);
      const env = { db, blobs: memoryBlobStore() },
        ctx = {
          projectId: 'project',
          machineId: 'machine',
          tokenId: issued.tokenId,
          bodyBytes: 1,
          now,
          writeOrigin: 'server' as const,
        };
      const toolCallId = uuid(91),
        event = (resultReason?: string) =>
          envelope({
            eventId: uuid(660),
            sessionId: 'session',
            kind: 'tool.failure',
            createdAt: now - 100,
            producer: { adapter: 'transcript-parse', version: '1' },
            payload: {
              toolCallId,
              toolName: 'Read',
              input: { path: 'file' },
              success: false,
              errorMessage: 'no result',
              ...(resultReason === undefined ? {} : { resultReason }),
            },
          });
      const version = () =>
        db
          .prepare(
            `SELECT material_seq,content_hash FROM material_versions WHERE project_id=? AND session_id=? AND kind='tool' AND record_id=? AND owner='fact'`,
          )
          .bind('project', 'session', toolCallId)
          .first<{ material_seq: number; content_hash: string }>();
      expect((await ingestPublishedMaterialEvent(env, ctx, event())).persisted, target).toBe(true);
      const initial = (await version())!;
      expect((await ingestPublishedMaterialEvent(env, ctx, event('pending_limit'))).persisted).toBe(true);
      const changed = (await version())!;
      expect(changed.material_seq).toBeGreaterThan(initial.material_seq);
      const raw = await db
        .prepare(`SELECT * FROM tool_calls WHERE project_id=? AND tool_call_id=?`)
        .bind('project', toolCallId)
        .first<Record<string, unknown>>();
      expect(raw?.result_reason).toBe('pending_limit');
      expect(changed.content_hash).toBe(await viewContentHash('tool', raw!));
      expect((await ingestPublishedMaterialEvent(env, ctx, event('pending_limit'))).persisted).toBe(true);
      expect(await version()).toEqual(changed);
    }),
  );
}, 60000);

test('prompt metadata and reply-derived end times share the canonical material transaction on native and D1', async () => {
  await withViewStores(async (db, target) =>
    withViewWriterDriver(async () => {
      await captureViewSession(db);
      const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, 5000),
        env = { db, blobs: memoryBlobStore() };
      const ctx = { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: 5000 },
        promptId = uuid(80);
      const write = (eventId: number, kind: string, createdAt: number, payload: Record<string, unknown>) =>
        ingestPublishedMaterialEvent(
          env,
          ctx,
          envelope({ eventId: uuid(eventId), sessionId: 'session', kind, createdAt, payload }),
        );
      const version = (kind: string, id: string) =>
        db
          .prepare(
            `SELECT material_seq,content_hash FROM material_versions WHERE project_id=? AND session_id=? AND kind=? AND record_id=? AND owner='fact'`,
          )
          .bind('project', 'session', kind, id)
          .first<{ material_seq: number; content_hash: string }>();
      expect((await write(600, 'prompt', 1000, { promptId, text: 'question', origin: 'user' })).persisted, target).toBe(
        true,
      );
      const initial = (await version('prompt', promptId))!;
      expect(
        (
          await write(601, 'prompt', 1100, {
            promptId,
            text: 'question',
            origin: 'user',
            threadLabel: 'label',
            promptKind: 'user',
          })
        ).persisted,
      ).toBe(true);
      const metadata = (await version('prompt', promptId))!;
      expect(metadata.material_seq).toBeGreaterThan(initial.material_seq);
      const reply = uuid(81);
      expect((await write(602, 'response', 2000, { responseId: reply, promptId, text: 'answer' })).persisted).toBe(
        true,
      );
      const ended = (await version('prompt', promptId))!,
        response = (await version('response', reply))!;
      expect(ended.material_seq).toBeGreaterThan(metadata.material_seq);
      expect(response.material_seq).toBeGreaterThan(metadata.material_seq);
      const rawPrompt = await db
        .prepare(`SELECT * FROM prompt_batches WHERE project_id=? AND prompt_id=?`)
        .bind('project', promptId)
        .first<Record<string, unknown>>();
      expect(rawPrompt?.ended_at).toBe(2000);
      expect(ended.content_hash).toBe(await viewContentHash('prompt', rawPrompt!));
      const rawReply = await db
        .prepare(`SELECT * FROM responses WHERE project_id=? AND response_id=?`)
        .bind('project', reply)
        .first<Record<string, unknown>>();
      expect(response.content_hash).toBe(await viewContentHash('response', rawReply!));
      expect((await write(603, 'response', 2100, { responseId: uuid(82), promptId, text: 'later' })).persisted).toBe(
        true,
      );
      expect(await version('prompt', promptId)).toEqual(ended);
      expect((await write(604, 'response', 1900, { responseId: uuid(83), promptId, text: 'earlier' })).persisted).toBe(
        true,
      );
      expect((await version('prompt', promptId))!.material_seq).toBeGreaterThan(ended.material_seq);
      const stable = (await version('prompt', promptId))!;
      expect(await write(604, 'response', 1900, { responseId: uuid(83), promptId, text: 'earlier' })).toEqual({
        persisted: true,
        duplicate: true,
      });
      expect(await version('prompt', promptId)).toEqual(stable);
      expect((await write(605, 'prompt', 1200, { promptId, text: 'conflicting', origin: 'user' })).persisted).toBe(
        true,
      );
      expect(await version('prompt', promptId)).toEqual(stable);
      const refused = {
        ...env,
        db: {
          prepare: db.prepare.bind(db),
          batch: (statements: Parameters<typeof db.batch>[0]) =>
            db.batch([...statements, ...contentAssertion(db, '0', [])]),
        },
      };
      await expect(
        ingestPublishedMaterialEvent(
          refused,
          ctx,
          envelope({
            eventId: uuid(606),
            sessionId: 'session',
            kind: 'response',
            createdAt: 1800,
            payload: { responseId: uuid(84), promptId, text: 'roll back' },
          }),
        ),
      ).rejects.toThrow();
      expect(await version('response', uuid(84))).toBeNull();
      expect(await version('prompt', promptId)).toEqual(stable);
    }),
  );
}, 60000);

test('published fact status versions its canonical postimage and retries only changed evidence on native and D1', async () => {
  await withViewStores(async (db, target) =>
    withViewWriterDriver(async () => {
      await captureViewSession(db);
      const env = { db, blobs: memoryBlobStore() };
      const binding = () =>
        db
          .prepare(
            `SELECT * FROM material_versions WHERE project_id=? AND session_id=? AND kind='plan' AND record_id=? AND owner='fact'`,
          )
          .bind('project', 'session', key)
          .first<{ material_seq: number; content_hash: string }>();
      expect(await setPublishedPlanStatus(env, scope, key, 'active', 'member', 2), target).toBe(false);
      const initial = await binding();
      expect(initial?.material_seq).toBeGreaterThan(0);
      expect(await setPublishedPlanStatus(env, scope, key, 'active', 'member', 3)).toBe(false);
      expect(await binding()).toEqual(initial);
      expect(await setPublishedPlanStatus(env, scope, key, 'completed', 'member', 4)).toBe(true);
      const changed = await binding();
      expect(changed!.material_seq).toBeGreaterThan(initial!.material_seq);
      const row = await db
        .prepare(`SELECT * FROM plans WHERE project_id=? AND plan_key=?`)
        .bind('project', key)
        .first<Record<string, unknown>>();
      expect(changed!.content_hash).toBe(await viewContentHash('plan', { ...row, tags: [] }));

      const tagRace = beforeBatch(db, async () => {
        await db
          .prepare(`INSERT INTO tags(project_id,entity_kind,entity_id,tag) VALUES(?,'plan',?,?)`)
          .bind('project', key, 'racing-tag')
          .run();
      });
      await setPublishedPlanStatus({ ...env, db: tagRace }, scope, key, 'in_progress', 'member', 5);
      const withTags = await db
        .prepare(`SELECT * FROM plans WHERE project_id=? AND plan_key=?`)
        .bind('project', key)
        .first<Record<string, unknown>>();
      expect((await binding())!.content_hash).toBe(
        await viewContentHash('plan', { ...withTags, tags: ['racing-tag'] }),
      );
      expect((await binding())!.material_seq).toBeGreaterThan(changed!.material_seq);

      await Promise.all([
        setPublishedPlanStatus(env, scope, key, 'completed', 'member', 6),
        setPublishedPlanStatus(env, scope, key, 'abandoned', 'member', 6),
      ]);
      const concurrent = await db
        .prepare(`SELECT * FROM plans WHERE project_id=? AND plan_key=?`)
        .bind('project', key)
        .first<Record<string, unknown>>();
      expect((await binding())!.content_hash).toBe(
        await viewContentHash('plan', { ...concurrent, tags: ['racing-tag'] }),
      );

      const before = {
        row: concurrent,
        binding: await binding(),
        counter: await db
          .prepare(`SELECT * FROM learning_sessions WHERE project_id=? AND session_id=?`)
          .bind('project', 'session')
          .first(),
      };
      const failing: RelationalStore = {
        prepare: (sql) => db.prepare(sql),
        batch: (statements) => db.batch([...statements, ...contentAssertion(db, '0', [])]),
      };
      await expect(
        setPublishedPlanStatus({ ...env, db: failing }, scope, key, 'active', 'member', 7),
      ).rejects.toThrow();
      expect(await binding()).toEqual(before.binding);
      expect(
        await db.prepare(`SELECT * FROM plans WHERE project_id=? AND plan_key=?`).bind('project', key).first(),
      ).toEqual(before.row);
      expect(
        await db
          .prepare(`SELECT * FROM learning_sessions WHERE project_id=? AND session_id=?`)
          .bind('project', 'session')
          .first(),
      ).toEqual(before.counter);

      const legacyRace = beforeBatch(db, async () => {
        await db
          .prepare(
            `INSERT INTO fact_classes(project_id,table_name,record_id,session_id,class,classified_at) VALUES(?,'plans',?,?,'legacy',?)`,
          )
          .bind('project', key, 'session', 8)
          .run();
      });
      await expect(
        setPublishedPlanStatus({ ...env, db: legacyRace }, scope, key, 'active', 'member', 8),
      ).rejects.toThrow('material_promotion_required');
      expect(await binding()).toEqual(before.binding);
      expect(await setPlanStatus(db, scope, key, 'active', 'member', 9)).toBe(true);
      expect(await binding()).toEqual(before.binding);
    }),
  );
}, 60000);

test('the canonical save operation versions complete blob content and retains an administrative status on title-only edits', async () => {
  await withViewStores(async (db, target) =>
    withViewWriterDriver(async () => {
      await captureViewSession(db);
      const blobs = memoryBlobStore(),
        env = {
          ...serverEnvFromBindings({
            MYCO_DB: db,
            BUCKET: blobs,
            SOURCE_LIMIT: recordingLimiter(),
            TOKEN_LIMIT: recordingLimiter(),
          }),
          blobs,
        };
      const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, 4000),
        member = { machineId: 'machine', tokenId: issued.tokenId };
      const body = 'complete plan body 😀 '.repeat(2000),
        blob = await sha256Hex(body),
        bytes = new TextEncoder().encode(body),
        planKey = uuid(70);
      const upload = await handleBlob(
        env,
        new Request('http://127.0.0.1/blobs/' + blob, {
          method: 'PUT',
          headers: { 'content-type': 'text/plain' },
          body: bytes,
        }),
        {
          projectId: 'project',
          machineId: 'machine',
          tokenId: issued.tokenId,
          now: 4000,
          clock: () => 4000,
          contentLength: bytes.length,
          params: { key: blob },
        },
      );
      expect(((await upload.json()) as { stored: boolean }).stored, target).toBe(true);
      await ingestPublishedPlanEvent(
        env,
        { projectId: 'project', ...member, bodyBytes: 1, now: 4000 },
        envelope({
          eventId: uuid(500),
          sessionId: 'session',
          kind: 'plan',
          createdAt: 4000,
          payload: { planKey, blob, title: 'Blob plan', tags: ['complete'] },
        }),
      );
      const version = () =>
        db
          .prepare(
            `SELECT * FROM material_versions WHERE project_id=? AND session_id=? AND kind='plan' AND record_id=? AND owner='fact'`,
          )
          .bind('project', 'session', planKey)
          .first<{ material_seq: number; content_hash: string }>();
      const initial = (await version())!;
      const status = await changePublishedPlanStatus(env, scope, planKey, 'completed', 'member', 4100);
      expect(status?.status).toBe('completed');
      expect((await version())!.material_seq).toBeGreaterThan(initial.material_seq);
      const saved = await savePublishedPlan(
        env,
        member,
        scope,
        { id: planKey, sessionId: 'session', title: 'Edited title' },
        4200,
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error(saved.error);
      expect(saved.row.status).toBe('completed');
      expect(saved.row.blobKey).toBe(blob);
      const raw = await db
        .prepare(`SELECT * FROM plans WHERE project_id=? AND plan_key=?`)
        .bind('project', planKey)
        .first<Record<string, unknown>>();
      expect((await version())!.content_hash).toBe(
        await viewContentHash('plan', { ...raw, content: body, tags: ['complete'] }),
      );
      const stable = await version();
      expect(
        (
          await savePublishedPlan(
            env,
            member,
            scope,
            { id: planKey, sessionId: 'session', title: 'Edited title' },
            4300,
          )
        ).ok,
      ).toBe(true);
      expect(await version()).toEqual(stable);
      const held = (await db
        .prepare(`SELECT generation FROM blobs WHERE project_id=? AND key=?`)
        .bind('project', blob)
        .first<{ generation: string }>())!;
      const objectKey = blobObjectKey('project', blob, held.generation),
        original = blobs.objects.get(objectKey)!;
      blobs.seed(objectKey, { size: bytes.length, bytes: new TextEncoder().encode('x'.repeat(bytes.length)) });
      await expect(
        savePublishedPlan(env, member, scope, { id: planKey, sessionId: 'session', title: 'Must not commit' }, 4400),
      ).rejects.toThrow('content_archive_digest_mismatch');
      expect(await version()).toEqual(stable);
      expect(
        (
          await db
            .prepare(`SELECT title FROM plans WHERE project_id=? AND plan_key=?`)
            .bind('project', planKey)
            .first<{ title: string }>()
        )?.title,
      ).toBe('Edited title');
      blobs.seed(objectKey, original);
    }),
  );
}, 60000);

test('canonical plan event publication versions tags and content, carries provenance and re-derives identity races atomically', async () => {
  await withViewStores(async (db, target) =>
    withViewWriterDriver(async () => {
      await captureViewSession(db);
      const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, 3000),
        env = { db, blobs: memoryBlobStore() };
      const ctx = { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: 3000 };
      const event = (n: number, at: number, body: string, tags = ['tag'], planKey = key) =>
        envelope({
          eventId: uuid(n),
          sessionId: 'session',
          kind: 'plan',
          createdAt: at,
          payload: { planKey, content: body, title: 'Published', tags },
        });
      const version = (planKey = key) =>
        db
          .prepare(
            `SELECT content_hash,material_seq FROM material_versions WHERE project_id=? AND session_id=? AND kind='plan' AND record_id=? AND owner='fact'`,
          )
          .bind('project', 'session', planKey)
          .first<{ content_hash: string; material_seq: number }>();
      const prepared = await planPublishedPlanEvent(env, ctx, event(400, 1200, 'published'));
      if (!prepared.ok) throw new Error(prepared.reason);
      for (const proof of prepared.evidence) {
        expect(
          (
            await db
              .prepare(`SELECT (${proof.sql}) admitted`)
              .bind(...proof.params)
              .first<{ admitted: number }>()
          )?.admitted,
          target,
        ).toBe(1);
      }
      expect((await ingestPublishedPlanEvent(env, ctx, event(400, 1200, 'published'))).persisted, target).toBe(true);
      const initial = (await version())!;
      expect(initial.material_seq).toBe(1);
      const counter = () =>
        db
          .prepare(`SELECT * FROM learning_sessions WHERE project_id=? AND session_id=?`)
          .bind('project', 'session')
          .first();
      const firstCounter = await counter();
      expect(await ingestPublishedPlanEvent(env, ctx, event(400, 1200, 'published'))).toEqual({
        persisted: true,
        duplicate: true,
      });
      expect(await version()).toEqual(initial);
      expect(await counter()).toEqual(firstCounter);
      await ingestPublishedPlanEvent(env, ctx, event(401, 1300, 'published', ['changed']));
      const tags = (await version())!;
      expect(tags.material_seq).toBeGreaterThan(initial.material_seq);
      await ingestPublishedPlanEvent(env, ctx, event(402, 1250, 'stale', ['stale']));
      expect(await version()).toEqual(tags);
      await ingestPublishedPlanEvent(env, ctx, event(403, 1400, 'published', ['changed']));
      expect(await version()).toEqual(tags);
      await Promise.all([
        ingestPublishedPlanEvent(env, ctx, event(404, 1500, 'first', ['one'], uuid(61))),
        ingestPublishedPlanEvent(env, ctx, event(405, 1500, 'second', ['two'], uuid(62))),
      ]);
      expect((await version(uuid(61)))!.material_seq).not.toBe((await version(uuid(62)))!.material_seq);
      await Promise.all([
        ingestPublishedPlanEvent(env, ctx, event(406, 1600, 'earlier', ['earlier'])),
        ingestPublishedPlanEvent(env, ctx, event(407, 1700, 'later', ['later'])),
      ]);
      const current = await db
        .prepare(`SELECT * FROM plans WHERE project_id=? AND plan_key=?`)
        .bind('project', key)
        .first<Record<string, unknown>>();
      expect(current!.content).toBe('later');
      expect((await version())!.content_hash).toBe(await viewContentHash('plan', { ...current, tags: ['later'] }));
      const before = { row: current, binding: await version(), counter: await counter() };
      let attempts = 0;
      const failing: RelationalStore = {
        prepare: (sql) => db.prepare(sql),
        batch: (statements) => {
          attempts++;
          return db.batch([...statements, ...contentAssertion(db, '0', [])]);
        },
      };
      await expect(
        ingestPublishedPlanEvent({ ...env, db: failing }, ctx, event(408, 1800, 'rolled back')),
      ).rejects.toThrow();
      expect(attempts).toBe(1);
      expect(await counter()).toEqual(before.counter);
      expect(await version()).toEqual(before.binding);
      expect(
        await db.prepare(`SELECT * FROM plans WHERE project_id=? AND plan_key=?`).bind('project', key).first(),
      ).toEqual(before.row);

      await db.prepare(`UPDATE projects SET archived_at=? WHERE project_id=?`).bind(2000, 'project').run();
      const admittedLater = beforeBatch(db, async () => {
        await db.prepare(`UPDATE projects SET archived_at=NULL WHERE project_id=?`).bind('project').run();
      });
      expect(
        (
          await ingestPublishedPlanEvent(
            { ...env, db: admittedLater },
            ctx,
            event(409, 1900, 'admitted after re-derive'),
          )
        ).persisted,
      ).toBe(true);
      expect((await version())!.material_seq).toBeGreaterThan(before.binding!.material_seq);
      const stable = await counter();
      const revoked = beforeBatch(db, async () => {
        await db.prepare(`UPDATE member_credentials SET revoked_at=? WHERE id=?`).bind(2999, issued.tokenId).run();
      });
      await expect(
        ingestPublishedPlanEvent({ ...env, db: revoked }, ctx, event(410, 2000, 'refused')),
      ).rejects.toBeInstanceOf(TokenRevokedError);
      expect(await counter()).toEqual(stable);
      await expect(
        ingestPublishedPlanEvent(
          env,
          ctx,
          envelope({
            eventId: uuid(411),
            sessionId: 'absent',
            kind: 'plan',
            payload: { planKey: uuid(63), content: 'refused' },
          }),
        ),
      ).rejects.toBeInstanceOf(TokenRevokedError);
      expect(
        await db
          .prepare(`SELECT * FROM learning_sessions WHERE project_id=? AND session_id=?`)
          .bind('project', 'absent')
          .first(),
      ).toBeNull();
    }),
  );
}, 60000);

test('the canonical plan merge and tag operation define the same postimage for new, edited, stale and tied events', async () => {
  await withViewStores(async (db, target) => {
    await captureViewSession(db);
    const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, 3000),
      key = uuid(60);
    const cases = [
      {
        eventId: uuid(200),
        createdAt: 1002,
        payload: { content: 'initial body', title: 'Initial', tags: ['b', 'a', 'a'] },
      },
      {
        eventId: uuid(202),
        createdAt: 2200,
        payload: { content: 'updated body', title: 'Updated', tags: ['changed'] },
      },
      {
        eventId: uuid(203),
        createdAt: 2100,
        payload: { content: 'stale body', title: 'Stale', tags: ['stale'], status: 'active' },
      },
      { eventId: uuid(201), createdAt: 2200, payload: { content: 'tie winner', title: 'Tie', tags: ['tie', 'tie'] } },
    ];
    for (const [index, input] of cases.entries()) {
      if (index === 1) await setPlanStatus(db, scope, key, 'completed', 'member', 2100);
      const planned = await planEventWrite(
        db,
        { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: 3000 },
        envelope({ sessionId: 'session', kind: 'plan', ...input, payload: { planKey: key, ...input.payload } }),
      );
      if (!planned.ok) throw new Error(planned.reason);
      const effect = planned.write.material?.effects[0];
      expect(effect, target).toBeDefined();
      const selected = await db
        .prepare(`SELECT (${effect!.postimage.sql}) doc`)
        .bind(...effect!.postimage.params)
        .first<{ doc: string }>();
      const affinity = await db
        .prepare(`SELECT json_type((${effect!.postimage.sql}),'$.updated_at') type`)
        .bind(...effect!.postimage.params)
        .first<{ type: string }>();
      expect(affinity?.type, target).toBe('integer');
      const expected = JSON.parse(selected!.doc) as Record<string, unknown>;
      const results = await db.batch(planned.write.statements);
      expect(planned.write.interpret(results).persisted).toBe(true);
      const actual = await db
        .prepare(`SELECT * FROM plans WHERE project_id=? AND plan_key=?`)
        .bind('project', key)
        .first<Record<string, unknown>>();
      for (const [field, value] of Object.entries(expected))
        if (field !== '_new' && field !== 'tags') expect(actual![field], target + ':' + field).toEqual(value);
      const tags = (
        await db
          .prepare(`SELECT tag FROM tags WHERE project_id=? AND entity_kind='plan' AND entity_id=? ORDER BY tag`)
          .bind('project', key)
          .all<{ tag: string }>()
      ).results.map((row) => row.tag);
      expect(expected.tags).toEqual(tags);
      if (index > 0) expect(actual!.status).toBe('completed');
    }
  });
}, 60000);

test('twelve same-identity replies in descending and mixed order all persist within bounded contention admission', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      await captureViewSession(db);
      const now = Date.now();
      const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, now);
      const recorded = statementRecorder(db, { accounting: 'native' });
      const blobs = memoryBlobStore(), env = { db: recorded.db, blobs };
      const blobCalls = (['head','get','put','delete'] as const).map(method=>spyOn(blobs,method));
      const invocations: StatementFrame[] = [];
      const stop = observeStatementSpans(frame=>{
        if(frame.phase==='contention-response')invocations.push(frame);
      });
      const clock = spyOn(Date,'now').mockReturnValue(now);
      try {
        for (const [round, order] of [
          [0, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]],
          [1, [5, 10, 2, 8, 0, 11, 3, 9, 1, 7, 4, 6]],
        ] as const) {
          const results = await Promise.all(
            order.map((i) => withStatementSpan('view-writer-driver','contention-response',() =>
              ingestPublishedMaterialEvent(
                env,
                { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now },
                envelope({
                  eventId: uuid(3000 + round * 100 + i),
                  sessionId: 'session',
                  kind: 'response',
                  createdAt: 500 - round * 100 - i,
                  payload: {
                    responseId: uuid(3100 + round * 100 + i),
                    promptId: uuid(20),
                    text: 'reply ' + round + '/' + i,
                  },
                }),
              ),
            )),
          );
          expect(
            results.every((result) => result.persisted),
            store,
          ).toBe(true);
        }
        expect(invocations).toHaveLength(24);
        const counts=invocations.map(frame=>recorded.statements.filter(row=>row.spanId===frame.spanId).length);
        for(const count of counts){
          expect(count,store).toBeGreaterThan(0);
          expect(count,store).toBeLessThanOrEqual(CONTENT_STATEMENT_LIMIT);
        }
        const totalBlobCalls=blobCalls.reduce((sum,call)=>sum+call.mock.calls.length,0);
        expect(totalBlobCalls,store).toBe(0);
        expect(totalBlobCalls,store).toBeLessThanOrEqual(CONTENT_BLOB_LIMIT);
        console.info(JSON.stringify({kind:'material_contention_bound',store,replies:counts.length,maxStatements:Math.max(...counts),blobCalls:totalBlobCalls}));
      } finally {
        clock.mockRestore();
        stop();
        blobCalls.forEach(call=>call.mockRestore());
      }
      expect(
        (await db
          .prepare('SELECT COUNT(*) n FROM responses WHERE project_id=? AND session_id=?')
          .bind('project', 'session')
          .first<{ n: number }>())!.n,
      ).toBe(25);
    }),
  );
}, 120000);

test('exhausted material contention admission is typed and retryable without partial capture', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      await captureViewSession(db);
      const now = Date.now(),
        issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, now);
      const env = measuredContentEnv(
        { db, blobs: memoryBlobStore() },
        { statements: 1, blobCalls: 1, wallMs: 2000 },
      ).env;
      const error = await ingestPublishedMaterialEvent(
        env,
        { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now },
        envelope({
          eventId: uuid(3500),
          sessionId: 'session',
          kind: 'response',
          createdAt: 100,
          payload: { responseId: uuid(3501), promptId: uuid(20), text: 'retry me' },
        }),
      ).catch((error: unknown) => error);
      expect(error, store).toBeInstanceOf(MaterialWriteRetryableError);
      expect(error).toMatchObject({ code: 'material_write_retryable', retryable: true });
      expect(
        await db
          .prepare('SELECT event_id FROM events WHERE project_id=? AND event_id=?')
          .bind('project', uuid(3500))
          .first(),
      ).toBeNull();
    }),
  );
}, 120000);

test('material retries continue after four separately committed canonical tag changes', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      await captureViewSession(db);
      let commits = 0;
      const racing = {
        prepare: db.prepare.bind(db),
        batch: async (statements: Parameters<typeof db.batch>[0]) => {
          if (commits < 4) {
            await db
              .prepare("INSERT INTO tags(project_id,entity_kind,entity_id,tag) VALUES(?,'plan',?,?)")
              .bind('project', key, 'concurrent-' + ++commits)
              .run();
          }
          return db.batch(statements);
        },
      };
      expect(
        await setPublishedPlanStatus(
          { db: racing, blobs: memoryBlobStore() },
          scope,
          key,
          'completed',
          'member',
          Date.now(),
        ),
        store,
      ).toBe(true);
      expect(commits).toBe(4);
      expect(
        (await db
          .prepare('SELECT status FROM plans WHERE project_id=? AND plan_key=?')
          .bind('project', key)
          .first<{ status: string }>())!.status,
      ).toBe('completed');
    }),
  );
}, 120000);
