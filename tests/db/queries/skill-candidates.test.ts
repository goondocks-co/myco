/**
 * Tests for skill candidate CRUD query helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import {
  insertCandidate,
  getCandidate,
  listCandidates,
  updateCandidate,
  countCandidates,
} from '@myco/db/queries/skill-candidates.js';
import type { CandidateInsert } from '@myco/db/queries/skill-candidates.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Factory for minimal valid candidate data. */
function makeCandidate(overrides: Partial<CandidateInsert> = {}): CandidateInsert {
  const now = epochNow();
  return {
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    agent_id: 'agent-test',
    topic: 'Use vitest for unit tests',
    rationale: 'Observed repeated test setup patterns across sessions',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('skill candidate query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();

    // Register the default agent for FK references
    registerAgent({
      id: 'agent-test',
      name: 'Test Agent',
      created_at: epochNow(),
    });
  });

  // ---------------------------------------------------------------------------
  // insertCandidate + getCandidate
  // ---------------------------------------------------------------------------

  describe('insertCandidate', () => {
    it('inserts a new candidate and retrieves it', () => {
      const data = makeCandidate({ topic: 'Extract reusable DB helpers' });
      const row = insertCandidate(data);

      expect(row.id).toBe(data.id);
      expect(row.agent_id).toBe('agent-test');
      expect(row.topic).toBe('Extract reusable DB helpers');
      expect(row.rationale).toBe(data.rationale);
      expect(row.status).toBe('identified');
      expect(row.confidence).toBe(0.0);
      expect(row.source_ids).toBe('[]');
      expect(row.skill_id).toBeNull();

      const fetched = getCandidate(data.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
      expect(fetched!.topic).toBe('Extract reusable DB helpers');
    });

    it('stores optional fields when provided', () => {
      const data = makeCandidate({
        confidence: 0.85,
        status: 'promoted',
        source_ids: '["sess-abc","sess-def"]',
        skill_id: 'skill-xyz',
      });
      const row = insertCandidate(data);

      expect(row.confidence).toBe(0.85);
      expect(row.status).toBe('promoted');
      expect(row.source_ids).toBe('["sess-abc","sess-def"]');
      expect(row.skill_id).toBe('skill-xyz');
    });

    it('uses defaults when optional fields are omitted', () => {
      const data = makeCandidate();
      const row = insertCandidate(data);

      expect(row.confidence).toBe(0.0);
      expect(row.status).toBe('identified');
      expect(row.source_ids).toBe('[]');
      expect(row.skill_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getCandidate
  // ---------------------------------------------------------------------------

  describe('getCandidate', () => {
    it('returns null for non-existent id', () => {
      const row = getCandidate('does-not-exist');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listCandidates
  // ---------------------------------------------------------------------------

  describe('listCandidates', () => {
    it('returns candidates ordered by confidence DESC, created_at DESC', () => {
      const now = epochNow();
      insertCandidate(makeCandidate({ id: 'cand-lo', confidence: 0.3, created_at: now }));
      insertCandidate(makeCandidate({ id: 'cand-hi', confidence: 0.9, created_at: now + 1 }));
      insertCandidate(makeCandidate({ id: 'cand-mid', confidence: 0.6, created_at: now + 2 }));

      const rows = listCandidates();
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('cand-hi');
      expect(rows[1].id).toBe('cand-mid');
      expect(rows[2].id).toBe('cand-lo');
    });

    it('filters by status', () => {
      const now = epochNow();
      insertCandidate(makeCandidate({ id: 'cand-identified', status: 'identified', created_at: now }));
      insertCandidate(makeCandidate({ id: 'cand-promoted', status: 'promoted', created_at: now + 1 }));
      insertCandidate(makeCandidate({ id: 'cand-rejected', status: 'rejected', created_at: now + 2 }));

      const rows = listCandidates({ status: 'identified' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('cand-identified');
    });

    it('filters by agent_id', () => {
      // Register a second agent
      registerAgent({ id: 'agent-other', name: 'Other Agent', created_at: epochNow() });

      const now = epochNow();
      insertCandidate(makeCandidate({ id: 'cand-a1', agent_id: 'agent-test', created_at: now }));
      insertCandidate(makeCandidate({ id: 'cand-a2', agent_id: 'agent-other', created_at: now + 1 }));

      const rows = listCandidates({ agent_id: 'agent-test' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('cand-a1');
    });

    it('combines agent_id and status filters', () => {
      registerAgent({ id: 'agent-combo', name: 'Combo Agent', created_at: epochNow() });

      const now = epochNow();
      insertCandidate(makeCandidate({ id: 'c1', agent_id: 'agent-test', status: 'identified', created_at: now }));
      insertCandidate(makeCandidate({ id: 'c2', agent_id: 'agent-test', status: 'promoted', created_at: now + 1 }));
      insertCandidate(makeCandidate({ id: 'c3', agent_id: 'agent-combo', status: 'identified', created_at: now + 2 }));

      const rows = listCandidates({ agent_id: 'agent-test', status: 'identified' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('c1');
    });

    it('respects limit and offset', () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        insertCandidate(makeCandidate({ confidence: i * 0.1, created_at: now + i }));
      }

      const page1 = listCandidates({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = listCandidates({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      const page3 = listCandidates({ limit: 2, offset: 4 });
      expect(page3).toHaveLength(1);
    });

    it('returns empty array when no candidates match', () => {
      const rows = listCandidates({ status: 'nonexistent' });
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // updateCandidate
  // ---------------------------------------------------------------------------

  describe('updateCandidate', () => {
    it('updates topic and rationale', () => {
      const data = makeCandidate();
      insertCandidate(data);

      const now = epochNow() + 10;
      const row = updateCandidate(data.id, {
        topic: 'Updated topic',
        rationale: 'New rationale after more evidence',
        updated_at: now,
      });

      expect(row).not.toBeNull();
      expect(row!.topic).toBe('Updated topic');
      expect(row!.rationale).toBe('New rationale after more evidence');
      expect(row!.updated_at).toBe(now);
    });

    it('updates status and confidence', () => {
      const data = makeCandidate({ confidence: 0.4 });
      insertCandidate(data);

      const now = epochNow() + 10;
      const row = updateCandidate(data.id, {
        status: 'promoted',
        confidence: 0.92,
        updated_at: now,
      });

      expect(row).not.toBeNull();
      expect(row!.status).toBe('promoted');
      expect(row!.confidence).toBe(0.92);
    });

    it('updates skill_id and source_ids', () => {
      const data = makeCandidate();
      insertCandidate(data);

      const now = epochNow() + 10;
      const row = updateCandidate(data.id, {
        skill_id: 'skill-abc',
        source_ids: '["sess-1","sess-2"]',
        updated_at: now,
      });

      expect(row).not.toBeNull();
      expect(row!.skill_id).toBe('skill-abc');
      expect(row!.source_ids).toBe('["sess-1","sess-2"]');
    });

    it('returns null for non-existent candidate', () => {
      const result = updateCandidate('nope', { updated_at: epochNow() });
      expect(result).toBeNull();
    });

    it('preserves unmodified fields', () => {
      const data = makeCandidate({ topic: 'Original topic', confidence: 0.5 });
      insertCandidate(data);

      const now = epochNow() + 10;
      const row = updateCandidate(data.id, { status: 'rejected', updated_at: now });

      expect(row).not.toBeNull();
      expect(row!.topic).toBe('Original topic');
      expect(row!.confidence).toBe(0.5);
      expect(row!.status).toBe('rejected');
    });

    it('auto-sets approved_at on first transition to approved', () => {
      const data = makeCandidate();
      const inserted = insertCandidate(data);
      expect(inserted.approved_at).toBeNull();

      const t1 = epochNow() + 100;
      const row = updateCandidate(data.id, { status: 'approved', updated_at: t1 });
      expect(row).not.toBeNull();
      expect(row!.status).toBe('approved');
      expect(row!.approved_at).toBe(t1);
    });

    it('does not overwrite approved_at on subsequent updates', () => {
      const data = makeCandidate();
      insertCandidate(data);

      const t1 = epochNow() + 100;
      updateCandidate(data.id, { status: 'approved', updated_at: t1 });

      // Unrelated update — should not touch approved_at
      const t2 = t1 + 50;
      updateCandidate(data.id, { topic: 'Renamed', updated_at: t2 });
      expect(getCandidate(data.id)!.approved_at).toBe(t1);

      // Re-setting status to approved (no-op in practice) — must not overwrite
      const t3 = t1 + 100;
      updateCandidate(data.id, { status: 'approved', updated_at: t3 });
      expect(getCandidate(data.id)!.approved_at).toBe(t1);
    });

    it('leaves approved_at null for candidates never approved', () => {
      const data = makeCandidate();
      insertCandidate(data);

      updateCandidate(data.id, { status: 'dismissed', updated_at: epochNow() + 10 });
      expect(getCandidate(data.id)!.approved_at).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // countCandidates
  // ---------------------------------------------------------------------------

  describe('countCandidates', () => {
    it('counts all candidates when no filters given', () => {
      const now = epochNow();
      insertCandidate(makeCandidate({ created_at: now }));
      insertCandidate(makeCandidate({ created_at: now + 1 }));
      insertCandidate(makeCandidate({ created_at: now + 2 }));

      expect(countCandidates()).toBe(3);
    });

    it('counts candidates matching a status filter', () => {
      const now = epochNow();
      insertCandidate(makeCandidate({ status: 'identified', created_at: now }));
      insertCandidate(makeCandidate({ status: 'identified', created_at: now + 1 }));
      insertCandidate(makeCandidate({ status: 'promoted', created_at: now + 2 }));

      expect(countCandidates({ status: 'identified' })).toBe(2);
      expect(countCandidates({ status: 'promoted' })).toBe(1);
      expect(countCandidates({ status: 'rejected' })).toBe(0);
    });

    it('counts candidates matching a multi-status filter', () => {
      const now = epochNow();
      insertCandidate(makeCandidate({ status: 'identified', created_at: now }));
      insertCandidate(makeCandidate({ status: 'approved', created_at: now + 1 }));
      insertCandidate(makeCandidate({ status: 'generated', created_at: now + 2 }));
      insertCandidate(makeCandidate({ status: 'dismissed', created_at: now + 3 }));

      expect(countCandidates({ statuses: ['approved', 'generated'] })).toBe(2);
      expect(countCandidates({ statuses: ['identified', 'dismissed'] })).toBe(2);
      expect(countCandidates({ statuses: ['approved'] })).toBe(1);
      expect(countCandidates({ statuses: [] })).toBe(4); // empty list = no filter
    });

    it('lists candidates matching a multi-status filter', () => {
      const now = epochNow();
      insertCandidate(makeCandidate({ id: 'cand-q-id', status: 'identified', created_at: now }));
      insertCandidate(makeCandidate({ id: 'cand-q-ap', status: 'approved', created_at: now + 1 }));
      insertCandidate(makeCandidate({ id: 'cand-q-gn', status: 'generated', created_at: now + 2 }));

      const rows = listCandidates({ statuses: ['approved', 'generated'] });
      expect(rows.map((r) => r.id).sort()).toEqual(['cand-q-ap', 'cand-q-gn']);
    });

    it('counts candidates matching an agent_id filter', () => {
      registerAgent({ id: 'agent-count', name: 'Count Agent', created_at: epochNow() });

      const now = epochNow();
      insertCandidate(makeCandidate({ agent_id: 'agent-test', created_at: now }));
      insertCandidate(makeCandidate({ agent_id: 'agent-test', created_at: now + 1 }));
      insertCandidate(makeCandidate({ agent_id: 'agent-count', created_at: now + 2 }));

      expect(countCandidates({ agent_id: 'agent-test' })).toBe(2);
      expect(countCandidates({ agent_id: 'agent-count' })).toBe(1);
    });
  });
});
