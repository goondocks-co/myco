import { expect } from 'bun:test';
import { lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * The clock on both targets: with scheduling on, a wake dispatches the harness
 * extraction for a Project with a recent receipt, a second wake inside the interval
 * dispatches nothing, a ceiling met leaves a skipped row by name, and a cold
 * Project gets nothing. The worker queue receives the run.
 */
export const scheduledTasks: ParityScenario = {
  name: 'the clock: extraction queued once, held by its interval, capped by its ceiling, withheld from a cold Project',
  async run(target: ParityTarget) {
    const now = Date.now();
    const leaf = (name: string, value: unknown) => target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (${lit(name)}, ${lit(JSON.stringify(value))}, ${now}, ${lit(MEMBER_ID)})`);
    await leaf('agent.scheduled_tasks_enabled', true);
    await target.sql(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (${lit(target.projectId)}, 'vault_evolution', 1, ${now}, ${lit(MEMBER_ID)})`);
    // Nothing earlier holds a place or sets the extraction interval.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE status IN ('pending', 'running', 'queued')`);
    await target.sql(`DELETE FROM agent_runs WHERE task = 'extract-curate'`);
    // A cold Project beside the live one: a receipt three weeks old.
    await target.sql(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_cold', 'cold', ${now - 30 * 86_400_000})`);
    await target.sql(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_cold', 'vault_evolution', 1, ${now}, ${lit(MEMBER_ID)})`);
    const [credential] = await target.sql(`SELECT id FROM member_credentials ORDER BY issued_at LIMIT 1`) as Array<{ id: string }>;
    await target.sql(`INSERT OR REPLACE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent)
      VALUES ('proj_cold', 'cold-session', 'machine_parity', ${lit(credential!.id)}, ${now - 21 * 86_400_000}, ${now - 21 * 86_400_000}, 'claude-code')`);
    // The live Project: a receipt a minute old, whatever ran before this scenario.
    await target.sql(`INSERT OR REPLACE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent)
      VALUES (${lit(target.projectId)}, 'clock-live-session', 'machine_parity', ${lit(credential!.id)}, ${now - 60_000}, ${now - 60_000}, 'claude-code')`);

    for (const [project, session, at] of [[target.projectId, 'clock-live-session', now - 60_000], ['proj_cold', 'cold-session', now - 21 * 86_400_000]] as const) {
      await target.sql(`UPDATE sessions SET ended_at = ${at} WHERE project_id = ${lit(project)} AND session_id = ${lit(session)}`);
      await target.sql(`INSERT INTO prompt_batches (project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at,processed)
        VALUES (${lit(project)},${lit(session)},'clock-prompt','clock-event','scheduled extraction material','user','clock-hash',${at},${at},${lit(credential!.id)},${at},0)`);
    }

    const wake = async () => {
      const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
      return (await res.json()) as { state: string; scheduled: { dispatched: number; skipped: number } };
    };
    const runs = (projectId: string) => target.sql(`SELECT status, harness, json_extract(run_context, '$.timeoutSeconds') AS timeoutSeconds, json_extract(run_context, '$.reason') AS reason FROM agent_runs WHERE project_id = ${lit(projectId)} AND task = 'extract-curate' ORDER BY COALESCE(queued_at, started_at), id`);

    await leaf('agent.tasks', { 'container-smoke': { schedule: { enabled: true, runIn: ['active', 'idle', 'sleep'] } }, 'extract-curate': { schedule: { enabled: false } } });
    expect((await wake()).scheduled).toEqual({ dispatched: 0, skipped: 0 });
    expect(await target.sql(`SELECT id FROM agent_runs WHERE task = 'container-smoke' AND status IN ('pending','running','queued')`)).toEqual([]);

    // Extraction is enabled at every awake state for this scenario.
    await leaf('agent.tasks', { 'container-smoke': { schedule: { enabled: true, runIn: ['active', 'idle', 'sleep'] } }, 'extract-curate': { schedule: { runIn: ['active', 'idle', 'sleep'], reservedRunsPerDay: { count: 0, preCondition: 'has-recent-live-prompts' } } } });
    const first = await wake();
    expect(first.scheduled).toEqual({ dispatched: 1, skipped: 0 });
    expect(await runs(target.projectId)).toEqual([{ status: 'queued', harness: null, timeoutSeconds: 900, reason: null }]);
    expect(await runs('proj_cold')).toEqual([]);

    // Inside the interval, and with extraction still live: nothing more.
    expect((await wake()).scheduled).toEqual({ dispatched: 0, skipped: 0 });
    expect(await runs(target.projectId)).toHaveLength(1);

    // The ceiling: one a day, the interval past — a skipped row names it.
    await target.sql(`UPDATE agent_runs SET status = 'completed', started_at = COALESCE(started_at, queued_at), completed_at = ${now} WHERE task = 'extract-curate'`);
    await leaf('agent.tasks', { 'extract-curate': { schedule: { runIn: ['active', 'idle', 'sleep'], intervalSeconds: 0, maxRunsPerDay: 1, reservedRunsPerDay: { count: 0, preCondition: 'has-recent-live-prompts' } } } });
    expect((await wake()).scheduled).toEqual({ dispatched: 0, skipped: 1 });
    const atCeiling = [
      { status: 'completed', harness: null, timeoutSeconds: 900, reason: null },
      { status: 'skipped', harness: null, timeoutSeconds: null, reason: 'max_runs_per_day' },
    ];
    expect(await runs(target.projectId)).toEqual(atCeiling);
    // The ceiling refuses rather than queues, and one episode leaves one row: a
    // second wake at the ceiling answers the same and leaves the same rows.
    expect((await wake()).scheduled).toEqual({ dispatched: 0, skipped: 1 });
    expect(await runs(target.projectId)).toEqual(atCeiling);

    // An owner can dispatch while the automatic allowance is exhausted.
    const manual = await fetch(`${target.url}/api/harness/dispatch`, {
      method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'extract-curate', projectId: target.projectId }),
    });
    expect(manual.status).toBe(200);
    expect(await runs(target.projectId)).toHaveLength(3);

    // Off again: the clock leaves both Projects alone.
    await leaf('agent.scheduled_tasks_enabled', false);
    expect((await wake()).scheduled).toEqual({ dispatched: 0, skipped: 0 });
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.tasks'`);
  },
};
