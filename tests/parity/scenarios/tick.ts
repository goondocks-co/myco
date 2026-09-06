import { expect } from 'bun:test';
import { lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * The wake on both targets: an owner asks for the tick, and the tick runs the
 * same two jobs on each — retention removes a run past the window, the sweep
 * fails a run whose runtime went away — and a second ask finds nothing more
 * to do.
 */
export const tick: ParityScenario = {
  name: 'the wake: retention and the stale-run sweep, identical on both targets, idempotent',
  async run(target: ParityTarget) {
    const now = Date.now();
    const day = 86_400_000;
    await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ${now})`);
    const seed = (id: string, status: string, startedAt: number, completedAt: number | null, context: string | null) =>
      target.sql(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, resumable, run_context)
        VALUES (${lit(target.projectId)}, ${lit(id)}, 'myco-agent', 'digest', ${lit(status)}, ${startedAt}, ${completedAt === null ? 'NULL' : completedAt}, 0, ${context === null ? 'NULL' : lit(context)})`);
    await seed('tick-old', 'completed', now - 41 * day, now - 40 * day, null);
    await seed('tick-old-turned', 'completed', now - 41 * day, now - 40 * day, null);
    await target.sql(`INSERT INTO agent_turns (project_id, run_id, agent_id, turn_number, tool_name) VALUES (${lit(target.projectId)}, 'tick-old-turned', 'myco-agent', 0, 'read')`);
    await seed('tick-stale', 'running', now - 3_600_000, null, JSON.stringify({ timeoutSeconds: 300 }));
    await seed('tick-live', 'running', now - 60_000, null, JSON.stringify({ timeoutSeconds: 300 }));
    // A receipt half an hour ago: the Deployment is asleep, where housekeeping runs.
    const [credential] = await target.sql(`SELECT id FROM member_credentials ORDER BY issued_at LIMIT 1`) as Array<{ id: string }>;
    await target.sql(`INSERT OR REPLACE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent)
      VALUES (${lit(target.projectId)}, 'tick-session', 'machine_parity', ${lit(credential!.id)}, ${now - 31 * 60_000}, ${now - 31 * 60_000}, 'claude-code')`);

    const wake = async () => {
      // Each wake follows an owner request, so the second finds the Deployment awake unless a run holds it; the assertions below say which.
      const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
      return (await res.json()) as { state: string; jobs: Array<{ name: string; changed: number; failed: string | null }>; nextWakeMs: number | null };
    };
    const rows = () => target.sql(`SELECT id, status, error FROM agent_runs WHERE id LIKE 'tick-%' ORDER BY id`);

    const first = await wake();
    // The scenarios before this one left fresh receipts, and a run start is activity too: the Deployment is awake, and housekeeping runs at every depth but deep sleep.
    expect(['active', 'idle']).toContain(first.state);
    expect(first.jobs).toEqual([
      { name: 'agent-run-retention', changed: 2, failed: null },
      { name: 'run-stale-sweep', changed: 1, failed: null },
      { name: 'search-index', changed: 0, failed: null },
    ]);
    expect(first.nextWakeMs).toBe(60_000);
    expect(await rows()).toEqual([
      { id: 'tick-live', status: 'running', error: null },
      { id: 'tick-stale', status: 'failed', error: 'the runtime went away' },
    ]);
    expect(await target.sql(`SELECT COUNT(*) AS c FROM agent_turns WHERE run_id = 'tick-old-turned'`)).toEqual([{ c: 0 }]);

    const second = await wake();
    expect(second.jobs).toEqual([
      { name: 'agent-run-retention', changed: 0, failed: null },
      { name: 'run-stale-sweep', changed: 0, failed: null },
      { name: 'search-index', changed: 0, failed: null },
    ]);
    expect(await rows()).toEqual([
      { id: 'tick-live', status: 'running', error: null },
      { id: 'tick-stale', status: 'failed', error: 'the runtime went away' },
    ]);

    // An owner's own request is activity: the wake that follows finds the Deployment in use, and housekeeping still runs.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE id = 'tick-live'`);
    const third = await wake();
    expect(third.state).toBe('active');
    expect(third.jobs.map((j) => j.changed)).toEqual([0, 0, 0]);
  },
};
