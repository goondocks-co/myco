import * as __orig__myco_agent_loader_js_1__ns from '@myco/agent/loader.js';
const __orig__myco_agent_loader_js_1 = { ...__orig__myco_agent_loader_js_1__ns };
import * as __orig__myco_db_queries_turns_js_2__ns from '@myco/db/queries/turns.js';
const __orig__myco_db_queries_turns_js_2 = { ...__orig__myco_db_queries_turns_js_2__ns };
import * as __orig__myco_db_queries_reports_js_3__ns from '@myco/db/queries/reports.js';
const __orig__myco_db_queries_reports_js_3 = { ...__orig__myco_db_queries_reports_js_3__ns };
import * as __orig__myco_db_client_js_4__ns from '@myco/db/client.js';
const __orig__myco_db_client_js_4 = { ...__orig__myco_db_client_js_4__ns };
/**
 * Tests for the agent executor.
 *
 * The Agent SDK's `query()` function is mocked via mock.module() so tests
 * never call the Anthropic API. Each test uses an in-memory PGlite
 * instance with the full schema.
 */

import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertTask } from '@myco/db/queries/tasks.js';
import { insertRun, getRun } from '@myco/db/queries/runs.js';
import { epochSeconds } from '@myco/constants.js';
import { composeTaskPrompt, composePhasePrompt, resolvePhaseExecution } from '@myco/agent/executor.js';
import type { PhaseDefinition, ExecutionConfig, OrchestratorConfig, EffectiveConfig, RunOptions, ProviderConfig } from '@myco/agent/types.js';
import type { ReportRow } from '@myco/db/queries/reports.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'myco-agent';
const TEST_VAULT_DIR = '/tmp/test-vault';
const TEST_TASK_NAME = 'vault-evolve';
const TEST_TASK_PROMPT = 'Run full intelligence pipeline.';
const TEST_SYSTEM_PROMPT = 'You are a vault agent.';


// ---------------------------------------------------------------------------
// Mock: Agent SDK query
// ---------------------------------------------------------------------------

/** Captured arguments from ALL query() calls (supports phased execution). */
let allQueryCalls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];

/** Captured arguments from the last query() call (backward compat). */
let capturedQueryArgs: { prompt: string; options?: Record<string, unknown> } | null = null;

/**
 * Per-call behaviors. Each query() call shifts the next behavior.
 * Falls back to mockQueryBehavior when exhausted.
 */
let mockQueryBehaviors: Array<'success' | 'error' | 'empty' | 'abort'> = [];

/** Default behavior when mockQueryBehaviors is empty. */
let mockQueryBehavior: 'success' | 'error' | 'empty' | 'abort' = 'success';

/** Custom error message for the 'error' behavior. */
let mockErrorMessage = 'SDK exploded';

/** Per-call result text. Shifts the next value per query() call. */
let mockResultTexts: string[] = [];

/** Default result text for successful queries. */
const DEFAULT_RESULT_TEXT = 'Agent run complete.';

/**
 * Number of `assistant` type messages yielded before the final `result`
 * message. Controls turn metric behavior: the executor counts these instead
 * of using num_turns from the SDK result.
 */
let mockAssistantCount = 0;
let mockToolCallCounts: Record<string, number> = {};
let mockRunReports: ReportRow[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (args: { prompt: string; options?: Record<string, unknown> }) => {
      capturedQueryArgs = args;
      allQueryCalls.push(args);

      const behavior = mockQueryBehaviors.length > 0
        ? mockQueryBehaviors.shift()!
        : mockQueryBehavior;

      const resultText = mockResultTexts.length > 0
        ? mockResultTexts.shift()!
        : DEFAULT_RESULT_TEXT;

      return {
        [Symbol.asyncIterator]: async function* () {
          if (behavior === 'error') {
            throw new Error(mockErrorMessage);
          }

          if (behavior === 'abort') {
            const controller = args.options?.abortController;
            if (controller instanceof AbortController) {
              controller.abort(new Error('Agent run timed out after 1 seconds'));
            }
            throw new Error('Claude Code process aborted by user');
          }

          if (behavior === 'success') {
            for (let i = 0; i < mockAssistantCount; i++) {
              yield {
                type: 'assistant' as const,
                message: { role: 'assistant' as const, content: 'test response' },
                uuid: `assistant-${i}`,
                session_id: 'test-session',
              };
            }
            yield {
              type: 'result' as const,
              subtype: 'success' as const,
              total_cost_usd: 0.0042,
              usage: {
                input_tokens: 1500,
                output_tokens: 350,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
              num_turns: 3,
              duration_ms: 5000,
              duration_api_ms: 4500,
              is_error: false,
              result: resultText,
              stop_reason: 'end_turn',
              modelUsage: {},
              permission_denials: [],
              uuid: '00000000-0000-0000-0000-000000000000',
              session_id: 'test-session',
            };
          }
          // 'empty': yields nothing
        },
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        applyFlagSettings: async () => {},
        initializationResult: async () => ({}),
        supportedCommands: async () => [],
        supportedModels: async () => [],
        supportedAgents: async () => [],
        mcpServerStatus: async () => [],
        accountInfo: async () => ({}),
        rewindFiles: async () => ({ canRewind: false }),
        reconnectMcpServer: async () => {},
        toggleMcpServer: async () => {},
        setMcpServers: async () => ({}),
        streamInput: async () => {},
        stopTask: async () => {},
        close: () => {},
        next: async () => ({ done: true, value: undefined }),
        return: async () => ({ done: true, value: undefined }),
        throw: async () => ({ done: true, value: undefined }),
      };
    },
    createSdkMcpServer: (opts: Record<string, unknown>) => ({
      type: 'sdk' as const,
      instance: {},
      ...opts,
    }),
    tool: (_name: string, _desc: string, _schema: unknown, handler: unknown) => ({
      name: _name,
      handler,
    }),
  };
});

// ---------------------------------------------------------------------------
// Mock: loader (avoid filesystem reads for definitions)
// ---------------------------------------------------------------------------

/** YAML phases to return from the loader mock. Set per-test. */
let mockYamlPhases: PhaseDefinition[] | undefined;

/** Execution config to return from the registry mock. Set per-test. */
let mockExecution: ExecutionConfig | undefined;

/** Orchestrator config to return from the registry mock. Set per-test. */
let mockOrchestratorConfig: OrchestratorConfig | undefined;

/** Top-level task reasoning level from the registry mock. Set per-test. */
let mockTaskReasoningLevel: 'low' | 'default' | 'high' | undefined;

mock.module('@myco/agent/loader.js', () => {
  const original = __orig__myco_agent_loader_js_1;
  return {
    ...original,
    resolveDefinitionsDir: () => '/mock/definitions',
    loadAgentDefinition: () => ({
      name: 'myco-agent',
      displayName: 'Myco Agent',
      description: 'Built-in agent',
      model: 'claude-sonnet-4-20250514',
      maxTurns: 10,
      timeoutSeconds: 300,
      systemPromptPath: 'prompts/system.md',
      tools: ['vault_unprocessed', 'vault_create_spore'],
    }),
    loadAgentTasks: () => {
      // Return a task with phases if mockYamlPhases is set
      if (mockYamlPhases) {
        return [{
          name: TEST_TASK_NAME,
          displayName: 'Vault Evolve',
          description: 'Run full intelligence pipeline',
          agent: 'myco-agent',
          prompt: 'Phased pipeline overview.',
          isDefault: true,
          phases: mockYamlPhases,
        }];
      }
      return [{
        name: TEST_TASK_NAME,
        displayName: 'Vault Evolve',
        description: 'Run full intelligence pipeline',
        agent: 'myco-agent',
        prompt: TEST_TASK_PROMPT,
        isDefault: true,
      }];
    },
    loadSystemPrompt: () => TEST_SYSTEM_PROMPT,
    // Keep resolveEffectiveConfig from the original module
  };
});

// ---------------------------------------------------------------------------
// Mock: registry (wraps loadAgentTasks — avoids filesystem reads)
// ---------------------------------------------------------------------------

