import { expect } from 'bun:test';
import { credentialEnvFor } from '@goondocks/myco-shared/harness-providers';
import { PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { lit, MEMBER_ID, type ParityScenario } from '../harness.ts';

/** Runner claims, fleet holds and administration use the same explicit sign-in choice on both targets. */
export const runnerSignIn: ParityScenario = {
  name: 'runners: explicit per-agent stored sign-in, own default and unavailable credential holds',
  dedicated: { timeoutMs: 240000 },
  async run(target) {
    const now = Date.now();
    const runnerId = 'rn_signin_parity';
    const credentialId = 'rc_signin_parity';
    const token = 'mycorun_' + 'p'.repeat(43);
    const key = 'sk-ant-api-parity-runner-key';
    const post = (path: string, body: unknown, headers = target.ownerHeaders()) =>
      fetch(`${target.url}${path}`, { method: 'POST', headers: { ...headers, origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const secret = (method: 'PUT' | 'DELETE', value?: string) => fetch(`${target.url}/api/secrets/anthropic`, {
      method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify({ value }) }),
    });
    await target.sql(`INSERT INTO runners(id,name,created_at,created_by_member) VALUES (${lit(runnerId)},'signin-parity',${now},${lit(MEMBER_ID)})`);
    expect(await target.sql(`SELECT credential_choices FROM runners WHERE id = ${lit(runnerId)}`)).toEqual([{ credential_choices: '{}' }]);
    await target.sql(`INSERT INTO runner_credentials(id,runner_id,token_hash,epoch,issued_at,expires_at,lineage_root)
      VALUES (${lit(credentialId)},${lit(runnerId)},${lit(await sha256Hex(token))},1,${now},${now + 3600000},${lit(credentialId)})`);
    await target.sql(`INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,${now})`);
    const headers = { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) };
    const change = (choice: 'own' | 'stored') => post(`/api/runners/${runnerId}/sign-in`, { agent: 'claude-code', choice });
    let serial = 0;
    const claim = async (authenticated: boolean, expectedHold: string | null, expectedEnv?: Record<string, string>) => {
      const id = `run_signin_${++serial}`;
      const session = `sess_signin_${serial}`;
      await target.sql(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        VALUES (${lit(target.projectId)},${lit(session)},'parity','tok_parity',${now},${now})`);
      await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,held_by,instruction,run_context)
        VALUES (${lit(target.projectId)},${lit(id)},'myco-agent','title-summary','queued',${now},'worker','Title this session',${lit(JSON.stringify({ session_id: session, mode: 'claim' }))})`);
      await target.sql(`UPDATE agent_runs SET dispatch_spec = ${lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID, timeoutSeconds: 120, params: { session_id: session, mode: 'claim' } }))} WHERE id = ${lit(id)}`);
      const response = await post('/worker/claim', { harnesses: [{ id: 'claude-code', authenticated, profile: { model: 'flag', efforts: ['low', 'medium', 'high', 'xhigh'] } }], capabilities: [] }, headers);
      expect(response.status).toBe(200);
      const body = await response.json() as { claimed: boolean; run?: { id: string; credentialEnv: Record<string, string> } };
      expect(body.claimed).toBe(expectedEnv !== undefined);
      if (expectedEnv !== undefined) {
        expect(body.run?.id).toBe(id);
        expect(body.run?.credentialEnv).toEqual(expectedEnv);
      }
      expect(await target.sql(`SELECT held_by FROM agent_runs WHERE id = ${lit(id)}`)).toEqual([{ held_by: expectedHold }]);
      if (expectedHold !== null) {
        const previewResponse = await fetch(`${target.url}/api/runners`, { headers: target.ownerHeaders() });
        expect(previewResponse.status).toBe(200);
        const projected = await previewResponse.json() as { queue: { reasons: Array<{ reason: string; count: number }> } };
        expect(projected.queue.reasons).toContainEqual({ reason: 'credential_unavailable', count: 1 });
      }
      await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE id = (SELECT dispatched_by FROM agent_runs WHERE id = ${lit(id)})`);
      await target.sql(`UPDATE agent_runs SET status = 'completed', completed_at = ${Date.now()}, lease_expires_at = NULL WHERE id = ${lit(id)}`);
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
      expect(await target.sql(`SELECT agent,choice FROM runner_signin_audit WHERE runner_id = ${lit(runnerId)} ORDER BY revision`))
        .toEqual([{ agent: 'claude-code', choice: 'stored' }, { agent: 'claude-code', choice: 'own' }]);
    } finally {
      await secret('DELETE');
      await post(`/api/runners/${runnerId}/remove`, {});
    }
  },
};
