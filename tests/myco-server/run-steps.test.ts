/**
 * A run's attempts, and the step log each attempt's worker delivers.
 *
 * A claim records its attempt in the batch that claims the run. A step page is filed under the attempt it names, from
 * the worker that claimed it, and lands once however often it arrives; it moves no status and no accounting, so a log
 * that arrives after the run ended or after another attempt took it changes no outcome. A log longer than a page is
 * read back whole, page by page, and every step goes with its run.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { claimNextRun, endLeasedRun, expireLeases, HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { pruneTerminalRuns } from '@myco-server-worker/core/runs.js';
import { STEP_ATTEMPT_UNHELD } from '@myco-server-worker/core/run-steps.js';
import { BACKUP_TABLES } from '@myco-server-worker/core/backup.js';
import { getRunDetail, getRunSteps } from '@myco-server-worker/read/runs.js';
import { WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import { MAX_RUN_STEPS, stepPages, type WorkerStep } from '@goondocks/myco-shared/worker-steps';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { memberHeaders, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { offeredHarness } from './helpers/offered-harness.js';

const NOW = 1_800_000_000_000;
const SCOPE = { projectId: 'proj_1' };
const UNRECOGNIZED = { total: 3, shapes: { 'system/hook_started': 2, rate_limit_event: 1 } };

const steps = (count: number, at = NOW): WorkerStep[] => Array.from({ length: count }, (_, seq) => ({
  seq, callId: `toolu_${seq}`, kind: seq % 2 === 0 ? 'read' : 'command', tool: seq % 2 === 0 ? 'Read' : 'Bash',
  target: seq % 2 === 0 ? `src/file-${seq}.ts` : `npm test -- tests/t-${seq}.test.ts`, outcome: 'ok', exitCode: seq % 2 === 0 ? null : 0, startedAt: at + seq, endedAt: at + seq + 1,
}));

async function rig() {
  const e = sqliteEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  await ensureMember(e.db, 'mem_worker', NOW, 'admin', 'a worker');
  const first = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, NOW);
  const other = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm2' }, NOW);
  const queue = (id: string) => e.sqlite.run(
    `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
     VALUES ('proj_1', ?, 'myco-agent', 'extract-curate', 'queued', ?, 'worker', ?, ?, 'read the prompts')`,
    [id, NOW, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })],
  );
  const claim = async (tokenId: string, machineId: string, now: number) => {
    const claimed = await claimNextRun(e.serverEnv, { tokenId, machineId, harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now });
    if (!claimed.claimed) throw new Error(`nothing claimed: ${claimed.reason}`);
    return claimed.run;
  };
  /** One page over the worker route, as a worker credential sends it. */
  const send = async (token: string, runId: string, page: object) => await (await worker.fetch(new Request('https://s/worker/steps', {
    method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ projectId: 'proj_1', runId, ...page }),
  }), e.env)).json() as Record<string, unknown>;
  const stored = (runId: string, attemptId: string) => e.sqlite.query(
    `SELECT seq, call_id AS callId, kind, tool, target, outcome, exit_code AS exitCode, started_at AS startedAt, ended_at AS endedAt FROM agent_run_steps WHERE run_id = ? AND attempt_id = ? ORDER BY seq`,
  ).all(runId, attemptId) as WorkerStep[];
  const runRow = (id: string) => e.sqlite.query(`SELECT status, error, usage_data AS usage, completed_at AS completedAt FROM agent_runs WHERE id = ?`).get(id);
  return { e, first, other, queue, claim, send, stored, runRow };
}

describe('a claim and its attempt', () => {
  it('records the attempt it starts in the batch that claims the run', async () => {
    const r = await rig();
    r.queue('run_1');
    const run = await r.claim(r.first.tokenId, 'm1', NOW + 1);
    expect(r.e.sqlite.query(`SELECT attempt_id AS attemptId, leased_by AS leasedBy, machine_id AS machineId, claimed_at AS claimedAt, steps_total AS total FROM agent_run_attempts WHERE run_id = 'run_1'`).all())
      .toEqual([{ attemptId: run.attemptId, leasedBy: r.first.tokenId, machineId: 'm1', claimedAt: NOW + 1, total: null }]);
  });
});

