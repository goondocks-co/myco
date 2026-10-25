import { expect } from 'bun:test';
import { HARNESS_SILENT_MS } from '@goondocks/myco-shared/harness-health';
import { expectPersisted, lit, MACHINE_ID, MEMBER_ID, type ParityScenario } from '../harness.ts';

export const harnessDeploymentActivity: ParityScenario = {
  name: 'harness deployment activity: scoped silence, legacy exclusion and replacement',
  async run(target) {
    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const capture = await fetch(`${target.url}/events`, {
      method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind: 'session.start', channel: 'cli', createdAt: now,
        producer: { adapter: 'parity', version: '1' }, payload: { agent: 'codex', startedAt: now } }),
    });
    await expectPersisted(capture, 'session.start');
    await target.sql(`INSERT OR IGNORE INTO machine_claims (machine_id, member_id, claimed_at) VALUES (${lit(MACHINE_ID)}, ${lit(MEMBER_ID)}, ${now})`);
    await target.sql(`UPDATE sessions SET agent = 'codex', last_live_received_at = ${now - 2 * HARNESS_SILENT_MS} WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(sessionId)}`);
    const report = async (scope: boolean, active: boolean) => {
      const response = await fetch(`${target.url}/members/harnesses/report`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
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
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ harnesses: [{ id: 'codex', provisioned: true, state: 'trust_required', activityScope: 'deployment', action: 'Approve capture.', hookRepairAt: marker, ranAt: Date.now() }] }),
      });
      expect(response.status).toBe(200); await response.arrayBuffer();
    };
    const marker = Date.now();
    await trust(marker); expect(await repairs()).toHaveLength(1);
    const rows = await target.sql(`SELECT harnesses FROM machine_harness_reports WHERE machine_id = ${lit(MACHINE_ID)}`);
    const since = (JSON.parse(String(rows[0].harnesses)) as Array<{ sinceAt: number }>)[0].sinceAt;
    await target.sql(`UPDATE sessions SET last_received_at = ${since + 1}, last_live_received_at = ${since + 1} WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(sessionId)}`);
    await target.sql(`UPDATE events SET received_at = ${since + 1}, created_at = ${since + 1} WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(sessionId)} AND kind = 'session.start'`);
    expect(await repairs()).toEqual([]);
    await trust(marker); expect(await repairs()).toEqual([]);
    await trust(marker + 1); expect(await repairs()).toHaveLength(1);

  },
};
