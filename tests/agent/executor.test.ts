/**
 * Tests for the curation agent executor.
 *
 * The Agent SDK's `query()` function is mocked via vi.mock() so tests
 * never call the Anthropic API. Each test uses an in-memory PGlite
 * instance with the full schema.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerCurator } from '@myco/db/queries/curators.js';
import { upsertTask } from '@myco/db/queries/tasks.js';
import { insertRun, getRun } from '@myco/db/queries/runs.js';
import { epochSeconds } from '@myco/constants.js';
import { composeTaskPrompt } from '@myco/agent/executor.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_CURATOR_ID = 'myco-curator';
const TEST_VAULT_DIR = '/tmp/test-vault';
const TEST_TASK_NAME = 'full-curation';
const TEST_TASK_PROMPT = 'Curate the vault.';
const TEST_SYSTEM_PROMPT = 'You are a vault curator.';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Mock: Agent SDK query
// ---------------------------------------------------------------------------

/** Captured arguments from the last query() call. */
let capturedQueryArgs: { prompt: string; options?: Record<string, unknown> } | null = null;

/** Controls what the mock query() yields. Set per-test. */
let mockQueryBehavior: 'success' | 'error' | 'empty' = 'success';

/** Custom error message for the 'error' behavior. */
let mockErrorMessage = 'SDK exploded';

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (args: { prompt: string; options?: Record<string, unknown> }) => {
      capturedQueryArgs = args;

      // Return an async generator
      return {
        [Symbol.asyncIterator]: async function* () {
          if (mockQueryBehavior === 'error') {
            throw new Error(mockErrorMessage);
          }

          if (mockQueryBehavior === 'success') {
            // Yield a result message matching SDKResultMessage shape
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
              result: 'Curation complete.',
              stop_reason: 'end_turn',
              modelUsage: {},
              permission_denials: [],
              uuid: '00000000-0000-0000-0000-000000000000',
              session_id: 'test-session',
            };
          }
          // 'empty': yields nothing — for await loop ends without a result
        },
        // Methods on the Query object that we don't use but exist on the type
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
    // Also mock createSdkMcpServer and tool since tools.ts imports them
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

vi.mock('@myco/agent/loader.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@myco/agent/loader.js')>();
  return {
    ...original,
    resolveDefinitionsDir: () => '/mock/definitions',
    loadAgentDefinition: () => ({
      name: 'myco-curator',
      displayName: 'Myco Curator',
      description: 'Built-in curator',
      model: 'claude-sonnet-4-20250514',
      maxTurns: 10,
      timeoutSeconds: 300,
      systemPromptPath: 'prompts/system.md',
      tools: ['vault_unprocessed', 'vault_create_spore'],
    }),
    loadSystemPrompt: () => TEST_SYSTEM_PROMPT,
    // Keep resolveEffectiveConfig from the original module
  };
});

// ---------------------------------------------------------------------------
// Mock: context (avoid DB queries in buildVaultContext since we test it separately)
// ---------------------------------------------------------------------------

vi.mock('@myco/agent/context.js', () => ({
  buildVaultContext: async () => '## Current Vault State\ncurator_id: myco-curator\nunprocessed_batches: 5',
}));

// ---------------------------------------------------------------------------
// Mock: tools (avoid importing real Agent SDK tool/createSdkMcpServer at module level)
// ---------------------------------------------------------------------------

vi.mock('@myco/agent/tools.js', () => ({
  createVaultToolServer: (_curatorId: string, _runId: string) => ({
    type: 'sdk' as const,
    name: 'myco-vault',
    instance: {},
  }),
}));

// ---------------------------------------------------------------------------
// Mock: initDatabaseForVault (we manage DB ourselves in tests)
// ---------------------------------------------------------------------------

