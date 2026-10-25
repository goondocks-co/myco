import { fixtureFlipEnvelope } from '../helpers/view-flip-envelope.js';
import { expect, test } from 'bun:test';
import { withViewStores, captureViewSession, captureViewTranscript } from './helpers/view-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';
import { createEmptyView, requestViewRebuild, tryPublishView } from '@myco-server-worker/ingest/view-lifecycle.js';
import { claimViewBuild, SERIAL_VIEW_BUDGET } from '@myco-server-worker/ingest/view-build-queue.js';
import { parseViewOnce } from '@myco-server-worker/ingest/view-parse.js';
import {
  exportMaterialVersions,
  restoreMaterialVersionStatements,
} from '@myco-server-worker/core/material-version-backup.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { setViewParserVersion } from './helpers/view-instances.js';
import { PARSER_VERSION } from '@myco-server-worker/ingest/parse.js';
import { viewContentHash } from '@myco-server-worker/core/material-content.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { codexParser } from '@myco-server-worker/ingest/parsers/codex.js';
import { withParserContinuation, MAX_VIEW_PENDING_BYTES } from '@myco-server-worker/ingest/parsers/incremental.js';
import type { ParserState } from '@myco-server-worker/ingest/parsers/index.js';

const tx = 'tx_0123456789abcdef0123456789abcdef';
const item = (payload: Record<string, unknown>) => JSON.stringify({ type: 'response_item', payload }) + '\n';

test('material hashes preserve complete body meaning across inline and verified blob representations', async () => {
  const input = 'full input 😀 '.repeat(3000),
    output = 'full output 😀 '.repeat(3000);
  const inline = { tool_name: 'Read', input, output_preview: output };
  const blob = {
    ...inline,
    input: input.slice(0, 100),
    input_blob_key: await sha256Hex(input),
    output_preview: output.slice(0, 100),
    output_blob_key: await sha256Hex(output),
  };
  expect(await viewContentHash('tool', blob)).toBe(await viewContentHash('tool', inline));
  expect(await viewContentHash('tool', { ...inline, input: input + 'x' })).not.toBe(
    await viewContentHash('tool', inline),
  );
  expect(await viewContentHash('tool', { ...inline, output_preview: output + 'x' })).not.toBe(
    await viewContentHash('tool', inline),
  );
  await expect(viewContentHash('tool', { ...blob, input_blob_key: 'invalid' })).rejects.toThrow(
    'material_body_digest_invalid',
  );
});

test('view pending input bytes flush the oldest call intact', async () => {
  const content = 'x'.repeat(Math.floor(MAX_VIEW_PENDING_BYTES / 2)),
    state: ParserState = {},
    parser = withParserContinuation(codexParser);
  const lines = [0, 1].map((offset) => ({
    offset,
    value: {
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'large-' + offset,
        name: 'Read',
        arguments: JSON.stringify({ content }),
      },
    },
  }));
  const events = await parser.parse({
    view: true,
    state,
    lines,
    sessionId: 'session',
    transcriptId: tx,
    scheme: 'offset-v2',
    recordScheme: 'source-record-v1',
    now: 1,
  });
  expect(events).toHaveLength(1);
  expect(events[0]!.payload.resultReason).toBe('pending_limit');
  expect(events[0]!.payload.input).toEqual({ content });
  expect(Object.keys(state.pending ?? {})).toEqual(['large-1']);
  expect(new TextEncoder().encode(JSON.stringify(state.pending)).length).toBeLessThanOrEqual(MAX_VIEW_PENDING_BYTES);
});

