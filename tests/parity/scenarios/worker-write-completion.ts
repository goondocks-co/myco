import { expect } from 'bun:test';
import { stepPages } from '@goondocks/myco-shared/worker-steps';
import { MEMBER_ID, lit, type ParityScenario } from '../harness.ts';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.js';

export const workerWriteCompletion: ParityScenario = {
  name: 'worker writes: required state and responses commit together under late authority loss',
  dedicated: { cloudflare: { main: '../../tests/parity/owner-review/worker-entry.ts' }, stopRace: true, timeoutMs: 300_000 },
  async run(target) {
    const now = Date.now();
    const request = async (path: string, body: unknown) => fetch(`${target.url}${path}`, { method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
    const claimBody = { harnesses: [offeredHarness('claude-code')] };
    const repository = { url: 'https://github.com/goondocks-co/myco', branch: 'main', historyDepth: 50 };
    const commit = 'a'.repeat(40);
    await target.sql(`INSERT OR IGNORE INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,${now})`);
    await target.sql(`INSERT INTO project_capabilities (project_id,capability,enabled,updated_at,updated_by) VALUES (${lit(target.projectId)},'vault_evolution',1,${now},${lit(MEMBER_ID)})`);
    expect((await fetch(`${target.url}/api/settings/agent.harnesses.claude-code.credential`, { method: 'PUT', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify({ value: 'worker-login' }) })).status).toBe(200);
    await target.sql(`INSERT INTO project_repositories (project_id,revision,url,branch,username,secret_slot,updated_at,updated_by) VALUES (${lit(target.projectId)},'worker-completion',${lit(repository.url)},'main',NULL,NULL,${now},${lit(MEMBER_ID)})`);
    const operations = [
      { path: 'claim', write: 'INSERT INTO worker_contacts', after: 1 },
      { path: 'claim', write: 'UPDATE agent_runs SET instruction =', after: 0 },
      { path: 'lease', write: 'INSERT INTO worker_contacts', after: 0 },
      { path: 'end', write: 'UPDATE member_credentials SET revoked_at', after: 0 },
      { path: 'steps', write: 'UPDATE agent_run_attempts SET', after: 0 },
      { path: 'models', write: 'INSERT INTO worker_model_catalogs', after: 0 },
      { path: 'repository', write: 'UPDATE agent_runs SET run_context', after: 0, task: 'vault-seed' },
      { path: 'repository', write: 'UPDATE agent_runs SET run_context', after: 0, task: 'canopy-map' },
    ];
    const snapshot = async () => {
      const response = await fetch(`${target.url}/__parity/worker-state`);
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, unknown>[][]>;
    };
    let index = 0;
    for (const operation of operations) {
      for (const revoke of [false, true]) {
        const runId = `completion-${index++}`;
        await target.sql(`UPDATE members SET role='admin', revoked_at=NULL WHERE id=${lit(MEMBER_ID)}`);
        await target.sql("UPDATE worker_contacts SET last_seen_at=0, last_reason='no_work'");
        await target.sql(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context,instruction)
          VALUES (${lit(target.projectId)},${lit(runId)},'myco-agent','extract-curate','queued',${now},'worker',${lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID, timeoutSeconds: 300 }))},'{}','do it')`);
        let body: unknown = claimBody;
        if (operation.path !== 'claim') {
          const claimed = await (await request('/worker/claim', claimBody)).json() as { persisted: boolean; claimed: boolean; run: { attemptId: string } };
          expect(claimed).toMatchObject({ persisted: true, claimed: true });
          const attemptId = claimed.run.attemptId;
          body = { projectId: target.projectId, runId, attemptId, status: 'failed', error: 'fixture' };
          if (operation.path === 'lease') {
            await target.sql(`UPDATE worker_contacts SET last_seen_at=0`);
            await target.sql(`UPDATE agent_runs SET lease_expires_at=${Date.now() + 30_000} WHERE id=${lit(runId)}`);
          } else if (operation.path === 'steps') {
            body = { projectId: target.projectId, runId, ...stepPages(attemptId, [{ seq: 0, callId: runId, kind: 'read', tool: 'Read', target: 'file.ts', outcome: 'ok', exitCode: null, startedAt: now, endedAt: now + 1 }], 0, { total: 0, shapes: {} })[0]! };
          } else if (operation.path === 'models') {
            body = { catalog: { harness: 'codex', source: { kind: 'exchange', command: 'fixture' }, signIn: 'worker-login', fetchedAt: now + index, models: [{ id: 'fixture-model', efforts: [] }] } };
          } else if (operation.path === 'repository') {
            await target.sql(`UPDATE agent_runs SET task=${lit(operation.task ?? 'vault-seed')}, run_context=${lit(JSON.stringify({ timeoutSeconds: 300, checkout: repository }))} WHERE id=${lit(runId)}`);
            body = { projectId: target.projectId, runId, attemptId, ...repository, commit };
          }
        }
        const before = await snapshot();
        await request('/__parity/stop-race/arm', { memberId: MEMBER_ID, write: operation.write, after: operation.after, revoke });
        const response = await request(`/worker/${operation.path}`, body);
        expect(response.status).toBe(200);
        expect({ operation: operation.path, boundary: operation.write, answer: await response.json() }).toMatchObject({ operation: operation.path, boundary: operation.write, answer: { persisted: false, code: 'not_admin' } });
        expect(await (await fetch(`${target.url}/__parity/stop-race/status`)).json() as Record<string, unknown>).toEqual({ fired: true, armed: false });
        expect(await snapshot()).toEqual(before);
        await target.sql(`UPDATE members SET role='admin', revoked_at=NULL WHERE id=${lit(MEMBER_ID)}`);
        expect(await (await request(`/worker/${operation.path}`, body)).json()).toMatchObject({ persisted: true });
        await target.sql(`UPDATE agent_runs SET status='failed', lease_expires_at=NULL WHERE id=${lit(runId)}`);
      }
    }
  },
};
