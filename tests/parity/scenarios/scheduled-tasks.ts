import { expect } from 'bun:test';
import { lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * The clock on both targets: with scheduling on, a wake dispatches the harness
 * probe for a Project with a recent receipt, a second wake inside the interval
 * dispatches nothing, a ceiling met leaves a skipped row by name, and a cold
 * Project gets nothing. The recording launch stands in for the runtime.
 */
export const scheduledTasks: ParityScenario = {
  name: 'the clock: the daily probe dispatched once, held by its interval, capped by its ceiling, withheld from a cold Project',
  async run(target: ParityTarget) {
    const now = Date.now();
    const leaf = (name: string, value: unknown) => target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (${lit(name)}, ${lit(JSON.stringify(value))}, ${now}, ${lit(MEMBER_ID)})`);
    for (const [name, value] of [
      ['agent.provider.type', 'openai-compatible'],
      ['agent.provider.model', 'parity-model'],
      ['agent.provider.base_url', 'http://models.internal/v1'],
      ['agent.scheduled_tasks_enabled', true],
    ] as const) await leaf(name, value);
    await target.sql(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (${lit(target.projectId)}, 'cortex', 1, ${now}, ${lit(MEMBER_ID)})`);
    // Nothing earlier holds a place, and no earlier probe run sets the interval.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE status IN ('pending', 'running', 'queued')`);
    await target.sql(`DELETE FROM agent_runs WHERE task = 'container-smoke'`);
    // A cold Project beside the live one: a receipt three weeks old.
    await target.sql(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_cold', 'cold', ${now - 30 * 86_400_000})`);
    await target.sql(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_cold', 'cortex', 1, ${now}, ${lit(MEMBER_ID)})`);
    const [credential] = await target.sql(`SELECT id FROM member_credentials ORDER BY issued_at LIMIT 1`) as Array<{ id: string }>;
    await target.sql(`INSERT OR REPLACE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent)
      VALUES ('proj_cold', 'cold-session', 'machine_parity', ${lit(credential!.id)}, ${now - 21 * 86_400_000}, ${now - 21 * 86_400_000}, 'claude-code')`);

    const wake = async () => {
      const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
      return (await res.json()) as { state: string; scheduled: { dispatched: number; skipped: number } };
    };
    const probes = (projectId: string) => target.sql(`SELECT status, harness, run_context AS runContext FROM agent_runs WHERE project_id = ${lit(projectId)} AND task = 'container-smoke' ORDER BY COALESCE(queued_at, started_at), id`);

    // The live Project's receipts are minutes old: the Deployment is in use or idle, and the probe runs only while asleep.
    await leaf('agent.tasks', { 'container-smoke': { schedule: { runIn: ['active', 'idle', 'sleep'] } } });
    const first = await wake();
    expect(first.scheduled).toEqual({ dispatched: 1, skipped: 0 });
    expect(await probes(target.projectId)).toEqual([{ status: 'pending', harness: 'record', runContext: JSON.stringify({ timeoutSeconds: 300 }) }]);
    expect(await probes('proj_cold')).toEqual([]);

    // Inside the interval, and with the probe still live: nothing more.
    expect((await wake()).scheduled).toEqual({ dispatched: 0, skipped: 0 });
    expect(await probes(target.projectId)).toHaveLength(1);

    // The ceiling: one a day, the interval past — a skipped row names it.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE task = 'container-smoke'`);
    await leaf('agent.tasks', { 'container-smoke': { schedule: { runIn: ['active', 'idle', 'sleep'], intervalSeconds: 0, maxRunsPerDay: 1 } } });
    expect((await wake()).scheduled).toEqual({ dispatched: 0, skipped: 1 });
    expect(await probes(target.projectId)).toEqual([
      { status: 'completed', harness: 'record', runContext: JSON.stringify({ timeoutSeconds: 300 }) },
      { status: 'skipped', harness: null, runContext: JSON.stringify({ reason: 'max_runs_per_day' }) },
    ]);

    // Off again: the clock leaves both Projects alone.
    await leaf('agent.scheduled_tasks_enabled', false);
    expect((await wake()).scheduled).toEqual({ dispatched: 0, skipped: 0 });
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.tasks'`);
  },
};
