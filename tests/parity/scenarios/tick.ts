import { expect } from 'bun:test';
import { SERVER_JOBS } from '@myco-server-worker/core/jobs.js';
import { CHAINED_WAKE_MS } from '@myco-server-worker/core/tick.js';
import { lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * The wake on both targets: an owner asks for the tick, and the tick runs the
 * same jobs on each — retention removes a run past the window, the sweep fails
 * a run whose runtime went away — and a second ask finds nothing more to do.
 *
 * The expected report is DERIVED from the job registry, never listed here. A
 * hand-written list makes every new job a parity failure on both targets at
 * once, which says nothing about parity and everything about the list.
 */

/** The report an owner's wake owes at a depth where every job runs: the registry in order, less the jobs only the target's own clock runs, changed where a job did work and zero everywhere else. */
const jobReport = (changed: Record<string, number> = {}) =>
  SERVER_JOBS.filter((job) => job.wake === undefined).map((job) => ({ name: job.name, changed: changed[job.name] ?? 0, failed: null }));

/** The two jobs this scenario seeds work for. */
const SEEDED = new Set(['agent-run-retention', 'run-stale-sweep']);

/**
 * A wake's report as this scenario judges it: every job, in order, with its failure, and the changed count of
 * the jobs it seeds. Any other job's count is the work the scenarios run ahead of this one on the same target
 * left behind, which depends on the shard's order and the target's pace, not on the wake.
 */
const seededView = (jobs: Array<{ name: string; changed: number; failed: string | null }>) =>
  jobs.map((job) => ({ name: job.name, changed: SEEDED.has(job.name) ? job.changed : 0, failed: job.failed }));

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
    // A run with an attempt and its step log: retention deletes the log in its own bounded statement before the run.
    await seed('tick-old-stepped', 'completed', now - 41 * day, now - 40 * day, null);
    await target.sql(`INSERT INTO agent_run_attempts (project_id, run_id, attempt_id, leased_by, machine_id, claimed_at)
      VALUES (${lit(target.projectId)}, 'tick-old-stepped', 'mt_tick', 'mt_worker', 'm_tick', ${now - 41 * day})`);
    await target.sql(`INSERT INTO agent_run_steps (project_id, run_id, attempt_id, seq, call_id, kind, tool, target, outcome, exit_code, started_at, ended_at, received_at)
      VALUES (${lit(target.projectId)}, 'tick-old-stepped', 'mt_tick', 0, 'c0', 'read', 'Read', 'a.ts', 'ok', NULL, 1, 2, 3),
             (${lit(target.projectId)}, 'tick-old-stepped', 'mt_tick', 1, 'c1', 'command', 'Bash', 'ls', 'ok', 0, 4, 5, 6)`);
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
      return (await res.json()) as { state: string; jobs: Array<{ name: string; changed: number; failed: string | null; more: boolean }>; nextWakeMs: number | null };
    };
    const rows = () => target.sql(`SELECT id, status, error FROM agent_runs WHERE id LIKE 'tick-%' ORDER BY id`);

    await target.sql(`UPDATE raw_provenance_backfill SET source = 0, cursor_project = '', cursor_id = '', complete = 0 WHERE id = 1`);
    const first = await wake();
    // The scenarios before this one left fresh receipts, and a run start is activity too: the Deployment is awake, and housekeeping runs at every depth but deep sleep.
    expect(['active', 'idle']).toContain(first.state);
    // Retention removes the three runs past the window; the sweep fails the stale one.
    expect(seededView(first.jobs)).toEqual(jobReport({ 'agent-run-retention': 3, 'run-stale-sweep': 1 }));
    expect(first.jobs.find((job) => job.name === 'raw-provenance-backfill')?.more).toBe(true);
    expect(first.nextWakeMs).toBe(CHAINED_WAKE_MS);
    expect(await rows()).toEqual([
      { id: 'tick-live', status: 'running', error: null },
      { id: 'tick-stale', status: 'failed', error: 'the machine running it stopped responding' },
    ]);
    expect(await target.sql(`SELECT COUNT(*) AS c FROM agent_turns WHERE run_id = 'tick-old-turned'`)).toEqual([{ c: 0 }]);
    expect(await target.sql(`SELECT (SELECT COUNT(*) FROM agent_run_steps WHERE run_id = 'tick-old-stepped') AS steps, (SELECT COUNT(*) FROM agent_run_attempts WHERE run_id = 'tick-old-stepped') AS attempts`))
      .toEqual([{ steps: 0, attempts: 0 }]);

    const second = await wake();
    // Idempotent: the same wake again converges on the state it already reached.
    expect(seededView(second.jobs)).toEqual(jobReport());
    expect(await rows()).toEqual([
      { id: 'tick-live', status: 'running', error: null },
      { id: 'tick-stale', status: 'failed', error: 'the machine running it stopped responding' },
    ]);

    // An owner's own request is activity: the wake that follows finds the Deployment in use, and housekeeping still runs.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE id = 'tick-live'`);
    const third = await wake();
    expect(third.state).toBe('active');
    expect(seededView(third.jobs)).toEqual(jobReport());
  },
};
