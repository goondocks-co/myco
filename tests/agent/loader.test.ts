/**
 * Tests for agent definition and task YAML loader.
 *
 * Tests cover:
 * - Loading the built-in agent definition from agent.yaml
 * - Loading all task YAML files from tasks/
 * - Merging definitions with DB overrides via resolveEffectiveConfig
 * - Registering built-in agents and tasks into PGlite
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getAgent } from '@myco/db/queries/agents.js';
import { listTasks, getDefaultTask } from '@myco/db/queries/tasks.js';
import {
  loadAgentDefinition,
  loadAgentTasks,
  loadSystemPrompt,
  resolveEffectiveConfig,
  registerBuiltInAgentsAndTasks,
} from '@myco/agent/loader.js';
import type { AgentRow } from '@myco/db/queries/agents.js';
import type { AgentDefinition, AgentTask } from '@myco/agent/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of built-in task YAML files. */
const EXPECTED_TASK_COUNT = 7;

/** Built-in agent name from agent.yaml. */
const BUILT_IN_AGENT_NAME = 'myco-agent';

/** Resolve the test definitions directory (src/agent/definitions/). */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFINITIONS_DIR = path.resolve(__dirname, '..', '..', 'src', 'agent', 'definitions');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AgentDefinition for testing. */
function makeDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'myco-agent',
    displayName: 'Myco Agent',
    description: 'Test agent',
    model: 'claude-sonnet-4-20250514',
    maxTurns: 30,
    timeoutSeconds: 300,
    systemPromptPath: '../prompts/agent.md',
    tools: ['vault_unprocessed', 'vault_create_spore', 'vault_set_state'],
    ...overrides,
  };
}

/** Create a minimal AgentRow for testing DB overrides. */
function makeAgentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'myco-agent',
    name: 'Myco Agent',
    provider: null,
    model: null,
    system_prompt_hash: null,
    config: null,
    source: 'built-in',
    system_prompt: null,
    max_turns: null,
    timeout_seconds: null,
    tool_access: null,
    enabled: 1,
    created_at: 1000,
    updated_at: null,
    ...overrides,
  };
}

