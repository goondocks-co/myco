import { expect } from 'bun:test';
import { TITLING_REFRESH_MIN_PROMPTS, TITLING_REFRESH_MIN_INTERVAL_MS } from '@myco-server-worker/constants.js';
import { ageRows, type ParityScenario } from '../harness.ts';
import { allowWorkerClaims, event, putSetting, runTool, sessionDetail, untilPublished, wake } from '../clients/requests.ts';
import { captureSession, finishRun, publishedSession, report, runList, takeRun } from '../clients/runs.ts';

const HOUR = 3_600_000;
/** An idle open session receives a title and later refreshes after new prompts. */
export const titlingIdleRefresh: ParityScenario = {
  name: 'titling of sessions that never end: an idle open session is titled and stays open, a long open session is refreshed once per interval',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    await allowWorkerClaims(target);
    expect((await putSetting(target, 'agent.tasks', { 'title-summary': { schedule: { enabled: false, intervalSeconds: 0, maxRunsPerDay: 1000 } } })).status).toBe(200);
    const id = 'idle-open';
    await captureSession(target, id, 'Work in a pane that was closed', { at: Date.now() - 4 * HOUR });
    await ageRows(target, { table: 'sessions', column: 'last_received_at', byMs: 3 * HOUR, match: { project_id: target.projectId, session_id: id } });
    const runsOf = async () => (await runList(target, 'task=title-summary')).filter(row => row.targetSessionId === id);
    const [queued] = await untilPublished(target, runsOf, rows => rows.length > 0);
    expect(queued).toMatchObject({ status: 'queued', startedBy: 'backfill' });
    expect((await sessionDetail(target, id)).body.session).toMatchObject({ endedAt: null, titledAt: expect.any(Number) });
    const first = await takeRun(target, queued.id);
    expect(await runTool(target, first, 'myco_run_sessions', { op: 'title', title: 'A long job', summary: 'It began hours ago.' })).toMatchObject({ written: true });
    await report(target, first, 'summary', 'Titled the open session.');
    expect(await finishRun(target, first, { status: 'completed' })).toMatchObject({ ended: true, status: 'completed' });
    await ageRows(target, { table: 'sessions', column: 'titled_at', byMs: TITLING_REFRESH_MIN_INTERVAL_MS + HOUR, match: { project_id: target.projectId, session_id: id } });
    for (let i = 0; i < TITLING_REFRESH_MIN_PROMPTS; i += 1) await event(target, id, 'prompt', { promptId: crypto.randomUUID(), text: `Step ${i} of the long job`, origin: 'user' });
    await publishedSession(target, id, TITLING_REFRESH_MIN_PROMPTS + 1);
    const rows = await untilPublished(target, runsOf, rows => rows.length === 2);
    const refresh = rows.find(row => row.id !== first.id)!;
    expect(refresh).toMatchObject({ status: 'queued', startedBy: 'backfill' });
    const second = await takeRun(target, refresh.id);
    expect(await runTool(target, second, 'myco_run_sessions', { op: 'title', title: 'Long job completed', summary: 'Covered the work since its first title.' })).toMatchObject({ written: true });
    await report(target, second, 'summary', 'Refreshed the title.');
    expect(await finishRun(target, second, { status: 'completed' })).toMatchObject({ ended: true, status: 'completed' });
    await wake(target);
    expect(await runsOf()).toHaveLength(2);
    expect((await sessionDetail(target, id)).body.session).toMatchObject({ endedAt: null, title: 'Long job completed' });
  },
};
