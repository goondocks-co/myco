import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { MycoConfigSchema } from '@myco/config/schema';
import type { MycoConfig } from '@myco/config/schema';

const {
  runAgent,
  buildCortexInstructionsInput,
  getLatestRunId,
} = vi.hoisted(() => ({
  runAgent: vi.fn(),
  buildCortexInstructionsInput: vi.fn(),
  getLatestRunId: vi.fn(),
}));

vi.mock('@myco/agent/executor.js', () => ({ runAgent }));
vi.mock('@myco/context/cortex-brief.js', async () => {
  const actual = await vi.importActual<typeof import('@myco/context/cortex-brief.js')>(
    '@myco/context/cortex-brief.js',
  );
  return { ...actual, buildCortexInstructionsInput };
});
vi.mock('@myco/db/queries/runs.js', () => ({ getLatestRunId }));

import { triggerCortexInstructions } from '@myco/daemon/cortex';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeEmbeddingManagerStub(): unknown {
  return { remove: vi.fn(), reconcile: vi.fn() };
}

function makeConfig(overrides: Partial<MycoConfig['agent']> = {}): MycoConfig {
  return MycoConfigSchema.parse({
    version: 3,
    agent: {
      event_tasks_enabled: true,
      tasks: {
        'cortex-instructions': {
          provider: { type: 'anthropic' },
        },
      },
      ...overrides,
    },
  });
}

describe('triggerCortexInstructions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildCortexInstructionsInput.mockResolvedValue({
      inputHash: 'hash-1',
      instruction: 'Cortex instruction payload',
    });
    runAgent.mockResolvedValue({ status: 'completed', runId: 'run-cortex-1' });
    getLatestRunId.mockReturnValue('run-cortex-1');
  });

  it('returns without starting when event-driven tasks are disabled', async () => {
    const result = await triggerCortexInstructions({
      vaultDir: '/tmp/ignored',
      embeddingManager: makeEmbeddingManagerStub() as never,
      liveConfig: { current: makeConfig({ event_tasks_enabled: false }) },
      logger: makeLogger() as never,
    });

    expect(result).toEqual({
      started: false,
      reason: 'event-tasks-disabled',
    });
    expect(buildCortexInstructionsInput).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('returns without starting when no provider is configured', async () => {
    const result = await triggerCortexInstructions({
      vaultDir: '/tmp/ignored',
      embeddingManager: makeEmbeddingManagerStub() as never,
      liveConfig: { current: makeConfig({ tasks: {} }) },
      logger: makeLogger() as never,
    });

    expect(result).toEqual({
      started: false,
      reason: 'provider-not-configured',
    });
    expect(buildCortexInstructionsInput).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('starts a fire-and-forget Cortex run with the built instruction payload', async () => {
    const logger = makeLogger();
    const getTeamClient = vi.fn(() => null);

    const result = await triggerCortexInstructions({
      vaultDir: '/tmp/myco',
      embeddingManager: makeEmbeddingManagerStub() as never,
      liveConfig: { current: makeConfig() },
      logger: logger as never,
      getTeamClient,
    });

    expect(result).toEqual({
      started: true,
      runId: 'run-cortex-1',
    });
    expect(buildCortexInstructionsInput).toHaveBeenCalledWith(makeConfig(), getTeamClient);
    expect(runAgent).toHaveBeenCalledWith('/tmp/myco', {
      task: 'cortex-instructions',
      agentId: 'myco-agent',
      instruction: 'Cortex instruction payload',
      runContext: { cortex_instruction_input_hash: 'hash-1' },
      embeddingManager: expect.anything(),
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns startup-failed with a log when buildCortexInstructionsInput throws', async () => {
    const logger = makeLogger();
    buildCortexInstructionsInput.mockRejectedValueOnce(new Error('DB unavailable'));

    const result = await triggerCortexInstructions({
      vaultDir: '/tmp/myco',
      embeddingManager: makeEmbeddingManagerStub() as never,
      liveConfig: { current: makeConfig() },
      logger: logger as never,
    });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('startup-failed');
    expect(result.error).toContain('DB unavailable');
    expect(logger.warn).toHaveBeenCalledWith(
      'agent.error',
      'Failed to start cortex-instructions task',
      expect.objectContaining({ error: expect.stringContaining('DB unavailable') }),
    );
  });

  it('returns agent-module-unavailable when loadExecutor throws (module-not-found path)', async () => {
    const logger = makeLogger();
    const loadExecutor = vi.fn(async () => {
      throw new Error("Cannot find module '../agent/executor.js'");
    });

    const result = await triggerCortexInstructions({
      vaultDir: '/tmp/myco',
      embeddingManager: makeEmbeddingManagerStub() as never,
      liveConfig: { current: makeConfig() },
      logger: logger as never,
      loadExecutor: loadExecutor as never,
    });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('agent-module-unavailable');
    expect(result.error).toContain('Cannot find module');
    expect(loadExecutor).toHaveBeenCalledTimes(1);
    expect(buildCortexInstructionsInput).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'agent.error',
      'cortex-instructions: agent module unavailable',
      expect.objectContaining({ error: expect.stringContaining('Cannot find module') }),
    );
  });

  it('uses the default loadExecutor (real dynamic import) when the seam is not injected', async () => {
    // Happy path already mocks @myco/agent/executor.js at the vi.mock level;
    // this assertion confirms the default code path is still exercised when
    // no loadExecutor override is passed (sanity check that the seam is
    // opt-in and backward-compatible).
    const logger = makeLogger();

    const result = await triggerCortexInstructions({
      vaultDir: '/tmp/myco',
      embeddingManager: makeEmbeddingManagerStub() as never,
      liveConfig: { current: makeConfig() },
      logger: logger as never,
    });

    expect(result.started).toBe(true);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('registers the fire-and-forget promise with registerInflightRun when provided', async () => {
    const logger = makeLogger();
    const registerInflightRun = vi.fn();

    const result = await triggerCortexInstructions({
      vaultDir: '/tmp/myco',
      embeddingManager: makeEmbeddingManagerStub() as never,
      liveConfig: { current: makeConfig() },
      logger: logger as never,
      registerInflightRun,
    });

    expect(result.started).toBe(true);
    expect(registerInflightRun).toHaveBeenCalledTimes(1);
    expect(registerInflightRun.mock.calls[0][0]).toBeInstanceOf(Promise);
  });
});
