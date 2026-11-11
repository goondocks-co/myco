/**
 * What a run ran with and what it was served, as the run panel and the runner page read them:
 * - a claim keeps on its attempt the runner version the runner last reported in its contact, and the coding agent
 *   version its claim reported for the harness it runs; a runner that reports neither reads as not reported;
 * - the runner page lists both, with each run's harness, asked profile and recorded identity, for the drift it counts;
 * - Myco counts the distinct prompts it served a run, and a run queued before it counted reads as not recorded.
 *
 * Runner and dashboard requests go through the deployed pipeline the way a runner and a dashboard reach them.
 */
import { describe, expect, it } from 'bun:test';
import { getRunDetail } from '@myco-server-worker/read/runs.js';
import { expireLeases } from '@myco-server-worker/core/harness.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import { SERVED_PROMPTS_COUNTED_FROM } from '@myco-server-worker/db/runs/served-prompts.js';
import { runnerRig, type Json } from './helpers/runner-rig.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { learningRun, plainTurns, NOW as LEARNING_NOW } from './helpers/learning-stages.ts';

const CLAUDE = offeredHarness('claude-code');

/** The runner ends the run it holds, so it may take the next. */
const end = (r: ReturnType<typeof runnerRig>, token: string, run: Json) =>
  r.asRunner(token, '/worker/end', { projectId: 'proj_1', runId: run.id, attemptId: run.attemptId, status: 'failed', error: 'stopped' });

describe('versions at run time', () => {
  it('an attempt keeps the runner version from its contact and the agent version its claim reported, on the run panel and the runner page', async () => {
    const r = runnerRig();
    try {
      const { token, runnerId } = await r.register('mini');
      await r.asRunner(token, '/runners/contact', { version: '2.0.0-alpha.24' });
      await r.queueTitling();
      const { run } = await r.claim(token, [{ ...CLAUDE, version: '2.1.3' }]);
      const detail = await r.get(`/api/projects/proj_1/runs/${run.id}`);
      expect(detail.attempts.map((attempt: Json) => [attempt.runnerVersion, attempt.agentVersion])).toEqual([['2.0.0-alpha.24', '2.1.3']]);

      // A later upgrade changes what the next claim records, never what an earlier attempt ran with.
      await end(r, token, run);
      r.at(r.now() + 60_000);
      await r.asRunner(token, '/runners/contact', { version: '2.0.0-alpha.25' });
      await r.queueTitling();
      const next = (await r.claim(token, [{ ...CLAUDE, version: '2.1.4' }])).run;
      const page = await r.get(`/api/runners/${runnerId}/runs`);
      expect(page.rows.map((row: Json) => [row.runId, row.runnerVersion, row.agentVersion, row.harness])).toEqual([
        [next.id, '2.0.0-alpha.25', '2.1.4', 'claude-code'],
        [run.id, '2.0.0-alpha.24', '2.1.3', 'claude-code'],
      ]);
      expect(page.rows[0].identity).toEqual({ status: 'not_recorded' });
    } finally { r.e.sqlite.close(); }
  });

  it('each attempt names the agent it was claimed for, so a retry on another agent never relabels an earlier version', async () => {
    const r = runnerRig();
    try {
      const { token, runnerId } = await r.register('mini');
      await r.queueTitling();
      const first = (await r.claim(token, [{ ...CLAUDE, version: '2.1.3' }])).run;
      r.at(r.now() + 2 * WORKER_LEASE_MS);
      expect(await expireLeases(r.e.serverEnv as never, r.now())).toBe(1);
      // The owner moves the task to Codex before the retry.
      await settingsWriter(r.e.db).setLeaf('agent.tasks', { 'title-summary': { harness: 'codex', model: 'gpt-5.5', reasoningLevel: 'default' } }, 'member', r.now());
      const retry = (await r.claim(token, [{ ...offeredHarness('codex'), version: '0.50.0' }])).run;
      expect(retry.id).toBe(first.id);
      const detail = await r.get(`/api/projects/proj_1/runs/${first.id}`);
      expect(detail.attempts.map((attempt: Json) => [attempt.harness, attempt.agentVersion])).toEqual([['claude-code', '2.1.3'], ['codex', '0.50.0']]);
      const page = await r.get(`/api/runners/${runnerId}/runs`);
      expect(page.rows.map((row: Json) => [row.harness, row.agentVersion])).toEqual([['codex', '0.50.0'], ['claude-code', '2.1.3']]);
    } finally { r.e.sqlite.close(); }
  });

  it('a runner that reports no versions, or text that is not a version, reads as not reported', async () => {
    const r = runnerRig();
    try {
      const { token, runnerId } = await r.register('mini');
      await r.queueTitling();
      const { run } = await r.claim(token, [CLAUDE]);
      await end(r, token, run);
      r.at(r.now() + 60_000);
      await r.queueTitling();
      const second = (await r.claim(token, [{ ...CLAUDE, version: 'claude --version; rm -rf /' }])).run;
      for (const id of [run.id, second.id]) {
        const detail = await r.get(`/api/projects/proj_1/runs/${id}`);
        expect(detail.attempts.map((attempt: Json) => [attempt.runnerVersion, attempt.agentVersion])).toEqual([[null, null]]);
      }
      const page = await r.get(`/api/runners/${runnerId}/runs`);
      expect(page.rows.map((row: Json) => [row.runnerVersion, row.agentVersion])).toEqual([[null, null], [null, null]]);
    } finally { r.e.sqlite.close(); }
  });
});

describe('prompts served', () => {
  it('counts each prompt Myco served a run once, however often it is served again', async () => {
    await withDocumentStores(async (db) => {
      const turns = plainTurns(6);
      const run = await learningRun(db, turns, 'low');
      const served = async () => (await getRunDetail(db, { projectId: 'project' }, run.claimed.id, LEARNING_NOW, 'member'))?.servedPrompts;
      expect(await served()).toBe(0);
      await run.readAll();
      expect(await served()).toBe(turns.length);
      await run.readAll();
      expect(await served()).toBe(turns.length);
    });
  });

  it('a run queued before Myco counted the prompts it served reads as not recorded', async () => {
    await withDocumentStores(async (db) => {
      const run = await learningRun(db, plainTurns(2), 'low');
      await run.readAll();
      await db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').bind(String(LEARNING_NOW * 2), SERVED_PROMPTS_COUNTED_FROM).run();
      expect((await getRunDetail(db, { projectId: 'project' }, run.claimed.id, LEARNING_NOW, 'member'))?.servedPrompts).toBeNull();
    });
  });
});
