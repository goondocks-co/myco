/**
 * Tests for agent CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  registerAgent,
  getAgent,
  listAgents,
} from '@myco/db/queries/agents.js';
import type { AgentInsert } from '@myco/db/queries/agents.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Factory for minimal valid agent data. */
function makeAgent(overrides: Partial<AgentInsert> = {}): AgentInsert {
  const now = epochNow();
  return {
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test Agent',
    created_at: now,
    ...overrides,
  };
}

describe('agent query helpers', () => {
  beforeEach(async () => {
    const db = await initDatabase(); // in-memory
    await createSchema(db);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // registerAgent + getAgent
  // ---------------------------------------------------------------------------

  describe('registerAgent', () => {
    it('inserts a new agent and retrieves it', async () => {
      const data = makeAgent({ name: 'Digest Agent' });
      const row = await registerAgent(data);

      expect(row.id).toBe(data.id);
      expect(row.name).toBe('Digest Agent');
      expect(row.provider).toBeNull();
      expect(row.model).toBeNull();
      expect(row.system_prompt_hash).toBeNull();
      expect(row.config).toBeNull();
      expect(row.source).toBe('built-in');
      expect(row.system_prompt).toBeNull();
      expect(row.max_turns).toBeNull();
      expect(row.timeout_seconds).toBeNull();
      expect(row.tool_access).toBeNull();
      expect(row.enabled).toBe(1);
      expect(row.created_at).toBe(data.created_at);
      expect(row.updated_at).toBeNull();

      const fetched = await getAgent(data.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
      expect(fetched!.name).toBe('Digest Agent');
    });

    it('stores all optional fields including Phase 2 columns', async () => {
      const now = epochNow();
      const data = makeAgent({
        name: 'Full Agent',
        provider: 'ollama',
        model: 'bge-m3',
        system_prompt_hash: 'hash-xyz',
        config: '{"temperature": 0.7}',
        source: 'user',
        system_prompt: 'You are a specialized agent.',
        max_turns: 10,
        timeout_seconds: 60,
        tool_access: '["vault_search","vault_read"]',
        enabled: 0,
        updated_at: now,
      });
      const row = await registerAgent(data);

      expect(row.provider).toBe('ollama');
      expect(row.model).toBe('bge-m3');
      expect(row.system_prompt_hash).toBe('hash-xyz');
      expect(row.config).toBe('{"temperature": 0.7}');
      expect(row.source).toBe('user');
      expect(row.system_prompt).toBe('You are a specialized agent.');
      expect(row.max_turns).toBe(10);
      expect(row.timeout_seconds).toBe(60);
      expect(row.tool_access).toBe('["vault_search","vault_read"]');
      expect(row.enabled).toBe(0);
      expect(row.updated_at).toBe(now);
    });

    it('upserts on conflict — updates name and optional fields', async () => {
      const data = makeAgent({ name: 'Original Name' });
      await registerAgent(data);

      const updated = await registerAgent({
        ...data,
        name: 'Updated Name',
        provider: 'anthropic',
        model: 'claude-3',
      });

      expect(updated.id).toBe(data.id);
      expect(updated.name).toBe('Updated Name');
      expect(updated.provider).toBe('anthropic');
      expect(updated.model).toBe('claude-3');
    });

    it('is idempotent — same data produces same result', async () => {
      const data = makeAgent({ name: 'Idempotent' });
      const first = await registerAgent(data);
      const second = await registerAgent(data);

      expect(first).toEqual(second);
    });
  });

  // ---------------------------------------------------------------------------
  // getAgent
  // ---------------------------------------------------------------------------

  describe('getAgent', () => {
    it('returns null for non-existent id', async () => {
      const row = await getAgent('does-not-exist');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listAgents
  // ---------------------------------------------------------------------------

  describe('listAgents', () => {
    it('returns agents ordered by created_at ASC', async () => {
      const now = epochNow();
      await registerAgent(makeAgent({ id: 'agent-old', created_at: now - 100 }));
      await registerAgent(makeAgent({ id: 'agent-mid', created_at: now - 50 }));
      await registerAgent(makeAgent({ id: 'agent-new', created_at: now }));

      const rows = await listAgents();
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('agent-old');
      expect(rows[1].id).toBe('agent-mid');
      expect(rows[2].id).toBe('agent-new');
    });

    it('returns empty array when no agents exist', async () => {
      const rows = await listAgents();
      expect(rows).toEqual([]);
    });
  });
});
