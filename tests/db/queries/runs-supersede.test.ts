/**
 * Regression test 1 (primary half) for the resume-admission gate:
 * completion-time supersede sweep + boot-time backfill sweep.
 *
 * `supersedeEquivalentResumableRuns` is called from the executor's success
 * path (executor.ts) immediately after a run completes — these tests
 * exercise the query helper directly, matching the pattern in
 * `runs.test.ts`. The gate-time belt (`hasNewerCompletedEquivalentRun` /
 * `findNewerCompletedEquivalentRun`) is covered in
 * `tests/daemon/scheduled-resume-gate.test.ts`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import {
  insertRun,
  getRun,
  supersedeEquivalentResumableRuns,
  sweepStaleSupersededRuns,
  RESUME_STATUS_SUPERSEDED,
  RESUME_STATUS_READY,
  type RunInsert,
} from '@myco/db/queries/runs.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const TEST_AGENT_ID = 'supersede-test-agent';
const TEST_TASK = 'skill-evolve';

function makeRun(overrides: Partial<RunInsert> = {}): RunInsert {
  return {
    id: `run-${Math.random().toString(36).slice(2, 10)}`,
    agent_id: TEST_AGENT_ID,
    task: TEST_TASK,
    ...overrides,
  };
}

function makeResumableFailed(overrides: Partial<RunInsert> = {}): RunInsert {
  return makeRun({
    status: 'failed',
    resumable: 1,
    resume_status: RESUME_STATUS_READY,
    started_at: epochNow() - 200,
    completed_at: epochNow() - 100,
    ...overrides,
  });
}

describe('supersedeEquivalentResumableRuns (completion-time sweep)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: TEST_AGENT_ID, name: 'Supersede Test Agent', created_at: epochNow() });
  });

  it('terminal-marks an older resumable failed run for the same task/scope', () => {
    const stale = insertRun(makeResumableFailed({ id: 'run-old' }));
    const completing = insertRun(makeRun({ id: 'run-completing', status: 'completed' }));

    const swept = supersedeEquivalentResumableRuns(completing.id, {
      agentId: TEST_AGENT_ID,
      taskName: TEST_TASK,
      scope: ALL_PROJECTS_SCOPE,
      dryRun: false,
    });

    expect(swept).toBe(1);
    const after = getRun(stale.id, ALL_PROJECTS_SCOPE)!;
    expect(after.resumable).toBe(0);
    expect(after.resume_status).toBe(RESUME_STATUS_SUPERSEDED);
  });

  it('never supersedes the completing run itself', () => {
    // A run that completes AFTER a resume (resumable was reset to 0 by the
    // executor's resume-restore block before this ran) must not somehow
    // match its own id via the equivalence key.
    const completing = insertRun(makeRun({ id: 'run-self', status: 'completed' }));

    const swept = supersedeEquivalentResumableRuns(completing.id, {
      agentId: TEST_AGENT_ID,
      taskName: TEST_TASK,
      scope: ALL_PROJECTS_SCOPE,
      dryRun: false,
    });

    expect(swept).toBe(0);
  });

  it('PROD SCENARIO: supersedes a resumable run of the same scheduled job even when instructions differ (dynamic per-run instruction, e.g. skill-evolve embeds live skill state)', () => {
    // Verified live on prod 1.2.12: a completed skill-evolve run retired
    // none of 3 equivalent-job zombies because every run — completed and
    // failed alike — carried a different dynamically-built instruction
    // string. The scheduled-job identity is (agent_id, task, project scope,
    // dry_run) — instruction body must NOT gate equivalence.
    const stale = insertRun(makeResumableFailed({ id: 'run-dynamic-instr-zombie', instruction: 'Live skill state snapshot A' }));
    const completing = insertRun(makeRun({ id: 'run-dynamic-instr-complete', status: 'completed', instruction: 'Live skill state snapshot B (different run, same job)' }));

    const swept = supersedeEquivalentResumableRuns(completing.id, {
      agentId: TEST_AGENT_ID,
      taskName: TEST_TASK,
      scope: ALL_PROJECTS_SCOPE,
      dryRun: false,
    });

    expect(swept).toBe(1);
    const after = getRun(stale.id, ALL_PROJECTS_SCOPE)!;
    expect(after.resumable).toBe(0);
    expect(after.resume_status).toBe(RESUME_STATUS_SUPERSEDED);
  });

  it('supersedes when both the stale run and the completing run have NULL instruction', () => {
    const stale = insertRun(makeResumableFailed({ id: 'run-null-instr' }));
    const completing = insertRun(makeRun({ id: 'run-null-instr-complete', status: 'completed' }));

    const swept = supersedeEquivalentResumableRuns(completing.id, {
      agentId: TEST_AGENT_ID,
      taskName: TEST_TASK,
      scope: ALL_PROJECTS_SCOPE,
      dryRun: false,
    });

    expect(swept).toBe(1);
    expect(getRun(stale.id, ALL_PROJECTS_SCOPE)!.resumable).toBe(0);
  });

  it('does NOT supersede a LIVE resumable run when the completing run is a DRY run', () => {
    const liveStale = insertRun(makeResumableFailed({ id: 'run-live-stale', dryRun: false }));
    const completingDry = insertRun(makeRun({ id: 'run-completing-dry', status: 'completed', dryRun: true }));

    const swept = supersedeEquivalentResumableRuns(completingDry.id, {
      agentId: TEST_AGENT_ID,
      taskName: TEST_TASK,
      scope: ALL_PROJECTS_SCOPE,
      dryRun: true,
    });

    expect(swept).toBe(0);
    const after = getRun(liveStale.id, ALL_PROJECTS_SCOPE)!;
    expect(after.resumable).toBe(1);
  });

  it('does not touch a resumable run for a different task', () => {
    const otherTaskRun = insertRun(makeResumableFailed({ id: 'run-other-task', task: 'vault-evolve' }));
    const completing = insertRun(makeRun({ id: 'run-completing-2', status: 'completed' }));

    supersedeEquivalentResumableRuns(completing.id, {
      agentId: TEST_AGENT_ID,
      taskName: TEST_TASK,
      scope: ALL_PROJECTS_SCOPE,
      dryRun: false,
    });

    expect(getRun(otherTaskRun.id, ALL_PROJECTS_SCOPE)!.resumable).toBe(1);
  });

  it('sweeps multiple stale resumable runs at once', () => {
    insertRun(makeResumableFailed({ id: 'run-old-1' }));
    insertRun(makeResumableFailed({ id: 'run-old-2' }));
    const completing = insertRun(makeRun({ id: 'run-completing-3', status: 'completed' }));

    const swept = supersedeEquivalentResumableRuns(completing.id, {
      agentId: TEST_AGENT_ID,
      taskName: TEST_TASK,
      scope: ALL_PROJECTS_SCOPE,
      dryRun: false,
    });

    expect(swept).toBe(2);
  });
});

describe('sweepStaleSupersededRuns (boot-time backfill)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: TEST_AGENT_ID, name: 'Supersede Test Agent', created_at: epochNow() });
  });

  it('sweeps a pre-existing stale resumable row on boot using the same equivalence key', () => {
    const stale = insertRun(makeResumableFailed({ id: 'run-boot-stale', completed_at: epochNow() - 100 }));
    insertRun(makeRun({ id: 'run-boot-completed', status: 'completed', completed_at: epochNow() - 50 }));

    const swept = sweepStaleSupersededRuns(ALL_PROJECTS_SCOPE);

    expect(swept).toBe(1);
    const after = getRun(stale.id, ALL_PROJECTS_SCOPE)!;
    expect(after.resumable).toBe(0);
    expect(after.resume_status).toBe(RESUME_STATUS_SUPERSEDED);
  });

  it('is idempotent — a second boot pass matches zero rows', () => {
    insertRun(makeResumableFailed({ id: 'run-boot-stale-2', completed_at: epochNow() - 100 }));
    insertRun(makeRun({ id: 'run-boot-completed-2', status: 'completed', completed_at: epochNow() - 50 }));

    expect(sweepStaleSupersededRuns(ALL_PROJECTS_SCOPE)).toBe(1);
    expect(sweepStaleSupersededRuns(ALL_PROJECTS_SCOPE)).toBe(0);
  });

  it('sweeps a resumable run even when its instruction differs from the completed run (same scheduled job, dynamic per-run instruction)', () => {
    const stale = insertRun(makeResumableFailed({
      id: 'run-boot-instr-x',
      instruction: 'candidate X',
      completed_at: epochNow() - 100,
    }));
    insertRun(makeRun({
      id: 'run-boot-instr-y',
      status: 'completed',
      instruction: 'candidate Y',
      completed_at: epochNow() - 50,
    }));

    expect(sweepStaleSupersededRuns(ALL_PROJECTS_SCOPE)).toBe(1);
    expect(getRun(stale.id, ALL_PROJECTS_SCOPE)!.resumable).toBe(0);
  });

  it('handles an interrupted run (NULL completed_at) via COALESCE fallback to started_at', () => {
    const interrupted = insertRun({
      id: 'run-boot-interrupted',
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK,
      status: 'failed',
      resumable: 1,
      resume_status: RESUME_STATUS_READY,
      started_at: epochNow() - 300,
      completed_at: null,
    });
    insertRun(makeRun({ id: 'run-boot-completed-3', status: 'completed', completed_at: epochNow() - 100 }));

    expect(sweepStaleSupersededRuns(ALL_PROJECTS_SCOPE)).toBe(1);
    expect(getRun(interrupted.id, ALL_PROJECTS_SCOPE)!.resumable).toBe(0);
  });

  it('does not sweep a resumable run with no completed equivalent at all', () => {
    const untouched = insertRun(makeResumableFailed({ id: 'run-no-completion' }));

    expect(sweepStaleSupersededRuns(ALL_PROJECTS_SCOPE)).toBe(0);
    expect(getRun(untouched.id, ALL_PROJECTS_SCOPE)!.resumable).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Regression: the resume-overwrites-started_at zombie (discovery-936c7370
  // live incident, PR #622 follow-up). A resumed-but-still-failed run must
  // stay sweepable by its ORIGINAL dispatch time even after its own zombie
  // resume attempt inflates completed_at/resumed_at past the superseding
  // run's completion — started_at is what makes this comparison exact now
  // that resumes no longer re-stamp it.
  // ---------------------------------------------------------------------

  it('sweeps a run whose LAST-ATTEMPT timestamps are newer than the superseding completion, using its ORIGINAL dispatch time', () => {
    const t0 = epochNow() - 10_000;
    // Original dispatch far in the past — the zombie's own later resume
    // attempt (resumed_at/completed_at below) does NOT touch started_at.
    const zombie = insertRun({
      id: 'run-zombie-resumed-past-supersede',
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK,
      status: 'failed',
      resumable: 1,
      resume_status: RESUME_STATUS_READY,
      started_at: t0,
      // A stale resume attempt fired AFTER the superseding run below
      // completed — completed_at/resumed_at land later in wall-clock time
      // than the equivalent's completion, mirroring the live zombie shape.
      resumed_at: t0 + 5_000,
      completed_at: t0 + 5_010,
    });
    // The superseding equivalent completed BEFORE the zombie's own last
    // attempt, but AFTER the zombie's ORIGINAL dispatch.
    insertRun(makeRun({
      id: 'run-superseding-equivalent',
      status: 'completed',
      started_at: t0 + 100,
      completed_at: t0 + 2_300,
    }));

    const swept = sweepStaleSupersededRuns(ALL_PROJECTS_SCOPE);

    expect(swept).toBe(1);
    const after = getRun(zombie.id, ALL_PROJECTS_SCOPE)!;
    expect(after.resumable).toBe(0);
    expect(after.resume_status).toBe(RESUME_STATUS_SUPERSEDED);
  });

  it('does NOT sweep a run whose ORIGINAL dispatch postdates the last equivalent completion — genuinely newer work is preserved', () => {
    const t0 = epochNow() - 10_000;
    // The only completed equivalent finished well before this failed run
    // was ever dispatched — this failed run represents newer work and must
    // survive the sweep even though it is still resumable.
    insertRun(makeRun({
      id: 'run-older-equivalent',
      status: 'completed',
      started_at: t0,
      completed_at: t0 + 50,
    }));
    const newerDispatch = insertRun({
      id: 'run-genuinely-newer-dispatch',
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK,
      status: 'failed',
      resumable: 1,
      resume_status: RESUME_STATUS_READY,
      started_at: t0 + 5_000,
      completed_at: t0 + 5_010,
    });

    expect(sweepStaleSupersededRuns(ALL_PROJECTS_SCOPE)).toBe(0);
    const after = getRun(newerDispatch.id, ALL_PROJECTS_SCOPE)!;
    expect(after.resumable).toBe(1);
    expect(after.resume_status).toBe(RESUME_STATUS_READY);
  });
});
