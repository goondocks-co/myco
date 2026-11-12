import { expect } from 'bun:test';
import { type ParityScenario } from '../harness.ts';
import { owner, putSetting, resetSetting } from '../clients/requests.ts';

/**
 * Deployment Settings read over a member credential on both targets: the leaf
 * the member and the dashboard both read, a body that is not the empty object
 * refused by name, a stored provider credential never in the answer, and no
 * Project created for whatever Project the request names.
 */
export const memberSettings: ParityScenario = {
  name: 'member settings: a member credential reads the Deployment leaves the dashboard reads, and never a stored credential',
  async run(target) {
    const secret = 'parity-provider-credential-that-must-not-cross';
    expect((await putSetting(target, 'agent.limits.concurrent_runs', 2)).status).toBe(200);
    try {
    const stored = await fetch(`${target.url}/api/secrets/anthropic`, {
      method: 'PUT', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify({ value: secret }),
    });
    expect(stored.status).toBe(200);

    const unseen = 'proj_parity_settings_unseen';
    const read = (body: string) => fetch(`${target.url}/members/settings`, { method: 'POST', headers: { ...target.memberHeaders({ 'x-myco-project': unseen }), 'content-type': 'application/json' }, body });
    const res = await read('{}');
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(secret);
    const member = JSON.parse(text) as { persisted: boolean; leaves: Array<{ leaf: string; configured: boolean; value: unknown }> };
    expect(member.persisted).toBe(true);
    expect(member.leaves.some((row) => row.leaf.startsWith('agent.provider.'))).toBe(false);
    expect(member.leaves.find((l) => l.leaf === 'agent.limits.concurrent_runs')).toMatchObject({ configured: true, value: 2 });
    const projects = await owner<{ projects: Array<{ projectId: string }> }>(target, '/api/projects?include=archived');
    expect(projects.status).toBe(200);
    expect(projects.body.projects.some((row) => row.projectId === unseen)).toBe(false);

    const dashboard = await owner<{ leaves: Array<{ leaf: string; value: unknown }> }>(target, '/api/settings');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.leaves.find((l) => l.leaf === 'agent.limits.concurrent_runs')?.value).toBe(2);

    expect((await (await read(JSON.stringify({ leaf: 'x' }))).json()) as Record<string, unknown>).toEqual({ persisted: false, code: 'unknown_field', reason: 'unknown field leaf' });

    } finally {
      expect((await resetSetting(target, 'agent.limits.concurrent_runs')).status).toBe(200);
      await fetch(`${target.url}/api/secrets/anthropic`, { method: 'DELETE', headers: { ...target.ownerHeaders(), origin: target.url } });
    }
  },
};
