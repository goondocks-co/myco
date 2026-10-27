import { expect, test } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ViewWriteTarget } from '@myco-server-worker/ingest/view-guard.js';
import { createEmptyView, requestViewRebuild, tryPublishView } from '@myco-server-worker/ingest/view-lifecycle.js';
import { readFlipWork, flipWorkSql, type FlipEnvelope } from '@myco-server-worker/ingest/view-flip-work.js';
import {
  claimViewBuild,
  SERIAL_VIEW_BUDGET,
  PARALLEL_VIEW_BUDGET,
} from '@myco-server-worker/ingest/view-build-queue.js';
import { PARSER_VERSION } from '@myco-server-worker/ingest/parse.js';
import { parseViewOnce as parseInstance } from '@myco-server-worker/ingest/view-parse.js';
import { setPublishedPlanStatus } from '@myco-server-worker/core/material-fact-writer.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { EXCLUDED_TABLES, BACKUP_TABLES } from '@myco-server-worker/core/backup.js';
import { withViewStores, withViewStorePair, captureViewSession, captureViewTranscript } from './helpers/view-stores.js';
import { memoryBlobStore, uuid } from './helpers/fixtures.js';
import { beforeViewWriteBatch } from './helpers/view-instances.js';
import { fixtureFlipEnvelope } from '../helpers/view-flip-envelope.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';

async function ready(db: RelationalStore, profile: 'serial' | 'parallel' = 'serial') {
  const now = Date.now(),
    blobs = memoryBlobStore();
  await captureViewSession(db);
  await createEmptyView(db, 'project', 'session', now);
  const text = JSON.stringify({ role: 'user', message: { content: 'flip work' } }) + '\n';
  const env = await captureViewTranscript(db, blobs, 'session', 'tx_0123456789abcdef0123456789abcdef', text, now);
  const instance = await requestViewRebuild(db, 'project', 'session', now);
  const target = (await claimViewBuild(
    db,
    'project',
    'session',
    profile === 'serial' ? SERIAL_VIEW_BUDGET : PARALLEL_VIEW_BUDGET,
    now,
  ))!;
  await parseInstance(env, target, now, {
    calls: 500,
    deadline: Date.now() + 10000,
    clock: Date.now,
    completeFile: true,
  });
  return { now, instance, target, env };
}

const publicationState = async (db: RelationalStore) => ({
  view: await db
    .prepare(`SELECT * FROM session_views WHERE project_id=? AND session_id=?`)
    .bind('project', 'session')
    .first(),
  versions: (
    await db
      .prepare(`SELECT * FROM material_versions WHERE project_id=? AND session_id=? ORDER BY material_seq`)
      .bind('project', 'session')
      .all()
  ).results,
  allocator: await db
    .prepare(`SELECT * FROM learning_sessions WHERE project_id=? AND session_id=?`)
    .bind('project', 'session')
    .first(),
});

test('missing, wrong-target and undersized whole-flip evidence refuses before any publication on native and D1', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const { target, now, env } = await ready(db),
        envelope = fixtureFlipEnvelope(store);
      await setPublishedPlanStatus(env, { projectId: 'project' }, uuid(50), 'active', 'member', now);
      await db
        .prepare(
          `INSERT INTO spore_injections(project_id,session_id,id,prompt_id,ask_protocol,prompt_hash,spore_ids,plan_ids,created_at)
    VALUES(?,?,?,?,'legacy',?,'[]','[]',?)`,
        )
        .bind('project', 'session', 'receipt', uuid(20), 'hash', now)
        .run();
      const work = await readFlipWork(db, target),
        before = await publicationState(db);
      expect(work.candidate_prompt_rows, store).toBe(1);
      expect(work.fact_prompt_rows).toBe(1);
      expect(work.bindings).toBe(1);
      expect(work.placement_spore_injections).toBe(1);
      expect(work.checkpoints).toBe(1);
      expect(work.checkpoint_bytes).toBeGreaterThan(0);
      const unavailable = { ...envelope, measurement: null };
      const untouched: RelationalStore = {
        prepare: () => {
          throw new Error('unavailable admission touched the store');
        },
        batch: () => {
          throw new Error('unavailable admission wrote');
        },
      };
      expect(await tryPublishView(untouched, target, now, unavailable)).toEqual({
        published: false,
        reason: 'view_flip_admission_unavailable',
      });
      expect(
        await tryPublishView(db, target, now, {
          ...envelope,
          measurement: { ...envelope.measurement!, store: store === 'native' ? 'remote' : 'native' },
        }),
      ).toEqual({ published: false, reason: 'view_flip_admission_unavailable' });
      for (const field of [
        'candidate_prompt_rows',
        'fact_prompt_rows',
        'placement_spore_injections',
        'bindings',
        'checkpoints',
        'checkpoint_bytes',
      ]) {
        const limited = {
          ...envelope,
          measurement: { ...envelope.measurement!, workload: { ...envelope.measurement!.workload, [field]: 0 } },
        };
        expect(await tryPublishView(db, target, now, limited), field).toEqual({
          published: false,
          reason: 'view_flip_content_wall_exceeded',
        });
        expect(await publicationState(db)).toEqual(before);
      }
      expect(await db.prepare(`SELECT COUNT(*) n FROM view_flip_calibrations`).first()).toEqual({ n: 0 });
      expect(EXCLUDED_TABLES.has('view_flip_calibrations')).toBe(true);
      expect(BACKUP_TABLES.includes('view_flip_calibrations')).toBe(false);
    }),
  );
}, 120000);

