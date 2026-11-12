import { expect } from 'bun:test';
import { credentialEnvFor } from '@goondocks/myco-shared/harness-providers';
import { type ParityScenario } from '../harness.ts';
import { browser, client, person, registerRunner } from '../clients/identity.ts';
import { askTitle, cancelRun, captureSession, runDetail } from '../clients/runs.ts';

/** Runner claims, fleet holds and administration use the same explicit sign-in choice on both targets. */
export const runnerSignIn: ParityScenario = {
  name: 'runners: explicit per-agent stored sign-in, own default and unavailable credential holds',
  dedicated: { timeoutMs: 240000 },
  async run(target) {
    const reader = await person(target, '477101', { login: 'reader' });
    const { runnerId, token } = await registerRunner(target, target.ownerHeaders(), 'signin-parity');
    const key = 'sk-ant-api-parity-runner-key';
    const secret = (method: 'PUT' | 'DELETE', value?: string) => fetch(`${target.url}/api/secrets/anthropic`, {
      method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify({ value }) }),
    });
    const change = (choice: 'own' | 'stored') => browser(target, `/api/runners/${runnerId}/sign-in`, target.ownerHeaders(), { agent: 'claude-code', choice });
    let serial = 0;
    // The owner asks a captured session's title; the runner offers its agent, signed in or not, and claims that run or leaves it held.
    const claim = async (authenticated: boolean, expectedHold: string | null, expectedEnv?: Record<string, string>) => {
      const session = `sess_signin_${++serial}`;
      await captureSession(target, session, 'Title this session');
      const id = await askTitle(target, session);
      const response = await client(target, '/worker/claim', { harnesses: [{ id: 'claude-code', authenticated, profile: { model: 'flag', efforts: ['low', 'medium', 'high', 'xhigh'] } }], capabilities: [] }, token);
      expect(response.status).toBe(200);
      const body = response.body as { claimed: boolean; run?: { id: string; attemptId: string; credentialEnv: Record<string, string> } };
      expect(body.claimed).toBe(expectedEnv !== undefined);
      if (expectedEnv !== undefined) {
        expect(body.run?.id).toBe(id);
        expect(body.run?.credentialEnv).toEqual(expectedEnv);
      }
      expect((await runDetail(target, id)).run.heldBy).toBe(expectedHold);
      if (expectedHold !== null) {
        const projected = await browser(target, '/api/runners', target.ownerHeaders());
        expect(projected.status).toBe(200);
        const member = await browser(target, '/api/runners', reader.session);
        expect(member.status).toBe(200);
        expect(member.body.runners[0]).not.toHaveProperty('credentialChoices');
        expect(JSON.stringify(member.body)).not.toContain('credential_unavailable');
        expect(member.body.queue.reasons).toEqual([{ reason: 'ready', count: 1 }]);
        expect(projected.body.queue.reasons).toContainEqual({ reason: 'credential_unavailable', count: 1 });
      }
      if (body.run === undefined) await cancelRun(target, id);
      else expect((await client(target, '/worker/end', { projectId: target.projectId, runId: body.run.id, attemptId: body.run.attemptId, status: 'completed', usage: { inputTokens: null, outputTokens: null, costUsd: 0 } }, token)).body).toMatchObject({ ended: true });
    };
    try {
      expect((await change('stored')).status).toBe(409);
      expect((await secret('PUT', key)).status).toBe(200);
      await claim(true, null, {});
      expect((await change('stored')).status).toBe(200);
      await claim(false, null, credentialEnvFor('claude-code', key));
      expect((await secret('DELETE')).status).toBe(200);
      await claim(true, 'credential_unavailable:claude-code');
      expect((await change('own')).status).toBe(200);
      await claim(true, null, {});
    } finally {
      await secret('DELETE');
      await browser(target, `/api/runners/${runnerId}/remove`, target.ownerHeaders(), {});
    }
  },
};
