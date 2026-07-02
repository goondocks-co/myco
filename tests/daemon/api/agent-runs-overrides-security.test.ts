/**
 * Security defenses for POST /api/agent/run executionOverrides.
 *
 * Two invariants under test:
 *   1. `executionOverrides.provider.apiKey` is rejected
 *      — the daemon never accepts secrets on the API surface.
 *   2. `executionOverrides.provider.baseUrl` is dropped for `openai` /
 *      `openrouter` remote providers, so the daemon's bearer key cannot
 *      be sent to an attacker-controlled host via an override.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertCandidate } from '@myco/db/queries/skill-candidates.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { getDatabase } from '@myco/db/client.js';
import { createAgentRunHandlers } from '@myco/daemon/api/agent-runs';
import type { RouteRequest } from '@myco/daemon/router';
import { makeTestRequestContext } from '../../helpers/request-context';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import { _clearNotifyDedupForTests } from '@myco/notifications/notify.js';

const epochNow = () => Math.floor(Date.now() / 1000);

// Seed a real vault dir so the (unmocked) loadMergedConfig has a myco.yaml
// to read. A top-level mock.module('@myco/config/loader.js', ...) returning a
// partial stub would poison every other test file in the same bun process
// (bundled runs share state across files) — see config-cortex-paths.test.ts
// and team-* tests that depend on a real four-tier merged config.
const VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-agent-runs-sec-'));
fs.writeFileSync(
  path.join(VAULT_DIR, 'myco.yaml'),
  'version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n',
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
    requestContext: makeTestRequestContext({ vaultDir: VAULT_DIR }),
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

describe('POST /api/agent/run — executionOverrides security', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    _clearNotifyDedupForTests();
    runAgentSpy.mockClear();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Test', created_at: epochNow() });
  });

  it('rejects provider.apiKey in executionOverrides', async () => {
    const { handleRun } = makeHandlers();
    const response = await handleRun(makeRequest({
      body: {
        task: 't', instruction: 'go', agentId: 'myco-agent',
        executionOverrides: {
          provider: { type: 'openai', apiKey: 'sk-attacker-captured' },
        },
      },
    }));

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('apiKey');
    expect(runAgentSpy).not.toHaveBeenCalled();
  });

  it('strips provider.baseUrl from executionOverrides when type=openai', async () => {
    const { handleRun } = makeHandlers();
    await handleRun(makeRequest({
      body: {
        task: 't', instruction: 'go', agentId: 'myco-agent',
        executionOverrides: {
          provider: { type: 'openai', baseUrl: 'https://attacker.example/v1' },
        },
      },
    }));

    expect(runAgentSpy).toHaveBeenCalledTimes(1);
    const [, opts] = runAgentSpy.mock.calls[0] as [string, { executionOverrides?: { provider?: { baseUrl?: string } } }];
    expect(opts.executionOverrides?.provider?.baseUrl).toBeUndefined();
  });

  it('strips provider.baseUrl from executionOverrides when type=openrouter', async () => {
    const { handleRun } = makeHandlers();
    await handleRun(makeRequest({
      body: {
        task: 't', instruction: 'go', agentId: 'myco-agent',
        executionOverrides: {
          provider: { type: 'openrouter', baseUrl: 'https://attacker.example/v1' },
        },
      },
    }));

    const [, opts] = runAgentSpy.mock.calls[0] as [string, { executionOverrides?: { provider?: { baseUrl?: string } } }];
    expect(opts.executionOverrides?.provider?.baseUrl).toBeUndefined();
  });

  it('resolves the embedding manager from the request context (per-request tenancy, not bootstrap)', async () => {
    // Anchor-leak guard (Variant A): the agent run's vector/canopy search tools
    // must get the run's grove manager, resolved from its request context.
    const groveManager = { tag: 'grove-mgr' } as never;
    let seenContext: unknown;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { handleRun } = createAgentRunHandlers({
      vaultDir: VAULT_DIR,
      resolveEmbeddingManager: (rc) => { seenContext = rc; return groveManager; },
      logger: logger as never,
    });
    await handleRun(makeRequest({ body: { task: 't', instruction: 'go', agentId: 'myco-agent' } }));
    expect((seenContext as { projectVaultDir?: string }).projectVaultDir).toBe(VAULT_DIR);
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
    const [, opts] = runAgentSpy.mock.calls[0] as [string, { embeddingManager?: unknown }];
    expect(opts.embeddingManager).toBe(groveManager);
  });

  it('dispatches manual runs against the request-scoped project vault dir', async () => {
    const projectVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-project-run-vault-'));
    fs.writeFileSync(
      path.join(projectVaultDir, 'myco.yaml'),
      'version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n',
      'utf-8',
    );
    try {
      const { handleRun } = makeHandlers();
      await handleRun(makeRequest({
        requestContext: makeTestRequestContext({ vaultDir: projectVaultDir }),
        body: { task: 'custom-smoke', instruction: 'go', agentId: 'myco-agent' },
      }));

      expect(runAgentSpy).toHaveBeenCalledTimes(1);
      const [dispatchedVaultDir] = runAgentSpy.mock.calls[0] as [string];
      expect(dispatchedVaultDir).toBe(projectVaultDir);
    } finally {
      fs.rmSync(projectVaultDir, { recursive: true, force: true });
    }
  });

  it('dispatches manual resume against the request-scoped project vault dir', async () => {
    const projectVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-project-resume-vault-'));
    const projectId = 'proj_11111111111111111111111111111111';
    fs.writeFileSync(
      path.join(projectVaultDir, 'myco.yaml'),
      'version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n',
      'utf-8',
    );
    insertRun({
      id: 'run-resume-request-vault',
      project_id: projectId,
      agent_id: DEFAULT_AGENT_ID,
      task: 'custom-resume-smoke',
      instruction: 'resume me',
      status: 'failed',
      resumable: 1,
      dryRun: true,
      started_at: epochNow(),
    });

    try {
      const { handleResumeRun } = makeHandlers();
      const response = await handleResumeRun(makeRequest({
        params: { id: 'run-resume-request-vault' },
        requestContext: makeTestRequestContext({
          vaultDir: projectVaultDir,
          projectId,
          groveId: 'grove_11111111111111111111111111111111',
        }),
        body: { mode: 'manual' },
      }));

      expect(response.body).toMatchObject({ ok: true, message: 'Agent resume started' });
      expect(runAgentSpy).toHaveBeenCalledTimes(1);
      const [dispatchedVaultDir, opts] = runAgentSpy.mock.calls[0] as [string, { resumeRunId?: string }];
      expect(dispatchedVaultDir).toBe(projectVaultDir);
      expect(opts.resumeRunId).toBe('run-resume-request-vault');
    } finally {
      fs.rmSync(projectVaultDir, { recursive: true, force: true });
    }
  });

  it('emits manual-run completion notifications against the request-scoped project vault dir', async () => {
    const projectVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-project-notify-vault-'));
    const projectId = 'proj_22222222222222222222222222222222';
    fs.writeFileSync(
      path.join(projectVaultDir, 'myco.yaml'),
      'version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nnotifications:\n  enabled: true\n',
      'utf-8',
    );

    try {
      const { handleRun } = makeHandlers();
      await handleRun(makeRequest({
        requestContext: makeTestRequestContext({
          vaultDir: projectVaultDir,
          projectId,
          groveId: 'grove_22222222222222222222222222222222',
        }),
        body: { task: 'custom-notify-smoke', instruction: 'go', agentId: DEFAULT_AGENT_ID },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const row = getDatabase().prepare(
        `SELECT project_id, type FROM notifications WHERE type = ?`,
      ).get('agent.task.success') as { project_id: string; type: string } | undefined;
      expect(row).toEqual({ project_id: projectId, type: 'agent.task.success' });
    } finally {
      fs.rmSync(projectVaultDir, { recursive: true, force: true });
    }
  });

  it('PRESERVES provider.baseUrl for type=openai-compatible (legitimate local path)', async () => {
    const { handleRun } = makeHandlers();
    await handleRun(makeRequest({
      body: {
        task: 't', instruction: 'go', agentId: 'myco-agent',
        executionOverrides: {
          provider: { type: 'openai-compatible', baseUrl: 'http://localhost:8080' },
        },
      },
    }));

    const [, opts] = runAgentSpy.mock.calls[0] as [string, { executionOverrides?: { provider?: { baseUrl?: string } } }];
    expect(opts.executionOverrides?.provider?.baseUrl).toBe('http://localhost:8080');
  });

  it('strips phase-level provider.baseUrl for openai/openrouter', async () => {
    const { handleRun } = makeHandlers();
    await handleRun(makeRequest({
      body: {
        task: 't', instruction: 'go', agentId: 'myco-agent',
        executionOverrides: {
          phases: {
            extract: { provider: { type: 'openai', baseUrl: 'https://attacker.example/v1' } },
            embed: { provider: { type: 'openai-compatible', baseUrl: 'http://localhost:8080' } },
          },
        },
      },
    }));

    const [, opts] = runAgentSpy.mock.calls[0] as [string, {
      executionOverrides?: { phases?: Record<string, { provider?: { baseUrl?: string } }> }
    }];
    expect(opts.executionOverrides?.phases?.extract?.provider?.baseUrl).toBeUndefined();
    expect(opts.executionOverrides?.phases?.embed?.provider?.baseUrl).toBe('http://localhost:8080');
  });

  it('uses the default agent id when building manual skill-survey admission', async () => {
    const now = epochNow();
    insertCandidate({
      id: 'queued-skill-survey-candidate',
      agent_id: DEFAULT_AGENT_ID,
      topic: 'Queued candidate',
      rationale: 'Needs reconciliation',
      created_at: now,
      updated_at: now,
    });

    const { handleRun } = makeHandlers();
    const response = await handleRun(makeRequest({
      body: {
        task: 'skill-survey',
        force: true,
      },
    }));

    expect(response.body).toMatchObject({ ok: true, message: 'Agent started' });
    expect(JSON.stringify(response.body)).not.toContain('skipped');
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
    const [, opts] = runAgentSpy.mock.calls[0] as [string, { agentId?: string; instruction?: string }];
    expect(opts.agentId).toBe(DEFAULT_AGENT_ID);
    expect(opts.instruction).toContain('ignore_watermark: true');
  });

  it('responds with the same runId it hands to the executor', async () => {
    // The handler pre-generates the run id and threads it through
    // RunOptions — reading the latest row back after dispatch raced the
    // executor's insert (it happens after awaits, e.g. Ollama variant
    // resolution) and returned a stale run's id to the UI.
    const { handleRun } = makeHandlers();
    const response = await handleRun(makeRequest({
      body: { task: 'title-summary', instruction: 'do the thing' },
    }));

    expect(response.body).toMatchObject({ ok: true, message: 'Agent started' });
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
    const [, opts] = runAgentSpy.mock.calls[0] as [string, { runId?: string }];
    expect(typeof opts.runId).toBe('string');
    expect((response.body as { runId?: string }).runId).toBe(opts.runId);
  });
});
