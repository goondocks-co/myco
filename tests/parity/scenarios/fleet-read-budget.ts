import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { client, credentials, registerRunner } from '../clients/identity.ts';
import { credentialHistory } from '../fleet-budget/client.ts';
import { allowWorkerClaims, putSetting } from '../clients/requests.ts';
import { dispatch } from '../clients/runs.ts';

export const fleetReadBudget: ParityScenario = {
  name: 'runner fleet: D1 rows read stay bounded as member credentials accumulate',
  only: 'cloudflare',
  dedicated: { cloudflare: { main: '../../tests/parity/fleet-budget/worker-entry.ts' }, timeoutMs: 240_000 },
  async run(target) {
    await allowWorkerClaims(target);
    expect((await putSetting(target, 'agent.scheduled_tasks_enabled', false)).status).toBe(200);
    const runner = await registerRunner(target, target.ownerHeaders(), 'fleet-runner');
    expect((await client(target, '/runners/contact', { machineId: 'fleet-runner' }, runner.token)).body).toMatchObject({ persisted: true });
    await dispatch(target, 'title-summary');
    const measure = async () => {
      const response = await fetch(`${target.url}/api/runners`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      const rowsRead = Number(response.headers.get('x-parity-rows-read'));
      expect(rowsRead).toBeGreaterThan(0);
      return { rowsRead, body: await response.json() as any };
    };
    const grow = await credentialHistory(target);
    await grow(4);
    const before = await credentials(target);
    const small = await measure();
    await grow(36);
    expect((await credentials(target)).length).toBeGreaterThan(before.length);
    const large = await measure();
    expect(large.body.runners.length).toBe(small.body.runners.length);
    expect(large.body.runners.length).toBeGreaterThan(0);
    expect(large.body.queue.count).toBe(1);
    expect(large.rowsRead).toBe(small.rowsRead);
    console.info(`fleet D1 rows_read: small ${small.rowsRead}; large ${large.rowsRead}`);
  },
};
