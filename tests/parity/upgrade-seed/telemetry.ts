import { expect } from 'bun:test';
import { event, owner, untilPublished, type RouteTarget } from '../clients/requests.ts';
import { telemetryBatch, telemetrySpan, telemetryTrace } from '../../myco-server/helpers/telemetry.ts';

/** A sender's exact child assertion, plus capture arriving after an export when requested. */
export async function seedTelemetry(target: RouteTarget, input: { lead: string; child: string; at: number; capture?: { launched: string; pending: string } }) {
  const issued = await owner<{ id: string; key: string }>(target, '/api/telemetry/keys', { method: 'POST', body: JSON.stringify({ label: 'parity sender' }) });
  expect(issued.status).toBe(201);
  const { key, id } = issued.body;
  const post = (body: unknown, signal = 'traces', bearer = key) => fetch(`${target.url}/v1/${signal}`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = telemetryTrace(input.lead, input.child, input.at);
  for (let retry = 0; retry < 2; retry++) {
    const response = await post(payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  }
  const base = `/api/projects/${target.projectId}/sessions`;
  const lineage = await untilPublished(target, async () => (await owner(target, `${base}/${input.child}/lineage`)).body,
    family => family.edges.some((edge: { source?: string }) => edge.source === 'telemetry'));
  expect(lineage.edges).toContainEqual(expect.objectContaining({ parentId: input.lead, childId: input.child, source: 'telemetry', keyLabel: 'parity sender', serviceName: 'dispatch-service' }));
  expect((await owner(target, `${base}/${input.child}/invocations`)).body.rows)
    .toEqual([expect.objectContaining({ agentName: 'worker', keyLabel: 'parity sender', matchedBy: 'exact' })]);
  if (input.capture !== undefined) {
    await event(target, input.capture.launched, 'session.start', { agent: 'windsurf', launchParentSessionId: input.lead }, input.at);
    expect((await owner(target, `${base}/${input.capture.launched}/lineage`)).body.edges)
      .toContainEqual(expect.objectContaining({ parentId: input.lead, childId: input.capture.launched, kind: 'launched' }));
    expect((await post(telemetryBatch([telemetrySpan(1, { trace: 2, conversation: input.capture.pending, at: input.at })]))).status).toBe(200);
    expect((await owner(target, '/api/wake', { method: 'POST', body: '{}' })).status).toBe(200);
    await event(target, input.capture.pending, 'session.start', { agent: 'codex', startedAt: input.at }, input.at);
  }
  return { key, id, post };
}
