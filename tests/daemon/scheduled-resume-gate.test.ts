/**
 * Tests for the scheduler's resume retry budget (gateScheduledResume).
 *
 * Under the cap a resumable run consumes one attempt and resumes; at the cap
 * it is terminal-marked (`resumable=0`, `resume_status='exhausted'`), the
 * failure notification fires, and the caller falls through to a fresh
 * dispatch — observable here as getLatestResumableRunForTask no longer
 * returning the run.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import {
  insertRun,
  getRun,
  getLatestResumableRunForTask,
  refundRunResumeAttempt,
  applyRunUpdate,
  RESUME_STATUS_EXHAUSTED,
  RESUME_STATUS_READY,
  RESUME_STATUS_SUPERSEDED,
  type RunRow,
} from '@myco/db/queries/runs.js';
import { ALL_PROJECTS_SCOPE, assertGroveProjectId } from '@myco/grove/ids.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { DaemonLogger } from '@myco/daemon/logger.js';

/** Captured notify() calls. */
let notifyCalls: Array<{ vaultDir: string | undefined; payload: Record<string, unknown> }> = [];

mock.module('@myco/notifications/notify.js', () => ({
  notify: (vaultDir: string | undefined, payload: Record<string, unknown>) => {
    notifyCalls.push({ vaultDir, payload });
    return 'notif-1';
  },
}));

import { gateScheduledResume, RESUME_MAX_ATTEMPTS } from '@myco/daemon/task-scheduling.js';

