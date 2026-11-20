import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { event, owner, untilPublished } from '../clients/requests.ts';
import { seedTelemetry } from '../upgrade-seed/telemetry.ts';

/** The same administrator and OTLP contracts through both real front doors. */
export const otlpReceiver: ParityScenario = {
  name: 'OpenTelemetry: ingest-only key, immutable retry, standard lineage, revocation',
  async run(target) {
    const lead = `otel-lead-${Date.now()}`,
      child = `otel-worker-${Date.now()}`;
    await event(target, lead, 'session.start', { agent: 'codex', startedAt: Date.now() });
    await event(target, child, 'session.start', { agent: 'codex', startedAt: Date.now() });
    const promptId = crypto.randomUUID();
    await event(target, child, 'prompt', { promptId, text: 'A program-invoked turn', origin: 'user' });
    const turnPath = `/api/projects/${target.projectId}/sessions/${child}/turns`;
    const turnListPath = `${turnPath}?origins=user,agent_dispatch`;
    const before = await untilPublished(
      target,
      async () =>
        (await owner<{ rows: { promptId: string; createdAt: number; origin: string }[] }>(target, turnListPath))
          .body,
      (page) => page.rows.some((row) => row.promptId === promptId),
    );
    const head = before.rows.find((row) => row.promptId === promptId)!;
    const { key, id, post } = await seedTelemetry(target, { lead, child, at: head.createdAt });
    expect((await post({}, 'traces', 'wrong-key')).status).toBe(401);
    expect((await post({ resourceSpans: false })).status).toBe(400);
    expect((await post({ resourceLogs: [] }, 'logs')).status).toBe(200);
    expect((await post({ resourceMetrics: [] }, 'metrics')).status).toBe(200);
    const path = `/api/projects/${target.projectId}/sessions/${child}/lineage`;
    const turns = await owner<{
      rows: { promptId: string; origin: string }[];
    }>(target, turnListPath);
    expect(turns.body.rows.find((row) => row.promptId === promptId)).toMatchObject({
      origin: 'user',
    });
    const detail = await owner<{ prompt: { origin: string } }>(
      target,
      `${turnPath}/${promptId}`,
    );
    expect(detail.body.prompt).toMatchObject({
      origin: 'user',
    });
    const listed = await owner<{ keys: { id: string; accepted: number; lastUsedAt: number | null }[] }>(
      target,
      '/api/telemetry/keys',
    );
    expect(listed.body.keys.find((row) => row.id === id)).toMatchObject({
      accepted: 3,
      lastUsedAt: expect.any(Number),
    });
    expect(
      (await fetch(`${target.url}/api/projects`, { headers: { authorization: `Bearer ${key}` } })).status,
    ).toBe(401);
    expect(
      (await owner(target, `/api/telemetry/keys/${id}/revoke`, { method: 'POST', body: '{}' })).body,
    ).toEqual({ revoked: true });
    expect((await post({})).status).toBe(401);
    expect((await owner<{ edges: unknown[] }>(target, path)).body.edges).toEqual([]);
    expect((await owner<{ rows: { origin: string }[] }>(target, turnListPath)).body.rows[0]!.origin).toBe('user');
    const launched = `otel-launched-${Date.now()}`;
    await event(target, launched, 'session.start', { agent: 'windsurf', launchParentSessionId: lead });
    const opening = crypto.randomUUID(), followup = crypto.randomUUID(), openedAt = Date.now();
    await event(target, launched, 'prompt', { promptId: opening, text: 'Read the task', origin: 'user' }, openedAt);
    await event(target, launched, 'prompt', { promptId: followup, text: 'A person follows up', origin: 'user' }, openedAt + 1);
    const launchedPath = `/api/projects/${target.projectId}/sessions/${launched}`;
    const opened = await untilPublished(target,
      async () => (await owner<{ rows: { promptId: string; origin: string }[] }>(target, `${launchedPath}/turns?origins=user,agent_dispatch`)).body,
      page => page.rows.some(row => row.promptId === followup));
    expect(opened.rows.map(row => row.origin)).toEqual(['agent_dispatch', 'user']);
    expect((await owner(target, `${launchedPath}/turns/${opening}`)).body).toMatchObject({ prompt: { origin: 'agent_dispatch' } });
    expect((await owner(target, launchedPath)).body).toMatchObject({ personTurns: 1, turns: 2 });
  },
};
