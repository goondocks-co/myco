import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { event, owner, untilPublished } from '../clients/requests.ts';
import { telemetryTrace } from '../../myco-server/helpers/telemetry.ts';

/** The same administrator and OTLP contracts through both real front doors. */
export const otlpReceiver: ParityScenario = {
  name: 'OpenTelemetry: ingest-only key, immutable retry, standard lineage, revocation',
  async run(target) {
    const lead = `otel-lead-${Date.now()}`, child = `otel-worker-${Date.now()}`;
    await event(target, lead, 'session.start', { agent: 'codex', startedAt: Date.now() });
    await event(target, child, 'session.start', { agent: 'codex', startedAt: Date.now() });
    const issued = await owner<{ id: string; key: string }>(target, '/api/telemetry/keys', { method: 'POST', body: JSON.stringify({ label: 'parity sender' }) });
    expect(issued.status).toBe(201);
    const { key, id } = issued.body;
    const post = (body: unknown, signal = 'traces', bearer = key) => fetch(`${target.url}/v1/${signal}`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await post({}, 'traces', 'wrong-key')).status).toBe(401);
    expect((await post({ resourceSpans: false })).status).toBe(400);
    const payload = telemetryTrace(lead, child, Date.now());
    for (let retry = 0; retry < 2; retry++) {
      const response = await post(payload);
      expect(response.status).toBe(200); expect(await response.json()).toEqual({});
    }
    expect((await post({ resourceLogs: [] }, 'logs')).status).toBe(200);
    expect((await post({ resourceMetrics: [] }, 'metrics')).status).toBe(200);
    const path = `/api/projects/${target.projectId}/sessions/${child}/lineage`;
    const lineage = await untilPublished(target, async () => (await owner<{ edges: { source?: string; parentId: string; childId: string; serviceName?: string }[] }>(target, path)).body,
      family => family.edges.some(edge => edge.source === 'telemetry'));
    expect(lineage.edges).toContainEqual(expect.objectContaining({ parentId: lead, childId: child, source: 'telemetry', serviceName: 'dispatch-service' }));
    const invocations = await owner<{ rows: { agentName: string; matchedBy: string }[] }>(target, `/api/projects/${target.projectId}/sessions/${child}/invocations`);
    expect(invocations.body.rows).toEqual([expect.objectContaining({ agentName: 'worker', matchedBy: 'exact' })]);
    const listed = await owner<{ keys: { id: string; accepted: number; lastUsedAt: number | null }[] }>(target, '/api/telemetry/keys');
    expect(listed.body.keys.find(row => row.id === id)).toMatchObject({ accepted: 3, lastUsedAt: expect.any(Number) });
    expect((await fetch(`${target.url}/api/projects`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
    expect((await owner(target, `/api/telemetry/keys/${id}/revoke`, { method: 'POST', body: '{}' })).body).toEqual({ revoked: true });
    expect((await post(payload)).status).toBe(401);
    expect((await owner<{ edges: unknown[] }>(target, path)).body.edges).toEqual([]);
  },
};
