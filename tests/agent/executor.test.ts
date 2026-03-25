/**
 * Tests for the agent executor.
 *
 * The Agent SDK's `query()` function is mocked via vi.mock() so tests
 * never call the Anthropic API. Each test uses an in-memory PGlite
 * instance with the full schema.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertTask } from '@myco/db/queries/tasks.js';
import { insertRun, getRun } from '@myco/db/queries/runs.js';
import { epochSeconds } from '@myco/constants.js';
import { composeTaskPrompt, composePhasePrompt } from '@myco/agent/executor.js';
import type { PhaseDefinition, ExecutionConfig, OrchestratorConfig } from '@myco/agent/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'myco-agent';
const TEST_VAULT_DIR = '/tmp/test-vault';
const TEST_TASK_NAME = 'full-intelligence';
const TEST_TASK_PROMPT = 'Run full intelligence pipeline.';
const TEST_SYSTEM_PROMPT = 'You are a vault agent.';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

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
let mockQueryBehaviors: Array<'success' | 'error' | 'empty'> = [];

/** Default behavior when mockQueryBehaviors is empty. */
let mockQueryBehavior: 'success' | 'error' | 'empty' = 'success';

/** Custom error message for the 'error' behavior. */
let mockErrorMessage = 'SDK exploded';

/** Per-call result text. Shifts the next value per query() call. */
let mockResultTexts: string[] = [];

