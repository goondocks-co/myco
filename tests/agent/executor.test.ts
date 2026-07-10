import * as __orig__myco_agent_loader_js_1__ns from '@myco/agent/loader.js';
const __orig__myco_agent_loader_js_1 = { ...__orig__myco_agent_loader_js_1__ns };
import * as __orig__myco_db_queries_turns_js_2__ns from '@myco/db/queries/turns.js';
const __orig__myco_db_queries_turns_js_2 = { ...__orig__myco_db_queries_turns_js_2__ns };
import * as __orig__myco_db_queries_reports_js_3__ns from '@myco/db/queries/reports.js';
const __orig__myco_db_queries_reports_js_3 = { ...__orig__myco_db_queries_reports_js_3__ns };
import * as __orig__myco_db_client_js_4__ns from '@myco/db/client.js';
const __orig__myco_db_client_js_4 = { ...__orig__myco_db_client_js_4__ns };
import * as __orig__myco_agent_lmstudio_context_js_5__ns from '@myco/agent/lmstudio-context.js';
const __orig__myco_agent_lmstudio_context_js_5 = { ...__orig__myco_agent_lmstudio_context_js_5__ns };
/**
 * Tests for the agent executor.
 *
 * The Agent SDK's `query()` function is mocked via mock.module() so tests
 * never call the Anthropic API. Each test uses an in-memory PGlite
 * instance with the full schema.
 */

import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
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
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
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

type MockQueryBehavior = 'success' | 'error' | 'error-after-usage' | 'empty' | 'abort';

/**
 * Per-call behaviors. Each query() call shifts the next behavior.
 * Falls back to mockQueryBehavior when exhausted.
 */
let mockQueryBehaviors: MockQueryBehavior[] = [];

/** Default behavior when mockQueryBehaviors is empty. */
let mockQueryBehavior: MockQueryBehavior = 'success';

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

          if (behavior === 'error-after-usage') {
            // Usage lands on a result message before the stream blows up —
            // the adapter wraps the throw in HarnessExecutionError telemetry.
            yield {
              type: 'result' as const,
              subtype: 'error_during_execution' as const,
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
              is_error: true,
              stop_reason: 'end_turn',
              modelUsage: {},
              permission_denials: [],
              uuid: '00000000-0000-0000-0000-000000000001',
              session_id: 'test-session',
            };
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

/** Task name to return from the loader/registry mocks. Set per-test. */
let mockTaskName = TEST_TASK_NAME;

/** YAML task params to return from the loader/registry mocks. Set per-test. */
let mockTaskParams: Record<string, string | number | boolean> | undefined;

/** Execution config to return from the registry mock. Set per-test. */
let mockExecution: ExecutionConfig | undefined;

/** Orchestrator config to return from the registry mock. Set per-test. */
let mockOrchestratorConfig: OrchestratorConfig | undefined;

/** Top-level task reasoning level from the registry mock. Set per-test. */
let mockTaskReasoningLevel: 'low' | 'default' | 'high' | undefined;

/** When set, loadSystemPrompt throws this error. Set per-test. */
let mockLoadSystemPromptError: Error | null = null;

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
      const taskName = mockTaskName;
      // Return a task with phases if mockYamlPhases is set
      if (mockYamlPhases) {
        return [{
          name: taskName,
          displayName: 'Vault Evolve',
          description: 'Run full intelligence pipeline',
          agent: 'myco-agent',
          prompt: 'Phased pipeline overview.',
          isDefault: true,
          ...(mockTaskParams ? { params: mockTaskParams } : {}),
          phases: mockYamlPhases,
        }];
      }
      return [{
        name: taskName,
        displayName: 'Vault Evolve',
        description: 'Run full intelligence pipeline',
        agent: 'myco-agent',
        prompt: TEST_TASK_PROMPT,
        isDefault: true,
      }];
    },
    loadSystemPrompt: () => {
      if (mockLoadSystemPromptError) throw mockLoadSystemPromptError;
      return TEST_SYSTEM_PROMPT;
    },
    // Keep resolveEffectiveConfig from the original module
  };
});

// ---------------------------------------------------------------------------
// Mock: registry (wraps loadAgentTasks — avoids filesystem reads)
// ---------------------------------------------------------------------------