/** Create a minimal AgentTask for testing. */
function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    name: 'test-task',
    displayName: 'Test Task',
    description: 'A test task',
    agent: 'myco-agent',
    prompt: 'Do the thing.',
    isDefault: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent loader', () => {
  // -------------------------------------------------------------------------
  // loadAgentDefinition
  // -------------------------------------------------------------------------

  describe('loadAgentDefinition', () => {
    it('loads agent.yaml with correct fields', () => {
      const def = loadAgentDefinition(DEFINITIONS_DIR);

      expect(def.name).toBe('myco-agent');
      expect(def.displayName).toBe('Myco Agent');
      expect(typeof def.description).toBe('string');
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.model).toBe('claude-sonnet-4-20250514');
      expect(def.maxTurns).toBe(30);
      expect(def.timeoutSeconds).toBe(300);
      expect(def.systemPromptPath).toBe('../prompts/agent.md');
    });

    it('includes all expected tools', () => {
      const def = loadAgentDefinition(DEFINITIONS_DIR);

      // Read tools
      expect(def.tools).toContain('vault_unprocessed');
      expect(def.tools).toContain('vault_spores');
      expect(def.tools).toContain('vault_sessions');
      expect(def.tools).toContain('vault_search');
      expect(def.tools).toContain('vault_state');

      // Write tools
      expect(def.tools).toContain('vault_create_spore');
      expect(def.tools).toContain('vault_create_entity');
      expect(def.tools).toContain('vault_create_edge');
      expect(def.tools).toContain('vault_resolve_spore');
      expect(def.tools).toContain('vault_update_session');
      expect(def.tools).toContain('vault_mark_processed');
      expect(def.tools).toContain('vault_write_digest');
      expect(def.tools).toContain('vault_set_state');
      expect(def.tools).toContain('vault_report');
    });

    it('tools is an array of strings', () => {
      const def = loadAgentDefinition(DEFINITIONS_DIR);

      expect(Array.isArray(def.tools)).toBe(true);
      for (const tool of def.tools) {
        expect(typeof tool).toBe('string');
      }
    });

    it('throws when definitions directory does not exist', () => {
      expect(() => loadAgentDefinition('/nonexistent/path')).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // loadAgentTasks
  // -------------------------------------------------------------------------

  describe('loadAgentTasks', () => {
    it('loads all 7 task files', () => {
      const tasks = loadAgentTasks(DEFINITIONS_DIR);
      expect(tasks).toHaveLength(EXPECTED_TASK_COUNT);
    });

    it('each task has required fields', () => {
      const tasks = loadAgentTasks(DEFINITIONS_DIR);

      for (const task of tasks) {
        expect(typeof task.name).toBe('string');
        expect(task.name.length).toBeGreaterThan(0);
        expect(typeof task.displayName).toBe('string');
        expect(typeof task.description).toBe('string');
        expect(task.agent).toBe('myco-agent');
        expect(typeof task.prompt).toBe('string');
        expect(task.prompt.length).toBeGreaterThan(0);
        expect(typeof task.isDefault).toBe('boolean');
      }
    });

    it('exactly one task is the default', () => {
      const tasks = loadAgentTasks(DEFINITIONS_DIR);
      const defaults = tasks.filter((t) => t.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].name).toBe('full-intelligence');
    });

    it('loads expected task names', () => {
      const tasks = loadAgentTasks(DEFINITIONS_DIR);
      const names = tasks.map((t) => t.name).sort();

      expect(names).toContain('full-intelligence');
      expect(names).toContain('digest-only');
      expect(names).toContain('review-session');
      expect(names).toContain('extract-only');
      expect(names).toContain('graph-maintenance');
      expect(names).toContain('supersession-sweep');
      expect(names).toContain('title-summary');
    });

    it('tasks with toolOverrides have string arrays', () => {
      const tasks = loadAgentTasks(DEFINITIONS_DIR);
      const withOverrides = tasks.filter((t) => t.toolOverrides !== undefined);

      expect(withOverrides.length).toBeGreaterThan(0);
      for (const task of withOverrides) {
        expect(Array.isArray(task.toolOverrides)).toBe(true);
        for (const tool of task.toolOverrides!) {
          expect(typeof tool).toBe('string');
        }
      }
    });

    it('returns empty array for nonexistent directory', () => {
      const tasks = loadAgentTasks('/nonexistent/path');
      expect(tasks).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // loadSystemPrompt
  // -------------------------------------------------------------------------

  describe('loadSystemPrompt', () => {
    it('loads the agent.md prompt file', () => {
      const content = loadSystemPrompt(DEFINITIONS_DIR, '../prompts/agent.md');
      expect(typeof content).toBe('string');
      expect(content.length).toBeGreaterThan(0);
    });

    it('throws for missing prompt file', () => {
      expect(() => loadSystemPrompt(DEFINITIONS_DIR, '../prompts/nonexistent.md')).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // resolveEffectiveConfig
  // -------------------------------------------------------------------------

  describe('resolveEffectiveConfig', () => {
    it('uses definition defaults when no overrides given', () => {
      const def = makeDefinition();
      const config = resolveEffectiveConfig(def);

      expect(config.agentId).toBe('myco-agent');
      expect(config.model).toBe('claude-sonnet-4-20250514');
      expect(config.maxTurns).toBe(30);
      expect(config.timeoutSeconds).toBe(300);
      expect(config.tools).toEqual(def.tools);
      expect(config.systemPromptPath).toBe('../prompts/agent.md');
      expect(config.taskName).toBe('full-intelligence');
      expect(config.taskDisplayName).toBe('Full Intelligence');
    });

    it('applies agent DB overrides for model', () => {
      const def = makeDefinition();
      const agent = makeAgentRow({ model: 'claude-3-haiku' });
      const config = resolveEffectiveConfig(def, agent);

      expect(config.model).toBe('claude-3-haiku');
    });

    it('applies agent DB overrides for maxTurns and timeoutSeconds', () => {
      const def = makeDefinition();
      const agent = makeAgentRow({
        max_turns: 10,
        timeout_seconds: 120,
      });
      const config = resolveEffectiveConfig(def, agent);

      expect(config.maxTurns).toBe(10);
      expect(config.timeoutSeconds).toBe(120);
    });

    it('applies agent DB tool_access override', () => {
      const def = makeDefinition();
      const agent = makeAgentRow({
        tool_access: JSON.stringify(['vault_spores', 'vault_create_spore']),
      });
      const config = resolveEffectiveConfig(def, agent);

      expect(config.tools).toEqual(['vault_spores', 'vault_create_spore']);
    });

    it('ignores invalid JSON in tool_access', () => {
      const def = makeDefinition();
      const agent = makeAgentRow({ tool_access: 'not-json' });
      const config = resolveEffectiveConfig(def, agent);

      // Falls back to definition tools
      expect(config.tools).toEqual(def.tools);
    });

    it('task toolOverrides take precedence over agent tool_access', () => {
      const def = makeDefinition();
      const agent = makeAgentRow({
        tool_access: JSON.stringify(['vault_spores', 'vault_create_spore']),
      });
      const task = makeTask({
        toolOverrides: ['vault_resolve_spore', 'vault_set_state'],
      });
      const config = resolveEffectiveConfig(def, agent, task);

      // Task overrides win
      expect(config.tools).toEqual(['vault_resolve_spore', 'vault_set_state']);
    });

    it('uses task prompt and display info when task provided', () => {
      const def = makeDefinition();
      const task = makeTask({
        name: 'digest-only',
        displayName: 'Digest Only',
        prompt: 'Regenerate digests.',
      });
      const config = resolveEffectiveConfig(def, null, task);

      expect(config.taskName).toBe('digest-only');
      expect(config.taskDisplayName).toBe('Digest Only');
      expect(config.taskPrompt).toBe('Regenerate digests.');
    });

    it('uses agent id from DB row when provided', () => {
      const def = makeDefinition();
      const agent = makeAgentRow({ id: 'custom-agent' });
      const config = resolveEffectiveConfig(def, agent);

      expect(config.agentId).toBe('custom-agent');
    });

    it('null agent overrides fall through to definition defaults', () => {
      const def = makeDefinition({ maxTurns: 50 });
      const agent = makeAgentRow({
        model: null,
        max_turns: null,
        timeout_seconds: null,
        tool_access: null,
      });
      const config = resolveEffectiveConfig(def, agent);

      expect(config.model).toBe('claude-sonnet-4-20250514');
      expect(config.maxTurns).toBe(50);
      expect(config.timeoutSeconds).toBe(300);
      expect(config.tools).toEqual(def.tools);
    });
  });

  // -------------------------------------------------------------------------
  // registerBuiltInAgentsAndTasks (requires PGlite)
  // -------------------------------------------------------------------------

  describe('registerBuiltInAgentsAndTasks', () => {
    beforeAll(() => { setupTestDb(); });
    afterAll(() => { teardownTestDb(); });
    beforeEach(() => { cleanTestDb(); });

    it('registers the built-in agent in the database', async () => {
      registerBuiltInAgentsAndTasks(DEFINITIONS_DIR);

      const agent = getAgent(BUILT_IN_AGENT_NAME);
      expect(agent).not.toBeNull();
      expect(agent!.id).toBe(BUILT_IN_AGENT_NAME);
      expect(agent!.name).toBe('Myco Agent');
      expect(agent!.source).toBe('built-in');
      expect(agent!.model).toBe('claude-sonnet-4-20250514');
      expect(agent!.max_turns).toBe(30);
      expect(agent!.timeout_seconds).toBe(300);
    });

    it('registers all built-in tasks in the database', async () => {
      registerBuiltInAgentsAndTasks(DEFINITIONS_DIR);

      const tasks = listTasks({ agent_id: BUILT_IN_AGENT_NAME });
      expect(tasks).toHaveLength(EXPECTED_TASK_COUNT);

      const names = tasks.map((t) => t.id).sort();
      expect(names).toContain('full-intelligence');
      expect(names).toContain('digest-only');
      expect(names).toContain('review-session');
      expect(names).toContain('extract-only');
      expect(names).toContain('graph-maintenance');
      expect(names).toContain('supersession-sweep');
      expect(names).toContain('title-summary');
    });

    it('marks full-intelligence as the default task', async () => {
      registerBuiltInAgentsAndTasks(DEFINITIONS_DIR);

      const defaultTask = getDefaultTask(BUILT_IN_AGENT_NAME);
      expect(defaultTask).not.toBeNull();
      expect(defaultTask!.id).toBe('full-intelligence');
      expect(defaultTask!.is_default).toBe(1);
    });

    it('is idempotent — running twice produces the same result', async () => {
      registerBuiltInAgentsAndTasks(DEFINITIONS_DIR);
      registerBuiltInAgentsAndTasks(DEFINITIONS_DIR);

      const agent = getAgent(BUILT_IN_AGENT_NAME);
      expect(agent).not.toBeNull();

      const tasks = listTasks({ agent_id: BUILT_IN_AGENT_NAME });
      expect(tasks).toHaveLength(EXPECTED_TASK_COUNT);
    });

    it('stores tool_access as JSON string on agent', async () => {
      registerBuiltInAgentsAndTasks(DEFINITIONS_DIR);

      const agent = getAgent(BUILT_IN_AGENT_NAME);
      expect(agent).not.toBeNull();
      expect(agent!.tool_access).not.toBeNull();

      const tools = JSON.parse(agent!.tool_access!) as string[];
      expect(Array.isArray(tools)).toBe(true);
      expect(tools).toContain('vault_unprocessed');
      expect(tools).toContain('vault_create_spore');
    });

    it('stores toolOverrides as JSON on tasks that have them', async () => {
      registerBuiltInAgentsAndTasks(DEFINITIONS_DIR);

      const tasks = listTasks({ agent_id: BUILT_IN_AGENT_NAME });
      const digestOnly = tasks.find((t) => t.id === 'digest-only');
      expect(digestOnly).not.toBeUndefined();
      expect(digestOnly!.tool_overrides).not.toBeNull();

      const overrides = JSON.parse(digestOnly!.tool_overrides!) as string[];
      expect(Array.isArray(overrides)).toBe(true);
      expect(overrides).toContain('vault_write_digest');
    });
  });
});
