import { fixtureFlipEnvelope } from '../helpers/view-flip-envelope.js';
import { expect, test } from 'bun:test';
import { withViewStores, captureViewSession, captureViewTranscript } from './helpers/view-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';
import { createEmptyView, requestViewRebuild } from '@myco-server-worker/ingest/view-lifecycle.js';
import { SERIAL_VIEW_BUDGET, PARALLEL_VIEW_BUDGET } from '@myco-server-worker/ingest/view-build-queue.js';
import { runViewParseJob } from '@myco-server-worker/ingest/view-run.js';
import { projectHostedConvergence, type ProjectionInput } from '@myco-server-worker/core/view-throughput.js';
import { setPublishedPlanStatus } from '@myco-server-worker/core/material-fact-writer.js';
import { beforeViewWriteBatch, beforeViewCheckpointRead } from './helpers/view-instances.js';
import { uuid } from './helpers/fixtures.js';

const tx = 'tx_0123456789abcdef0123456789abcdef';
const bytes = (text: string) => new TextEncoder().encode(text).length;
const lines = (count: number, width: number) =>
  Array.from(
    { length: count },
    () => JSON.stringify({ role: 'user', message: { content: 'x'.repeat(width) } }) + '\n',
  ).join('');
for (const [profile, budget] of [
  ['serial', SERIAL_VIEW_BUDGET],
  ['parallel', PARALLEL_VIEW_BUDGET],
] as const) {
  test(`net publication drain under continuous capture on ${profile} budget`, async () => {
    await withViewStores(async (db, store) =>
      withViewWriterDriver(async () => {
        const blobs = memoryBlobStore(),
          now = Date.now();
        await captureViewSession(db);
        await createEmptyView(db, 'project', 'session', now);
        const initial = lines(80, 1700),
          initialBytes = bytes(initial);
        let size = initialBytes;
        const sourceEnv = await captureViewTranscript(db, blobs, 'session', tx, initial, now);
        await setPublishedPlanStatus(sourceEnv, { projectId: 'project' }, uuid(50), 'active', 'member', now);
        let buildPasses = 0,
          hookWrites = 0;
        const capture = beforeViewCheckpointRead(db, async () => {
          const append = lines(4, 1000);
          await captureViewTranscript(db, blobs, 'session', tx, append, Date.now(), size);
          size += bytes(append);
          buildPasses++;
        });
        const concurrent = beforeViewWriteBatch(
          capture,
          (sql) => sql.includes('UPDATE view_checkpoints SET parsed_offset='),
          async () => {
            hookWrites++;
            await setPublishedPlanStatus(
              sourceEnv,
              { projectId: 'project' },
              uuid(50),
              hookWrites % 2 ? 'completed' : 'active',
              'member',
              Date.now(),
            );
          },
        );
        const env = { ...sourceEnv, db: concurrent };
        const instance = await requestViewRebuild(db, 'project', 'session', now);
        const start = performance.now(),
          reports: Awaited<ReturnType<typeof runViewParseJob>>[] = [];
        let published = 0,
          passes = 0;
        for (; passes < 32 && !published; passes++) {
          const report = await runViewParseJob(env, Date.now(), {
            profile: budget,
            envelope: fixtureFlipEnvelope(store, budget.slots === 2 ? 'parallel' : 'serial'),
          });
          reports.push(report);
          published += report.published;
          expect(report.usage.statements).toBeLessThanOrEqual(800);
          expect(report.usage.roundTrips + report.usage.blobCalls).toBeLessThanOrEqual(budget.calls);
          expect(report.usage.blobCalls).toBeLessThanOrEqual(240);
          if (!published) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const wallMs = performance.now() - start;
        expect(published, store).toBe(1);
        expect(passes).toBeLessThanOrEqual(32);
        const live = await db
          .prepare(`SELECT live_instance FROM session_views WHERE project_id='project' AND session_id='session'`)
          .first<{ live_instance: string }>();
        expect(live?.live_instance).toBe(instance);
        const frontier = await db
          .prepare(`SELECT parsed_offset FROM transcripts WHERE project_id='project' AND transcript_id=?`)
          .bind(tx)
          .first<{ parsed_offset: number }>();
        expect(frontier?.parsed_offset).toBe(size);
        const prompts = await db
          .prepare(`SELECT COUNT(*) n FROM view_prompts WHERE project_id='project' AND instance_id=?`)
          .bind(instance)
          .first<{ n: number }>();
        expect(prompts?.n).toBe(80 + buildPasses * 4);
        expect(buildPasses).toBeGreaterThan(1);
        expect(hookWrites).toBe(buildPasses);
        expect(
          (await db
            .prepare(`SELECT revision FROM learning_sessions WHERE project_id=? AND session_id=?`)
            .bind('project', 'session')
            .first<{ revision: number }>())!.revision,
        ).toBeGreaterThan(buildPasses);
        const localNet = initialBytes / (wallMs / 1000);
        expect(localNet).toBeGreaterThan(0);
        console.log(
          JSON.stringify({
            measurement: 'view-publication-drain',
            store,
            profile,
            initialBytes,
            appendedBytes: size - initialBytes,
            publishedBytes: size,
            passes,
            buildPasses,
            wallMs,
            localNet,
            statements: reports.reduce((n, r) => n + r.usage.statements, 0),
            roundTrips: reports.reduce((n, r) => n + r.usage.roundTrips, 0),
            blobs: reports.reduce((n, r) => n + r.usage.blobCalls, 0),
          }),
        );
      }),
    );
  }, 120000);
}

test('hosted projection subtracts offered capture and refuses unsourced, unstable or unpublishable evidence', () => {
  const evidence: ProjectionInput = {
    profile: 'serial',
    heldBytes: 1000000,
    peakDailyBytes: 86400,
    growthSource: 'synthetic fixture, 2026-10-24',
    latencySource: 'injected 1ms SQL, 2ms blob, 2026-10-24',
    liveBytesPerSecond: 1,
    localNet: 1000,
    bytesPerCall: 1000,
    bytesPerStatement: 1000,
    bytesPerBlob: 1000,
    wakeMs: 2000,
    roundTripsPerByte: 0.001,
    blobCallsPerByte: 0.0001,
    sqlLatencyMs: 1,
    blobLatencyMs: 2,
    contentBytes: 100,
    contentCpuMs: 1,
    liveLagStable: true,
    publications: 1,
  };
  expect(projectHostedConvergence(evidence).admit).toBe(true);
  const measured = projectHostedConvergence(evidence);
  expect('latency' in measured && measured.latency).toBeCloseTo(1 / 0.0000012 - 1);
  for (const change of [
    { growthSource: '' },
    { latencySource: '' },
    { liveBytesPerSecond: 0 },
    { localNet: 0 },
    { liveLagStable: false },
    { publications: 0 },
    { contentCpuMs: 2001 },
    { heldBytes: 1e20 },
    { bytesPerCall: 0.001 },
  ]) {
    expect(projectHostedConvergence({ ...evidence, ...change }).admit).toBe(false);
  }
});
