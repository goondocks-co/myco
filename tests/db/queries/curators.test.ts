/**
 * Tests for curator CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  registerCurator,
  getCurator,
  listCurators,
} from '@myco/db/queries/curators.js';
import type { CuratorInsert } from '@myco/db/queries/curators.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Factory for minimal valid curator data. */
function makeCurator(overrides: Partial<CuratorInsert> = {}): CuratorInsert {
  const now = epochNow();
  return {
    id: `curator-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test Curator',
    created_at: now,
    ...overrides,
  };
}

describe('curator query helpers', () => {
  beforeEach(async () => {
    const db = await initDatabase(); // in-memory
    await createSchema(db);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // registerCurator + getCurator
  // ---------------------------------------------------------------------------

  describe('registerCurator', () => {
    it('inserts a new curator and retrieves it', async () => {
      const data = makeCurator({ name: 'Digest Curator' });
      const row = await registerCurator(data);

      expect(row.id).toBe(data.id);
      expect(row.name).toBe('Digest Curator');
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

      const fetched = await getCurator(data.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
      expect(fetched!.name).toBe('Digest Curator');
    });

    it('stores all optional fields including Phase 2 columns', async () => {
      const now = epochNow();
      const data = makeCurator({
        name: 'Full Curator',
        provider: 'ollama',
        model: 'bge-m3',
        system_prompt_hash: 'hash-xyz',
        config: '{"temperature": 0.7}',
        source: 'user',
        system_prompt: 'You are a specialized curator.',
        max_turns: 10,
        timeout_seconds: 60,
        tool_access: '["vault_search","vault_read"]',
        enabled: 0,
        updated_at: now,
      });
      const row = await registerCurator(data);

      expect(row.provider).toBe('ollama');
      expect(row.model).toBe('bge-m3');
      expect(row.system_prompt_hash).toBe('hash-xyz');
      expect(row.config).toBe('{"temperature": 0.7}');
      expect(row.source).toBe('user');
      expect(row.system_prompt).toBe('You are a specialized curator.');
      expect(row.max_turns).toBe(10);
      expect(row.timeout_seconds).toBe(60);
      expect(row.tool_access).toBe('["vault_search","vault_read"]');
      expect(row.enabled).toBe(0);
      expect(row.updated_at).toBe(now);
    });

    it('upserts on conflict — updates name and optional fields', async () => {
      const data = makeCurator({ name: 'Original Name' });
      await registerCurator(data);

      const updated = await registerCurator({
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
      const data = makeCurator({ name: 'Idempotent' });
      const first = await registerCurator(data);
      const second = await registerCurator(data);

      expect(first).toEqual(second);
    });
  });

  // ---------------------------------------------------------------------------
  // getCurator
  // ---------------------------------------------------------------------------

  describe('getCurator', () => {
    it('returns null for non-existent id', async () => {
      const row = await getCurator('does-not-exist');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listCurators
  // ---------------------------------------------------------------------------

  describe('listCurators', () => {
    it('returns curators ordered by created_at ASC', async () => {
      const now = epochNow();
      await registerCurator(makeCurator({ id: 'curator-old', created_at: now - 100 }));
      await registerCurator(makeCurator({ id: 'curator-mid', created_at: now - 50 }));
      await registerCurator(makeCurator({ id: 'curator-new', created_at: now }));

      const rows = await listCurators();
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('curator-old');
      expect(rows[1].id).toBe('curator-mid');
      expect(rows[2].id).toBe('curator-new');
    });

    it('returns empty array when no curators exist', async () => {
      const rows = await listCurators();
      expect(rows).toEqual([]);
    });
  });
});
