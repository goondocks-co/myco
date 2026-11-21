import { expect } from 'bun:test';
import { SESSION_END_SETTLE_MS } from '@myco-server-worker/constants.js';
import { ageRows, type ParityScenario } from '../harness.ts';
import { allowWorkerClaims, endRun, event, owner, putSetting, runTool, sessionDetail, untilPublished, wake } from '../clients/requests.ts';
import { captureSession, report, runList, takeRun } from '../clients/runs.ts';

const HOUR = 3_600_000;
/** An idle open session receives a title and later refreshes after new prompts. */
export const titlingIdleRefresh: ParityScenario = {
  name: 'titling of sessions that never end: an idle open session is titled and stays open, a continued session refreshes once when quiet or ended',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    await allowWorkerClaims(target);
    expect((await putSetting(target, 'agent.tasks', { 'title-summary': { schedule: { enabled: false, intervalSeconds: 0, maxRunsPerDay: 1000 } } })).status).toBe(200);
    const id = 'idle-open';
    await captureSession(target, id, 'Work in a pane that was closed', { at: Date.now() - 4 * HOUR });
    await ageRows(target, { table: 'sessions', column: 'last_received_at', byMs: 3 * HOUR, match: { project_id: target.projectId, session_id: id } });
    await ageRows(target, { table: 'sessions', column: 'latest_activity_at', byMs: 3 * HOUR, match: { project_id: target.projectId, session_id: id } });
    const runsOf = async () => (await runList(target, 'task=title-summary')).filter(row => row.targetSessionId === id);
    const [queued] = await untilPublished(target, runsOf, rows => rows.length > 0);
    expect(queued).toMatchObject({ status: 'queued', startedBy: 'backfill' });
    expect((await sessionDetail(target, id)).body.session).toMatchObject({ endedAt: expect.any(Number), titledAt: expect.any(Number) });
    const first = await takeRun(target, queued.id);
    await runTool(target, first, 'myco_run_sessions', { op: 'material' });
    expect(await runTool(target, first, 'myco_run_sessions', { op: 'title', title: 'A long job', summary: 'It began hours ago.' })).toMatchObject({ written: true });
    await report(target, first, 'summary', 'Titled the open session.');
    expect(await endRun(target, first)).toMatchObject({ ended: true, status: 'completed' });
    const closing = crypto.randomUUID();
    await event(target, id, 'prompt', { promptId: closing, text: 'Finish the implementation', origin: 'agent_dispatch' });
    await event(target, id, 'response', { responseId: crypto.randomUUID(), promptId: closing, text: 'Committed and verified the implementation.' });
    await event(target, id, 'session.end', { endedAt: Date.now() });
    await untilPublished(target, () => owner(target, `/api/projects/${target.projectId}/sessions/${id}/turns?origins=user,agent_dispatch`), value => value.body.rows?.length === 2);
    await ageRows(target, { table: 'sessions', column: 'last_received_at', byMs: 2 * SESSION_END_SETTLE_MS, match: { project_id: target.projectId, session_id: id } });
    const rows = await untilPublished(target, runsOf, rows => rows.length === 2);
    const refresh = rows.find(row => row.id !== first.id)!;
    expect(refresh).toMatchObject({ status: 'queued', startedBy: 'backfill' });
    const second = await takeRun(target, refresh.id);
    const material = await runTool(target, second, 'myco_run_sessions', { op: 'material' });
    expect(JSON.stringify(material)).toContain('Committed and verified the implementation.');
    expect(await runTool(target, second, 'myco_run_sessions', { op: 'title', title: 'Long job completed', summary: 'Covered the work since its first title.' })).toMatchObject({ written: true });
    await report(target, second, 'summary', 'Refreshed the title.');
    expect(await endRun(target, second)).toMatchObject({ ended: true, status: 'completed' });
    await wake(target);
    expect(await runsOf()).toHaveLength(2);
    expect((await sessionDetail(target, id)).body.session).toMatchObject({ endedAt: expect.any(Number), title: 'Long job completed', titleCoverage: { throughTurnKey: closing, throughTurnCount: 2, lastTurnKey: closing, current: true } });
  },
};
