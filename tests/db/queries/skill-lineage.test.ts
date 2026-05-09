/**
 * Tests for skill lineage query helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import {
  insertLineage,
  listLineageForSkill,
} from '@myco/db/queries/skill-lineage.js';
import type { LineageInsert } from '@myco/db/queries/skill-lineage.js';
import type { SkillRecordInsert } from '@myco/db/queries/skill-records.js';
import { ALL_PROJECTS_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Factory for minimal valid skill record data. */
function makeSkillRecord(overrides: Partial<SkillRecordInsert> = {}): SkillRecordInsert {
  const now = epochNow();
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `skill-lineage-test-${suffix}`;
  return {
    id: `skill-${suffix}`,
    agent_id: 'agent-test',
    name,
    display_name: 'Test Skill',
    description: 'A skill for lineage tests',
    path: `.myco/skills/${name}.md`,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** Factory for minimal valid lineage insert data. */
function makeLineage(skillId: string, overrides: Partial<LineageInsert> = {}): LineageInsert {
  const now = epochNow();
  return {
    id: `lineage-${Math.random().toString(36).slice(2, 8)}`,
    skill_id: skillId,
    generation: 1,
    action: 'created',
    rationale: 'Initial skill creation',
    content_snapshot: '# Test Skill\nInitial content.',
    created_at: now,
    ...overrides,
  };
}

describe('skill lineage query helpers', () => {
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
  // insertLineage
  // ---------------------------------------------------------------------------

  describe('insertLineage', () => {
    it('inserts a lineage entry and returns the row', () => {
      const skill = insertSkillRecord(makeSkillRecord());
      const data = makeLineage(skill.id, {
        generation: 1,
        action: 'created',
        rationale: 'Bootstrapped from session pattern',
        content_snapshot: '# Use Vitest\nAlways prefer vitest.',
      });

      const row = insertLineage(data);

      expect(row.id).toBe(data.id);
      expect(row.project_id).toBeNull();
      expect(row.skill_id).toBe(skill.id);
      expect(row.generation).toBe(1);
      expect(row.action).toBe('created');
      expect(row.rationale).toBe('Bootstrapped from session pattern');
      expect(row.content_snapshot).toBe('# Use Vitest\nAlways prefer vitest.');
      expect(row.source_ids_added).toBe('[]');
      expect(row.created_at).toBe(data.created_at);
    });

    it('stores source_ids_added when provided', () => {
      const skill = insertSkillRecord(makeSkillRecord());
      const data = makeLineage(skill.id, {
        source_ids_added: '["sess-abc","sess-def"]',
      });

      const row = insertLineage(data);

      expect(row.source_ids_added).toBe('["sess-abc","sess-def"]');
    });

    it('defaults source_ids_added to empty array when omitted', () => {
      const skill = insertSkillRecord(makeSkillRecord());
      const data = makeLineage(skill.id);
      delete (data as Partial<LineageInsert>).source_ids_added;

      const row = insertLineage(data);

      expect(row.source_ids_added).toBe('[]');
    });
  });

  // ---------------------------------------------------------------------------
  // listLineageForSkill
  // ---------------------------------------------------------------------------

  describe('listLineageForSkill', () => {
    it('returns lineage entries ordered by generation DESC (newest first)', () => {
      const skill = insertSkillRecord(makeSkillRecord());
      const now = epochNow();

      insertLineage(makeLineage(skill.id, {
        id: 'lin-gen1',
        generation: 1,
        action: 'created',
        created_at: now,
      }));
      insertLineage(makeLineage(skill.id, {
        id: 'lin-gen2',
        generation: 2,
        action: 'updated',
        created_at: now + 10,
      }));

      const rows = listLineageForSkill(skill.id, ALL_PROJECTS_SCOPE);

      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('lin-gen2');
      expect(rows[0].generation).toBe(2);
      expect(rows[1].id).toBe('lin-gen1');
      expect(rows[1].generation).toBe(1);
    });

    it('returns empty array for a skill with no lineage entries', () => {
      const skill = insertSkillRecord(makeSkillRecord());

      const rows = listLineageForSkill(skill.id, ALL_PROJECTS_SCOPE);

      expect(rows).toEqual([]);
    });

    it('returns empty array for a non-existent skill id', () => {
      const rows = listLineageForSkill('skill-does-not-exist', ALL_PROJECTS_SCOPE);

      expect(rows).toEqual([]);
    });

    it('only returns lineage for the requested skill', () => {
      const skillA = insertSkillRecord(makeSkillRecord());
      const skillB = insertSkillRecord(makeSkillRecord());
      const now = epochNow();

      insertLineage(makeLineage(skillA.id, { id: 'lin-a1', generation: 1, created_at: now }));
      insertLineage(makeLineage(skillB.id, { id: 'lin-b1', generation: 1, created_at: now + 1 }));

      const rows = listLineageForSkill(skillA.id, ALL_PROJECTS_SCOPE);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('lin-a1');
      expect(rows[0].skill_id).toBe(skillA.id);
    });

    it('filters lineage by project_id when requested', () => {
      const skillA = insertSkillRecord(makeSkillRecord({ id: 'skill-project-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
      const skillB = insertSkillRecord(makeSkillRecord({ id: 'skill-project-b', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }));

      insertLineage(makeLineage(skillA.id, { id: 'lin-project-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
      insertLineage(makeLineage(skillB.id, { id: 'lin-project-b', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }));

      expect(listLineageForSkill(skillA.id, projectScope('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as GroveProjectId), 50)).toEqual([]);
      expect(listLineageForSkill(skillA.id, projectScope('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId), 50).map((row) => row.id)).toEqual(['lin-project-a']);
    });
  });
});
