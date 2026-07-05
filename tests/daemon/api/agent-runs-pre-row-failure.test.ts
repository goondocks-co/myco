/**
 * Covers the executor-throws-before-row-creation path in handleRun's catch:
 *   (a) a non-FK pre-row throw with the agents FK healthy -> persists a
 *       `failed` row with the pre-generated runId and fires an
 *       `agent.task.failure` notification.
 *   (b) the failed-row insert itself also faults -> falls back to an
 *       enriched ERROR log (runId + task + project) and a notification,
 *       with no row ever created.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { getRun } from '@myco/db/queries/runs.js';
import { createAgentRunHandlers } from '@myco/daemon/api/agent-runs';
import type { RouteRequest } from '@myco/daemon/router';
import { makeTestRequestContext } from '../../helpers/request-context';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { _clearNotifyDedupForTests } from '@myco/notifications/notify.js';

const epochNow = () => Math.floor(Date.now() / 1000);

// Real (unmocked) vault dir: loadMergedConfig needs a myco.yaml to read.
const VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-agent-runs-pre-row-'));
fs.writeFileSync(
  path.join(VAULT_DIR, 'myco.yaml'),
  'version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nnotifications:\n  enabled: true\n',
  'utf-8',
);

// Simulates a pre-row throw from the executor (e.g. provider resolution).
const DISPATCH_ERROR_MESSAGE = 'provider resolution blew up before the run row existed';
const runAgentSpy = vi.fn(async () => {
  throw new Error(DISPATCH_ERROR_MESSAGE);
});
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
    requestContext: makeTestRequestContext({ vaultDir: VAULT_DIR }),
    ...overrides,
  } as RouteRequest;
}

function makeHandlers(logger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }) {
  return createAgentRunHandlers({
    vaultDir: VAULT_DIR,
    resolveEmbeddingManager: () => ({} as never),
    logger: logger as never,
  });
}

// resultPromise.catch runs on a microtask after handleRun returns — flush it.
async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('POST /api/agent/run — pre-row dispatch failure surfacing', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    _clearNotifyDedupForTests();
    runAgentSpy.mockClear();
  });

  it('(a) persists a failed row with the pre-generated runId when a non-FK throw happens before row creation', async () => {
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Test', created_at: epochNow() });

    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { handleRun } = makeHandlers(logger);
    const response = await handleRun(makeRequest({
      body: { task: 'custom-pre-row-smoke', instruction: 'go' },
    }));
    const runId = (response.body as { runId?: string }).runId;
    expect(typeof runId).toBe('string');

    expect(response.body).toMatchObject({ ok: true, message: 'Agent started' });

    await flushMicrotasks();

    const row = getRun(runId!, ALL_PROJECTS_SCOPE);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('failed');
    expect(row?.task).toBe('custom-pre-row-smoke');
    expect(row?.error).toBe(DISPATCH_ERROR_MESSAGE);

    const errorCalls = logger.error.mock.calls as unknown as Array<[string, string, Record<string, unknown>]>;
    const enriched = errorCalls.find(([, message]) => message === 'Agent run threw before its run row was created');
    expect(enriched).toBeDefined();
    expect(enriched?.[2]).toMatchObject({ runId, task: 'custom-pre-row-smoke' });
  });

  it('(c) fires the run-outcome notification for the persisted-row case — a consumer keyed off run outcomes now has a row to find', async () => {
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Test', created_at: epochNow() });

    const projectId = 'proj_44444444444444444444444444444444';
    const groveId = 'grove_44444444444444444444444444444444';
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { handleRun } = makeHandlers(logger);
    const response = await handleRun(makeRequest({
      requestContext: makeTestRequestContext({ vaultDir: VAULT_DIR, projectId, groveId }),
      body: { task: 'custom-pre-row-notify-smoke', instruction: 'go' },
    }));
    const runId = (response.body as { runId?: string }).runId;

    await flushMicrotasks();

    const notificationRow = getDatabase().prepare(
      `SELECT project_id, type FROM notifications WHERE type = ?`,
    ).get('agent.task.failure') as { project_id: string; type: string } | undefined;
    expect(notificationRow).toEqual({ project_id: projectId, type: 'agent.task.failure' });

    const row = getRun(runId!, ALL_PROJECTS_SCOPE);
    expect(row?.status).toBe('failed');
  });

  it('(b) falls back to enriched log + notification when the failed-row insert itself also faults', async () => {
    const projectId = 'proj_55555555555555555555555555555555';
    const groveId = 'grove_55555555555555555555555555555555';
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { handleRun } = makeHandlers(logger);
    const response = await handleRun(makeRequest({
      requestContext: makeTestRequestContext({ vaultDir: VAULT_DIR, projectId, groveId }),
      body: { task: 'custom-pre-row-fallback-smoke', instruction: 'go' },
    }));
    const runId = (response.body as { runId?: string }).runId;
    expect(response.body).toMatchObject({ ok: true, message: 'Agent started' });

    await flushMicrotasks();

    const row = getRun(runId!, ALL_PROJECTS_SCOPE);
    expect(row).toBeNull();

    const errorCalls = logger.error.mock.calls as unknown as Array<[string, string, Record<string, unknown>]>;
    const fallback = errorCalls.find(([, message]) => message === 'Agent run threw unhandled error');
    expect(fallback).toBeDefined();
    expect(fallback?.[2]).toMatchObject({
      runId,
      task: 'custom-pre-row-fallback-smoke',
      project_id: projectId,
    });

    const notificationRow = getDatabase().prepare(
      `SELECT project_id, type FROM notifications WHERE type = ?`,
    ).get('agent.task.failure') as { project_id: string; type: string } | undefined;
    expect(notificationRow).toEqual({ project_id: projectId, type: 'agent.task.failure' });
  });
});
