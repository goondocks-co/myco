/**
 * Tests for agent definition and task YAML loader.
 *
 * Tests cover:
 * - Loading the built-in curator definition from curator.yaml
 * - Loading all task YAML files from tasks/
 * - Merging definitions with DB overrides via resolveEffectiveConfig
 * - Registering built-in curators and tasks into PGlite
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { getCurator } from '@myco/db/queries/curators.js';
import { listTasks, getDefaultTask } from '@myco/db/queries/tasks.js';
import {
  loadAgentDefinition,
  loadAgentTasks,
  loadSystemPrompt,
  resolveEffectiveConfig,
  registerBuiltInCuratorsAndTasks,
} from '@myco/agent/loader.js';
import type { CuratorRow } from '@myco/db/queries/curators.js';
import type { AgentDefinition, AgentTask } from '@myco/agent/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of built-in task YAML files. */
const EXPECTED_TASK_COUNT = 7;

/** Built-in curator name from curator.yaml. */
const BUILT_IN_CURATOR_NAME = 'myco-curator';

/** Resolve the test definitions directory (src/agent/definitions/). */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFINITIONS_DIR = path.resolve(__dirname, '..', '..', 'src', 'agent', 'definitions');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AgentDefinition for testing. */
function makeDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'myco-curator',
    displayName: 'Myco Curator',
    description: 'Test curator',
    model: 'claude-sonnet-4-20250514',
    maxTurns: 25,
    timeoutSeconds: 300,
    systemPromptPath: '../prompts/curator.md',
    tools: ['query_unprocessed', 'create_spore', 'set_agent_state'],
    ...overrides,
  };
}

