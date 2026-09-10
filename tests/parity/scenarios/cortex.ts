import { expect } from 'bun:test';
import { lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * An outcome run on both targets: an owner's ask for the extraction pass builds
 * the prompt and writes it onto the queued run row with its hash, a second ask
 * waits behind a limit and is left for a worker by the wake rather than
 * launched, and a new session's start is served the Project it works in and the
 * Deployment's own instructions, never a generated artifact.
 *
 * Both targets bind a recording launch, so no container ever starts and a
 * worker-served run stays queued until a worker takes it.
 */
export const cortex: ParityScenario = {
  name: 'an outcome run: the ask queues a run carrying its prompt and hash, the wake leaves it for a worker, and session start serves the Project and its instructions',
  async run(target: ParityTarget) {
    const now = Date.now();
    const stamp = String(now);
    const leaf = (name: string, value: unknown) => target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (${lit(name)}, ${lit(JSON.stringify(value))}, ${now}, ${lit(MEMBER_ID)})`);
    await target.sql(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (${lit(target.projectId)}, 'vault_evolution', 1, ${now}, ${lit(MEMBER_ID)})`);
    // A clean board: nothing another scenario left holds a place.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE status IN ('pending', 'running', 'queued')`);
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.limits.concurrent_runs'`);

    const dispatch = async (ask: Record<string, unknown> = {}) => {
      const res = await fetch(`${target.url}/api/harness/dispatch`, {
        method: 'POST',
        headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'extract-curate', projectId: target.projectId, ...ask }),
      });
      return { status: res.status, body: (await res.json()) as { outcome?: string; runId?: string; queued?: boolean; heldBy?: string } };
    };
    const startSession = async (sessionId: string) => {
      const res = await fetch(`${target.url}/context/session`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, kind: 'start' }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { persisted: boolean; context: string; parts: Array<{ kind: string }> };
    };
    const wake = async () => {
      const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
    };
    const row = async (runId: string) =>
      (await target.sql(`SELECT status, instruction, run_context AS runContext, dry_run AS dryRun, held_by AS heldBy FROM agent_runs WHERE id = ${lit(runId)}`))[0] as
        { status: string; instruction: string | null; runContext: string | null; dryRun: number; heldBy: string | null };

    // A first ask: the run row carries the prompt the server built, and its hash,
    // and waits for a worker — neither front door runs a harness.
    const first = await dispatch();
    expect(first.status).toBe(200);
    const firstRunId = String(first.body.runId);
    const firstRow = await row(firstRunId);
    expect({ status: firstRow.status, heldBy: firstRow.heldBy, dryRun: firstRow.dryRun }).toEqual({ status: 'queued', heldBy: 'worker', dryRun: 0 });
    expect(firstRow.instruction).toContain('Read the prompts nobody has read yet');
    expect((JSON.parse(firstRow.runContext!) as { input_hash: string }).input_hash).toHaveLength(64);
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${Date.now()} WHERE id = ${lit(firstRunId)}`);

    // A second ask behind a limit waits by the limit's name, and the wake leaves
    // it for a worker once the limit clears: a worker-served run is never
    // launched by the drain.
    await leaf('agent.limits.concurrent_runs', 1);
    await target.sql(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, dry_run, started_at) VALUES (${lit(target.projectId)}, ${lit(`blocker-${stamp}`)}, 'myco-agent', 'extract-curate', 'running', 0, ${Date.now()})`);
    const queued = await dispatch();
    expect(queued.body).toMatchObject({ queued: true, heldBy: 'concurrent_runs' });
    const queuedRunId = String(queued.body.runId);
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${Date.now()} WHERE id = ${lit(`blocker-${stamp}`)}`);
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.limits.concurrent_runs'`);
    await wake();
    const waiting = await row(queuedRunId);
    expect(waiting.status).toBe('queued');
    expect(waiting.instruction).toContain('Read the prompts nobody has read yet');
    expect((JSON.parse(waiting.runContext!) as { input_hash?: string }).input_hash).toEqual(expect.any(String));

    // Session start serves the Project the agent works in and the Deployment's
    // own instructions, and nothing any run wrote.
    await leaf('instructions.template', `# Parity guidance ${stamp}`);
    try {
      const block = await startSession(`parity-cortex-${stamp}`);
      expect({ persisted: block.persisted, parts: block.parts.map((p) => p.kind) }).toEqual({ persisted: true, parts: ['project', 'instructions'] });
      expect(block.context).toContain(target.projectId);
      expect(block.context).toContain(`# Parity guidance ${stamp}`);
    } finally {
      await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'instructions.template'`);
    }

    // Leave the board as the next scenario expects it.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${Date.now()} WHERE status IN ('pending', 'running', 'queued')`);
  },
};
