/**
 * Tests for agent state query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  getState,
  setState,
  getStatesForCurator,
} from '@myco/db/queries/agent-state.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Insert a curator directly into the curators table and return its id. */
async function createCurator(id: string): Promise<string> {
  const db = getDatabase();
  const now = epochNow();
  await db.query(
    `INSERT INTO curators (id, name, created_at) VALUES ($1, $2, $3)`,
    [id, `curator-${id}`, now],
  );
  return id;
}

describe('agent state query helpers', () => {
  let curatorId: string;

  beforeEach(async () => {
    const db = await initDatabase(); // in-memory
    await createSchema(db);

    // Create a curator for FK references
    curatorId = await createCurator('curator-test');
  });

  afterEach(async () => {
    await closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // setState + getState
  // ---------------------------------------------------------------------------

  describe('setState', () => {
    it('sets a new key-value pair and retrieves it', async () => {
      const now = epochNow();
      const row = await setState(curatorId, 'last_run', '2026-03-22', now);

      expect(row.curator_id).toBe(curatorId);
      expect(row.key).toBe('last_run');
      expect(row.value).toBe('2026-03-22');
      expect(row.updated_at).toBe(now);

      const fetched = await getState(curatorId, 'last_run');
      expect(fetched).not.toBeNull();
      expect(fetched!.value).toBe('2026-03-22');
    });

    it('overwrites existing value on conflict', async () => {
      const now = epochNow();
      await setState(curatorId, 'counter', '1', now);

      const laterTime = now + 10;
      const updated = await setState(curatorId, 'counter', '2', laterTime);

      expect(updated.value).toBe('2');
      expect(updated.updated_at).toBe(laterTime);

      const fetched = await getState(curatorId, 'counter');
      expect(fetched).not.toBeNull();
      expect(fetched!.value).toBe('2');
    });

    it('is idempotent — same data produces same result', async () => {
      const now = epochNow();
      const first = await setState(curatorId, 'mode', 'active', now);
      const second = await setState(curatorId, 'mode', 'active', now);

      expect(first).toEqual(second);
    });

    it('handles different curators with same key independently', async () => {
      const curatorId2 = await createCurator('curator-other');
      const now = epochNow();

      await setState(curatorId, 'theme', 'dark', now);
      await setState(curatorId2, 'theme', 'light', now);

      const state1 = await getState(curatorId, 'theme');
      const state2 = await getState(curatorId2, 'theme');

      expect(state1!.value).toBe('dark');
      expect(state2!.value).toBe('light');
    });
  });

  // ---------------------------------------------------------------------------
  // getState
  // ---------------------------------------------------------------------------

  describe('getState', () => {
    it('returns null for non-existent key', async () => {
      const row = await getState(curatorId, 'nonexistent');
      expect(row).toBeNull();
    });

    it('returns null for non-existent curator', async () => {
      const row = await getState('no-such-curator', 'key');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getStatesForCurator
  // ---------------------------------------------------------------------------

  describe('getStatesForCurator', () => {
    it('returns all key-value pairs for a curator', async () => {
      const now = epochNow();
      await setState(curatorId, 'alpha', 'one', now);
      await setState(curatorId, 'beta', 'two', now + 1);
      await setState(curatorId, 'gamma', 'three', now + 2);

      const rows = await getStatesForCurator(curatorId);
      expect(rows).toHaveLength(3);

      // Verify all expected keys are present
      const keys = rows.map((r) => r.key);
      expect(keys).toContain('alpha');
      expect(keys).toContain('beta');
      expect(keys).toContain('gamma');
    });

    it('does not include state from other curators', async () => {
      const curatorId2 = await createCurator('curator-other');
      const now = epochNow();

      await setState(curatorId, 'shared_key', 'value1', now);
      await setState(curatorId2, 'shared_key', 'value2', now);
      await setState(curatorId2, 'extra', 'value3', now);

      const rows = await getStatesForCurator(curatorId);
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe('shared_key');
      expect(rows[0].value).toBe('value1');
    });

    it('returns empty array when curator has no state', async () => {
      const rows = await getStatesForCurator(curatorId);
      expect(rows).toEqual([]);
    });

    it('returns rows ordered by key ASC', async () => {
      const now = epochNow();
      await setState(curatorId, 'zebra', 'z', now);
      await setState(curatorId, 'apple', 'a', now);
      await setState(curatorId, 'mango', 'm', now);

      const rows = await getStatesForCurator(curatorId);
      expect(rows).toHaveLength(3);
      expect(rows[0].key).toBe('apple');
      expect(rows[1].key).toBe('mango');
      expect(rows[2].key).toBe('zebra');
    });
  });
});
