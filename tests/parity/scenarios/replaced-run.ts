import { expect } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { REPLACED_REQUEUES_PER_DAY } from '@myco-server-worker/core/harness.js';
import { lit, MEMBER_ID, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * A deploy that ends a run, on both targets: the runtime posts its failure with
 * the word for it, the row carries that word, one fresh run of the same task
 * stands in for it naming the run it replaces, the day's ceiling is not spent
 * on work nobody received, and a Deployment rolling again and again is capped
 * at `REPLACED_REQUEUES_PER_DAY` successors of a task in a day.
 *
 * Both targets bind a recording launch, so no container ever starts and this
 * scenario plays the runtime itself. The credential it plays under is minted the
 * only way a test can mint one: the store keeps a digest of the token, so a row
 * is written for a token this scenario chose.
 */
export const replacedRun: ParityScenario = {
  name: 'a replaced run: the row says a deploy ended it, a successor stands in for it once, and the day is not spent',
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
    // A clean board: nothing another scenario left holds a place, no limit holds
    // a dispatch, and no earlier run of this task has spent the day.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${now} WHERE status IN ('pending', 'running', 'queued')`);
    await target.sql(`DELETE FROM agent_runs WHERE task = 'container-smoke'`);
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.limits.concurrent_runs'`);
    // One run of this task a day, so the ceiling is a single row: what the
    // replaced run costs the day is then visible in one dispatch.
    await leaf('agent.tasks', { 'container-smoke': { schedule: { maxRunsPerDay: 1 } } });

    const dispatch = async () => {
      const res = await fetch(`${target.url}/api/harness/dispatch`, {
        method: 'POST',
        headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'container-smoke', projectId: target.projectId, timeoutSeconds: 120 }),
      });
      return { status: res.status, body: (await res.json()) as { runId?: string; error?: string; queued?: boolean } };
    };
    const row = async (runId: string) =>
      (await target.sql(`SELECT status, run_context AS runContext FROM agent_runs WHERE id = ${lit(runId)}`))[0] as { status: string; runContext: string | null };
    const successorOf = async (runId: string): Promise<string | null> => {
      const rows = await target.sql(`SELECT id FROM agent_runs WHERE task = 'container-smoke' AND json_extract(CASE WHEN json_valid(run_context) THEN run_context END, '$.replaces') = ${lit(runId)}`);
      return rows.length === 0 ? null : String((rows[0] as { id: string }).id);
    };
    const listed = async () => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/runs?task=container-smoke`, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      return ((await res.json()) as { rows: Array<{ id: string; replaced: boolean; replaces: string | null }> }).rows;
    };

    // A runtime's own credential, one per run: the store keeps a digest of the
    // token, so a row is written for a token this scenario chose. The wire's
    // token grammar is 32 random bytes as unpadded base64url; these are chosen
    // rather than random so their digests can be written directly. Each run's
    // ending revokes the credential its dispatch minted, so the next link in
    // the chain gets its own, exactly as a real dispatch would.
    const minted: string[] = [];
    const mintRuntime = async (n: number): Promise<{ token: string; tokenId: string }> => {
      const token = `parity-replaced-${n}-${stamp}`.padEnd(43, 'x').slice(0, 43);
      const tokenId = `mt_parity_replaced_${n}_${stamp}`;
      await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, revoked_at, bytes_written, predecessor_id, lineage_root, lineage_started_at, first_used_at, runtime_label, runtime_kind)
        VALUES (${lit(tokenId)}, 'mem_harness', 'harness', ${lit(await sha256Hex(token))}, ${now}, ${now + 86_400_000}, NULL, 0, NULL, ${lit(tokenId)}, ${now}, NULL, NULL, NULL)`);
      minted.push(tokenId);
      return { token, tokenId };
    };
    /**
     * The runtime's own word about how its run ended: a deploy took the runtime
     * away. Only the credential the dispatch minted for a run may say it, so
     * this scenario takes that place on the row before it speaks — the same
     * stand-in the Cortex scenario makes to play a run.
     */
    const failReplaced = async (runId: string) => {
      const { token, tokenId } = await mintRuntime(minted.length);
      await target.sql(`UPDATE agent_runs SET status = 'running', dispatched_by = ${lit(tokenId)}, started_at = ${Date.now()} WHERE id = ${lit(runId)}`);
      const res = await fetch(`${target.url}/runs/update`, {
        method: 'POST',
        headers: { ...memberHeadersFor(token, target.projectId), 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          replaced: true,
          update: { status: 'failed', completed_at: Date.now(), error: 'the platform reclaimed the runtime before the run ended' },
        }),
      });
      expect(`/runs/update: ${res.status}`).toBe('/runs/update: 200');
      expect(await res.json()).toEqual({ persisted: true, changed: 1 });
    };

    // A first ask launches; a second meets the day's ceiling of one.
    const first = await dispatch();
    expect(first.status).toBe(200);
    const firstRunId = String(first.body.runId);
    expect((await row(firstRunId)).status).toBe('pending');
    expect(await dispatch()).toMatchObject({ status: 409, body: { error: 'max_runs_per_day' } });

    // The run's own runtime names the deploy that ended it. The row carries the
    // word, and one fresh run of the same task stands in for it.
    await failReplaced(firstRunId);
    const failed = await row(firstRunId);
    expect(failed.status).toBe('failed');
    expect((JSON.parse(failed.runContext!) as { replaced?: boolean }).replaced).toBe(true);
    const second = await successorOf(firstRunId);
    expect(second).not.toBeNull();
    expect((await row(second!)).status).toBe('pending');

    // A deploy that keeps rolling is capped: each replaced run is answered once,
    // and the Project gets REPLACED_REQUEUES_PER_DAY of this task in a day.
    const chain = [firstRunId, second!];
    for (let i = 1; i < REPLACED_REQUEUES_PER_DAY + 1; i += 1) {
      await failReplaced(chain[i]!);
      const next = await successorOf(chain[i]!);
      if (next !== null) chain.push(next);
    }
    expect(chain).toHaveLength(REPLACED_REQUEUES_PER_DAY + 1);
    expect(await successorOf(chain.at(-1)!)).toBeNull();

    // The reader is told which rows a deploy touched, and which stands in for which.
    const rows = await listed();
    expect(rows.filter((r) => r.replaced).map((r) => r.id).sort()).toEqual([...chain].sort());
    expect(rows.filter((r) => r.replaces !== null).map((r) => r.replaces).sort()).toEqual(chain.slice(0, -1).sort());

    // Every run of this task today is one a deploy ended, so the day is unspent
    // and the ceiling of one admits an ask again.
    const again = await dispatch();
    expect(again.status).toBe(200);
    expect(again.body.runId).toBeDefined();

    // Leave the board as the next scenario expects it.
    await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${Date.now()} WHERE status IN ('pending', 'running', 'queued')`);
    await target.sql(`DELETE FROM deployment_settings WHERE leaf = 'agent.tasks'`);
    await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE id IN (${minted.map(lit).join(', ')})`);
  },
};