mock.module('@myco/agent/registry.js', () => ({
  loadAllTasks: (_definitionsDir: string, _vaultDir?: string) => {
    const tasks = new Map();
      const task = {
        name: TEST_TASK_NAME,
        displayName: 'Vault Evolve',
        description: 'Run full intelligence pipeline',
        agent: 'myco-agent',
        prompt: mockYamlPhases ? 'Phased pipeline overview.' : TEST_TASK_PROMPT,
        isDefault: true,
        ...(mockTaskReasoningLevel ? { reasoningLevel: mockTaskReasoningLevel } : {}),
        ...(mockYamlPhases ? { phases: mockYamlPhases } : {}),
        ...(mockExecution ? { execution: mockExecution } : {}),
        ...(mockOrchestratorConfig ? { orchestrator: mockOrchestratorConfig } : {}),
    };
    tasks.set(TEST_TASK_NAME, task);
    return tasks;
  },
}));

// ---------------------------------------------------------------------------
// Mock: context
// ---------------------------------------------------------------------------

mock.module('@myco/agent/context.js', () => ({
  buildVaultContext: () => '## Current Vault State\nagent_id: myco-agent\nunprocessed_batches: 5',
}));

// ---------------------------------------------------------------------------
// Mock: tools (track scoped tool server calls)
// ---------------------------------------------------------------------------

/** Captured calls to createScopedVaultToolServer. */
let scopedToolCalls: Array<{ agentId: string; runId: string; toolNames: string[]; options?: Record<string, unknown> }> = [];

mock.module('@myco/agent/tools.js', () => ({
  createVaultToolServer: (_agentId: string, _runId: string) => ({
    type: 'sdk' as const,
    name: 'myco-vault',
    instance: {},
  }),
  createMaterializedVaultToolServer: (_tools: unknown[]) => ({
    type: 'sdk' as const,
    name: 'myco-vault',
    instance: {},
  }),
  createScopedVaultToolServer: (agentId: string, runId: string, toolNames: string[], options?: Record<string, unknown>) => {
    scopedToolCalls.push({ agentId, runId, toolNames, options });
    return {
      type: 'sdk' as const,
      name: 'myco-vault',
      instance: {},
    };
  },
}));

mock.module('@myco/db/queries/turns.js', () => {
  const original = __orig__myco_db_queries_turns_js_2;
  return {
    ...original,
    countToolCallsByRun: () => mockToolCallCounts,
  };
});

mock.module('@myco/db/queries/reports.js', () => {
  const original = __orig__myco_db_queries_reports_js_3;
  return {
    ...original,
    listReports: () => mockRunReports,
  };
});

// ---------------------------------------------------------------------------
// Mock: initDatabaseForVault (we manage DB ourselves in tests)
// ---------------------------------------------------------------------------

mock.module('@myco/db/client.js', () => {
  const original = __orig__myco_db_client_js_4;
  return {
    ...original,
    initDatabaseForVault: async () => original.getDatabase(),
  };
});

// ---------------------------------------------------------------------------
// Mock: config loader (avoid filesystem reads for myco.yaml)
// ---------------------------------------------------------------------------

let mockMergedConfig: any = {
  version: 3,
  config_version: 0,
  embedding: { provider: 'ollama', model: 'bge-m3' },
  daemon: { port: null, log_level: 'info' },
  capture: { transcript_paths: [], artifact_watch: [], artifact_extensions: [], buffer_max_events: 500 },
  agent: { summary_batch_interval: 5 },
};

