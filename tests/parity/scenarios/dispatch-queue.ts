import { expect } from 'bun:test';
import { lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * The queue on both targets: with one run allowed at once, three dispatches
 * yield one launched and two waiting in order; a run ending frees its place
 * on the next wake; with no limit, everything left launches. Both parity
 * targets bind a recording launch, so a launched run sits `pending` with the
 * recorder's mark and nothing starts.
 */
export const dispatchQueue: ParityScenario = {
  name: 'the queue: a limit holds a dispatch in order, a freed place drains it on the wake, no limit launches all',
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

    const dispatch = async () => {
      const res = await fetch(`${target.url}/api/harness/dispatch`, {
        method: 'POST',
        headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
        // A task the catalogue declares no schedule for, so no per-day ceiling: the
        // queue is the thing under test, not the clock's cap.
        body: JSON.stringify({ task: 'cortex-prompt-builder', projectId: target.projectId, timeoutSeconds: 120 }),
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

    const first = await dispatch();
    const second = await dispatch();
    const third = await dispatch();
    expect(first.queued).toBe(false);
    expect(second).toMatchObject({ queued: true, heldBy: 'concurrent_runs' });
    expect(third).toMatchObject({ queued: true, heldBy: 'concurrent_runs' });
    const ids = [first.runId, second.runId, third.runId].sort();
    expect(await rows(ids)).toEqual(ids.map((id) => (
      id === first.runId
        ? { id, status: 'pending', heldBy: null, harness: 'record', credentialed: 1 }
        : { id, status: 'queued', heldBy: 'concurrent_runs', harness: null, credentialed: 0 }
    )));
    // Two asks in the same instant take their places by id; the queue's own positions say which is first.
    const queued = (await listed('queued')).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    expect(queued.map((r) => r.id).sort()).toEqual([second.runId, third.runId].sort());
    expect(queued.map((r) => r.position)).toEqual([0, 1]);
    const front = queued[0]!.id;
    const back = queued[1]!.id;

    // Nothing has changed, so a wake launches nothing.
    expect((await wake()).drained).toBe(0);

    // The first run ends; the wake spends its place on the run at the front of the queue, and the other keeps waiting.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE id = ${lit(first.runId)}`);
    expect((await wake()).drained).toBe(1);
    expect(await rows([front, back].sort())).toEqual([front, back].sort().map((id) => (
      id === front
        ? { id, status: 'pending', heldBy: null, harness: 'record', credentialed: 1 }
        : { id, status: 'queued', heldBy: 'concurrent_runs', harness: null, credentialed: 0 }
    )));

    // No limit: the wake launches what is left.
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.limits.concurrent_runs'`);
    expect((await wake()).drained).toBe(1);
    expect(await rows([back])).toEqual([{ id: back, status: 'pending', heldBy: null, harness: 'record', credentialed: 1 }]);
    expect(await listed('queued')).toEqual([]);

    // A queued run the Deployment can no longer prepare is ended where it
    // waits, and the credential its own row names goes with it. The write that
    // does both answers with what it displaced (`UPDATE … RETURNING`), which
    // this proves on each target's store rather than on one of them.
    const stranded = `run_parity_stranded`;
    const credential = `mt_parity_stranded`;
    await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, revoked_at, bytes_written, lineage_root, lineage_started_at, predecessor_id, first_used_at)
      VALUES (${lit(credential)}, 'mem_harness', 'harness', ${lit(`h_${credential}`)}, ${now}, ${now + 3_600_000}, NULL, 0, ${lit(credential)}, ${now}, NULL, NULL)`);
    await target.sql(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, dispatched_by)
      VALUES (${lit(target.projectId)}, ${lit(stranded)}, 'myco-agent', 'cortex-prompt-builder', 'queued', ${now}, 'runtime',
              ${lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID, timeoutSeconds: 120 }))}, ${lit(credential)})`);

    // With no provider named, the drain can prepare nothing and gives up on it.
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.provider.type'`);
    await wake();
    expect(await target.sql(`SELECT status, error FROM agent_runs WHERE id = ${lit(stranded)}`))
      .toEqual([{ status: 'failed', error: 'no provider is configured; Settings names one before a dispatch can run' }]);
    expect(await target.sql(`SELECT revoked_at IS NOT NULL AS revoked FROM member_credentials WHERE id = ${lit(credential)}`))
      .toEqual([{ revoked: 1 }]);
    await leaf('agent.provider.type', 'openai-compatible');

    // Nothing this scenario launched stays live for the next one to count.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE id IN (${ids.map(lit).join(', ')})`);
  },
};
