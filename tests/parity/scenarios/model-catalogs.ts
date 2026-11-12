import { expect } from 'bun:test';
import { MODEL_CATALOG_FRESH_MS } from '@goondocks/myco-shared/execution-profile';
import { ageRows, lit, memberHeadersFor, waitFor, type ParityScenario } from '../harness.ts';
import { browser, deviceMachine } from '../clients/identity.ts';

/**
 * The models a machine lists, kept the same on both targets: a report is kept with only the models the agent's
 * settings accept and the resolutions it lists, the machine's next report of the same agent replaces it, Settings
 * answers it to an admin, and the lease sweep forgets a list no machine renewed within the freshness window.
 */
export const modelCatalogs: ParityScenario = {
  name: 'model lists: a machine\'s list is kept, replaced, answered to Settings and forgotten once stale',
  async run(target) {
    const now = Date.now();
    const alias = 'openrouter/~anthropic/claude-opus-latest';
    let observedOrder = 0;
    const report = async (models: unknown[], fetchedAt: number, headers = target.memberHeaders(), harness = 'opencode') => {
      const response = await fetch(`${target.url}/worker/models`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ catalog: { observedOrder: ++observedOrder, harness, source: { kind: 'command', command: `${harness} models` }, signIn: 'worker-login', fetchedAt, models } }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };

    expect(await report([
      { id: alias, label: alias, provider: 'openrouter', resolvesTo: 'openrouter/anthropic/claude-opus-5.5' },
      { id: 'openai/gpt-6', label: 'GPT-6', provider: 'openai', upgrade: 'openai/gpt-6.1' },
      { id: 'no provider', label: 'refused by the pattern' },
    ], now - 2_000)).toEqual({ status: 200, body: { persisted: true, recorded: true, models: 2 } });
    expect(await report([{ id: alias, label: alias, provider: 'openrouter' }], now - 1_000)).toEqual({ status: 200, body: { persisted: true, recorded: true, models: 1 } });

    const answered = async () => {
      const settings = await browser(target, '/api/settings', target.ownerHeaders());
      expect(settings.status).toBe(200);
      return settings.body.models as Array<Record<string, unknown>>;
    };
    expect((await answered()).filter((catalog) => catalog.harness === 'opencode')).toEqual([{
      harness: 'opencode', source: { kind: 'command', command: 'opencode models' }, signIn: 'worker-login', fetchedAt: now - 1_000, receivedAt: expect.any(Number), observedOrder: expect.any(Number),
      models: [{ id: alias, label: alias, provider: 'openrouter' }],
    }]);
    // A machine since decommissioned listed its models once, and has not renewed them within the freshness window.
    const gone = await deviceMachine(target, target.ownerHeaders());
    expect(await report([{ id: 'gpt-5.5', label: 'GPT-5.5' }], now, memberHeadersFor(gone.token, target.projectId), 'codex')).toEqual({ status: 200, body: { persisted: true, recorded: true, models: 1 } });
    await ageRows(target, { table: 'worker_model_catalogs', column: 'received_at', byMs: MODEL_CATALOG_FRESH_MS + 60_000, match: { machine_id: gone.machineId } });
    expect((await answered()).map((catalog) => catalog.harness)).toEqual(['opencode']);
    // The lease sweep deletes the stale list itself, which no read shows once the list is past its window.
    const left = async () => (await target.sql(`SELECT machine_id FROM worker_model_catalogs WHERE machine_id = ${lit(gone.machineId)}`)).length;
    expect(await left()).toBe(1);
    await target.clockWake();
    expect(await waitFor(left, (count) => count === 0)).toBe(0);
    expect((await answered()).map((catalog) => catalog.harness)).toEqual(['opencode']);
    expect((await browser(target, `/api/machines/${gone.machineId}/stop`, target.ownerHeaders(), {})).status).toBe(200);
  },
};
