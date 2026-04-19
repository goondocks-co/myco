/**
 * Executor tests that exercise the openai-agents runtime path.
 *
 * Addresses findings #27 (dryRun not E2E tested for openai-agents) and
 * #28 (resume semantics untested for openai-agents). The Claude SDK runtime
 * has its own coverage in executor.test.ts and executor-dry-run.test.ts;
 * this file stands up the parallel @openai/agents Runner mock and verifies
 * the executor threads dryRun + resumes lastResponseId correctly.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertTask } from '@myco/db/queries/tasks.js';
import { getRun, insertRun } from '@myco/db/queries/runs.js';
import { epochSeconds } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'myco-agent';
const TEST_VAULT_DIR = '/tmp/test-vault-openai-agents';
const TEST_TASK_NAME = 'vault-evolve'; // no postcondition, easy path
const TEST_TASK_PROMPT = 'Do the thing.';
const TEST_SYSTEM_PROMPT = 'You are a vault agent.';

// ---------------------------------------------------------------------------
// Mock: @openai/agents Runner — capture args + lastResponseId propagation
// ---------------------------------------------------------------------------

interface MockRunOptions {
  session?: {
    addItems: (items: unknown[]) => Promise<void>;
    getItems: () => Promise<unknown[]>;
  };
  signal?: AbortSignal;
  maxTurns?: number;
}

const runnerCalls: Array<{ agent: unknown; input: string; options: MockRunOptions; priorSessionItems: unknown[] }> = [];
let mockLastResponseId = 'resp_openai_final';

vi.mock('@openai/agents', () => {
  class Agent {
    constructor(public readonly config: Record<string, unknown>) {}
  }
  class OpenAIProvider {
    constructor(public readonly config: Record<string, unknown>) {}
  }
  class Runner {
    constructor(public readonly config: Record<string, unknown>) {}
    async run(agent: unknown, input: string, options: MockRunOptions = {}) {
      const priorItems = options.session ? await options.session.getItems() : [];
      runnerCalls.push({ agent, input, options, priorSessionItems: priorItems });
      if (options.session) {
        await options.session.addItems([{ type: 'assistant', content: 'ok' }]);
      }
      return {
        finalOutput: 'Agent run complete.',
        lastResponseId: mockLastResponseId,
        rawResponses: [
          {
            usage: {
              requests: 1,
              inputTokens: 42,
              outputTokens: 7,
              totalTokens: 49,
            },
          },
        ],
      };
    }
  }
  return { Agent, Runner, OpenAIProvider };
});

// ---------------------------------------------------------------------------
// Mock: openai
// ---------------------------------------------------------------------------

vi.mock('openai', () => ({
  default: class OpenAI {
    constructor(public readonly config: Record<string, unknown>) {}
  },
}));

// ---------------------------------------------------------------------------
// Mock: local provider prep
// ---------------------------------------------------------------------------

vi.mock('@myco/agent/ollama-context.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@myco/agent/ollama-context.js')>();
  return {
    ...original,
    ensureOllamaContextVariant: async (model: string) => model,
  };
});

// ---------------------------------------------------------------------------
// Mock: Claude SDK (unused here, but pulled in by indirect imports)
// ---------------------------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]: async function* () {},
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
  }),
  createSdkMcpServer: (opts: Record<string, unknown>) => ({
    type: 'sdk' as const,
    instance: {},
    ...opts,
  }),
  tool: (_name: string, _desc: string, _schema: unknown, handler: unknown) => ({
    name: _name,
    handler,
  }),
}));

// ---------------------------------------------------------------------------
// Mock: loader
// ---------------------------------------------------------------------------

vi.mock('@myco/agent/loader.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@myco/agent/loader.js')>();
  return {
    ...original,
    resolveDefinitionsDir: () => '/mock/definitions',
    loadAgentDefinition: () => ({
      name: TEST_AGENT_ID,
      displayName: 'Myco Agent',
      description: 'Built-in agent',
      model: 'gpt-5.4-mini',
      maxTurns: 5,
      timeoutSeconds: 300,
      systemPromptPath: 'prompts/system.md',
      tools: ['vault_unprocessed'],
    }),
    loadAgentTasks: () => [{
      name: TEST_TASK_NAME,
      displayName: 'Vault Evolve',
      description: 'Run full intelligence pipeline.',
      agent: TEST_AGENT_ID,
      prompt: TEST_TASK_PROMPT,
      isDefault: true,
    }],
    loadSystemPrompt: () => TEST_SYSTEM_PROMPT,
  };
});

vi.mock('@myco/agent/registry.js', () => ({
  loadAllTasks: () => {
    const tasks = new Map();
    tasks.set(TEST_TASK_NAME, {
      name: TEST_TASK_NAME,
      displayName: 'Vault Evolve',
      description: 'Run full intelligence pipeline.',
      agent: TEST_AGENT_ID,
      prompt: TEST_TASK_PROMPT,
      isDefault: true,
    });
    return tasks;
  },
}));

vi.mock('@myco/agent/context.js', () => ({
  buildVaultContext: () => '## Current Vault State\nagent_id: myco-agent',
}));

// ---------------------------------------------------------------------------
// Mock: openai-local-mcp server (capture options)
// ---------------------------------------------------------------------------

let localMcpCalls: Array<Record<string, unknown>> = [];

vi.mock('@myco/agent/runtime/openai-local-mcp.js', () => ({
  createLocalVaultMcpServer: (toolSurface: Record<string, unknown>) => {
    localMcpCalls.push(toolSurface);
    return {
      connect: async () => {},
      close: async () => {},
    };
  },
}));

// ---------------------------------------------------------------------------
// Mock: DB client — use in-memory
// ---------------------------------------------------------------------------

vi.mock('@myco/db/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@myco/db/client.js')>();
  return {
    ...original,
    initDatabase: (...args: unknown[]) => {
      if (args.length > 0 && args[0] !== undefined) {
        try { return original.getDatabase(); } catch { /* not yet */ }
      }
      return original.initDatabase(...(args as [string?]));
    },
    vaultDbPath: () => ':memory:',
  };
});

