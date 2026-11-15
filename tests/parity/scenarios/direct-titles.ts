
import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { sessionDetail, untilPublished } from '../clients/requests.ts';
import { askTitle, captureSession, runDetail, runList } from '../clients/runs.ts';
import { withSettings } from '../clients/settings.ts';

/** Both front doors call an OpenAI-compatible provider without a registered runner. */
export const directTitles: ParityScenario = {
  name: 'direct titles: configured model writes and records a session title without a runner',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    const answer = { title: 'Added bounded retry to delivery', summary: 'Added a bounded retry to delivery. Verified successful delivery after a transient refusal.' };
    const stub = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(request) {
        const body = await request.json() as { response_format?: { type: string } };
        expect(body.response_format?.type).toBe('json_schema');
        return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 800, completion_tokens: 90 } });
      },
    });
    try {
      const session = 'direct-title-session';
      await captureSession(target, session, 'Add a bounded retry to delivery');
      await withSettings(target, { 'single_turn.base_url': `http://127.0.0.1:${stub.port}/v1`, 'single_turn.model': 'local-title-model' }, async () => {
        const runId = await askTitle(target, session);
        const completed = await untilPublished(target, () => sessionDetail(target, session), value => value.body.session.title === answer.title);
        expect(completed.body.session).toMatchObject(answer);
        const run = await runDetail(target, runId);
        expect(run.run).toMatchObject({ status: 'completed', provider: 'direct', model: 'local-title-model', harness: null, tokensUsed: 890, costUsd: null, costProvenance: 'unavailable', targetSessionId: session });
        expect(run.attempts).toEqual([]);
        expect(run.run.identity).toMatchObject({ status: 'reported', primary: { model: 'local-title-model' } });
        expect((await runList(target, 'task=title-summary')).find(row => row.id === runId)).toMatchObject({ status: 'completed', model: 'local-title-model' });
        expect(completed.body.outcome.runs).toContainEqual(expect.objectContaining({ runId, titled: true }));
      });
    } finally { stub.stop(true); }
  },
};
