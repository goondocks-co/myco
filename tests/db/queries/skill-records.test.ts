/**
 * Tests for skill record CRUD query helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertCandidate } from '@myco/db/queries/skill-candidates.js';
import {
  insertSkillRecord,
  getSkillRecord,
  getSkillRecordByName,
  listSkillRecords,
  updateSkillRecord,
  countSkillRecords,
} from '@myco/db/queries/skill-records.js';
import type { SkillRecordInsert } from '@myco/db/queries/skill-records.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Factory for minimal valid skill record data. */
function makeSkillRecord(overrides: Partial<SkillRecordInsert> = {}): SkillRecordInsert {
  const now = epochNow();
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `use-vitest-${suffix}`;
  return {
    id: `skill-${suffix}`,
    agent_id: 'agent-test',
    name,
    display_name: 'Use Vitest',
    description: 'Prefer vitest for unit tests',
    path: `.myco/skills/${name}.md`,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('skill record query helpers', () => {
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
  // insertSkillRecord + getSkillRecord
  // ---------------------------------------------------------------------------

  describe('insertSkillRecord', () => {
    it('inserts a new record and retrieves it', () => {
      const data = makeSkillRecord({ display_name: 'Extract reusable DB helpers' });
      const row = insertSkillRecord(data);

      expect(row.id).toBe(data.id);
      expect(row.project_id).toBeNull();
      expect(row.agent_id).toBe('agent-test');
      expect(row.name).toBe(data.name);
      expect(row.display_name).toBe('Extract reusable DB helpers');
      expect(row.description).toBe(data.description);
      expect(row.path).toBe(data.path);
      expect(row.status).toBe('active');
      expect(row.generation).toBe(1);
      expect(row.candidate_id).toBeNull();
      expect(row.source_ids).toBe('[]');
      expect(row.usage_count).toBe(0);
      expect(row.last_used_at).toBeNull();
      expect(row.properties).toBe('{}');

      const fetched = getSkillRecord(data.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
      expect(fetched!.display_name).toBe('Extract reusable DB helpers');
    });

    it('stores optional fields when provided', () => {
      // Insert a real candidate so the FK constraint is satisfied
      const now = epochNow();
      const cand = insertCandidate({
        id: 'cand-abc',
        agent_id: 'agent-test',
        topic: 'Test candidate',
        rationale: 'For FK test',
        created_at: now,
        updated_at: now,
      });

      const data = makeSkillRecord({
        status: 'deprecated',
        generation: 3,
        candidate_id: cand.id,
        source_ids: '["sess-abc","sess-def"]',
        properties: '{"tags":["testing"]}',
      });
      const row = insertSkillRecord(data);

      expect(row.status).toBe('deprecated');
      expect(row.generation).toBe(3);
      expect(row.candidate_id).toBe('cand-abc');
      expect(row.source_ids).toBe('["sess-abc","sess-def"]');
      expect(row.properties).toBe('{"tags":["testing"]}');
    });

    it('uses defaults when optional fields are omitted', () => {
      const data = makeSkillRecord();
      const row = insertSkillRecord(data);

      expect(row.status).toBe('active');
      expect(row.generation).toBe(1);
      expect(row.candidate_id).toBeNull();
      expect(row.source_ids).toBe('[]');
      expect(row.properties).toBe('{}');
    });
  });

  // ---------------------------------------------------------------------------
  // getSkillRecord
  // ---------------------------------------------------------------------------

  describe('getSkillRecord', () => {
    it('returns null for non-existent id', () => {
      const row = getSkillRecord('does-not-exist');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getSkillRecordByName
  // ---------------------------------------------------------------------------

  describe('getSkillRecordByName', () => {
    it('retrieves a record by its unique name', () => {
      const data = makeSkillRecord({ name: 'use-typed-errors', path: '.myco/skills/use-typed-errors.md' });
      insertSkillRecord(data);

      const fetched = getSkillRecordByName('use-typed-errors');
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
      expect(fetched!.name).toBe('use-typed-errors');
    });

    it('retrieves records with the same name by project scope', () => {
      const name = 'use-project-scope';
      insertSkillRecord(makeSkillRecord({
        id: 'skill-project-a',
        project_id: 'proj_a',
        name,
        path: '.myco/skills/a.md',
      }));
      insertSkillRecord(makeSkillRecord({
        id: 'skill-project-b',
        project_id: 'proj_b',
        name,
        path: '.myco/skills/b.md',
      }));

      expect(getSkillRecordByName(name)).toBeNull();
      expect(getSkillRecordByName(name, 'proj_a')!.id).toBe('skill-project-a');
      expect(getSkillRecordByName(name, 'proj_b')!.id).toBe('skill-project-b');
    });

    it('returns null for non-existent name', () => {
      const row = getSkillRecordByName('no-such-skill');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listSkillRecords
  // ---------------------------------------------------------------------------

  describe('listSkillRecords', () => {
    it('returns records ordered by updated_at DESC', () => {
      const now = epochNow();
      insertSkillRecord(makeSkillRecord({ id: 'skill-old', updated_at: now }));
      insertSkillRecord(makeSkillRecord({ id: 'skill-new', updated_at: now + 2 }));
      insertSkillRecord(makeSkillRecord({ id: 'skill-mid', updated_at: now + 1 }));

      const rows = listSkillRecords();
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('skill-new');
      expect(rows[1].id).toBe('skill-mid');
      expect(rows[2].id).toBe('skill-old');
    });

    it('filters by status', () => {
      const now = epochNow();
      insertSkillRecord(makeSkillRecord({ id: 'skill-active', status: 'active', updated_at: now }));
      insertSkillRecord(makeSkillRecord({ id: 'skill-deprecated', status: 'deprecated', updated_at: now + 1 }));
      insertSkillRecord(makeSkillRecord({ id: 'skill-archived', status: 'archived', updated_at: now + 2 }));

      const rows = listSkillRecords({ status: 'active' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('skill-active');
    });

    it('filters by agent_id', () => {
      registerAgent({ id: 'agent-other', name: 'Other Agent', created_at: epochNow() });

      const now = epochNow();
      insertSkillRecord(makeSkillRecord({ id: 'skill-a1', agent_id: 'agent-test', updated_at: now }));
      insertSkillRecord(makeSkillRecord({ id: 'skill-a2', agent_id: 'agent-other', updated_at: now + 1 }));

      const rows = listSkillRecords({ agent_id: 'agent-test' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('skill-a1');
    });

    it('filters by project_id when requested', () => {
      const now = epochNow();
      insertSkillRecord(makeSkillRecord({ id: 'skill-legacy', project_id: null, updated_at: now }));
      insertSkillRecord(makeSkillRecord({ id: 'skill-project-a', project_id: 'proj_a', updated_at: now + 1 }));
      insertSkillRecord(makeSkillRecord({ id: 'skill-project-b', project_id: 'proj_b', updated_at: now + 2 }));

      expect(listSkillRecords({ project_id: null }).map((r) => r.id)).toEqual(['skill-legacy']);
      expect(listSkillRecords({ project_id: 'proj_a' }).map((r) => r.id)).toEqual(['skill-project-a']);
    });

    it('respects limit and offset', () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        insertSkillRecord(makeSkillRecord({ updated_at: now + i }));
      }

      const page1 = listSkillRecords({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = listSkillRecords({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      const page3 = listSkillRecords({ limit: 2, offset: 4 });
      expect(page3).toHaveLength(1);
    });

    it('returns empty array when no records match', () => {
      const rows = listSkillRecords({ status: 'nonexistent' });
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // updateSkillRecord
  // ---------------------------------------------------------------------------

  describe('updateSkillRecord', () => {
    it('updates display_name and description', () => {
      const data = makeSkillRecord();
      insertSkillRecord(data);

      const now = epochNow() + 10;
      const row = updateSkillRecord(data.id, {
        display_name: 'Updated display name',
        description: 'New description after review',
        updated_at: now,
      });

      expect(row).not.toBeNull();
      expect(row!.display_name).toBe('Updated display name');
      expect(row!.description).toBe('New description after review');
      expect(row!.updated_at).toBe(now);
    });

    it('updates status and generation', () => {
      const data = makeSkillRecord({ generation: 1 });
      insertSkillRecord(data);

      const now = epochNow() + 10;
      const row = updateSkillRecord(data.id, {
        status: 'deprecated',
        generation: 2,
        updated_at: now,
      });

      expect(row).not.toBeNull();
      expect(row!.status).toBe('deprecated');
      expect(row!.generation).toBe(2);
    });

    it('updates usage_count and last_used_at', () => {
      const data = makeSkillRecord();
      insertSkillRecord(data);

      const now = epochNow() + 10;
      const usedAt = now - 5;
      const row = updateSkillRecord(data.id, {
        usage_count: 5,
        last_used_at: usedAt,
        updated_at: now,
      });

      expect(row).not.toBeNull();
      expect(row!.usage_count).toBe(5);
      expect(row!.last_used_at).toBe(usedAt);
    });

    it('updates source_ids, path, and properties', () => {
      const data = makeSkillRecord();
      insertSkillRecord(data);

      const now = epochNow() + 10;
      const row = updateSkillRecord(data.id, {
        source_ids: '["sess-1","sess-2"]',
        path: '.myco/skills/updated-path.md',
        properties: '{"tags":["db","testing"]}',
        updated_at: now,
      });

      expect(row).not.toBeNull();
      expect(row!.source_ids).toBe('["sess-1","sess-2"]');
      expect(row!.path).toBe('.myco/skills/updated-path.md');
      expect(row!.properties).toBe('{"tags":["db","testing"]}');
    });

    it('returns null for non-existent record', () => {
      const result = updateSkillRecord('nope', { updated_at: epochNow() });
      expect(result).toBeNull();
    });

    it('preserves unmodified fields', () => {
      const data = makeSkillRecord({ display_name: 'Original name', generation: 2 });
      insertSkillRecord(data);

      const now = epochNow() + 10;
      const row = updateSkillRecord(data.id, { status: 'deprecated', updated_at: now });

      expect(row).not.toBeNull();
      expect(row!.display_name).toBe('Original name');
      expect(row!.generation).toBe(2);
      expect(row!.status).toBe('deprecated');
    });
  });

  // ---------------------------------------------------------------------------
  // Unique name constraint
  // ---------------------------------------------------------------------------

  describe('unique name constraint', () => {
    it('rejects a second record with the same name', () => {
      const name = 'use-unique-skill';
      const path = '.myco/skills/use-unique-skill.md';
      const now = epochNow();

      insertSkillRecord(makeSkillRecord({ name, path, created_at: now }));

      expect(() => {
        insertSkillRecord(makeSkillRecord({ name, path, created_at: now + 1 }));
      }).toThrow();
    });

    it('allows the same name in different projects', () => {
      const name = 'use-project-unique-skill';
      const now = epochNow();

      insertSkillRecord(makeSkillRecord({
        id: 'skill-project-unique-a',
        project_id: 'proj_a',
        name,
        path: '.myco/skills/project-a.md',
        created_at: now,
      }));
      insertSkillRecord(makeSkillRecord({
        id: 'skill-project-unique-b',
        project_id: 'proj_b',
        name,
        path: '.myco/skills/project-b.md',
        created_at: now + 1,
      }));

      expect(() => {
        insertSkillRecord(makeSkillRecord({
          id: 'skill-project-unique-a2',
          project_id: 'proj_a',
          name,
          path: '.myco/skills/project-a2.md',
          created_at: now + 2,
        }));
      }).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // countSkillRecords
  // ---------------------------------------------------------------------------

  describe('countSkillRecords', () => {
    it('counts all records when no filters given', () => {
      const now = epochNow();
      insertSkillRecord(makeSkillRecord({ updated_at: now }));
      insertSkillRecord(makeSkillRecord({ updated_at: now + 1 }));
      insertSkillRecord(makeSkillRecord({ updated_at: now + 2 }));

      expect(countSkillRecords()).toBe(3);
    });

    it('counts records matching a status filter', () => {
      const now = epochNow();
      insertSkillRecord(makeSkillRecord({ status: 'active', updated_at: now }));
      insertSkillRecord(makeSkillRecord({ status: 'active', updated_at: now + 1 }));
      insertSkillRecord(makeSkillRecord({ status: 'deprecated', updated_at: now + 2 }));

      expect(countSkillRecords({ status: 'active' })).toBe(2);
      expect(countSkillRecords({ status: 'deprecated' })).toBe(1);
      expect(countSkillRecords({ status: 'archived' })).toBe(0);
    });

    it('counts records matching an agent_id filter', () => {
      registerAgent({ id: 'agent-count', name: 'Count Agent', created_at: epochNow() });

      const now = epochNow();
      insertSkillRecord(makeSkillRecord({ agent_id: 'agent-test', updated_at: now }));
      insertSkillRecord(makeSkillRecord({ agent_id: 'agent-test', updated_at: now + 1 }));
      insertSkillRecord(makeSkillRecord({ agent_id: 'agent-count', updated_at: now + 2 }));

      expect(countSkillRecords({ agent_id: 'agent-test' })).toBe(2);
      expect(countSkillRecords({ agent_id: 'agent-count' })).toBe(1);
    });
  });
});
