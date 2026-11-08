/**
 * Myco's work over a window (`/api/work`): what the runs produced, counted by outcome rather than by status.
 *
 * A learning run marked failed that saved spores reports them, with its failure as a note; a run that completed having
 * written nothing remains in the counts and is omitted from the timeline; a failed search-index update a later one recovered from is a retry, not
 * a failure. A member who is not an admin reads all of it, cost included.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { MAX_WORK_RUNS } from '@myco-server-worker/read/work.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The UTC day holding NOW: a supported window, so the summary reads the rollups. */
const SINCE = Math.floor(NOW / DAY) * DAY;
const END = SINCE + DAY;

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
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(fixture.db, Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const runAt = (project: string, id: string, task: string, status: string, at: { queuedAt?: number | null; startedAt?: number | null; completedAt?: number | null; cost?: number | null }) =>
    sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, started_at, completed_at, cost_usd) VALUES (?, ?, 'agent_1', ?, ?, ?, ?, ?, ?)`,
      [project, id, task, status, at.queuedAt ?? null, at.startedAt ?? null, at.completedAt ?? null, at.cost ?? null]);
  return { sqlite, run, runAt, spore, wrote, report, get };
}

const window = `since=${SINCE}&until=${END}`;

describe('Myco\'s work', () => {
  it('reports queued code learning as pending work with no produced outcome', async () => {
    const { sqlite, runAt, get } = await harness();
    try {
      runAt('proj_1', 'run_seed_queued', 'vault-seed', 'queued', { queuedAt: Date.now() - HOUR });
      const { status, body } = await get('/api/work');
      expect(status).toBe(200);
      expect(body.summary).toMatchObject([{
        projectId: 'proj_1', kind: 'seed', task: 'vault-seed',
        runs: { queued: 1 }, outcome: { spores: 0, sessions: 0, maps: 0 }, failed: 0, failure: null,
      }]);
      expect(body.timeline).toEqual([]);
      const listed = await get('/api/projects/proj_1/runs?task=vault-seed');
      expect(listed.status).toBe(200);
      expect(listed.body.rows).toMatchObject([{
        id: 'run_seed_queued', status: 'queued', startedAt: null, completedAt: null,
      }]);
    } finally { sqlite.close(); }
  });

  it('labels a partition model in work reads', async () => {
    const { sqlite, run, get } = await harness();
    try {
      run('proj_1', 'partition', { task: 'canopy-map', status: 'failed', at: NOW - HOUR });
      sqlite.query("UPDATE agent_runs SET model = ? WHERE id = 'partition'").run(JSON.stringify(['cloudflare', '@cf/baai/bge-m3']));
      expect((await get(`/api/work?${window}`)).body.timeline[0].model).toBe('@cf/baai/bge-m3');
    } finally { sqlite.close(); }
  });

  it('reads recorded failure codes before prose and admits legacy capability-held expiries', async () => {
    const { sqlite, run, get } = await harness();
    try {
      run('proj_1', 'coded', { task: 'canopy-map', status: 'failed', at: NOW - HOUR, error: 'The requested tool was unavailable.' });
      sqlite.run(`UPDATE agent_runs SET error_code = 'machine_did_not_start' WHERE id = 'coded'`);
      run('proj_1', 'legacy', { task: 'canopy-map', status: 'failed', at: NOW - HOUR, error: 'no worker reporting repository-digests took the run within a day' });
      const { body } = await get(`/api/work?${window}`);
      expect(body.timeline.filter((r: any) => ['coded', 'legacy'].includes(r.id)).map((r: any) => r.failure.code)).toEqual(['machine_did_not_start', 'machine_did_not_start']);
    } finally { sqlite.close(); }
  });

  it('keeps an agent report separate from a terminal failure with no recorded reason', async () => {
    const { sqlite, run, report, get } = await harness();
    try {
      run('proj_1', 'report_only', { task: 'canopy-map', status: 'failed', at: NOW - HOUR });
      report('proj_1', 'report_only', 'The requested source was unavailable.');
      const { body } = await get(`/api/work?${window}`);
      expect(body.timeline[0].failure).toEqual({ source: 'error', cause: 'the run failed without saying why', code: 'run_failed', error: null });
    } finally { sqlite.close(); }
  });

  it('counts learning by the spores it wrote, keeps a failed run\'s spores with its failure as a note, and counts completed passes that changed nothing', async () => {
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
    expect(body.window).toEqual({ since: SINCE, until: END });
    expect(body.state).toBe('ready');
    expect(body.summary).toEqual([{
      projectId: 'proj_1', kind: 'learn', task: 'extract-curate',
      runs: { completed: 2, failed: 2 },
      outcome: { spores: 3, sessions: 3, maps: 0 },
      failedWithOutput: 1, failed: 1,
      failure: { runs: 1, latestAt: NOW - 3 * HOUR + 1000, latestRunId: 'run_l3', unresolved: false },
      latestAt: NOW - 2 * HOUR + 120_000,
      tokens: 4500, costUsd: 2.25, runsWithoutCost: 1,
      spend: { tokens: [1000, 3000], costUsd: [0.5, 1.5], durationMs: [60_000, 120_000] },
    }]);
    expect(body.timeline.map((r: any) => [r.id, r.result, r.outcome.spores, r.failure])).toEqual([
      ['run_l3', 'failed', 0, { cause: 'the runtime went away', code: 'machine_unresponsive', error: 'the runtime went away', source: 'error' }],
      ['run_l2', 'failed_with_output', 1, { cause: 'the run ended without its artifact', code: 'run_failed', error: 'the run ended without its artifact', source: 'error' }],
      ['run_l1', 'produced', 2, null],
    ]);
    expect(body.hasMore).toBe(false);
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
    const byKind = Object.fromEntries(body.summary.map((o: any) => [o.kind, o]));
    expect(byKind.title).toMatchObject({ projectId: 'proj_1', runs: { completed: 1, skipped: 1 }, outcome: { spores: 0, sessions: 1, maps: 0 } });
    expect(byKind.map).toMatchObject({
      projectId: 'proj_2', runs: { completed: 1, failed: 1 }, outcome: { maps: 1 }, failed: 1, failedWithOutput: 0,
    });
    expect(body.maps).toEqual([{ projectId: 'proj_2', branch: 'main', commit: '8194811', generatedAt: NOW - 2 * HOUR, sourceRunId: 'run_m1' }]);
    const title = body.timeline.find((r: any) => r.id === 'run_t1');
    expect(title).toMatchObject({ kind: 'title', result: 'produced', sessionId: 's_titled', outcome: { spores: 0, sessions: 1, maps: 0 } });
    expect(body.timeline.map((r: any) => r.id).sort()).toEqual(['run_m1', 'run_m2', 'run_t1']);
  });

  it('links the failure that ended most recently, including a run that started earlier', async () => {
    const { sqlite, run, get } = await harness();
    try {
      run('proj_1', 'ended-last', { task: 'embedding-reconcile', status: 'failed', at: NOW - 2 * HOUR, durationMs: HOUR + 1000 });
      run('proj_1', 'started-last', { task: 'embedding-reconcile', status: 'failed', at: NOW - HOUR, durationMs: 500 });
      expect((await get(`/api/work?${window}`)).body.upkeep.unrecovered.latestFailure).toMatchObject({ runId: 'ended-last', at: NOW - HOUR + 1000 });
    } finally { sqlite.close(); }
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
    expect(body.upkeep).toEqual({ task: 'embedding-reconcile', lastSuccessAt: NOW - 3 * HOUR, failedInWindow: 3, unrecovered: { runs: 2, since: NOW - 2 * HOUR, latestFailure: { projectId: 'proj_1', runId: 'run_e5', at: NOW - HOUR + 1000, code: null } } });
    // Upkeep is never listed nor counted as an outcome.
    expect(body.summary).toEqual([]);
    expect(body.timeline).toEqual([]);
  });

  it('covers the Projects named, and every Project that accepts capture when none is', async () => {
    const { sqlite, run, spore, get } = await harness();
    run('proj_1', 'run_a', { task: 'extract-curate', status: 'completed', at: NOW - HOUR });
    spore('proj_1', 'sp_a', 'run_a', 's1');
    run('proj_2', 'run_b', { task: 'extract-curate', status: 'completed', at: NOW - HOUR });
    spore('proj_2', 'sp_b', 'run_b', 's1');
    expect((await get(`/api/work?${window}&project=proj_2`)).body.summary.map((o: any) => o.projectId)).toEqual(['proj_2']);
    sqlite.run(`UPDATE projects SET archived_at = ?, archived_by = 'mem_machine_1' WHERE project_id = 'proj_2'`, [NOW]);
    expect((await get(`/api/work?${window}`)).body.summary.map((o: any) => o.projectId)).toEqual(['proj_1']);
    expect((await get(`/api/work?${window}&project=absent`)).status).toBe(404);
  });

  it('lists at most its ceiling and says so, while the counts cover every run', async () => {
    const { run, spore, get } = await harness();
    for (let i = 0; i <= MAX_WORK_RUNS; i += 1) {
      run('proj_1', `run_${i}`, { task: 'extract-curate', status: 'completed', at: NOW - HOUR + i });
      spore('proj_1', `sp_${i}`, `run_${i}`, 's1');
    }
    const { body } = await get(`/api/work?${window}`);
    expect(body.timeline).toHaveLength(MAX_WORK_RUNS);
    expect(body.hasMore).toBe(true);
    expect(body.summary[0].outcome.spores).toBe(MAX_WORK_RUNS + 1);
  });

  it('lists exactly its ceiling without saying it cut anything', async () => {
    const { run, spore, get } = await harness();
    for (let i = 0; i < MAX_WORK_RUNS; i += 1) {
      run('proj_1', `run_${i}`, { task: 'extract-curate', status: 'completed', at: NOW - HOUR + i });
      spore('proj_1', `sp_${i}`, `run_${i}`, 's1');
    }
    const { body } = await get(`/api/work?${window}`);
    expect(body.timeline).toHaveLength(MAX_WORK_RUNS);
    expect(body.hasMore).toBe(false);
  });

  it('keeps a Project failure authoritative beyond the evidence cap and retrieves the next page', async () => {
    const { sqlite, run, wrote, get } = await harness();
    try {
      run('proj_1', 'older_failure', { task: 'canopy-map', status: 'failed', at: SINCE + HOUR, error: 'source unavailable' });
      for (let i = 0; i < MAX_WORK_RUNS; i += 1) {
        const id = `newer_${i}`;
        run('proj_2', id, { task: 'canopy-map', status: 'completed', at: NOW - HOUR + i });
        wrote('proj_2', id, 'myco_run_map', { op: 'write' });
      }
      const { body } = await get(`/api/work?${window}`);
      expect(body.timeline).toHaveLength(MAX_WORK_RUNS);
      expect(body.timeline.some((row: { id: string }) => row.id === 'older_failure')).toBe(false);
      expect(body.hasMore).toBe(true);
      expect(body.cursor).toBeString();
      expect(body.summary.find((row: { projectId: string }) => row.projectId === 'proj_1').failure)
        .toMatchObject({ runs: 1, latestRunId: 'older_failure', unresolved: true });
      expect(body.summary.find((row: { projectId: string }) => row.projectId === 'proj_2').failure).toBeNull();

      const next = await get(`/api/work?${window}&cursor=${encodeURIComponent(body.cursor)}`);
      expect(next.status).toBe(200);
      expect(next.body.timeline.map((row: { id: string }) => row.id)).toEqual(['older_failure']);
      expect(next.body.cursor).toBeNull();
      expect(next.body.summary).toBeNull();
      expect((await get(`/api/work?${window}&project=proj_1`)).body.timeline.map((row: { id: string }) => row.id)).toEqual(['older_failure']);
      expect((await get(`/api/work?${window}&cursor=oops`)).status).toBe(400);
    } finally { sqlite.close(); }
  });

  it('resolves a failure only when a later run of the same Project and task completes', async () => {
    const { sqlite, run, wrote, get } = await harness();
    try {
      run('proj_1', 'failed_first', { task: 'canopy-map', status: 'failed', at: NOW - 4 * HOUR });
      run('proj_2', 'other_project', { task: 'canopy-map', status: 'completed', at: NOW - 3 * HOUR });
      wrote('proj_2', 'other_project', 'myco_run_map', { op: 'write' });
      let answer = (await get(`/api/work?${window}`)).body;
      expect(answer.summary.find((row: { projectId: string }) => row.projectId === 'proj_1').failure.unresolved).toBe(true);

      run('proj_1', 'recovered_here', { task: 'canopy-map', status: 'completed', at: NOW - 2 * HOUR });
      wrote('proj_1', 'recovered_here', 'myco_run_map', { op: 'write' });
      answer = (await get(`/api/work?${window}`)).body;
      expect(answer.summary.find((row: { projectId: string }) => row.projectId === 'proj_1').failure.unresolved).toBe(false);
    } finally { sqlite.close(); }
  });

  it('windows, shows and counts a run at one instant: when it ended, the UTC window\'s end excluded', async () => {
    const { runAt, spore, get } = await harness();
    const learn = (id: string, at: Parameters<typeof runAt>[4]) => { runAt('proj_1', id, 'extract-curate', 'completed', at); spore('proj_1', `sp_${id}`, id, 's1'); };
    learn('run_queued_before_ended_inside', { queuedAt: SINCE - HOUR, startedAt: SINCE - 30 * 60_000, completedAt: SINCE + HOUR });
    learn('run_started_inside_ended_after', { queuedAt: END - HOUR, startedAt: END - HOUR, completedAt: END + HOUR });
    learn('run_ended_at_end', { startedAt: END - 1000, completedAt: END });
    learn('run_ended_just_before_end', { startedAt: END - 1000, completedAt: END - 1 });
    learn('run_ended_at_start', { startedAt: SINCE - 1000, completedAt: SINCE });
    const { body } = await get(`/api/work?${window}`);
    expect(body.timeline.map((r: any) => [r.id, r.at])).toEqual([
      ['run_ended_just_before_end', END - 1], ['run_queued_before_ended_inside', SINCE + HOUR], ['run_ended_at_start', SINCE],
    ]);
    expect(body.summary[0]).toMatchObject({ runs: { completed: 3 }, outcome: { spores: 3 }, latestAt: END - 1 });
  });

  it('shows a custom range as paged evidence with no totals', async () => {
    const { run, get } = await harness();
    run('proj_1', 'run_listed', { task: 'canopy-map', status: 'failed', at: NOW - HOUR });
    const { status, body } = await get(`/api/work?since=${NOW - 6 * HOUR}&until=${NOW}`);
    expect(status).toBe(200);
    expect(body.summary).toBeNull();
    expect(body.state).toBe('ready');
    expect(body.timeline.map((r: any) => r.id)).toEqual(['run_listed']);
  });

  it('defaults to the last seven UTC days through today', async () => {
    const { run, get } = await harness();
    const now = Date.now();
    const today = Math.floor(now / DAY) * DAY;
    run('proj_1', 'run_week', { task: 'canopy-map', status: 'failed', at: today - 5 * DAY });
    run('proj_1', 'run_before_week', { task: 'canopy-map', status: 'failed', at: today - 7 * DAY });
    const { body } = await get('/api/work');
    expect(body.window).toEqual({ since: today - 6 * DAY, until: today + DAY });
    expect(body.summary).toMatchObject([{ failed: 1 }]);
    expect(body.timeline.map((r: any) => r.id)).toEqual(['run_week']);
  });

  it('counts a session once across a week of runs, and moves a run when it ends later', async () => {
    const { sqlite, run, spore, get } = await harness();
    const weekSince = SINCE - 6 * DAY;
    run('proj_1', 'mon', { task: 'extract-curate', status: 'completed', at: SINCE - 3 * DAY });
    spore('proj_1', 'sp_a', 'mon', 's_shared');
    run('proj_1', 'fri', { task: 'extract-curate', status: 'completed', at: SINCE - HOUR });
    spore('proj_1', 'sp_b', 'fri', 's_shared');
    spore('proj_1', 'sp_c', 'fri', 's_other');
    const week = await get(`/api/work?since=${weekSince}&until=${END}`);
    expect(week.body.summary[0].outcome).toMatchObject({ spores: 3, sessions: 2 });
    // The rollup follows the run: a later end moves it out of the day it counted in.
    sqlite.query(`UPDATE agent_runs SET completed_at = ? WHERE id = 'fri'`).run(END - HOUR);
    const today = await get(`/api/work?${window}`);
    expect(today.body.summary[0]).toMatchObject({ runs: { completed: 1 }, outcome: { spores: 2, sessions: 2 } });
    expect((await get(`/api/work?since=${SINCE - DAY}&until=${SINCE}`)).body.summary).toEqual([]);
  });

  it('subtracts a retired run from its window and keeps the session a surviving run still wrote from', async () => {
    const { sqlite, run, spore, get } = await harness();
    run('proj_1', 'run_old_1', { task: 'extract-curate', status: 'completed', at: SINCE + HOUR, tokens: 10, cost: 0.1 });
    spore('proj_1', 'sp_1', 'run_old_1', 's_shared');
    run('proj_1', 'run_old_2', { task: 'extract-curate', status: 'completed', at: SINCE + 2 * HOUR, tokens: 30, cost: 0.3 });
    spore('proj_1', 'sp_2', 'run_old_2', 's_shared');
    sqlite.run(`DELETE FROM agent_runs WHERE id = 'run_old_2'`);
    const { body } = await get(`/api/work?${window}`);
    expect(body.summary[0]).toMatchObject({ runs: { completed: 1 }, outcome: { sessions: 1 }, tokens: 10, spend: { tokens: [10, 10], costUsd: [0.1, 0.1] } });
    sqlite.run(`DELETE FROM agent_runs WHERE id = 'run_old_1'`);
    expect((await get(`/api/work?${window}`)).body.summary).toEqual([]);
    for (const table of ['work_daily', 'work_run_contribution', 'run_output_membership', 'work_window_sessions', 'work_window_totals']) {
      expect(sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it('counts as reporting no cost only runs that started, and never one that failed before it ran', async () => {
    const { runAt, get } = await harness();
    runAt('proj_1', 'run_never_ran', 'extract-curate', 'failed', { queuedAt: NOW - 2 * HOUR, completedAt: NOW - HOUR });
    runAt('proj_1', 'run_ran_no_cost', 'extract-curate', 'failed', { startedAt: NOW - 2 * HOUR, completedAt: NOW - HOUR });
    runAt('proj_1', 'run_ran_with_cost', 'extract-curate', 'completed', { startedAt: NOW - 2 * HOUR, completedAt: NOW - HOUR, cost: 0.1 });
    expect((await get(`/api/work?${window}`)).body.summary[0]).toMatchObject({ runs: { failed: 2, completed: 1 }, runsWithoutCost: 1 });
  });

  it('counts upkeep failures started inside the window, from its start up to, not including, its end', async () => {
    const { run, get } = await harness();
    run('proj_1', 'run_before', { task: 'embedding-reconcile', status: 'failed', at: SINCE - 1 });
    run('proj_1', 'run_at_start', { task: 'embedding-reconcile', status: 'failed', at: SINCE });
    run('proj_1', 'run_before_end', { task: 'embedding-reconcile', status: 'failed', at: END - 1 });
    run('proj_1', 'run_at_end', { task: 'embedding-reconcile', status: 'failed', at: END });
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
    expect(body.summary[0].costUsd).toBe(0.75);
    expect(body.timeline[0].costUsd).toBe(0.75);
  });
});

it('keeps a failure visible when a week contains more than the cap of newer unchanged passes', async () => {
  const { sqlite, run, get } = await harness();
  try {
    const week = SINCE - 6 * DAY;
    run('proj_1', 'needs_attention', { task: 'canopy-map', status: 'failed', at: week + HOUR, error: 'the runtime went away' });
    for (let i = 0; i < MAX_WORK_RUNS + 1; i++) {
      run('proj_1', `unchanged_${i}`, { task: 'canopy-map', status: 'completed', at: NOW - HOUR - i * 1_000 });
    }
    const { status, body } = await get(`/api/work?since=${week}&until=${END}`);
    expect(status).toBe(200);
    expect(body.timeline.map((row: { id: string }) => row.id)).toEqual(['needs_attention']);
    expect(body.hasMore).toBe(false);
    expect(body.summary[0]).toMatchObject({ runs: { completed: MAX_WORK_RUNS + 1, failed: 1 }, failed: 1, failedWithOutput: 0, outcome: { maps: 0 } });
  } finally { sqlite.close(); }
});