const TEST_AGENT_ID = 'gate-test-agent';
const TEST_TASK = 'vault-evolve';
const TEST_PROJECT_ID = assertGroveProjectId('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

const stubLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as DaemonLogger;

const stubConfig = {} as MycoConfig;

const epochNow = () => Math.floor(Date.now() / 1000);

function insertResumableRun(id: string, resumeAttempts: number): RunRow {
  return insertRun({
    id,
    agent_id: TEST_AGENT_ID,
    task: TEST_TASK,
    status: 'failed',
    resumable: 1,
    resume_status: RESUME_STATUS_READY,
    resume_attempts: resumeAttempts,
    started_at: epochNow() - 120,
    completed_at: epochNow() - 60,
    error: 'boom',
  });
}

function gate(run: RunRow): 'resume' | 'exhausted' {
  return gateScheduledResume({
    run,
    taskName: TEST_TASK,
    scope: ALL_PROJECTS_SCOPE,
    projectVaultDir: '/tmp/gate-test/.myco',
    projectId: TEST_PROJECT_ID,
    config: stubConfig,
    logger: stubLogger,
  });
}

describe('gateScheduledResume', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    notifyCalls = [];
    registerAgent({ id: TEST_AGENT_ID, name: 'Gate Test Agent', created_at: epochNow() });
  });

  it('increments resume_attempts and allows the resume while under the cap', () => {
    const run = insertResumableRun('run-under-cap', 0);

    expect(gate(run)).toBe('resume');

    const after = getRun('run-under-cap', ALL_PROJECTS_SCOPE)!;
    expect(after.resume_attempts).toBe(1);
    expect(after.resumable).toBe(1);
    expect(after.resume_status).toBe(RESUME_STATUS_READY);
    expect(notifyCalls).toHaveLength(0);
  });

  it('allows exactly RESUME_MAX_ATTEMPTS resumes before exhausting', () => {
    let run = insertResumableRun('run-budget', 0);

    for (let attempt = 1; attempt <= RESUME_MAX_ATTEMPTS; attempt += 1) {
      expect(gate(run)).toBe('resume');
      run = getRun('run-budget', ALL_PROJECTS_SCOPE)!;
      expect(run.resume_attempts).toBe(attempt);
    }

    expect(gate(run)).toBe('exhausted');
  });

  it('terminal-marks an at-cap run, notifies, and unblocks a fresh dispatch', () => {
    const run = insertResumableRun('run-at-cap', RESUME_MAX_ATTEMPTS);
    expect(getLatestResumableRunForTask(TEST_AGENT_ID, TEST_TASK, ALL_PROJECTS_SCOPE)?.id)
      .toBe('run-at-cap');

    expect(gate(run)).toBe('exhausted');

    const after = getRun('run-at-cap', ALL_PROJECTS_SCOPE)!;
    expect(after.resumable).toBe(0);
    expect(after.resume_status).toBe(RESUME_STATUS_EXHAUSTED);
    // resume_attempts is not consumed further by the exhaustion path.
    expect(after.resume_attempts).toBe(RESUME_MAX_ATTEMPTS);

    // The next scheduler tick (and the fall-through in this one) sees no
    // resumable run, so the task dispatches fresh.
    expect(getLatestResumableRunForTask(TEST_AGENT_ID, TEST_TASK, ALL_PROJECTS_SCOPE)).toBeNull();

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].payload).toMatchObject({
      domain: 'agents',
      type: 'agent.task.failure',
      title: `Task failed: ${TEST_TASK}`,
      link: '/agent/run-at-cap',
    });
    expect(String(notifyCalls[0].payload.message)).toContain(`${RESUME_MAX_ATTEMPTS} attempts`);
  });

  it('refunds the attempt when the resume dispatch is skipped — budget unchanged, run still resumable', () => {
    // Mirrors the scheduler's resume branch when the executor returns
    // status 'skipped' (another run of the task active — e.g. a long
    // manual run): the gate pre-increments, the skipped dispatch refunds.
    let run = insertResumableRun('run-skip-refund', 0);

    expect(gate(run)).toBe('resume');
    expect(getRun('run-skip-refund', ALL_PROJECTS_SCOPE)!.resume_attempts).toBe(1);

    // dispatchAgentRun returned 'skipped' → refund.
    expect(refundRunResumeAttempt('run-skip-refund', ALL_PROJECTS_SCOPE)).toBe(1);

    run = getRun('run-skip-refund', ALL_PROJECTS_SCOPE)!;
    expect(run.resume_attempts).toBe(0);
    expect(run.resumable).toBe(1);
    expect(run.resume_status).toBe(RESUME_STATUS_READY);

    // The next tick still gets a real resume.
    expect(gate(run)).toBe('resume');
  });

  it('skipped ticks during a long manual run can never exhaust the budget', () => {
    let run = insertResumableRun('run-manual-window', 0);

    // RESUME_MAX_ATTEMPTS + 2 ticks that all skip (a manual run of the
    // same task stays active the whole time).
    for (let tick = 0; tick < RESUME_MAX_ATTEMPTS + 2; tick += 1) {
      expect(gate(run)).toBe('resume');
      refundRunResumeAttempt(run.id, ALL_PROJECTS_SCOPE);
      run = getRun('run-manual-window', ALL_PROJECTS_SCOPE)!;
    }

    expect(run.resume_attempts).toBe(0);
    expect(run.resumable).toBe(1);
    expect(notifyCalls).toHaveLength(0);
  });

  it('does not select session-expired runs in the first place', () => {
    // A session-expired run is already terminal (resumable=0): the scheduler
    // never hands it to the gate, so the cap leaves it untouched.
    insertRun({
      id: 'run-expired',
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK,
      status: 'failed',
      resumable: 0,
      resume_status: 'session_expired',
      started_at: epochNow() - 120,
      completed_at: epochNow() - 60,
    });

    expect(getLatestResumableRunForTask(TEST_AGENT_ID, TEST_TASK, ALL_PROJECTS_SCOPE)).toBeNull();
    const row = getRun('run-expired', ALL_PROJECTS_SCOPE)!;
    expect(row.resume_status).toBe('session_expired');
    expect(row.resume_attempts).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Regression test 1 (belt half) + Regression test 4 (exhaustion-shape
  // fall-through). See runs-supersede.test.ts for the completion-time
  // sweep (primary) half of test 1.
  // ---------------------------------------------------------------------

  describe('supersede belt', () => {
    it('terminal-marks a resumable run as superseded when a newer equivalent run completed, without consuming resume_attempts', () => {
      const run = insertResumableRun('run-stale-legacy', 0);
      // A newer COMPLETED equivalent run — same agent/task/scope/dry_run,
      // completed after the failed run's own completed_at. Simulates a
      // legacy row written before the completion-time sweep existed.
      insertRun({
        id: 'run-newer-completed',
        agent_id: TEST_AGENT_ID,
        task: TEST_TASK,
        status: 'completed',
        started_at: run.completed_at! + 10,
        completed_at: run.completed_at! + 20,
      });

      expect(gate(run)).toBe('superseded');

      const after = getRun('run-stale-legacy', ALL_PROJECTS_SCOPE)!;
      expect(after.resumable).toBe(0);
      expect(after.resume_status).toBe(RESUME_STATUS_SUPERSEDED);
      // The belt fires BEFORE the resume_attempts cap logic — the budget
      // counter is untouched, distinguishing this from the exhaustion path.
      expect(after.resume_attempts).toBe(0);
      expect(notifyCalls).toHaveLength(0);

      // Regression test 4 (exhaustion-shape fall-through): the next lookup
      // in the SAME tick sees no resumable run, exactly like the
      // 'exhausted' path — dispatchScheduledTask's generic
      // `if (gate === 'resume') {...return} // fall through` structure
      // treats 'superseded' identically to 'exhausted', so the tick is not
      // a no-op even though gateScheduledResume already terminal-marked
      // the old run.
      expect(getLatestResumableRunForTask(TEST_AGENT_ID, TEST_TASK, ALL_PROJECTS_SCOPE)).toBeNull();
    });

    it('supersedes even when the newer completed run has a DIFFERENT instruction (same scheduled job, dynamic per-run instruction)', () => {
      const run = insertResumableRun('run-instr-scoped', 0);
      applyRunUpdate(run.id, { instruction: 'candidate X' }, ALL_PROJECTS_SCOPE);
      const refreshed = getRun(run.id, ALL_PROJECTS_SCOPE)!;

      insertRun({
        id: 'run-newer-different-instruction',
        agent_id: TEST_AGENT_ID,
        task: TEST_TASK,
        instruction: 'candidate Y',
        status: 'completed',
        started_at: refreshed.completed_at! + 10,
        completed_at: refreshed.completed_at! + 20,
      });

      expect(gate(refreshed)).toBe('superseded');
      const after = getRun('run-instr-scoped', ALL_PROJECTS_SCOPE)!;
      expect(after.resumable).toBe(0);
      expect(after.resume_status).toBe(RESUME_STATUS_SUPERSEDED);
    });

    it('does NOT supersede a live run using a completed DRY run as the equivalent', () => {
      const run = insertResumableRun('run-live-scoped', 0);

      insertRun({
        id: 'run-newer-dry-completed',
        agent_id: TEST_AGENT_ID,
        task: TEST_TASK,
        dryRun: true,
        status: 'completed',
        started_at: run.completed_at! + 10,
        completed_at: run.completed_at! + 20,
      });

      expect(gate(run)).toBe('resume');
      const after = getRun('run-live-scoped', ALL_PROJECTS_SCOPE)!;
      expect(after.resumable).toBe(1);
      expect(after.resume_status).toBe(RESUME_STATUS_READY);
    });

    it('does not supersede when the completed equivalent run finished BEFORE the failed run\'s own completion', () => {
      // An older completion must never supersede a NEWER failed attempt —
      // only a completion that postdates COALESCE(completed_at, started_at)
      // counts.
      insertRun({
        id: 'run-older-completed',
        agent_id: TEST_AGENT_ID,
        task: TEST_TASK,
        status: 'completed',
        started_at: epochNow() - 500,
        completed_at: epochNow() - 400,
      });
      const run = insertResumableRun('run-newer-failed', 0);

      expect(gate(run)).toBe('resume');
      const after = getRun('run-newer-failed', ALL_PROJECTS_SCOPE)!;
      expect(after.resumable).toBe(1);
    });

    it('uses COALESCE(completed_at, started_at) on the failed side — an interrupted run with NULL completed_at is still supersedable', () => {
      // markRunningRunsInterrupted leaves completed_at NULL on the failed
      // row. The belt must fall back to started_at for that side of the
      // comparison rather than treating NULL as "never" or as "now".
      const interruptedId = 'run-interrupted-null-completed';
      insertRun({
        id: interruptedId,
        agent_id: TEST_AGENT_ID,
        task: TEST_TASK,
        status: 'failed',
        resumable: 1,
        resume_status: RESUME_STATUS_READY,
        started_at: epochNow() - 300,
        completed_at: null,
      });
      const interrupted = getRun(interruptedId, ALL_PROJECTS_SCOPE)!;

      insertRun({
        id: 'run-newer-completed-2',
        agent_id: TEST_AGENT_ID,
        task: TEST_TASK,
        status: 'completed',
        started_at: epochNow() - 100,
        completed_at: epochNow() - 50,
      });

      expect(gate(interrupted)).toBe('superseded');
      const after = getRun(interruptedId, ALL_PROJECTS_SCOPE)!;
      expect(after.resumable).toBe(0);
      expect(after.resume_status).toBe(RESUME_STATUS_SUPERSEDED);
    });

    // -----------------------------------------------------------------
    // Regression: resume-overwrites-started_at zombie (discovery-936c7370
    // live incident). Compares against runs-supersede.test.ts's boot-sweep
    // pair for the same shape via the OTHER enforcement point (the
    // gate-time belt, reached through gateScheduledResume).
    // -----------------------------------------------------------------

    it('supersedes a run whose own zombie resume inflated completed_at/resumed_at past the superseding completion, using ORIGINAL dispatch time', () => {
      const t0 = epochNow() - 10_000;
      const run = insertRun({
        id: 'run-zombie-belt',
        agent_id: TEST_AGENT_ID,
        task: TEST_TASK,
        status: 'failed',
        resumable: 1,
        resume_status: RESUME_STATUS_READY,
        started_at: t0,
        resumed_at: t0 + 5_000,
        completed_at: t0 + 5_010,
      });
      insertRun({
        id: 'run-superseding-belt',
        agent_id: TEST_AGENT_ID,
        task: TEST_TASK,
        status: 'completed',
        started_at: t0 + 100,
        completed_at: t0 + 2_300,
      });

      expect(gate(run)).toBe('superseded');
      const after = getRun('run-zombie-belt', ALL_PROJECTS_SCOPE)!;
      expect(after.resumable).toBe(0);
      expect(after.resume_status).toBe(RESUME_STATUS_SUPERSEDED);
    });

    it('does NOT supersede a run whose ORIGINAL dispatch postdates the last equivalent completion — genuinely newer work resumes normally', () => {
      const t0 = epochNow() - 10_000;
      insertRun({
        id: 'run-older-equivalent-belt',
        agent_id: TEST_AGENT_ID,
        task: TEST_TASK,
        status: 'completed',
        started_at: t0,
        completed_at: t0 + 50,
      });
      const run = insertRun({
        id: 'run-genuinely-newer-belt',
        agent_id: TEST_AGENT_ID,
        task: TEST_TASK,
        status: 'failed',
        resumable: 1,
        resume_status: RESUME_STATUS_READY,
        started_at: t0 + 5_000,
        completed_at: t0 + 5_010,
      });

      expect(gate(run)).toBe('resume');
      const after = getRun('run-genuinely-newer-belt', ALL_PROJECTS_SCOPE)!;
      expect(after.resumable).toBe(1);
      expect(after.resume_status).toBe(RESUME_STATUS_READY);
    });
  });
});
