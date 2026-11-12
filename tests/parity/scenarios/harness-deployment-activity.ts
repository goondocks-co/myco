import { expect } from 'bun:test';
import { HARNESS_SILENT_MS } from '@goondocks/myco-shared/harness-health';
import { ageRows, expectPersisted, memberHeadersFor, type ParityScenario } from '../harness.ts';
import { browser, deviceMachine } from '../clients/identity.ts';

export const harnessDeploymentActivity: ParityScenario = {
  name: 'harness deployment activity: scoped silence, legacy exclusion and replacement',
  async run(target) {
    const now = Date.now();
    const sessionId = crypto.randomUUID();
    // A machine of the parity member, signed in through the device flow, captures a Codex session.
    const mine = await deviceMachine(target, target.ownerHeaders());
    const headers = memberHeadersFor(mine.token, target.projectId);
    const capture = (kind: string, payload: Record<string, unknown>, session = sessionId) => fetch(`${target.url}/events`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind, channel: 'cli', createdAt: Date.now(),
        producer: { adapter: 'parity', version: '1' }, payload }),
    });
    await expectPersisted(await capture('session.start', { agent: 'codex', startedAt: now }), 'session.start');
    // The session has been silent for twice the harness's silence bound.
    await ageRows(target, { table: 'sessions', column: 'last_live_received_at', byMs: 2 * HARNESS_SILENT_MS, match: { project_id: target.projectId, session_id: sessionId } });
    const report = async (scope: boolean, active: boolean) => {
      const response = await fetch(`${target.url}/members/harnesses/report`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ harnesses: [{ id: 'codex', provisioned: true, state: 'ready', ...(scope ? { activityScope: 'deployment' } : {}), ...(active ? { ranAt: now } : {}) }] }),
      });
      expect(response.status).toBe(200); await response.arrayBuffer();
      const health = await fetch(`${target.url}/api/attention`, { headers: target.ownerHeaders() });
      expect(health.status).toBe(200);
      const body = await health.json() as { items: Array<{ kind: string; harness?: string }> };
      return body.items.filter(item => item.kind === 'harness_capture_silent' && item.harness === 'codex');
    };
    expect(await report(false, true)).toEqual([]);
    expect(await report(true, true)).toHaveLength(1);
    expect(await report(true, false)).toEqual([]);
    const repairs = async () => {
      const response = await fetch(`${target.url}/api/attention`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      const body = await response.json() as { items: Array<{ kind: string; harness?: string }> };
      return body.items.filter(item => item.kind === 'harness_needs_repair' && item.harness === 'codex');
    };
    const trust = async (marker: number) => {
      const response = await fetch(`${target.url}/members/harnesses/report`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ harnesses: [{ id: 'codex', provisioned: true, state: 'trust_required', activityScope: 'deployment', action: 'Approve capture.', hookRepairAt: marker, ranAt: Date.now() }] }),
      });
      expect(response.status).toBe(200); await response.arrayBuffer();
    };
    const marker = Date.now();
    await trust(marker); expect(await repairs()).toHaveLength(1);
    // The harness starts a session after the repair was asked for, which settles it.
    await Bun.sleep(5);
    await expectPersisted(await capture('session.start', { agent: 'codex', startedAt: Date.now() }, crypto.randomUUID()), 'session.start after the repair');
    expect(await repairs()).toEqual([]);
    await trust(marker); expect(await repairs()).toEqual([]);
    await trust(marker + 1); expect(await repairs()).toHaveLength(1);
    expect((await browser(target, `/api/machines/${mine.machineId}/stop`, target.ownerHeaders(), {})).status).toBe(200);
  },
};
