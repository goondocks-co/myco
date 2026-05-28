/**
 * Tests for the per-phase mechanical preCondition resolver.
 *
 * The resolver is the deterministic gate that runs before harness
 * invocation. The phase-loop integration is exercised separately in
 * tests/agent/phase-loop.test.ts; this file focuses on the resolver
 * contract — kind → SQL → boolean.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { insertSpore, type SporeInsert } from '@myco/db/queries/spores.js';
import {
  checkPhasePreCondition,
  RECENT_SPORE_ACTIVITY_MIN_COUNT,
  RECENT_SPORE_ACTIVITY_WINDOW_SECONDS,
} from '@myco/agent/phase-preconditions.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const epochNow = () => Math.floor(Date.now() / 1000);

function createAgent(id: string): string {
  const db = getDatabase();
  db.prepare(`INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`)
    .run(id, `agent-${id}`, epochNow());
  return id;
}

function makeSpore(agentId: string, overrides: Partial<SporeInsert> = {}): SporeInsert {
  const now = epochNow();
  return {
    id: `spore_${Math.random().toString(36).slice(2, 10)}`,
    agent_id: agentId,
    observation_type: 'discovery',
    status: 'active',
    content: 'test content',
    importance: 5,
    created_at: now,
    ...overrides,
  };
}

/**
 * Mark a spore as embedded post-insert. The insertSpore helper doesn't
 * touch the embedded column (defaults to 0), so tests that need to
 * exercise the embedded=1 filter set it explicitly.
 */
function markEmbedded(id: string): void {
  getDatabase().prepare(`UPDATE spores SET embedded = 1 WHERE id = ?`).run(id);
}

function insertSporeEmbedded(insert: SporeInsert): void {
  insertSpore(insert);
  markEmbedded(insert.id);
}

describe('checkPhasePreCondition', () => {
  let agentId: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    agentId = createAgent('agent-pp-test');
  });

  describe('has-recent-spore-activity', () => {
    it('passes when active spore count meets the minimum', () => {
      const now = epochNow();
      for (let i = 0; i < RECENT_SPORE_ACTIVITY_MIN_COUNT; i++) {
        insertSpore(makeSpore(agentId, { created_at: now - 60 }));
      }
      const result = checkPhasePreCondition('has-recent-spore-activity', ALL_PROJECTS_SCOPE);
      expect(result.passed).toBe(true);
      expect(result.reason).toContain(String(RECENT_SPORE_ACTIVITY_MIN_COUNT));
    });

    it('fails when there are no recent spores', () => {
      const result = checkPhasePreCondition('has-recent-spore-activity', ALL_PROJECTS_SCOPE);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('0');
      expect(result.reason).toContain(String(RECENT_SPORE_ACTIVITY_MIN_COUNT));
    });

    it('fails when active spore count is below the minimum', () => {
      const now = epochNow();
      for (let i = 0; i < RECENT_SPORE_ACTIVITY_MIN_COUNT - 1; i++) {
        insertSpore(makeSpore(agentId, { created_at: now - 60 }));
      }
      const result = checkPhasePreCondition('has-recent-spore-activity', ALL_PROJECTS_SCOPE);
      expect(result.passed).toBe(false);
    });

    it('excludes spores older than the activity window', () => {
      const now = epochNow();
      const beforeWindow = now - RECENT_SPORE_ACTIVITY_WINDOW_SECONDS - 60;
      for (let i = 0; i < RECENT_SPORE_ACTIVITY_MIN_COUNT * 2; i++) {
        insertSpore(makeSpore(agentId, { created_at: beforeWindow }));
      }
      const result = checkPhasePreCondition('has-recent-spore-activity', ALL_PROJECTS_SCOPE);
      expect(result.passed).toBe(false);
    });

    it('excludes superseded spores from the count', () => {
      const now = epochNow();
      // 1 active, 5 superseded — should fail despite the 5 being recent
      insertSpore(makeSpore(agentId, { created_at: now - 60, status: 'active' }));
      for (let i = 0; i < 5; i++) {
        insertSpore(makeSpore(agentId, { created_at: now - 60, status: 'superseded' }));
      }
      const result = checkPhasePreCondition('has-recent-spore-activity', ALL_PROJECTS_SCOPE);
      expect(result.passed).toBe(false);
    });
  });

  describe('has-recent-consolidatable-spores', () => {
    it('passes when ≥3 active, non-wisdom, embedded spores exist in the window', () => {
      const now = epochNow();
      for (let i = 0; i < RECENT_SPORE_ACTIVITY_MIN_COUNT; i++) {
        insertSporeEmbedded(makeSpore(agentId, {
          created_at: now - 60,
          observation_type: 'discovery',
        }));
      }
      const result = checkPhasePreCondition('has-recent-consolidatable-spores', ALL_PROJECTS_SCOPE);
      expect(result.passed).toBe(true);
      expect(result.reason).toContain('consolidatable');
    });

    it('excludes wisdom spores — cannot consolidate wisdoms into more wisdom', () => {
      const now = epochNow();
      // 5 wisdom spores: plenty of activity, but nothing the consolidate
      // phase could legitimately roll up.
      for (let i = 0; i < 5; i++) {
        insertSporeEmbedded(makeSpore(agentId, {
          created_at: now - 60,
          observation_type: 'wisdom',
        }));
      }
      const result = checkPhasePreCondition('has-recent-consolidatable-spores', ALL_PROJECTS_SCOPE);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('non-wisdom');
    });

    it('excludes un-embedded spores — semantic search cannot return them', () => {
      const now = epochNow();
      // 5 non-wisdom spores but none embedded yet (just created by extract,
      // embedding queued in deep_sleep). vault_search_semantic would return
      // nothing, so the LLM phase would no-op.
      for (let i = 0; i < 5; i++) {
        insertSpore(makeSpore(agentId, {
          created_at: now - 60,
          observation_type: 'discovery',
        }));
      }
      const result = checkPhasePreCondition('has-recent-consolidatable-spores', ALL_PROJECTS_SCOPE);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('embedded');
    });

    it('mixed pool: counts only the rows that pass all three filters', () => {
      const now = epochNow();
      // 2 qualifying (active, non-wisdom, embedded) — below threshold
      insertSporeEmbedded(makeSpore(agentId, { created_at: now - 60, observation_type: 'discovery' }));
      insertSporeEmbedded(makeSpore(agentId, { created_at: now - 60, observation_type: 'gotcha' }));
      // Disqualified for various reasons:
      insertSporeEmbedded(makeSpore(agentId, { created_at: now - 60, observation_type: 'wisdom' })); // wisdom
      insertSpore(makeSpore(agentId, { created_at: now - 60, observation_type: 'discovery' })); // not embedded
      insertSporeEmbedded(makeSpore(agentId, { created_at: now - 60, observation_type: 'discovery', status: 'superseded' })); // superseded
      const result = checkPhasePreCondition('has-recent-consolidatable-spores', ALL_PROJECTS_SCOPE);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Only 2');
    });

    it('excludes spores older than the activity window', () => {
      const now = epochNow();
      const beforeWindow = now - RECENT_SPORE_ACTIVITY_WINDOW_SECONDS - 60;
      for (let i = 0; i < RECENT_SPORE_ACTIVITY_MIN_COUNT * 2; i++) {
        insertSporeEmbedded(makeSpore(agentId, {
          created_at: beforeWindow,
          observation_type: 'discovery',
        }));
      }
      const result = checkPhasePreCondition('has-recent-consolidatable-spores', ALL_PROJECTS_SCOPE);
      expect(result.passed).toBe(false);
    });
  });
});
