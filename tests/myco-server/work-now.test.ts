/**
 * What Myco is doing now (`/api/work/now`, `read/work-now.ts`): a running run with its latest step, each reason work
 * waits under in the server's own words, and a needs-you item that clears once a later run succeeds.
 */
import { describe, expect, it } from 'bun:test';
import { HELD_BY_WORDS } from '@goondocks/myco-shared/run-holds';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { offeredHarness } from './helpers/offered-harness.js';
import worker from '@myco-server-worker/index.js';
import { readWorkNow } from '@myco-server-worker/read/work-now.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function harness() {
  const fixture = sqliteEnv();
  const { sqlite } = fixture;
  sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, ?)`, [NOW]);
  for (const id of ['proj_1', 'proj_2']) sqlite.run('INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, 1)', [id, id]);
  sqlite.run("INSERT INTO runners(id,name,created_at) VALUES('rn_mini','homelab-mini',1)");
  sqlite.run(`INSERT INTO runner_credentials(id,runner_id,token_hash,epoch,issued_at,expires_at,lineage_root) VALUES('rc_mini','rn_mini','fixture',1,?,?,'rc_mini')`, [NOW, NOW + HOUR]);
  const run = (project: string, id: string, task: string, status: string, at: number, over: { heldBy?: string; error?: string; runner?: string } = {}) =>
    sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, origin, started_at, completed_at, queued_at, held_by, error, model, leased_runner_id, leased_runner_credential_id)
      VALUES (?, ?, 'agent_1', ?, ?, 'automatic', ?, ?, ?, ?, ?, 'claude-sonnet-4-5', ?, ?)`,
    [project, id, task, status, status === 'queued' ? null : at, status === 'queued' || status === 'running' ? null : at + 1000,
      at, over.heldBy ?? null, over.error ?? null, over.runner ?? null, over.runner === undefined ? null : 'rc_mini']);
  const call = (project: string, runId: string, tool: string, payload: Record<string, unknown>, at: number, outcome = 'success') =>
    sqlite.run(`INSERT INTO agent_run_events (project_id, run_id, event_type, tool_name, outcome, payload, recorded_at) VALUES (?, ?, 'run_tool', ?, ?, ?, ?)`,
      [project, runId, tool, outcome, JSON.stringify(payload), at]);
  const read = (scope: { projectId: string } | { all: true } = { projectId: 'proj_1' }, now = NOW) =>
    readWorkNow(fixture.serverEnv as never, scope, now, true);
  return { fixture, sqlite, run, call, read };
}

