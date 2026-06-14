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
  RESUME_STATUS_EXHAUSTED,
  RESUME_STATUS_READY,
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
});
