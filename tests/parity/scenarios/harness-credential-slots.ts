import { expect } from 'bun:test';
import { type ParityScenario } from '../harness.ts';
import { owner, putSetting } from '../clients/requests.ts';
import { askTitle, cancelRun, captureSession, finishRun, runDetail, worker } from '../clients/runs.ts';

/** Codex consumes its own deployment slot or a worker login. */
export const harnessCredentialSlots: ParityScenario = {
  name: 'harness credential slots: a Codex claim reads the Codex slot and never the embedding provider\'s',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    const embeddingKey = 'sk-parity-embedding-key-not-a-login-0001', codexKey = 'sk-parity-codex-run-key-0002';
    const secret = async (method: 'PUT' | 'DELETE', slot: string, value?: string) => {
      expect((await owner(target, `/api/secrets/${slot}`, { method, ...(value === undefined ? {} : { body: JSON.stringify({ value }) }) })).status).toBe(200);
    };
    const set = async (leaf: string, value: unknown) => { expect((await putSetting(target, leaf, value)).status).toBe(200); };
    await set('agent.reasoning_map.codex.low', 'gpt-6.1');
    await set('agent.harnesses.codex.credential', 'deployment');
    const codexClaim = async (n: number) => {
      const session = `credential-slot-${n}`;
      await captureSession(target, session, 'Title the credential-slot check');
      const runId = await askTitle(target, session);
      const answer = await worker(target, 'claim', { harnesses: [{ id: 'codex', authenticated: true, profile: { model: 'config', efforts: ['low', 'medium', 'high'] } }], capabilities: [] });
      if (answer.claimed) expect(answer.run).toMatchObject({ id: runId, harness: 'codex' });
      const heldBy = (await runDetail(target, runId)).run.heldBy;
      if (answer.claimed) expect(await finishRun(target, answer.run)).toMatchObject({ ended: true });
      else await cancelRun(target, runId);
      return { claimed: answer.claimed, reason: answer.reason ?? null, heldBy, credentialEnv: answer.run?.credentialEnv ?? null };
    };
    const unavailable = { claimed: false, reason: 'no_harness', heldBy: 'credential_unavailable:codex', credentialEnv: null };
    expect(await codexClaim(1)).toEqual(unavailable);
    await secret('PUT', 'openai', embeddingKey);
    expect(await codexClaim(2)).toEqual(unavailable);
    await secret('PUT', 'codex', codexKey);
    expect(await codexClaim(3)).toEqual({ claimed: true, reason: null, heldBy: null, credentialEnv: { OPENAI_API_KEY: codexKey } });
    await secret('DELETE', 'codex');
    expect(await codexClaim(4)).toEqual(unavailable);
    await set('agent.harnesses.codex.credential', 'worker-login');
    expect(await codexClaim(5)).toEqual({ claimed: true, reason: null, heldBy: null, credentialEnv: {} });
  },
};