describe('Myco’s work now', () => {
  it('lists a running run with its machine, model and latest step in plain words', async () => {
    const h = harness();
    h.run('proj_1', 'run_live', 'curate-spores', 'running', NOW - 2 * MINUTE, { runner: 'rn_mini' });
    h.call('proj_1', 'run_live', 'myco_run_spores', { op: 'list' }, NOW - 90_000);
    h.call('proj_1', 'run_live', 'myco_spores', { op: 'supersede' }, NOW - 30_000);
    const answer = await h.read();
    expect(answer.running).toEqual([{
      runId: 'run_live', projectId: 'proj_1', task: 'curate-spores', what: 'Curate overlapping spores', machine: 'homelab-mini',
      harness: null, model: 'claude-sonnet-4-5', startedAt: NOW - 2 * MINUTE, step: { words: 'Replaced a spore', at: NOW - 30_000 },
    }]);
    expect(answer.unavailable).toEqual([]);
    expect((await h.read({ projectId: 'proj_2' })).running).toEqual([]);
  });

  it('says why each kind of work waits, in the server’s words', async () => {
    const h = harness();
    h.run('proj_1', 'run_budget', 'extract-curate', 'queued', NOW - HOUR, { heldBy: 'budget' });
    h.run('proj_1', 'run_title', 'title-summary', 'queued', NOW - HOUR);
    h.sqlite.run("INSERT INTO project_capabilities VALUES ('proj_1','spore_curation',1,1,'fixture'), ('proj_1','canopy',1,1,'fixture')");
    h.sqlite.run("INSERT INTO project_settings (project_id, leaf, value, updated_at, updated_by) VALUES ('proj_1', 'agent.spore_curation.daily_runs', '2', 1, 'owner')");
    h.sqlite.run(`INSERT INTO spore_curation_work (project_id, cluster_key, members, due_at, failures) VALUES ('proj_1', 'k1', '[]', ?, 0)`, [NOW - MINUTE]);
    h.run('proj_1', 'cur_1', 'curate-spores', 'completed', NOW - 5 * HOUR);
    h.run('proj_1', 'cur_2', 'curate-spores', 'completed', NOW - 3 * HOUR);
    h.sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')");
    h.run('proj_1', 'map_1', 'canopy-map', 'completed', NOW - 2 * HOUR);
    const byWhat = new Map((await h.read()).waiting.map((item) => [item.what, item]));
    expect(byWhat.get('Learn from sessions')).toMatchObject({ projectId: 'proj_1', count: 1, why: HELD_BY_WORDS.budget, since: NOW - HOUR });
    expect(byWhat.get('Title and summarize sessions')?.why).toBe('No recently seen runner can currently take this work.');
    expect(byWhat.get('Curation')).toMatchObject({ why: 'Paused: 2 of 2 curation runs in the last 24 hours. The next starts as the earliest leaves that window.', nextAt: NOW - 5 * HOUR + 24 * HOUR });
    expect(byWhat.get('Code map')).toMatchObject({ why: 'It refreshes every 6 hours, and only after new session material arrives. None has arrived since the last refresh.', nextAt: null });
    expect((await h.read({ all: true })).waiting.filter((item) => item.what === 'Code map')).toEqual([]);
    h.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', 's_new', 'm1', 'tok_1', ?, ?)`, [NOW - HOUR, NOW - HOUR]);
    expect((await h.read({ all: true })).waiting.find((item) => item.what === 'Code map')).toMatchObject({
      projectId: 'proj_1', why: 'It refreshes every 6 hours. New session material has arrived since the last refresh.', nextAt: NOW - 2 * HOUR + 6 * HOUR });
    expect(byWhat.size).toBe(4);
  });

  it('says a runner can’t sign in, and names a failure by its own refusal until a later run succeeds', async () => {
    const h = harness();
    h.sqlite.run(`INSERT INTO runner_contacts(runner_id,offers,capabilities,last_reason,last_seen_at,updated_at) VALUES('rn_mini',?,?,'no_harness',?,?)`,
      [JSON.stringify([{ ...offeredHarness('claude-code'), authenticated: false }]), JSON.stringify(WORKER_CAPABILITIES), NOW, NOW]);
    h.run('proj_1', 'learn_1', 'extract-curate', 'failed', NOW - 2 * HOUR, { error: 'the run ended without its artifact' });
    h.run('proj_1', 'learn_2', 'extract-curate', 'failed', NOW - HOUR, { error: 'the run ended without its artifact' });
    h.call('proj_1', 'learn_2', 'myco_spores', { op: 'save', failure: { code: 'invalid_input', message: 'agent_line was 171 characters; the limit is 158.' } }, NOW - HOUR + 1000, 'failed');
    const needs = (await h.read()).needsYou;
    expect(needs.find((item) => item.key === 'failed:proj_1:extract-curate')).toEqual({
      key: 'failed:proj_1:extract-curate', projectId: 'proj_1', what: 'Learn from sessions failed twice in a row',
      why: 'agent_line was 171 characters; the limit is 158.', at: NOW - HOUR + 1000, runId: 'learn_2', retryAt: null,
    });
    expect(needs.find((item) => item.key === 'sign-in:rn_mini')).toMatchObject({ projectId: null, what: 'homelab-mini can’t sign in to a coding agent' });

    h.run('proj_1', 'learn_3', 'extract-curate', 'completed', NOW - MINUTE);
    expect((await h.read()).needsYou.map((item) => item.key)).toEqual(['sign-in:rn_mini']);
  });

  it('lists a failing curation group with its refusal and when Myco tries again, and drops it once decided', async () => {
    const h = harness();
    h.sqlite.run("INSERT INTO project_capabilities VALUES ('proj_1','spore_curation',1,1,'fixture')");
    h.run('proj_1', 'cur_fail', 'curate-spores', 'failed', NOW - HOUR, { error: 'the run ended without its decision' });
    h.call('proj_1', 'cur_fail', 'myco_spores', { op: 'consolidate', failure: { code: 'invalid_input', message: 'agent_line was 171 characters; the limit is 158.' } }, NOW - HOUR + 500, 'failed');
    h.sqlite.run(`INSERT INTO spore_curation_work (project_id, cluster_key, members, due_at, failures, run_id) VALUES ('proj_1', 'k1', '[]', ?, 2, 'cur_fail')`, [NOW + 2 * HOUR]);
    const answer = await h.read({ all: true });
    expect(answer.needsYou).toEqual([{
      key: 'curation-group:proj_1:k1', projectId: 'proj_1', what: 'A curation group failed twice',
      why: 'agent_line was 171 characters; the limit is 158.', at: NOW, runId: 'cur_fail', retryAt: NOW + 2 * HOUR,
    }]);
    expect(answer.waiting.filter((item) => item.what === 'Curation')).toEqual([]);
    h.sqlite.run("UPDATE spore_curation_work SET due_at = NULL, decision = 'keep', reason = 'kept apart', decided_at = ? WHERE cluster_key = 'k1'", [NOW]);
    h.run('proj_1', 'cur_ok', 'curate-spores', 'completed', NOW - MINUTE);
    expect((await h.read({ all: true })).needsYou).toEqual([]);
  });

  it('moves its runs mark when a run starts or ends, and answers a member over the route', async () => {
    const h = harness();
    const before = (await h.read()).marks;
    h.run('proj_1', 'run_new', 'title-summary', 'running', NOW);
    const started = (await h.read()).marks;
    expect(started.runs).not.toBe(before.runs);
    expect(started.sessions).toBe(before.sessions);
    h.sqlite.run("UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE id = 'run_new'", [NOW + 1]);
    expect((await h.read()).marks.runs).not.toBe(started.runs);

    const env = { ...h.fixture.env, ...OWNER_ENV };
    const get = async (path: string) => {
      const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(h.fixture.db, Date.now()), 'cf-connecting-ip': '1.2.3.4' } }), env);
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    expect(await get('/api/work/now?project=proj_1')).toMatchObject({ status: 200, body: { scope: 'project', unavailable: [] } });
    expect(await get('/api/work/now')).toMatchObject({ status: 200, body: { scope: 'deployment' } });
    expect((await get('/api/work/now?project=proj_1&project=proj_2')).status).toBe(400);
    expect((await get('/api/work/now?project=proj_missing')).status).toBe(404);
  });
});
