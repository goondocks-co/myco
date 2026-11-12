import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { MEMBER_ID, SESSION_SECRET, lit, type ParityScenario } from '../harness.ts';

export const setupProgress: ParityScenario = {
  name: 'setup progress: scoped observations and bounded D1 reads',
  dedicated: { timeoutMs: 180_000 },
  async run(target) {
    const now = Date.now();
    const read = async (headers = target.ownerHeaders()) => {
      const response = await fetch(`${target.url}/api/setup`, { headers });
      expect(response.status).toBe(200);
      return await response.json() as { machines: { signedIn: number }; liveCapture: boolean; runnersReady: number | null; workProduced: boolean; legacyWorkers: number | null };
    };
    await target.sql(`INSERT INTO projects(project_id,name,created_at) VALUES ('proj_setup_parity','Setup',${now})`);
    await target.sql(`INSERT INTO agents(id,name,created_at) VALUES ('agent_setup_parity','Setup',${now})`);
    await target.sql(`INSERT INTO runners(id,name,created_at,created_by_member) VALUES ('rn_setup_parity','Private name',${now},${lit(MEMBER_ID)})`);
    await target.sql(`INSERT INTO runner_credentials(id,runner_id,token_hash,epoch,issued_at,expires_at,lineage_root)
      VALUES ('rc_setup_parity','rn_setup_parity','fixture-only-hash',1,${now},${now + 86_400_000},'rc_setup_parity')`);
    await target.sql(`INSERT INTO runner_contacts(runner_id,offers,last_seen_at,updated_at)
      VALUES ('rn_setup_parity','[{"id":"claude-code","authenticated":true}]',${now},${now})`);
    expect((await read()).runnersReady).toBe(1);
    await target.sql(`UPDATE runner_credentials SET revoked_at = ${now}`);
    expect((await read()).runnersReady).toBe(0);

    await target.sql(`INSERT INTO members(id,label,created_at,role,github_id) VALUES ('mem_setup_parity','Private member',${now},'member','1719001')`);
    const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub: '1719001', login: 'fixture', iat: now, exp: now + 3_600_000 })}`;
    const member = await read({ cookie, 'cf-connecting-ip': '1.2.3.4' });
    expect(member).toMatchObject({ machines: { signedIn: 0 }, liveCapture: false, runnersReady: null, legacyWorkers: null, workProduced: false });
    expect(JSON.stringify(member)).not.toMatch(/Private|token|hash|1719001/);

    await target.sql(`INSERT INTO machine_claims(machine_id,member_id,claimed_at)
      VALUES ('established_setup_machine',${lit(MEMBER_ID)},${now - 1000})`);
    await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES ('mt_setup_established',${lit(MEMBER_ID)},'established_setup_machine','fixture-established-hash',${now},${now + 86_400_000},'mt_setup_established',${now})`);
    await target.sql(`INSERT INTO sessions(project_id,session_id,machine_id,agent,created_by_token_id,first_received_at,last_received_at,last_live_received_at)
      VALUES ('proj_setup_parity','established_live','established_setup_machine','claude-code','mt_setup_established',${now},${now},${now})`);
    expect((await read()).liveCapture).toBe(true);

    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at)
      VALUES ('proj_setup_parity','run_setup_empty','agent_setup_parity','extract-curate','completed',${now},${now})`);
    await target.sql(`INSERT INTO spores(project_id,id,agent_id,observation_type,status,content,author,created_at)
      VALUES('proj_setup_parity','run_output','agent_setup_parity','gotcha','active','Run knowledge','run_setup_empty',${now})`);
    expect((await read()).workProduced).toBe(true);

    type Measurement = { rowsRead: number | null; progress: { liveCapture: boolean; workProduced: boolean } };
    const measure = async (): Promise<Measurement> => {
      if (target.name !== 'cloudflare') return { rowsRead: null, progress: await read() };
      const response = await fetch(`${target.url}/api/setup`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      return { rowsRead: Number(response.headers.get('x-parity-rows-read')), progress: await response.json() as Measurement['progress'] };
    };
    const expectFlat = (label: string, before: Measurement, after: Measurement) => {
      if (target.name !== 'cloudflare') return;
      if (before.rowsRead === null || after.rowsRead === null) throw new Error('D1 read measurement unavailable');
      console.info(`setup D1 ${label} rows_read: ${before.rowsRead} -> ${after.rowsRead}`);
      expect(before.rowsRead).toBeGreaterThan(0);
      expect(after.rowsRead).toBeLessThan(200);
      expect(after.rowsRead).toBeLessThanOrEqual(before.rowsRead + 5);
    };

    // 50 vs 500 unrelated sessions: setup reads remain bounded.
    await target.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
      INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,last_live_received_at)
      SELECT 'proj_setup_parity','small_' || i,'established_setup_machine','mt_setup_established',${now},${now},${now} FROM n`);
    const small = await measure();
    await target.sql(`WITH RECURSIVE n(i) AS (SELECT 51 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
      INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,last_live_received_at)
      SELECT 'proj_setup_parity','bulk_' || i,'established_setup_machine','mt_setup_established',${now},${now},${now} FROM n`);
    const large = await measure();
    expectFlat('unrelated session history', small, large);
  },
};
