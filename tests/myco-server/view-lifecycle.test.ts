import { fixtureFlipEnvelope } from '../helpers/view-flip-envelope.js';
import { expect, test } from 'bun:test';
import { withViewStores, withViewStorePair, captureViewSession, captureViewTranscript } from './helpers/view-stores.js';
import type { ViewWriteTarget } from '@myco-server-worker/ingest/view-guard.js';
import { memoryBlobStore, uuid } from './helpers/fixtures.js';
import { withViewWriterDriver, statementRecorder } from '../helpers/statement-recorder.js';
import {
  createEmptyView,
  requestViewRebuild,
  tryPublishView,
  viewReady,
  legacyAckFeedStatement,
  convertLegacyCoveragePage,
  prepareLegacyCoverageTail,
} from '@myco-server-worker/ingest/view-lifecycle.js';
import {
  claimViewBuild,
  SERIAL_VIEW_BUDGET,
  PARALLEL_VIEW_BUDGET,
  selectViewBuild,
  yieldViewBuild,
  releaseViewBuild,
  failViewBuild,
  noteViewCaptureStatements,
  BUILD_SLOT_MS,
  VIEW_FAILURE_BACKOFF,
} from '@myco-server-worker/ingest/view-build-queue.js';
import { parseViewOnce } from '@myco-server-worker/ingest/view-parse.js';
import { PARSER_VERSION } from '@myco-server-worker/ingest/parse.js';
import { EXCLUDED_TABLES, BACKUP_TABLES } from '@myco-server-worker/core/backup.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import {
  beforeViewFlip,
  setViewParserVersion,
  completeViewConversion,
  seedTailFrontier,
} from './helpers/view-instances.js';
import { viewCheckpointStatements, liveFrontierMirrorStatements } from '@myco-server-worker/ingest/view-checkpoint.js';
import { viewWriteGuard } from '@myco-server-worker/ingest/view-guard.js';
import { readParserCheckpoint } from '@myco-server-worker/ingest/parser-checkpoint.js';
import { MAX_PAYLOAD_BYTES } from '@myco-server-worker/ingest/envelope.js';
import type { ParserState } from '@myco-server-worker/ingest/parsers/index.js';
import { restoreExtractionAckStatement } from '@myco-server-worker/core/extraction-acks.js';
import { lateLegacyCoverageStatement } from '@myco-server-worker/ingest/view-acknowledgements.js';
import { runViewParseJob } from '@myco-server-worker/ingest/view-run.js';
import { readViewStatus } from '@myco-server-worker/read/view-status.js';
import { publicationVersionStatements, finishVersionStatements } from '@myco-server-worker/core/material-versions.js';

test('real shared parse, rebuild and atomic flip preserve sequence and continuation ownership on native and D1', async () => {
  await withViewStores(async (db, name) =>
    withViewWriterDriver(async () => {
      const envelope = fixtureFlipEnvelope(name);
      const now = Date.now(),
        blobs = memoryBlobStore();
      await captureViewSession(db);
      const original = await createEmptyView(db, 'project', 'session', now);
      const text = [
        { role: 'user', message: { content: 'view prompt' } },
        { role: 'assistant', message: { content: 'view answer' } },
      ]
        .map((row) => JSON.stringify(row) + '\n')
        .join('');
      const env = await captureViewTranscript(db, blobs, 'session', 'tx_0123456789abcdef0123456789abcdef', text, now);
      const instance = await requestViewRebuild(db, 'project', 'session', now);
      expect(await requestViewRebuild(db, 'project', 'session', now)).toBe(instance);
      const target = await claimViewBuild(
        db,
        'project',
        'session',
        name === 'D1' ? SERIAL_VIEW_BUDGET : PARALLEL_VIEW_BUDGET,
        now,
      );
      expect(target).not.toBeNull();
      expect(
        await parseViewOnce(env, target!, now, {
          calls: 500,
          deadline: Date.now() + 10000,
          clock: Date.now,
          completeFile: true,
        }),
      ).not.toBeNull();
      expect((await db.prepare(`SELECT COUNT(*) n FROM learning_sessions`).first<{ n: number }>())?.n).toBe(0);
      expect(
        (
          await db
            .prepare(`SELECT parsed_offset FROM transcripts WHERE transcript_id='tx_0123456789abcdef0123456789abcdef'`)
            .first<{ parsed_offset: number }>()
        )?.parsed_offset,
      ).toBe(0);
      expect(await viewReady(db, target!, now)).toBe(true);
      const result = await tryPublishView(db, target!, now, envelope);
      expect(result.published, name).toBe(true);
      const prompts = (
        await db
          .prepare(`SELECT material_seq,text FROM view_prompts WHERE project_id='project' AND instance_id=?`)
          .bind(instance)
          .all<{ material_seq: number; text: string }>()
      ).results;
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.text).toBe('view prompt');
      expect(prompts[0]!.material_seq).toBeGreaterThan(0);
      expect(
        (
          await db
            .prepare(`SELECT state FROM view_instances WHERE project_id='project' AND instance_id=?`)
            .bind(original)
            .first<{ state: string }>()
        )?.state,
      ).toBe('retired');
      const frontier = await db
        .prepare(
          `SELECT parsed_offset,parser_version,parser_context FROM transcripts WHERE transcript_id='tx_0123456789abcdef0123456789abcdef'`,
        )
        .first<{ parsed_offset: number; parser_version: number; parser_context: string }>();
      expect(frontier?.parsed_offset).toBe(new TextEncoder().encode(text).length);
      expect(frontier?.parser_version).toBe(PARSER_VERSION);
      expect(JSON.parse(frontier!.parser_context).mycoParserUnfinished).toBe(0);
      const second = await requestViewRebuild(db, 'project', 'session', now + 1);
      expect(second).not.toBe(instance);
      const next = await claimViewBuild(
        db,
        'project',
        'session',
        name === 'D1' ? SERIAL_VIEW_BUDGET : PARALLEL_VIEW_BUDGET,
        now + 1,
      );
      await parseViewOnce(env, next!, now + 1, {
        calls: 500,
        deadline: Date.now() + 10000,
        clock: Date.now,
        completeFile: true,
      });
      expect((await tryPublishView(db, next!, now + 1, envelope)).published).toBe(true);
      expect(
        (
          await db
            .prepare(`SELECT material_seq FROM view_prompts WHERE instance_id=?`)
            .bind(second)
            .first<{ material_seq: number }>()
        )?.material_seq,
      ).toBe(prompts[0]!.material_seq);
      for (const table of ['learning_sessions', 'material_versions']) {
        expect(EXCLUDED_TABLES.has(table)).toBe(true);
        expect(BACKUP_TABLES.includes(table)).toBe(false);
      }
      await tombstoneSession({ db }, { projectId: 'project' }, 'session', 'member', now + 2);
      expect(
        await db
          .prepare('PRAGMA foreign_key_check')
          .all()
          .then((r) => r.results),
      ).toEqual([]);
      expect((await db.prepare(`SELECT COUNT(*) n FROM learning_sessions`).first<{ n: number }>())?.n).toBe(0);
    }),
  );
}, 120000);

