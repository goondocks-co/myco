import { expect } from 'bun:test';
import { lit, waitFor, type ParityScenario } from '../harness.ts';

/**
 * The models a worker lists, kept the same on both targets: a report is kept with only the models the agent's settings
 * accept, the next report of the same agent replaces it, Settings answers it without naming the machine, and the lease
 * sweep forgets a list whose worker is forgotten.
 */
export const modelCatalogs: ParityScenario = {
  name: 'model lists: a worker\'s list is kept, replaced, answered to Settings and forgotten with its worker',
  async run(target) {
    const now = Date.now();
    const alias = 'openrouter/~anthropic/claude-opus-latest';
    const report = async (models: unknown[], fetchedAt: number) => {
      const response = await fetch(`${target.url}/worker/models`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ catalog: { harness: 'opencode', source: { kind: 'command', command: 'opencode models' }, fetchedAt, models } }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };

    // A worker claims before it reports, which records its contact; a list is kept as long as that contact is.
    const claimed = await fetch(`${target.url}/worker/claim`, {
      method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ harnesses: [] }),
    });
    expect(claimed.status).toBe(200);
    expect(await report([
      { id: alias, label: alias, provider: 'openrouter' },
      { id: 'openai/gpt-6', label: 'GPT-6', provider: 'openai', upgrade: 'openai/gpt-6.1' },
      { id: 'no provider', label: 'refused by the pattern' },
    ], now - 2_000)).toEqual({ status: 200, body: { persisted: true, recorded: true, models: 2 } });
    expect(await report([{ id: alias, label: alias, provider: 'openrouter' }], now - 1_000)).toEqual({ status: 200, body: { persisted: true, recorded: true, models: 1 } });

    const settings = await fetch(`${target.url}/api/settings`, { headers: { ...target.ownerHeaders(), origin: target.url } });
    expect(settings.status).toBe(200);
    const models = ((await settings.json()) as { models: Array<Record<string, unknown>> }).models.filter((catalog) => catalog.harness === 'opencode');
    expect(models).toEqual([{
      harness: 'opencode', source: { kind: 'command', command: 'opencode models' }, fetchedAt: now - 1_000, receivedAt: expect.any(Number),
      models: [{ id: alias, label: alias, provider: 'openrouter' }],
    }]);
    expect(Object.keys(models[0]!)).not.toContain('machineId');

    const gone = 'mt_parity_forgotten_worker';
    await target.sql(`INSERT INTO worker_model_catalogs (credential_id, harness, machine_id, catalog, fetched_at, received_at)
      VALUES (${lit(gone)}, 'codex', NULL, ${lit(JSON.stringify({ harness: 'codex', source: { kind: 'exchange', command: 'codex app-server' }, fetchedAt: now, models: [] }))}, ${now}, ${now})`);
    const left = async () => (await target.sql(`SELECT credential_id FROM worker_model_catalogs WHERE credential_id = ${lit(gone)}`)).length;
    expect(await left()).toBe(1);
    await target.clockWake();
    expect(await waitFor(left, (count) => count === 0)).toBe(0);
    expect((await target.sql(`SELECT COUNT(*) AS n FROM worker_model_catalogs WHERE harness = 'opencode'`))[0]?.n).toBe(1);
  },
};
