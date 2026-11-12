import { expect } from 'bun:test';
import { MEMBER_ID, lit, type ParityScenario } from '../harness.ts';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.js';
import { TITLING_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { revisionHeaders } from '../settings-revision.ts';

export const workerWriteCompletion: ParityScenario = {
  name: 'worker writes: required state and responses commit together under late authority loss',
  dedicated: { cloudflare: { main: '../../tests/parity/owner-review/worker-entry.ts' }, stopRace: true, timeoutMs: 300_000 },
  async run(target) {
    const now = Date.now();
    const request = async (path: string, body: unknown) => fetch(`${target.url}${path}`, { method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
    const claimBody = { harnesses: [offeredHarness('claude-code')] };
    await target.sql(`INSERT OR IGNORE INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,${now})`);
    expect((await fetch(`${target.url}/api/settings/agent.harnesses.claude-code.credential`, { method: 'PUT', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json', ...await revisionHeaders(target, '/api/settings/agent.harnesses.claude-code.credential') }, body: JSON.stringify({ value: 'worker-login' }) })).status).toBe(200);
    const operation = { path: 'claim', write: 'INSERT INTO worker_contacts', after: 1 };
    const snapshot = async () => {
      const response = await fetch(`${target.url}/__parity/worker-state`);
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, unknown>[][]>;
    };
    const runId = 'completion-0';
    await target.sql(`UPDATE members SET role='admin', revoked_at=NULL WHERE id=${lit(MEMBER_ID)}`);
    await target.sql("UPDATE worker_contacts SET last_seen_at=0, last_reason='no_work'");
    await target.sql(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context,instruction)
      VALUES (${lit(target.projectId)},${lit(runId)},'myco-agent',${lit(TITLING_TASK)},'queued',${now},'worker',${lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID, timeoutSeconds: 300, params: { session_id: runId, mode: 'claim' } }))},'{}','do it')`);
    const before = await snapshot();
    await request('/__parity/stop-race/arm', { memberId: MEMBER_ID, write: operation.write, after: operation.after, revoke: false });
    const response = await request(`/worker/${operation.path}`, claimBody);
    expect(response.status).toBe(200);
    expect({ operation: operation.path, boundary: operation.write, answer: await response.json() }).toMatchObject({ operation: operation.path, boundary: operation.write, answer: { persisted: false, code: 'not_admin' } });
    expect(await (await fetch(`${target.url}/__parity/stop-race/status`)).json() as Record<string, unknown>).toEqual({ fired: true, armed: false });
    expect(await snapshot()).toEqual(before);
    await target.sql(`UPDATE members SET role='admin', revoked_at=NULL WHERE id=${lit(MEMBER_ID)}`);
    expect(await (await request(`/worker/${operation.path}`, claimBody)).json()).toMatchObject({ persisted: true });
    await target.sql(`UPDATE agent_runs SET status='failed', lease_expires_at=NULL WHERE id=${lit(runId)}`);

    const endRunId = 'completion-end';
    await target.sql(`UPDATE members SET role='admin', revoked_at=NULL WHERE id=${lit(MEMBER_ID)}`);
    await target.sql("UPDATE worker_contacts SET last_seen_at=0, last_reason='no_work'");
    await target.sql(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context,instruction)
      VALUES (${lit(target.projectId)},${lit(endRunId)},'myco-agent',${lit(TITLING_TASK)},'queued',${now},'worker',${lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID, timeoutSeconds: 300, params: { session_id: endRunId, mode: 'claim' } }))},'{}','do it')`);
    const claimed = await (await request('/worker/claim', claimBody)).json() as { persisted: boolean; claimed: boolean; run: { attemptId: string } };
    expect(claimed).toMatchObject({ persisted: true, claimed: true });
    const attemptId = claimed.run.attemptId;
    const endBody = { projectId: target.projectId, runId: endRunId, attemptId, status: 'failed', error: 'fixture' };
    const beforeEnd = await snapshot();
    await request('/__parity/stop-race/arm', { memberId: MEMBER_ID, write: 'UPDATE member_credentials SET revoked_at', after: 0, revoke: true });
    const endResponse = await request('/worker/end', endBody);
    expect(endResponse.status).toBe(200);
    expect({ operation: 'end', boundary: 'UPDATE member_credentials SET revoked_at', answer: await endResponse.json() }).toMatchObject({
      operation: 'end', boundary: 'UPDATE member_credentials SET revoked_at', answer: { persisted: false, code: 'not_admin' },
    });
    expect(await (await fetch(`${target.url}/__parity/stop-race/status`)).json() as Record<string, unknown>).toEqual({ fired: true, armed: false });
    expect(await snapshot()).toEqual(beforeEnd);
    await target.sql(`UPDATE members SET role='admin', revoked_at=NULL WHERE id=${lit(MEMBER_ID)}`);
    expect(await (await request('/worker/end', endBody)).json()).toMatchObject({ persisted: true });
    await target.sql(`UPDATE agent_runs SET status='failed', lease_expires_at=NULL WHERE id=${lit(endRunId)}`);
  },
};