describe('a step page', () => {
  it('lands once however often it is sent, and the run\'s detail reads the log with its totals', async () => {
    const r = await rig();
    r.queue('run_1');
    const run = await r.claim(r.first.tokenId, 'm1', NOW + 1);
    const [page] = stepPages(run.attemptId, steps(3), 0, UNRECOGNIZED);
    expect(await r.send(r.first.token, 'run_1', page!)).toEqual({ persisted: true, stored: true, landed: 3 });
    expect(await r.send(r.first.token, 'run_1', page!)).toEqual({ persisted: true, stored: true, landed: 0 });
    expect(r.stored('run_1', run.attemptId)).toEqual(steps(3));
    const detail = await getRunDetail(r.e.db, SCOPE, 'run_1', NOW + 2, 'mem_worker');
    expect(detail?.attempts).toEqual([{ attemptId: run.attemptId, claimedAt: NOW + 1, steps: { total: 3, received: 3, overflow: 0, unrecognized: UNRECOGNIZED } }]);
    expect(detail?.steps).toEqual({ attemptId: run.attemptId, rows: steps(3), cursor: null });
  });

  it('carries no access key into a stored target, and a page that does not hold its shape is refused whole', async () => {
    const r = await rig();
    r.queue('run_1');
    const run = await r.claim(r.first.tokenId, 'm1', NOW + 1);
    const leaky: WorkerStep = { ...steps(1)[0]!, kind: 'command', target: 'curl -H "Authorization: Bearer abcdef0123456789abcdef" https://example.test' };
    expect(await r.send(r.first.token, 'run_1', { ...stepPages(run.attemptId, [leaky], 0, { total: 0, shapes: {} })[0]! })).toMatchObject({ stored: true, landed: 1 });
    expect(r.stored('run_1', run.attemptId)[0]?.target).toBe('curl -H … https://example.test');

    const [page] = stepPages(run.attemptId, steps(2), 0, { total: 0, shapes: {} });
    expect(await r.send(r.first.token, 'run_1', { ...page!, steps: [{ ...page!.steps[0]!, output: 'secret file contents' }, page!.steps[1]] }))
      .toEqual({ persisted: false, code: 'parse', reason: 'steps[0] names an unknown field: output' });
    expect(await r.send(r.first.token, 'run_1', { ...page!, steps: [{ ...page!.steps[0]!, kind: 'shell' }, page!.steps[1]] }))
      .toMatchObject({ persisted: false, code: 'parse' });
    expect(await r.send(r.first.token, 'run_1', { ...page!, total: 250 })).toMatchObject({ persisted: false, code: 'parse', reason: 'pages does not match total' });
    expect(await r.send(r.first.token, 'run_1', { ...page!, steps: [{ ...page!.steps[0]!, target: 'x'.repeat(301) }, page!.steps[1]] }))
      .toMatchObject({ persisted: false, code: 'parse' });
    expect(r.stored('run_1', run.attemptId)).toHaveLength(1);
  });

  it('is refused from a worker on another machine, and for an attempt the run never had', async () => {
    const r = await rig();
    r.queue('run_1');
    const run = await r.claim(r.first.tokenId, 'm1', NOW + 1);
    const [page] = stepPages(run.attemptId, steps(1), 0, { total: 0, shapes: {} });
    expect(await r.send(r.other.token, 'run_1', page!)).toEqual({ persisted: true, stored: false, reason: STEP_ATTEMPT_UNHELD });
    expect(await r.send(r.first.token, 'run_1', { ...page!, attemptId: 'mt_never' })).toEqual({ persisted: true, stored: false, reason: STEP_ATTEMPT_UNHELD });
    expect(r.e.sqlite.query(`SELECT COUNT(*) AS n FROM agent_run_steps`).get()).toEqual({ n: 0 });
  });

  it('is admitted from another credential of the machine that claimed the attempt', async () => {
    const r = await rig();
    r.queue('run_1');
    const run = await r.claim(r.first.tokenId, 'm1', NOW + 1);
    const rotated = await issueMemberToken(r.e.db, { memberId: 'mem_worker', machineId: 'm1' }, NOW + 2);
    expect(await r.send(rotated.token, 'run_1', stepPages(run.attemptId, steps(1), 0, { total: 0, shapes: {} })[0]!)).toMatchObject({ stored: true, landed: 1 });
  });
});