vi.mock('@myco/db/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@myco/db/client.js')>();
  return {
    ...original,
    // Override initDatabaseForVault to be a no-op (DB is already initialized in beforeEach)
    initDatabaseForVault: async () => original.getDatabase(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a curator directly for test setup. */
async function createTestCurator(id: string): Promise<void> {
  const now = epochNow();
  await registerCurator({
    id,
    name: `curator-${id}`,
    created_at: now,
    updated_at: now,
  });
}

/** Insert a default task for the test curator. */
async function createTestTask(): Promise<void> {
  const now = epochNow();
  await upsertTask({
    id: TEST_TASK_NAME,
    curator_id: TEST_CURATOR_ID,
    prompt: TEST_TASK_PROMPT,
    display_name: 'Full Curation',
    description: 'Run full curation pipeline',
    is_default: 1,
    created_at: now,
    updated_at: now,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('composeTaskPrompt', () => {
  it('composes vault context + task without instruction', () => {
    const result = composeTaskPrompt(
      '## Vault State\nspores: 10',
      'Full Curation',
      'Curate everything.',
    );

    expect(result).toContain('## Vault State');
    expect(result).toContain('spores: 10');
    expect(result).toContain('## Task: Full Curation');
    expect(result).toContain('Curate everything.');
    expect(result).not.toContain('## User Instruction');
  });

  it('appends user instruction when provided', () => {
    const result = composeTaskPrompt(
      '## Vault State',
      'Full Curation',
      'Curate everything.',
      'Focus on gotchas only.',
    );

    expect(result).toContain('## User Instruction');
    expect(result).toContain('Focus on gotchas only.');
  });
});

describe('runCurationAgent', () => {
  beforeEach(async () => {
    capturedQueryArgs = null;
    mockQueryBehavior = 'success';
    mockErrorMessage = 'SDK exploded';

    const db = await initDatabase(); // in-memory
    await createSchema(db);
    await createTestCurator(TEST_CURATOR_ID);
    await createTestTask();
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('completes a successful run with cost and token tracking', async () => {
    // Dynamic import to get the version with mocks applied
    const { runCurationAgent } = await import('@myco/agent/executor.js');

    const result = await runCurationAgent(TEST_VAULT_DIR);

    expect(result.status).toBe('completed');
    expect(result.runId).toBeDefined();
    expect(result.tokensUsed).toBe(1850); // 1500 + 350
    expect(result.costUsd).toBe(0.0042);

    // Verify run record in DB
    const run = await getRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.tokens_used).toBe(1850);
    expect(run!.cost_usd).toBe(0.0042);
    expect(run!.task).toBe(TEST_TASK_NAME);
    expect(run!.curator_id).toBe(TEST_CURATOR_ID);
    expect(run!.started_at).toBeGreaterThan(0);
    expect(run!.completed_at).toBeGreaterThan(0);
  });

  it('passes system prompt and composed task prompt to the SDK', async () => {
    const { runCurationAgent } = await import('@myco/agent/executor.js');

    await runCurationAgent(TEST_VAULT_DIR);

    expect(capturedQueryArgs).not.toBeNull();
    expect(capturedQueryArgs!.prompt).toContain('## Current Vault State');
    expect(capturedQueryArgs!.prompt).toContain('## Task: Full Curation');
    expect(capturedQueryArgs!.prompt).toContain(TEST_TASK_PROMPT);
    expect(capturedQueryArgs!.options?.systemPrompt).toBe(TEST_SYSTEM_PROMPT);
  });

  it('returns skipped when a run is already active for the curator', async () => {
    const { runCurationAgent } = await import('@myco/agent/executor.js');

    // Insert a running run for the same curator
    const existingRunId = crypto.randomUUID();
    await insertRun({
      id: existingRunId,
      curator_id: TEST_CURATOR_ID,
      status: 'running',
      started_at: epochSeconds(),
    });

    const result = await runCurationAgent(TEST_VAULT_DIR);

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('already_running');
    expect(result.runId).toBe(existingRunId);
    // query() should NOT have been called
    expect(capturedQueryArgs).toBeNull();
  });

  it('marks run as failed on SDK error', async () => {
    const { runCurationAgent } = await import('@myco/agent/executor.js');

    mockQueryBehavior = 'error';
    mockErrorMessage = 'API rate limit exceeded';

    const result = await runCurationAgent(TEST_VAULT_DIR);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('API rate limit exceeded');
    expect(result.runId).toBeDefined();

    // Verify run record in DB
    const run = await getRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('failed');
    expect(run!.error).toBe('API rate limit exceeded');
    expect(run!.completed_at).toBeGreaterThan(0);
  });

  it('stores user instruction in run record and prompt', async () => {
    const { runCurationAgent } = await import('@myco/agent/executor.js');

    const result = await runCurationAgent(TEST_VAULT_DIR, {
      instruction: 'Focus on security observations only.',
    });

    expect(result.status).toBe('completed');

    // Verify instruction in run record
    const run = await getRun(result.runId);
    expect(run!.instruction).toBe('Focus on security observations only.');

    // Verify instruction appears in the composed prompt
    expect(capturedQueryArgs!.prompt).toContain('## User Instruction');
    expect(capturedQueryArgs!.prompt).toContain('Focus on security observations only.');
  });

  it('uses correct SDK options (model, maxTurns, tools, permissions)', async () => {
    const { runCurationAgent } = await import('@myco/agent/executor.js');

    await runCurationAgent(TEST_VAULT_DIR);

    expect(capturedQueryArgs).not.toBeNull();
    const opts = capturedQueryArgs!.options as Record<string, unknown>;
    expect(opts.model).toBe('claude-sonnet-4-20250514');
    expect(opts.maxTurns).toBe(10);
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.persistSession).toBe(false);
    expect(opts.mcpServers).toBeDefined();
    // Tools should be empty array (all tools come from MCP server)
    expect(opts.tools).toEqual([]);
  });

  it('resolves config with curator DB overrides', async () => {
    const { runCurationAgent } = await import('@myco/agent/executor.js');

    // Update the curator with a different model
    const db = getDatabase();
    await db.query(
      `UPDATE curators SET model = $1, max_turns = $2 WHERE id = $3`,
      ['claude-opus-4-20250514', 20, TEST_CURATOR_ID],
    );

    await runCurationAgent(TEST_VAULT_DIR);

    const opts = capturedQueryArgs!.options as Record<string, unknown>;
    expect(opts.model).toBe('claude-opus-4-20250514');
    expect(opts.maxTurns).toBe(20);
  });
});