mock.module('@myco/config/loader.js', () => ({
  loadConfig: () => mockMergedConfig,
  loadMergedConfig: () => mockMergedConfig,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestAgent(id: string): Promise<void> {
  const now = epochSeconds();
  registerAgent({
    id,
    name: `agent-${id}`,
    created_at: now,
    updated_at: now,
  });
}

async function createTestTask(): Promise<void> {
  const now = epochSeconds();
  upsertTask({
    id: TEST_TASK_NAME,
    agent_id: TEST_AGENT_ID,
    prompt: TEST_TASK_PROMPT,
    display_name: 'Vault Evolve',
    description: 'Run full intelligence pipeline',
    is_default: 1,
    created_at: now,
    updated_at: now,
  });
}

async function createTask(taskId: string, prompt = TEST_TASK_PROMPT): Promise<void> {
  const now = epochSeconds();
  upsertTask({
    id: taskId,
    agent_id: TEST_AGENT_ID,
    prompt,
    display_name: taskId,
    description: `Run ${taskId}`,
    is_default: 0,
    created_at: now,
    updated_at: now,
  });
}

/** Resets all mock state between tests. */
function resetMockState(): void {
  capturedQueryArgs = null;
  allQueryCalls = [];
  scopedToolCalls = [];
  mockQueryBehavior = 'success';
  mockQueryBehaviors = [];
  mockResultTexts = [];
  mockErrorMessage = 'SDK exploded';
  mockYamlPhases = undefined;
  mockExecution = undefined;
  mockOrchestratorConfig = undefined;
  mockTaskReasoningLevel = undefined;
  mockAssistantCount = 0;
  mockToolCallCounts = {};
  mockRunReports = [];
  mockMergedConfig = {
    version: 3,
    config_version: 0,
    embedding: { provider: 'ollama', model: 'bge-m3' },
    daemon: { port: null, log_level: 'info' },
    capture: { transcript_paths: [], artifact_watch: [], artifact_extensions: [], buffer_max_events: 500 },
    agent: { summary_batch_interval: 5 },
  };
}

// ---------------------------------------------------------------------------
// Tests: composeTaskPrompt
// ---------------------------------------------------------------------------

describe('composeTaskPrompt', () => {
  it('composes vault context + task without instruction', () => {
    const result = composeTaskPrompt({
      vaultContext: '## Vault State\nspores: 10',
      taskDisplayName: 'Vault Evolve',
      taskPrompt: 'Run full intelligence.',
    });

    expect(result).toContain('## Vault State');
    expect(result).toContain('spores: 10');
    expect(result).toContain('## Task: Vault Evolve');
    expect(result).toContain('Run full intelligence.');
    expect(result).not.toContain('## User Instruction');
  });

  it('appends user instruction when provided', () => {
    const result = composeTaskPrompt({
      vaultContext: '## Vault State',
      taskDisplayName: 'Vault Evolve',
      taskPrompt: 'Run full intelligence.',
      instruction: 'Focus on gotchas only.',
    });

    expect(result).toContain('## User Instruction');
    expect(result).toContain('Focus on gotchas only.');
  });
});

// ---------------------------------------------------------------------------
// Tests: composePhasePrompt
// ---------------------------------------------------------------------------

describe('composePhasePrompt', () => {
  const vaultContext = '## Vault State\nspores: 10';
  const taskName = 'Vault Evolve';
  const taskOverview = 'Complete intelligence pipeline.';

  it('composes vault context + task overview + phase prompt', () => {
    const result = composePhasePrompt({
      vaultContext,
      taskDisplayName: taskName,
      taskOverview,
      phase: { name: 'extract', prompt: 'Extract spores from batches.', tools: [], maxTurns: 5, required: true },
      priorPhaseResults: [],
    });

    expect(result).toContain('## Vault State');
    expect(result).toContain('## Task: Vault Evolve');
    expect(result).toContain('Complete intelligence pipeline.');
    expect(result).toContain('## Current Phase: extract');
    expect(result).toContain('Extract spores from batches.');
    expect(result).not.toContain('## Prior Phase Results');
  });

  it('includes prior phase results when available', () => {
    const result = composePhasePrompt({
      vaultContext,
      taskDisplayName: taskName,
      taskOverview,
      phase: { name: 'consolidate', prompt: 'Consolidate spores.', tools: [], maxTurns: 5, required: true },
      priorPhaseResults: [
        { name: 'extract', status: 'completed', turnsUsed: 3, tokensUsed: 500, costUsd: 0.001, summary: 'Created 5 spores.' },
        { name: 'summarize', status: 'completed', turnsUsed: 2, tokensUsed: 300, costUsd: 0.0005, summary: 'Updated 2 sessions.' },
      ],
    });

    expect(result).toContain('## Prior Phase Results');
    expect(result).toContain('### extract (completed)');
    expect(result).toContain('Created 5 spores.');
    expect(result).toContain('### summarize (completed)');
    expect(result).toContain('Updated 2 sessions.');
  });

  it('truncates long phase summaries', () => {
    const longSummary = 'A'.repeat(5000);
    const result = composePhasePrompt({
      vaultContext,
      taskDisplayName: taskName,
      taskOverview,
      phase: { name: 'graph', prompt: 'Build graph.', tools: [], maxTurns: 5, required: true },
      priorPhaseResults: [{ name: 'extract', status: 'completed', turnsUsed: 3, tokensUsed: 500, costUsd: 0.001, summary: longSummary }],
    });

    expect(result).toContain('...');
    expect(result.indexOf(longSummary)).toBe(-1);
  });

  it('includes user instruction when provided', () => {
    const result = composePhasePrompt({
      vaultContext,
      taskDisplayName: taskName,
      taskOverview,
      phase: { name: 'extract', prompt: 'Extract spores.', tools: [], maxTurns: 5, required: true },
      priorPhaseResults: [],
      instruction: 'Focus on security issues.',
    });

    expect(result).toContain('## User Instruction');
    expect(result).toContain('Focus on security issues.');
  });
});

// ---------------------------------------------------------------------------
// Tests: resolvePhaseExecution (pure precedence helper)
// ---------------------------------------------------------------------------

describe('resolvePhaseExecution', () => {
  const baseProvider: ProviderConfig = {
    type: 'anthropic',
    reasoningMap: {
      low: 'model-low',
      default: 'model-default',
      high: 'model-high',
    },
  };

  const baseConfig: EffectiveConfig = {
    agentId: 'myco-agent',
    runtime: 'claude-sdk',
    model: 'model-task-default',
    reasoningLevel: 'default',
    maxTurns: 10,
    timeoutSeconds: 300,
    systemPromptPath: 'prompts/system.md',
    tools: [],
    taskName: 'vault-evolve',
    taskDisplayName: 'Vault Evolve',
    taskPrompt: 'overview',
  };

  function phase(partial: Partial<PhaseDefinition> = {}): PhaseDefinition {
    return {
      name: 'phaseA',
      prompt: 'do.',
      tools: [],
      maxTurns: 5,
      required: true,
      ...partial,
    };
  }

  it('falls back to task config when nothing is set', () => {
    const result = resolvePhaseExecution(phase(), undefined, baseConfig, baseProvider);
    // config.reasoningLevel=default → maps to model-default via provider
    expect(result.reasoningLevel).toBe('default');
    expect(result.model).toBe('model-default');
  });

  it('top-level executionOverrides beats task default', () => {
    const opts: RunOptions = { executionOverrides: { reasoningLevel: 'low' } };
    const result = resolvePhaseExecution(phase(), opts, baseConfig, baseProvider);
    expect(result.reasoningLevel).toBe('low');
    expect(result.model).toBe('model-low');
  });

  it('phase YAML beats top-level executionOverrides', () => {
    const opts: RunOptions = { executionOverrides: { reasoningLevel: 'low' } };
    const result = resolvePhaseExecution(
      phase({ reasoningLevel: 'high' }),
      opts,
      baseConfig,
      baseProvider,
    );
    expect(result.reasoningLevel).toBe('high');
    expect(result.model).toBe('model-high');
  });

  it('per-phase executionOverrides beats phase YAML', () => {
    const opts: RunOptions = {
      executionOverrides: {
        reasoningLevel: 'low',
        phases: { phaseA: { reasoningLevel: 'high' } },
      },
    };
    const result = resolvePhaseExecution(
      phase({ reasoningLevel: 'default' }),
      opts,
      baseConfig,
      baseProvider,
    );
    expect(result.reasoningLevel).toBe('high');
    expect(result.model).toBe('model-high');
  });

  it('per-phase model override takes precedence over reasoning mapping', () => {
    const opts: RunOptions = {
      executionOverrides: {
        phases: { phaseA: { model: 'custom-phase-model' } },
      },
    };
    const result = resolvePhaseExecution(phase(), opts, baseConfig, baseProvider);
    expect(result.model).toBe('custom-phase-model');
  });

  it('different phases receive independent overrides', () => {
    const opts: RunOptions = {
      executionOverrides: {
        phases: {
          phaseA: { reasoningLevel: 'low' },
          phaseB: { reasoningLevel: 'high' },
        },
      },
    };
    const a = resolvePhaseExecution(phase({ name: 'phaseA' }), opts, baseConfig, baseProvider);
    const b = resolvePhaseExecution(phase({ name: 'phaseB' }), opts, baseConfig, baseProvider);
    expect(a.model).toBe('model-low');
    expect(b.model).toBe('model-high');
  });

  it('uses phase.model as fallback when no override and no provider match', () => {
    const result = resolvePhaseExecution(
      phase({ model: 'phase-yaml-model' }),
      undefined,
      baseConfig,
      undefined, // no provider → no reasoningMap
    );
    expect(result.model).toBe('phase-yaml-model');
  });

  // -------------------------------------------------------------------------
  // Provider precedence (added in Task F: richer overrides)
  // -------------------------------------------------------------------------

  it('per-phase provider override wins over top-level override, phase YAML, and task default', () => {
    const taskProvider: ProviderConfig = { type: 'anthropic', model: 'task-default-model' };
    const topOverrideProvider: ProviderConfig = { type: 'lmstudio', model: 'lmstudio-model' };
    const phaseYamlProvider: ProviderConfig = { type: 'ollama', model: 'ollama-model' };
    const phaseOverrideProvider: ProviderConfig = { type: 'openai', model: 'openai-model' };

    const opts: RunOptions = {
      executionOverrides: {
        provider: topOverrideProvider,
        phases: {
          phaseA: { provider: phaseOverrideProvider },
        },
      },
    };
    const result = resolvePhaseExecution(
      phase({ provider: phaseYamlProvider }),
      opts,
      baseConfig,
      taskProvider,
    );
    expect(result.provider).toEqual(phaseOverrideProvider);
  });

  it('phase YAML provider wins over top-level provider override', () => {
    const phaseYamlProvider: ProviderConfig = { type: 'ollama', model: 'ollama-model' };
    const topOverrideProvider: ProviderConfig = { type: 'lmstudio', model: 'lmstudio-model' };
    const opts: RunOptions = {
      executionOverrides: { provider: topOverrideProvider },
    };
    const result = resolvePhaseExecution(
      phase({ provider: phaseYamlProvider }),
      opts,
      baseConfig,
      { type: 'anthropic' },
    );
    expect(result.provider).toEqual(phaseYamlProvider);
  });

  it('top-level provider override wins over task default when no phase-level provider set', () => {
    const topOverrideProvider: ProviderConfig = { type: 'lmstudio', model: 'lmstudio-model' };
    const opts: RunOptions = {
      executionOverrides: { provider: topOverrideProvider },
    };
    const result = resolvePhaseExecution(
      phase(),
      opts,
      baseConfig,
      { type: 'anthropic' },
    );
    expect(result.provider).toEqual(topOverrideProvider);
  });

  // -------------------------------------------------------------------------
  // maxTurns precedence
  // -------------------------------------------------------------------------

  it('returns the phase YAML maxTurns when no override is provided', () => {
    const result = resolvePhaseExecution(
      phase({ maxTurns: 8 }),
      undefined,
      baseConfig,
      baseProvider,
    );
    expect(result.maxTurns).toBe(8);
  });

  it('per-phase executionOverrides.maxTurns beats phase YAML', () => {
    const opts: RunOptions = {
      executionOverrides: {
        phases: { phaseA: { maxTurns: 25 } },
      },
    };
    const result = resolvePhaseExecution(
      phase({ maxTurns: 8 }),
      opts,
      baseConfig,
      baseProvider,
    );
    expect(result.maxTurns).toBe(25);
  });

  // -------------------------------------------------------------------------
  // myco.yaml per-phase overrides (new precedence layer)
  // -------------------------------------------------------------------------

  it('myco.yaml per-phase provider override beats top-level run override', () => {
    const mycoYamlProvider: ProviderConfig = { type: 'ollama', model: 'ollama-model' };
    const topRunProvider: ProviderConfig = { type: 'lmstudio', model: 'lmstudio-model' };
    const opts: RunOptions = { executionOverrides: { provider: topRunProvider } };
    const result = resolvePhaseExecution(
      phase(),
      opts,
      baseConfig,
      { type: 'anthropic' },
      { phaseA: { provider: mycoYamlProvider } },
    );
    expect(result.provider).toEqual(mycoYamlProvider);
  });

  it('phase YAML provider still wins over myco.yaml per-phase override', () => {
    const phaseYamlProvider: ProviderConfig = { type: 'anthropic', model: 'phase-yaml' };
    const mycoYamlProvider: ProviderConfig = { type: 'ollama', model: 'ollama-model' };
    const result = resolvePhaseExecution(
      phase({ provider: phaseYamlProvider }),
      undefined,
      baseConfig,
      { type: 'anthropic' },
      { phaseA: { provider: mycoYamlProvider } },
    );
    expect(result.provider).toEqual(phaseYamlProvider);
  });

  it('run-level per-phase provider override beats myco.yaml per-phase', () => {
    const mycoYamlProvider: ProviderConfig = { type: 'ollama', model: 'ollama-model' };
    const runPhaseProvider: ProviderConfig = { type: 'openai', model: 'openai-model' };
    const opts: RunOptions = {
      executionOverrides: {
        phases: { phaseA: { provider: runPhaseProvider } },
      },
    };
    const result = resolvePhaseExecution(
      phase(),
      opts,
      baseConfig,
      { type: 'anthropic' },
      { phaseA: { provider: mycoYamlProvider } },
    );
    expect(result.provider).toEqual(runPhaseProvider);
  });

  it('myco.yaml per-phase model override beats provider reasoning map', () => {
    const result = resolvePhaseExecution(
      phase(),
      undefined,
      baseConfig,
      baseProvider,
      { phaseA: { model: 'myco-yaml-model' } },
    );
    expect(result.model).toBe('myco-yaml-model');
  });

  it('run-level per-phase model override beats myco.yaml per-phase model', () => {
    const opts: RunOptions = {
      executionOverrides: { phases: { phaseA: { model: 'run-level-model' } } },
    };
    const result = resolvePhaseExecution(
      phase(),
      opts,
      baseConfig,
      baseProvider,
      { phaseA: { model: 'myco-yaml-model' } },
    );
    expect(result.model).toBe('run-level-model');
  });

  it('myco.yaml per-phase maxTurns beats phase YAML maxTurns', () => {
    const result = resolvePhaseExecution(
      phase({ maxTurns: 8 }),
      undefined,
      baseConfig,
      baseProvider,
      { phaseA: { maxTurns: 20 } },
    );
    expect(result.maxTurns).toBe(20);
  });

  it('run-level per-phase maxTurns beats myco.yaml per-phase maxTurns', () => {
    const opts: RunOptions = {
      executionOverrides: { phases: { phaseA: { maxTurns: 50 } } },
    };
    const result = resolvePhaseExecution(
      phase({ maxTurns: 8 }),
      opts,
      baseConfig,
      baseProvider,
      { phaseA: { maxTurns: 20 } },
    );
    expect(result.maxTurns).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Tests: runAgent (non-phased, backward compatibility)
// ---------------------------------------------------------------------------

describe('runAgent', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(async () => {
    resetMockState();
    cleanTestDb();
    await createTestAgent(TEST_AGENT_ID);
    await createTestTask();
  });

  it('completes a successful run with cost and token tracking', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR);

    expect(result.status).toBe('completed');
    expect(result.runId).toBeDefined();
    expect(result.tokensUsed).toBe(1850);
    expect(result.costUsd).toBe(0.0042);
    expect(result.costSource).toBe('actual');

    const run = getRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.tokens_used).toBe(1850);
    expect(run!.cost_usd).toBe(0.0042);
    expect(run!.actual_cost_usd).toBe(0.0042);
    expect(run!.estimated_cost_usd).toBeNull();
    expect(run!.cost_source).toBe('actual');
    expect(run!.cost_data).toBeTruthy();
    expect(run!.task).toBe(TEST_TASK_NAME);
    expect(run!.agent_id).toBe(TEST_AGENT_ID);
    expect(run!.started_at).toBeGreaterThan(0);
    expect(run!.completed_at).toBeGreaterThan(0);
  });

  it('passes system prompt and composed task prompt to the SDK', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR);

    expect(capturedQueryArgs).not.toBeNull();
    expect(capturedQueryArgs!.prompt).toContain('## Current Vault State');
    expect(capturedQueryArgs!.prompt).toContain('## Task: Vault Evolve');
    expect(capturedQueryArgs!.prompt).toContain(TEST_TASK_PROMPT);
    expect(capturedQueryArgs!.options?.systemPrompt).toBe(TEST_SYSTEM_PROMPT);
  });

  it('returns skipped when a run is already active for the agent', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const existingRunId = crypto.randomUUID();
    insertRun({
      id: existingRunId,
      agent_id: TEST_AGENT_ID,
      task: 'vault-evolve',
      status: 'running',
      started_at: epochSeconds(),
    });

    // Same task running → skipped
    const result = await runAgent(TEST_VAULT_DIR, { task: 'vault-evolve' });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('already_running');
    expect(result.runId).toBe(existingRunId);
    expect(capturedQueryArgs).toBeNull();
  });

  it('marks run as failed on SDK error', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    mockQueryBehavior = 'error';
    mockErrorMessage = 'API rate limit exceeded';

    const result = await runAgent(TEST_VAULT_DIR);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('API rate limit exceeded');
    expect(result.runId).toBeDefined();

    const run = getRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('API rate limit exceeded');
    expect(run!.completed_at).toBeGreaterThan(0);
  });

  it('terminal-marks a resume attempt whose SDK session has expired so it stops re-enqueueing', async () => {
    // Regression for issue #118: when the Claude SDK subprocess exits 1
    // because its session TTLed out, runAgent's catch was re-flagging the
    // run as resumable=1/ready, so the scheduler would pick it up every
    // tick and loop forever. The expired-session detector should redirect
    // to resumable=0/session_expired and null the checkpoint.
    const { runAgent } = await import('@myco/agent/executor.js');

    const existingRunId = crypto.randomUUID();
    insertRun({
      id: existingRunId,
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK_NAME,
      status: 'failed',
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      resumable: 1,
      resume_status: 'ready',
      session_ref: 'stale-session-id',
      checkpoints: JSON.stringify({
        runtime: 'claude-sdk',
        sessionRef: 'stale-session-id',
        phases: {},
      }),
      started_at: epochSeconds() - 600,
      completed_at: epochSeconds() - 300,
      error: 'Claude Code process exited with code 1',
    });

    mockQueryBehavior = 'error';
    mockErrorMessage = 'Claude Code process exited with code 1';

    const result = await runAgent(TEST_VAULT_DIR, {
      task: TEST_TASK_NAME,
      resumeRunId: existingRunId,
      resumeMode: 'scheduled',
    });

    expect(result.status).toBe('failed');
    const run = getRun(existingRunId);
    expect(run).not.toBeNull();
    expect(run!.resumable).toBe(0);
    expect(run!.resume_status).toBe('session_expired');
    expect(run!.checkpoints).toBeNull();
  });

  it('leaves non-expired resume failures as resumable=ready', async () => {
    // Counterpart to the session-expired test — a garden-variety SDK crash
    // on resume should still be retryable. Otherwise one bad run would
    // become permanently abandoned on a transient failure.
    const { runAgent } = await import('@myco/agent/executor.js');

    const existingRunId = crypto.randomUUID();
    insertRun({
      id: existingRunId,
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK_NAME,
      status: 'failed',
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      resumable: 1,
      resume_status: 'ready',
      session_ref: 'session-id',
      checkpoints: JSON.stringify({
        runtime: 'claude-sdk',
        sessionRef: 'session-id',
        phases: {},
      }),
      started_at: epochSeconds() - 120,
      completed_at: epochSeconds() - 60,
      error: 'boom',
    });

    mockQueryBehavior = 'error';
    mockErrorMessage = 'Upstream 500 from model provider';

    const result = await runAgent(TEST_VAULT_DIR, {
      task: TEST_TASK_NAME,
      resumeRunId: existingRunId,
      resumeMode: 'scheduled',
    });

    expect(result.status).toBe('failed');
    const run = getRun(existingRunId);
    expect(run!.resumable).toBe(1);
    expect(run!.resume_status).toBe('ready');
  });

  it('resets started_at to the resume attempt time when resuming a failed run', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const existingRunId = crypto.randomUUID();
    const originalStartedAt = epochSeconds() - 120;
    const originalCompletedAt = epochSeconds() - 60;
    insertRun({
      id: existingRunId,
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK_NAME,
      status: 'failed',
      instruction: 'Retry this run',
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      resumable: 1,
      resume_status: 'ready',
      checkpoints: JSON.stringify({ runtime: 'claude-sdk', phases: {} }),
      started_at: originalStartedAt,
      completed_at: originalCompletedAt,
      error: 'boom',
    });

    const result = await runAgent(TEST_VAULT_DIR, {
      task: TEST_TASK_NAME,
      instruction: 'Retry this run',
      resumeRunId: existingRunId,
      resumeMode: 'manual',
    });

    expect(result.status).toBe('completed');
    const run = getRun(existingRunId);
    expect(run).not.toBeNull();
    expect(run!.started_at).toBeGreaterThan(originalStartedAt);
    expect(run!.started_at).toBeGreaterThanOrEqual(run!.resumed_at ?? 0);
    expect(run!.completed_at).toBeGreaterThanOrEqual(run!.started_at ?? 0);
  });

  it('stores user instruction in run record and prompt', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR, {
      instruction: 'Focus on security observations only.',
    });

    expect(result.status).toBe('completed');

    const run = getRun(result.runId);
    expect(run!.instruction).toBe('Focus on security observations only.');

    expect(capturedQueryArgs!.prompt).toContain('## User Instruction');
    expect(capturedQueryArgs!.prompt).toContain('Focus on security observations only.');
  });

  it('uses correct SDK options (model, maxTurns, tools, permissions)', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR);

    expect(capturedQueryArgs).not.toBeNull();
    const opts = capturedQueryArgs!.options as Record<string, unknown>;
    expect(opts.model).toBe('claude-sonnet-4-20250514');
    expect(opts.maxTurns).toBe(10);
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.persistSession).toBe(true);
    expect(opts.mcpServers).toBeDefined();
    expect(opts.tools).toEqual([]);
  });

  it('resolves config with agent DB overrides', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const db = getDatabase();
    db.prepare(
      `UPDATE agents SET model = ?, max_turns = ? WHERE id = ?`,
    ).run('claude-opus-4-20250514', 20, TEST_AGENT_ID);

    await runAgent(TEST_VAULT_DIR);

    const opts = capturedQueryArgs!.options as Record<string, unknown>;
    expect(opts.model).toBe('claude-opus-4-20250514');
    expect(opts.maxTurns).toBe(20);
  });

  it('does not return phases for non-phased tasks', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR);

    expect(result.status).toBe('completed');
    expect(result.phases).toBeUndefined();
    expect(allQueryCalls.length).toBe(1);
    expect(scopedToolCalls.length).toBe(0);
  });

  it('execution.model overrides task.model', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // Set execution config with a different model — no phases
    mockExecution = { model: 'claude-haiku-4-5' };

    await runAgent(TEST_VAULT_DIR);

    const opts = capturedQueryArgs!.options as Record<string, unknown>;
    expect(opts.model).toBe('claude-haiku-4-5');
  });

  it('execution.maxTurns overrides task.maxTurns', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // Set execution config with a custom maxTurns
    mockExecution = { maxTurns: 42 };

    await runAgent(TEST_VAULT_DIR);

    const opts = capturedQueryArgs!.options as Record<string, unknown>;
    expect(opts.maxTurns).toBe(42);
  });

  it('passes abort controller to SDK for timeout enforcement', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR);

    expect(capturedQueryArgs).not.toBeNull();
    const opts = capturedQueryArgs!.options as Record<string, unknown>;
    // The executor creates an AbortController and passes it to the SDK
    expect(opts.abortController).toBeDefined();
    expect(opts.abortController).toBeInstanceOf(AbortController);
  });

  it('fails title-summary when no report or session update side effect occurred', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');
    await createTask('title-summary', 'Generate or update session titles and summaries.');

    const result = await runAgent(TEST_VAULT_DIR, { task: 'title-summary' });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('title-summary');
    const run = getRun(result.runId);
    expect(run?.status).toBe('failed');
    expect(run?.error).toContain('title-summary');
  });

  it('allows title-summary to complete when it reports a skip', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');
    await createTask('title-summary', 'Generate or update session titles and summaries.');

    mockRunReports = [{
      id: 1,
      run_id: 'unused',
      agent_id: TEST_AGENT_ID,
      action: 'skip',
      summary: 'No update needed',
      details: null,
      created_at: epochSeconds(),
    }];

    const result = await runAgent(TEST_VAULT_DIR, { task: 'title-summary' });

    expect(result.status).toBe('completed');
  });

  it('allows title-summary to complete when it updates the session and reports', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');
    await createTask('title-summary', 'Generate or update session titles and summaries.');

    mockToolCallCounts = { vault_update_session: 1 };
    mockRunReports = [{
      id: 1,
      run_id: 'unused',
      agent_id: TEST_AGENT_ID,
      action: 'summary',
      summary: 'Sessions updated: 1',
      details: null,
      created_at: epochSeconds(),
    }];

    const result = await runAgent(TEST_VAULT_DIR, { task: 'title-summary' });

    expect(result.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Tests: runAgent — phased execution
// ---------------------------------------------------------------------------

describe('runAgent — phased execution', () => {
  const TEST_PHASES: PhaseDefinition[] = [
    {
      name: 'read-state',
      prompt: 'Read vault state.',
      tools: ['vault_state', 'vault_unprocessed'],
      maxTurns: 3,
      required: true,
    },
    {
      name: 'extract',
      prompt: 'Extract spores from batches.',
      tools: ['vault_unprocessed', 'vault_create_spore', 'vault_mark_processed'],
      maxTurns: 15,
      required: true,
      dependsOn: ['read-state'],
    },
    {
      name: 'report',
      prompt: 'Write final report.',
      tools: ['vault_report'],
      maxTurns: 2,
      required: true,
      dependsOn: ['extract'],
    },
  ];

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(async () => {
    resetMockState();
    mockYamlPhases = TEST_PHASES;
    cleanTestDb();
    await createTestAgent(TEST_AGENT_ID);
    await createTestTask();
  });

  it('executes all phases sequentially', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    mockResultTexts = [
      'Found 5 unprocessed batches.',
      'Created 3 spores.',
      'Run complete.',
    ];

    const result = await runAgent(TEST_VAULT_DIR);

    expect(result.status).toBe('completed');
    // 3 phases = 3 query() calls
    expect(allQueryCalls.length).toBe(3);
    // All phases should use scoped tools
    expect(scopedToolCalls.length).toBe(3);
  });

  it('returns per-phase results with token tracking', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR);

    expect(result.phases).toBeDefined();
    expect(result.phases!.length).toBe(3);

    expect(result.phases![0].name).toBe('read-state');
    expect(result.phases![0].status).toBe('completed');
    expect(result.phases![0].tokensUsed).toBe(1850);
    expect(result.phases![0].costUsd).toBe(0.0042);
    expect(result.phases![0].costSource).toBe('actual');
    expect(result.phases![0].turnsUsed).toBe(3);

    expect(result.phases![1].name).toBe('extract');
    expect(result.phases![2].name).toBe('report');

    // Total should be sum of all phases
    expect(result.tokensUsed).toBe(1850 * 3);
    expect(result.costUsd).toBeCloseTo(0.0042 * 3);
  });

  it('scopes tools per phase', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR);

    expect(scopedToolCalls.length).toBe(3);
    expect(scopedToolCalls[0].toolNames).toEqual(['vault_state', 'vault_unprocessed']);
    expect(scopedToolCalls[1].toolNames).toEqual(['vault_unprocessed', 'vault_create_spore', 'vault_mark_processed']);
    expect(scopedToolCalls[2].toolNames).toEqual(['vault_report']);
  });

  it('passes phase-specific maxTurns to SDK', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR);

    expect(allQueryCalls.length).toBe(3);
    expect((allQueryCalls[0].options as Record<string, unknown>).maxTurns).toBe(3);
    expect((allQueryCalls[1].options as Record<string, unknown>).maxTurns).toBe(15);
    expect((allQueryCalls[2].options as Record<string, unknown>).maxTurns).toBe(2);
  });

  it('includes prior phase summaries in later phase prompts', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    mockResultTexts = [
      'Found 5 batches to process.',
      'Extracted 3 spores from 5 batches.',
      'Done.',
    ];

    await runAgent(TEST_VAULT_DIR);

    // Phase 1 prompt should NOT have prior results
    expect(allQueryCalls[0].prompt).not.toContain('## Prior Phase Results');
    expect(allQueryCalls[0].prompt).toContain('## Current Phase: read-state');

    // Phase 2 prompt should have phase 1 results
    expect(allQueryCalls[1].prompt).toContain('## Prior Phase Results');
    expect(allQueryCalls[1].prompt).toContain('### read-state (completed)');
    expect(allQueryCalls[1].prompt).toContain('Found 5 batches to process.');
    expect(allQueryCalls[1].prompt).toContain('## Current Phase: extract');

    // Phase 3 prompt should have phases 1 and 2
    expect(allQueryCalls[2].prompt).toContain('### read-state (completed)');
    expect(allQueryCalls[2].prompt).toContain('### extract (completed)');
    expect(allQueryCalls[2].prompt).toContain('Extracted 3 spores from 5 batches.');
  });

  it('marks the run as failed when a required phase fails', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // Phase 1 succeeds, phase 2 (extract, required) fails
    mockQueryBehaviors = ['success', 'error', 'success'];
    mockErrorMessage = 'Model unavailable';

    const result = await runAgent(TEST_VAULT_DIR);

    // Run-level status must reflect the required phase failure — not "completed".
    // A required phase failing is a failed run, even though the pipeline stopped
    // cleanly instead of throwing through the normal error path.
    expect(result.status).toBe('failed');
    expect(result.error).toContain('extract');
    expect(result.error).toContain('Model unavailable');
    expect(result.phases!.length).toBe(2); // stopped after phase 2 failed
    expect(result.phases![0].status).toBe('completed');
    expect(result.phases![1].status).toBe('failed');
    expect(result.phases![1].summary).toContain('Model unavailable');
    // Phase 3 (report) should NOT have run
    expect(allQueryCalls.length).toBe(2);

    // The DB row must also reflect the failure — the UI reads from here.
    const run = getRun(result.runId);
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('extract');
  });

  it('surfaces timeout abort reasons instead of generic user-abort text', async () => {
    mockYamlPhases = [
      { name: 'explore', prompt: 'Explore.', tools: ['vault_state'], maxTurns: 3, required: true },
    ];

    const { runAgent } = await import('@myco/agent/executor.js');

    mockQueryBehaviors = ['abort'];

    const result = await runAgent(TEST_VAULT_DIR);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Agent run timed out after 1 seconds');
    expect(result.error).not.toContain('Claude Code process aborted by user');
    expect(result.phases?.[0].summary).toContain('Agent run timed out after 1 seconds');
  });

  it('continues pipeline when an optional phase fails', async () => {
    // Override phases to make the middle one optional
    mockYamlPhases = [
      { name: 'read-state', prompt: 'Read state.', tools: ['vault_state'], maxTurns: 3, required: true },
      { name: 'summarize', prompt: 'Update summaries.', tools: ['vault_sessions'], maxTurns: 5, required: false, dependsOn: ['read-state'] },
      { name: 'report', prompt: 'Write report.', tools: ['vault_report'], maxTurns: 2, required: true, dependsOn: ['summarize'] },
    ];

    const { runAgent } = await import('@myco/agent/executor.js');

    // Phase 1 succeeds, phase 2 (optional) fails, phase 3 succeeds
    mockQueryBehaviors = ['success', 'error', 'success'];
    mockErrorMessage = 'Timeout';

    const result = await runAgent(TEST_VAULT_DIR);

    expect(result.phases!.length).toBe(3);
    expect(result.phases![0].status).toBe('completed');
    expect(result.phases![1].status).toBe('failed');
    expect(result.phases![2].status).toBe('completed');
    // All 3 query() calls should have been made
    expect(allQueryCalls.length).toBe(3);
  });

  it('uses phase-specific model when provided', async () => {
    mockYamlPhases = [
      { name: 'extract', prompt: 'Extract.', tools: ['vault_unprocessed'], maxTurns: 20, model: 'claude-haiku-4-5', required: true },
      { name: 'graph', prompt: 'Build graph.', tools: ['vault_create_entity'], maxTurns: 10, required: true, dependsOn: ['extract'] },
    ];

    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR);

    expect(allQueryCalls.length).toBe(2);
    // Phase 1 should use the phase-specific model
    expect((allQueryCalls[0].options as Record<string, unknown>).model).toBe('claude-haiku-4-5');
    // Phase 2 should fall back to the task/agent model
    expect((allQueryCalls[1].options as Record<string, unknown>).model).toBe('claude-sonnet-4-20250514');
  });

  it('uses task-level reasoningLevel for single-query tasks', async () => {
    mockYamlPhases = undefined;
    mockTaskReasoningLevel = 'low';
    mockExecution = {
      provider: {
        type: 'anthropic',
        reasoningMap: {
          low: 'claude-haiku-4-5',
          default: 'claude-sonnet-4-6',
        },
      },
    };

    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR);

    expect(allQueryCalls).toHaveLength(1);
    expect((allQueryCalls[0].options as Record<string, unknown>).model).toBe('claude-haiku-4-5');
  });

  it('uses myco.yaml per-phase model overrides when present', async () => {
    mockYamlPhases = [
      { name: 'extract', prompt: 'Extract.', tools: ['vault_unprocessed'], maxTurns: 20, required: true },
      { name: 'graph', prompt: 'Build graph.', tools: ['vault_create_entity'], maxTurns: 10, required: true, dependsOn: ['extract'] },
    ];
    mockMergedConfig = {
      ...mockMergedConfig,
      agent: {
        ...mockMergedConfig.agent,
        tasks: {
          [TEST_TASK_NAME]: {
            phases: {
              extract: { model: 'claude-opus-4-6' },
            },
          },
        },
      },
    };

    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR);

    expect(allQueryCalls).toHaveLength(2);
    expect((allQueryCalls[0].options as Record<string, unknown>).model).toBe('claude-opus-4-6');
  });

  it('applies RunOptions.executionOverrides.phases per-phase model/reasoning', async () => {
    mockYamlPhases = [
      { name: 'phaseA', prompt: 'Extract.', tools: ['vault_unprocessed'], maxTurns: 5, required: true },
      { name: 'phaseB', prompt: 'Build graph.', tools: ['vault_create_entity'], maxTurns: 5, required: true, dependsOn: ['phaseA'] },
    ];
    mockExecution = {
      provider: {
        type: 'anthropic',
        reasoningMap: {
          low: 'claude-haiku-4-5',
          default: 'claude-sonnet-4-6',
          high: 'claude-opus-4-6',
        },
      },
    };

    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR, {
      executionOverrides: {
        phases: {
          phaseA: { reasoningLevel: 'low' },
          phaseB: { reasoningLevel: 'high' },
        },
      },
    });

    expect(allQueryCalls).toHaveLength(2);
    // Phase A maps 'low' → haiku via the provider reasoningMap
    expect((allQueryCalls[0].options as Record<string, unknown>).model).toBe('claude-haiku-4-5');
    // Phase B maps 'high' → opus
    expect((allQueryCalls[1].options as Record<string, unknown>).model).toBe('claude-opus-4-6');
  });

  it('per-phase model override beats both myco.yaml phase override and reasoning mapping', async () => {
    mockYamlPhases = [
      { name: 'phaseA', prompt: 'Extract.', tools: ['vault_unprocessed'], maxTurns: 5, required: true, model: 'phase-yaml-model' },
    ];

    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR, {
      executionOverrides: {
        phases: {
          phaseA: { model: 'run-option-model' },
        },
      },
    });

    expect(allQueryCalls).toHaveLength(1);
    expect((allQueryCalls[0].options as Record<string, unknown>).model).toBe('run-option-model');
  });

  it('per-phase provider override routes the phase through the chosen provider/model', async () => {
    mockYamlPhases = [
      { name: 'phaseA', prompt: 'Extract.', tools: ['vault_unprocessed'], maxTurns: 5, required: true },
      { name: 'phaseB', prompt: 'Build graph.', tools: ['vault_create_entity'], maxTurns: 5, required: true, dependsOn: ['phaseA'] },
    ];
    mockExecution = {
      provider: {
        type: 'anthropic',
        model: 'claude-sonnet-default',
      },
    };

    const { runAgent } = await import('@myco/agent/executor.js');

    // Use lmstudio (not ollama) so the ollama variant resolver is a no-op.
    await runAgent(TEST_VAULT_DIR, {
      executionOverrides: {
        phases: {
          phaseA: {
            provider: {
              type: 'lmstudio',
              model: 'qwen3-30b',
              baseUrl: 'http://localhost:1234',
            },
          },
        },
      },
    });

    expect(allQueryCalls).toHaveLength(2);
    // Phase A: overridden to LM Studio / qwen3-30b
    expect((allQueryCalls[0].options as Record<string, unknown>).model).toBe('qwen3-30b');
    // Phase B: falls back to the task default (Anthropic / claude-sonnet-default)
    expect((allQueryCalls[1].options as Record<string, unknown>).model).toBe('claude-sonnet-default');
  });

  it('top-level provider override flows to all phases unless a phase overrides it again', async () => {
    mockYamlPhases = [
      { name: 'phaseA', prompt: 'Extract.', tools: [], maxTurns: 5, required: true },
      { name: 'phaseB', prompt: 'Synth.', tools: [], maxTurns: 5, required: true, dependsOn: ['phaseA'] },
    ];
    mockExecution = {
      provider: { type: 'anthropic', model: 'claude-sonnet-default' },
    };

    const { runAgent } = await import('@myco/agent/executor.js');

    // Use lmstudio (not ollama) to avoid the ollama-variant resolver making
    // real network calls to create Modelfile variants.
    await runAgent(TEST_VAULT_DIR, {
      executionOverrides: {
        provider: { type: 'lmstudio', model: 'qwen3-30b', baseUrl: 'http://localhost:1234' },
      },
    });

    expect(allQueryCalls).toHaveLength(2);
    expect((allQueryCalls[0].options as Record<string, unknown>).model).toBe('qwen3-30b');
    expect((allQueryCalls[1].options as Record<string, unknown>).model).toBe('qwen3-30b');
  });

  it('per-phase maxTurns override is applied when the phase executes', async () => {
    mockYamlPhases = [
      { name: 'phaseA', prompt: 'Extract.', tools: [], maxTurns: 5, required: true },
    ];

    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR, {
      executionOverrides: {
        phases: {
          phaseA: { maxTurns: 25 },
        },
      },
    });

    expect(allQueryCalls).toHaveLength(1);
    expect((allQueryCalls[0].options as Record<string, unknown>).maxTurns).toBe(25);
  });

  it('logs a warning once when executionOverrides.phases contains unknown keys', async () => {
    mockYamlPhases = [
      { name: 'phaseA', prompt: 'p.', tools: [], maxTurns: 3, required: true },
    ];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runAgent } = await import('@myco/agent/executor.js');
      const result = await runAgent(TEST_VAULT_DIR, {
        executionOverrides: {
          phases: {
            phaseA: { reasoningLevel: 'low' },
            bogusPhase: { reasoningLevel: 'high' },
          },
        },
      });

      expect(result.status).toBe('completed');
      const unknownCalls = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].includes('Unknown phase override keys'),
      );
      expect(unknownCalls).toHaveLength(1);
      expect(unknownCalls[0][0]).toContain('bogusPhase');
      expect(unknownCalls[0][0]).toContain('task phases: phaseA');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('non-phased task + executionOverrides.phases: warns, does not throw, uses task default', async () => {
    mockYamlPhases = undefined; // single-query (non-phased) path
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runAgent } = await import('@myco/agent/executor.js');
      const result = await runAgent(TEST_VAULT_DIR, {
        executionOverrides: {
          phases: {
            extract: { reasoningLevel: 'high' },
          },
        },
      });

      expect(result.status).toBe('completed');
      expect(allQueryCalls).toHaveLength(1);
      // Single-query path still uses the task/agent default model.
      expect((allQueryCalls[0].options as Record<string, unknown>).model).toBe('claude-sonnet-4-20250514');
      const unknownCalls = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].includes('Unknown phase override keys'),
      );
      expect(unknownCalls).toHaveLength(1);
      expect(unknownCalls[0][0]).toContain('extract');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('records correct aggregate tokens and cost', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR);

    // Each phase: 1850 tokens, $0.0042 — 3 phases total
    expect(result.tokensUsed).toBe(5550);
    expect(result.costUsd).toBeCloseTo(0.0126);

    // Verify DB record
    const run = getRun(result.runId);
    expect(run!.tokens_used).toBe(5550);
    expect(run!.cost_usd).toBeCloseTo(0.0126);
    expect(run!.actual_cost_usd).toBeCloseTo(0.0126);
    expect(run!.cost_source).toBe('actual');
  });

  // ---------------------------------------------------------------------------
  // Orchestrator tests
  // ---------------------------------------------------------------------------

  it('orchestrator disabled (default): runs all phases statically', async () => {
    // No mockOrchestratorConfig set — orchestrator is disabled by default
    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR);

    // Exactly 3 query() calls — one per phase, no orchestrator call
    expect(allQueryCalls.length).toBe(3);
  });

  it('orchestrator enabled: runs planning call before phases', async () => {
    mockOrchestratorConfig = { enabled: true };

    // mockResultTexts[0] = orchestrator JSON plan, then one per phase
    mockResultTexts = [
      JSON.stringify({
        phases: [
          { name: 'read-state', skip: false },
          { name: 'extract', skip: false },
          { name: 'report', skip: false },
        ],
        reasoning: 'Running all phases.',
      }),
      'Found 5 batches.',
      'Created 3 spores.',
      'Run complete.',
    ];

    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR);

    expect(result.status).toBe('completed');
    // 1 orchestrator planning call + 3 phase calls = 4 total
    expect(allQueryCalls.length).toBe(4);
    // Orchestrator call uses an empty mcpServers map with strictMcpConfig
    // — planning needs no vault tools, but we still lock down the surface
    // so the SDK doesn't fall back to loading the user's MCP registry.
    const orchestratorCall = allQueryCalls[0];
    expect((orchestratorCall.options as Record<string, unknown>).mcpServers).toEqual({});
    expect((orchestratorCall.options as Record<string, unknown>).strictMcpConfig).toBe(true);
    expect((orchestratorCall.options as Record<string, unknown>).tools).toEqual([]);
    // All 3 phases should have run
    expect(result.phases!.length).toBe(3);
  });

  it('orchestrator skips non-required phase when directed', async () => {
    // Make middle phase optional so orchestrator can skip it
    mockYamlPhases = [
      { name: 'read-state', prompt: 'Read state.', tools: ['vault_state'], maxTurns: 3, required: true },
      { name: 'summarize', prompt: 'Update summaries.', tools: ['vault_sessions'], maxTurns: 5, required: false, dependsOn: ['read-state'] },
      { name: 'report', prompt: 'Write report.', tools: ['vault_report'], maxTurns: 2, required: true, dependsOn: ['summarize'] },
    ];
    mockOrchestratorConfig = { enabled: true };

    // Orchestrator plan skips the optional 'summarize' phase
    mockResultTexts = [
      JSON.stringify({
        phases: [
          { name: 'read-state', skip: false },
          { name: 'summarize', skip: true, skipReason: 'No new sessions to summarize' },
          { name: 'report', skip: false },
        ],
        reasoning: 'Skipping summarize — no new sessions.',
      }),
      'Vault state read.',
      'Report written.',
    ];

    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR);

    expect(result.status).toBe('completed');
    // 1 orchestrator + 2 phase calls (summarize was skipped)
    expect(allQueryCalls.length).toBe(3);
    // Only 2 phase results (read-state + report)
    expect(result.phases!.length).toBe(2);
    expect(result.phases!.map((p) => p.name)).toEqual(['read-state', 'report']);
  });

  it('orchestrator cannot skip required phase', async () => {
    mockOrchestratorConfig = { enabled: true };

    // Orchestrator attempts to skip the required 'extract' phase
    mockResultTexts = [
      JSON.stringify({
        phases: [
          { name: 'read-state', skip: false },
          { name: 'extract', skip: true, skipReason: 'Looks clean' },
          { name: 'report', skip: false },
        ],
        reasoning: 'Tried to skip required phase.',
      }),
      'State read.',
      'Extracted anyway.',
      'Report done.',
    ];

    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR);

    expect(result.status).toBe('completed');
    // 1 orchestrator + 3 phase calls — required phase cannot be skipped
    expect(allQueryCalls.length).toBe(4);
    expect(result.phases!.length).toBe(3);
    expect(result.phases!.map((p) => p.name)).toEqual(['read-state', 'extract', 'report']);
  });

  it('orchestrator adjusts turn budget per directive', async () => {
    mockOrchestratorConfig = { enabled: true };

    // Plan overrides maxTurns for the extract phase
    mockResultTexts = [
      JSON.stringify({
        phases: [
          { name: 'read-state', skip: false },
          { name: 'extract', skip: false, maxTurns: 7 },
          { name: 'report', skip: false },
        ],
        reasoning: 'Extract needs more turns than usual.',
      }),
      'State read.',
      'Extracted spores.',
      'Report done.',
    ];

    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR);

    // Phase calls start at index 1 (index 0 is orchestrator)
    expect((allQueryCalls[2].options as Record<string, unknown>).maxTurns).toBe(7);
  });

  it('turnsUsed reports SDK num_turns', async () => {
    // The mock result has num_turns: 3. turnsUsed should use this value
    // since it's what the SDK enforces maxTurns against.
    mockAssistantCount = 2;

    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR);

    expect(result.phases).toBeDefined();
    expect(result.phases!.length).toBe(3);
    for (const phase of result.phases!) {
      expect(phase.turnsUsed).toBe(3); // num_turns from SDK result
    }
  });

  it('passes readOnly flag to scoped tool server for read-only phases', async () => {
    mockYamlPhases = [
      { name: 'explore', prompt: 'Explore.', tools: ['vault_spores'], maxTurns: 5, required: true, readOnly: true },
      { name: 'evaluate', prompt: 'Evaluate.', tools: ['vault_skill_candidates'], maxTurns: 5, required: true, dependsOn: ['explore'] },
    ];

    const { runAgent } = await import('@myco/agent/executor.js');
    await runAgent(TEST_VAULT_DIR);

    expect(scopedToolCalls.length).toBe(2);
    // explore phase should have readOnly: true
    expect(scopedToolCalls[0].options?.readOnly).toBe(true);
    // evaluate phase should NOT have readOnly
    expect(scopedToolCalls[1].options?.readOnly).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: computeWaves — topological sort of phases into parallel waves
// ---------------------------------------------------------------------------

describe('computeWaves', () => {
  /** Helper to create a minimal PhaseDefinition for wave computation tests. */
  const makePhase = (name: string, dependsOn?: string[]): PhaseDefinition => ({
    name,
    dependsOn,
    prompt: '',
    tools: [],
    maxTurns: 5,
    required: true,
  });

  it('full intelligence DAG: 7 phases → 5 waves', async () => {
    const { computeWaves } = await import('@myco/agent/executor.js');

    // Matches vault-evolve.yaml dependency graph
    const phases = [
      makePhase('read-state'),
      makePhase('extract', ['read-state']),
      makePhase('summarize', ['read-state']),
      makePhase('consolidate', ['extract']),
      makePhase('graph', ['extract']),
      makePhase('digest', ['consolidate']),
      makePhase('report', ['extract', 'summarize', 'consolidate', 'graph', 'digest']),
    ];

    const waves = computeWaves(phases);

    expect(waves.length).toBe(5);
    expect(waves[0].map((p) => p.name)).toEqual(['read-state']);
    expect(waves[1].map((p) => p.name).sort()).toEqual(['extract', 'summarize']);
    expect(waves[2].map((p) => p.name).sort()).toEqual(['consolidate', 'graph']);
    expect(waves[3].map((p) => p.name)).toEqual(['digest']);
    expect(waves[4].map((p) => p.name)).toEqual(['report']);
  });

  it('all roots: 3 independent phases → single wave', async () => {
    const { computeWaves } = await import('@myco/agent/executor.js');

    const phases = [
      makePhase('a'),
      makePhase('b'),
      makePhase('c'),
    ];

    const waves = computeWaves(phases);

    expect(waves.length).toBe(1);
    expect(waves[0].map((p) => p.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('linear chain: A→B→C → 3 waves of 1 each', async () => {
    const { computeWaves } = await import('@myco/agent/executor.js');

    const phases = [
      makePhase('a'),
      makePhase('b', ['a']),
      makePhase('c', ['b']),
    ];

    const waves = computeWaves(phases);

    expect(waves.length).toBe(3);
    expect(waves[0].map((p) => p.name)).toEqual(['a']);
    expect(waves[1].map((p) => p.name)).toEqual(['b']);
    expect(waves[2].map((p) => p.name)).toEqual(['c']);
  });

  it('diamond: A→[B,C]→D → 3 waves', async () => {
    const { computeWaves } = await import('@myco/agent/executor.js');

    const phases = [
      makePhase('a'),
      makePhase('b', ['a']),
      makePhase('c', ['a']),
      makePhase('d', ['b', 'c']),
    ];

    const waves = computeWaves(phases);

    expect(waves.length).toBe(3);
    expect(waves[0].map((p) => p.name)).toEqual(['a']);
    expect(waves[1].map((p) => p.name).sort()).toEqual(['b', 'c']);
    expect(waves[2].map((p) => p.name)).toEqual(['d']);
  });

  it('circular dependency throws', async () => {
    const { computeWaves } = await import('@myco/agent/executor.js');

    const phases = [
      makePhase('a', ['b']),
      makePhase('b', ['a']),
    ];

    expect(() => computeWaves(phases)).toThrow();
  });

  it('missing dependency treated as satisfied (supports orchestrator skip)', async () => {
    const { computeWaves } = await import('@myco/agent/executor.js');

    const phases = [
      makePhase('a', ['nonexistent']),
    ];

    // Missing deps are treated as already satisfied (the phase may have been
    // removed by orchestrator directives)
    const waves = computeWaves(phases);
    expect(waves.length).toBe(1);
    expect(waves[0].map((p) => p.name)).toEqual(['a']);
  });

  it('empty phases returns empty array', async () => {
    const { computeWaves } = await import('@myco/agent/executor.js');

    const waves = computeWaves([]);

    expect(waves).toEqual([]);
  });
});
