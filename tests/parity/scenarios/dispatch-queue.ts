import { expect } from 'bun:test';
import { lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * The claim queue on both targets.
 *
 * Every ask for a worker-served task waits, whatever the limits say, in the
 * order the queue's own positions give it; the wake drains none of them. The
 * launch queue the seam still serves is exercised by the clock scenario, which
 * dispatches one of the three tasks that still launch.
 */
export const dispatchQueue: ParityScenario = {
  name: 'the claim queue: a worker\'s runs wait in order whatever the limit says, and no front door launches one',
  async run(target: ParityTarget) {
    const now = Date.now();
    const leaf = (name: string, value: unknown) => target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (${lit(name)}, ${lit(JSON.stringify(value))}, ${now}, ${lit(MEMBER_ID)})`);
    for (const [name, value] of [
      ['agent.provider.type', 'openai-compatible'],
      ['agent.provider.model', 'parity-model'],
      ['agent.provider.base_url', 'http://models.internal/v1'],
    ] as const) await leaf(name, value);
    await target.sql(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (${lit(target.projectId)}, 'cortex', 1, ${now}, ${lit(MEMBER_ID)})`);
    // A clean queue: nothing another scenario launched under the recorder still holds a place.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE status IN ('pending', 'running', 'queued')`);
    await leaf('agent.limits.concurrent_runs', 1);

    const dispatch = async (task: string) => {
      const res = await fetch(`${target.url}/api/harness/dispatch`, {
        method: 'POST',
        headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
        body: JSON.stringify({ task, projectId: target.projectId, timeoutSeconds: 120 }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { runId: string; queued?: boolean; heldBy?: string };
    };
    const wake = async () => {
      const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
      return (await res.json()) as { drained: number };
    };
    const rows = (ids: string[]) => target.sql(`SELECT id, status, held_by AS heldBy, harness, dispatched_by IS NOT NULL AS credentialed FROM agent_runs WHERE id IN (${ids.map(lit).join(', ')}) ORDER BY id`);
    const listed = async (status: string) => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/runs?status=${status}`, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      return ((await res.json()) as { rows: Array<{ id: string; status: string; heldBy: string | null; position: number | null }> }).rows;
    };
    const launched = (id: string) => ({ id, status: 'pending', heldBy: null, harness: 'record', credentialed: 1 });
    const waiting = (id: string, heldBy: string) => ({ id, status: 'queued', heldBy, harness: null, credentialed: 0 });

    // A run already running holds the limit, so the first ask waits behind it
    // by name; with the limit clear the next still waits, held by the worker
    // that has yet to claim it. Both are the same queue in the same order.
    await target.sql(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, dry_run, started_at) VALUES (${lit(target.projectId)}, ${lit(`blocker-${now}`)}, 'myco-agent', 'supersession-sweep', 'running', 0, ${now})`);
    const a = await dispatch('cortex-prompt-builder');
    expect(a).toMatchObject({ queued: true, heldBy: 'concurrent_runs' });
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE id = ${lit(`blocker-${now}`)}`);
    const b = await dispatch('cortex-prompt-builder');
    expect(b).toMatchObject({ queued: true, heldBy: 'worker' });
    expect(await rows([a.runId, b.runId].sort()))
      .toEqual([a.runId, b.runId].sort().map((id) => waiting(id, id === a.runId ? 'concurrent_runs' : 'worker')));
    const queued = (await listed('queued')).sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
    expect(queued.map((r) => r.id)).toEqual([a.runId, b.runId]);
    expect(queued.map((r) => r.position)).toEqual([0, 1]);

    // No limit, and still nothing launches: neither front door runs a harness
    // for these, and the drain passes over them rather than stopping.
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.limits.concurrent_runs'`);
    expect((await wake()).drained).toBe(0);
    expect(await rows([a.runId, b.runId].sort()))
      .toEqual([a.runId, b.runId].sort().map((id) => waiting(id, id === a.runId ? 'concurrent_runs' : 'worker')));

    // A queued run the Deployment can no longer prepare is ended where it
    // waits, and the credential its own row names goes with it. The write that
    // does both answers with what it displaced (`UPDATE … RETURNING`), which
    // this proves on each target's store rather than on one of them.
    const stranded = `run_parity_stranded`;
    const credential = `mt_parity_stranded`;
    await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, revoked_at, bytes_written, lineage_root, lineage_started_at, predecessor_id, first_used_at)
      VALUES (${lit(credential)}, 'mem_harness', 'harness', ${lit(`h_${credential}`)}, ${now}, ${now + 3_600_000}, NULL, 0, ${lit(credential)}, ${now}, NULL, NULL)`);
    await target.sql(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, dispatched_by)
      VALUES (${lit(target.projectId)}, ${lit(stranded)}, 'myco-agent', 'container-smoke', 'queued', ${now}, 'runtime',
              ${lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID, timeoutSeconds: 120 }))}, ${lit(credential)})`);

    // With no provider named, the drain can prepare nothing and gives up on it.
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.provider.type'`);
    try {
      await wake();
      expect(await target.sql(`SELECT status, error FROM agent_runs WHERE id = ${lit(stranded)}`))
        .toEqual([{ status: 'failed', error: 'no provider is configured; Settings names one before a dispatch can run' }]);
      expect(await target.sql(`SELECT revoked_at IS NOT NULL AS revoked FROM member_credentials WHERE id = ${lit(credential)}`))
        .toEqual([{ revoked: 1 }]);
    } finally {
      // The scenarios after this one dispatch, and a Deployment with no provider
      // dispatches nothing.
      await leaf('agent.provider.type', 'openai-compatible');
    }

    // Nothing this scenario launched stays live for the next one to count.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE id IN (${[a.runId, b.runId].map(lit).join(', ')})`);
  },
};
