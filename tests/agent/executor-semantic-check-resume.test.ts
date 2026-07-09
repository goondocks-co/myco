import * as __orig__myco_agent_loader_js_1__ns from '@myco/agent/loader.js';
const __orig__myco_agent_loader_js_1 = { ...__orig__myco_agent_loader_js_1__ns };
import * as __orig__myco_db_client_js_2__ns from '@myco/db/client.js';
const __orig__myco_db_client_js_2 = { ...__orig__myco_db_client_js_2__ns };
import * as __orig__myco_config_loader_js_3__ns from '@myco/config/loader.js';
const __orig__myco_config_loader_js_3 = { ...__orig__myco_config_loader_js_3__ns };
/**
 * Regression test for the config-snapshot bug class this task exists to
 * close: `agent.semantic_write_check_enabled` must be resolved ONCE at
 * dispatch time and snapshotted onto `agent_runs.execution_overrides`, so a
 * resumed run reflects the ORIGINAL dispatch's value even if myco.yaml
 * changes in between. Mirrors `executor-dry-run.test.ts` (module mocking
 * shape) and the RC-9 resume-restoration tests in `executor.test.ts`
 * (mutable `mockMergedConfig` flipped between dispatch and resume).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertTask } from '@myco/db/queries/tasks.js';
import { getRun } from '@myco/db/queries/runs.js';
import { epochSeconds } from '@myco/constants.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'myco-agent';
const TEST_VAULT_DIR = '/tmp/test-vault-semantic-check-resume';
const TEST_TASK_NAME = 'vault-evolve'; // no postcondition rule — completes cleanly
const TEST_TASK_PROMPT = 'Run full intelligence pipeline.';
const TEST_SYSTEM_PROMPT = 'You are a vault agent.';

// ---------------------------------------------------------------------------
// Mock: Agent SDK query
// ---------------------------------------------------------------------------

mock.module('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (_args: unknown) => {
      return {
        [Symbol.asyncIterator]: async function* () {
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
      displayName: 'Vault Evolve',
      description: 'Run full intelligence pipeline',
      agent: TEST_AGENT_ID,
      prompt: TEST_TASK_PROMPT,
      isDefault: true,
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
      displayName: 'Vault Evolve',
      description: 'Run full intelligence pipeline',
      agent: TEST_AGENT_ID,
      prompt: TEST_TASK_PROMPT,
      isDefault: true,
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
// Mock: tools
// ---------------------------------------------------------------------------

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
  createScopedVaultToolServer: (_agentId: string, _runId: string, _toolNames: string[], _options?: Record<string, unknown>) => ({
    type: 'sdk' as const,
    name: 'myco-vault',
    instance: {},
  }),
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
    initDatabase: (...args: unknown[]) => {
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
// Mock: config loader — mutable so a test can flip the global flag between
// dispatch and resume, mirroring the RC-9 `mockMergedConfig` pattern in
// executor.test.ts.
// ---------------------------------------------------------------------------

let mockMergedConfig: any = {
  version: 3,
  config_version: 0,
  embedding: { provider: 'ollama', model: 'bge-m3' },
  daemon: { port: null, log_level: 'info' },
  capture: { transcript_paths: [], artifact_watch: [], artifact_extensions: [], buffer_max_events: 500 },
  agent: { summary_batch_interval: 5, semantic_write_check_enabled: false },
};

mock.module('@myco/config/loader.js', () => ({
  ...__orig__myco_config_loader_js_3,
  loadConfig: () => mockMergedConfig,
  loadMergedConfig: () => mockMergedConfig,
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
    display_name: 'Vault Evolve',
    description: 'Run full intelligence pipeline',
    is_default: 1,
    created_at: now,
    updated_at: now,
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('semantic_write_check_enabled survives resume even if myco.yaml changes in between', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  beforeEach(() => {
    cleanTestDb();
    createTestAgent();
    createTestTask();
    mockMergedConfig = {
      version: 3,
      config_version: 0,
      embedding: { provider: 'ollama', model: 'bge-m3' },
      daemon: { port: null, log_level: 'info' },
      capture: { transcript_paths: [], artifact_watch: [], artifact_extensions: [], buffer_max_events: 500 },
      agent: { summary_batch_interval: 5, semantic_write_check_enabled: false },
    };
  });

  it('snapshots the flag ON at dispatch and keeps it ON across resume after the config flips OFF', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // Dispatch with the flag ON via the (mocked) merged myco.yaml config.
    mockMergedConfig = {
      ...mockMergedConfig,
      agent: { ...mockMergedConfig.agent, semantic_write_check_enabled: true },
    };

    const firstResult = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      task: TEST_TASK_NAME,
    });
    expect(firstResult.status).toBe('completed');

    const runRow = getRun(firstResult.runId, ALL_PROJECTS_SCOPE);
    expect(runRow).not.toBeNull();
    expect(runRow!.execution_overrides).toBeTruthy();
    expect(runRow!.execution_overrides!.semanticWriteCheckEnabled).toBe(true);

    // Flip the GLOBAL config to the opposite value — simulating an operator
    // editing myco.yaml while the run is between phases (e.g. after a crash
    // or a scheduler-driven resume).
    mockMergedConfig = {
      ...mockMergedConfig,
      agent: { ...mockMergedConfig.agent, semantic_write_check_enabled: false },
    };

    // Mark the run resumable so runAgent's resume path restores from it
    // rather than treating this as a duplicate concurrent run.
    const { applyRunUpdate } = await import('@myco/db/queries/runs.js');
    applyRunUpdate(firstResult.runId, { status: 'failed', resumable: 1, resume_status: 'ready' }, ALL_PROJECTS_SCOPE);

    // Resume WITHOUT an explicit executionOverrides override — the resumed
    // run must still see semanticWriteCheckEnabled: true from the ORIGINAL
    // dispatch, not false from the just-flipped config.
    const resumedResult = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      resumeRunId: firstResult.runId,
      resumeMode: 'scheduled',
    });
    expect(resumedResult.status).toBe('completed');

    const resumedRow = getRun(firstResult.runId, ALL_PROJECTS_SCOPE);
    expect(resumedRow!.execution_overrides!.semanticWriteCheckEnabled).toBe(true);
  });

  it('snapshots the flag OFF (default) at dispatch when myco.yaml has it off', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      task: TEST_TASK_NAME,
    });
    expect(result.status).toBe('completed');

    const runRow = getRun(result.runId, ALL_PROJECTS_SCOPE);
    expect(runRow!.execution_overrides!.semanticWriteCheckEnabled).toBe(false);
  });

  it('caller-supplied executionOverrides.semanticWriteCheckEnabled wins over the config default', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // Config default is OFF, but the caller explicitly asks for ON.
    const result = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      task: TEST_TASK_NAME,
      executionOverrides: { semanticWriteCheckEnabled: true },
    });
    expect(result.status).toBe('completed');

    const runRow = getRun(result.runId, ALL_PROJECTS_SCOPE);
    expect(runRow!.execution_overrides!.semanticWriteCheckEnabled).toBe(true);
  });

  it('snapshots the flag OFF at dispatch and keeps it OFF across resume after the config flips ON', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // Dispatch with the flag OFF via the default (mocked) merged myco.yaml config.
    // mockMergedConfig already has semantic_write_check_enabled: false from beforeEach.
    const firstResult = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      task: TEST_TASK_NAME,
    });
    expect(firstResult.status).toBe('completed');

    const runRow = getRun(firstResult.runId, ALL_PROJECTS_SCOPE);
    expect(runRow).not.toBeNull();
    expect(runRow!.execution_overrides).toBeTruthy();
    expect(runRow!.execution_overrides!.semanticWriteCheckEnabled).toBe(false);

    // Flip the GLOBAL config to the opposite value — simulating an operator
    // editing myco.yaml while the run is between phases (e.g. after a crash
    // or a scheduler-driven resume).
    mockMergedConfig = {
      ...mockMergedConfig,
      agent: { ...mockMergedConfig.agent, semantic_write_check_enabled: true },
    };

    // Mark the run resumable so runAgent's resume path restores from it
    // rather than treating this as a duplicate concurrent run.
    const { applyRunUpdate } = await import('@myco/db/queries/runs.js');
    applyRunUpdate(firstResult.runId, { status: 'failed', resumable: 1, resume_status: 'ready' }, ALL_PROJECTS_SCOPE);

    // Resume WITHOUT an explicit executionOverrides override — the resumed
    // run must still see semanticWriteCheckEnabled: false from the ORIGINAL
    // dispatch, not true from the just-flipped config.
    const resumedResult = await runAgent(TEST_VAULT_DIR, {
      requestContext: TEST_REQUEST_CONTEXT,
      resumeRunId: firstResult.runId,
      resumeMode: 'scheduled',
    });
    expect(resumedResult.status).toBe('completed');

    const resumedRow = getRun(firstResult.runId, ALL_PROJECTS_SCOPE);
    expect(resumedRow!.execution_overrides!.semanticWriteCheckEnabled).toBe(false);
  });
});
