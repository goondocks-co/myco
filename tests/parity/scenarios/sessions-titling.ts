import { expect } from 'bun:test';
import { SESSION_END_SETTLE_MS } from '@myco-server-worker/constants.js';
import { ageRows, type ParityScenario } from '../harness.ts';
import { allowWorkerClaims, endRun, event, mcp, owner, runTool, sessionDetail, wake } from '../clients/requests.ts';
import { askTitle, captureSession, report, runList, takeRun } from '../clients/runs.ts';

/** Captured sessions queue once, retain their prompt label, and receive a worker's title. */
export const sessionsTitling: ParityScenario = {
  name: 'sessions and titling: capture, the unbound-runtime fallback, label, MCP, an owner\'s ask',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    await allowWorkerClaims(target);
    const session = 'titling-ended';
    await captureSession(target, session, 'Add a retry to the runner please', { ended: true });
    await ageRows(target, { table: 'sessions', column: 'last_received_at', byMs: 2 * SESSION_END_SETTLE_MS, match: { project_id: target.projectId, session_id: session } });
    await wake(target);
    const runsOf = async (id: string) => (await runList(target, 'task=title-summary')).filter(row => row.targetSessionId === id);
    const [queued] = await runsOf(session);
    expect(queued).toMatchObject({ status: 'queued', harness: null, heldBy: 'worker' });
    const initial = (await sessionDetail(target, session)).body.session;
    const attemptedAt = initial.titledAt;
    expect(initial).toMatchObject({ title: null, summary: null, titledAt: expect.any(Number) });
    const ask = (id: string) => owner(target, `/api/projects/${target.projectId}/sessions/${id}/title`, { method: 'POST' });
    expect((await ask(session)).body).toEqual({ outcome: 'already' });
    const listed = await owner(target, `/api/projects/${target.projectId}/sessions`);
    expect(listed.body.rows.find((row: any) => row.sessionId === session)?.label).toBe('Add a retry to the runner please');
    expect(await mcp(target, 'myco_sessions', { op: 'get', id: session })).toMatchObject({ id: session, title: null });
    await event(target, session, 'session.end', { endedAt: Date.now() });
    await ageRows(target, { table: 'sessions', column: 'last_received_at', byMs: 2 * SESSION_END_SETTLE_MS, match: { project_id: target.projectId, session_id: session } });
    await wake(target);
    expect((await ask(session)).body).toEqual({ outcome: 'already' });
    expect((await sessionDetail(target, session)).body.session.titledAt).toBe(attemptedAt);
    expect(await runsOf(session)).toHaveLength(1);
    const run = await takeRun(target, queued.id);
    const writes = await Promise.all([
      runTool(target, run, 'myco_run_sessions', { op: 'title', title: 'Runner retry', summary: 'Added a retry to the runner.' }),
      runTool(target, run, 'myco_run_sessions', { op: 'title', title: 'Runner retry', summary: 'Added a retry to the runner.' }),
    ]);
    expect(writes.map(write => write.written).sort()).toEqual([false, true]);
    expect((await sessionDetail(target, session)).body.session).toMatchObject({ title: 'Runner retry', summary: 'Added a retry to the runner.' });
    await report(target, run, 'summary', 'Added a retry to the runner.');
    expect(await endRun(target, run)).toMatchObject({ ended: true, status: 'completed' });

    const open = 'titling-open';
    await captureSession(target, open, 'Rename the project from the card');
    const asked = await askTitle(target, open);
    expect((await runsOf(open))[0]).toMatchObject({ id: asked, status: 'queued', heldBy: 'worker' });
    const taken = await takeRun(target, asked);
    expect(await runTool(target, taken, 'myco_run_sessions', { op: 'title', title: 'Project renamed', summary: 'Renamed the project from its card.' })).toMatchObject({ written: true });
    await report(target, taken, 'summary', 'Renamed the project.');
    expect(await endRun(target, taken)).toMatchObject({ ended: true, status: 'completed' });
  },
};