test('a parser bump replaces an older building generation and a newer live generation remains incompatible', async () => {
  await withViewStores(async (db, name) =>
    withViewWriterDriver(async () => {
      const envelope = fixtureFlipEnvelope(name);
      const now = Date.now(),
        blobs = memoryBlobStore(),
        tx = 'tx_0123456789abcdef0123456789abcdef';
      await captureViewSession(db);
      await createEmptyView(db, 'project', 'session', now);
      const line = JSON.stringify({ role: 'user', message: { content: 'generation owned prompt' } }) + '\n';
      const env = await captureViewTranscript(db, blobs, 'session', tx, line, now);
      const previous = await requestViewRebuild(db, 'project', 'session', now);
      await setViewParserVersion(db, 'project', previous, PARSER_VERSION - 1);
      const result = await runViewParseJob(env, now, { profile: SERIAL_VIEW_BUDGET, envelope });
      expect(result.published, name).toBe(1);
      const live = (await db
        .prepare(`SELECT live_instance,building_instance FROM session_views WHERE project_id=? AND session_id=?`)
        .bind('project', 'session')
        .first<{ live_instance: string; building_instance: string | null }>())!;
      expect(live.live_instance).not.toBe(previous);
      expect(live.building_instance).toBeNull();
      expect(
        (
          await db
            .prepare(`SELECT state FROM view_instances WHERE project_id=? AND instance_id=?`)
            .bind('project', previous)
            .first<{ state: string }>()
        )?.state,
      ).toBe('abandoned');
      await setViewParserVersion(db, 'project', live.live_instance, PARSER_VERSION + 1);
      await captureViewTranscript(db, blobs, 'session', tx, line, now + 1, new TextEncoder().encode(line).length);
      const before = await db
        .prepare(`SELECT * FROM learning_sessions WHERE project_id=? AND session_id=?`)
        .bind('project', 'session')
        .first();
      expect((await runViewParseJob(env, now + 1, { profile: SERIAL_VIEW_BUDGET, envelope })).published).toBe(0);
      expect(
        await db
          .prepare(`SELECT * FROM learning_sessions WHERE project_id=? AND session_id=?`)
          .bind('project', 'session')
          .first(),
      ).toEqual(before);
      const status = await readViewStatus(db, ['project'], now + 1);
      expect(status.states[0]?.state).toBe('incompatible');
      expect(status.states[0]?.bytes_behind).toBe(new TextEncoder().encode(line).length);
    }),
  );
}, 120000);

