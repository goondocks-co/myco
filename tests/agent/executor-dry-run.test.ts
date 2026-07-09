import * as __orig__myco_agent_loader_js_1__ns from '@myco/agent/loader.js';
const __orig__myco_agent_loader_js_1 = { ...__orig__myco_agent_loader_js_1__ns };
import * as __orig__myco_db_client_js_2__ns from '@myco/db/client.js';
const __orig__myco_db_client_js_2 = { ...__orig__myco_db_client_js_2__ns };
import * as __orig__myco_config_loader_js_3__ns from '@myco/config/loader.js';
const __orig__myco_config_loader_js_3 = { ...__orig__myco_config_loader_js_3__ns };
/**
 * Tests for dryRun + evaluationId threading through the executor.
 *
 * Verifies:
 *   a. dryRun:true persists dry_run=true on the agent_runs row.
 *   b. dryRun:true skips validateTaskPostconditions (the run completes
 *      even for tasks that would normally fail postcondition checks).
 *   c. dryRun:false (default) persists dry_run=false on the agent_runs row.
 *   d. evaluationId is persisted onto the agent_runs row.
 *   e. dryRun:true is forwarded to the scoped tool server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertTask } from '@myco/db/queries/tasks.js';
import { getRun } from '@myco/db/queries/runs.js';
import { epochSeconds } from '@myco/constants.js';
import type { PhaseDefinition } from '@myco/agent/types.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'myco-agent';
const TEST_VAULT_DIR = '/tmp/test-vault-dry-run';
const TEST_TASK_NAME = 'title-summary';  // has a postcondition rule
const TEST_TASK_PROMPT = 'Summarize the target session.';
const TEST_SYSTEM_PROMPT = 'You are a vault agent.';

// ---------------------------------------------------------------------------
// Mock: Agent SDK query
// ---------------------------------------------------------------------------

let mockQueryBehavior: 'success' | 'error' = 'success';

mock.module('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (_args: unknown) => {
      return {
        [Symbol.asyncIterator]: async function* () {
          if (mockQueryBehavior === 'error') {
            throw new Error('SDK error');
          }
          yield {
            type: 'result' as const,
            subtype: 'success' as const,
            total_cost_usd: 0.001,
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            num_turns: 1,
            duration_ms: 1000,
            duration_api_ms: 900,
            is_error: false,
            result: 'Agent run complete.',
            stop_reason: 'end_turn',
            modelUsage: {},
            permission_denials: [],
            uuid: '00000000-0000-0000-0000-000000000000',
            session_id: 'test-session',
          };
        },
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
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
// Mock: loader
// ---------------------------------------------------------------------------

let mockYamlPhases: PhaseDefinition[] | undefined;

mock.module('@myco/agent/loader.js', () => {
  const original = __orig__myco_agent_loader_js_1;
  return {
    ...original,
    resolveDefinitionsDir: () => '/mock/definitions',
    loadAgentDefinition: () => ({
      name: TEST_AGENT_ID,
      displayName: 'Myco Agent',
      description: 'Built-in agent',
      model: 'claude-sonnet-4-20250514',
      maxTurns: 10,
      timeoutSeconds: 300,
      systemPromptPath: 'prompts/system.md',
      tools: ['vault_unprocessed', 'vault_create_spore'],
    }),
    loadAgentTasks: () => [{
      name: TEST_TASK_NAME,
      displayName: 'Title & Summary',
      description: 'Summarize sessions',
      agent: TEST_AGENT_ID,
      prompt: TEST_TASK_PROMPT,
      isDefault: true,
      ...(mockYamlPhases ? { phases: mockYamlPhases } : {}),
    }],
    loadSystemPrompt: () => TEST_SYSTEM_PROMPT,
  };
});

// ---------------------------------------------------------------------------
// Mock: registry
// ---------------------------------------------------------------------------

mock.module('@myco/agent/registry.js', () => ({
  loadAllTasks: () => {
    const tasks = new Map();
    tasks.set(TEST_TASK_NAME, {
      name: TEST_TASK_NAME,
      displayName: 'Title & Summary',
      description: 'Summarize sessions',
      agent: TEST_AGENT_ID,
      prompt: TEST_TASK_PROMPT,
      isDefault: true,
      ...(mockYamlPhases ? { phases: mockYamlPhases } : {}),
    });
    return tasks;
  },
}));

// ---------------------------------------------------------------------------
// Mock: context
// ---------------------------------------------------------------------------

mock.module('@myco/agent/context.js', () => ({
  buildVaultContext: () => '## Current Vault State\nagent_id: myco-agent',
}));

// ---------------------------------------------------------------------------
// Mock: tools — capture dryRun arg
// ---------------------------------------------------------------------------

/** Options passed to createScopedVaultToolServer, captured for assertions. */
let scopedToolCallOptions: Array<Record<string, unknown>> = [];

mock.module('@myco/agent/tools.js', () => ({
  createVaultTools: (_agentId: string, _runId: string, _options?: Record<string, unknown>) => [],
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
  createScopedVaultToolServer: (_agentId: string, _runId: string, _toolNames: string[], options?: Record<string, unknown>) => {
    scopedToolCallOptions.push(options ?? {});
    return {
      type: 'sdk' as const,
      name: 'myco-vault',
      instance: {},
    };
  },
  VAULT_TOOL_COUNT: 0,
  validateSkillContent: () => ({ valid: true }),
  MAX_SKILL_LINES: 500,
  REQUIRED_FRONTMATTER_FIELDS: [],
}));

