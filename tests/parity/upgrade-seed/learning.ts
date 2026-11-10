import { expect } from 'bun:test';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { CARD_REPORT_ACTION, EXTRACTION_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.ts';
import { RUN_AUDIT } from '../../helpers/run-audit.ts';
import { documentsPublished, lit, memberHeadersFor } from '../harness.ts';
import { event, setting, type RouteTarget, type SeedTarget } from './requests.ts';

/** A session a member's machine, working as a worker, carded and learned from, acknowledging its prompts. */
export interface LearningSeed { sessionId: string; promptId: string }

type Run = { id: string; task: string; attemptId: string; runToken: string };

async function post(target: RouteTarget, path: string, body: unknown, headers = target.memberHeaders()): Promise<any> {
  const response = await fetch(`${target.url}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status, path).toBe(200);
  return response.json();
}

async function call(target: RouteTarget, run: Run, name: string, input: Record<string, unknown>): Promise<any> {
  const body = await post(target, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: target.projectId, ...input } } },
    memberHeadersFor(run.runToken, target.projectId));
  expect(body.error).toBeUndefined();
  expect(body.result?.isError, name).not.toBe(true);
  return body.result.structuredContent.result;
}

async function end(target: RouteTarget, run: Run, status: 'completed' | 'failed'): Promise<void> {
  expect(await post(target, '/worker/end', { projectId: target.projectId, runId: run.id, attemptId: run.attemptId, status,
    usage: { inputTokens: null, outputTokens: null, costUsd: 0 } })).toMatchObject({ ended: true, status });
}

/**
 * An ended session the member's machine cards and learns from as a worker, through the claim, the run tools and the
 * run's end, so the Deployment holds the acknowledgements its learning records. Work the claim offers first that is
 * not the session's cards or learning ends failed, as a worker that cannot do it would end it.
 */
export async function seedLearning(target: SeedTarget, stamp: number): Promise<LearningSeed> {
  for (const [leaf, value] of [['agent.harnesses.claude-code.credential', 'worker-login'], ['agent.scheduled_tasks_enabled', true], ['agent.budget.daily_usd', 1]] as const) {
    expect((await setting(target, `/api/settings/${leaf}`, { value })).status).toBe(200);
  }
  const at = stamp - 7_200_000;
  const seed = { sessionId: `upgrade-learned-${stamp}`, promptId: crypto.randomUUID() };
  await event(target, seed.sessionId, 'session.start', { agent: 'claude-code', branch: 'upgrade', startedAt: at }, at);
  await event(target, seed.sessionId, 'prompt', { promptId: seed.promptId, text: 'Record why the upgrade waits for its migrations.', origin: 'user' }, at + 1);
  await event(target, seed.sessionId, 'response', { responseId: crypto.randomUUID(), promptId: seed.promptId, text: 'Serving before the migrations refuses writes.' }, at + 2);
  await event(target, seed.sessionId, 'session.end', { endedAt: at + 3 }, at + 3);
  await documentsPublished(target, seed.sessionId);
  for (let claims = 0; claims < 8; claims += 1) {
    const claim = await post(target, '/worker/claim', { harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES });
    expect(claim, 'a claim while the seeded session awaits its learning').toMatchObject({ claimed: true });
    const run = claim.run as Run;
    if (run.task === 'turn-cards') {
      const material = await call(target, run, 'myco_run_cards', { op: 'material' });
      const turns = (material.turns as { turn_key: string }[]).map((turn) => turn.turn_key);
      expect(await call(target, run, 'myco_run_cards', { op: 'write', revision: material.revision, cards: turns.map((turn) => ({ turns: [turn], signal: 'high', card: {
        asked: 'Record the upgrade order', done: 'Recorded it', outcome: 'done', decisions: [], rejected: [], errors: [], corrections: [], files: [], commands: [], open_questions: [],
      } })) })).toMatchObject({ written: turns.length });
      await call(target, run, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'Carded the session', audit: RUN_AUDIT });
      await end(target, run, 'completed');
    } else if (run.task === 'extract-curate') {
      await call(target, run, 'myco_run_learning', { op: 'material' });
      expect(await call(target, run, 'myco_run_learning', { op: 'complete', handoff: '' })).toMatchObject({ completed: true });
      await call(target, run, 'myco_run', { op: 'report', action: EXTRACTION_REPORT_ACTION, summary: 'Learned nothing new', audit: RUN_AUDIT });
      await end(target, run, 'completed');
      const acknowledged = await target.sql(`SELECT COUNT(*) AS n FROM extraction_acks WHERE project_id=${lit(target.projectId)} AND record_id=${lit(seed.promptId)}`);
      if (acknowledged[0]!.n === 1) return seed;
    } else await end(target, run, 'failed');
  }
  throw new Error(`the seeded session ${seed.sessionId} was not learned within eight claims`);
}