for (const profile of [SERIAL_VIEW_BUDGET, PARALLEL_VIEW_BUDGET])
  test(`build service yields across priority tiers and restores admitted capture with ${profile.slots} slots`, async () => {
    await withViewStores(async (db, name) =>
      withViewWriterDriver(async () => {
        const envelope = fixtureFlipEnvelope(name);
        const now = Date.now(),
          blobs = memoryBlobStore();
        await captureViewSession(db);
        await captureViewSession(db, 'other', 'peer');
        await createEmptyView(db, 'project', 'session', now);
        await createEmptyView(db, 'other', 'peer', now);
        const tx = 'tx_0123456789abcdef0123456789abcdef';
        await captureViewTranscript(
          db,
          blobs,
          'session',
          tx,
          JSON.stringify({ role: 'user', message: { content: 'queued capture' } }) + '\n',
          now,
        );
        const first = await requestViewRebuild(db, 'project', 'session', now);
        await requestViewRebuild(db, 'other', 'peer', now);
        const selected = await selectViewBuild(db, now);
        expect(selected?.project_id, name).toBe('project');
        const target = (await claimViewBuild(db, 'project', 'session', profile, now))!;
        const peer = await claimViewBuild(db, 'other', 'peer', profile, now);
        if (profile.slots === 1) expect(peer).toBeNull();
        else {
          expect(peer).not.toBeNull();
          expect(await releaseViewBuild(db, peer!, now + 1)).toBe(true);
        }
        expect(await yieldViewBuild(db, target, BUILD_SLOT_MS, now + 2)).toBe(true);
        expect((await selectViewBuild(db, now + 2))?.project_id).toBe('other');
        const nextPeer = (await claimViewBuild(db, 'other', 'peer', profile, now + 2))!;
        expect(await yieldViewBuild(db, nextPeer, BUILD_SLOT_MS, now + 3)).toBe(true);
        expect((await selectViewBuild(db, now + 3))?.project_id).toBe('project');
        const resumed = (await claimViewBuild(db, 'project', 'session', profile, now + 3))!;
        await expect(yieldViewBuild(db, target, 1, now + 3)).rejects.toThrow();
        const checkpoint = () =>
          db
            .prepare(
              `SELECT parsed_offset FROM view_checkpoints WHERE project_id=? AND instance_id=? AND transcript_id=?`,
            )
            .bind('project', first, tx)
            .first<{ parsed_offset: number }>();
        expect((await checkpoint())?.parsed_offset).toBe(0);
        await failViewBuild(db, resumed, 'blob_absent', now + 4);
        const status = () =>
          db
            .prepare(
              `SELECT next_attempt_at,unrebuildable_reason FROM session_views WHERE project_id=? AND session_id=?`,
            )
            .bind('project', 'session')
            .first<{ next_attempt_at: number; unrebuildable_reason: string | null }>();
        expect((await status())?.next_attempt_at).toBe(now + 4 + VIEW_FAILURE_BACKOFF[0]);
        await db.batch(noteViewCaptureStatements(db, 'project', 'session', now + 5, { sql: '0', params: [] }));
        expect((await status())?.unrebuildable_reason).toBe('blob_absent');
        await db.batch(noteViewCaptureStatements(db, 'project', 'session', now + 5, { sql: '1', params: [] }));
        expect((await status())?.unrebuildable_reason).toBeNull();
        expect((await checkpoint())?.parsed_offset).toBe(0);
        const recovered = (await claimViewBuild(db, 'project', 'session', profile, now + 6))!;
        await failViewBuild(db, recovered, 'malformed', now + 6);
        const due = now + 6 + VIEW_FAILURE_BACKOFF[1];
        expect((await status())?.next_attempt_at).toBe(due);
        await selectViewBuild(db, due - 1);
        expect(
          (
            await db
              .prepare(`SELECT state FROM view_build_work WHERE project_id=? AND session_id=?`)
              .bind('project', 'session')
              .first<{ state: string }>()
          )?.state,
        ).toBe('waiting');
        expect((await selectViewBuild(db, due))?.project_id).toBe('project');
        const retry = (await claimViewBuild(db, 'project', 'session', profile, due))!;
        await failViewBuild(db, retry, 'malformed', due);
        expect((await status())?.next_attempt_at).toBe(due + VIEW_FAILURE_BACKOFF[2]);
      }),
    );
  }, 120000);

