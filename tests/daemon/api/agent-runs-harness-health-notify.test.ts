/**
 * Seam tests for the harness-health findings consumer wired into the two
 * agent-run API completion paths:
 *   - POST /api/agent/run          (handleRun's resultPromise.then)
 *   - POST /api/agent/runs/:id/resume (handleResumeRun's resultPromise.then)
 *
 * Both seams call `notifyHarnessHealthFindings` when a harness-health task
 * completes. Seam 3 (resume) previously only logged on completion — no
 * notification path existed at all — so a manually-resumed harness-health
 * run's `vault_report` produced no notification. These tests assert both
 * seams now emit the finding notification.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { createAgentRunHandlers } from '@myco/daemon/api/agent-runs';
import type { RouteRequest } from '@myco/daemon/router';
import { makeTestRequestContext } from '../../helpers/request-context';
import { DEFAULT_AGENT_ID, epochSeconds } from '@myco/constants.js';
import { _clearNotifyDedupForTests } from '@myco/notifications/notify.js';

const PROJECT_ID = 'proj_33333333333333333333333333333333';
const GROVE_ID = 'grove_33333333333333333333333333333333';

// Seeded so the (unmocked) loadMergedConfig has a myco.yaml to read — a
// top-level mock of @myco/config/loader.js would poison other test files
// sharing the bundled bun process (see agent-runs-overrides-security.test.ts).
const VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-agent-runs-harness-health-'));
fs.writeFileSync(
  path.join(VAULT_DIR, 'myco.yaml'),
  'version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nnotifications:\n  enabled: true\n',
  'utf-8',
);

const runAgentSpy = vi.fn(async () => ({ runId: 'stub', status: 'completed' as const }));
mock.module('@myco/agent/executor.js', () => ({
  runAgent: (...args: unknown[]) => runAgentSpy(...args),
}));
mock.module('@myco/agent/config-resolver.js', () => ({
  hasConfiguredProvider: () => true,
  resolveTaskDefinitionExecution: () => ({}),
}));

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    pathname: '/',
    requestContext: makeTestRequestContext({ vaultDir: VAULT_DIR, projectId: PROJECT_ID, groveId: GROVE_ID }),
    ...overrides,
  } as RouteRequest;
}

function makeHandlers() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return createAgentRunHandlers({
    vaultDir: VAULT_DIR,
    resolveEmbeddingManager: () => ({} as never),
    logger: logger as never,
  });
}

function findingsNotificationRow(): { type: string; title: string; project_id: string } | undefined {
  return getDatabase().prepare(
    `SELECT type, title, project_id FROM notifications WHERE type = ?`,
  ).get('agent.harness-health.findings') as { type: string; title: string; project_id: string } | undefined;
}

describe('harness-health findings notification — agent-run API seams', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    _clearNotifyDedupForTests();
    runAgentSpy.mockClear();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Test', created_at: epochSeconds() });
  });

  describe('handleRun (Seam 2)', () => {
    // handleRun pre-generates the run id and hands it to the executor —
    // the id isn't known until the (mocked) executor is invoked, so the
    // agent_runs row (required by agent_reports' FK) and the report are
    // both seeded from inside the mock implementation, keyed off the real
    // generated id.
    it('emits a harness-health findings notification when the completed run is a harness-health task', async () => {
      runAgentSpy.mockImplementationOnce(async (vaultDir: string, opts: { runId?: string }) => {
        const runId = opts.runId!;
        insertRun({
          id: runId,
          project_id: PROJECT_ID,
          agent_id: DEFAULT_AGENT_ID,
          task: 'harness-health',
          status: 'completed',
          started_at: epochSeconds(),
          completed_at: epochSeconds(),
        });
        insertReport({
          run_id: runId,
          project_id: PROJECT_ID,
          agent_id: DEFAULT_AGENT_ID,
          action: 'harness-health',
          summary: 'scan',
          details: JSON.stringify({ stalledRuns: ['run-x'] }),
          created_at: epochSeconds(),
        });
        return { runId, status: 'completed' as const };
      });

      const { handleRun } = makeHandlers();
      await handleRun(makeRequest({
        body: { task: 'harness-health', instruction: 'scan', agentId: DEFAULT_AGENT_ID },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const row = findingsNotificationRow();
      expect(row).toBeTruthy();
      expect(row?.project_id).toBe(PROJECT_ID);
      expect(row?.title).toContain('stalledRuns');
    });

    // Symmetry with the resume seam's "does not complete" case below: a
    // harness-health run that finishes with a non-'completed', non-'failed'
    // status (e.g. 'skipped') must not fire the consumer either. Before this
    // fix, handleRun only branched on `result.status === 'failed'` and fired
    // the consumer for every other status, including 'skipped'.
    it('does not emit a findings notification when the harness-health run is skipped, not completed', async () => {
      runAgentSpy.mockImplementationOnce(async (vaultDir: string, opts: { runId?: string }) => {
        const runId = opts.runId!;
        insertRun({
          id: runId,
          project_id: PROJECT_ID,
          agent_id: DEFAULT_AGENT_ID,
          task: 'harness-health',
          status: 'skipped',
          started_at: epochSeconds(),
          completed_at: epochSeconds(),
        });
        insertReport({
          run_id: runId,
          project_id: PROJECT_ID,
          agent_id: DEFAULT_AGENT_ID,
          action: 'harness-health',
          summary: 'scan',
          details: JSON.stringify({ stalledRuns: ['run-x'] }),
          created_at: epochSeconds(),
        });
        return { runId, status: 'skipped' as const };
      });

      const { handleRun } = makeHandlers();
      await handleRun(makeRequest({
        body: { task: 'harness-health', instruction: 'scan', agentId: DEFAULT_AGENT_ID },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(findingsNotificationRow()).toBeFalsy();
    });

    it('does not emit a findings notification for a completed run of a different task', async () => {
      runAgentSpy.mockImplementationOnce(async (vaultDir: string, opts: { runId?: string }) => {
        const runId = opts.runId!;
        insertRun({
          id: runId,
          project_id: PROJECT_ID,
          agent_id: DEFAULT_AGENT_ID,
          task: 'vault-evolve',
          status: 'completed',
          started_at: epochSeconds(),
          completed_at: epochSeconds(),
        });
        insertReport({
          run_id: runId,
          project_id: PROJECT_ID,
          agent_id: DEFAULT_AGENT_ID,
          action: 'harness-health',
          summary: 'scan',
          details: JSON.stringify({ stalledRuns: ['run-x'] }),
          created_at: epochSeconds(),
        });
        return { runId, status: 'completed' as const };
      });

      const { handleRun } = makeHandlers();
      await handleRun(makeRequest({
        body: { task: 'vault-evolve', instruction: 'go', agentId: DEFAULT_AGENT_ID },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(findingsNotificationRow()).toBeFalsy();
    });
  });

  describe('handleResumeRun (Seam 3 — the gap this task closes)', () => {
    it('emits a harness-health findings notification when a resumed harness-health run completes', async () => {
      runAgentSpy.mockImplementationOnce(async () => ({ runId: 'hh-run-resumed', status: 'completed' as const }));

      insertRun({
        id: 'hh-run-resumed',
        project_id: PROJECT_ID,
        agent_id: DEFAULT_AGENT_ID,
        task: 'harness-health',
        instruction: 'scan',
        status: 'failed',
        resumable: 1,
        started_at: epochSeconds(),
      });
      insertReport({
        run_id: 'hh-run-resumed',
        project_id: PROJECT_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'harness-health',
        summary: 'scan',
        details: JSON.stringify({ budgetExhaustion: ['task-a', 'task-b'] }),
        created_at: epochSeconds(),
      });

      const { handleResumeRun } = makeHandlers();
      const response = await handleResumeRun(makeRequest({
        params: { id: 'hh-run-resumed' },
        body: { mode: 'manual' },
      }));
      expect(response.body).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const row = findingsNotificationRow();
      expect(row).toBeTruthy();
      expect(row?.project_id).toBe(PROJECT_ID);
      expect(row?.title).toContain('budgetExhaustion');
    });

    it('does not emit a findings notification when the resumed run is not a harness-health task', async () => {
      runAgentSpy.mockImplementationOnce(async () => ({ runId: 'other-run-resumed', status: 'completed' as const }));

      insertRun({
        id: 'other-run-resumed',
        project_id: PROJECT_ID,
        agent_id: DEFAULT_AGENT_ID,
        task: 'vault-evolve',
        instruction: 'go',
        status: 'failed',
        resumable: 1,
        started_at: epochSeconds(),
      });
      insertReport({
        run_id: 'other-run-resumed',
        project_id: PROJECT_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'harness-health',
        summary: 'scan',
        details: JSON.stringify({ stalledRuns: ['run-x'] }),
        created_at: epochSeconds(),
      });

      const { handleResumeRun } = makeHandlers();
      await handleResumeRun(makeRequest({
        params: { id: 'other-run-resumed' },
        body: { mode: 'manual' },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(findingsNotificationRow()).toBeFalsy();
    });

    it('does not emit a findings notification when the resumed harness-health run does not complete', async () => {
      runAgentSpy.mockImplementationOnce(async () => ({ runId: 'hh-run-still-failed', status: 'failed' as const, error: 'boom' }));

      insertRun({
        id: 'hh-run-still-failed',
        project_id: PROJECT_ID,
        agent_id: DEFAULT_AGENT_ID,
        task: 'harness-health',
        instruction: 'scan',
        status: 'failed',
        resumable: 1,
        started_at: epochSeconds(),
      });
      insertReport({
        run_id: 'hh-run-still-failed',
        project_id: PROJECT_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'harness-health',
        summary: 'scan',
        details: JSON.stringify({ stalledRuns: ['run-x'] }),
        created_at: epochSeconds(),
      });

      const { handleResumeRun } = makeHandlers();
      await handleResumeRun(makeRequest({
        params: { id: 'hh-run-still-failed' },
        body: { mode: 'manual' },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(findingsNotificationRow()).toBeFalsy();
    });
  });
});
