import { expect } from 'bun:test';
import { lit, MEMBER_ID, type ParityScenario } from '../harness.ts';

/**
 * Deployment Settings read over a member credential on both targets: the same
 * leaves the dashboard's owner route answers, a stored value included, a body
 * that is not the empty object refused by name, and a stored provider
 * credential never in the answer.
 */
export const memberSettings: ParityScenario = {
  name: 'member settings: a member credential reads the Deployment leaves the dashboard reads, and never a stored credential',
  async run(target) {
    const now = Date.now();
    const secret = 'parity-provider-credential-that-must-not-cross';
    await target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.limits.concurrent_runs', ${lit(JSON.stringify(2))}, ${now}, ${lit(MEMBER_ID)})`);
    const stored = await fetch(`${target.url}/api/secrets/anthropic`, {
      method: 'PUT', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify({ value: secret }),
    });
    expect(stored.status).toBe(200);

    const read = (body: string) => fetch(`${target.url}/members/settings`, { method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' }, body });
    const res = await read('{}');
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(secret);
    const member = JSON.parse(text) as { persisted: boolean; leaves: Array<{ leaf: string; configured: boolean; value: unknown }> };
    expect(member.persisted).toBe(true);
    expect(member.leaves.find((l) => l.leaf === 'agent.limits.concurrent_runs')).toMatchObject({ configured: true, value: 2 });

    const owner = await fetch(`${target.url}/api/settings`, { headers: { ...target.ownerHeaders(), origin: target.url } });
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as { leaves: unknown[] }).leaves).toEqual(member.leaves);

    expect((await (await read(JSON.stringify({ leaf: 'x' }))).json()) as Record<string, unknown>).toEqual({ persisted: false, code: 'unknown_field', reason: 'unknown field leaf' });

    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.limits.concurrent_runs'`);
    await fetch(`${target.url}/api/secrets/anthropic`, { method: 'DELETE', headers: { ...target.ownerHeaders(), origin: target.url } });
  },
};