test('a tail rebuild preserves its frozen parent and start offset with empty continuation across parser generations', async () => {
  await withViewStores(async (db, name) =>
    withViewWriterDriver(async () => {
      const envelope = fixtureFlipEnvelope(name);
      const now = Date.now(),
        blobs = memoryBlobStore(),
        tx = 'tx_0123456789abcdef0123456789abcdef',
        start = 100;
      await captureViewSession(db);
      const parent = await createEmptyView(db, 'project', 'session', now),
        oldTail = crypto.randomUUID();
      const item = (payload: Record<string, unknown>) => ({ type: 'response_item', payload });
      const text = [
        item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'unattributed steering' }] }),
        item({ type: 'function_call_output', call_id: 'old-call', output: 'reported after pruned call' }),
        { type: 'turn_context', payload: { turn_id: uuid(90) } },
        item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new turn' }] }),
      ]
        .map((row) => JSON.stringify(row) + '\n')
        .join('');
      const prefix = JSON.stringify({ type: 'session_meta', payload: {} }).padEnd(start - 1, ' ') + '\n';
      await captureViewTranscript(db, blobs, 'session', tx, prefix, now, 0, 'codex');
      const env = await captureViewTranscript(db, blobs, 'session', tx, text, now, start, 'codex');
      const frozenIdentity = JSON.stringify(['prompt', 'frozen-prompt', 'stamp']),
        attempt = crypto.randomUUID();
      await db.batch([
        ...publicationVersionStatements(
          db,
          'project',
          'session',
          attempt,
          [{ kind: 'prompt', identity: frozenIdentity, recordId: 'frozen-prompt', hash: 'frozen-hash' }],
          false,
        ),
        db
          .prepare(
            `INSERT INTO view_prompts(project_id,instance_id,session_id,prompt_id,origin,text,content_hash,created_at,updated_at,received_at,source_transcript_id,source_offset,source_end,
    canonical_identity,view_content_hash,hash_scheme,material_seq) SELECT ?,?,?,'frozen-prompt','user','frozen body','body-hash',1,1,1,?,0,?,?,?, ?,NULL
    FROM view_publication_material WHERE project_id=? AND session_id=? AND attempt_id=?`,
          )
          .bind(
            'project',
            parent,
            'session',
            tx,
            start,
            frozenIdentity,
            'frozen-hash',
            'view-content-v1',
            'project',
            'session',
            attempt,
          ),
        ...finishVersionStatements(db, 'project', 'session', attempt),
      ]);
      const frozenBinding = await db
        .prepare(`SELECT * FROM material_versions WHERE project_id=? AND session_id=? AND identity=?`)
        .bind('project', 'session', frozenIdentity)
        .first();
      await seedTailFrontier(db, 'project', 'session', parent, oldTail, tx, start, PARSER_VERSION - 1);
      const [build, duplicate] = await Promise.all([
        requestViewRebuild(db, 'project', 'session', now),
        requestViewRebuild(db, 'project', 'session', now),
      ]);
      expect(build, name).toBe(duplicate);
      const checkpoint = await db
        .prepare(`SELECT * FROM view_checkpoints WHERE project_id=? AND instance_id=? AND transcript_id=?`)
        .bind('project', build, tx)
        .first<{
          parser_version: number;
          start_offset: number;
          parsed_offset: number;
          parser_context: string;
          open_prompt_id: string | null;
          lost_context: number;
        }>();
      expect(checkpoint?.parser_version, name).toBe(PARSER_VERSION);
      expect(checkpoint?.start_offset).toBe(start);
      expect(checkpoint?.parsed_offset).toBe(start);
      expect(checkpoint?.open_prompt_id).toBeNull();
      expect(JSON.parse(checkpoint!.parser_context).mycoParserState).toEqual({});
      expect(checkpoint?.lost_context).toBe(1);
      const frozen = await db
        .prepare(`SELECT * FROM view_instances WHERE project_id=? AND instance_id=?`)
        .bind('project', parent)
        .first();
      const target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
      await parseViewOnce(env, target, now, { calls: 500, deadline: Date.now() + 10000, clock: Date.now });
      expect((await tryPublishView(db, target, now, envelope)).published, name).toBe(true);
      expect(
        await db
          .prepare(`SELECT * FROM view_instances WHERE project_id=? AND instance_id=?`)
          .bind('project', parent)
          .first(),
      ).toEqual(frozen);
      expect(
        await db
          .prepare(`SELECT * FROM material_versions WHERE project_id=? AND session_id=? AND identity=?`)
          .bind('project', 'session', frozenIdentity)
          .first(),
        name,
      ).toEqual(frozenBinding);
      expect(
        (
          await db
            .prepare(`SELECT parent_instance FROM view_instances WHERE project_id=? AND instance_id=?`)
            .bind('project', build)
            .first<{ parent_instance: string }>()
        )?.parent_instance,
      ).toBe(parent);
      const unknown = await db
        .prepare(`SELECT tool_name,input,prompt_id FROM view_tool_calls WHERE project_id=? AND instance_id=?`)
        .bind('project', build)
        .first<{ tool_name: string; input: string; prompt_id: string | null }>();
      expect(unknown).toEqual({ tool_name: 'unknown', input: '{}', prompt_id: null });
      expect(
        (
          await db
            .prepare(
              `SELECT SUM(count) n FROM view_findings WHERE project_id=? AND instance_id=? AND kind='unattributed'`,
            )
            .bind('project', build)
            .first<{ n: number }>()
        )?.n,
      ).toBe(2);
      expect(
        (
          await db
            .prepare(`SELECT COUNT(*) n FROM view_prompts WHERE project_id=? AND instance_id=?`)
            .bind('project', build)
            .first<{ n: number }>()
        )?.n,
      ).toBe(1);
    }),
  );
}, 120000);

test('acknowledgement feed cursors survive deletion, canonical restore and native vacuum', async () => {
  await withViewStores(async (db, name) =>
    withViewWriterDriver(async () => {
      const now = Date.now();
      await captureViewSession(db);
      await createEmptyView(db, 'project', 'session', now);
      await requestViewRebuild(db, 'project', 'session', now);
      await completeViewConversion(db, 'project', 'session', uuid(20));
      const restore = (id: string) =>
        restoreExtractionAckStatement(db, {
          project_id: 'project',
          session_id: 'session',
          ack_id: id,
          kind: 'record',
          record_id: uuid(20),
          run_id: 'fixture-run',
          acknowledged_at: now,
        });
      const record = (id: string) => [restore(id), legacyAckFeedStatement(db, 'project', 'session', id)];
      await db.batch(record('retained-ack'));
      const before = (await db.prepare(`SELECT MAX(ack_seq) n FROM view_legacy_ack_feed`).first<{ n: number }>())!.n;
      await db
        .prepare(`DELETE FROM view_legacy_ack_feed WHERE project_id=? AND session_id=?`)
        .bind('project', 'session')
        .run();
      if (name === 'native') await db.prepare('VACUUM').run();
      await db.batch([...record('retained-ack'), ...record('new-ack'), ...record('retained-ack')]);
      const after = (
        await db
          .prepare(
            `SELECT ack_seq,ack_id FROM view_legacy_ack_feed WHERE project_id=? AND session_id=? ORDER BY ack_seq`,
          )
          .bind('project', 'session')
          .all<{ ack_seq: number; ack_id: string }>()
      ).results;
      expect(
        after.map((row) => row.ack_id),
        name,
      ).toEqual(['retained-ack', 'new-ack']);
      expect(
        after.every((row) => row.ack_seq > before),
        name,
      ).toBe(true);
      expect(
        (await db
          .prepare(`SELECT COUNT(*) n FROM extraction_acks WHERE project_id=? AND ack_id=?`)
          .bind('project', 'retained-ack')
          .first<{ n: number }>())!.n,
      ).toBe(1);
    }),
  );
}, 120000);

