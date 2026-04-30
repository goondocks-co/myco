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
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { createAgentRunHandlers } from '@myco/daemon/api/agent-runs';
import type { RouteRequest } from '@myco/daemon/router';

const epochNow = () => Math.floor(Date.now() / 1000);

const runAgentSpy = vi.fn(async () => ({ runId: 'stub', status: 'completed' as const }));
mock.module('@myco/agent/executor.js', () => ({
  runAgent: (...args: unknown[]) => runAgentSpy(...args),
}));
mock.module('@myco/config/loader.js', () => ({
  loadMergedConfig: () => ({ agent: { tasks: {} } }),
}));
mock.module('@myco/agent/config-resolver.js', () => ({
  hasConfiguredProvider: () => true,
}));

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { params: {}, query: {}, body: undefined, pathname: '/', ...overrides } as RouteRequest;
}

function makeHandlers() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return createAgentRunHandlers({
    vaultDir: '/tmp/fake-vault',
    embeddingManager: {} as never,
    logger: logger as never,
  });
}

describe('POST /api/agent/run — executionOverrides security', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    runAgentSpy.mockClear();
    registerAgent({ id: 'myco-agent', name: 'Test', created_at: epochNow() });
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
});
