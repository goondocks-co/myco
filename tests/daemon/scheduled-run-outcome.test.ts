/**
 * Seam tests for the scheduler's post-dispatch notification path
 * (`notifyScheduledRunOutcome`, called by `dispatchScheduledTask` after
 * every dispatch). Covers the harness-health findings consumer at the
 * scheduled seam: a completed harness-health run with an anomalous
 * `harness-health` report emits the findings notification alongside the
 * regular task-success notification; other tasks and failed runs do not.
 *
 * Exported-function seam (the gateScheduledResume precedent):
 * `dispatchScheduledTask` is a closure inside `registerScheduledTasks`, and
 * driving a full scheduler tick would need top-level module mocks that
 * poison other test files in the same bundled bun process.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { _clearNotifyDedupForTests } from '@myco/notifications/notify.js';
import { notifyScheduledRunOutcome } from '@myco/daemon/task-scheduling.js';
import { DEFAULT_AGENT_ID, epochSeconds } from '@myco/constants.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import type { DaemonLogger } from '@myco/daemon/logger.js';

const TEST_PROJECT_ID = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TEST_PROJECT_SCOPE_ID = assertGroveProjectId(TEST_PROJECT_ID);

const stubLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as DaemonLogger;

let VAULT_DIR: string;

function seedCompletedRun(runId: string, task: string) {
  insertRun({
    id: runId,
    project_id: TEST_PROJECT_ID,
    agent_id: DEFAULT_AGENT_ID,
    task,
    status: 'completed',
    started_at: epochSeconds(),
    completed_at: epochSeconds(),
  });
}

function seedAnomalousReport(runId: string) {
  insertReport({
    run_id: runId,
    project_id: TEST_PROJECT_ID,
    agent_id: DEFAULT_AGENT_ID,
    action: 'harness-health',
    summary: 'harness health scan',
    details: JSON.stringify({
      cap_hits: [{ run_id: 'run-victim', task: 'skill-evolve', phase_name: 'assess' }],
    }),
    created_at: epochSeconds(),
  });
}

function notificationTypes(): string[] {
  const rows = getDatabase().prepare('SELECT type FROM notifications').all() as Array<{ type: string }>;
  return rows.map((r) => r.type);
}

function findingsRow(): { title: string; message: string | null } | undefined {
  return getDatabase().prepare(
    'SELECT title, message FROM notifications WHERE type = ?',
  ).get('agent.harness-health.findings') as { title: string; message: string | null } | undefined;
}

describe('notifyScheduledRunOutcome — scheduled dispatch seam', () => {
  beforeAll(() => {
    setupTestDb();
    VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-sched-outcome-'));
    fs.writeFileSync(path.join(VAULT_DIR, 'myco.yaml'), 'version: 3\n');
  });
  afterAll(() => {
    teardownTestDb();
    fs.rmSync(VAULT_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    cleanTestDb();
    _clearNotifyDedupForTests();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Myco Agent', created_at: epochSeconds() });
  });

  it('emits the findings notification for a completed harness-health run with an anomalous report', async () => {
    seedCompletedRun('hh-sched-run', 'harness-health');
    seedAnomalousReport('hh-sched-run');

    await notifyScheduledRunOutcome({
      result: { runId: 'hh-sched-run', status: 'completed' },
      taskName: 'harness-health',
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      config: loadMergedConfig(VAULT_DIR),
      logger: stubLogger,
    });

    const types = notificationTypes();
    expect(types).toContain('agent.task.success');
    expect(types).toContain('agent.harness-health.findings');
    const row = findingsRow();
    expect(row?.title).toContain('cap_hits');
    expect(row?.message).toContain('skill-evolve');
    expect(row?.message).toContain('run-victim');
  });

  it('does not emit the findings notification for a completed run of another task', async () => {
    seedCompletedRun('other-sched-run', 'vault-evolve');
    seedAnomalousReport('other-sched-run');

    await notifyScheduledRunOutcome({
      result: { runId: 'other-sched-run', status: 'completed' },
      taskName: 'vault-evolve',
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      config: loadMergedConfig(VAULT_DIR),
      logger: stubLogger,
    });

    const types = notificationTypes();
    expect(types).toContain('agent.task.success');
    expect(types).not.toContain('agent.harness-health.findings');
  });

  it('does not emit the findings notification for a failed harness-health run', async () => {
    insertRun({
      id: 'hh-sched-failed',
      project_id: TEST_PROJECT_ID,
      agent_id: DEFAULT_AGENT_ID,
      task: 'harness-health',
      status: 'failed',
      started_at: epochSeconds(),
      completed_at: epochSeconds(),
      error: 'boom',
    });
    seedAnomalousReport('hh-sched-failed');

    await notifyScheduledRunOutcome({
      result: { runId: 'hh-sched-failed', status: 'failed', error: 'boom' },
      taskName: 'harness-health',
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      config: loadMergedConfig(VAULT_DIR),
      logger: stubLogger,
    });

    const types = notificationTypes();
    expect(types).toContain('agent.task.failure');
    expect(types).not.toContain('agent.harness-health.findings');
  });

  it('a consumer failure never propagates into the completion path', async () => {
    seedCompletedRun('hh-sched-resilient', 'harness-health');
    // Corrupt report details — the consumer parses leniently and no-ops.
    insertReport({
      run_id: 'hh-sched-resilient',
      project_id: TEST_PROJECT_ID,
      agent_id: DEFAULT_AGENT_ID,
      action: 'harness-health',
      summary: 'scan',
      details: 'not json',
      created_at: epochSeconds(),
    });

    await expect(notifyScheduledRunOutcome({
      result: { runId: 'hh-sched-resilient', status: 'completed' },
      taskName: 'harness-health',
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      config: loadMergedConfig(VAULT_DIR),
      logger: stubLogger,
    })).resolves.toBeUndefined();

    const types = notificationTypes();
    expect(types).toContain('agent.task.success');
    expect(types).not.toContain('agent.harness-health.findings');
  });
});
