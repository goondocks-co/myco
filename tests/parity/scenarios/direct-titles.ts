import completion from '../../fixtures/providers/workers-ai-completion.json';

import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { owner, sessionDetail, untilPublished } from '../clients/requests.ts';
import { captureSession, runDetail, runList } from '../clients/runs.ts';
import { withSettings } from '../clients/settings.ts';

/** Both front doors call an OpenAI-compatible provider without a registered runner. */
export const directTitles: ParityScenario = {
  name: 'direct titles: configured model writes and records a session title without a runner',
  dedicated: { timeoutMs: 120_000, cloudflare: { embeddingFixture: 'completion' } },
  async run(target) {
    const answer = JSON.parse(completion.r.choices[0]!.message.content) as { title: string; summary: string };
    const hosted = target.name === 'cloudflare';
    const model = hosted ? completion.r.model : 'local-title-model';
    const stub = hosted ? null : Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(request) {
        const body = await request.json() as { response_format?: { type: string } };
        expect(body.response_format?.type).toBe('json_schema');
        return Response.json(completion.r);
      },
    });
    try {
      const session = 'direct-title-session';
      await captureSession(target, session, 'Add a bounded retry to delivery');
      await withSettings(target, { ...(stub === null ? {} : { 'single_turn.base_url': `http://127.0.0.1:${stub.port}/v1` }), 'single_turn.model': model }, async () => {
        const titled = await owner(target, `/api/projects/${target.projectId}/sessions/${session}/title`, { method: 'POST' });
        expect(titled.status).toBe(200);
        expect(titled.body).toMatchObject({ outcome: 'completed', ...answer });
        const runId = titled.body.runId as string;
        const completed = await untilPublished(target, () => sessionDetail(target, session), value => value.body.session.title === answer.title);
        expect(completed.body.session).toMatchObject(answer);
        const run = await runDetail(target, runId);
        expect(run.run).toMatchObject({ status: 'completed', provider: 'direct', model, harness: null, tokensUsed: completion.r.usage.total_tokens, costProvenance: hosted ? 'model_pricing' : 'unavailable', targetSessionId: session });
        expect(run.attempts).toEqual([]);
        expect(run.run.identity).toMatchObject({ status: 'reported', primary: { model } });
        expect((await runList(target, 'task=title-summary')).find(row => row.id === runId)).toMatchObject({ status: 'completed', model });
        expect(completed.body.outcome.runs).toContainEqual(expect.objectContaining({ runId, titled: true }));
      });
      if (hosted) {
        const settings = await owner(target, '/api/settings');
        expect(settings.body.leaves.find((leaf: { leaf: string }) => leaf.leaf === 'single_turn.model')).toMatchObject({ configured: false, effective: completion.r.model });
      }
    } finally { stub?.stop(true); }
  },
};