test('committed overruns and interrupted observations quarantine their calibration without pretending to undo publication', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const { target, now, env } = await ready(db),
        envelope = fixtureFlipEnvelope(store);
      let ticks = 0;
      const result = await tryPublishView(db, target, now, envelope, () => (++ticks < 3 ? 0 : 2001));
      expect(result.published, store).toBe(true);
      if (!result.published) throw new Error(result.reason);
      expect(result.overrun).toBe(true);
      expect(
        (
          await db
            .prepare(`SELECT live_instance FROM session_views WHERE project_id=? AND session_id=?`)
            .bind('project', 'session')
            .first<{ live_instance: string }>()
        )?.live_instance,
      ).toBe(target.instanceId);
      await requestViewRebuild(db, 'project', 'session', now + 1);
      const next = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now + 1))!;
      await parseInstance(env, next, now + 1, {
        calls: 500,
        deadline: Date.now() + 10000,
        clock: Date.now,
        completeFile: true,
      });
      const before = await publicationState(db);
      expect(await tryPublishView(db, next, now + 1, envelope)).toEqual({
        published: false,
        reason: 'view_flip_admission_unavailable',
      });
      expect(await publicationState(db)).toEqual(before);
      const row = await db
        .prepare(`SELECT blocked,maximum_wall_ms,last_observation FROM view_flip_calibrations`)
        .first<{ blocked: number; maximum_wall_ms: number; last_observation: string }>();
      expect(row?.blocked).toBe(1);
      expect(row?.maximum_wall_ms).toBe(2001);
      expect(JSON.parse(row!.last_observation).cpuMs).toBeNull();
    }),
  );
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const { target, now } = await ready(db),
        envelope = fixtureFlipEnvelope(store);
      const interrupted = beforeViewWriteBatch(
        db,
        (sql) => sql.includes('last_observation=?'),
        async () => {
          throw new Error('interrupted observation');
        },
        true,
      );
      await expect(tryPublishView(interrupted, target, now, envelope)).rejects.toThrow('interrupted observation');
      expect(
        (
          await db
            .prepare(`SELECT live_instance FROM session_views WHERE project_id=? AND session_id=?`)
            .bind('project', 'session')
            .first<{ live_instance: string }>()
        )?.live_instance,
      ).toBe(target.instanceId);
      expect(await tryPublishView(db, target, now, envelope)).toEqual({
        published: false,
        reason: 'view_flip_admission_unavailable',
      });
    }),
  );
}, 120000);