/** Create a minimal CuratorRow for testing DB overrides. */
function makeCuratorRow(overrides: Partial<CuratorRow> = {}): CuratorRow {
  return {
    id: 'myco-curator',
    name: 'Myco Curator',
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
    agent: 'myco-curator',
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
    it('loads curator.yaml with correct fields', () => {
      const def = loadAgentDefinition(DEFINITIONS_DIR);

      expect(def.name).toBe('myco-curator');
      expect(def.displayName).toBe('Myco Curator');
      expect(typeof def.description).toBe('string');
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.model).toBe('claude-sonnet-4-20250514');
      expect(def.maxTurns).toBe(25);
      expect(def.timeoutSeconds).toBe(300);
      expect(def.systemPromptPath).toBe('../prompts/curator.md');
    });

    it('includes all expected tools', () => {
      const def = loadAgentDefinition(DEFINITIONS_DIR);

      // Read tools
      expect(def.tools).toContain('query_unprocessed');
      expect(def.tools).toContain('query_spores');
      expect(def.tools).toContain('query_graph');
      expect(def.tools).toContain('query_sessions');
      expect(def.tools).toContain('semantic_search');
      expect(def.tools).toContain('get_agent_state');

      // Write tools
      expect(def.tools).toContain('create_spore');
      expect(def.tools).toContain('create_entity');
      expect(def.tools).toContain('create_edge');
      expect(def.tools).toContain('resolve_spore');
      expect(def.tools).toContain('update_session_summary');
      expect(def.tools).toContain('mark_processed');
      expect(def.tools).toContain('write_digest_extract');
      expect(def.tools).toContain('set_agent_state');
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
        expect(task.agent).toBe('myco-curator');
        expect(typeof task.prompt).toBe('string');
        expect(task.prompt.length).toBeGreaterThan(0);
        expect(typeof task.isDefault).toBe('boolean');
      }
    });

    it('exactly one task is the default', () => {
      const tasks = loadAgentTasks(DEFINITIONS_DIR);
      const defaults = tasks.filter((t) => t.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].name).toBe('full-curation');
    });

    it('loads expected task names', () => {
      const tasks = loadAgentTasks(DEFINITIONS_DIR);
      const names = tasks.map((t) => t.name).sort();

      expect(names).toContain('full-curation');
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
    it('loads the curator.md prompt file', () => {
      const content = loadSystemPrompt(DEFINITIONS_DIR, '../prompts/curator.md');
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

      expect(config.curatorId).toBe('myco-curator');
      expect(config.model).toBe('claude-sonnet-4-20250514');
      expect(config.maxTurns).toBe(25);
      expect(config.timeoutSeconds).toBe(300);
      expect(config.tools).toEqual(def.tools);
      expect(config.systemPromptPath).toBe('../prompts/curator.md');
      expect(config.taskName).toBe('full-curation');
      expect(config.taskDisplayName).toBe('Full Curation');
    });

    it('applies curator DB overrides for model', () => {
      const def = makeDefinition();
      const curator = makeCuratorRow({ model: 'claude-3-haiku' });
      const config = resolveEffectiveConfig(def, curator);

      expect(config.model).toBe('claude-3-haiku');
    });

    it('applies curator DB overrides for maxTurns and timeoutSeconds', () => {
      const def = makeDefinition();
      const curator = makeCuratorRow({
        max_turns: 10,
        timeout_seconds: 120,
      });
      const config = resolveEffectiveConfig(def, curator);

      expect(config.maxTurns).toBe(10);
      expect(config.timeoutSeconds).toBe(120);
    });

    it('applies curator DB tool_access override', () => {
      const def = makeDefinition();
      const curator = makeCuratorRow({
        tool_access: JSON.stringify(['query_spores', 'create_spore']),
      });
      const config = resolveEffectiveConfig(def, curator);

      expect(config.tools).toEqual(['query_spores', 'create_spore']);
    });

    it('ignores invalid JSON in tool_access', () => {
      const def = makeDefinition();
      const curator = makeCuratorRow({ tool_access: 'not-json' });
      const config = resolveEffectiveConfig(def, curator);

      // Falls back to definition tools
      expect(config.tools).toEqual(def.tools);
    });

    it('task toolOverrides take precedence over curator tool_access', () => {
      const def = makeDefinition();
      const curator = makeCuratorRow({
        tool_access: JSON.stringify(['query_spores', 'create_spore']),
      });
      const task = makeTask({
        toolOverrides: ['resolve_spore', 'set_agent_state'],
      });
      const config = resolveEffectiveConfig(def, curator, task);

      // Task overrides win
      expect(config.tools).toEqual(['resolve_spore', 'set_agent_state']);
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

    it('uses curator id from DB row when provided', () => {
      const def = makeDefinition();
      const curator = makeCuratorRow({ id: 'custom-curator' });
      const config = resolveEffectiveConfig(def, curator);

      expect(config.curatorId).toBe('custom-curator');
    });

    it('null curator overrides fall through to definition defaults', () => {
      const def = makeDefinition({ maxTurns: 50 });
      const curator = makeCuratorRow({
        model: null,
        max_turns: null,
        timeout_seconds: null,
        tool_access: null,
      });
      const config = resolveEffectiveConfig(def, curator);

      expect(config.model).toBe('claude-sonnet-4-20250514');
      expect(config.maxTurns).toBe(50);
      expect(config.timeoutSeconds).toBe(300);
      expect(config.tools).toEqual(def.tools);
    });
  });

  // -------------------------------------------------------------------------
  // registerBuiltInCuratorsAndTasks (requires PGlite)
  // -------------------------------------------------------------------------

  describe('registerBuiltInCuratorsAndTasks', () => {
    beforeEach(async () => {
      const db = await initDatabase(); // in-memory
      await createSchema(db);
    });

    afterEach(async () => {
      await closeDatabase();
    });

    it('registers the built-in curator in the database', async () => {
      await registerBuiltInCuratorsAndTasks(DEFINITIONS_DIR);

      const curator = await getCurator(BUILT_IN_CURATOR_NAME);
      expect(curator).not.toBeNull();
      expect(curator!.id).toBe(BUILT_IN_CURATOR_NAME);
      expect(curator!.name).toBe('Myco Curator');
      expect(curator!.source).toBe('built-in');
      expect(curator!.model).toBe('claude-sonnet-4-20250514');
      expect(curator!.max_turns).toBe(25);
      expect(curator!.timeout_seconds).toBe(300);
    });

    it('registers all built-in tasks in the database', async () => {
      await registerBuiltInCuratorsAndTasks(DEFINITIONS_DIR);

      const tasks = await listTasks({ curator_id: BUILT_IN_CURATOR_NAME });
      expect(tasks).toHaveLength(EXPECTED_TASK_COUNT);

      const names = tasks.map((t) => t.id).sort();
      expect(names).toContain('full-curation');
      expect(names).toContain('digest-only');
      expect(names).toContain('review-session');
      expect(names).toContain('extract-only');
      expect(names).toContain('graph-maintenance');
      expect(names).toContain('supersession-sweep');
      expect(names).toContain('title-summary');
    });

    it('marks full-curation as the default task', async () => {
      await registerBuiltInCuratorsAndTasks(DEFINITIONS_DIR);

      const defaultTask = await getDefaultTask(BUILT_IN_CURATOR_NAME);
      expect(defaultTask).not.toBeNull();
      expect(defaultTask!.id).toBe('full-curation');
      expect(defaultTask!.is_default).toBe(1);
    });

    it('is idempotent — running twice produces the same result', async () => {
      await registerBuiltInCuratorsAndTasks(DEFINITIONS_DIR);
      await registerBuiltInCuratorsAndTasks(DEFINITIONS_DIR);

      const curator = await getCurator(BUILT_IN_CURATOR_NAME);
      expect(curator).not.toBeNull();

      const tasks = await listTasks({ curator_id: BUILT_IN_CURATOR_NAME });
      expect(tasks).toHaveLength(EXPECTED_TASK_COUNT);
    });

    it('stores tool_access as JSON string on curator', async () => {
      await registerBuiltInCuratorsAndTasks(DEFINITIONS_DIR);

      const curator = await getCurator(BUILT_IN_CURATOR_NAME);
      expect(curator).not.toBeNull();
      expect(curator!.tool_access).not.toBeNull();

      const tools = JSON.parse(curator!.tool_access!) as string[];
      expect(Array.isArray(tools)).toBe(true);
      expect(tools).toContain('query_unprocessed');
      expect(tools).toContain('create_spore');
    });

    it('stores toolOverrides as JSON on tasks that have them', async () => {
      await registerBuiltInCuratorsAndTasks(DEFINITIONS_DIR);

      const tasks = await listTasks({ curator_id: BUILT_IN_CURATOR_NAME });
      const digestOnly = tasks.find((t) => t.id === 'digest-only');
      expect(digestOnly).not.toBeUndefined();
      expect(digestOnly!.tool_overrides).not.toBeNull();

      const overrides = JSON.parse(digestOnly!.tool_overrides!) as string[];
      expect(Array.isArray(overrides)).toBe(true);
      expect(overrides).toContain('write_digest_extract');
    });
  });
});
