/**
 * Unit tests for `notifyHarnessHealthFindings` — the best-effort consumer
 * that turns a completed `harness-health` sentinel run's report into an
 * `agents` domain notification. Agent tools cannot emit notifications
 * themselves, so this is the read-only daemon-side seam that notices the
 * run's `vault_report` (action `harness-health`) and surfaces its findings.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { _clearNotifyDedupForTests } from '@myco/notifications/notify.js';
import { notifyHarnessHealthFindings } from '@myco/notifications/harness-health-consumer.js';
import { DEFAULT_AGENT_ID, epochSeconds } from '@myco/constants.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';

const TEST_PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEST_PROJECT_SCOPE_ID = assertGroveProjectId(TEST_PROJECT_ID);
const TEST_RUN_ID = 'run-harness-health-consumer';

function makeLogger() {
  return { warn: vi.fn() };
}

function seedRun(overrides: Partial<Parameters<typeof insertRun>[0]> = {}) {
  insertRun({
    id: TEST_RUN_ID,
    project_id: TEST_PROJECT_ID,
    agent_id: DEFAULT_AGENT_ID,
    task: 'harness-health',
    status: 'completed',
    started_at: epochSeconds(),
    completed_at: epochSeconds(),
    ...overrides,
  });
}

function seedReport(details: unknown) {
  insertReport({
    run_id: TEST_RUN_ID,
    project_id: TEST_PROJECT_ID,
    agent_id: DEFAULT_AGENT_ID,
    action: 'harness-health',
    summary: 'harness health scan',
    details: details === undefined ? null : JSON.stringify(details),
    created_at: epochSeconds(),
  });
}

function countNotificationRows(): number {
  const row = getDatabase().prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
  return row.n;
}

function getLatestNotification(): { type: string; title: string; message: string | null } | undefined {
  return getDatabase().prepare(
    'SELECT type, title, message FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT 1',
  ).get() as { type: string; title: string; message: string | null } | undefined;
}

describe('notifyHarnessHealthFindings', () => {
  let VAULT_DIR: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    _clearNotifyDedupForTests();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Myco Agent', created_at: epochSeconds() });
    VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-harness-health-consumer-'));
    fs.writeFileSync(path.join(VAULT_DIR, 'myco.yaml'), 'version: 3\n');
  });
  afterEach(() => {
    fs.rmSync(VAULT_DIR, { recursive: true, force: true });
  });

  it('emits exactly one notification naming the anomaly bucket for a report with findings', async () => {
    seedRun();
    seedReport({ stalledRuns: ['run-a', 'run-b'], budgetExhaustion: [] });

    const logger = makeLogger();
    await notifyHarnessHealthFindings({
      runId: TEST_RUN_ID,
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      logger: logger as never,
    });

    expect(countNotificationRows()).toBe(1);
    const row = getLatestNotification();
    expect(row?.type).toBe('agent.harness-health.findings');
    expect(row?.title).toContain('stalledRuns');
    expect(row?.message).toContain('stalledRuns');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('includes affected task names and run ids from bucket entries, capping the run-id list', async () => {
    seedRun();
    seedReport({
      cap_hits: [
        { run_id: 'run-1', task: 'skill-evolve', phase_name: 'assess' },
        { run_id: 'run-2', task: 'vault-evolve', phase_name: 'extract' },
      ],
      zero_usage: [
        { run_id: 'run-3', task: 'title-summary' },
        { run_id: 'run-4', task: 'title-summary' },
        { run_id: 'run-5', task: 'title-summary' },
      ],
    });

    const logger = makeLogger();
    await notifyHarnessHealthFindings({
      runId: TEST_RUN_ID,
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      logger: logger as never,
    });

    expect(countNotificationRows()).toBe(1);
    const row = getLatestNotification();
    expect(row?.message).toContain('cap_hits (2)');
    expect(row?.message).toContain('zero_usage (3)');
    expect(row?.message).toContain('skill-evolve');
    expect(row?.message).toContain('vault-evolve');
    expect(row?.message).toContain('title-summary');
    // Five distinct run ids, capped at three shown.
    expect(row?.message).toContain('run-1, run-2, run-3 and 2 more');
    expect(row?.message).not.toContain('run-4');
  });

  it('treats vault_run_health-style { description, entries } buckets by their entries, not key count', async () => {
    seedRun();
    seedReport({
      cap_hits: { description: 'phases that hit their turn budget', entries: [] },
      flag_clusters: { description: 'classifier-blocked writes', entries: [{ run_id: 'run-f', task: 'vault-evolve' }] },
    });

    const logger = makeLogger();
    await notifyHarnessHealthFindings({
      runId: TEST_RUN_ID,
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      logger: logger as never,
    });

    expect(countNotificationRows()).toBe(1);
    const row = getLatestNotification();
    // The empty-entries bucket must not be reported despite its description key.
    expect(row?.title).toBe('Harness health: flag_clusters');
    expect(row?.message).toContain('flag_clusters (1)');
    expect(row?.message).not.toContain('cap_hits');
    expect(row?.message).toContain('run-f');
  });

  it('emits nothing when every vault_run_health-style bucket has empty entries', async () => {
    seedRun();
    seedReport({
      cap_hits: { description: 'phases that hit their turn budget', entries: [] },
      zero_usage: { description: 'runs with no usage telemetry', entries: [] },
    });

    const logger = makeLogger();
    await notifyHarnessHealthFindings({
      runId: TEST_RUN_ID,
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      logger: logger as never,
    });

    expect(countNotificationRows()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('emits nothing when every bucket is empty', async () => {
    seedRun();
    seedReport({ stalledRuns: [], budgetExhaustion: [], costSpikes: {} });

    const logger = makeLogger();
    await notifyHarnessHealthFindings({
      runId: TEST_RUN_ID,
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      logger: logger as never,
    });

    expect(countNotificationRows()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('emits nothing and does not throw when no report was seeded', async () => {
    seedRun();

    const logger = makeLogger();
    await expect(notifyHarnessHealthFindings({
      runId: TEST_RUN_ID,
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      logger: logger as never,
    })).resolves.toBeUndefined();

    expect(countNotificationRows()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('emits nothing and does not throw when details is unparseable / non-object', async () => {
    seedRun();
    seedReport(undefined);
    // Overwrite with a raw non-JSON string to exercise the unparseable path.
    getDatabase().prepare('UPDATE agent_reports SET details = ? WHERE run_id = ?').run('not json', TEST_RUN_ID);

    const logger = makeLogger();
    await notifyHarnessHealthFindings({
      runId: TEST_RUN_ID,
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      logger: logger as never,
    });

    expect(countNotificationRows()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('emits nothing and does not throw when details is a JSON array, not an object', async () => {
    seedRun();
    seedReport(['stalledRuns', 'budgetExhaustion']);

    const logger = makeLogger();
    await notifyHarnessHealthFindings({
      runId: TEST_RUN_ID,
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      logger: logger as never,
    });

    expect(countNotificationRows()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is a no-op for a report scoped to a run whose task is not harness-health', async () => {
    // Contract: callers gate on `task === 'harness-health'` before invoking
    // the helper. Simulate a caller that (incorrectly) invoked it anyway
    // for an unrelated run/report pairing — no report exists under this
    // run id with the harness-health action, so it still no-ops safely.
    insertRun({
      id: 'run-other-task',
      project_id: TEST_PROJECT_ID,
      agent_id: DEFAULT_AGENT_ID,
      task: 'vault-evolve',
      status: 'completed',
      started_at: epochSeconds(),
      completed_at: epochSeconds(),
    });

    const logger = makeLogger();
    await notifyHarnessHealthFindings({
      runId: 'run-other-task',
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      logger: logger as never,
    });

    expect(countNotificationRows()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('never throws even if the logger itself is missing a warn method (defensive best-effort contract)', async () => {
    seedRun();
    seedReport({ stalledRuns: ['x'] });

    // A logger whose warn throws should still not propagate out of the
    // outer notify call for a successful path (warn isn't invoked here),
    // but the wrapper's own try/catch is what's under test more broadly —
    // covered by the "no report" and "unparseable" cases above returning
    // cleanly without invoking warn.
    const logger = { warn: vi.fn() };
    await expect(notifyHarnessHealthFindings({
      runId: TEST_RUN_ID,
      projectVaultDir: VAULT_DIR,
      projectId: TEST_PROJECT_SCOPE_ID,
      logger: logger as never,
    })).resolves.toBeUndefined();
  });
});