test('physical recovery preserves feed coordinates across canonical acknowledgement rowid changes', async () => {
  for (const store of ['native', 'D1'] as const) {
    if (process.env.MYCO_VIEW_TEST_STORE && process.env.MYCO_VIEW_TEST_STORE !== store) continue;
    await withViewWriterDriver(async () => {
      const now = Date.now();
      let target: ViewWriteTarget | undefined;
      const ack = (id: string) => ({
        project_id: 'project',
        session_id: 'session',
        ack_id: id,
        kind: 'record',
        record_id: uuid(20),
        run_id: 'fixture-run',
        acknowledged_at: now,
      });
      await withViewStorePair(
        store,
        async (db) => {
          await captureViewSession(db);
          await createEmptyView(db, 'project', 'session', now);
          await requestViewRebuild(db, 'project', 'session', now);
          await completeViewConversion(db, 'project', 'session', uuid(20));
          target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
          await db.batch(
            ['first', 'second', 'third'].flatMap((id) => [
              restoreExtractionAckStatement(db, ack(id)),
              legacyAckFeedStatement(db, 'project', 'session', id),
            ]),
          );
          await db
            .prepare(
              `UPDATE view_build_work SET legacy_ack_watermark=(SELECT MIN(ack_seq) FROM view_legacy_ack_feed) WHERE project_id=? AND session_id=?`,
            )
            .bind('project', 'session')
            .run();
        },
        async (baseline, candidate) => {
          const before = (
            await baseline
              .prepare(`SELECT ack_seq,ack_id FROM view_legacy_ack_feed ORDER BY ack_seq`)
              .all<{ ack_seq: number; ack_id: string }>()
          ).results;
          expect(
            (await candidate.prepare(`SELECT ack_seq,ack_id FROM view_legacy_ack_feed ORDER BY ack_seq`).all()).results,
            store,
          ).toEqual(before);
          const oldRows = (
            await candidate
              .prepare(`SELECT rowid physical,ack_id FROM extraction_acks WHERE project_id=? ORDER BY ack_id`)
              .bind('project')
              .all<{ physical: number; ack_id: string }>()
          ).results;
          await candidate.prepare(`DELETE FROM extraction_acks WHERE project_id=?`).bind('project').run();
          await candidate.batch(
            ['filler-a', 'filler-b', 'filler-c', ...before.map((row) => row.ack_id).reverse()].map((id) =>
              restoreExtractionAckStatement(candidate, ack(id)),
            ),
          );
          const changed = (
            await candidate
              .prepare(
                `SELECT rowid physical,ack_id FROM extraction_acks WHERE project_id=? AND ack_id IN(SELECT value FROM json_each(?)) ORDER BY ack_id`,
              )
              .bind('project', JSON.stringify(before.map((row) => row.ack_id)))
              .all<{ physical: number; ack_id: string }>()
          ).results;
          expect(
            changed.every((row) => row.physical !== oldRows.find((old) => old.ack_id === row.ack_id)!.physical),
            store,
          ).toBe(true);
          const tail = await prepareLegacyCoverageTail(candidate, target!, now);
          expect(tail?.count).toBe(2);
          expect(tail?.watermark).toBe(before.at(-1)!.ack_seq);
          await candidate.batch([
            restoreExtractionAckStatement(candidate, ack('next')),
            legacyAckFeedStatement(candidate, 'project', 'session', 'next'),
          ]);
          expect(
            (await candidate
              .prepare(`SELECT ack_seq FROM view_legacy_ack_feed WHERE ack_id=?`)
              .bind('next')
              .first<{ ack_seq: number }>())!.ack_seq,
          ).toBeGreaterThan(before.at(-1)!.ack_seq);
        },
      );
    });
  }
}, 120000);

