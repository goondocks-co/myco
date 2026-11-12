import { expect } from 'bun:test';
import { type ParityScenario, waitFor } from '../harness.ts';
import { allowWorkerClaims, runTool } from '../clients/requests.ts';
import { asMember, askTitle, captureSession, finishRun, linkedMember, runDetail, takeRun } from '../clients/runs.ts';

/** A member reads which session a genuinely claimed title run consumed. */
export const runReads: ParityScenario = {
  name: 'run reads: a run\'s read of its session is recorded, and a member reads it off the session and the run',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    await allowWorkerClaims(target);
    const joined = await linkedMember(target, '1518003');
    const sessionId = 'reads-session';
    await captureSession(asMember(target, joined.token), sessionId, 'Record what the run reads');
    const run = await takeRun(target, await askTitle(target, sessionId));
    expect(await runTool(target, run, 'myco_run_sessions', { op: 'material' })).toMatchObject({ session_id: sessionId });
    const recorded = await waitFor(() => runDetail(target, run.id), detail => detail.read.recorded);
    expect(recorded.read).toEqual({ sessions: [{ sessionId, title: null, readAt: expect.any(Number) }], total: 1, recorded: true });
    const read = async (path: string) => {
      const response = await fetch(`${target.url}${path}`, { headers: joined.headers });
      expect(response.status).toBe(200); return response.json() as Promise<any>;
    };
    const session = await read(`/api/projects/${target.projectId}/sessions/${sessionId}`);
    expect(session.outcome.runs).toEqual([expect.objectContaining({ runId: run.id, task: 'title-summary', readAt: expect.any(Number), target: true, titled: false, spores: 0 })]);
    const detail = await read(`/api/projects/${target.projectId}/runs/${run.id}`);
    expect(detail.read).toEqual(recorded.read);
    expect(detail.produced).toEqual({ spores: { total: 0, items: [] } });
    expect(await finishRun(target, run)).toMatchObject({ ended: true });
  },
};
