/**
 * Tests for agent task CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import {
  upsertTask,
  getTask,
  listTasks,
  getDefaultTask,
} from '@myco/db/queries/tasks.js';
import type { TaskInsert } from '@myco/db/queries/tasks.js';

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
  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);
    // Insert the agent FK target
    await registerAgent({
      id: TEST_AGENT_ID,
      name: 'Test Agent',
      created_at: epochNow(),
    });
  });

  afterEach(async () => {
    await closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // upsertTask + getTask
  // ---------------------------------------------------------------------------

  describe('upsertTask', () => {
    it('inserts a new task and retrieves it', async () => {
      const data = makeTask({ display_name: 'Default Digest' });
      const row = await upsertTask(data);

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

      const fetched = await getTask(data.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
    });

    it('stores all optional fields', async () => {
      const now = epochNow();
      const data = makeTask({
        source: 'user',
        display_name: 'Custom Task',
        description: 'A custom curation task',
        is_default: 1,
        tool_overrides: '["vault_search"]',
        config: '{"max_spores": 10}',
        updated_at: now,
      });
      const row = await upsertTask(data);

      expect(row.source).toBe('user');
      expect(row.display_name).toBe('Custom Task');
      expect(row.description).toBe('A custom curation task');
      expect(row.is_default).toBe(1);
      expect(row.tool_overrides).toBe('["vault_search"]');
      expect(row.config).toBe('{"max_spores": 10}');
      expect(row.updated_at).toBe(now);
    });

    it('upserts on conflict — updates fields', async () => {
      const data = makeTask({ display_name: 'Original' });
      await upsertTask(data);

      const updated = await upsertTask({
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
      const first = await upsertTask(data);
      const second = await upsertTask(data);

      expect(first).toEqual(second);
    });
  });

  // ---------------------------------------------------------------------------
  // getTask
  // ---------------------------------------------------------------------------

  describe('getTask', () => {
    it('returns null for non-existent id', async () => {
      const row = await getTask('does-not-exist');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listTasks
  // ---------------------------------------------------------------------------

  describe('listTasks', () => {
    it('returns tasks ordered by created_at ASC', async () => {
      const now = epochNow();
      await upsertTask(makeTask({ id: 'task-old', created_at: now - 100 }));
      await upsertTask(makeTask({ id: 'task-mid', created_at: now - 50 }));
      await upsertTask(makeTask({ id: 'task-new', created_at: now }));

      const rows = await listTasks();
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('task-old');
      expect(rows[1].id).toBe('task-mid');
      expect(rows[2].id).toBe('task-new');
    });

    it('filters by agent_id', async () => {
      await registerAgent({
        id: 'agent-other',
        name: 'Other',
        created_at: epochNow(),
      });
      await upsertTask(makeTask({ id: 'task-a' }));
      await upsertTask(makeTask({ id: 'task-b', agent_id: 'agent-other' }));

      const rows = await listTasks({ agent_id: TEST_AGENT_ID });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('task-a');
    });

    it('filters by source', async () => {
      await upsertTask(makeTask({ id: 'task-builtin', source: 'built-in' }));
      await upsertTask(makeTask({ id: 'task-user', source: 'user' }));

      const rows = await listTasks({ source: 'user' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('task-user');
    });

    it('respects limit', async () => {
      const now = epochNow();
      await upsertTask(makeTask({ id: 'task-1', created_at: now - 2 }));
      await upsertTask(makeTask({ id: 'task-2', created_at: now - 1 }));
      await upsertTask(makeTask({ id: 'task-3', created_at: now }));

      const rows = await listTasks({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('returns empty array when no tasks exist', async () => {
      const rows = await listTasks();
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getDefaultTask
  // ---------------------------------------------------------------------------

  describe('getDefaultTask', () => {
    it('returns the default task for an agent', async () => {
      await upsertTask(makeTask({ id: 'task-regular', is_default: 0 }));
      await upsertTask(makeTask({ id: 'task-default', is_default: 1, display_name: 'Default' }));

      const defaultTask = await getDefaultTask(TEST_AGENT_ID);
      expect(defaultTask).not.toBeNull();
      expect(defaultTask!.id).toBe('task-default');
      expect(defaultTask!.is_default).toBe(1);
    });

    it('returns null when no default task exists', async () => {
      await upsertTask(makeTask({ is_default: 0 }));

      const defaultTask = await getDefaultTask(TEST_AGENT_ID);
      expect(defaultTask).toBeNull();
    });

    it('returns null for agent with no tasks', async () => {
      const defaultTask = await getDefaultTask('no-such-agent');
      expect(defaultTask).toBeNull();
    });
  });
});
