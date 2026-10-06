import { expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { claimNextRun } from '@myco-server-worker/core/harness.js';
import { memberHeaders, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { stepPages } from '@goondocks/myco-shared/worker-steps';

const ACTOR = 'mem_machine_2';
const paths = ['/worker/claim', '/worker/lease', '/worker/end', '/worker/repository', '/worker/models', '/worker/steps'];

for (const path of paths) {
  for (const change of (path === '/worker/claim' ? ['demotion', 'revocation', 'claim demotion'] : ['demotion', 'revocation']) as Array<'demotion' | 'revocation' | 'claim demotion'>) {
    it(`${path}: ${change} before its first write preserves worker state and its refusal shape`, async () => {
      let armed = false;
      const f = sqliteEnv({ workerLogin: true, onSql(sql, sqlite) {
        if (change === 'claim demotion' && !/SET status = 'running', started_at/.test(sql)) return;
        if (!armed || /^SELECT\b/.test(sql.trim()) || !/agent_runs|agent_run_attempts|agent_run_steps|worker_contacts|worker_model_catalogs/.test(sql)) return;
        armed = false;
        sqlite.run(change !== 'revocation' ? "UPDATE members SET role='member' WHERE id=?" : 'UPDATE members SET revoked_at=1 WHERE id=?', [ACTOR]);
      } });
      try {
        const now = Date.now();
        f.sqlite.run("UPDATE members SET role='admin' WHERE id=?", [ACTOR]);
        turnOnGatedCapabilities(f.sqlite);
        const issued = await issueMemberToken(f.db, { memberId: ACTOR, machineId: 'worker-machine' }, now);
        f.sqlite.run(`INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)`, [now]);
        f.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context,instruction)
          VALUES ('proj_1','live-run','myco-agent','extract-curate','queued',?,'worker',?,'{}','do it')`, [now, JSON.stringify({ serverUrl: 'https://s', actor: ACTOR, timeoutSeconds: 300 })]);
        const claimed = await claimNextRun(f.serverEnv, { tokenId: issued.tokenId, machineId: 'worker-machine', harnesses: [offeredHarness('claude-code')], now });
        if (!claimed.claimed) throw new Error('fixture run was not claimed');
        if (path === '/worker/repository') {
          f.sqlite.run(`INSERT INTO project_repositories (project_id,revision,url,branch,updated_at,updated_by) VALUES ('proj_1','r1','https://example.test/source','main',?,'fixture')`, [now]);
          f.sqlite.run("UPDATE agent_runs SET task='vault-seed', run_context=? WHERE id='live-run'", [JSON.stringify({ timeoutSeconds: 300, checkout: { url: 'https://example.test/source', branch: 'main', historyDepth: 50 } })]);
        }
        if (change === 'claim demotion') f.sqlite.run("UPDATE agent_runs SET status='queued', dispatched_by=NULL, leased_by=NULL, lease_expires_at=NULL WHERE id='live-run'");
        const body = path === '/worker/claim' ? { harnesses: change === 'claim demotion' ? [offeredHarness('claude-code')] : [] }
          : path === '/worker/models' ? { catalog: { harness: 'codex', source: { kind: 'exchange', command: 'fixture' }, signIn: 'worker-login', fetchedAt: now, models: [{ id: 'fixture-model', efforts: [] }] } }
          : path === '/worker/steps' ? { projectId: 'proj_1', runId: 'live-run', ...stepPages(claimed.run.attemptId, [{ seq: 0, callId: 'fixture-call', kind: 'read', tool: 'Read', target: 'file.ts', outcome: 'ok', exitCode: null, startedAt: now, endedAt: now + 1 }], 0, { total: 0, shapes: {} })[0]! }
          : path === '/worker/repository' ? { projectId: 'proj_1', runId: 'live-run', url: 'https://example.test/source', branch: 'main', commit: 'a'.repeat(40) }
          : { projectId: 'proj_1', runId: 'live-run', status: 'failed', error: 'fixture' };
        const snapshot = () => ['agent_runs', 'agent_run_attempts', 'agent_run_steps', 'worker_contacts', 'worker_model_catalogs', 'member_credentials'].filter(table => change !== 'claim demotion' || table !== 'worker_contacts').map(table => f.sqlite.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
        const before = snapshot();
        armed = true;
        const response = await worker.fetch(new Request(`https://s${path}`, { method: 'POST', headers: memberHeaders(issued.token), body: JSON.stringify(body) }), f.env);
        expect(armed).toBe(false);
        expect(response.status).toBe(200);
        expect(await response.json() as Record<string, unknown>).toMatchObject({ persisted: false, code: 'not_admin' });
        expect(snapshot()).toEqual(before);
      } finally { f.sqlite.close(); }
    });
  }
}
