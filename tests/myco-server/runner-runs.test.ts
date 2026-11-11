/**
 * A runner's page of recent runs: every run it took across Projects, newest first, each with how it came out, paged by
 * cursor; the runner's last check-in beside them; and the same D1 cost at any length of runner history.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { runnerAttempts, runnerFacts } from '@myco-server-worker/db/runners/recent-runs.js';
import { RUNNER_RUNS_PAGE } from '@myco-server-worker/api/runner-runs.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
type Answer = Record<string, any>;

async function fixture() {
  const f = sqliteEnv();
  f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('agent', 'agent', 'built-in', 1, ?)`, [NOW]);
  f.sqlite.run(`UPDATE projects SET name = 'Second' WHERE project_id = 'proj_2'`);
  for (const id of ['rn_mini', 'rn_other']) f.sqlite.run('INSERT INTO runners (id, name, created_at) VALUES (?, ?, ?)', [id, id === 'rn_mini' ? 'homelab-mini' : 'studio', NOW]);
  f.sqlite.run(`INSERT INTO runner_contacts (runner_id, version, last_seen_at, updated_at) VALUES ('rn_mini', '2.0.0-alpha.24', ?, ?)`, [NOW - 8_000, NOW - 8_000]);
  /** A run in `project`, and each claim of it in order, by the runners named. */
  const run = (project: string, id: string, status: string, claims: string[], at: number, attempt = (index: number) => `${id}-${index}`) => {
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, started_at, completed_at)
      VALUES (?, ?, 'agent', 'canopy-map', ?, ?, ?, ?)`, [project, id, status, at - 1_000, at, status === 'running' ? null : at + 500]);
    claims.forEach((runner, index) => f.sqlite.run(`INSERT INTO agent_run_attempts (project_id, run_id, attempt_id, leased_by, claimed_at, owner_kind, runner_id)
      VALUES (?, ?, ?, 'credential', ?, 'runner', ?)`, [project, id, attempt(index), at + index * 10, runner]));
  };
  const get = async (path: string): Promise<{ status: number; body: Answer }> => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(f.db, Date.now()), 'cf-connecting-ip': '1.2.3.4' } }), { ...f.env, ...OWNER_ENV });
    return { status: res.status, body: await res.json() as Answer };
  };
  return { ...f, run, get };
}

describe('a runner’s recent runs', () => {
  it('lists every run it took across Projects, newest first, with how each came out and its last check-in', async () => {
    const f = await fixture();
    try {
      f.run('proj_1', 'mapped', 'completed', ['rn_mini'], NOW - 30 * MINUTE);
      f.run('proj_2', 'broke', 'failed', ['rn_mini'], NOW - 20 * MINUTE);
      f.run('proj_1', 'handed', 'completed', ['rn_mini', 'rn_other'], NOW - 10 * MINUTE);
      f.run('proj_1', 'live', 'running', ['rn_mini'], NOW - MINUTE);
      f.run('proj_1', 'elsewhere', 'completed', ['rn_other'], NOW - 5 * MINUTE);
      const { status, body } = await f.get('/api/runners/rn_mini/runs');
      expect(status).toBe(200);
      expect(body.runner).toMatchObject({ name: 'homelab-mini', lastSeenAt: NOW - 8_000, version: '2.0.0-alpha.24' });
      expect(body.rows.map((row: Answer) => [row.runId, row.projectName, row.outcome])).toEqual([
        ['live', expect.any(String), 'running'], ['handed', expect.any(String), 'handed_on'], ['broke', 'Second', 'failed'], ['mapped', expect.any(String), 'changed_nothing'],
      ]);
      expect(body.cursor).toBeNull();
      expect((await f.get('/api/runners/rn_other/runs')).body.rows.map((row: Answer) => [row.runId, row.outcome])).toEqual([['elsewhere', 'changed_nothing'], ['handed', 'changed_nothing']]);
    } finally { f.sqlite.close(); }
  });

  it('pages by cursor with no run listed twice or left out, claims at one instant by one credential included, and refuses what it cannot answer', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 3; i++) f.run('proj_1', `run-${i}`, 'completed', ['rn_mini'], NOW - i * MINUTE);
      // Two runs one credential claimed at the same instant: the page boundary falls between them.
      for (const id of ['same-a', 'same-b']) f.run('proj_1', id, 'completed', ['rn_mini'], NOW - 10 * MINUTE, () => 'credential-attempt');
      const pages: Answer[] = [];
      let cursor: string | null = null;
      do {
        const page: Answer = (await f.get(`/api/runners/rn_mini/runs?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`)).body;
        pages.push(page);
        cursor = page.cursor;
      } while (cursor !== null);
      expect(pages.flatMap((page) => page.rows.map((row: Answer) => row.runId))).toEqual(['run-0', 'run-1', 'run-2', 'same-b', 'same-a']);
      expect((await f.get('/api/runners/rn_unknown/runs')).status).toBe(404);
      const tooMany = await f.get(`/api/runners/rn_mini/runs?limit=${RUNNER_RUNS_PAGE + 1}`);
      expect({ status: tooMany.status, says: tooMany.body.reason.includes(`1 to ${RUNNER_RUNS_PAGE}`) }).toEqual({ status: 400, says: true });
      expect((await f.get('/api/runners/rn_mini/runs?cursor=nonsense')).status).toBe(400);
    } finally { f.sqlite.close(); }
  });
});

/** Each unit is one older run of the runner, in one of two Projects, with its claim. */
async function grow(db: RelationalStore, from: number, to: number) {
  await eachUnit(db, from, to, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,queued_at)
    SELECT 'proj_'||(i%2),'old-'||i,'agent','canopy-map','completed',?3-i*?4,?3-i*?4+1,?3-i*?4 FROM n`, NOW - 2 * RUNNER_RUNS_PAGE * MINUTE, MINUTE);
  await eachUnit(db, from, to, `INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,owner_kind,runner_id)
    SELECT 'proj_'||(i%2),'old-'||i,'old-'||i,'credential',?3-i*?4,'runner','rn_mini' FROM n`, NOW - 2 * RUNNER_RUNS_PAGE * MINUTE, MINUTE);
}

it('a page of a runner’s runs costs D1 the same as its history grows', async () => {
  expectTwoScale(await d1TwoScale({
    sizes: [500, 5_000],
    setup: async (db) => {
      for (const project of ['proj_0', 'proj_1']) await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
      await db.prepare("INSERT INTO runners(id,name,created_at) VALUES('rn_mini','homelab-mini',1)").run();
      await db.prepare("INSERT INTO runner_contacts(runner_id,last_seen_at,updated_at) VALUES('rn_mini',?1,?1)").bind(NOW).run();
    },
    grow,
    cases: [
      { name: 'newest page of a runner’s runs', run: async (db) => expect(await runnerAttempts(db, 'rn_mini', RUNNER_RUNS_PAGE + 1)).toHaveLength(RUNNER_RUNS_PAGE + 1) },
      { name: 'a later page of a runner’s runs', run: async (db) => expect(await runnerAttempts(db, 'rn_mini', RUNNER_RUNS_PAGE + 1,
        { claimedAt: NOW - 2 * RUNNER_RUNS_PAGE * MINUTE - 100 * MINUTE, attemptId: 'old-100', projectId: 'proj_0', runId: 'old-100' })).toHaveLength(RUNNER_RUNS_PAGE + 1) },
      { name: 'the runner and its last check-in', run: async (db) => expect(await runnerFacts(db, 'rn_mini')).toMatchObject({ last_seen_at: NOW }) },
    ],
  }));
}, 180_000);
