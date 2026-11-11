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
import { completeBudgetMigration } from '@myco-server-worker/db/meta/budget-activation.js';
import { LAST_REQUEST_KEY } from '@myco-server-worker/core/activity.js';
import { estimateKey } from '@myco-server-worker/core/budget-estimates.js';
import { PROFILE_HARNESSES } from '@goondocks/myco-shared/execution-profile';
import { claimNextRun } from '@myco-server-worker/core/harness.js';
import { PULLED_BUDGET_HOLD_MS } from '@myco-server-worker/db/runs/pulled-budget-hold.js';

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
  it('names pulled work by its real deadline and Project, excludes capacity holds and skips pricing without an execution', async () => {
    const h = harness();
    await completeBudgetMigration(h.fixture.db, NOW);
    h.sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')");
    const pending = (project: string, deadline: number) => {
      h.sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,ended_at) VALUES(?1,?1,'m1','tok_1',?2,?2,?2)", [project, NOW - 2 * HOUR]);
      h.sqlite.run("INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at) VALUES(?1,?1,'ready',?2)", [project, NOW - 2 * HOUR]);
      h.sqlite.run("INSERT INTO turn_cards(project_id,session_id,turn_key,due_at,created_at) VALUES(?1,?1,'turn',?2,?3)", [project, deadline, NOW - 2 * HOUR]);
    };
    pending('proj_1', NOW - MINUTE);
    pending('proj_2', NOW - HOUR);
    const needs = async (scope?: Parameters<typeof h.read>[0]) => (await h.read(scope)).needsYou.filter(item => item.key.startsWith('pulled:'));
    expect(await needs()).toEqual([]);
    h.sqlite.run("UPDATE turn_cards SET due_at=? WHERE project_id='proj_1'", [NOW - HOUR]);
    expect(await needs()).toEqual([{ key: 'pulled:proj_1:turn-cards', projectId: 'proj_1',
      what: 'Summarize session turns has waited 60 minutes with no machine taking it', why: 'Open Runners to check that a machine is available and signed in to a coding agent.',
      at: NOW - HOUR, runId: null, retryAt: null }]);
    expect((await needs({ all: true })).map(item => item.projectId).sort()).toEqual(['proj_1', 'proj_2']);
    h.sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.limits.concurrent_runs','1',1,'owner')");
    h.run('proj_2', 'busy', 'title-summary', 'running', NOW - MINUTE);
    expect(await needs()).toEqual([]);
    h.sqlite.run("UPDATE agent_runs SET status='completed',completed_at=? WHERE id='busy'", [NOW]);
    expect(await needs()).toHaveLength(1);
    h.sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.budget.daily_usd','1',1,'owner')");
    h.sqlite.run("INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,cost_usd,cost_source) VALUES('proj_2','busy','spent','fixture',?,1,'actual')", [NOW - MINUTE]);
    expect(await needs()).toHaveLength(1);
  });

  it('shows the claim’s Deployment-wide budget hold across Projects, expires it and clears it on a successful claim', async () => {
    const h = harness();
    await completeBudgetMigration(h.fixture.db, NOW);
    h.sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')");
    for (const project of ['proj_1', 'proj_2']) {
      h.sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,ended_at) VALUES(?1,?1,'m1','tok_1',?2,?2,?2)", [project, NOW - 2 * HOUR]);
      h.sqlite.run("INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at) VALUES(?1,?1,'ready',?2)", [project, NOW - 2 * HOUR]);
      h.sqlite.run("INSERT INTO turn_cards(project_id,session_id,turn_key,state,input_hash,card,signal,created_at,carded_at) VALUES(?1,?1,'turn','carded','input',?3,'high',?2,?2)", [project, NOW - HOUR,
        JSON.stringify({ asked: 'Keep the lesson', done: 'Recorded the fix', outcome: 'done', decisions: [], rejected: [], errors: [], corrections: [], files: [], commands: [], open_questions: [] })]);
      h.sqlite.run("UPDATE learning_sessions SET eligible_at=?2,learning_promoted_at=?2 WHERE project_id=?1", [project, NOW - HOUR]);
    }
    h.sqlite.run("INSERT INTO project_capabilities VALUES('proj_1','spore_curation',1,1,'owner')");
    h.sqlite.run("INSERT INTO spore_curation_work(project_id,cluster_key,members,due_at) VALUES('proj_1','group','[]',?)", [NOW - 45 * MINUTE]);
    expect((await h.read()).needsYou.filter(item => item.key.startsWith('pulled:'))).toMatchObject([
      { what: 'Learn from sessions has waited 60 minutes with no machine taking it', at: NOW - HOUR },
      { what: 'Curate overlapping spores has waited 45 minutes with no machine taking it', at: NOW - 45 * MINUTE },
    ]);
    h.sqlite.run("INSERT INTO runners(id,name,created_at) VALUES('rn_price','priced runner',1)");
    h.sqlite.run("INSERT INTO runner_credentials(id,runner_id,token_hash,epoch,issued_at,expires_at,lineage_root) VALUES('rc_price','rn_price','priced-fixture',1,?1,?2,'rc_price')", [NOW, NOW + HOUR]);
    h.sqlite.run("INSERT INTO runner_contacts(runner_id,offers,capabilities,last_reason,last_seen_at,updated_at) VALUES('rn_price',?1,?2,'no_work',?3,?3)",
      [JSON.stringify([offeredHarness('claude-code')]), JSON.stringify(WORKER_CAPABILITIES), NOW]);
    h.sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,1)");
    const key = estimateKey('extract-curate', 'claude-code', { tier: 'default', model: PROFILE_HARNESSES['claude-code']!.models.default! });
    h.sqlite.run("INSERT INTO agent_state(project_id,agent_id,key,value,updated_at) VALUES('proj_1','myco-agent',?1,?2,?3),('proj_2','myco-agent',?1,?4,?3)", [key, JSON.stringify({ estimate: 1.2 }), NOW, JSON.stringify({ estimate: 0.4 })]);
    h.sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.budget.daily_usd','2',1,'owner')");
    h.run('proj_2', 'spent', 'title-summary', 'completed', NOW - MINUTE);
    h.sqlite.run("INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,cost_usd,cost_source) VALUES('proj_2','spent','priced-spend','fixture',?,1.2,'actual')", [NOW - MINUTE]);
    const poll = (now: number) => claimNextRun(h.fixture.serverEnv, {
      principal: { kind: 'runner', runnerId: 'rn_price', credentialId: 'rc_price', machineId: null },
      harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now,
    });
    expect((await h.read({ projectId: 'proj_2' })).needsYou).toContainEqual(expect.objectContaining({ key: 'pulled:proj_2:extract-curate' }));
    expect(await poll(NOW)).toMatchObject({ claimed: false });
    const held = await h.read({ projectId: 'proj_2' });
    expect(held.unavailable).toEqual([]);
    expect(held.needsYou.filter(item => item.key.startsWith('pulled:'))).toEqual([]);
    expect(held.waiting.filter(item => item.key === 'budget')).toMatchObject([{ projectId: null,
      why: 'Paused: the rolling 24-hour budget has no room for the next automatic run. It resumes as earlier spending leaves the window.' }]);
    h.sqlite.run("UPDATE agent_state SET value=?1 WHERE project_id='proj_1' AND key=?2", [JSON.stringify({ estimate: 3 }), key]);
    expect(await poll(NOW + 1)).toMatchObject({ claimed: false });
    expect((await h.read({ projectId: 'proj_2' }, NOW + 1)).waiting.find(item => item.key === 'budget')?.why)
      .toBe('The next learn from sessions run needs about $3.00, more than the whole daily budget of $2.00. Raise the daily budget in Settings.');
    const expiredAt = NOW + PULLED_BUDGET_HOLD_MS + 2;
    expect((await h.read({ projectId: 'proj_2' }, expiredAt)).needsYou).toContainEqual(expect.objectContaining({ key: 'pulled:proj_2:extract-curate' }));
    expect(await poll(expiredAt + 1)).toMatchObject({ claimed: false });
    h.sqlite.run("UPDATE agent_state SET value=?1 WHERE project_id='proj_1' AND key=?2", [JSON.stringify({ estimate: 0.2 }), key]);
    expect(await poll(expiredAt + 2)).toMatchObject({ claimed: true, run: { task: 'extract-curate' } });
    const resumed = await h.read({ projectId: 'proj_2' }, expiredAt + 3);
    expect(resumed.waiting.find(item => item.key === 'budget')).toBeUndefined();
    expect(resumed.needsYou).toContainEqual(expect.objectContaining({ key: 'pulled:proj_2:extract-curate' }));
    h.sqlite.run("UPDATE project_capabilities SET enabled=0 WHERE capability='spore_curation'");
    h.sqlite.run("UPDATE deployment_settings SET value='false' WHERE leaf='agent.scheduled_tasks_enabled'");
    expect((await h.read()).needsYou).toEqual([]);
  });
  it('lists a running run with its machine, its last check-in, model and latest step in plain words', async () => {
    const h = harness();
    h.run('proj_1', 'run_live', 'curate-spores', 'running', NOW - 2 * MINUTE, { runner: 'rn_mini' });
    h.sqlite.run("INSERT INTO runner_contacts(runner_id,last_seen_at,updated_at) VALUES('rn_mini',?1,?1)", [NOW - 8_000]);
    h.call('proj_1', 'run_live', 'myco_run_spores', { op: 'list' }, NOW - 90_000);
    h.call('proj_1', 'run_live', 'myco_spores', { op: 'supersede' }, NOW - 30_000);
    const answer = await h.read();
    expect(answer.running).toEqual([{
      runId: 'run_live', projectId: 'proj_1', task: 'curate-spores', what: 'Curate overlapping spores', machine: 'homelab-mini', runnerId: 'rn_mini', heardAt: NOW - 8_000,
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
    h.sqlite.run(`INSERT INTO spore_curation_work (project_id, cluster_key, members, failures, first_started_at, decision, reason, decided_at)
      VALUES ('proj_1', 'd1', '[]', 1, ?, 'keep', 'kept apart', ?), ('proj_1', 'd2', '[]', 1, ?, 'resolved', 'merged', ?)`, [NOW - 5 * HOUR, NOW - 5 * HOUR, NOW - 3 * HOUR, NOW - 3 * HOUR]);
    h.sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')");
    h.run('proj_1', 'map_1', 'canopy-map', 'completed', NOW - 2 * HOUR);
    const answer = await h.read();
    const byWhat = new Map(answer.waiting.map((item) => [item.what, item]));
    expect(answer.needsYou.filter((item) => item.key.startsWith('unclaimed:'))).toEqual([{ key: 'unclaimed:proj_1:title-summary', projectId: 'proj_1',
      what: 'Title and summarize sessions has waited 60 minutes with no machine taking it', why: `One run is due. ${HELD_BY_WORDS.worker}`, at: NOW - HOUR, runId: 'run_title', retryAt: null }]);
    expect(byWhat.get('Learn from sessions')).toMatchObject({ projectId: 'proj_1', count: 1, why: HELD_BY_WORDS.budget, since: NOW - HOUR });
    expect(byWhat.get('Title and summarize sessions')?.why).toBe('No recently seen runner can currently take this work.');
    expect(byWhat.get('Curation')).toMatchObject({ why: 'Paused: 2 of 2 new curation groups started in the last 24 hours. The next starts as the earliest leaves that window; a group that failed retries meanwhile.', nextAt: NOW - 5 * HOUR + 24 * HOUR });
    expect(byWhat.get('Code map')).toMatchObject({ why: 'It refreshes every 6 hours, and only after new session material arrives. None has arrived since the last refresh.', nextAt: null });
    expect((await h.read({ all: true })).waiting.filter((item) => item.what === 'Code map')).toEqual([]);
    h.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', 's_new', 'm1', 'tok_1', ?, ?)`, [NOW - HOUR, NOW - HOUR]);
    expect((await h.read({ all: true })).waiting.find((item) => item.what === 'Code map')).toMatchObject({
      projectId: 'proj_1', why: 'It refreshes every 6 hours. New session material has arrived since the last refresh.', nextAt: NOW - 2 * HOUR + 6 * HOUR });
    expect(byWhat.size).toBe(4);
  });

  it('names queued work no machine took, and not work its Project turned off or a busy fleet holds', async () => {
    const h = harness();
    h.sqlite.run("INSERT INTO project_capabilities VALUES ('proj_1','canopy',0,1,'fixture')");
    h.run('proj_1', 'run_map', 'canopy-map', 'queued', NOW - HOUR, { heldBy: 'worker' });
    h.run('proj_1', 'run_busy', 'title-summary', 'queued', NOW - HOUR, { heldBy: 'fleet' });
    h.run('proj_2', 'run_title', 'title-summary', 'queued', NOW - HOUR, { heldBy: 'worker' });
    expect((await h.read({ all: true }, NOW)).needsYou.filter((item) => item.key.startsWith('unclaimed:')).map((item) => item.key)).toEqual(['unclaimed:proj_2:title-summary']);
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

    const stamp = () => h.sqlite.query(`SELECT value FROM schema_meta WHERE key = ?`).get(LAST_REQUEST_KEY);
    const ask = async (path: string, headers: Record<string, string> = {}) => (await worker.fetch(new Request(`https://s${path}`, {
      headers: { cookie: await ownerCookie(h.fixture.db, Date.now()), 'cf-connecting-ip': '1.2.3.4', ...headers } }), env)).status;
    h.sqlite.run('DELETE FROM schema_meta WHERE key = ?', [LAST_REQUEST_KEY]);
    expect(await ask('/api/work/now?project=proj_1', { 'x-myco-automatic': '1' })).toBe(200);
    expect(stamp()).toBeNull();
    expect(await ask('/api/presence')).toBe(200);
    expect(stamp()).not.toBeNull();
  });

  it('says the budget holds automatic work from the governor’s own holds, and why a run can never fit', async () => {
    const h = harness();
    expect((await completeBudgetMigration(h.fixture.db, NOW)).active).toBe(true);
    h.run('proj_1', 'run_held', 'extract-curate', 'queued', NOW - HOUR, { heldBy: 'budget' });
    expect((await h.read()).waiting.find((item) => item.key === 'budget')).toMatchObject({ projectId: null, what: 'Automatic work',
      why: 'Paused: the rolling 24-hour budget has no room for the next automatic run. It resumes as earlier spending leaves the window.' });
    h.sqlite.run(`UPDATE agent_runs SET run_context = json_object('budgetEstimateUsd', 500) WHERE id = 'run_held'`);
    expect((await h.read()).waiting.find((item) => item.key === 'budget')?.why).toMatch(/^The next learn from sessions run needs about \$500\.00, more than the whole daily budget of \$[0-9.]+\. Raise the daily budget in Settings\.$/);
  });

  it('shows a project’s due learning in its own scope, by the same status line as every project', async () => {
    const h = harness();
    h.sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_1','waiting','m1','tok_1',?,?)", [NOW - 1000, NOW - 1000]);
    h.sqlite.run("INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at,pending_cards) VALUES('proj_1','waiting','ready',?,1)", [NOW - 1000]);
    const project = (await h.read()).waiting.find((item) => item.key === 'learning');
    const deployment = (await h.read({ all: true })).waiting.find((item) => item.key === 'learning');
    expect(project).toMatchObject({ projectId: 'proj_1', what: 'Learning from sessions' });
    expect(project?.why).toContain('1 turn waiting to be summarized');
    expect(deployment?.why).toContain('1 turn waiting to be summarized');
    expect((await h.read({ projectId: 'proj_2' })).waiting.find((item) => item.key === 'learning')).toBeUndefined();
  });

  it('names a failing curation group by its own outstanding refusal, beside the next group still due', async () => {
    const h = harness();
    h.sqlite.run("INSERT INTO project_capabilities VALUES ('proj_1','spore_curation',1,1,'fixture')");
    h.run('proj_1', 'cur_fail', 'curate-spores', 'failed', NOW - HOUR, { error: 'the run ended without its decision' });
    h.sqlite.run(`INSERT INTO spore_curation_work (project_id, cluster_key, members, due_at, failures, run_id, first_started_at, write_refusal)
      VALUES ('proj_1', 'g', '[]', ?, 1, 'cur_fail', ?, ?), ('proj_1', 'n', '[]', ?, 0, NULL, NULL, NULL)`,
      [NOW + HOUR, NOW - HOUR, JSON.stringify({ error: 'Not saved: agent_line is 171 characters; the limit is 158.' }), NOW - MINUTE]);
    const answer = await h.read();
    expect(answer.needsYou).toMatchObject([{ key: 'curation-group:proj_1:g', what: 'A curation group failed once',
      why: 'Not saved: agent_line is 171 characters; the limit is 158.', retryAt: NOW + HOUR }]);
    expect(answer.waiting.find((item) => item.what === 'Curation')?.why).toBe('A group of overlapping spores is due; it starts when the server next checks, inside the daily budget.');
  });

  it('moves its knowledge mark when a spore is edited or retired, and its recovery mark as a backup advances', async () => {
    const h = harness();
    h.sqlite.run("INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', 's1', 'm1', 'tok_1', ?, ?)", [NOW, NOW]);
    h.sqlite.run("INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, author, created_at) VALUES ('proj_1', 'sp1', 'agent_1', 's1', 'gotcha', 'active', 'x', 'agent_1', ?)", [NOW - HOUR]);
    const saved = (await h.read()).marks.knowledge;
    h.sqlite.run("UPDATE spores SET content = 'y', revision = revision + 1, updated_at = ? WHERE id = 'sp1'", [NOW]);
    const edited = (await h.read()).marks.knowledge;
    expect(edited).not.toBe(saved);
    h.sqlite.run("UPDATE spores SET status = 'obsolete', revision = revision + 1, updated_at = ? WHERE id = 'sp1'", [NOW + 1]);
    expect((await h.read()).marks.knowledge).not.toBe(edited);

    let stage = 'export';
    const recovery = { status: async () => ({ attempt: 7, stage, form: 'staging', startedAt: NOW - MINUTE, recoverable: false, staged: { prefix: 'p', sqlBytes: null, downloadedBytes: 0, parts: 0 } }) };
    const read = () => readWorkNow({ ...h.fixture.serverEnv, recovery } as never, { all: true }, NOW, true);
    const copying = await read();
    expect(copying.waiting.find((item) => item.key === 'backup')?.why).toBe('A backup is copying the database. Work that reads it waits until the copy finishes.');
    stage = 'complete';
    const done = await read();
    expect(done.marks.recovery).not.toBe(copying.marks.recovery);
    expect(done.waiting.find((item) => item.key === 'backup')).toBeUndefined();
  });

  it('settles a curation failure once its group is decided, and keeps a group curation gave up on', async () => {
    const h = harness();
    h.sqlite.run("INSERT INTO project_capabilities VALUES ('proj_1','spore_curation',1,1,'fixture')");
    h.run('proj_1', 'cur_fail', 'curate-spores', 'failed', NOW - HOUR, { error: 'the run ended without its decision' });
    h.sqlite.run(`INSERT INTO spore_curation_work (project_id, cluster_key, members, due_at, failures, run_id) VALUES ('proj_1', 'g', '[]', ?, 2, 'cur_fail')`, [NOW + HOUR]);
    expect((await h.read()).needsYou.map((item) => item.key)).toEqual(['curation-group:proj_1:g']);
    h.sqlite.run("UPDATE spore_curation_work SET due_at = NULL, decision = 'changed', reason = 'member revision changed', decided_at = ?", [NOW]);
    expect((await h.read()).needsYou).toEqual([]);
    h.sqlite.run("UPDATE spore_curation_work SET decision = 'failed', reason = 'Curation stopped after 3 attempts without a decision'");
    expect((await h.read()).needsYou).toMatchObject([{ key: 'failed:proj_1:curate-spores', what: 'Curation stopped on a group without a decision',
      why: 'Curation stopped after 3 attempts without a decision', runId: 'cur_fail' }]);
  });

  it('pages Projects with unresolved work first and reports the exact coverage', async () => {
    const h = harness();
    for (let i = 0; i < 30; i += 1) h.sqlite.run('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, 1)', [`a_project_${String(i).padStart(2, '0')}`, `Earlier ${i}`]);
    h.run('proj_2', 'hidden_failure', 'extract-curate', 'failed', NOW - 1000, { error: 'the run ended without its artifact' });
    const answer = await h.read({ all: true });
    expect(answer.needsYou.map(item => item.key)).toEqual(['failed:proj_2:extract-curate']);
    expect(answer.projects).toMatchObject({ read: 25, total: 32, hasMore: true });
    const next = await readWorkNow(h.fixture.serverEnv as never, { all: true }, NOW, true, answer.projects.cursor);
    expect(next.needsYou).toEqual([]);
    expect(next.projects).toMatchObject({ read: 7, total: 32, hasMore: false });
    expect((await h.read()).projects).toEqual({ read: 1, total: 1, hasMore: false, cursor: null });
  });
  it('reads an archived Project on its own Today page and describes a coded failure in words', async () => {
    const h = harness();
    h.run('proj_1', 'failure', 'extract-curate', 'failed', NOW - HOUR);
    h.sqlite.run("UPDATE agent_runs SET error_code='task_start_failed' WHERE id='failure'");
    h.sqlite.run("UPDATE projects SET archived_at=? WHERE project_id='proj_1'", [NOW]);
    const own = await h.read();
    expect(own.projects).toEqual({ read: 1, total: 1, hasMore: false, cursor: null });
    expect(own.needsYou).toMatchObject([{ runId: 'failure', why: 'The machine could not start the task.' }]);
    expect((await h.read({ all: true })).needsYou).toEqual([]);
  });

});
