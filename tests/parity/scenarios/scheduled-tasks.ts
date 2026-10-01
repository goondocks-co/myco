import { expect } from 'bun:test';
import { lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * The clock on both targets: with scheduling on, a wake queues extraction for a
 * worker in a Project with a recent receipt and an unread prompt, a second wake
 * while that run waits queues nothing, a ceiling met leaves a skipped row by
 * name, and a cold Project gets nothing.
 */
export const scheduledTasks: ParityScenario = {
  name: 'the clock: extraction queued once, held while it waits, capped by its ceiling, withheld from a cold Project',
  async run(target: ParityTarget) {
    const now = Date.now();
    const leaf = (name: string, value: unknown) => target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (${lit(name)}, ${lit(JSON.stringify(value))}, ${now}, ${lit(MEMBER_ID)})`);
    await leaf('agent.scheduled_tasks_enabled', true);
    const capability = (projectId: string) => target.sql(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (${lit(projectId)}, 'vault_evolution', 1, ${now}, ${lit(MEMBER_ID)})`);
    await capability(target.projectId);
    // Nothing earlier holds a place, and no earlier extraction sets the interval.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE status IN ('pending', 'running', 'queued')`);
    await target.sql(`DELETE FROM agent_runs WHERE task = 'extract-curate'`);
    const [credential] = await target.sql(`SELECT id FROM member_credentials ORDER BY issued_at LIMIT 1`) as Array<{ id: string }>;
    // An ended session holding a prompt extraction has not read, last heard from at `at`.
    const backlog = async (projectId: string, session: string, at: number) => {
      await target.sql(`INSERT OR REPLACE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at)
        VALUES (${lit(projectId)}, ${lit(session)}, 'machine_parity', ${lit(credential!.id)}, ${at}, ${at}, 'claude-code', ${at}, ${at})`);
      await target.sql(`INSERT OR REPLACE INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at, processed)
        VALUES (${lit(projectId)}, ${lit(session)}, ${lit(`p_${session}`)}, ${lit(`e_${session}`)}, 'a decision worth keeping', 'user', ${lit(`h_${session}`)}, ${at}, ${at}, ${lit(credential!.id)}, ${at}, 0)`);
    };
    // A cold Project beside the live one: a receipt three weeks old.
    await target.sql(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_cold', 'cold', ${now - 30 * 86_400_000})`);
    await capability('proj_cold');
    await backlog('proj_cold', 'cold-session', now - 21 * 86_400_000);
    // The live Project: a receipt a minute old, whatever ran before this scenario.
    await backlog(target.projectId, 'clock-live-session', now - 60_000);

    const wake = async () => {
      const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
      return (await res.json()) as { state: string; scheduled: { dispatched: number; skipped: number } };
    };
    const runs = (projectId: string) => target.sql(`SELECT status, held_by AS heldBy, harness, run_context AS runContext FROM agent_runs WHERE project_id = ${lit(projectId)} AND task = 'extract-curate' ORDER BY COALESCE(queued_at, started_at), id`) as Promise<Array<{ status: string; heldBy: string | null; harness: string | null; runContext: string | null }>>;
    const shape = (rows: Array<{ status: string; heldBy: string | null; harness: string | null; runContext: string | null }>) =>
      rows.map((r) => ({ status: r.status, heldBy: r.heldBy, harness: r.harness, reason: r.status === 'skipped' ? (JSON.parse(r.runContext!) as { reason: string }).reason : null }));

    // The live Project's receipt is a minute old: the Deployment is in use or idle, and extraction runs only then or asleep.
    await leaf('agent.tasks', { 'extract-curate': { schedule: { runIn: ['active', 'idle', 'sleep'] } } });
    const first = await wake();
    expect(first.scheduled).toEqual({ dispatched: 1, skipped: 0 });
    // A worker serves extraction: the run waits for one, and nothing launches it here.
    expect(shape(await runs(target.projectId))).toEqual([{ status: 'queued', heldBy: 'worker', harness: null, reason: null }]);
    expect(await runs('proj_cold')).toEqual([]);

    // While that run waits: nothing more.
    expect((await wake()).scheduled).toEqual({ dispatched: 0, skipped: 0 });
    expect(await runs(target.projectId)).toHaveLength(1);

    // The ceiling: one a day, the interval past — a skipped row names it.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE task = 'extract-curate'`);
    await leaf('agent.tasks', { 'extract-curate': { schedule: { runIn: ['active', 'idle', 'sleep'], intervalSeconds: 0, maxRunsPerDay: 1, reservedRunsPerDay: { count: 0, preCondition: 'has-recent-live-prompts' } } } });
    expect((await wake()).scheduled).toEqual({ dispatched: 0, skipped: 1 });
    const atCeiling = [
      { status: 'completed', heldBy: 'worker', harness: null, reason: null },
      { status: 'skipped', heldBy: null, harness: null, reason: 'max_runs_per_day' },
    ];
    expect(shape(await runs(target.projectId))).toEqual(atCeiling);
    // The ceiling refuses rather than queues, and one episode leaves one row: a
    // second wake at the ceiling answers the same and leaves the same rows.
    expect((await wake()).scheduled).toEqual({ dispatched: 0, skipped: 1 });
    expect(shape(await runs(target.projectId))).toEqual(atCeiling);

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
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${Date.now()} WHERE status IN ('pending', 'running', 'queued')`);
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.tasks'`);
  },
};