test('budget yields reuse durable prepared bodies before committing one terminal window on both stores', async () => {
  await withViewStores(async (db, name) =>
    withViewWriterDriver(async () => {
      const now = Date.now(),
        blobs = memoryBlobStore();
      await captureViewSession(db);
      await createEmptyView(db, 'project', 'session', now);
      const source = Array.from({ length: 32 }, (_, i) =>
        item({
          type: 'function_call',
          call_id: 'spill-' + i,
          name: 'Read',
          arguments: JSON.stringify({ content: String(i) + ' ' + 'body '.repeat(4000) }),
        }),
      ).join('');
      const env = await captureViewTranscript(db, blobs, 'session', tx, source, now, 0, 'codex');
      const instance = await requestViewRebuild(db, 'project', 'session', now),
        target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
      let yielded = 0,
        complete = false;
      for (let pass = 0; pass < 30; pass++)
        try {
          const report = await parseViewOnce(env, target, now, {
            calls: 500,
            deadline: Date.now() + 10000,
            clock: Date.now,
            completeFile: true,
          });
          expect(report?.failure ?? null, name).toBeNull();
          if (report === null) {
            complete = true;
            break;
          }
        } catch (error) {
          if (!(error instanceof Error) || !/^content_(statement|blob|wall)_budget_exhausted$/.test(error.message))
            throw error;
          yielded++;
        }
      expect(complete, name).toBe(true);
      expect(yielded, name).toBeGreaterThan(0);
      expect(
        (
          await db
            .prepare(
              `SELECT COUNT(*) n FROM view_tool_calls WHERE project_id=? AND instance_id=? AND input_blob_key IS NOT NULL AND material_seq IS NULL`,
            )
            .bind('project', instance)
            .first<{ n: number }>()
        )?.n,
      ).toBe(32);
      expect(
        (
          await db
            .prepare(
              `SELECT COUNT(*) n FROM view_content_proofs WHERE project_id=? AND instance_id=? AND kind='tool-input'`,
            )
            .bind('project', instance)
            .first<{ n: number }>()
        )?.n,
      ).toBe(32);
    }),
  );
}, 120000);
test('full tool input survives checkpoint, pending flush, repeated keys and reported outcome on both stores', async () => {
  await withViewStores(async (db, name) =>
    withViewWriterDriver(async () => {
      const now = Date.now(),
        blobs = memoryBlobStore(),
        input = { content: 'complete input 😀 '.repeat(6000) };
      await captureViewSession(db);
      await createEmptyView(db, 'project', 'session', now);
      const calls =
        item({ type: 'function_call', call_id: 'large', name: 'Read', arguments: JSON.stringify(input) }) +
        item({ type: 'function_call', call_id: 'large', name: 'Read', arguments: '{"content":"replacement"}' }) +
        Array.from({ length: 32 }, (_, i) =>
          item({ type: 'function_call', call_id: 'other-' + i, name: 'Read', arguments: '{}' }),
        ).join('');
      const output = 'complete reported output 😀 '.repeat(1500);
      const text = calls + item({ type: 'function_call_output', call_id: 'large', output });
      const env = await captureViewTranscript(db, blobs, 'session', tx, text, now, 0, 'codex');
      const instance = await requestViewRebuild(db, 'project', 'session', now);
      const target = await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now);
      let passes = 0;
      while (passes++ < 8) {
        const report = await parseViewOnce(env, target!, now, {
          calls: 500,
          deadline: Date.now() + 10000,
          clock: Date.now,
          completeFile: true,
        });
        expect(report?.failure ?? null, name).toBeNull();
        if (report === null) break;
      }
      expect(passes).toBeLessThan(8);
      const rows = (
        await db
          .prepare(
            `SELECT * FROM view_tool_calls WHERE project_id='project' AND instance_id=? AND tool_name='Read' AND input_blob_key IS NOT NULL`,
          )
          .bind(instance)
          .all<{
            tool_call_id: string;
            input: string;
            output_preview: string;
            input_blob_key: string;
            output_blob_key: string;
            success: number;
            material_seq: number | null;
          }>()
      ).results;
      expect(rows, name).toHaveLength(1);
      const row = rows[0]!;
      expect(row.success).toBe(1);
      expect(row.material_seq).toBeNull();
      expect(new TextEncoder().encode(row.input).length).toBeLessThanOrEqual(16_384);
      expect(new TextEncoder().encode(row.output_preview).length).toBeLessThanOrEqual(16_384);
      expect(JSON.stringify(input).startsWith(row.input)).toBe(true);
      expect(output.startsWith(row.output_preview)).toBe(true);
      for (const [key, expected] of [
        [row.input_blob_key, JSON.stringify(input)],
        [row.output_blob_key, output],
      ]) {
        const registered = await db
          .prepare('SELECT generation FROM blobs WHERE project_id=? AND key=?')
          .bind('project', key)
          .first<{ generation: string }>();
        const held = await blobs.get(blobObjectKey('project', key!, registered!.generation));
        expect(await new Response(held!.body).text(), name).toBe(expected);
      }
      expect(
        (
          await db
            .prepare(
              `SELECT COUNT(*) n FROM view_findings WHERE project_id='project' AND instance_id=? AND kind='key_reuse'`,
            )
            .bind(instance)
            .first<{ n: number }>()
        )?.n,
      ).toBeGreaterThan(0);
      expect((await tryPublishView(db, target!, now, fixtureFlipEnvelope(name))).published).toBe(true);
      const unit = await exportMaterialVersions(db, 'project', 'session');
      expect(unit).not.toBeNull();
      await db.batch(restoreMaterialVersionStatements(db, 'project', 'session', unit));
      expect(await exportMaterialVersions(db, 'project', 'session')).toEqual(unit);
      expect(() => restoreMaterialVersionStatements(db, 'project', 'session', { ...unit!, nextSeq: 1 })).toThrow(
        'material_version_unit_invalid',
      );
      expect(restoreMaterialVersionStatements(db, 'project', 'session', null)).toEqual([]);
    }),
  );
}, 120000);

