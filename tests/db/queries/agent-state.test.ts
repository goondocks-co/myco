/**
 * Tests for agent state query helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import {
  getState,
  setState,
  getStatesForAgent,
} from '@myco/db/queries/agent-state.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Insert an agent directly into the agents table and return its id. */
function createAgent(id: string): string {
  const db = getDatabase();
  const now = epochNow();
  db.prepare(
    `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, `agent-${id}`, now);
  return id;
}

describe('agent state query helpers', () => {
  let agentId: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();

    // Create an agent for FK references
    agentId = createAgent('agent-test');
  });

  // ---------------------------------------------------------------------------
  // setState + getState
  // ---------------------------------------------------------------------------

  describe('setState', () => {
    it('sets a new key-value pair and retrieves it', () => {
      const now = epochNow();
      const row = setState(agentId, 'last_run', '2026-03-22', now);

      expect(row.agent_id).toBe(agentId);
      expect(row.key).toBe('last_run');
      expect(row.value).toBe('2026-03-22');
      expect(row.updated_at).toBe(now);

      const fetched = getState(agentId, 'last_run');
      expect(fetched).not.toBeNull();
      expect(fetched!.value).toBe('2026-03-22');
    });

    it('overwrites existing value on conflict', () => {
      const now = epochNow();
      setState(agentId, 'counter', '1', now);

      const laterTime = now + 10;
      const updated = setState(agentId, 'counter', '2', laterTime);

      expect(updated.value).toBe('2');
      expect(updated.updated_at).toBe(laterTime);

      const fetched = getState(agentId, 'counter');
      expect(fetched).not.toBeNull();
      expect(fetched!.value).toBe('2');
    });

    it('is idempotent — same data produces same result', () => {
      const now = epochNow();
      const first = setState(agentId, 'mode', 'active', now);
      const second = setState(agentId, 'mode', 'active', now);

      expect(first).toEqual(second);
    });

    it('handles different agents with same key independently', () => {
      const agentId2 = createAgent('agent-other');
      const now = epochNow();

      setState(agentId, 'theme', 'dark', now);
      setState(agentId2, 'theme', 'light', now);

      const state1 = getState(agentId, 'theme');
      const state2 = getState(agentId2, 'theme');

      expect(state1!.value).toBe('dark');
      expect(state2!.value).toBe('light');
    });
  });

  // ---------------------------------------------------------------------------
  // getState
  // ---------------------------------------------------------------------------

  describe('getState', () => {
    it('returns null for non-existent key', () => {
      const row = getState(agentId, 'nonexistent');
      expect(row).toBeNull();
    });

    it('returns null for non-existent agent', () => {
      const row = getState('no-such-agent', 'key');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getStatesForAgent
  // ---------------------------------------------------------------------------

  describe('getStatesForAgent', () => {
    it('returns all key-value pairs for an agent', () => {
      const now = epochNow();
      setState(agentId, 'alpha', 'one', now);
      setState(agentId, 'beta', 'two', now + 1);
      setState(agentId, 'gamma', 'three', now + 2);

      const rows = getStatesForAgent(agentId);
      expect(rows).toHaveLength(3);

      // Verify all expected keys are present
      const keys = rows.map((r) => r.key);
      expect(keys).toContain('alpha');
      expect(keys).toContain('beta');
      expect(keys).toContain('gamma');
    });

    it('does not include state from other agents', () => {
      const agentId2 = createAgent('agent-other');
      const now = epochNow();

      setState(agentId, 'shared_key', 'value1', now);
      setState(agentId2, 'shared_key', 'value2', now);
      setState(agentId2, 'extra', 'value3', now);

      const rows = getStatesForAgent(agentId);
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe('shared_key');
      expect(rows[0].value).toBe('value1');
    });

    it('returns empty array when agent has no state', () => {
      const rows = getStatesForAgent(agentId);
      expect(rows).toEqual([]);
    });

    it('returns rows ordered by key ASC', () => {
      const now = epochNow();
      setState(agentId, 'zebra', 'z', now);
      setState(agentId, 'apple', 'a', now);
      setState(agentId, 'mango', 'm', now);

      const rows = getStatesForAgent(agentId);
      expect(rows).toHaveLength(3);
      expect(rows[0].key).toBe('apple');
      expect(rows[1].key).toBe('mango');
      expect(rows[2].key).toBe('zebra');
    });
  });
});
