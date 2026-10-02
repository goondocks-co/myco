import { expect } from 'bun:test';
import { lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/** How far other queued runs are moved back while this scenario claims its own, and forward again afterwards. */
const PARK_MS = 3_600_000;

/**
 * A Codex claim held for a deployment login stays held when only an embedding key exists. A Codex key releases it,
 * deleting that key holds it again, and an explicit worker login claims with no injected key.
 */
export const harnessCredentialSlots: ParityScenario = {
  name: 'harness credential slots: a Codex claim reads the Codex slot and never the embedding provider\'s',
  async run(target: ParityTarget) {
    const now = Date.now();
    const embeddingKey = 'sk-parity-embedding-key-not-a-login-0001';
    const codexKey = 'sk-parity-codex-run-key-0002';
    const owner = (method: 'PUT' | 'DELETE', slot: string, value?: string) => fetch(`${target.url}/api/secrets/${slot}`, {
      method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify({ value }) }),
    });
    const modelLeaf = 'agent.reasoning_map.codex.low';
    const credentialLeaf = 'agent.harnesses.codex.credential';
    const settings = await fetch(`${target.url}/api/settings`, { headers: { ...target.ownerHeaders(), origin: target.url } });
    expect(settings.status).toBe(200);
    const leaves = ((await settings.json()) as { leaves: Array<{ leaf: string; configured: boolean; value: unknown }> }).leaves;
    const before = [modelLeaf, credentialLeaf].map((leaf) => leaves.find((entry) => entry.leaf === leaf));
    if (before.some((entry) => entry === undefined)) throw new Error(`${target.name}: missing Codex profile settings`);
    const setting = (method: 'PUT' | 'DELETE', leaf: string, value?: unknown) => fetch(`${target.url}/api/settings/${leaf}`, {
      method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
      ...(method === 'PUT' ? { body: JSON.stringify({ value }) } : {}),
    });
    const set = async (leaf: string, value: unknown): Promise<void> => {
      const response = await setting('PUT', leaf, value);
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { applied: true } });
    };
    await target.sql(`INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (${lit(target.projectId)}, 'Slot parity', ${now})`);
    await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ${now})`);
    const parked = (await target.sql(`SELECT id FROM agent_runs WHERE status = 'queued' AND dispatched_by IS NULL AND task IS NOT NULL`))
      .map((r) => String((r as { id: string }).id));
    const shiftParked = async (by: number) => {
      if (parked.length > 0) await target.sql(`UPDATE agent_runs SET queued_at = queued_at + (${by}) WHERE id IN (${parked.map(lit).join(', ')})`);
    };

    /** What one Codex claim answers and records against the credential source and keys held now. */
    const codexClaim = async (n: number): Promise<{ claimed: boolean; reason: string | null; heldBy: string | null; credentialEnv: Record<string, string> | null }> => {
      const runId = `run_parity_slots_${now}_${n}`;
      const sessionId = `sess_parity_slots_${now}_${n}`;
      await target.sql(
        `INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
         VALUES (${lit(target.projectId)}, ${lit(sessionId)}, 'm_parity', 'tok_parity', ${now}, ${now})`,
      );
      await target.sql(
        `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
         VALUES (${lit(target.projectId)}, ${lit(runId)}, 'myco-agent', 'title-summary', 'queued', ${now}, 'worker',
                 ${lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID, timeoutSeconds: 120, params: { session_id: sessionId, mode: 'claim' } }))},
                 ${lit(JSON.stringify({ timeoutSeconds: 120, session_id: sessionId, mode: 'claim' }))}, NULL)`,
      );
      const res = await fetch(`${target.url}/worker/claim`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ harnesses: [{ id: 'codex', authenticated: true, profile: { model: 'config', efforts: ['low', 'medium', 'high'] } }], capabilities: [] }),
      });
      const answer = await res.json() as { claimed: boolean; reason?: string; run?: { id: string; harness: string; credentialEnv: Record<string, string> } };
      expect(res.status).toBe(200);
      if (answer.claimed) expect({ id: answer.run?.id, harness: answer.run?.harness }).toEqual({ id: runId, harness: 'codex' });
      const [row] = await target.sql(`SELECT held_by AS heldBy FROM agent_runs WHERE id = ${lit(runId)}`) as Array<{ heldBy: string | null }>;
      // The claim's run credential is retired and its row closed, so nothing this scenario claimed outlives it.
      if (answer.claimed) await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE id = (SELECT dispatched_by FROM agent_runs WHERE id = ${lit(runId)})`);
      await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${Date.now()}, lease_expires_at = NULL WHERE id = ${lit(runId)}`);
      return { claimed: answer.claimed, reason: answer.reason ?? null, heldBy: row?.heldBy ?? null, credentialEnv: answer.run?.credentialEnv ?? null };
    };

    await shiftParked(PARK_MS);
    try {
      await set(modelLeaf, 'gpt-6.1');
      await set(credentialLeaf, 'deployment');
      const unavailable = { claimed: false, reason: 'no_harness', heldBy: 'credential_unavailable:codex', credentialEnv: null };
      expect(await codexClaim(1)).toEqual(unavailable);
      expect((await owner('PUT', 'openai', embeddingKey)).status).toBe(200);
      expect(await codexClaim(2)).toEqual(unavailable);
      expect((await owner('PUT', 'codex', codexKey)).status).toBe(200);
      expect(await codexClaim(3)).toEqual({ claimed: true, reason: null, heldBy: null, credentialEnv: { OPENAI_API_KEY: codexKey } });
      expect((await owner('DELETE', 'codex')).status).toBe(200);
      expect(await codexClaim(4)).toEqual(unavailable);
      await set(credentialLeaf, 'worker-login');
      expect(await codexClaim(5)).toEqual({ claimed: true, reason: null, heldBy: null, credentialEnv: {} });
    } finally {
      const restored = await Promise.allSettled(before.map((entry, index) => setting(entry!.configured ? 'PUT' : 'DELETE', [modelLeaf, credentialLeaf][index]!, entry!.value)));
      try {
        await owner('DELETE', 'codex');
        await owner('DELETE', 'openai');
      } finally { await shiftParked(-PARK_MS); }
      for (const result of restored) {
        if (result.status === 'rejected') throw result.reason;
        expect({ status: result.value.status, body: await result.value.json() }).toEqual({ status: 200, body: { applied: true } });
      }
    }
  },
};