test('conversion pages bound the final flip to 64 acks and late coverage resolves the published stamp in its transaction', async () => {
  await withViewStores(async (db, name) =>
    withViewWriterDriver(async () => {
      const envelope = fixtureFlipEnvelope(name);
      const now = Date.now(),
        blobs = memoryBlobStore(),
        tx = 'tx_0123456789abcdef0123456789abcdef';
      await captureViewSession(db);
      await createEmptyView(db, 'project', 'session', now);
      const text = JSON.stringify({ v: 1, type: 'prompt', promptId: uuid(20), text: 'factcanary', at: now }) + '\n';
      const env = await captureViewTranscript(db, blobs, 'session', tx, text, now, 0, 'opencode');
      const instance = await requestViewRebuild(db, 'project', 'session', now);
      const target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
      await parseViewOnce(env, target, now, { calls: 500, deadline: Date.now() + 10000, clock: Date.now });
      await completeViewConversion(db, 'project', 'session', uuid(20));
      const acknowledge = (id: string) =>
        restoreExtractionAckStatement(db, {
          project_id: 'project',
          session_id: 'session',
          ack_id: id,
          kind: 'record',
          record_id: uuid(20),
          run_id: 'fixture-run',
          acknowledged_at: now,
        });
      const ids = Array.from({ length: 65 }, (_, index) => 'legacy-' + index);
      await db.batch(ids.flatMap((id) => [acknowledge(id), legacyAckFeedStatement(db, 'project', 'session', id)]));
      expect(await viewReady(db, target, now), name).toBe(false);
      expect(await tryPublishView(db, target, now, envelope)).toEqual({ published: false, reason: 'view_not_ready' });
      expect(await convertLegacyCoveragePage(db, target, now)).toBe(64);
      expect(await viewReady(db, target, now)).toBe(true);
      const observed = statementRecorder(db, { accounting: name === 'D1' ? 'd1' : 'native' });
      await prepareLegacyCoverageTail(observed.db, target, now);
      const tailRead = observed.statements.find((row) => row.sql.includes('SELECT a.ack_id'))!;
      const raced = beforeViewFlip(db, async () => {
        await db.batch([acknowledge('racing'), legacyAckFeedStatement(db, 'project', 'session', 'racing')]);
      });
      expect(await tryPublishView(raced, target, now, envelope)).toEqual({
        published: false,
        reason: 'view_not_ready',
      });
      expect((await tryPublishView(db, target, now, envelope)).published).toBe(true);
      const sourceCount = () =>
        db
          .prepare(`SELECT COUNT(*) n FROM extraction_acks WHERE project_id=? AND session_id=? AND kind='source'`)
          .bind('project', 'session')
          .first<{ n: number }>();
      expect((await sourceCount())!.n).toBe(66);
      expect(
        (await db
          .prepare(`SELECT COUNT(*) n FROM view_legacy_ack_feed WHERE project_id=? AND session_id=?`)
          .bind('project', 'session')
          .first<{ n: number }>())!.n,
      ).toBe(0);
      await db.batch([
        acknowledge('late'),
        legacyAckFeedStatement(db, 'project', 'session', 'late'),
        lateLegacyCoverageStatement(db, 'project', 'session', 'late', now + 1),
      ]);
      expect((await sourceCount())!.n).toBe(67);
      await lateLegacyCoverageStatement(observed.db, 'project', 'session', 'late', now + 2).run();
      expect((await sourceCount())!.n).toBe(67);
      expect(
        (await db
          .prepare(`SELECT COUNT(*) n FROM view_legacy_ack_feed WHERE project_id=? AND session_id=?`)
          .bind('project', 'session')
          .first<{ n: number }>())!.n,
      ).toBe(0);
      const current = await db
        .prepare(`SELECT canonical_identity FROM view_prompts WHERE project_id=? AND instance_id=? AND prompt_id=?`)
        .bind('project', instance, uuid(20))
        .first<{ canonical_identity: string }>();
      expect(JSON.parse(current!.canonical_identity)[2]).toBe('stamp');
      const lateWrite = observed.statements.at(-1)!;
      await requestViewRebuild(db, 'project', 'session', now + 3);
      const next = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now + 3))!;
      await parseViewOnce(env, next, now + 3, { calls: 500, deadline: Date.now() + 10000, clock: Date.now });
      await completeViewConversion(db, 'project', 'session', uuid(20));
      await db.batch(
        Array.from({ length: 64 }, (_, index) => 'exact64-' + index).flatMap((id) => [
          acknowledge(id),
          legacyAckFeedStatement(db, 'project', 'session', id),
        ]),
      );
      expect(await viewReady(db, next, now + 3)).toBe(true);
      expect((await tryPublishView(db, next, now + 3, envelope)).published).toBe(true);
      expect((await sourceCount())!.n).toBe(131);
      for (const statement of [tailRead, lateWrite]) {
        const details = (
          await db
            .prepare('EXPLAIN QUERY PLAN ' + statement.sql)
            .bind(...statement.binds)
            .all<{ detail: string }>()
        ).results.map((row) => row.detail);
        console.log(JSON.stringify({ measurement: 'view-coverage-explain', store: name, details }));
        expect(
          details.some((detail) =>
            /SEARCH view_prompts USING (?:COVERING )?INDEX idx_view_prompt_source \(project_id=\? AND instance_id=\? AND claim=\? AND source_key=\? AND source_thread=\? AND source_record=\?\)/.test(
              detail,
            ),
          ),
          name,
        ).toBe(true);
        expect(
          details.some((detail) =>
            /SEARCH p USING INDEX (?:sqlite_autoindex_view_prompts_1|idx_view_prompts_prompt) \(project_id=\? AND instance_id=\? AND prompt_id=\?\)/.test(
              detail,
            ),
          ),
          name,
        ).toBe(true);
        expect(
          details.some((detail) =>
            /SEARCH a USING INDEX sqlite_autoindex_extraction_acks_1 \(project_id=\? AND ack_id=\?\)/.test(detail),
          ),
          name,
        ).toBe(true);
        expect(
          details.filter((detail) => /^SCAN (?:p|view_prompts)(?: |$)/.test(detail)),
          name,
        ).toEqual([]);
      }
      console.log(
        JSON.stringify({
          measurement: 'view-coverage-equality',
          store: name,
          tailRowsRead: tailRead.rowsRead ?? null,
          tailRows: tailRead.rowCount,
          lateRowsRead: lateWrite.rowsRead ?? null,
          lateRowsWritten: lateWrite.rowsWritten ?? null,
        }),
      );
      if (name === 'D1') {
        expect(tailRead.rowsRead).toBeLessThanOrEqual(16);
        expect(lateWrite.rowsRead).toBeLessThanOrEqual(16);
      }
    }),
  );
}, 120000);

