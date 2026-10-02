import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';

const NOW = 1_800_000_000_000;
const CALL_TIME = NOW - 1_000;
const OWN_MACHINE_NAME = 'Private build machine';

async function fixture() {
  const f = sqliteEnv();
  const sql: string[] = [];
  const env = {
    ...f.env, ...OWNER_ENV,
    db: {
      prepare: (statement: string) => { sql.push(statement); return f.db.prepare(statement); },
      batch: f.db.batch.bind(f.db),
    },
  };
  seedMemberRoleAccount(f.sqlite);
  f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('calls_agent', 'calls', 'built-in', 1, ?)`, [NOW]);
  f.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at, label) VALUES ('calls_machine', 'mem_machine_1', ?, ?)`, [NOW, OWN_MACHINE_NAME]);
  f.sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, runtime_label, issued_at, expires_at, lineage_root, lineage_started_at)
    VALUES ('calls_worker', 'mem_machine_1', 'calls-hash', 'calls_machine', ?, ?, ?, 'calls_worker', ?)`, [OWN_MACHINE_NAME, NOW, NOW + 86_400_000, NOW]);
  for (const projectId of ['proj_1', 'proj_2']) {
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, instruction, started_at, completed_at, leased_by)
      VALUES (?, 'calls_run', 'calls_agent', 'canopy-map', 'completed', 'Exact private launch prompt', ?, ?, 'calls_worker')`, [projectId, NOW - 2_000, NOW - 1_000]);
  }
  const call = (projectId: string, failed: boolean) => f.sqlite.run(`INSERT INTO agent_run_events (project_id, run_id, event_type, tool_name, outcome, payload, recorded_at)
    VALUES (?, 'calls_run', 'run_tool', 'myco_run_map', ?, ?, ?)`, [projectId, failed ? 'failed' : 'success', JSON.stringify({ op: failed ? 'write' : 'get', ...(failed ? { failure: { code: 'tool_call_failed', message: 'Map text must be a bounded nonempty line' } } : {}) }), CALL_TIME]);
  const get = async (path: string, sub?: string) => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { ...f, sql, get, call };
}

describe('the run calls-only API', () => {
  it('pages equal timestamps by event id with whole-run totals and no repeated call', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 201; i++) f.call('proj_1', i === 200);
      f.call('proj_2', true);
      const first = await f.get('/api/projects/proj_1/runs/calls_run/calls');
      expect(first.status).toBe(200);
      expect(first.body.rows).toHaveLength(200);
      expect(first.body).toMatchObject({ total: 201, failed: 1 });
      expect(first.body.cursor).not.toBeNull();
      const second = await f.get(`/api/projects/proj_1/runs/calls_run/calls?cursor=${encodeURIComponent(first.body.cursor)}`);
      expect(second.status).toBe(200);
      expect(second.body.rows).toHaveLength(1);
      expect(second.body).toMatchObject({ total: 201, failed: 1, cursor: null });
      const calls = [...first.body.rows, ...second.body.rows];
      expect(new Set(calls.map((call: { id: number }) => call.id)).size).toBe(201);
      expect(calls.map((call: { id: number }) => call.id)).toEqual([...calls.map((call: { id: number }) => call.id)].sort((a, b) => a - b));
      expect(second.body.rows[0]).toMatchObject({ status: 'failed', recordedAt: CALL_TIME, failure: { message: 'Map text must be a bounded nonempty line' } });
    } finally { f.sqlite.close(); }
  });

  it('serves only call evidence to a member, without reading the full run detail or exposing machine names', async () => {
    const f = await fixture();
    try {
      f.call('proj_1', false);
      const answer = await f.get('/api/projects/proj_1/runs/calls_run/calls?limit=1', MEMBER_SUB);
      expect(answer.status).toBe(200);
      expect(Object.keys(answer.body).sort()).toEqual(['cursor', 'failed', 'rows', 'total']);
      expect(JSON.stringify(answer.body)).not.toContain(OWN_MACHINE_NAME);
      expect(JSON.stringify(answer.body)).not.toContain('Exact private launch prompt');
      expect(f.sql.filter((statement) => /canopy_maps|agent_reports|run_reads|source_branch|requested_profile|SELECT machine_id, label FROM machine_claims/.test(statement))).toEqual([]);
    } finally { f.sqlite.close(); }
  });

  it('distinguishes an empty scoped run from a missing run or project and validates paging', async () => {
    const f = await fixture();
    try {
      const empty = await f.get('/api/projects/proj_1/runs/calls_run/calls');
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ rows: [], total: 0, failed: 0, cursor: null });
      f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_2', 'only_elsewhere', 'calls_agent', 'canopy-map', 'running', ?)`, [NOW]);
      for (const path of ['/api/projects/proj_1/runs/missing/calls', '/api/projects/proj_1/runs/only_elsewhere/calls', '/api/projects/unknown/runs/calls_run/calls']) {
        expect((await f.get(path)).status).toBe(404);
      }
      for (const query of ['cursor=invalid', 'limit=abc', 'limit=-1']) {
        expect((await f.get(`/api/projects/proj_1/runs/calls_run/calls?${query}`)).status).toBe(400);
      }
    } finally { f.sqlite.close(); }
  });
});