for (const store of ['native', 'D1'] as const)
  for (const profile of ['serial', 'parallel'] as const) {
    test(
      'a paired whole-flip measurement admits its identical ' + store + '/' + profile + ' workload',
      async () =>
        withViewWriterDriver(async () => {
          let state: Awaited<ReturnType<typeof ready>>;
          await withViewStorePair(
            store,
            async (db) => {
              state = await ready(db, profile);
            },
            async (baseline, candidate) => {
              const bootstrap = fixtureFlipEnvelope(store, profile),
                work = await readFlipWork(baseline, state.target);
              expect((await tryPublishView(baseline, state.target, state.now, bootstrap)).published).toBe(true);
              const row = (await baseline
                .prepare(`SELECT last_observation FROM view_flip_calibrations`)
                .first<{ last_observation: string }>())!;
              const observed = JSON.parse(row.last_observation) as {
                wallMs: number;
                statements: number;
                roundTrips: number;
                transactionRowsRead: number | null;
                transactionRowsWritten: number | null;
                cpuMs: null;
              };
              const source = 'paired local whole-flip ' + store + '/' + profile,
                observedAt = Date.now();
              const measurement = {
                store: bootstrap.store,
                profile,
                source,
                sourceDigest: await sha256Hex(JSON.stringify([source, work, observed, observedAt])),
                observedAt,
                parserVersion: PARSER_VERSION,
                workload: work,
                wallMs: observed.wallMs,
                statements: observed.statements,
                roundTrips: observed.roundTrips,
                rowsRead: observed.transactionRowsRead,
                rowsWritten: observed.transactionRowsWritten,
                cpuMs: observed.cpuMs,
              };
              const envelope: FlipEnvelope = { store: bootstrap.store, profile, measurement, reserveFraction: 0 };
              const result = await tryPublishView(candidate, state.target, state.now, envelope);
              expect(result.published).toBe(true);
              if (!result.published) throw new Error(result.reason);
              expect(result.overrun).toBe(false);
              expect(result.wallMs).toBeLessThanOrEqual(2000);
              console.log(
                JSON.stringify({
                  measurement: 'whole-view-flip',
                  store,
                  profile,
                  source,
                  workload: work,
                  observed,
                  repeatWallMs: result.wallMs,
                }),
              );
              expect(await publicationState(candidate)).toEqual(await publicationState(baseline));
            },
          );
        }),
      120000,
    );
  }

test('the separate 26165-prompt and 7000-ack scale fixture is refused above a measured envelope', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const { target, now } = await ready(db);
      for (let start = 1; start < 26165; start += 1000) {
        const ids = Array.from({ length: Math.min(1000, 26165 - start) }, (_, index) => start + index);
        await db
          .prepare(
            `INSERT INTO view_prompts(project_id,instance_id,session_id,prompt_id,origin,text,content_hash,created_at,updated_at,received_at,
     canonical_identity,view_content_hash,hash_scheme,source_transcript_id,source_offset,source_end)
     SELECT ?,?,?,'scale-'||value,'user','scale','body',1,1,1,json_array('prompt','scale-'||value),'material','view-content-v1',?,0,1 FROM json_each(?)`,
          )
          .bind('project', target.instanceId, 'session', 'tx_0123456789abcdef0123456789abcdef', JSON.stringify(ids))
          .run();
      }
      await db
        .prepare(
          `INSERT INTO extraction_acks(project_id,ack_id,session_id,kind,record_id,acknowledged_at,run_id)
    SELECT ?,'scale-ack-'||value,?,'record','absent-'||value,?,'scale-run' FROM json_each(?)`,
        )
        .bind('project', 'session', now, JSON.stringify(Array.from({ length: 7000 }, (_, index) => index)))
        .run();
      const work = await readFlipWork(db, target);
      expect(work.candidate_prompt_rows, store).toBe(26165);
      expect(work.acks).toBe(7000);
      const before = await publicationState(db),
        envelope = fixtureFlipEnvelope(store);
      envelope.measurement!.workload.candidate_prompt_rows = 1000;
      expect(await tryPublishView(db, target, now, envelope)).toEqual({
        published: false,
        reason: 'view_flip_content_wall_exceeded',
      });
      expect(await publicationState(db)).toEqual(before);
      console.log(JSON.stringify({ measurement: 'oversized-view-flip-refusal', store, workload: work }));
      const query = flipWorkSql(target);
      expect(new TextEncoder().encode(query.sql).length).toBeLessThan(100000);
      expect(query.params).toHaveLength(1);
      const plan = (
        await db
          .prepare('EXPLAIN QUERY PLAN SELECT (' + query.sql + ')')
          .bind(...query.params)
          .all<{ detail: string }>()
      ).results.map((row) => row.detail);
      expect(plan.some((detail) => /SEARCH view_prompts.*project_id=\? AND instance_id=\?/.test(detail))).toBe(true);
      expect(plan.some((detail) => /^SCAN view_prompts(?: |$)/.test(detail))).toBe(false);
    }),
  );
}, 120000);