mock.module('@myco/agent/registry.js', () => ({
  loadAllTasks: (_definitionsDir: string, _vaultDir?: string) => {
    const tasks = new Map();
    const taskName = mockTaskName;
      const task = {
        name: taskName,
        displayName: 'Vault Evolve',
        description: 'Run full intelligence pipeline',
        agent: 'myco-agent',
        prompt: mockYamlPhases ? 'Phased pipeline overview.' : TEST_TASK_PROMPT,
        isDefault: true,
        ...(mockTaskReasoningLevel ? { reasoningLevel: mockTaskReasoningLevel } : {}),
        ...(mockTaskParams ? { params: mockTaskParams } : {}),
        ...(mockYamlPhases ? { phases: mockYamlPhases } : {}),
        ...(mockExecution ? { execution: mockExecution } : {}),
        ...(mockOrchestratorConfig ? { orchestrator: mockOrchestratorConfig } : {}),
    };
    tasks.set(taskName, task);
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
// Mock: lmstudio context resolver — passthrough by default; a test can park
// dispatches inside this await by setting the gate, forcing the same-tick
// concurrency window between the early duplicate-run guard and row creation.
// ---------------------------------------------------------------------------

/** When set, resolveLmStudioContextLoads awaits this before resolving. */
let mockLmStudioResolverGate: Promise<void> | null = null;

mock.module('@myco/agent/lmstudio-context.js', () => {
  const original = __orig__myco_agent_lmstudio_context_js_5;
  return {
    ...original,
    resolveLmStudioContextLoads: async (
      ...args: Parameters<typeof original.resolveLmStudioContextLoads>
    ) => {
      if (mockLmStudioResolverGate) await mockLmStudioResolverGate;
      return original.resolveLmStudioContextLoads(...args);
    },
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
  mockTaskName = TEST_TASK_NAME;
  mockYamlPhases = undefined;
  mockTaskParams = undefined;
  mockExecution = undefined;
  mockOrchestratorConfig = undefined;
  mockTaskReasoningLevel = undefined;
  mockLoadSystemPromptError = null;
  mockLmStudioResolverGate = null;
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
  const runId = 'run-compose-phase';

  it('composes vault context + task overview + phase prompt', () => {
    const result = composePhasePrompt({
      vaultContext,
      taskDisplayName: taskName,
      taskOverview,
      phase: { name: 'extract', prompt: 'Extract spores from batches.', tools: [], maxTurns: 5, required: true },
      priorPhaseResults: [],
      runId,
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
      runId,
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
      runId,
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
      runId,
    });

    expect(result).toContain('## User Instruction');
    expect(result).toContain('Focus on security issues.');
  });

  it('interpolates resolved task params and run id in phase prompts', () => {
    const result = composePhasePrompt({
      vaultContext,
      taskDisplayName: taskName,
      taskOverview,
      phase: {
        name: 'assess',
        prompt: 'Run {{run_id}} assess {{max_skills_per_run}} skills every {{assess_interval_hours}} hours; phase={{phase_name}} budget={{max_turns}} tools={{phase_tools}}.',
        tools: ['vault_report'],
        maxTurns: 14,
        required: true,
      },
      priorPhaseResults: [],
      runId: 'run-phase-vars',
      taskParams: {
        max_skills_per_run: 3,
        assess_interval_hours: 24,
      },
    });

    expect(result).toContain('Run run-phase-vars assess 3 skills every 24 hours; phase=assess budget=14 tools=vault_report.');
    expect(result).not.toContain('{{run_id}}');
    expect(result).not.toContain('{{max_skills_per_run}}');
    expect(result).not.toContain('{{assess_interval_hours}}');
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
    harness: 'claude-sdk',
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

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    expect(result.status).toBe('completed');
    expect(result.runId).toBeDefined();
    expect(result.tokensUsed).toBe(1850);
    expect(result.costUsd).toBe(0.0042);
    expect(result.costSource).toBe('actual');

    const run = getRun(result.runId, ALL_PROJECTS_SCOPE);
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

  it('uses the caller-supplied runId for the run row', async () => {
    // Dispatchers (API handler, cortex triggers, canopy regenerate)
    // pre-generate the run id so their responses can name the run without
    // reading the latest row back — that read-back raced the executor's
    // insert (which happens after awaits) and returned stale runs.
    const { runAgent } = await import('@myco/agent/executor.js');

    const callerRunId = crypto.randomUUID();
    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      runId: callerRunId,
    });

    expect(result.status).toBe('completed');
    expect(result.runId).toBe(callerRunId);
    const run = getRun(callerRunId, ALL_PROJECTS_SCOPE);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
  });

  it('resumeRunId wins over a caller-supplied runId', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const existingRunId = crypto.randomUUID();
    insertRun({
      id: existingRunId,
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK_NAME,
      status: 'failed',
      harness: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      resumable: 1,
      resume_status: 'ready',
      started_at: epochSeconds() - 600,
      completed_at: epochSeconds() - 300,
      error: 'transient failure',
    });

    const strayRunId = crypto.randomUUID();
    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      task: TEST_TASK_NAME,
      resumeRunId: existingRunId,
      runId: strayRunId,
    });

    expect(result.runId).toBe(existingRunId);
    expect(getRun(strayRunId, ALL_PROJECTS_SCOPE)).toBeNull();
  });

  it('passes system prompt and composed task prompt to the SDK', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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
    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, task: 'vault-evolve' });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('already_running');
    expect(result.runId).toBe(existingRunId);
    expect(capturedQueryArgs).toBeNull();
  });

  it('marks run as failed on SDK error', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    mockQueryBehavior = 'error';
    mockErrorMessage = 'API rate limit exceeded';

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('API rate limit exceeded');
    expect(result.runId).toBeDefined();

    const run = getRun(result.runId, ALL_PROJECTS_SCOPE);
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
      harness: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      resumable: 1,
      resume_status: 'ready',
      session_ref: 'stale-session-id',
      checkpoints: JSON.stringify({
        harness: 'claude-sdk',
        sessionRef: 'stale-session-id',
        phases: {},
      }),
      started_at: epochSeconds() - 600,
      completed_at: epochSeconds() - 300,
      error: 'Claude Code process exited with code 1',
    });

    mockQueryBehavior = 'error';
    mockErrorMessage = 'Claude Code process exited with code 1';

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
      task: TEST_TASK_NAME,
      resumeRunId: existingRunId,
      resumeMode: 'scheduled',
    });

    expect(result.status).toBe('failed');
    const run = getRun(existingRunId, ALL_PROJECTS_SCOPE);
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
      harness: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      resumable: 1,
      resume_status: 'ready',
      session_ref: 'session-id',
      checkpoints: JSON.stringify({
        harness: 'claude-sdk',
        sessionRef: 'session-id',
        phases: {},
      }),
      started_at: epochSeconds() - 120,
      completed_at: epochSeconds() - 60,
      error: 'boom',
    });

    mockQueryBehavior = 'error';
    mockErrorMessage = 'Upstream 500 from model provider';

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
      task: TEST_TASK_NAME,
      resumeRunId: existingRunId,
      resumeMode: 'scheduled',
    });

    expect(result.status).toBe('failed');
    const run = getRun(existingRunId, ALL_PROJECTS_SCOPE);
    expect(run!.resumable).toBe(1);
    expect(run!.resume_status).toBe('ready');
  });

  it('preserves the original started_at and advances resumed_at when resuming a failed run', async () => {
    // started_at must survive every resume attempt unchanged — it is the
    // run's ORIGINAL dispatch time and the supersede sweep/belt (runs.ts)
    // depend on it being stable dispatch-order evidence. resumed_at is the
    // per-attempt clock: it advances on every resume.
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
      harness: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      resumable: 1,
      resume_status: 'ready',
      checkpoints: JSON.stringify({ harness: 'claude-sdk', phases: {} }),
      started_at: originalStartedAt,
      completed_at: originalCompletedAt,
      error: 'boom',
    });

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
      task: TEST_TASK_NAME,
      instruction: 'Retry this run',
      resumeRunId: existingRunId,
      resumeMode: 'manual',
    });

    expect(result.status).toBe('completed');
    const run = getRun(existingRunId, ALL_PROJECTS_SCOPE);
    expect(run).not.toBeNull();
    expect(run!.started_at).toBe(originalStartedAt);
    expect(run!.resumed_at).not.toBeNull();
    expect(run!.resumed_at!).toBeGreaterThan(originalCompletedAt);
    expect(run!.completed_at).toBeGreaterThanOrEqual(run!.resumed_at ?? 0);
  });

  it('preserves started_at and sets a fresh resumed_at across TWO resume attempts', async () => {
    // Pins the field across two attempts: the second resume must not
    // re-stamp started_at either, and resumed_at must advance each time
    // (not freeze at the first resume's value).
    const { runAgent } = await import('@myco/agent/executor.js');

    const existingRunId = crypto.randomUUID();
    const originalStartedAt = epochSeconds() - 500;
    insertRun({
      id: existingRunId,
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK_NAME,
      status: 'failed',
      instruction: 'Retry this run twice',
      harness: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      resumable: 1,
      resume_status: 'ready',
      checkpoints: JSON.stringify({ harness: 'claude-sdk', phases: {} }),
      started_at: originalStartedAt,
      completed_at: originalStartedAt + 60,
      error: 'boom',
    });

    // First resume attempt fails.
    mockQueryBehavior = 'error';
    mockErrorMessage = 'Transient provider failure';
    const firstResult = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
      task: TEST_TASK_NAME,
      instruction: 'Retry this run twice',
      resumeRunId: existingRunId,
      resumeMode: 'manual',
    });
    expect(firstResult.status).toBe('failed');
    const afterFirst = getRun(existingRunId, ALL_PROJECTS_SCOPE)!;
    expect(afterFirst.started_at).toBe(originalStartedAt);
    const firstResumedAt = afterFirst.resumed_at;
    expect(firstResumedAt).not.toBeNull();

    // Second resume attempt succeeds.
    mockQueryBehavior = 'success';
    const secondResult = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
      task: TEST_TASK_NAME,
      instruction: 'Retry this run twice',
      resumeRunId: existingRunId,
      resumeMode: 'manual',
    });
    expect(secondResult.status).toBe('completed');
    const afterSecond = getRun(existingRunId, ALL_PROJECTS_SCOPE)!;
    expect(afterSecond.started_at).toBe(originalStartedAt);
    expect(afterSecond.resumed_at).not.toBeNull();
    expect(afterSecond.resumed_at!).toBeGreaterThanOrEqual(firstResumedAt!);
    expect(afterSecond.completed_at).toBeGreaterThanOrEqual(afterSecond.resumed_at ?? 0);
  });

  it('stores user instruction in run record and prompt', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
      instruction: 'Focus on security observations only.',
    });

    expect(result.status).toBe('completed');

    const run = getRun(result.runId, ALL_PROJECTS_SCOPE);
    expect(run!.instruction).toBe('Focus on security observations only.');

    expect(capturedQueryArgs!.prompt).toContain('## User Instruction');
    expect(capturedQueryArgs!.prompt).toContain('Focus on security observations only.');
  });

  it('uses correct SDK options (model, maxTurns, tools, permissions)', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    const opts = capturedQueryArgs!.options as Record<string, unknown>;
    expect(opts.model).toBe('claude-opus-4-20250514');
    expect(opts.maxTurns).toBe(20);
  });

  it('does not return phases for non-phased tasks', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    expect(result.status).toBe('completed');
    expect(result.phases).toBeUndefined();
    expect(allQueryCalls.length).toBe(1);
    expect(scopedToolCalls.length).toBe(0);
  });

  it('execution.model overrides task.model', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // Set execution config with a different model — no phases
    mockExecution = { model: 'claude-haiku-4-5' };

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    const opts = capturedQueryArgs!.options as Record<string, unknown>;
    expect(opts.model).toBe('claude-haiku-4-5');
  });

  it('execution.maxTurns overrides task.maxTurns', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // Set execution config with a custom maxTurns
    mockExecution = { maxTurns: 42 };

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    const opts = capturedQueryArgs!.options as Record<string, unknown>;
    expect(opts.maxTurns).toBe(42);
  });

  it('passes abort controller to SDK for timeout enforcement', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    expect(capturedQueryArgs).not.toBeNull();
    const opts = capturedQueryArgs!.options as Record<string, unknown>;
    // The executor creates an AbortController and passes it to the SDK
    expect(opts.abortController).toBeDefined();
    expect(opts.abortController).toBeInstanceOf(AbortController);
  });

  it('fails title-summary when no report or session update side effect occurred', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');
    await createTask('title-summary', 'Generate or update session titles and summaries.');

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, task: 'title-summary' });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('title-summary');
    const run = getRun(result.runId, ALL_PROJECTS_SCOPE);
    expect(run?.status).toBe('failed');
    expect(run?.error).toContain('title-summary');
    // Regression guard: executeSingleQuery's mocked harness call succeeds
    // (1500 input + 350 output = 1850 tokens, same usage shape as the
    // 'records tokens_used from num_turns' success-path test) BEFORE the
    // run-end postcondition throws a plain Error. Postcondition failures
    // are not HarnessExecutionError, so before hoisting `tokensUsed`/`usage`
    // out of the try block (executor.ts), the catch block's failure-usage
    // rebuild had no way to see this already-populated usage and always
    // persisted tokens_used=0 despite the run being fully billed (observed
    // on ea34158d, 0f22a8c3).
    expect(run?.tokens_used).toBe(1850);
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

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, task: 'title-summary' });

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

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, task: 'title-summary' });

    expect(result.status).toBe('completed');
  });

  it('completes a scheduled title-summary run and writes the title for a rootless (treeless) project', async () => {
    // Team Host shape: a registered project whose working tree lives on a
    // member machine, not this one. title-summary never touches the tree
    // (its tool surface is vault_unprocessed/vault_session_summary_material/
    // vault_update_session/vault_report, all DB-resident) — the scheduled-
    // tasks dispatcher's treeAvailable:false must not stop it from
    // completing and writing the title.
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

    const rootlessRequestContext = {
      ...TEST_REQUEST_CONTEXT,
      projectRoot: '/nonexistent/rootless-project',
    };

    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: rootlessRequestContext,
      task: 'title-summary',
      treeAvailable: false,
    });

    expect(result.status).toBe('completed');
    const run = getRun(result.runId, ALL_PROJECTS_SCOPE);
    expect(run?.status).toBe('completed');
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

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    expect(result.status).toBe('completed');
    // 3 phases = 3 query() calls
    expect(allQueryCalls.length).toBe(3);
    // All phases should use scoped tools
    expect(scopedToolCalls.length).toBe(3);
  });

  it('returns per-phase results with token tracking', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

  it('records a requiresProjectTree phase skip on the run, visible in agent_runs.checkpoints, when treeAvailable is false', async () => {
    // A tree-requiring phase in a scheduled run for a treeless (Team Host
    // served) project must be skipped and annotated on the run rather than
    // silently invoked against a nonexistent projectRoot.
    mockYamlPhases = [
      {
        name: 'scan-tree',
        prompt: 'Survey the working tree.',
        tools: [],
        maxTurns: 3,
        required: false,
        requiresProjectTree: true,
      },
      {
        name: 'report',
        prompt: 'Write final report.',
        tools: ['vault_report'],
        maxTurns: 2,
        required: true,
        dependsOn: ['scan-tree'],
      },
    ];

    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: { ...TEST_REQUEST_CONTEXT, projectRoot: '/nonexistent/rootless-project' },
      treeAvailable: false,
    });

    expect(result.status).toBe('completed');
    expect(result.phases).toBeDefined();
    const scanPhase = result.phases!.find((p) => p.name === 'scan-tree');
    expect(scanPhase?.status).toBe('skipped');
    expect(scanPhase?.summary).toContain('requires project tree');
    // Only the report phase actually invoked the harness.
    expect(allQueryCalls.length).toBe(1);

    const run = getRun(result.runId, ALL_PROJECTS_SCOPE);
    expect(run?.checkpoints).not.toBeNull();
    const checkpoints = JSON.parse(run!.checkpoints!);
    expect(checkpoints.phases['scan-tree'].status).toBe('skipped');
  });

  it('skips both real skill-generate phases for a rootless project without creating the phantom root', async () => {
    // skill-generate's draft and validate phases both write into the project
    // tree (vault_stage_skill stages under <root>/.myco/staging/skills/,
    // vault_finalize_skill promotes to <root>/.agents/skills/). On a treeless
    // (Team Host served) project the run must complete with both phases
    // skipped and annotated — zero harness invocations, and no directory
    // fabricated at the member's projectRoot path.
    const { BUNDLED_AGENT_TASKS } = await import('@myco/agent/definitions.generated.js');
    const sg = BUNDLED_AGENT_TASKS.find((t) => t.name === 'skill-generate');
    mockTaskName = 'skill-generate';
    mockYamlPhases = [...(sg!.phases ?? [])];
    await createTask('skill-generate', 'Generate a skill.');

    const phantomRoot = '/nonexistent/rootless-skillgen-project';
    const { runAgent } = await import('@myco/agent/executor.js');
    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: { ...TEST_REQUEST_CONTEXT, projectRoot: phantomRoot },
      task: 'skill-generate',
      treeAvailable: false,
    });

    expect(result.status).toBe('completed');
    const draft = result.phases!.find((p) => p.name === 'draft');
    const validate = result.phases!.find((p) => p.name === 'validate');
    expect(draft?.status).toBe('skipped');
    expect(validate?.status).toBe('skipped');
    expect(draft?.summary).toContain('requires project tree');
    expect(validate?.summary).toContain('requires project tree');
    expect(allQueryCalls.length).toBe(0);

    const run = getRun(result.runId, ALL_PROJECTS_SCOPE);
    expect(run?.checkpoints).not.toBeNull();
    const checkpoints = JSON.parse(run!.checkpoints!);
    expect(checkpoints.phases['draft'].status).toBe('skipped');
    expect(checkpoints.phases['validate'].status).toBe('skipped');

    expect(existsSync(phantomRoot)).toBe(false);
  });

  it('scopes tools per phase', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    expect(scopedToolCalls.length).toBe(3);
    expect(scopedToolCalls[0].toolNames).toEqual(['vault_state', 'vault_unprocessed']);
    expect(scopedToolCalls[1].toolNames).toEqual(['vault_unprocessed', 'vault_create_spore', 'vault_mark_processed']);
    expect(scopedToolCalls[2].toolNames).toEqual(['vault_report']);
  });

  it('passes phase-specific maxTurns to SDK', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    expect(allQueryCalls.length).toBe(3);
    expect((allQueryCalls[0].options as Record<string, unknown>).maxTurns).toBe(3);
    expect((allQueryCalls[1].options as Record<string, unknown>).maxTurns).toBe(15);
    expect((allQueryCalls[2].options as Record<string, unknown>).maxTurns).toBe(2);
  });

  it('passes resolved task params into executed phase prompts', async () => {
    mockYamlPhases = [
      {
        name: 'assess',
        prompt: 'Run {{run_id}} assess cap is {{max_skills_per_run}} and turn budget is {{max_turns}}.',
        tools: [],
        maxTurns: 5,
        required: true,
      },
    ];

    const { runAgent } = await import('@myco/agent/executor.js');
    await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      taskParams: { max_skills_per_run: 3 },
    });

    expect(allQueryCalls.length).toBe(1);
    expect(allQueryCalls[0].prompt).toContain('assess cap is 3 and turn budget is 5.');
    expect(allQueryCalls[0].prompt).not.toContain('{{run_id}}');
    expect(allQueryCalls[0].prompt).not.toContain('{{max_skills_per_run}}');
  });

  it('passes YAML default task params into executed phase prompts without run overrides', async () => {
    mockYamlPhases = [
      {
        name: 'assess',
        prompt: 'Run {{run_id}} default assess cap is {{max_skills_per_run}}.',
        tools: [],
        maxTurns: 5,
        required: true,
      },
    ];
    mockTaskParams = { max_skills_per_run: 3 };

    const { runAgent } = await import('@myco/agent/executor.js');
    await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
    });

    expect(allQueryCalls.length).toBe(1);
    expect(allQueryCalls[0].prompt).toContain('default assess cap is 3.');
    expect(allQueryCalls[0].prompt).not.toContain('{{run_id}}');
    expect(allQueryCalls[0].prompt).not.toContain('{{max_skills_per_run}}');
  });

  it('includes prior phase summaries in later phase prompts', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    mockResultTexts = [
      'Found 5 batches to process.',
      'Extracted 3 spores from 5 batches.',
      'Done.',
    ];

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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
    const run = getRun(result.runId, ALL_PROJECTS_SCOPE);
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('extract');
  });

  it('runs task postconditions after phased task success', async () => {
    mockTaskName = 'skill-evolve';
    mockYamlPhases = [
      {
        name: 'inventory',
        prompt: 'Write inventory.',
        tools: ['vault_report'],
        maxTurns: 2,
        required: true,
      },
      {
        name: 'assess',
        prompt: 'Write assessment.',
        tools: ['vault_report'],
        maxTurns: 2,
        required: true,
        dependsOn: ['inventory'],
      },
    ];
    await createTask('skill-evolve', 'Run skill evolution.');

    const { runAgent } = await import('@myco/agent/executor.js');
    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      task: 'skill-evolve',
    });

    expect(allQueryCalls.length).toBe(2);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('skill-evolve completed without a skill-evolve-inventory report');
    const run = getRun(result.runId, ALL_PROJECTS_SCOPE);
    expect(run?.status).toBe('failed');
    expect(run?.error).toContain('skill-evolve completed without a skill-evolve-inventory report');
  });

  it('surfaces timeout abort reasons instead of generic user-abort text', async () => {
    mockYamlPhases = [
      { name: 'explore', prompt: 'Explore.', tools: ['vault_state'], maxTurns: 3, required: true },
    ];

    const { runAgent } = await import('@myco/agent/executor.js');

    mockQueryBehaviors = ['abort'];

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
      executionOverrides: {
        phases: {
          phaseA: { reasoningLevel: 'low' },
          phaseB: {reasoningLevel: 'high' },
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

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
      executionOverrides: {
        phases: {
          phaseA: {model: 'run-option-model' },
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
    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
      executionOverrides: {
        phases: {
          phaseA: {
            provider: {              type: 'lmstudio',
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
    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
      executionOverrides: {
        provider: {type: 'lmstudio', model: 'qwen3-30b', baseUrl: 'http://localhost:1234' },
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

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
      executionOverrides: {
        phases: {
          phaseA: {maxTurns: 25 },
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
      const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
        executionOverrides: {
          phases: {
            phaseA: { reasoningLevel: 'low' },
            bogusPhase: {reasoningLevel: 'high' },
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
      const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT,
        executionOverrides: {
          phases: {
            extract: {reasoningLevel: 'high' },
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

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    // Each phase: 1850 tokens, $0.0042 — 3 phases total
    expect(result.tokensUsed).toBe(5550);
    expect(result.costUsd).toBeCloseTo(0.0126);

    // Verify DB record
    const run = getRun(result.runId, ALL_PROJECTS_SCOPE);
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

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    // Phase calls start at index 1 (index 0 is orchestrator)
    expect((allQueryCalls[2].options as Record<string, unknown>).maxTurns).toBe(7);
  });

  it('turnsUsed reports SDK num_turns', async () => {
    // The mock result has num_turns: 3. turnsUsed should use this value
    // since it's what the SDK enforces maxTurns against.
    mockAssistantCount = 2;

    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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
    await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

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

// ---------------------------------------------------------------------------
// Tests: runAgent — run lifecycle (RC-9): resume input restoration, insert
// window, stale running rows, failed-run telemetry.
// ---------------------------------------------------------------------------

describe('runAgent — run lifecycle', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(async () => {
    resetMockState();
    cleanTestDb();
    await createTestAgent(TEST_AGENT_ID);
    await createTestTask();
  });

  function insertResumableRun(overrides: Partial<Parameters<typeof insertRun>[0]> = {}): string {
    const id = crypto.randomUUID();
    insertRun({
      id,
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK_NAME,
      status: 'failed',
      resumable: 1,
      resume_status: 'ready',
      checkpoints: JSON.stringify({ harness: 'claude-sdk', phases: {} }),
      started_at: epochSeconds() - 120,
      completed_at: epochSeconds() - 60,
      error: 'boom',
      ...overrides,
    });
    return id;
  }

  it('restores instruction and run_context from the resumed row when the caller omits them', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');
    const { getState } = await import('@myco/db/queries/agent-state.js');
    const { SKILL_SURVEY_WATERMARK_KEY } = await import('@myco/agent/instruction-builders.js');

    await createTask('skill-survey');
    const runId = insertResumableRun({
      task: 'skill-survey',
      instruction: 'Original survey instruction',
      run_context: JSON.stringify({ skill_survey_watermark: 777 }),
    });

    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      resumeRunId: runId,
      resumeMode: 'scheduled',
    });

    expect(result.status).toBe('completed');
    expect(capturedQueryArgs!.prompt).toContain('Original survey instruction');
    // runContext restoration is observable through the skill-survey success
    // hook, which persists the watermark carried on runContext.
    const state = getState(TEST_AGENT_ID, TEST_REQUEST_CONTEXT.projectId!, SKILL_SURVEY_WATERMARK_KEY);
    expect(state?.value).toBe('777');
  });

  it('restores dry_run from the resumed row — a resumed dry-run skips success hooks', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');
    const { getState } = await import('@myco/db/queries/agent-state.js');
    const { SKILL_SURVEY_WATERMARK_KEY } = await import('@myco/agent/instruction-builders.js');

    await createTask('skill-survey');
    const runId = insertResumableRun({
      task: 'skill-survey',
      instruction: 'Original survey instruction',
      run_context: JSON.stringify({ skill_survey_watermark: 888 }),
      dryRun: true,
    });

    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      resumeRunId: runId,
      resumeMode: 'scheduled',
    });

    expect(result.status).toBe('completed');
    // dry-run restored from the row → finalizeOnTaskSuccess early-returns,
    // so the watermark must NOT be written.
    expect(getState(TEST_AGENT_ID, TEST_REQUEST_CONTEXT.projectId!, SKILL_SURVEY_WATERMARK_KEY)).toBeNull();
    expect(getRun(runId, ALL_PROJECTS_SCOPE)!.dry_run).toBe(true);
  });

  it('prefers caller-supplied values over the resumed row', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const runId = insertResumableRun({ instruction: 'Row instruction A' });

    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      resumeRunId: runId,
      instruction: 'Caller instruction B',
    });

    expect(result.status).toBe('completed');
    expect(capturedQueryArgs!.prompt).toContain('Caller instruction B');
    expect(capturedQueryArgs!.prompt).not.toContain('Row instruction A');
  });

  it('restores executionOverrides (reasoning tier) from the resumed row', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    mockExecution = {
      provider: {
        type: 'anthropic',
        reasoningMap: { high: 'claude-high-tier', low: 'claude-low-tier' },
      },
    } as ExecutionConfig;
    const runId = insertResumableRun({
      reasoningLevel: 'high',
      executionOverrides: { reasoningLevel: 'high' },
    });

    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      resumeRunId: runId,
    });

    expect(result.status).toBe('completed');
    expect((capturedQueryArgs!.options as Record<string, unknown>).model).toBe('claude-high-tier');
  });

  it('pins a CONFIG-resolved reasoningLevel (no caller override) across resume after config changes', async () => {
    // C1 regression: reasoningLevel resolved from task config at dispatch
    // (not from a caller-supplied executionOverrides.reasoningLevel) must
    // still be snapshotted onto agent_runs.execution_overrides, so a resumed
    // run uses the ORIGINAL tier even if the live task config's reasoning
    // level changes in between. Exercises rung 3 of the restore ladder
    // (`resumedRun.reasoning_level` with no pre-existing executionOverrides
    // entry for reasoningLevel) via a real dispatch→flip→resume cycle,
    // mirroring executor-semantic-check-resume.test.ts's machinery.
    mockTaskReasoningLevel = 'low';
    mockExecution = {
      provider: {
        type: 'anthropic',
        reasoningMap: { low: 'claude-low-tier', high: 'claude-high-tier' },
      },
    } as ExecutionConfig;

    const { runAgent } = await import('@myco/agent/executor.js');

    const dispatched = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });
    expect(dispatched.status).toBe('completed');
    expect((capturedQueryArgs!.options as Record<string, unknown>).model).toBe('claude-low-tier');

    const dispatchedRow = getRun(dispatched.runId, ALL_PROJECTS_SCOPE)!;
    expect(dispatchedRow.reasoning_level).toBe('low');
    expect(dispatchedRow.execution_overrides).toBeTruthy();
    expect(dispatchedRow.execution_overrides!.reasoningLevel).toBe('low');

    // Flip the live task config's reasoning level — simulating an operator
    // editing myco.yaml between dispatch and resume.
    mockTaskReasoningLevel = 'high';

    const { applyRunUpdate } = await import('@myco/db/queries/runs.js');
    applyRunUpdate(dispatched.runId, { status: 'failed', resumable: 1, resume_status: 'ready' }, ALL_PROJECTS_SCOPE);

    const resumed = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      resumeRunId: dispatched.runId,
      resumeMode: 'scheduled',
    });

    expect(resumed.status).toBe('completed');
    // Must still resolve to the ORIGINAL 'low' tier, not the flipped 'high'.
    expect((capturedQueryArgs!.options as Record<string, unknown>).model).toBe('claude-low-tier');
  });

  it('tolerates unparseable run_context on resume', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const runId = insertResumableRun({ run_context: 'not-json{' });

    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      resumeRunId: runId,
    });
    expect(result.status).toBe('completed');
  });

  it('persists runContext to the run_context column on insert', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      runContext: { skill_survey_watermark: 5 },
    });

    expect(result.status).toBe('completed');
    const run = getRun(result.runId, ALL_PROJECTS_SCOPE)!;
    expect(JSON.parse(run.run_context!)).toEqual({ skill_survey_watermark: 5 });
  });

  it('does not create a run row when pre-run setup throws', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    mockLoadSystemPromptError = new Error('definitions dir unreadable');

    await expect(runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT }))
      .rejects.toThrow('definitions dir unreadable');

    // No orphaned 'running' row: the row is created immediately before the
    // try whose catch marks it failed, so a setup throw leaves nothing.
    const count = getDatabase().prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('does not let a stale running row block a new dispatch', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const staleId = crypto.randomUUID();
    insertRun({
      id: staleId,
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK_NAME,
      status: 'running',
      started_at: epochSeconds() - 7200,
    });

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, task: TEST_TASK_NAME });

    expect(result.status).toBe('completed');
    expect(result.runId).not.toBe(staleId);
    // The guard is read-only: boot recovery owns marking the orphan.
    expect(getRun(staleId, ALL_PROJECTS_SCOPE)!.status).toBe('running');
  });

  it('still skips when a fresh running row exists for the task', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const freshId = crypto.randomUUID();
    insertRun({
      id: freshId,
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK_NAME,
      status: 'running',
      started_at: epochSeconds() - 10,
    });

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, task: TEST_TASK_NAME });

    expect(result.status).toBe('skipped');
    expect(result.runId).toBe(freshId);
  });

  it('single-flights two same-tick concurrent dispatches of the same task', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // Park both dispatches inside the resolver await — past the early
    // duplicate-run guard, before row creation — then release them
    // together. This is the window where the early guard alone admits both.
    let release!: () => void;
    mockLmStudioResolverGate = new Promise<void>((resolve) => { release = resolve; });

    const first = runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, task: TEST_TASK_NAME });
    const second = runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, task: TEST_TASK_NAME });
    release();
    const [r1, r2] = await Promise.all([first, second]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(['completed', 'skipped']);
    const completed = r1.status === 'completed' ? r1 : r2;
    const skipped = r1.status === 'skipped' ? r1 : r2;
    expect(skipped.reason).toBe('already_running');
    expect(skipped.runId).toBe(completed.runId);

    // Exactly one agent_runs row — the loser never inserted.
    const count = getDatabase().prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number };
    expect(count.n).toBe(1);
    expect(getRun(completed.runId, ALL_PROJECTS_SCOPE)!.status).toBe('completed');
  });

  it('records telemetry usage and cost on a failed single-query', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    mockQueryBehavior = 'error-after-usage';
    mockErrorMessage = 'stream exploded mid-run';

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT });

    expect(result.status).toBe('failed');
    const run = getRun(result.runId, ALL_PROJECTS_SCOPE)!;
    expect(run.status).toBe('failed');
    expect(run.tokens_used).toBe(1850);
    expect(run.cost_usd).toBe(0.0042);
    expect(run.cost_source).toBe('actual');
  });

  // ---------------------------------------------------------------------
  // Regression test 3: all-restored resume + failing run-end validator ⇒
  // ONE attempt terminal-marks 'postcondition_unsatisfiable' (typed error
  // path), checkpoints preserved; does not burn 3 attempts.
  // ---------------------------------------------------------------------

  describe('Part 3 — PostconditionUnsatisfiableError on an all-restored resume', () => {
    it('terminal-marks postcondition_unsatisfiable in ONE attempt when every phase was restored and the contract is still unmet', async () => {
      mockTaskName = 'skill-evolve';
      mockYamlPhases = [
        {
          name: 'inventory',
          prompt: 'Write inventory.',
          tools: ['vault_report'],
          maxTurns: 2,
          required: true,
        },
        {
          name: 'assess',
          prompt: 'Write assessment.',
          tools: ['vault_report'],
          maxTurns: 2,
          required: true,
          dependsOn: ['inventory'],
        },
      ];
      await createTask('skill-evolve', 'Run skill evolution.');

      // Checkpoint has BOTH phases already marked completed — a resume
      // restores them without re-invoking the harness. No matching
      // agent_reports/agent_state rows exist in the DB (this test never
      // ran the phases for real), so the run-end postcondition validator
      // fails exactly as it would for a genuinely stuck run.
      const runId = insertResumableRun({
        task: 'skill-evolve',
        checkpoints: JSON.stringify({
          harness: 'claude-sdk',
          phases: {
            inventory: { name: 'inventory', status: 'completed', summary: 'done', turnsUsed: 2, tokensUsed: 100, updatedAt: 0 },
            assess: { name: 'assess', status: 'completed', summary: 'done', turnsUsed: 2, tokensUsed: 100, updatedAt: 0 },
          },
        }),
      });

      const { runAgent } = await import('@myco/agent/executor.js');
      const result = await runAgent(TEST_VAULT_DIR, {
        requestContext: TEST_REQUEST_CONTEXT,
        resumeRunId: runId,
        resumeMode: 'scheduled',
      });

      // Zero fresh harness calls — every phase was trusted from the checkpoint.
      expect(allQueryCalls.length).toBe(0);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('skill-evolve completed without a skill-evolve-inventory report');

      const run = getRun(runId, ALL_PROJECTS_SCOPE)!;
      expect(run.status).toBe('failed');
      // Terminal-marked in ONE attempt — resumable=0 stops the scheduler
      // from re-admitting a run that can never satisfy its contract by
      // retrying (retrying re-runs nothing).
      expect(run.resumable).toBe(0);
      expect(run.resume_status).toBe('postcondition_unsatisfiable');
      expect(run.resume_attempts).toBe(0);
      // Unlike session-expired, checkpoints are PRESERVED for debugging —
      // never nulled.
      expect(run.checkpoints).not.toBeNull();
      const checkpoints = JSON.parse(run.checkpoints!);
      expect(checkpoints.phases.inventory.status).toBe('completed');
      expect(checkpoints.phases.assess.status).toBe('completed');
    });

    it('does NOT terminal-mark postcondition_unsatisfiable when at least one phase executed fresh this attempt', async () => {
      mockTaskName = 'skill-evolve';
      mockYamlPhases = [
        {
          name: 'inventory',
          prompt: 'Write inventory.',
          tools: ['vault_report'],
          maxTurns: 2,
          required: true,
        },
        {
          name: 'assess',
          prompt: 'Write assessment.',
          tools: ['vault_report'],
          maxTurns: 2,
          required: true,
          dependsOn: ['inventory'],
        },
      ];
      await createTask('skill-evolve', 'Run skill evolution.');

      // Only 'inventory' is restored; 'assess' has no checkpoint entry, so
      // it re-executes fresh this attempt (executedPhaseCount === 1).
      const runId = insertResumableRun({
        task: 'skill-evolve',
        checkpoints: JSON.stringify({
          harness: 'claude-sdk',
          phases: {
            inventory: { name: 'inventory', status: 'completed', summary: 'done', turnsUsed: 2, tokensUsed: 100, updatedAt: 0 },
          },
        }),
      });

      const { runAgent } = await import('@myco/agent/executor.js');
      const result = await runAgent(TEST_VAULT_DIR, {
        requestContext: TEST_REQUEST_CONTEXT,
        resumeRunId: runId,
        resumeMode: 'scheduled',
      });

      expect(allQueryCalls.length).toBe(1);
      expect(result.status).toBe('failed');

      const run = getRun(runId, ALL_PROJECTS_SCOPE)!;
      // The generic Error path (RESUME_STATUS_READY), not the typed
      // PostconditionUnsatisfiableError path — this run made progress and
      // is worth retrying under the normal resume budget.
      expect(run.resumable).toBe(1);
      expect(run.resume_status).toBe('ready');
    });
  });
});