test('live frontier mirrors carry complete chunked continuations and remove superseded chunks on native and D1', async () => {
  await withViewStores(async (db, name) =>
    withViewWriterDriver(async () => {
      const envelope = fixtureFlipEnvelope(name);
      const now = Date.now(),
        blobs = memoryBlobStore(),
        tx = 'tx_0123456789abcdef0123456789abcdef';
      await captureViewSession(db);
      await createEmptyView(db, 'project', 'session', now);
      const text = JSON.stringify({ role: 'user', message: { content: 'checkpoint owner' } }) + '\n';
      const env = await captureViewTranscript(db, blobs, 'session', tx, text, now);
      const instance = await requestViewRebuild(db, 'project', 'session', now);
      const target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
      await parseViewOnce(env, target, now, { calls: 500, deadline: Date.now() + 10000, clock: Date.now });
      const offset = new TextEncoder().encode(text).length;
      const state: ParserState = {
        pending: {
          held: {
            toolCallId: 'held',
            toolName: 'Read',
            input: { text: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) },
            createdAt: now,
            offset: 0,
          },
        },
      };
      await db.batch([
        ...viewWriteGuard(db, target, now),
        ...(await viewCheckpointStatements(
          db,
          target,
          { transcriptId: tx, offset, context: null, openPromptId: null },
          offset,
          state,
          undefined,
          now,
          now,
          'complete',
        )),
        ...liveFrontierMirrorStatements(db, target, tx),
      ]);
      expect(
        (await db
          .prepare(`SELECT COUNT(*) n FROM transcript_parser_state_chunks WHERE project_id=? AND transcript_id=?`)
          .bind('project', tx)
          .first<{ n: number }>())!.n,
        name,
      ).toBe(0);
      expect((await tryPublishView(db, target, now, envelope)).published, name).toBe(true);
      const mirrored = await db
        .prepare(`SELECT parser_context FROM transcripts WHERE project_id=? AND transcript_id=?`)
        .bind('project', tx)
        .first<{ parser_context: string }>();
      const context = JSON.parse(mirrored!.parser_context);
      expect(context.mycoParserUnfinished).toBe(1);
      expect(context.mycoParserState.chunked).toBe(true);
      expect(
        await readParserCheckpoint(
          db,
          { projectId: 'project', transcriptId: tx, parsedOffset: offset },
          context.mycoParserState.digest,
        ),
      ).toEqual(state);
      const live = {
        ...target,
        instanceId: instance,
        liveInstance: instance,
        fence: target.fence + 1,
        leaseToken: null,
      };
      await db.batch([
        ...viewWriteGuard(db, live, now + 1),
        ...(await viewCheckpointStatements(
          db,
          live,
          { transcriptId: tx, offset, context: mirrored!.parser_context, openPromptId: null },
          offset,
          {},
          undefined,
          now + 1,
          now,
          'complete',
        )),
        ...liveFrontierMirrorStatements(db, live, tx),
      ]);
      expect(
        (await db
          .prepare(`SELECT COUNT(*) n FROM transcript_parser_state_chunks WHERE project_id=? AND transcript_id=?`)
          .bind('project', tx)
          .first<{ n: number }>())!.n,
      ).toBe(0);
    }),
  );
}, 120000);

test('version, capture and manifest races preserve the live closure and resume catch-up', async () => {
  await withViewStores(async (db, name) =>
    withViewWriterDriver(async () => {
      const envelope = fixtureFlipEnvelope(name);
      const now = Date.now(),
        blobs = memoryBlobStore();
      await captureViewSession(db);
      const live = await createEmptyView(db, 'project', 'session', now);
      const tx = 'tx_0123456789abcdef0123456789abcdef';
      const line = (text: string) => JSON.stringify({ role: 'user', message: { content: text } }) + '\n';
      const source = line('first'),
        env = await captureViewTranscript(db, blobs, 'session', tx, source, now);
      const build = await requestViewRebuild(db, 'project', 'session', now),
        target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
      await setViewParserVersion(db, 'project', build, PARSER_VERSION - 1);
      await expect(
        parseViewOnce(env, target, now, { calls: 500, deadline: Date.now() + 10000, clock: Date.now }),
      ).rejects.toThrow();
      expect(
        (await db.prepare('SELECT COUNT(*) n FROM view_prompts WHERE instance_id=?').bind(build).first<{ n: number }>())
          ?.n,
      ).toBe(0);
      await setViewParserVersion(db, 'project', build, PARSER_VERSION);
      await parseViewOnce(env, target, now, { calls: 500, deadline: Date.now() + 10000, clock: Date.now });
      expect(await viewReady(db, target, now)).toBe(true);
      const appended = line('appended');
      const raced = beforeViewFlip(db, async () => {
        await captureViewTranscript(
          db,
          blobs,
          'session',
          tx,
          appended,
          now + 1,
          new TextEncoder().encode(source).length,
        );
      });
      expect(await tryPublishView(raced, target, now, envelope), name).toEqual({
        published: false,
        reason: 'view_not_ready',
      });
      expect(
        (
          await db
            .prepare('SELECT live_instance FROM session_views WHERE session_id=?')
            .bind('session')
            .first<{ live_instance: string }>()
        )?.live_instance,
      ).toBe(live);
      expect((await db.prepare('SELECT COUNT(*) n FROM learning_sessions').first<{ n: number }>())?.n).toBe(0);
      await parseViewOnce(env, target, now + 1, { calls: 500, deadline: Date.now() + 10000, clock: Date.now });
      const added = beforeViewFlip(db, async () => {
        await captureViewTranscript(
          db,
          blobs,
          'session',
          'tx_abcdef0123456789abcdef0123456789',
          line('new transcript'),
          now + 2,
        );
      });
      expect(await tryPublishView(added, target, now + 1, envelope), name).toEqual({
        published: false,
        reason: 'view_not_ready',
      });
      await parseViewOnce(env, target, now + 2, { calls: 500, deadline: Date.now() + 10000, clock: Date.now });
      expect((await tryPublishView(db, target, now + 2, envelope)).published).toBe(true);
      expect(
        (await db.prepare('SELECT COUNT(*) n FROM view_prompts WHERE instance_id=?').bind(build).first<{ n: number }>())
          ?.n,
      ).toBe(3);
    }),
  );
}, 120000);

