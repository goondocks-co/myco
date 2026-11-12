import { expect } from 'bun:test';
import { SESSION_END_SETTLE_MS } from '@myco-server-worker/constants.js';
import { ageRows, type ParityScenario } from '../harness.ts';
import { allowWorkerClaims, owner, putCapability, untilPublished } from '../clients/requests.ts';
import { captureSession, dispatch, failRun, repository, runDetail, runList, takeRun } from '../clients/runs.ts';

/** Manual work bypasses automatic heads held by the daily budget. */
export const budgetGovernor: ParityScenario = {
  name: 'budget: a manual first poll bypasses held heads and its priced spend survives worker end',
  dedicated: { timeoutMs: 180_000 },
  async run(target) {
    await allowWorkerClaims(target);
    expect((await putCapability(target, 'vault_evolution', true)).status).toBe(200);
    await repository(target);
    const history = await takeRun(target, (await dispatch(target, 'vault-seed')).runId);
    expect(await failRun(target, history, { usage: { inputTokens: null, outputTokens: null, costUsd: 1 } })).toMatchObject({ ended: true });
    for (let i = 0; i < 25; i += 1) {
      const session = `budget-held-${i}`;
      await captureSession(target, session, 'Title the held session', { ended: true });
      await ageRows(target, { table: 'sessions', column: 'last_received_at', byMs: 2 * SESSION_END_SETTLE_MS, match: { project_id: target.projectId, session_id: session } });
    }
    const held = await untilPublished(target, () => runList(target, 'status=queued&task=title-summary'), rows => rows.length === 25);
    const oldestHeldId = [...held].sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id))[0].id;
    const manual = await takeRun(target, (await dispatch(target, 'vault-seed')).runId);
    expect((await runDetail(target, oldestHeldId)).run).toMatchObject({ status: 'queued', heldBy: 'budget' });
    expect(await failRun(target, manual, { usage: { inputTokens: null, outputTokens: null, costUsd: 0.30 } })).toMatchObject({ ended: true });
    expect((await runDetail(target, manual.id)).run).toMatchObject({ actualCostUsd: 0.30, costSource: 'actual' });
    const status = await owner(target, '/api/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ budget: { active: true, dailyUsd: 1, manualUsd: 1.30, automaticUsd: 0,
      heldHeads: [expect.objectContaining({ projectId: target.projectId, runId: oldestHeldId, reason: 'budget', requiredUsd: expect.any(Number), quotedAt: expect.any(Number) })] } });
    const fleet = await owner(target, '/api/runners');
    expect(fleet.status).toBe(200);
    expect(fleet.body).toMatchObject({ queue: { count: 25, oldestAt: Math.min(...held.map(row => row.queuedAt)) } });
    const preview = await owner(target, `/api/tasks/start?project=${target.projectId}&task=vault-seed`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ task: 'vault-seed', projectId: target.projectId, live: false });
  },
};