describe('a log longer than a page', () => {
  it('lands every step of every page, and reads back whole page by page, in order', async () => {
    const r = await rig();
    r.queue('run_1');
    const run = await r.claim(r.first.tokenId, 'm1', NOW + 1);
    const log = steps(450);
    const pages = stepPages(run.attemptId, log, 0, { total: 0, shapes: {} });
    expect(pages.map((page) => page.steps.length)).toEqual([100, 100, 100, 100, 50]);
    for (const page of pages.reverse()) expect(await r.send(r.first.token, 'run_1', page)).toMatchObject({ stored: true });
    expect(r.stored('run_1', run.attemptId)).toEqual(log);

    const read: WorkerStep[] = [];
    let cursor: string | undefined;
    do {
      const page = await getRunSteps(r.e.db, SCOPE, 'run_1', undefined, { limit: 200, cursor });
      read.push(...page!.rows);
      cursor = page!.cursor ?? undefined;
    } while (cursor !== undefined);
    expect(read).toEqual(log);
    const detail = await getRunDetail(r.e.db, SCOPE, 'run_1', NOW + 2, 'mem_worker');
    expect(detail?.steps?.rows).toHaveLength(200);
    expect(detail?.steps?.cursor).not.toBeNull();
    expect(detail?.attempts[0]?.steps).toEqual({ total: 450, received: 450, overflow: 0, unrecognized: { total: 0, shapes: {} } });
  });

  it('refuses a page past the bound a log keeps', async () => {
    const r = await rig();
    r.queue('run_1');
    const run = await r.claim(r.first.tokenId, 'm1', NOW + 1);
    expect(await r.send(r.first.token, 'run_1', { attemptId: run.attemptId, page: 20, pages: 21, total: MAX_RUN_STEPS + 1, overflow: 0, unrecognized: { total: 0, shapes: {} }, steps: [] }))
      .toMatchObject({ persisted: false, code: 'parse' });
  });
});

describe('a run another attempt took', () => {
  it('keeps each attempt\'s log apart, and a late log from the first changes nothing about how the run ended', async () => {
    const r = await rig();
    r.queue('run_1');
    const a = await r.claim(r.first.tokenId, 'm1', NOW + 1);
    // The first worker goes away; its lease lapses and the run is claimed again.
    expect(await expireLeases(r.e.serverEnv, NOW + 1 + WORKER_LEASE_MS + 1)).toBe(1);
    const b = await r.claim(r.other.tokenId, 'm2', NOW + 2 + WORKER_LEASE_MS);
    expect(b.attemptId).not.toBe(a.attemptId);
    expect(await endLeasedRun(r.e.serverEnv, { tokenId: r.other.tokenId, now: NOW + 3 + WORKER_LEASE_MS }, {
      projectId: 'proj_1', runId: 'run_1', status: 'failed', error: 'the harness stopped: error', attemptId: b.attemptId,
      accountingVersion: 1, identity: { status: 'unknown', reason: 'harness_not_started' }, usage: null,
    })).toMatchObject({ ended: true, status: 'failed' });
    expect(await r.send(r.other.token, 'run_1', stepPages(b.attemptId, steps(2, NOW + 5), 0, { total: 0, shapes: {} })[0]!)).toMatchObject({ stored: true, landed: 2 });
    const ended = r.runRow('run_1');

    // The first worker comes back and delivers the log it kept for its own attempt.
    expect(await r.send(r.first.token, 'run_1', stepPages(a.attemptId, steps(3), 1, UNRECOGNIZED)[0]!)).toEqual({ persisted: true, stored: true, landed: 3 });
    expect(r.runRow('run_1')).toEqual(ended);
    expect(r.stored('run_1', a.attemptId)).toEqual(steps(3));
    expect(r.stored('run_1', b.attemptId)).toEqual(steps(2, NOW + 5));
    const detail = await getRunDetail(r.e.db, SCOPE, 'run_1', NOW, 'mem_worker');
    expect(detail?.attempts.map((attempt) => [attempt.attemptId, attempt.steps?.total, attempt.steps?.overflow])).toEqual([[a.attemptId, 3, 1], [b.attemptId, 2, 0]]);
    expect(detail?.steps?.attemptId).toBe(b.attemptId);
    expect((await getRunSteps(r.e.db, SCOPE, 'run_1', a.attemptId))?.rows).toEqual(steps(3));
  });
});

