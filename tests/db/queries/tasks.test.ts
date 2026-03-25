/**
 * Tests for agent task CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import {
  upsertTask,
  getTask,
  listTasks,
  getDefaultTask,
  deleteTask,
  serializeConfig,
  deserializeConfig,
} from '@myco/db/queries/tasks.js';
import type { TaskInsert } from '@myco/db/queries/tasks.js';
import type { TaskConfig } from '@myco/agent/types.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Shared agent ID used across tests. */
const TEST_AGENT_ID = 'agent-tasks-test';

/** Factory for minimal valid task data. */
function makeTask(overrides: Partial<TaskInsert> = {}): TaskInsert {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    agent_id: TEST_AGENT_ID,
    prompt: 'Analyze the vault and produce observations.',
    created_at: epochNow(),
    ...overrides,
  };
}

describe('task query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(async () => {
    cleanTestDb();
    // Insert the agent FK target
    registerAgent({
      id: TEST_AGENT_ID,
      name: 'Test Agent',
      created_at: epochNow(),
    });
  });

  // ---------------------------------------------------------------------------
  // upsertTask + getTask
  // ---------------------------------------------------------------------------

  describe('upsertTask', () => {
    it('inserts a new task and retrieves it', async () => {
      const data = makeTask({ display_name: 'Default Digest' });
      const row = upsertTask(data);

      expect(row.id).toBe(data.id);
      expect(row.agent_id).toBe(TEST_AGENT_ID);
      expect(row.source).toBe('built-in');
      expect(row.display_name).toBe('Default Digest');
      expect(row.description).toBeNull();
      expect(row.prompt).toBe(data.prompt);
      expect(row.is_default).toBe(0);
      expect(row.tool_overrides).toBeNull();
      expect(row.config).toBeNull();
      expect(row.created_at).toBe(data.created_at);
      expect(row.updated_at).toBeNull();

      const fetched = getTask(data.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
    });

    it('stores all optional fields', async () => {
      const now = epochNow();
      const data = makeTask({
        source: 'user',
        display_name: 'Custom Task',
        description: 'A custom intelligence task',
        is_default: 1,
        tool_overrides: '["vault_search"]',
        config: '{"max_spores": 10}',
        updated_at: now,
      });
      const row = upsertTask(data);

      expect(row.source).toBe('user');
      expect(row.display_name).toBe('Custom Task');
      expect(row.description).toBe('A custom intelligence task');
      expect(row.is_default).toBe(1);
      expect(row.tool_overrides).toBe('["vault_search"]');
      expect(row.config).toBe('{"max_spores": 10}');
      expect(row.updated_at).toBe(now);
    });

    it('upserts on conflict — updates fields', async () => {
      const data = makeTask({ display_name: 'Original' });
      upsertTask(data);

      const updated = upsertTask({
        ...data,
        display_name: 'Updated',
        prompt: 'New prompt text.',
        updated_at: epochNow(),
      });

      expect(updated.id).toBe(data.id);
      expect(updated.display_name).toBe('Updated');
      expect(updated.prompt).toBe('New prompt text.');
    });

    it('is idempotent — same data produces same result', async () => {
      const data = makeTask({ display_name: 'Idempotent Task' });
      const first = upsertTask(data);
      const second = upsertTask(data);

      expect(first).toEqual(second);
    });
  });

  // ---------------------------------------------------------------------------
  // getTask
  // ---------------------------------------------------------------------------

  describe('getTask', () => {
    it('returns null for non-existent id', async () => {
      const row = getTask('does-not-exist');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listTasks
  // ---------------------------------------------------------------------------

  describe('listTasks', () => {
    it('returns tasks ordered by created_at ASC', async () => {
      const now = epochNow();
      upsertTask(makeTask({ id: 'task-old', created_at: now - 100 }));
      upsertTask(makeTask({ id: 'task-mid', created_at: now - 50 }));
      upsertTask(makeTask({ id: 'task-new', created_at: now }));

      const rows = listTasks();
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('task-old');
      expect(rows[1].id).toBe('task-mid');
      expect(rows[2].id).toBe('task-new');
    });

    it('filters by agent_id', async () => {
      registerAgent({
        id: 'agent-other',
        name: 'Other',
        created_at: epochNow(),
      });
      upsertTask(makeTask({ id: 'task-a' }));
      upsertTask(makeTask({ id: 'task-b', agent_id: 'agent-other' }));

      const rows = listTasks({ agent_id: TEST_AGENT_ID });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('task-a');
    });

    it('filters by source', async () => {
      upsertTask(makeTask({ id: 'task-builtin', source: 'built-in' }));
      upsertTask(makeTask({ id: 'task-user', source: 'user' }));

      const rows = listTasks({ source: 'user' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('task-user');
    });

    it('respects limit', async () => {
      const now = epochNow();
      upsertTask(makeTask({ id: 'task-1', created_at: now - 2 }));
      upsertTask(makeTask({ id: 'task-2', created_at: now - 1 }));
      upsertTask(makeTask({ id: 'task-3', created_at: now }));

      const rows = listTasks({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('returns empty array when no tasks exist', async () => {
      const rows = listTasks();
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getDefaultTask
  // ---------------------------------------------------------------------------

  describe('getDefaultTask', () => {
    it('returns the default task for an agent', async () => {
      upsertTask(makeTask({ id: 'task-regular', is_default: 0 }));
      upsertTask(makeTask({ id: 'task-default', is_default: 1, display_name: 'Default' }));

      const defaultTask = getDefaultTask(TEST_AGENT_ID);
      expect(defaultTask).not.toBeNull();
      expect(defaultTask!.id).toBe('task-default');
      expect(defaultTask!.is_default).toBe(1);
    });

    it('returns null when no default task exists', async () => {
      upsertTask(makeTask({ is_default: 0 }));

      const defaultTask = getDefaultTask(TEST_AGENT_ID);
      expect(defaultTask).toBeNull();
    });

    it('returns null for agent with no tasks', async () => {
      const defaultTask = getDefaultTask('no-such-agent');
      expect(defaultTask).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // config column — serialization helpers and round-trip
  // ---------------------------------------------------------------------------

  describe('config column', () => {
    it('upsert with phases config round-trips correctly', async () => {
      const phases = [
        {
          name: 'gather',
          prompt: 'Gather data.',
          tools: ['vault_unprocessed'],
          maxTurns: 5,
          required: true,
        },
        {
          name: 'extract',
          prompt: 'Extract spores.',
          tools: ['vault_create_spore'],
          maxTurns: 10,
          required: false,
        },
      ];
      const config: TaskConfig = { phases, schemaVersion: 1 };

      const data = makeTask({ config: serializeConfig(config) });
      upsertTask(data);

      const row = getTask(data.id);
      expect(row).not.toBeNull();
      expect(row!.config).not.toBeNull();

      const parsed = deserializeConfig(row!.config);
      expect(parsed).not.toBeNull();
      expect(parsed!.phases).toHaveLength(2);
      expect(parsed!.phases![0].name).toBe('gather');
      expect(parsed!.phases![1].name).toBe('extract');
      expect(parsed!.schemaVersion).toBe(1);
    });

    it('upsert with execution overrides config round-trips correctly', async () => {
      const config: TaskConfig = {
        execution: {
          model: 'claude-3-haiku',
          maxTurns: 20,
          timeoutSeconds: 180,
        },
        schemaVersion: 1,
      };

      const data = makeTask({ config: serializeConfig(config) });
      upsertTask(data);

      const row = getTask(data.id);
      expect(row).not.toBeNull();

      const parsed = deserializeConfig(row!.config);
      expect(parsed).not.toBeNull();
      expect(parsed!.execution).toBeDefined();
      expect(parsed!.execution!.model).toBe('claude-3-haiku');
      expect(parsed!.execution!.maxTurns).toBe(20);
      expect(parsed!.execution!.timeoutSeconds).toBe(180);
    });

    it('config column is null when no extended config provided', async () => {
      const data = makeTask(); // no config field
      const row = upsertTask(data);

      expect(row.config).toBeNull();

      const fetched = getTask(data.id);
      expect(fetched!.config).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // serializeConfig / deserializeConfig helpers
  // ---------------------------------------------------------------------------

  describe('serializeConfig', () => {
    it('serializes a config to JSON string', () => {
      const config: TaskConfig = { schemaVersion: 1, phases: [] };
      const result = serializeConfig(config);
      expect(typeof result).toBe('string');
      expect(JSON.parse(result!)).toEqual(config);
    });

    it('returns null for null input', () => {
      expect(serializeConfig(null)).toBeNull();
    });
  });

  describe('deserializeConfig', () => {
    it('deserializes a valid JSON string to TaskConfig', () => {
      const config: TaskConfig = { schemaVersion: 2 };
      const raw = JSON.stringify(config);
      const result = deserializeConfig(raw);
      expect(result).toEqual(config);
    });

    it('returns null for null input', () => {
      expect(deserializeConfig(null)).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      expect(deserializeConfig('not-json')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // deleteTask
  // ---------------------------------------------------------------------------

  describe('deleteTask', () => {
    it('deletes a user task (source=user) and returns true', async () => {
      const data = makeTask({ id: 'task-to-delete', source: 'user' });
      upsertTask(data);

      const deleted = deleteTask(data.id);
      expect(deleted).toBe(true);

      const fetched = getTask(data.id);
      expect(fetched).toBeNull();
    });

    it('returns false for a non-existent task', async () => {
      const deleted = deleteTask('does-not-exist');
      expect(deleted).toBe(false);
    });

    it('returns false for a built-in task and does not delete it', async () => {
      const data = makeTask({ id: 'task-builtin', source: 'built-in' });
      upsertTask(data);

      const deleted = deleteTask(data.id);
      expect(deleted).toBe(false);

      const fetched = getTask(data.id);
      expect(fetched).not.toBeNull();
    });
  });
});
