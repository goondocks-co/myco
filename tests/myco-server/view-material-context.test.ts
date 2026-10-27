import { expect, test } from 'bun:test';
import { withViewStores, captureViewSession } from './helpers/view-stores.js';
import { memoryBlobStore, uuid, envelope, recordingLimiter } from './helpers/fixtures.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';
import {
  ingestPublishedMaterialEvent,
  commitPublishedContextWrite,
  restorePublishedMaterial,
  setPublishedPlanStatus,
} from '@myco-server-worker/core/material-fact-writer.js';
import {
  prepareInjectionReceipt,
  preparePromptAnswer,
  prepareSessionRecord,
} from '@myco-server-worker/core/context-writes.js';
import { sessionWriteAdmission } from '@myco-server-worker/ingest/projections.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { handleBlob } from '@myco-server-worker/ingest/blobs.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { TURN_KIND } from '@goondocks/myco-shared/member-protocol';
import { CONTEXT_DELIVERED_KIND } from '@goondocks/myco-shared/prompt-identity';
import { materialContentHash } from '@myco-server-worker/core/material-content.js';
import { prepareMaterialRestore } from '@myco-server-worker/core/material-restore.js';
import { prepareArchive, eventArchiveStatements } from '@myco-server-worker/core/event-content.js';
import { readBundleEntry } from '@myco-server-worker/core/archive-bundle.js';
import { processedBody } from '@myco-server-worker/read/processed.js';
import { FACT_MATERIALS } from '@myco-server-worker/db/view-tables.js';
import { restoreArchivedEvent } from '@myco-server-worker/core/event-content-restore.js';

