import { expect } from 'bun:test';
import { expectPersisted, type ParityScenario } from '../harness.ts';
import { allowWorkerClaims, event, owner, putSetting, runTool, sessionDetail, untilPublished, wake } from '../clients/requests.ts';
import { finishRun, publishedSession, report, runList, takeRun } from '../clients/runs.ts';
import { revisionHeaders } from '../settings-revision.ts';

/** Imported history is titled only after the operator enables its backfill. */
export const titlingBackfill: ParityScenario = {
  name: 'titling backfill: imported sessions wait for the operator, queue once after publication, and remain queued when stopped',
  dedicated: { timeoutMs: 240_000 },
  async run(target) {
    await allowWorkerClaims(target);
    expect((await putSetting(target, 'agent.scheduled_tasks_enabled', true)).status).toBe(200);
    const stamp = Date.now(), session = 'backfill-imported';
    const bytes = new TextEncoder().encode(`${JSON.stringify({ type: 'user', promptId: crypto.randomUUID(), message: { content: 'Wire the imported-session backfill' }, timestamp: new Date(stamp - 60_000).toISOString() })}\n`);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    await expectPersisted(await fetch(`${target.url}/blobs/${digest}`, { method: 'POST', headers: target.memberHeaders({ 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }), body: bytes }), 'blob');
    const post = (kind: string, payload: Record<string, unknown>) => event(target, session, kind, payload, stamp, target.projectId, { channel: 'import', producer: { adapter: 'claude-code', version: '1' } });
    await post('session.start', { agent: 'claude-code', startedAt: stamp - 120_000 });
    await post('transcript.segment', { transcriptId: `tx_${'c'.repeat(32)}`, baseOffset: 0, length: bytes.byteLength, blob: digest, agent: 'claude-code', headHash: 'c'.repeat(64) });
    await post('session.end', { endedAt: stamp - 60_000 });
    expect((await sessionDetail(target, session)).body.session).toMatchObject({ title: null, titledAt: null });
    expect((await owner(target, '/api/titling-backfill')).body).toMatchObject({ scheduledTasksEnabled: true, backfillEnabled: false, enabled: false });
    await publishedSession(target, session);
    const runsOf = async () => (await runList(target, 'task=title-summary')).filter(row => row.targetSessionId === session);
    expect(await runsOf()).toEqual([]);
    expect((await owner(target, '/api/titling-backfill')).body.remaining).toBeGreaterThanOrEqual(1);
    const toggle = async (enabled: boolean) => {
      const answer = await owner(target, '/api/titling-backfill', { method: 'PUT', headers: await revisionHeaders(target, '/api/titling-backfill'), body: JSON.stringify({ enabled }) });
      expect(answer.status).toBe(200); expect(answer.body).toMatchObject({ enabled, backfillEnabled: enabled });
    };
    await toggle(true);
    const [queued] = await untilPublished(target, runsOf, rows => rows.length > 0);
    expect(queued).toMatchObject({ status: 'queued', startedBy: 'backfill', targetSessionId: session });
    expect((await sessionDetail(target, session)).body.session).toMatchObject({ title: null, titledAt: expect.any(Number) });
    expect((await owner(target, '/api/titling-backfill')).body).toMatchObject({ enabled: true, inFlight: 1, usedToday: 1 });
    await toggle(false);
    await wake(target);
    expect((await runsOf()).map(row => row.id)).toEqual([queued.id]);
    const run = await takeRun(target, queued.id);
    expect(await runTool(target, run, 'myco_run_sessions', { op: 'material' })).toMatchObject({ session_id: session });
    expect(await runTool(target, run, 'myco_run_sessions', { op: 'title', title: 'Imported backfill wired', summary: 'Enabled titling for imported history.' })).toMatchObject({ written: true });
    await report(target, run, 'summary', 'Titled the imported session.');
    expect(await finishRun(target, run, { status: 'completed' })).toMatchObject({ ended: true, status: 'completed' });
  },
};
