import { expect } from 'bun:test';
import { MODEL_CATALOG_FRESH_MS } from '@goondocks/myco-shared/execution-profile';
import { lit, waitFor, type ParityScenario } from '../harness.ts';

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
    const report = async (models: unknown[], fetchedAt: number) => {
      const response = await fetch(`${target.url}/worker/models`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ catalog: { harness: 'opencode', source: { kind: 'command', command: 'opencode models' }, signIn: 'worker-login', fetchedAt, models } }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };

    expect(await report([
      { id: alias, label: alias, provider: 'openrouter', resolvesTo: 'openrouter/anthropic/claude-opus-5.5' },
      { id: 'openai/gpt-6', label: 'GPT-6', provider: 'openai', upgrade: 'openai/gpt-6.1' },
      { id: 'no provider', label: 'refused by the pattern' },
    ], now - 2_000)).toEqual({ status: 200, body: { persisted: true, recorded: true, models: 2 } });
    expect(await report([{ id: alias, label: alias, provider: 'openrouter' }], now - 1_000)).toEqual({ status: 200, body: { persisted: true, recorded: true, models: 1 } });

    const settings = await fetch(`${target.url}/api/settings`, { headers: { ...target.ownerHeaders(), origin: target.url } });
    expect(settings.status).toBe(200);
    const models = ((await settings.json()) as { models: Array<Record<string, unknown>> }).models.filter((catalog) => catalog.harness === 'opencode');
    expect(models).toEqual([{
      harness: 'opencode', source: { kind: 'command', command: 'opencode models' }, signIn: 'worker-login', fetchedAt: now - 1_000, receivedAt: expect.any(Number),
      models: [{ id: alias, label: alias, provider: 'openrouter' }],
    }]);
    expect(await target.sql(`SELECT resolutions FROM worker_model_catalogs WHERE harness = 'opencode'`)).toEqual([{ resolutions: '{}' }]);

    const gone = 'machine_parity_decommissioned';
    const stale = now - MODEL_CATALOG_FRESH_MS - 60_000;
    await target.sql(`INSERT INTO worker_model_catalogs (machine_id, harness, catalog, resolutions, fetched_at, received_at)
      VALUES (${lit(gone)}, 'codex', ${lit(JSON.stringify({ harness: 'codex', source: { kind: 'exchange', command: 'codex app-server' }, signIn: 'worker-login', fetchedAt: stale, models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }] }))}, '{}', ${stale}, ${stale})`);
    const left = async () => (await target.sql(`SELECT machine_id FROM worker_model_catalogs WHERE machine_id = ${lit(gone)}`)).length;
    expect(await left()).toBe(1);
    const answered = await (await fetch(`${target.url}/api/settings`, { headers: { ...target.ownerHeaders(), origin: target.url } })).json() as { models: Array<{ harness: string }> };
    expect(answered.models.map((catalog) => catalog.harness)).toEqual(['opencode']);
    await target.clockWake();
    expect(await waitFor(left, (count) => count === 0)).toBe(0);
    expect((await target.sql(`SELECT COUNT(*) AS n FROM worker_model_catalogs WHERE harness = 'opencode'`))[0]?.n).toBe(1);
  },
};
