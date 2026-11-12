import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { joinMachine } from '../historical-storage/clients.ts';
import { registerRunner } from '../fleet-budget/client.ts';
import { allowWorkerClaims, putSetting } from '../clients/requests.ts';
import { dispatch } from '../clients/runs.ts';

export const fleetReadBudget: ParityScenario = {
  name: 'runner fleet: D1 rows read stay bounded as member credentials accumulate',
  only: 'cloudflare',
  dedicated: { cloudflare: { main: '../../tests/parity/fleet-budget/worker-entry.ts' }, timeoutMs: 240_000 },
  async run(target) {
    await allowWorkerClaims(target);
    expect((await putSetting(target, 'agent.scheduled_tasks_enabled', false)).status).toBe(200);
    await registerRunner(target);
    await dispatch(target, 'title-summary');
    const measure = async () => {
      const response = await fetch(`${target.url}/api/status`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      const rowsRead = Number(response.headers.get('x-parity-rows-read'));
      expect(rowsRead).toBeGreaterThan(0);
      return { rowsRead, body: await response.json() as any };
    };
    for (let i = 0; i < 4; i++) await joinMachine(target);
    const small = await measure();
    for (let i = 0; i < 36; i++) await joinMachine(target);
    const large = await measure();
    expect(large.body.workers.fleet.length).toBe(small.body.workers.fleet.length);
    expect(large.body.workers.fleet.length).toBeGreaterThan(0);
    expect(large.body.workers.runsQueued).toBe(1);
    expect(large.rowsRead).toBe(small.rowsRead);
    console.info(`fleet D1 rows_read: small ${small.rowsRead}; large ${large.rowsRead}`);
  },
};