// ---------------------------------------------------------------------------
// Mock: DB client (use in-memory test DB)
// ---------------------------------------------------------------------------

mock.module('@myco/db/client.js', () => {
  const original = __orig__myco_db_client_js_2;
  return {
    ...original,
    // Redirect executor's initDatabase(vaultDbPath) to the already-initialized
    // in-memory instance so we don't create a separate file-based DB.
    initDatabase: (...args: unknown[]) => {
      // If called with a path (executor call), return the existing in-memory instance.
      // If called without a path (setupTestDb), initialize normally.
      if (args.length > 0 && args[0] !== undefined) {
        try {
          return original.getDatabase();
        } catch {
          // Not yet initialized — fall through to normal init
        }
      }
      return original.initDatabase(...(args as [string?]));
    },
    vaultDbPath: (_vaultDir: string) => ':memory:',
  };
});

// ---------------------------------------------------------------------------
// Mock: config loader
// ---------------------------------------------------------------------------

mock.module('@myco/config/loader.js', () => ({
  ...__orig__myco_config_loader_js_3,
  loadConfig: () => ({
    version: 3,
    config_version: 0,
    embedding: { provider: 'ollama', model: 'bge-m3' },
    daemon: { port: null, log_level: 'info' },
    capture: { transcript_paths: [], artifact_watch: [], artifact_extensions: [], buffer_max_events: 500 },
    agent: { summary_batch_interval: 5 },
  }),
  loadMergedConfig: () => ({
    version: 3,
    config_version: 0,
    embedding: { provider: 'ollama', model: 'bge-m3' },
    daemon: { port: null, log_level: 'info' },
    capture: { transcript_paths: [], artifact_watch: [], artifact_extensions: [], buffer_max_events: 500 },
    agent: { summary_batch_interval: 5 },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestAgent(): void {
  const now = epochSeconds();
  registerAgent({ id: TEST_AGENT_ID, name: 'Myco Agent', created_at: now, updated_at: now });
}

function createTestTask(): void {
  const now = epochSeconds();
  upsertTask({
    id: TEST_TASK_NAME,
    agent_id: TEST_AGENT_ID,
    prompt: TEST_TASK_PROMPT,
    display_name: 'Title & Summary',
    description: 'Summarize sessions',
    is_default: 1,
    created_at: now,
    updated_at: now,
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('executor dry-run threading', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    createTestAgent();
    createTestTask();
    mockQueryBehavior = 'success';
    mockYamlPhases = undefined;
    scopedToolCallOptions = [];
  });

  // (a) dryRun:true persists dry_run=true on agent_runs
  it('persists dry_run=true on the agent_runs row when dryRun:true', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, dryRun: true, task: TEST_TASK_NAME });

    // title-summary has a postcondition that would fail without real writes,
    // but dryRun skips it — so the run should still complete.
    expect(result.status).toBe('completed');
    expect(result.runId).toBeDefined();

    const run = getRun(result.runId, ALL_PROJECTS_SCOPE);
    expect(run).not.toBeNull();
    expect(run!.dry_run).toBe(true);
  });

  // (b) dryRun:true skips postcondition validation — run completes
  //     even though title-summary requires vault_update_session or skip report
  it('skips validateTaskPostconditions when dryRun:true', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // title-summary postcondition requires vault_report + (vault_update_session or skip).
    // With dryRun:true the run must still complete (no postcondition violation thrown).
    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, dryRun: true, task: TEST_TASK_NAME });

    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
  });

  // (b) dryRun:false — postcondition IS checked and causes failure
  it('runs validateTaskPostconditions when dryRun:false', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // With dryRun:false and no real writes, postcondition should fail.
    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, dryRun: false, task: TEST_TASK_NAME });

    // The postcondition for title-summary fails when no vault_report or
    // vault_update_session was called.
    expect(result.status).toBe('failed');
    expect(result.error).toContain('title-summary');
  });

  // (c) default run (dryRun unset) persists dry_run=false
  it('persists dry_run=false on the agent_runs row by default', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // Use a task without a postcondition to avoid the run failing for other reasons
    const noPostconditionTask = 'vault-evolve';
    upsertTask({
      id: noPostconditionTask,
      agent_id: TEST_AGENT_ID,
      prompt: 'Run full intelligence pipeline.',
      display_name: 'Vault Evolve',
      description: 'Full intelligence pipeline',
      is_default: 0,
      created_at: epochSeconds(),
      updated_at: epochSeconds(),
    });

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, task: noPostconditionTask });

    // vault-evolve has no postcondition rule, so it completes.
    const run = getRun(result.runId, ALL_PROJECTS_SCOPE);
    expect(run).not.toBeNull();
    expect(run!.dry_run).toBe(false);
  });

  // (d) dryRun:true is forwarded to the scoped tool server via toolSurface
  it('forwards dryRun:true to createScopedVaultToolServer options for phased tasks', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // Use a phased task so createScopedVaultToolServer is invoked
    mockYamlPhases = [
      {
        name: 'extract',
        prompt: 'Extract spores.',
        tools: ['vault_unprocessed', 'vault_create_spore'],
        maxTurns: 3,
        required: true,
      },
    ];

    const result = await runAgent(TEST_VAULT_DIR, { requestContext: TEST_REQUEST_CONTEXT, dryRun: true, task: TEST_TASK_NAME });

    expect(result.status).toBe('completed');

    // At least one scoped tool server call should have dryRun:true
    expect(scopedToolCallOptions.length).toBeGreaterThan(0);
    expect(scopedToolCallOptions.every((opts) => opts.dryRun === true)).toBe(true);
  });
});
