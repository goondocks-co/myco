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
      instruction: null,
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
      instruction: null,
    });

    expect(swept).toBe(0);
  });

  it('does NOT supersede a resumable run for a DIFFERENT instruction (candidate-scoped work stays isolated)', () => {
    const stale = insertRun(makeResumableFailed({ id: 'run-candidate-x', instruction: 'candidate X' }));
    const completing = insertRun(makeRun({ id: 'run-candidate-y', status: 'completed', instruction: 'candidate Y' }));

    const swept = supersedeEquivalentResumableRuns(completing.id, {
      agentId: TEST_AGENT_ID,
      taskName: TEST_TASK,
      scope: ALL_PROJECTS_SCOPE,
      dryRun: false,
      instruction: 'candidate Y',
    });

    expect(swept).toBe(0);
    const after = getRun(stale.id, ALL_PROJECTS_SCOPE)!;
    expect(after.resumable).toBe(1);
    expect(after.resume_status).toBe(RESUME_STATUS_READY);
  });

  it('supersedes when both the stale run and the completing run have NULL instruction', () => {
    const stale = insertRun(makeResumableFailed({ id: 'run-null-instr' }));
    const completing = insertRun(makeRun({ id: 'run-null-instr-complete', status: 'completed' }));

    const swept = supersedeEquivalentResumableRuns(completing.id, {
      agentId: TEST_AGENT_ID,
      taskName: TEST_TASK,
      scope: ALL_PROJECTS_SCOPE,
      dryRun: false,
      instruction: null,
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
      instruction: null,
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
      instruction: null,
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
      instruction: null,
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

  it('does not sweep a resumable run whose instruction differs from the completed run', () => {
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

    expect(sweepStaleSupersededRuns(ALL_PROJECTS_SCOPE)).toBe(0);
    expect(getRun(stale.id, ALL_PROJECTS_SCOPE)!.resumable).toBe(1);
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
});
