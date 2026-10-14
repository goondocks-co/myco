import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { projectRepositoryNeeded } from '@myco-server-worker/read/repository-requirements.js';
import type { ServerEnv, RelationalStore } from '@myco-server-worker/core/adapters.js';
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
    await target.sql(`INSERT INTO machine_claims(machine_id,member_id,claimed_at)
      VALUES ('reclaimed_setup_machine',${lit(MEMBER_ID)},${now})`);
    await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES ('mt_setup_current',${lit(MEMBER_ID)},'reclaimed_setup_machine','fixture-current-hash',${now},${now + 86_400_000},'mt_setup_current',${now})`);
    type Measurement = { rowsRead: number | null; progress: { liveCapture: boolean } };
    const measure = async (): Promise<Measurement> => {
      if (target.name !== 'cloudflare') return { rowsRead: null, progress: await read() };
      const response = await fetch(`${target.url}/__setup-read-budget`);
      expect(response.status).toBe(200);
      return await response.json() as Measurement;
    };
    const expectFlat = (label: string, before: Measurement, after: Measurement) => {
      if (target.name !== 'cloudflare') return;
      if (before.rowsRead === null || after.rowsRead === null) throw new Error('D1 read measurement unavailable');
      console.info(`setup D1 ${label} rows_read: ${before.rowsRead} -> ${after.rowsRead}`);
      expect(before.rowsRead).toBeGreaterThan(0);
      expect(after.rowsRead).toBeLessThan(200);
      expect(after.rowsRead).toBeLessThanOrEqual(before.rowsRead + 5);
    };
    const small = await measure();
    expect(small.progress.liveCapture).toBe(false);
    await target.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO sessions(project_id,session_id,machine_id,agent,created_by_token_id,first_received_at,last_received_at,last_live_received_at)
      SELECT 'proj_setup_parity','preclaim_' || i,'reclaimed_setup_machine','claude-code','mt_setup_current',${old},${old},${now - 1} FROM n`);
    const reclaimed = await measure();
    expect(reclaimed.progress.liveCapture).toBe(false);
    expectFlat('reclaimed-machine', small, reclaimed);
    await target.sql(`INSERT INTO machine_claims(machine_id,member_id,claimed_at)
      VALUES ('established_setup_machine',${lit(MEMBER_ID)},${now - 1000})`);
    await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES ('mt_setup_established',${lit(MEMBER_ID)},'established_setup_machine','fixture-established-hash',${old},${now + 86_400_000},'mt_setup_established',${old})`);
    await target.sql(`INSERT INTO sessions(project_id,session_id,machine_id,agent,created_by_token_id,first_received_at,last_received_at,last_live_received_at)
      VALUES ('proj_setup_parity','established_live','established_setup_machine','claude-code','mt_setup_established',${now},${now},${now})`);
    expect((await read()).liveCapture).toBe(true);
    const established = await measure();
    expect(established.progress.liveCapture).toBe(true);
    await target.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO sessions(project_id,session_id,machine_id,agent,created_by_token_id,first_received_at,last_received_at,last_live_received_at)
      SELECT 'proj_setup_parity','preclaim_more_' || i,'reclaimed_setup_machine','claude-code','mt_setup_current',${old},${old},${now - 1} FROM n`);
    const establishedLarge = await measure();
    expect(establishedLarge.progress.liveCapture).toBe(true);
    expectFlat('established Deployment', established, establishedLarge);
    await target.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,last_live_received_at)
      SELECT 'proj_setup_parity','import_' || i,'removed-machine','t',${old},${old},${now} FROM n`);
    await target.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at)
      SELECT 'proj_setup_parity','old_' || i,'agent_setup_parity','extract-curate','completed',${old},${old} FROM n`);
    const unrelated = await measure();
    expect(unrelated.progress.liveCapture).toBe(true);
    expectFlat('unrelated history', establishedLarge, unrelated);

    // A project's notice stays a primary-key read even when the Deployment-wide list overflows.
    await target.sql(`INSERT INTO project_capabilities(project_id,capability,enabled,updated_at,updated_by)
      VALUES ('proj_setup_parity','canopy',1,${now},${lit(MEMBER_ID)})`);
    await target.sql(`INSERT INTO project_repositories(project_id,revision,url,branch,username,secret_slot,updated_at,updated_by)
      VALUES ('proj_setup_parity','budget-fixture','https://github.com/example/healthy.git','main',NULL,NULL,${now},${lit(MEMBER_ID)})`);
    const scopedBudget = async () => {
      if (target.name !== 'cloudflare') return null;
      const response = await fetch(`${target.url}/__repository-read-budget?project=proj_setup_parity`);
      expect(response.status).toBe(200);
      return response.json() as Promise<{ rowsRead: number; needed: { projectId: string } | null }>;
    };
    const beforeOverflow = await scopedBudget();
    expect(beforeOverflow?.needed ?? null).toBeNull();
    await target.sql(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
      INSERT INTO projects(project_id,name,created_at)
      SELECT 'proj_repo_overflow_' || printf('%03d',i),'Repository overflow',${now} FROM n`);
    await target.sql(`INSERT INTO project_capabilities(project_id,capability,enabled,updated_at,updated_by)
      SELECT project_id,'canopy',1,${now},${lit(MEMBER_ID)} FROM projects WHERE project_id LIKE 'proj_repo_overflow_%'`);
    const overflow = await read();
    expect((overflow as typeof overflow & { repositoriesNeeded: Array<{ projectId: string }>; repositoriesOverflow: boolean }).repositoriesNeeded).toHaveLength(100);
    expect((overflow as typeof overflow & { repositoriesOverflow: boolean }).repositoriesOverflow).toBe(true);
    const attention = async (project?: string) => {
      const response = await fetch(`${target.url}/api/attention${project === undefined ? '' : `?project=${project}`}`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ items: Array<{ kind: string; tone?: string; projectId?: string }>; unavailable: string[] }>;
    };
    expect((await attention()).unavailable).toContain('repository_missing');
    const healthy = await attention('proj_setup_parity');
    expect(healthy.unavailable).not.toContain('repository_missing');
    expect(healthy.items.filter(item => item.kind === 'repository_missing')).toEqual([]);
    const excess = await attention('proj_repo_overflow_100');
    expect(excess.unavailable).not.toContain('repository_missing');
    expect(excess.items.filter(item => item.kind === 'repository_missing')).toEqual([{ kind: 'repository_missing', projectId: 'proj_repo_overflow_100', tone: 'warn' }]);
    const afterOverflow = await scopedBudget();
    expect(afterOverflow?.needed ?? null).toBeNull();
    if (beforeOverflow !== null && afterOverflow !== null) {
      console.info(`repository scoped D1 rows_read: ${beforeOverflow.rowsRead} -> ${afterOverflow.rowsRead}`);
      expect(afterOverflow.rowsRead).toBeLessThan(50);
      expect(afterOverflow.rowsRead).toBeLessThanOrEqual(beforeOverflow.rowsRead + 5);
    }

    const statements: Array<{ sql: string; binds: unknown[] }> = [];
    const recorder = { prepare: (sql: string) => ({ bind: (...binds: unknown[]) => ({
      all: async () => { statements.push({ sql, binds }); return { results: [] }; },
    }) }) } as unknown as RelationalStore;
    await projectRepositoryNeeded({ db: recorder } as ServerEnv, { projectId: 'proj_setup_parity' });
    const scoped = statements.find(({ sql }) => sql.includes('SELECT p.project_id AS projectId FROM projects p'));
    if (scoped === undefined) throw new Error('single-project repository query was not issued');
    expect(scoped.sql).toContain('p.project_id IN (?)');
    let next = 0;
    const inlined = scoped.sql.replace(/\?/g, () => {
      const value = scoped.binds[next++];
      return typeof value === 'number' ? String(value) : lit(String(value));
    });
    const plan = (await target.sql(`EXPLAIN QUERY PLAN ${inlined}`)).map((row) => String(row.detail)).join('\n');
    expect(plan).toMatch(/SEARCH p USING INDEX sqlite_autoindex_projects_1/);
    expect(plan).not.toMatch(/SCAN p\b/);
  },
};
