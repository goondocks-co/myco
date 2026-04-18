import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteRequest } from '@myco/daemon/router';
import { MycoConfigSchema } from '@myco/config/schema';

const {
  getCortexInstructionsSnapshot,
  buildCortexPrompt,
  getCortexPromptResult,
  triggerCortexInstructions,
} = vi.hoisted(() => ({
  getCortexInstructionsSnapshot: vi.fn(),
  buildCortexPrompt: vi.fn(),
  getCortexPromptResult: vi.fn(),
  triggerCortexInstructions: vi.fn(),
}));

vi.mock('@myco/services/cortex.js', () => ({
  getCortexInstructionsSnapshot,
  buildCortexPrompt,
  getCortexPromptResult,
}));
vi.mock('@myco/daemon/trigger-cortex-instructions.js', () => ({
  triggerCortexInstructions,
}));

import { createCortexHandlers } from '@myco/daemon/api/cortex';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    pathname: '/api/cortex',
    ...overrides,
  } as RouteRequest;
}

describe('createCortexHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeHandlers() {
    return createCortexHandlers('/tmp/myco', {
      liveConfig: { current: MycoConfigSchema.parse({ version: 3 }) },
      embeddingManager: { reconcile: vi.fn() } as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      getTeamClient: vi.fn(() => null),
    });
  }

  it('returns the stored Cortex snapshot without triggering a task run', async () => {
    getCortexInstructionsSnapshot.mockResolvedValue({
      content: 'Stored instructions',
      generatedAt: 123,
      sourceRunId: 'run-1',
      enabled: true,
      stored: true,
    });
    const handlers = makeHandlers();

    const response = await handlers.handleGetInstructions();

    expect(response.body).toEqual({
      content: 'Stored instructions',
      generatedAt: 123,
      sourceRunId: 'run-1',
      enabled: true,
      stored: true,
    });
    expect(getCortexInstructionsSnapshot).toHaveBeenCalledTimes(1);
    expect(triggerCortexInstructions).not.toHaveBeenCalled();
  });

  it('uses the event-driven trigger for manual refresh', async () => {
    triggerCortexInstructions.mockResolvedValue({
      started: true,
      runId: 'run-cortex-refresh',
    });
    const handlers = makeHandlers();

    const response = await handlers.handleRefreshInstructions();

    expect(response.body).toEqual({
      started: true,
      runId: 'run-cortex-refresh',
    });
    expect(triggerCortexInstructions).toHaveBeenCalledTimes(1);
    expect(getCortexInstructionsSnapshot).not.toHaveBeenCalled();
  });

  it('passes builder requests through to the prompt builder service', async () => {
    buildCortexPrompt.mockResolvedValue({
      started: true,
      runId: 'run-builder-1',
      inlineInstructions: false,
      targetSymbiont: null,
    });
    const handlers = makeHandlers();

    const response = await handlers.handleBuildPrompt(
      makeRequest({
        body: {
          goal: 'Build Cortex',
          symbiont: 'codex',
        },
      }),
    );

    expect(response.body).toEqual({
      started: true,
      runId: 'run-builder-1',
      inlineInstructions: false,
      targetSymbiont: null,
    });
    expect(buildCortexPrompt).toHaveBeenCalledTimes(1);
  });

  it('returns prompt-builder run status from the Cortex service', async () => {
    getCortexPromptResult.mockReturnValue({
      runId: 'run-builder-1',
      status: 'completed',
      prompt: 'Prompt output',
      reports: [],
      error: null,
    });
    const handlers = makeHandlers();

    const response = await handlers.handleGetPromptResult(
      makeRequest({ params: { runId: 'run-builder-1' } }),
    );

    expect(response.body).toEqual({
      runId: 'run-builder-1',
      status: 'completed',
      prompt: 'Prompt output',
      reports: [],
      error: null,
    });
  });
});
