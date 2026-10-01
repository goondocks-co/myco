/**
 * Myco's work over a window (`/api/work`): what the runs produced, counted by outcome rather than by status.
 *
 * A learning run marked failed that saved spores reports them, with its failure as a note; a run that completed having
 * written nothing is counted and never listed; a failed search-index update a later one recovered from is a retry, not
 * a failure. A member who is not an admin reads all of it, cost included.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { MAX_WORK_RUNS } from '@myco-server-worker/read/work.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const SINCE = NOW - 24 * HOUR;

interface RunSeed { task: string; status: string; at: number; tokens?: number | null; cost?: number | null; error?: string | null; durationMs?: number }

async function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const { sqlite } = fixture;
  sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, ?)`, [NOW]);
  const run = (project: string, id: string, r: RunSeed) =>
    sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, tokens_used, cost_usd, error)
                VALUES (?, ?, 'agent_1', ?, ?, ?, ?, ?, ?, ?)`,
    [project, id, r.task, r.status, r.at, r.status === 'queued' || r.status === 'running' ? null : r.at + (r.durationMs ?? 1000), r.tokens ?? null, r.cost ?? null, r.error ?? null]);
  const spore = (project: string, id: string, author: string, session: string) => {
    sqlite.run(`INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES (?, ?, 'm1', 'tok_1', ?, ?)`, [project, session, NOW, NOW]);
    sqlite.run(`INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, author, created_at) VALUES (?, ?, 'agent_1', ?, 'gotcha', 'active', 'x', ?, ?)`,
      [project, id, session, author, NOW]);
  };
  const wrote = (project: string, runId: string, tool: string, payload: Record<string, unknown>) =>
    sqlite.run(`INSERT INTO agent_run_events (project_id, run_id, event_type, tool_name, outcome, payload, recorded_at) VALUES (?, ?, 'run_write', ?, 'written', ?, ?)`,
      [project, runId, tool, JSON.stringify(payload), NOW]);
  const report = (project: string, runId: string, summary: string) =>
    sqlite.run(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at) VALUES (?, ?, 'agent_1', 'extract', ?, ?)`, [project, runId, summary, NOW]);
  const get = async (path: string, sub?: string) => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const runAt = (project: string, id: string, task: string, status: string, at: { queuedAt?: number | null; startedAt?: number | null; completedAt?: number | null; cost?: number | null }) =>
    sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, started_at, completed_at, cost_usd) VALUES (?, ?, 'agent_1', ?, ?, ?, ?, ?, ?)`,
      [project, id, task, status, at.queuedAt ?? null, at.startedAt ?? null, at.completedAt ?? null, at.cost ?? null]);
  return { sqlite, run, runAt, spore, wrote, report, get };
}

const window = `since=${SINCE}&until=${NOW}`;

describe('Myco\'s work', () => {
  it('counts learning by the spores it wrote, keeps a failed run\'s spores with its failure as a note, and lists what produced or failed', async () => {
    const { run, spore, report, get } = await harness();
    run('proj_1', 'run_l1', { task: 'extract-curate', status: 'completed', at: NOW - 5 * HOUR, tokens: 1000, cost: 0.5, durationMs: 60_000 });
    spore('proj_1', 'sp1', 'run_l1', 's1');
    spore('proj_1', 'sp2', 'run_l1', 's2');
    run('proj_1', 'run_l2', { task: 'extract-curate', status: 'failed', at: NOW - 4 * HOUR, tokens: 500, cost: 0.25, error: 'the run ended without its artifact' });
    spore('proj_1', 'sp3', 'run_l2', 's3');
    report('proj_1', 'run_l2', 'stopped on a refused Bash call');
    run('proj_1', 'run_l3', { task: 'extract-curate', status: 'failed', at: NOW - 3 * HOUR, error: 'the runtime went away' });
    run('proj_1', 'run_l4', { task: 'extract-curate', status: 'completed', at: NOW - 2 * HOUR, tokens: 3000, cost: 1.5, durationMs: 120_000 });
    // Outside the window: counted nowhere.
    run('proj_1', 'run_old', { task: 'extract-curate', status: 'completed', at: SINCE - 2000 });
    spore('proj_1', 'sp_old', 'run_old', 's9');

    const { status, body } = await get(`/api/work?${window}`);
    expect(status).toBe(200);
    expect(body.window).toEqual({ since: SINCE, until: NOW });
    expect(body.outcomes).toEqual([{
      projectId: 'proj_1', kind: 'learn', task: 'extract-curate',
      runs: { completed: 2, failed: 2 },
      outcome: { spores: 3, sessions: 3, maps: 0 },
      failedWithOutput: 1, failed: 1,
      latestAt: NOW - 2 * HOUR + 120_000,
      tokens: 4500, costUsd: 2.25, runsWithoutCost: 1,
      spend: { tokens: [1000, 3000], costUsd: [0.5, 1.5], durationMs: [60_000, 120_000] },
      map: null,
    }]);
    expect(body.runs.map((r: any) => [r.id, r.result, r.outcome.spores, r.failure])).toEqual([
      ['run_l3', 'failed', 0, { cause: 'the runtime went away', code: 'machine_unresponsive', source: 'error' }],
      ['run_l2', 'failed_with_output', 1, { cause: 'stopped on a refused Bash call', source: 'report' }],
      ['run_l1', 'produced', 2, null],
    ]);
    expect(body.truncated).toBe(false);
  });

  it('counts titles by the sessions they landed on and maps by the maps written, with the current map', async () => {
    const { sqlite, run, wrote, get } = await harness();
    run('proj_1', 'run_t1', { task: 'title-summary', status: 'completed', at: NOW - HOUR });
    wrote('proj_1', 'run_t1', 'myco_run_sessions', { op: 'title', session_id: 's_titled' });
    run('proj_1', 'run_t2', { task: 'title-summary', status: 'skipped', at: NOW - HOUR });
    run('proj_2', 'run_m1', { task: 'canopy-map', status: 'completed', at: NOW - 2 * HOUR });
    wrote('proj_2', 'run_m1', 'myco_run_map', { op: 'write' });
    run('proj_2', 'run_m2', { task: 'canopy-map', status: 'failed', at: NOW - HOUR, error: 'the run ended without its artifact' });
    sqlite.run(`INSERT INTO canopy_maps (project_id, revision, artifact, input_hash, repository_url, repository_branch, repository_commit, source_run_id, generated_at)
                VALUES ('proj_2', 'rev1', '{}', 'h', 'https://example.com/r.git', 'main', '8194811', 'run_m1', ?)`, [NOW - 2 * HOUR]);

    const { body } = await get(`/api/work?${window}`);
    const byKind = Object.fromEntries(body.outcomes.map((o: any) => [o.kind, o]));
    expect(byKind.title).toMatchObject({ projectId: 'proj_1', runs: { completed: 1, skipped: 1 }, outcome: { spores: 0, sessions: 1, maps: 0 }, map: null });
    expect(byKind.map).toMatchObject({
      projectId: 'proj_2', runs: { completed: 1, failed: 1 }, outcome: { maps: 1 }, failed: 1, failedWithOutput: 0,
      map: { branch: 'main', commit: '8194811', generatedAt: NOW - 2 * HOUR, sourceRunId: 'run_m1' },
    });
    const title = body.runs.find((r: any) => r.id === 'run_t1');
    expect(title).toMatchObject({ kind: 'title', result: 'produced', sessionId: 's_titled', outcome: { spores: 0, sessions: 1, maps: 0 } });
    expect(body.runs.map((r: any) => r.id).sort()).toEqual(['run_m1', 'run_m2', 'run_t1']);
  });

  it('summarises the search index\'s upkeep: a failure a later success followed is a retry, one after the last success is unrecovered', async () => {
    const { run, get } = await harness();
    run('proj_1', 'run_e1', { task: 'embedding-reconcile', status: 'failed', at: NOW - 5 * HOUR });
    run('proj_1', 'run_e2', { task: 'embedding-reconcile', status: 'completed', at: NOW - 4 * HOUR });
    run('proj_2', 'run_e3', { task: 'embedding-reconcile', status: 'completed', at: NOW - 3 * HOUR });
    expect((await get(`/api/work?${window}`)).body.upkeep).toEqual({ task: 'embedding-reconcile', lastSuccessAt: NOW - 3 * HOUR, failedInWindow: 1, unrecovered: null });

    run('proj_1', 'run_e4', { task: 'embedding-reconcile', status: 'failed', at: NOW - 2 * HOUR });
    run('proj_1', 'run_e5', { task: 'embedding-reconcile', status: 'failed', at: NOW - HOUR });
    const { body } = await get(`/api/work?${window}`);
    expect(body.upkeep).toEqual({ task: 'embedding-reconcile', lastSuccessAt: NOW - 3 * HOUR, failedInWindow: 3, unrecovered: { runs: 2, since: NOW - 2 * HOUR } });
    // Upkeep is never listed nor counted as an outcome.
    expect(body.outcomes).toEqual([]);
    expect(body.runs).toEqual([]);
  });

  it('covers the Projects named, and every Project that accepts capture when none is', async () => {
    const { sqlite, run, spore, get } = await harness();
    run('proj_1', 'run_a', { task: 'extract-curate', status: 'completed', at: NOW - HOUR });
    spore('proj_1', 'sp_a', 'run_a', 's1');
    run('proj_2', 'run_b', { task: 'extract-curate', status: 'completed', at: NOW - HOUR });
    spore('proj_2', 'sp_b', 'run_b', 's1');
    expect((await get(`/api/work?${window}&project=proj_2`)).body.outcomes.map((o: any) => o.projectId)).toEqual(['proj_2']);
    sqlite.run(`UPDATE projects SET archived_at = ?, archived_by = 'mem_machine_1' WHERE project_id = 'proj_2'`, [NOW]);
    expect((await get(`/api/work?${window}`)).body.outcomes.map((o: any) => o.projectId)).toEqual(['proj_1']);
    expect((await get(`/api/work?${window}&project=absent`)).status).toBe(404);
  });

  it('lists at most its ceiling and says so, while the counts cover every run', async () => {
    const { run, spore, get } = await harness();
    for (let i = 0; i <= MAX_WORK_RUNS; i += 1) {
      run('proj_1', `run_${i}`, { task: 'extract-curate', status: 'completed', at: NOW - HOUR + i });
      spore('proj_1', `sp_${i}`, `run_${i}`, 's1');
    }
    const { body } = await get(`/api/work?${window}`);
    expect(body.runs).toHaveLength(MAX_WORK_RUNS);
    expect(body.truncated).toBe(true);
    expect(body.outcomes[0].outcome.spores).toBe(MAX_WORK_RUNS + 1);
  });

  it('lists exactly its ceiling without saying it cut anything', async () => {
    const { run, spore, get } = await harness();
    for (let i = 0; i < MAX_WORK_RUNS; i += 1) {
      run('proj_1', `run_${i}`, { task: 'extract-curate', status: 'completed', at: NOW - HOUR + i });
      spore('proj_1', `sp_${i}`, `run_${i}`, 's1');
    }
    const { body } = await get(`/api/work?${window}`);
    expect(body.runs).toHaveLength(MAX_WORK_RUNS);
    expect(body.truncated).toBe(false);
  });

  it('windows, shows and counts a run at one instant: when it ended, else when it queued, the window\'s end excluded', async () => {
    const { runAt, spore, get } = await harness();
    const learn = (id: string, at: Parameters<typeof runAt>[4]) => { runAt('proj_1', id, 'extract-curate', 'completed', at); spore('proj_1', `sp_${id}`, id, 's1'); };
    learn('run_queued_before_ended_inside', { queuedAt: SINCE - HOUR, startedAt: SINCE - 30 * 60_000, completedAt: SINCE + HOUR });
    learn('run_started_inside_ended_after', { queuedAt: NOW - HOUR, startedAt: NOW - HOUR, completedAt: NOW + HOUR });
    learn('run_ended_at_end', { startedAt: NOW - 1000, completedAt: NOW });
    learn('run_ended_just_before_end', { startedAt: NOW - 1000, completedAt: NOW - 1 });
    learn('run_ended_at_start', { startedAt: SINCE - 1000, completedAt: SINCE });
    runAt('proj_1', 'run_still_queued', 'extract-curate', 'queued', { queuedAt: NOW - HOUR });
    const { body } = await get(`/api/work?${window}`);
    expect(body.runs.map((r: any) => [r.id, r.at])).toEqual([
      ['run_ended_just_before_end', NOW - 1], ['run_queued_before_ended_inside', SINCE + HOUR], ['run_ended_at_start', SINCE],
    ]);
    expect(body.outcomes[0]).toMatchObject({ runs: { completed: 3, queued: 1 }, outcome: { spores: 3 }, latestAt: NOW - 1 });
    expect(body.outcomes[0].latestAt).toBeLessThan(NOW);
  });

  it('counts as reporting no cost only runs that started, and never one that failed before it ran', async () => {
    const { runAt, get } = await harness();
    runAt('proj_1', 'run_never_ran', 'extract-curate', 'failed', { queuedAt: NOW - 2 * HOUR, completedAt: NOW - HOUR });
    runAt('proj_1', 'run_ran_no_cost', 'extract-curate', 'failed', { startedAt: NOW - 2 * HOUR, completedAt: NOW - HOUR });
    runAt('proj_1', 'run_ran_with_cost', 'extract-curate', 'completed', { startedAt: NOW - 2 * HOUR, completedAt: NOW - HOUR, cost: 0.1 });
    expect((await get(`/api/work?${window}`)).body.outcomes[0]).toMatchObject({ runs: { failed: 2, completed: 1 }, runsWithoutCost: 1 });
  });

  it('counts upkeep failures started inside the window, from its start up to, not including, its end', async () => {
    const { run, get } = await harness();
    run('proj_1', 'run_before', { task: 'embedding-reconcile', status: 'failed', at: SINCE - 1 });
    run('proj_1', 'run_at_start', { task: 'embedding-reconcile', status: 'failed', at: SINCE });
    run('proj_1', 'run_before_end', { task: 'embedding-reconcile', status: 'failed', at: NOW - 1 });
    run('proj_1', 'run_at_end', { task: 'embedding-reconcile', status: 'failed', at: NOW });
    expect((await get(`/api/work?${window}`)).body.upkeep.failedInWindow).toBe(2);
  });

  it('refuses a window that is backwards, too long, or not made of instants', async () => {
    const { get } = await harness();
    expect((await get(`/api/work?since=${NOW}&until=${NOW - 1}`)).status).toBe(400);
    expect((await get(`/api/work?since=${NOW - 40 * 24 * HOUR}&until=${NOW}`)).status).toBe(400);
    expect((await get('/api/work?since=today')).status).toBe(400);
  });

  it('answers a member who is not an admin, cost included', async () => {
    const { sqlite, run, spore, get } = await harness();
    seedMemberRoleAccount(sqlite);
    run('proj_1', 'run_a', { task: 'extract-curate', status: 'completed', at: NOW - HOUR, cost: 0.75 });
    spore('proj_1', 'sp_a', 'run_a', 's1');
    const { status, body } = await get(`/api/work?${window}`, MEMBER_SUB);
    expect(status).toBe(200);
    expect(body.outcomes[0].costUsd).toBe(0.75);
    expect(body.runs[0].costUsd).toBe(0.75);
  });
});
