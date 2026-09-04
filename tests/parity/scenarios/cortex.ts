import { expect } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { lit, MEMBER_ID, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * Instructions on the harness, on both targets: an owner's ask builds the input
 * and writes it onto the run row with its hash; the run, as the harness member,
 * reads that prompt back over its own admitted route and files the artifact
 * under the SERVER's hash; a second ask over unmoved material answers
 * `unchanged` and starts nothing; a queued ask has its prompt rebuilt at the
 * drain against the vault as it then stands; and a new session's start is served
 * what the run wrote.
 *
 * Both targets bind a recording launch, so no container ever starts and this
 * scenario plays the runtime itself. The credential it plays under is minted the
 * only way a test can mint one: the store keeps a digest of the token, so a row
 * is written for a token this scenario chose.
 */
export const cortex: ParityScenario = {
  name: 'cortex instructions: the run carries its prompt, files the artifact under the server\'s hash, and a still Project costs nothing',
  async run(target: ParityTarget) {
    const now = Date.now();
    const stamp = String(now);
    const leaf = (name: string, value: unknown) => target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (${lit(name)}, ${lit(JSON.stringify(value))}, ${now}, ${lit(MEMBER_ID)})`);
    for (const [name, value] of [
      ['agent.provider.type', 'openai-compatible'],
      ['agent.provider.model', 'parity-model'],
      ['agent.provider.base_url', 'http://models.internal/v1'],
    ] as const) await leaf(name, value);
    await target.sql(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (${lit(target.projectId)}, 'cortex', 1, ${now}, ${lit(MEMBER_ID)})`);
    // A clean board: nothing another scenario left holds a place, no earlier
    // instructions run sets the per-day ceiling, and no artifact stands.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE status IN ('pending', 'running', 'queued')`);
    await target.sql(`DELETE FROM agent_runs WHERE task = 'cortex-instructions'`);
    await target.sql(`DELETE FROM cortex_instructions WHERE project_id = ${lit(target.projectId)}`);
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.limits.concurrent_runs'`);

    const dispatch = async () => {
      const res = await fetch(`${target.url}/api/harness/dispatch`, {
        method: 'POST',
        headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'cortex-instructions', projectId: target.projectId }),
      });
      return { status: res.status, body: (await res.json()) as { outcome?: string; runId?: string; queued?: boolean } };
    };
    const wake = async () => {
      const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
    };
    const saveSpore = async (content: string) => {
      const res = await fetch(`${target.url}/mcp`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_spores', arguments: { op: 'save', type: 'decision', content } } }),
      });
      expect(res.status).toBe(200);
    };
    const row = async (runId: string) =>
      (await target.sql(`SELECT status, instruction, run_context AS runContext, dry_run AS dryRun FROM agent_runs WHERE id = ${lit(runId)}`))[0] as
        { status: string; instruction: string | null; runContext: string | null; dryRun: number };
    const instructionsRows = () => target.sql(`SELECT content, input_hash AS inputHash, source_run_id AS sourceRunId FROM cortex_instructions WHERE project_id = ${lit(target.projectId)}`);
    const runCount = async () => ((await target.sql(`SELECT COUNT(*) AS c FROM agent_runs WHERE task = 'cortex-instructions'`))[0] as { c: number }).c;

    // A first ask: the run row carries the prompt the server built, and its hash.
    const first = await dispatch();
    expect(first.status).toBe(200);
    const firstRunId = String(first.body.runId);
    const firstRow = await row(firstRunId);
    expect(firstRow.status).toBe('pending');
    expect(firstRow.instruction).toContain('## Recent sessions');
    expect(firstRow.dryRun).toBe(0);
    const firstHash = (JSON.parse(firstRow.runContext!) as { input_hash: string }).input_hash;
    expect(firstHash).toHaveLength(64);

    // The runtime's own credential: a row for a token this scenario chose, bound
    // to the run the dispatch recorded, and the run moved to `running` as its
    // claim would move it.
    // The wire's token grammar: 32 random bytes as unpadded base64url. This one is chosen rather than random so its digest can be written directly.
    const token = `parity-harness-${stamp}`.padEnd(43, 'x').slice(0, 43);
    const tokenId = `mt_parity_${stamp}`;
    await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, revoked_at, bytes_written, predecessor_id, lineage_root, lineage_started_at, first_used_at, runtime_label, runtime_kind)
      VALUES (${lit(tokenId)}, 'mem_harness', 'harness', ${lit(await sha256Hex(token))}, ${now}, ${now + 86_400_000}, NULL, 0, NULL, ${lit(tokenId)}, ${now}, NULL, NULL, NULL)`);
    await target.sql(`UPDATE agent_runs SET status = 'running', dispatched_by = ${lit(tokenId)}, started_at = ${Date.now()} WHERE id = ${lit(firstRunId)}`);
    const asRun = async (path: string, body: Record<string, unknown>) => {
      const res = await fetch(`${target.url}${path}`, {
        method: 'POST',
        headers: { ...memberHeadersFor(token, target.projectId), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(`${path}: ${res.status}`).toBe(`${path}: 200`);
      return (await res.json()) as Record<string, unknown>;
    };

    // The run reads back the prompt the server wrote for it.
    const served = await asRun('/runs/instruction', { runId: firstRunId });
    expect({ held: served.held, instruction: served.instruction }).toEqual({ held: true, instruction: firstRow.instruction });

    // The artifact is filed under the hash the RUN ROW carries, never one the caller names.
    const content = `## Myco-Enabled Project\n\nParity instructions ${stamp}.`;
    expect(await asRun('/runs/instructions-write', { runId: firstRunId, content, inputHash: 'not-this-one' }))
      .toEqual({ persisted: true, held: true, written: true });
    expect(await instructionsRows()).toEqual([{ content, inputHash: firstHash, sourceRunId: firstRunId }]);
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${Date.now()} WHERE id = ${lit(firstRunId)}`);

    // A second ask over material that has not moved: an outcome, and no run row —
    // decided ahead of the day's ceiling, which the first run has already met.
    const before = await runCount();
    expect(await dispatch()).toEqual({ status: 200, body: { outcome: 'unchanged' } });
    expect(await runCount()).toBe(before);

    // The day's ceiling stands for a Project that HAS moved: one run a day.
    await saveSpore(`the ceiling is the day's spend ${stamp}`);
    expect(await dispatch()).toMatchObject({ status: 409, body: { error: 'max_runs_per_day' } });
    // Yesterday's run leaves today free again.
    await target.sql(`UPDATE agent_runs SET started_at = ${now - 2 * 86_400_000} WHERE id = ${lit(firstRunId)}`);

    // A queued ask has its prompt rebuilt at the drain: a spore saved after it
    // queued is in the prompt the launch writes, under a hash that has moved.
    await leaf('agent.limits.concurrent_runs', 1);
    await target.sql(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, dry_run, started_at) VALUES (${lit(target.projectId)}, ${lit(`blocker-${stamp}`)}, 'myco-agent', 'digest-only', 'running', 0, ${Date.now()})`);
    await saveSpore(`the queue holds a run row ${stamp}`);
    const queued = await dispatch();
    expect(queued.body.queued).toBe(true);
    const queuedRunId = String(queued.body.runId);
    await saveSpore(`a drained run reads the vault as it stands ${stamp}`);
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${Date.now()} WHERE id = ${lit(`blocker-${stamp}`)}`);
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.limits.concurrent_runs'`);
    await wake();
    const drained = await row(queuedRunId);
    expect(drained.status).toBe('pending');
    expect(drained.instruction).toContain(`a drained run reads the vault as it stands ${stamp}`);
    expect((JSON.parse(drained.runContext!) as { input_hash: string }).input_hash).not.toBe(firstHash);

    // The artifact the first run filed is what a new session is served at its start.
    const sessionId = `parity-cortex-${stamp}`;
    const started = await fetch(`${target.url}/context/session`, {
      method: 'POST',
      headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, kind: 'start' }),
    });
    expect(started.status).toBe(200);
    const block = (await started.json()) as { persisted: boolean; context: string; parts: Array<{ kind: string }> };
    expect({ persisted: block.persisted, parts: block.parts.map((p) => p.kind) }).toEqual({ persisted: true, parts: ['instructions'] });
    expect(block.context).toContain(`Parity instructions ${stamp}`);

    // Leave the board as the next scenario expects it.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${Date.now()} WHERE status IN ('pending', 'running', 'queued')`);
    await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE id = ${lit(tokenId)}`);
  },
};
