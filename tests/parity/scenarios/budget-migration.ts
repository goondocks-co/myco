import { expect } from 'bun:test';
import { type ParityScenario } from '../harness.ts';

export const budgetMigrationParity: ParityScenario = {
  name: 'budget: populated schema upgrade keeps activation visible',
  dedicated: { latestSchemaUpgrade: true, sqliteVec: true, timeoutMs: 240_000 },
  async run(target) {
    const active = await fetch(`${target.url}/api/status`, { headers: target.ownerHeaders() });
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({ budget: { active: true, reason: null } });
  },
};
