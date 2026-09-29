import { expect } from 'bun:test';
import { lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/** How far other queued runs are moved back while this scenario claims its own, and forward again afterwards. */
const PARK_MS = 3_600_000;

/**
 * The key a Codex claim hands a worker, on both targets (#1212): a key stored for embeddings in the `openai` slot
 * changes nothing a Codex claim answers, and only the key stored in the `codex` slot does. Stored and removed through
 * the dashboard's own owner routes, and claimed through the worker's own route.
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
    await target.sql(`INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (${lit(target.projectId)}, 'Slot parity', ${now})`);
    await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ${now})`);
    const parked = (await target.sql(`SELECT id FROM agent_runs WHERE status = 'queued' AND dispatched_by IS NULL AND task IS NOT NULL`))
      .map((r) => String((r as { id: string }).id));
    const shiftParked = async (by: number) => {
      if (parked.length > 0) await target.sql(`UPDATE agent_runs SET queued_at = queued_at + (${by}) WHERE id IN (${parked.map(lit).join(', ')})`);
    };

    /** What one Codex claim answers the worker with, against whatever keys the Deployment holds now. */
    const codexClaim = async (n: number): Promise<Record<string, string>> => {
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
        body: JSON.stringify({ harnesses: [{ id: 'codex', authenticated: true }], capabilities: [] }),
      });
      const answer = await res.json() as { claimed: boolean; reason?: string; run?: { id: string; harness: string; credentialEnv: Record<string, string> } };
      expect({ status: res.status, claimed: answer.claimed, reason: answer.reason ?? null, run: answer.run?.id ?? null, harness: answer.run?.harness ?? null })
        .toEqual({ status: 200, claimed: true, reason: null, run: runId, harness: 'codex' });
      // The claim's run credential is retired and its row closed, so nothing this scenario claimed outlives it.
      await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE id = (SELECT dispatched_by FROM agent_runs WHERE id = ${lit(runId)})`);
      await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${Date.now()}, lease_expires_at = NULL WHERE id = ${lit(runId)}`);
      return answer.run!.credentialEnv;
    };

    await shiftParked(PARK_MS);
    try {
      expect(await codexClaim(1)).toEqual({});
      expect((await owner('PUT', 'openai', embeddingKey)).status).toBe(200);
      expect(await codexClaim(2)).toEqual({});
      expect((await owner('PUT', 'codex', codexKey)).status).toBe(200);
      expect(await codexClaim(3)).toEqual({ OPENAI_API_KEY: codexKey });
      expect((await owner('DELETE', 'codex')).status).toBe(200);
      expect(await codexClaim(4)).toEqual({});
    } finally {
      await owner('DELETE', 'codex');
      await owner('DELETE', 'openai');
      await shiftParked(-PARK_MS);
    }
  },
};