describe('a run\'s log over its lifetime', () => {
  it('goes with its run under retention, and travels in a portable backup', async () => {
    const r = await rig();
    r.queue('run_1');
    const run = await r.claim(r.first.tokenId, 'm1', NOW + 1);
    await r.send(r.first.token, 'run_1', stepPages(run.attemptId, steps(3), 0, { total: 0, shapes: {} })[0]!);
    await endLeasedRun(r.e.serverEnv, { tokenId: r.first.tokenId, now: NOW + 2 }, { projectId: 'proj_1', runId: 'run_1', status: 'failed', error: 'stopped' });
    expect(BACKUP_TABLES.indexOf('agent_run_attempts')).toBeGreaterThan(BACKUP_TABLES.indexOf('agent_runs'));
    expect(BACKUP_TABLES.indexOf('agent_run_steps')).toBeGreaterThan(BACKUP_TABLES.indexOf('agent_run_attempts'));
    expect(await pruneTerminalRuns(r.e.db, NOW + 10, 100)).toBeGreaterThanOrEqual(1);
    expect(r.e.sqlite.query(`SELECT COUNT(*) AS n FROM agent_runs WHERE id = 'run_1'`).get()).toEqual({ n: 0 });
    expect(r.e.sqlite.query(`SELECT (SELECT COUNT(*) FROM agent_run_attempts) AS attempts, (SELECT COUNT(*) FROM agent_run_steps) AS steps`).get()).toEqual({ attempts: 0, steps: 0 });
  });

  it('deletes at most its bound of step rows a pass, and keeps a run with its turns and reports until its log is gone', async () => {
    const r = await rig();
    r.queue('run_1');
    const run = await r.claim(r.first.tokenId, 'm1', NOW + 1);
    await r.send(r.first.token, 'run_1', stepPages(run.attemptId, steps(150), 0, { total: 0, shapes: {} })[0]!);
    await r.send(r.first.token, 'run_1', stepPages(run.attemptId, steps(150), 0, { total: 0, shapes: {} })[1]!);
    await endLeasedRun(r.e.serverEnv, { tokenId: r.first.tokenId, now: NOW + 2 }, { projectId: 'proj_1', runId: 'run_1', status: 'failed', error: 'stopped' });
    r.e.sqlite.run(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at) VALUES ('proj_1', 'run_1', 'myco-agent', 'extract', 'kept', ?)`, [NOW]);
    const left = () => r.e.sqlite.query(`SELECT (SELECT COUNT(*) FROM agent_run_steps WHERE run_id = 'run_1') AS steps, (SELECT COUNT(*) FROM agent_reports WHERE run_id = 'run_1') AS reports,
      (SELECT COUNT(*) FROM agent_runs WHERE id = 'run_1') AS runs`).get();
    await pruneTerminalRuns(r.e.db, NOW + 10, 100, 100);
    expect(left()).toEqual({ steps: 50, reports: 1, runs: 1 });
    await pruneTerminalRuns(r.e.db, NOW + 10, 100, 100);
    expect(left()).toEqual({ steps: 0, reports: 0, runs: 0 });
  });
});

describe('a run claimed many times', () => {
  it('lists its latest attempts, counts them all, and serves any attempt\'s log by its id', async () => {
    const r = await rig();
    r.queue('run_1');
    const ids: string[] = [];
    let at = NOW;
    for (let i = 0; i < 55; i += 1) {
      at += 1;
      const run = await r.claim(r.first.tokenId, 'm1', at);
      ids.push(run.attemptId!);
      await r.send(r.first.token, 'run_1', stepPages(run.attemptId, steps(i === 0 ? 2 : 1), 0, { total: 0, shapes: {} })[0]!);
      at += WORKER_LEASE_MS + 1;
      expect(await expireLeases(r.e.serverEnv, at)).toBe(1);
    }
    const detail = await getRunDetail(r.e.db, SCOPE, 'run_1', at, 'mem_worker');
    expect(detail?.attemptCount).toBe(55);
    expect(detail?.attempts.map((attempt) => attempt.attemptId)).toEqual(ids.slice(5));
    expect(detail?.steps?.attemptId).toBe(ids[54]);
    expect((await getRunSteps(r.e.db, SCOPE, 'run_1', undefined))?.attemptId).toBe(ids[54]);
    expect((await getRunSteps(r.e.db, SCOPE, 'run_1', ids[0]))?.rows).toHaveLength(2);
    expect(await getRunSteps(r.e.db, SCOPE, 'run_1', 'mt_never')).toBeNull();
  });
});