test('an unpaired surrogate refuses the view record before its row or frontier can commit', async () => {
  await withViewStores(async (db, name) =>
    withViewWriterDriver(async () => {
      const now = Date.now(),
        blobs = memoryBlobStore();
      await captureViewSession(db);
      await createEmptyView(db, 'project', 'session', now);
      const source = item({ type: 'function_call_output', call_id: 'invalid-unicode', output: 'unpaired \ud800' });
      const env = await captureViewTranscript(db, blobs, 'session', tx, source, now, 0, 'codex');
      const instance = await requestViewRebuild(db, 'project', 'session', now),
        target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
      expect(
        (
          await parseViewOnce(env, target, now, {
            calls: 500,
            deadline: Date.now() + 10000,
            clock: Date.now,
            completeFile: true,
          })
        )?.failure,
        name,
      ).toBe('event_refused');
      expect(
        await db
          .prepare(
            `SELECT parsed_offset,parse_error FROM view_checkpoints WHERE project_id=? AND instance_id=? AND transcript_id=?`,
          )
          .bind('project', instance, tx)
          .first<{ parsed_offset: number; parse_error: string }>(),
      ).toEqual({ parsed_offset: 0, parse_error: 'event_refused' });
      expect(
        (
          await db
            .prepare(`SELECT COUNT(*) n FROM view_tool_calls WHERE project_id=? AND instance_id=?`)
            .bind('project', instance)
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
      expect(
        (
          await db
            .prepare(`SELECT COUNT(*) n FROM learning_sessions WHERE project_id=? AND session_id=?`)
            .bind('project', 'session')
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
    }),
  );
}, 120000);

test('content preparation loses ownership with its instance stamp and leaves the committed checkpoint resumable', async () => {
  await withViewStores(async (db, name) =>
    withViewWriterDriver(async () => {
      const now = Date.now(),
        blobs = memoryBlobStore();
      await captureViewSession(db);
      await createEmptyView(db, 'project', 'session', now);
      const source = item({
        type: 'function_call',
        call_id: 'held',
        name: 'Read',
        arguments: JSON.stringify({ content: 'large '.repeat(6000) }),
      });
      const env = await captureViewTranscript(db, blobs, 'session', tx, source, now, 0, 'codex');
      const instance = await requestViewRebuild(db, 'project', 'session', now),
        target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
      const raced = {
        ...env,
        blobs: {
          ...blobs,
          put: async (...args: Parameters<typeof blobs.put>) => {
            const object = await blobs.put(...args);
            await setViewParserVersion(db, 'project', instance, PARSER_VERSION - 1);
            return object;
          },
        },
      };
      await expect(
        parseViewOnce(raced, target, now, {
          calls: 500,
          deadline: Date.now() + 10000,
          clock: Date.now,
          completeFile: true,
        }),
      ).rejects.toThrow();
      expect(
        (
          await db
            .prepare(
              `SELECT parsed_offset FROM view_checkpoints WHERE project_id=? AND instance_id=? AND transcript_id=?`,
            )
            .bind('project', instance, tx)
            .first<{ parsed_offset: number }>()
        )?.parsed_offset,
        name,
      ).toBe(0);
      expect(
        (
          await db
            .prepare(`SELECT COUNT(*) n FROM view_tool_calls WHERE project_id=? AND instance_id=?`)
            .bind('project', instance)
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
      expect(
        (
          await db
            .prepare(
              `SELECT COUNT(*) n FROM registered_content_proofs WHERE project_id=? AND source_kind='view' AND source_id=?`,
            )
            .bind('project', instance)
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
      expect(
        (
          await db
            .prepare(
              `SELECT COUNT(*) n FROM blob_reservations WHERE project_id=? AND source_kind='view' AND source_id=?`,
            )
            .bind('project', instance)
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
      await setViewParserVersion(db, 'project', instance, PARSER_VERSION);
      expect(
        (
          await parseViewOnce(env, target, now, {
            calls: 500,
            deadline: Date.now() + 10000,
            clock: Date.now,
            completeFile: true,
          })
        )?.failure ?? null,
      ).toBeNull();
      expect((await tryPublishView(db, target, now, fixtureFlipEnvelope(name))).published).toBe(true);
    }),
  );
}, 120000);

test('content wall deadlines remain advisory unless the scope explicitly enforces them', async () => {
  await withViewStores(async (db, store) => {
    const { measuredContentEnv } = await import('@myco-server-worker/core/content-budget.js');
    const advisory = measuredContentEnv({ db }, { statements: 1, blobCalls: 0, wallMs: 0 });
    expect(await advisory.env.db.prepare('SELECT 1 value').first(), store).toEqual({ value: 1 });
    const enforced = measuredContentEnv({ db }, { statements: 1, blobCalls: 0, wallMs: 0, enforceWall: true });
    await expect(enforced.env.db.prepare('SELECT 1 value').first()).rejects.toThrow('content_wall_budget_exhausted');
  });
}, 120000);