/** Default result text for successful queries. */
const DEFAULT_RESULT_TEXT = 'Agent run complete.';

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
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

          if (behavior === 'success') {
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

vi.mock('@myco/agent/loader.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@myco/agent/loader.js')>();
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
          displayName: 'Full Intelligence',
          description: 'Run full intelligence pipeline',
          agent: 'myco-agent',
          prompt: 'Phased pipeline overview.',
          isDefault: true,
          phases: mockYamlPhases,
        }];
      }
      return [{
        name: TEST_TASK_NAME,
        displayName: 'Full Intelligence',
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

vi.mock('@myco/agent/registry.js', () => ({
  loadAllTasks: (_definitionsDir: string, _vaultDir?: string) => {
    const tasks = new Map();
    const task = {
      name: TEST_TASK_NAME,
      displayName: 'Full Intelligence',
      description: 'Run full intelligence pipeline',
      agent: 'myco-agent',
      prompt: mockYamlPhases ? 'Phased pipeline overview.' : TEST_TASK_PROMPT,
      isDefault: true,
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

vi.mock('@myco/agent/context.js', () => ({
  buildVaultContext: async () => '## Current Vault State\nagent_id: myco-agent\nunprocessed_batches: 5',
}));

// ---------------------------------------------------------------------------
// Mock: tools (track scoped tool server calls)
// ---------------------------------------------------------------------------

/** Captured calls to createScopedVaultToolServer. */
let scopedToolCalls: Array<{ agentId: string; runId: string; toolNames: string[] }> = [];

vi.mock('@myco/agent/tools.js', () => ({
  createVaultToolServer: (_agentId: string, _runId: string) => ({
    type: 'sdk' as const,
    name: 'myco-vault',
    instance: {},
  }),
  createScopedVaultToolServer: (agentId: string, runId: string, toolNames: string[]) => {
    scopedToolCalls.push({ agentId, runId, toolNames });
    return {
      type: 'sdk' as const,
      name: 'myco-vault',
      instance: {},
    };
  },
}));

// ---------------------------------------------------------------------------
// Mock: initDatabaseForVault (we manage DB ourselves in tests)
// ---------------------------------------------------------------------------

vi.mock('@myco/db/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@myco/db/client.js')>();
  return {
    ...original,
    initDatabaseForVault: async () => original.getDatabase(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestAgent(id: string): Promise<void> {
  const now = epochNow();
  await registerAgent({
    id,
    name: `agent-${id}`,
    created_at: now,
    updated_at: now,
  });
}

async function createTestTask(): Promise<void> {
  const now = epochNow();
  await upsertTask({
    id: TEST_TASK_NAME,
    agent_id: TEST_AGENT_ID,
    prompt: TEST_TASK_PROMPT,
    display_name: 'Full Intelligence',
    description: 'Run full intelligence pipeline',
    is_default: 1,
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
}

// ---------------------------------------------------------------------------
// Tests: composeTaskPrompt
// ---------------------------------------------------------------------------

describe('composeTaskPrompt', () => {
  it('composes vault context + task without instruction', () => {
    const result = composeTaskPrompt(
      '## Vault State\nspores: 10',
      'Full Intelligence',
      'Run full intelligence.',
    );

    expect(result).toContain('## Vault State');
    expect(result).toContain('spores: 10');
    expect(result).toContain('## Task: Full Intelligence');
    expect(result).toContain('Run full intelligence.');
    expect(result).not.toContain('## User Instruction');
  });

  it('appends user instruction when provided', () => {
    const result = composeTaskPrompt(
      '## Vault State',
      'Full Intelligence',
      'Run full intelligence.',
      'Focus on gotchas only.',
    );

    expect(result).toContain('## User Instruction');
    expect(result).toContain('Focus on gotchas only.');
  });
});

// ---------------------------------------------------------------------------
// Tests: composePhasePrompt
// ---------------------------------------------------------------------------

describe('composePhasePrompt', () => {
  const vaultContext = '## Vault State\nspores: 10';
  const taskName = 'Full Intelligence';
  const taskOverview = 'Complete intelligence pipeline.';

  it('composes vault context + task overview + phase prompt', () => {
    const result = composePhasePrompt(
      vaultContext,
      taskName,
      taskOverview,
      { name: 'extract', prompt: 'Extract spores from batches.', tools: [], maxTurns: 5, required: true },
      [],
    );

    expect(result).toContain('## Vault State');
    expect(result).toContain('## Task: Full Intelligence');
    expect(result).toContain('Complete intelligence pipeline.');
    expect(result).toContain('## Current Phase: extract');
    expect(result).toContain('Extract spores from batches.');
    expect(result).not.toContain('## Prior Phase Results');
  });

  it('includes prior phase results when available', () => {
    const result = composePhasePrompt(
      vaultContext,
      taskName,
      taskOverview,
      { name: 'consolidate', prompt: 'Consolidate spores.', tools: [], maxTurns: 5, required: true },
      [
        { name: 'extract', status: 'completed', turnsUsed: 3, tokensUsed: 500, costUsd: 0.001, summary: 'Created 5 spores.' },
        { name: 'summarize', status: 'completed', turnsUsed: 2, tokensUsed: 300, costUsd: 0.0005, summary: 'Updated 2 sessions.' },
      ],
    );

    expect(result).toContain('## Prior Phase Results');
    expect(result).toContain('### extract (completed)');
    expect(result).toContain('Created 5 spores.');
    expect(result).toContain('### summarize (completed)');
    expect(result).toContain('Updated 2 sessions.');
  });

  it('truncates long phase summaries', () => {
    const longSummary = 'A'.repeat(3000);
    const result = composePhasePrompt(
      vaultContext,
      taskName,
      taskOverview,
      { name: 'graph', prompt: 'Build graph.', tools: [], maxTurns: 5, required: true },
      [{ name: 'extract', status: 'completed', turnsUsed: 3, tokensUsed: 500, costUsd: 0.001, summary: longSummary }],
    );

    expect(result).toContain('...');
    expect(result.indexOf(longSummary)).toBe(-1);
  });

  it('includes user instruction when provided', () => {
    const result = composePhasePrompt(
      vaultContext,
      taskName,
      taskOverview,
      { name: 'extract', prompt: 'Extract spores.', tools: [], maxTurns: 5, required: true },
      [],
      'Focus on security issues.',
    );

    expect(result).toContain('## User Instruction');
    expect(result).toContain('Focus on security issues.');
  });
});

// ---------------------------------------------------------------------------
// Tests: runAgent (non-phased, backward compatibility)
// ---------------------------------------------------------------------------

describe('runAgent', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    resetMockState();
    await cleanTestDb();
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

    const run = await getRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.tokens_used).toBe(1850);
    expect(run!.cost_usd).toBe(0.0042);
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
    expect(capturedQueryArgs!.prompt).toContain('## Task: Full Intelligence');
    expect(capturedQueryArgs!.prompt).toContain(TEST_TASK_PROMPT);
    expect(capturedQueryArgs!.options?.systemPrompt).toBe(TEST_SYSTEM_PROMPT);
  });

  it('returns skipped when a run is already active for the agent', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const existingRunId = crypto.randomUUID();
    await insertRun({
      id: existingRunId,
      agent_id: TEST_AGENT_ID,
      status: 'running',
      started_at: epochSeconds(),
    });

    const result = await runAgent(TEST_VAULT_DIR);

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

    const run = await getRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('API rate limit exceeded');
    expect(run!.completed_at).toBeGreaterThan(0);
  });

  it('stores user instruction in run record and prompt', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR, {
      instruction: 'Focus on security observations only.',
    });

    expect(result.status).toBe('completed');

    const run = await getRun(result.runId);
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
    expect(opts.persistSession).toBe(false);
    expect(opts.mcpServers).toBeDefined();
    expect(opts.tools).toEqual([]);
  });

  it('resolves config with agent DB overrides', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const db = getDatabase();
    await db.query(
      `UPDATE agents SET model = $1, max_turns = $2 WHERE id = $3`,
      ['claude-opus-4-20250514', 20, TEST_AGENT_ID],
    );

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
    },
    {
      name: 'report',
      prompt: 'Write final report.',
      tools: ['vault_report'],
      maxTurns: 2,
      required: true,
    },
  ];

  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    resetMockState();
    mockYamlPhases = TEST_PHASES;
    await cleanTestDb();
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

  it('stops pipeline when a required phase fails', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // Phase 1 succeeds, phase 2 (extract, required) fails
    mockQueryBehaviors = ['success', 'error', 'success'];
    mockErrorMessage = 'Model unavailable';

    const result = await runAgent(TEST_VAULT_DIR);

    expect(result.status).toBe('completed'); // run-level status still completed
    expect(result.phases!.length).toBe(2); // stopped after phase 2 failed
    expect(result.phases![0].status).toBe('completed');
    expect(result.phases![1].status).toBe('failed');
    expect(result.phases![1].summary).toContain('Model unavailable');
    // Phase 3 (report) should NOT have run
    expect(allQueryCalls.length).toBe(2);
  });

  it('continues pipeline when an optional phase fails', async () => {
    // Override phases to make the middle one optional
    mockYamlPhases = [
      { name: 'read-state', prompt: 'Read state.', tools: ['vault_state'], maxTurns: 3, required: true },
      { name: 'summarize', prompt: 'Update summaries.', tools: ['vault_sessions'], maxTurns: 5, required: false },
      { name: 'report', prompt: 'Write report.', tools: ['vault_report'], maxTurns: 2, required: true },
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
      { name: 'graph', prompt: 'Build graph.', tools: ['vault_create_entity'], maxTurns: 10, required: true },
    ];

    const { runAgent } = await import('@myco/agent/executor.js');

    await runAgent(TEST_VAULT_DIR);

    expect(allQueryCalls.length).toBe(2);
    // Phase 1 should use the phase-specific model
    expect((allQueryCalls[0].options as Record<string, unknown>).model).toBe('claude-haiku-4-5');
    // Phase 2 should fall back to the task/agent model
    expect((allQueryCalls[1].options as Record<string, unknown>).model).toBe('claude-sonnet-4-20250514');
  });

  it('records correct aggregate tokens and cost', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR);

    // Each phase: 1850 tokens, $0.0042 — 3 phases total
    expect(result.tokensUsed).toBe(5550);
    expect(result.costUsd).toBeCloseTo(0.0126);

    // Verify DB record
    const run = await getRun(result.runId);
    expect(run!.tokens_used).toBe(5550);
    expect(run!.cost_usd).toBeCloseTo(0.0126);
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
    // Orchestrator call uses no mcpServers (planning only)
    const orchestratorCall = allQueryCalls[0];
    expect((orchestratorCall.options as Record<string, unknown>).mcpServers).toBeUndefined();
    expect((orchestratorCall.options as Record<string, unknown>).tools).toEqual([]);
    // All 3 phases should have run
    expect(result.phases!.length).toBe(3);
  });

  it('orchestrator skips non-required phase when directed', async () => {
    // Make middle phase optional so orchestrator can skip it
    mockYamlPhases = [
      { name: 'read-state', prompt: 'Read state.', tools: ['vault_state'], maxTurns: 3, required: true },
      { name: 'summarize', prompt: 'Update summaries.', tools: ['vault_sessions'], maxTurns: 5, required: false },
      { name: 'report', prompt: 'Write report.', tools: ['vault_report'], maxTurns: 2, required: true },
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
});