test('context delivery, attachments and raw turn/subagent facts publish their canonical admitted material', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const now = Date.now(),
        blobs = memoryBlobStore(),
        originalInput = { path: 'full original 😀 '.repeat(300) };
      await captureViewSession(db, 'project', 'session', { toolInput: originalInput, blobs });
      const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, now);
      const env = {
        ...serverEnvFromBindings({
          MYCO_DB: db,
          BUCKET: blobs,
          SOURCE_LIMIT: recordingLimiter(),
          TOKEN_LIMIT: recordingLimiter(),
        }),
        blobs,
      };
      const ctx = { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now },
        admission = sessionWriteAdmission(ctx, 'session').admission;
      const receiptId = uuid(910),
        answerId = uuid(911);
      await commitPublishedContextWrite(
        db,
        prepareInjectionReceipt(
          db,
          {
            project: 'project',
            session: 'session',
            id: receiptId,
            promptId: null,
            scopeReason: 'absent_key',
            protocol: 'legacy',
            askedAt: null,
            promptHash: 'context',
            spores: [],
            plans: [],
            now,
          },
          admission,
        ),
      );
      await commitPublishedContextWrite(
        db,
        preparePromptAnswer(
          db,
          {
            project: 'project',
            session: 'session',
            id: answerId,
            promptId: null,
            scopeReason: 'absent_key',
            protocol: 'legacy',
            askedAt: null,
            receiptId,
            outcome: 'served',
            chars: 10,
            parts: [{ kind: 'plan-nudge' }],
            skipped: [],
            failures: [],
            selection: {},
            now,
          },
          admission,
        ),
      );
      await commitPublishedContextWrite(
        db,
        prepareSessionRecord(db, 'project', 'session', 'plan-nudge', now, admission),
      );
      const before = (await db
        .prepare(`SELECT next_seq FROM learning_sessions WHERE project_id=? AND session_id=?`)
        .bind('project', 'session')
        .first<{ next_seq: number }>())!.next_seq;
      const delivery = (n: number) =>
        envelope({
          eventId: uuid(n),
          sessionId: 'session',
          kind: CONTEXT_DELIVERED_KIND,
          createdAt: now + 1,
          payload: { receiptId, answerId, renderedScopeReason: 'absent_key' },
        });
      expect((await ingestPublishedMaterialEvent(env, ctx, delivery(912))).persisted, store).toBe(true);
      const after = (await db
        .prepare(`SELECT next_seq FROM learning_sessions WHERE project_id=? AND session_id=?`)
        .bind('project', 'session')
        .first<{ next_seq: number }>())!.next_seq;
      expect(after).toBe(before + 3);
      await ingestPublishedMaterialEvent(env, ctx, delivery(913));
      expect(
        (await db
          .prepare(`SELECT next_seq FROM learning_sessions WHERE project_id=? AND session_id=?`)
          .bind('project', 'session')
          .first<{ next_seq: number }>())!.next_seq,
      ).toBe(after);
      for (const [kind, table, id] of [
        ['injection', 'spore_injections', receiptId],
        ['answer', 'prompt_context_answers', answerId],
        ['session-record', 'session_injections', 'plan-nudge'],
      ] as const) {
        const key = kind === 'session-record' ? 'kind' : 'id';
        const row = (await db
          .prepare(`SELECT * FROM ${table} WHERE project_id=? AND session_id=? AND ${key}=?`)
          .bind('project', 'session', id)
          .first<Record<string, unknown>>())!;
        const binding = (await db
          .prepare(
            `SELECT content_hash,material_seq FROM material_versions WHERE project_id=? AND session_id=? AND kind=? AND record_id=?`,
          )
          .bind('project', 'session', kind, id)
          .first<{ content_hash: string; material_seq: number }>())!;
        expect(binding.content_hash).toBe(await materialContentHash(kind, row));
        expect(binding.material_seq).toBeGreaterThanOrEqual(before);
      }
      const body = 'attachment bytes',
        blob = await sha256Hex(body),
        bytes = new TextEncoder().encode(body);
      const uploaded = await handleBlob(
        env,
        new Request('http://127.0.0.1/blobs/' + blob, {
          method: 'PUT',
          headers: { 'content-type': 'text/plain' },
          body: bytes,
        }),
        { ...ctx, clock: () => now, contentLength: bytes.length, params: { key: blob } },
      );
      expect(((await uploaded.json()) as { stored: boolean }).stored).toBe(true);
      const events = [
        envelope({
          eventId: uuid(914),
          sessionId: 'session',
          kind: 'attachment',
          createdAt: now,
          payload: { attachmentId: uuid(915), blob, description: 'kept file' },
        }),
        envelope({
          eventId: uuid(916),
          sessionId: 'session',
          kind: TURN_KIND,
          createdAt: now,
          payload: { phase: 'end', promptId: uuid(20) },
        }),
        envelope({
          eventId: uuid(917),
          sessionId: 'session',
          kind: 'subagent.start',
          createdAt: now,
          payload: { subagentId: uuid(920), agentType: 'helper', parentPromptId: uuid(20) },
        }),
        envelope({
          eventId: uuid(918),
          sessionId: 'session',
          kind: 'subagent.stop',
          createdAt: now,
          payload: { subagentId: uuid(920), agentType: 'helper', parentPromptId: uuid(20) },
        }),
      ];
      for (const event of events) expect((await ingestPublishedMaterialEvent(env, ctx, event)).persisted).toBe(true);
      const bindings = (
        await db
          .prepare(
            `SELECT kind,record_id,material_seq FROM material_versions WHERE project_id=? AND kind IN ('attachment','event') ORDER BY material_seq`,
          )
          .bind('project')
          .all<{ kind: string; record_id: string; material_seq: number }>()
      ).results;
      expect(bindings.map((row) => row.kind)).toEqual(['attachment', 'event', 'event', 'event']);
      expect(new Set(bindings.map((row) => row.material_seq)).size).toBe(4);
      const stable = (await db.prepare(`SELECT * FROM learning_sessions`).all()).results;
      for (const event of events) expect((await ingestPublishedMaterialEvent(env, ctx, event)).persisted).toBe(true);
      expect((await db.prepare(`SELECT * FROM learning_sessions`).all()).results).toEqual(stable);
      const raw = (await db
        .prepare(`SELECT * FROM events WHERE project_id=? AND event_id=?`)
        .bind('project', uuid(916))
        .first<{
          token_id: string;
          envelope_hash: string;
          content_revision: number;
          received_at: number;
          raw_revision: number | null;
          payload: string;
        }>())!;
      const source = {
        project_id: 'project',
        session_id: 'session',
        event_id: uuid(916),
        resource_id: uuid(916),
        token_id: raw.token_id,
        envelope_hash: raw.envelope_hash,
        content_revision: raw.content_revision,
        received_at: raw.received_at,
        raw_revision: raw.raw_revision ?? 0,
        bytes: new TextEncoder().encode(raw.payload).length,
      };
      const archive = await prepareArchive(env, 'event', source, now);
      await db.batch(eventArchiveStatements(db, source, archive));
      expect((await db.prepare(`SELECT * FROM learning_sessions`).all()).results).toEqual(stable);
      const archived = (await db
        .prepare(`SELECT * FROM events WHERE project_id=? AND event_id=?`)
        .bind('project', uuid(916))
        .first<Record<string, unknown>>())!;
      const bundle = (await db
        .prepare(`SELECT * FROM archive_bundles WHERE project_id=? AND id=?`)
        .bind('project', archived.bundle_id)
        .first<Record<string, unknown>>())!;
      expect(
        await readBundleEntry(env, {
          projectId: 'project',
          kind: 'event',
          resourceId: uuid(916),
          bundleId: Number(archived.bundle_id),
          entry: Number(archived.bundle_entry),
          tokenId: raw.token_id,
        }),
      ).toBe(raw.payload);
      await db.prepare(`DELETE FROM events WHERE project_id=? AND event_id=?`).bind('project', uuid(916)).run();
      expect(await restoreArchivedEvent(db, archived, bundle)).toBe(1);
      expect((await db.prepare(`SELECT * FROM learning_sessions`).all()).results).toEqual(stable);
      expect(
        (
          await db
            .prepare(
              `SELECT kind,record_id,material_seq FROM material_versions WHERE project_id=? AND kind IN ('attachment','event') ORDER BY material_seq`,
            )
            .bind('project')
            .all()
        ).results,
      ).toEqual(bindings);
      for (const definition of Object.values(FACT_MATERIALS)) {
        const restored = (await db
          .prepare(
            `SELECT * FROM ${definition.fact} WHERE project_id=? AND session_id=?${definition.kind === 'event' ? ' AND kind=?' : ''} LIMIT 1`,
          )
          .bind('project', 'session', ...(definition.kind === 'event' ? ['subagent.start'] : []))
          .first<Record<string, unknown>>())!;
        expect(restored, definition.kind).not.toBeNull();
        await db
          .prepare(`DELETE FROM ${definition.fact} WHERE project_id=? AND ${definition.id}=?`)
          .bind('project', restored[definition.id])
          .run();
        expect((await restorePublishedMaterial(env, definition.fact, restored)).results, definition.kind).toHaveLength(
          1,
        );
        const versions = (
          await db
            .prepare(`SELECT * FROM material_versions WHERE project_id=? AND session_id=? ORDER BY material_seq`)
            .bind('project', 'session')
            .all()
        ).results;
        const allocator = (
          await db
            .prepare(`SELECT * FROM learning_sessions WHERE project_id=? AND session_id=?`)
            .bind('project', 'session')
            .all()
        ).results;
        await db
          .prepare(`DELETE FROM ${definition.fact} WHERE project_id=? AND ${definition.id}=?`)
          .bind('project', restored[definition.id])
          .run();
        expect((await restorePublishedMaterial(env, definition.fact, restored)).results, definition.kind).toHaveLength(
          1,
        );
        expect(
          await db
            .prepare(`SELECT * FROM ${definition.fact} WHERE project_id=? AND ${definition.id}=?`)
            .bind('project', restored[definition.id])
            .first(),
          definition.kind,
        ).toEqual(restored);
        expect(
          (
            await db
              .prepare(`SELECT * FROM material_versions WHERE project_id=? AND session_id=? ORDER BY material_seq`)
              .bind('project', 'session')
              .all()
          ).results,
          definition.kind,
        ).toEqual(versions);
        expect(
          (
            await db
              .prepare(`SELECT * FROM learning_sessions WHERE project_id=? AND session_id=?`)
              .bind('project', 'session')
              .all()
          ).results,
          definition.kind,
        ).toEqual(allocator);
        if (definition.kind === 'tool')
          expect(await processedBody(env, { projectId: 'project' }, 'tool-input', String(restored.tool_call_id))).toBe(
            JSON.stringify(originalInput),
          );
        console.log(
          JSON.stringify({ kind: 'material_restore_witness', table: definition.fact, store, sameContentCarry: true }),
        );
      }
    }),
  );
}, 120000);

