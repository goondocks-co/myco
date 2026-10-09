import { expect } from 'bun:test';
import { MEMBER_ID, lit, type ParityScenario } from '../harness.ts';

/** Local workerd/D1 counts examined rows for the shipped fleet projection. */
export const fleetReadBudget: ParityScenario = {
  name: 'runner fleet: D1 rows read stay bounded as member credentials accumulate',
  dedicated: { cloudflare: { main: '../../tests/parity/fleet-budget/worker-entry.ts' }, timeoutMs: 240_000 },
  async run(target) {
    if (target.name !== 'cloudflare') return;
    const measure = async () => {
      const response = await fetch(`${target.url}/__fleet-read-budget`);
      expect(response.status).toBe(200);
      return await response.json() as { rowsRead: number; workers: number; queued: number };
    };
    const seed = async (start: number, count: number) => {
      await target.sql(`WITH RECURSIVE n(x) AS (SELECT ${start} UNION ALL SELECT x + 1 FROM n WHERE x < ${start + count - 1})
        INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
        SELECT 'mt_fleet_budget_' || x, ${lit(MEMBER_ID)}, NULL, 'fleet_budget_hash_' || x, 1, 2,
          'mt_fleet_budget_' || x, 1 FROM n`);
    };
    const now = Date.now();
    await target.sql(`INSERT INTO runners(id,name,created_at,created_by_member,registration_id)
      VALUES ('rn_fleet_budget','Fleet budget runner',${now},${lit(MEMBER_ID)},'request_fleet_budget')`);
    await target.sql(`INSERT INTO runner_credentials(id,runner_id,token_hash,epoch,issued_at,expires_at,lineage_root)
      VALUES ('rc_fleet_budget','rn_fleet_budget','hash_fleet_budget',1,${now},${now + 86_400_000},'rc_fleet_budget')`);
    await target.sql(`INSERT INTO runner_contacts(runner_id,offers,capabilities,last_seen_at,updated_at)
      VALUES ('rn_fleet_budget','[{"id":"claude-code","authenticated":true}]','[]',${now},${now})`);
    await target.sql(`INSERT INTO agents(id,name,created_at) VALUES ('agent_fleet_budget','Fleet budget agent',${now})`);
    await target.sql(`INSERT INTO agent_runs(id,project_id,agent_id,task,status,queued_at,held_by,instruction)
      VALUES ('run_fleet_budget',${lit(target.projectId)},'agent_fleet_budget','title-summary','queued',${now},'worker','budget')`);
    await seed(1, 400);
    const small = await measure();
    await seed(401, 1600);
    const large = await measure();
    const oldQuery = await (await fetch(`${target.url}/__fleet-read-budget?old_inventory_query=1`)).json() as { rowsRead: number };
    expect(large.workers).toBe(small.workers);
    expect(large.workers).toBeGreaterThan(0);
    expect(large.queued).toBe(1);
    expect(large.rowsRead).toBe(small.rowsRead);
    expect(large.rowsRead).toBeLessThan(200);
    expect(oldQuery.rowsRead).toBeGreaterThan(large.rowsRead + 1000);
    console.info(`fleet D1 rows_read: 400 credentials ${small.rowsRead}; 2000 credentials ${large.rowsRead}; old OR join ${oldQuery.rowsRead}`);
  },
};
