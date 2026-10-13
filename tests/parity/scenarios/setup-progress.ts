import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { MEMBER_ID, SESSION_SECRET, lit, type ParityScenario } from '../harness.ts';

export const setupProgress: ParityScenario = {
  name: 'setup progress: scoped observations and bounded D1 reads with misleading history',
  dedicated: { timeoutMs: 180_000, cloudflare: { main: '../../tests/parity/setup-budget/worker-entry.ts' } },
  async run(target) {
    const now = Date.now(); const old = now - 40 * 86_400_000;
    const read = async (headers = target.ownerHeaders()) => {
      const response = await fetch(`${target.url}/api/setup`, { headers });
      expect(response.status).toBe(200);
      return await response.json() as { machines: { signedIn: number }; liveCapture: boolean; runnersReady: number | null; workProduced: boolean; legacyWorkers: number | null };
    };
    await target.sql(`INSERT INTO projects(project_id,name,created_at) VALUES ('proj_setup_parity','Setup',${old})`);
    await target.sql(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES ('proj_setup_parity','imported','removed-machine','t',${now},${now})`);
    await target.sql(`INSERT INTO agents(id,name,created_at) VALUES ('agent_setup_parity','Setup',${now})`);
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at)
      VALUES ('proj_setup_parity','run_setup_empty','agent_setup_parity','extract-curate','completed',${now},${now})`);
    await target.sql(`INSERT INTO runners(id,name,created_at,created_by_member) VALUES ('rn_setup_parity','Private name',${now},${lit(MEMBER_ID)})`);
    await target.sql(`INSERT INTO runner_credentials(id,runner_id,token_hash,epoch,issued_at,expires_at,lineage_root)
      VALUES ('rc_setup_parity','rn_setup_parity','fixture-only-hash',1,${old},${now + 86_400_000},'rc_setup_parity')`);
    await target.sql(`INSERT INTO runner_contacts(runner_id,offers,last_seen_at,updated_at)
      VALUES ('rn_setup_parity','[{"id":"claude-code","authenticated":true}]',${old},${old})`);
    expect(await read()).toMatchObject({ liveCapture: false, runnersReady: 0, workProduced: false });
    await target.sql(`UPDATE runner_contacts SET last_seen_at = ${now}, updated_at = ${now}`);
    expect((await read()).runnersReady).toBe(1);
    await target.sql(`UPDATE runner_credentials SET revoked_at = ${now}`);
    expect((await read()).runnersReady).toBe(0);
    await target.sql(`INSERT INTO members(id,label,created_at,role,github_id) VALUES ('mem_setup_parity','Private member',${now},'member','1719001')`);
    const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub: '1719001', login: 'fixture', iat: now, exp: now + 3_600_000 })}`;
    const member = await read({ cookie, 'cf-connecting-ip': '1.2.3.4' });
    expect(member).toMatchObject({ machines: { signedIn: 0 }, liveCapture: false, runnersReady: null, legacyWorkers: null, workProduced: false });
    expect(JSON.stringify(member)).not.toMatch(/Private|token|hash|1719001/);
    if (target.name !== 'cloudflare') return;
    const measure = async () => await (await fetch(`${target.url}/__setup-read-budget`)).json() as { rowsRead: number };
    const small = await measure();
    expect(small.rowsRead).toBeGreaterThan(0);
    await target.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      SELECT 'proj_setup_parity','import_' || i,'removed-machine','t',${old},${old} FROM n`);
    await target.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at)
      SELECT 'proj_setup_parity','old_' || i,'agent_setup_parity','extract-curate','completed',${old},${old} FROM n`);
    await target.sql(`UPDATE sessions SET last_live_received_at = ${now} WHERE machine_id = 'removed-machine'`);
    const large = await measure();
    expect((await read()).liveCapture).toBe(false);
    expect(large.rowsRead).toBeLessThan(200);
    expect(large.rowsRead).toBeLessThanOrEqual(small.rowsRead + 5);
    console.info(`setup D1 rows_read: before history ${small.rowsRead}; after 2000 removed-machine live sessions and 2000 expired runs ${large.rowsRead}`);
  },
};