test('the additive restore owner preserves same-content versions and allocates for genuinely different admitted content', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      await captureViewSession(db);
      const env = { db, blobs: memoryBlobStore() },
        scope = { projectId: 'project' },
        key = uuid(50);
      await setPublishedPlanStatus(env, scope, key, 'active', 'member', 2);
      const row = (await db
        .prepare(`SELECT * FROM plans WHERE project_id=? AND plan_key=?`)
        .bind('project', key)
        .first<Record<string, unknown>>())!;
      const binding = () =>
        db
          .prepare(
            `SELECT * FROM material_versions WHERE project_id=? AND session_id=? AND kind='plan' AND record_id=?`,
          )
          .bind('project', 'session', key)
          .first<{ material_seq: number; content_hash: string }>();
      const original = (await binding())!;
      expect((await restorePublishedMaterial(env, 'plans', row)).results, store).toHaveLength(0);
      expect(await binding()).toEqual(original);
      await db.prepare(`DELETE FROM plans WHERE project_id=? AND plan_key=?`).bind('project', key).run();
      expect((await restorePublishedMaterial(env, 'plans', row)).results).toHaveLength(1);
      expect(await binding()).toEqual(original);
      await db.prepare(`DELETE FROM plans WHERE project_id=? AND plan_key=?`).bind('project', key).run();
      const changed = {
        ...row,
        content: 'different authoritative body',
        content_hash: await sha256Hex('different authoritative body'),
      };
      expect((await restorePublishedMaterial(env, 'plans', changed)).results).toHaveLength(1);
      const fresh = (await binding())!;
      expect(fresh.material_seq).toBeGreaterThan(original.material_seq);
      expect(fresh.content_hash).not.toBe(original.content_hash);
      const before = (await db.prepare(`SELECT * FROM learning_sessions`).all()).results;
      expect((await restorePublishedMaterial(env, 'plans', row)).results).toHaveLength(0);
      expect(await binding()).toEqual(fresh);
      expect((await db.prepare(`SELECT * FROM learning_sessions`).all()).results).toEqual(before);
      const legacy = {
        project_id: 'project',
        session_id: 'session',
        id: uuid(930),
        prompt_id: null,
        scope_reason: 'absent_key',
        outcome: 'empty',
        context_chars: 0,
        parts: '[]',
        skipped: '[]',
        failures: '[]',
        selection: '{}',
        created_at: 3,
      };
      const prepared = await prepareMaterialRestore(db, 'prompt_context_answers', legacy);
      expect(prepared.write).not.toBeNull();
      await restorePublishedMaterial(env, 'prompt_context_answers', legacy);
      const answer = (await db
        .prepare(`SELECT * FROM prompt_context_answers WHERE project_id=? AND id=?`)
        .bind('project', uuid(930))
        .first<Record<string, unknown>>())!;
      const version = (await db
        .prepare(`SELECT content_hash FROM material_versions WHERE project_id=? AND kind='answer' AND record_id=?`)
        .bind('project', uuid(930))
        .first<{ content_hash: string }>())!;
      expect(answer.ask_protocol).toBe('legacy');
      expect(version.content_hash).toBe(await materialContentHash('answer', answer));
    }),
  );
}, 120000);