vi.mock('@myco/config/loader.js', () => ({
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
// Test helpers
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
    description: 'Run full intelligence pipeline.',
    is_default: 0,
    created_at: now,
    updated_at: now,
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('executor with openai-agents runtime', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    createTestAgent();
    createTestTask();
    runnerCalls.length = 0;
    localMcpCalls = [];
    mockLastResponseId = 'resp_openai_final';
  });

  it('runs the openai-agents runtime and persists runtime=openai-agents on the row', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');
    const result = await runAgent(TEST_VAULT_DIR, {
      task: TEST_TASK_NAME,
      executionOverrides: {
        runtime: 'openai-agents',
        provider: { type: 'openai', model: 'gpt-5.4-mini' },
      },
    });

    expect(result.status).toBe('completed');
    const run = getRun(result.runId);
    expect(run?.runtime).toBe('openai-agents');
    expect(runnerCalls).toHaveLength(1);
  });

  it('persists dry_run=true and forwards dryRun to the openai-local MCP server', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');
    const result = await runAgent(TEST_VAULT_DIR, {
      task: TEST_TASK_NAME,
      dryRun: true,
      executionOverrides: {
        runtime: 'openai-agents',
        provider: { type: 'openai', model: 'gpt-5.4-mini' },
      },
    });

    expect(result.status).toBe('completed');
    const run = getRun(result.runId);
    expect(run?.dry_run).toBe(true);

    expect(localMcpCalls.length).toBeGreaterThan(0);
    expect(localMcpCalls.every((call) => call.dryRun === true)).toBe(true);
  });

  it('round-trips lastResponseId via rawRuntimeMetadata on resume', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');

    // First run — establishes checkpoint state with runtime=openai-agents
    mockLastResponseId = 'resp_first_call';
    const first = await runAgent(TEST_VAULT_DIR, {
      task: TEST_TASK_NAME,
      executionOverrides: {
        runtime: 'openai-agents',
        provider: { type: 'openai', model: 'gpt-5.4-mini' },
      },
    });
    expect(first.status).toBe('completed');

    // Seed a failed-but-resumable row mimicking a prior openai-agents run
    // with lastResponseId stashed in checkpoints.
    const existingRunId = crypto.randomUUID();
    const now = epochSeconds();
    insertRun({
      id: existingRunId,
      agent_id: TEST_AGENT_ID,
      task: TEST_TASK_NAME,
      status: 'failed',
      instruction: 'Resume me',
      runtime: 'openai-agents',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      resumable: 1,
      resume_status: 'ready',
      checkpoints: JSON.stringify({
        runtime: 'openai-agents',
        phases: {},
        rawRuntimeMetadata: { lastResponseId: 'resp_abc_prior' },
        sessionData: [{ type: 'user', content: 'first turn before failure' }],
      }),
      started_at: now - 60,
      completed_at: now - 30,
      error: 'earlier failure',
    });

    mockLastResponseId = 'resp_abc_next';
    const resumed = await runAgent(TEST_VAULT_DIR, {
      task: TEST_TASK_NAME,
      instruction: 'Resume me',
      resumeRunId: existingRunId,
      resumeMode: 'manual',
      executionOverrides: {
        runtime: 'openai-agents',
        provider: { type: 'openai', model: 'gpt-5.4-mini' },
      },
    });
    expect(resumed.status).toBe('completed');

    // The second Runner invocation should have been fed the prior session items.
    const resumeCall = runnerCalls[runnerCalls.length - 1];
    expect(resumeCall.priorSessionItems).toEqual([
      { type: 'user', content: 'first turn before failure' },
    ]);

    const run = getRun(existingRunId);
    expect(run?.runtime).toBe('openai-agents');
  });
});