test('real reader response contexts retain selected bodies across an atomic writer flip',async()=>{
 const {listTurns,turnDetail}=await import('@myco-server-worker/read/turns.js');
 const {withViewReadResponse,turns_readTurnBodies}=await import('@myco-server-worker/read/view-store.js');
 const {sha256Hex}=await import('@myco-server-worker/hash.js');
 const {processedBody}=await import('@myco-server-worker/read/processed.js');
 const scope={projectId:'project'},prompt=uuid(900),transcript='tx_abcdef0123456789abcdef0123456789';
 const oldBody='held old body '.repeat(1800),newBody='new published body '.repeat(1800);
 const line=(text:string,at:number,promptId=prompt)=>JSON.stringify({v:1,type:'prompt',promptId,text,at})+'\n';
 const original=line(oldBody,1),appended=line(newBody,2,uuid(901)),blobs=memoryBlobStore();
 let firstInstance='';
 await withViewStorePair('native-D1',db=>withViewWriterDriver(async()=>{
  const now=Date.now();await captureViewSession(db);await createEmptyView(db,'project','session',now);
  const env=await captureViewTranscript(db,blobs,'session',transcript,original,now,0,'opencode');
  firstInstance=await requestViewRebuild(db,'project','session',now);
  const target=(await claimViewBuild(db,'project','session',SERIAL_VIEW_BUDGET,now))!;
  await parseViewOnce(env,target,now,{calls:500,deadline:Date.now()+15000,clock:Date.now,completeFile:true});
  expect((await tryPublishView(db,target,now,fixtureFlipEnvelope())).published).toBe(true);
 }),async(native,remote)=>{
  for(const [db,store]of [[native,'native'],[remote,'D1']]as const)await withViewWriterDriver(async()=>{
   const now=Date.now();
   const env=await captureViewTranscript(db,blobs,'session',transcript,appended,now,new TextEncoder().encode(original).length,'opencode');
   const instance=await requestViewRebuild(db,'project','session',now),target=(await claimViewBuild(db,'project','session',SERIAL_VIEW_BUDGET,now))!;
   await parseViewOnce(env,target,now,{calls:500,deadline:Date.now()+15000,clock:Date.now,completeFile:true});
   const captures=[
    (bound:typeof db)=>listTurns(bound,scope,'session',{limit:200}),
    (bound:typeof db)=>turnDetail(bound,scope,'session',prompt),
    (bound:typeof db)=>processedBody({...env,db:bound},scope,'prompt',prompt),
   ];
   let release!:()=>void;const flipped=new Promise<void>(resolve=>{release=resolve});
   const selected:{promise:Promise<void>;resolve:()=>void}[]=captures.map(()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}});
   const contexts=captures.map((capture,index)=>withViewReadResponse(db,()=>now,async bound=>{
    await capture(bound);
    const heldTurns=await listTurns(bound,scope,'session',{limit:200});
    selected[index]!.resolve();await flipped;
    expect(await listTurns(bound,scope,'session',{limit:200}),store+' retained listing').toEqual(heldTurns);
    const rows=await turns_readTurnBodies(bound,scope,'session',[prompt]);
    expect(rows.get(prompt)?.prompt.blobKey,store+' selected body').toBe(await sha256Hex(oldBody));
    expect((await processedBody({...env,db:bound},scope,'prompt',prompt)),store+' selected proof').toBe(oldBody);
   }));
   await Promise.race([Promise.all(selected.map(row=>row.promise)),Promise.all(contexts)]);
   const before=beforeViewFlip(db,async()=>{
    expect((await processedBody(env,scope,'prompt',prompt))).toBe(oldBody);
   });
   expect((await tryPublishView(before,target,now,fixtureFlipEnvelope(store))).published).toBe(true);
   release();await Promise.all(contexts);
   expect((await processedBody(env,scope,'prompt',uuid(901))),store+' fresh response').toBe(newBody);
   expect(instance).not.toBe(firstInstance);
   const frontier=await db.prepare('SELECT parsed_offset FROM transcripts WHERE project_id=? AND transcript_id=?').bind('project',transcript).first<{parsed_offset:number}>();
   expect(frontier?.parsed_offset).toBe(new TextEncoder().encode(original+appended).length);
  });
 },'native');
},60000);
