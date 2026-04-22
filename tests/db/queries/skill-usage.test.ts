/**
 * Tests for skill usage query helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import {
  insertSkillUsage,
  listUsageForSkill,
  countUsageForSkill,
  hasUsageForSkillAndSession,
} from '@myco/db/queries/skill-usage.js';
import type { SkillUsageInsert } from '@myco/db/queries/skill-usage.js';
import type { SkillRecordInsert } from '@myco/db/queries/skill-records.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Factory for minimal valid session data. */
function makeSession(overrides: Partial<SessionInsert> = {}): SessionInsert {
  const now = epochNow();
  return {
    id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    agent: 'claude-code',
    started_at: now,
    created_at: now,
    ...overrides,
  };
}

/** Factory for minimal valid skill record data. */
function makeSkillRecord(overrides: Partial<SkillRecordInsert> = {}): SkillRecordInsert {
  const now = epochNow();
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `skill-usage-test-${suffix}`;
  return {
    id: `skill-${suffix}`,
    agent_id: 'agent-test',
    name,
    display_name: 'Test Skill',
    description: 'A skill for usage tests',
    path: `.myco/skills/${name}.md`,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** Factory for minimal valid skill usage insert data. */
function makeUsage(skillId: string, sessionId: string, overrides: Partial<SkillUsageInsert> = {}): SkillUsageInsert {
  return {
    id: `usage-${Math.random().toString(36).slice(2, 8)}`,
    skill_id: skillId,
    session_id: sessionId,
    detected_at: epochNow(),
    ...overrides,
  };
}

describe('skill usage query helpers', () => {
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
  // insertSkillUsage
  // ---------------------------------------------------------------------------

  describe('insertSkillUsage', () => {
    it('inserts a usage entry and returns the row', () => {
      const session = upsertSession(makeSession());
      const skill = insertSkillRecord(makeSkillRecord());
      const now = epochNow();
      const data = makeUsage(skill.id, session.id, { detected_at: now });

      const row = insertSkillUsage(data);

      expect(row.id).toBe(data.id);
      expect(row.skill_id).toBe(skill.id);
      expect(row.session_id).toBe(session.id);
      expect(row.detected_at).toBe(now);
      expect(typeof row.machine_id).toBe('string');
      expect(row.machine_id.length).toBeGreaterThan(0);
    });

    it('stores optional machine_id when provided', () => {
      const session = upsertSession(makeSession());
      const skill = insertSkillRecord(makeSkillRecord());
      const data = makeUsage(skill.id, session.id, { machine_id: 'machine-xyz' });

      const row = insertSkillUsage(data);

      expect(row.machine_id).toBe('machine-xyz');
    });
  });

  // ---------------------------------------------------------------------------
  // listUsageForSkill
  // ---------------------------------------------------------------------------

  describe('listUsageForSkill', () => {
    it('returns usage entries for a skill ordered by detected_at DESC', () => {
      const session = upsertSession(makeSession());
      const skill = insertSkillRecord(makeSkillRecord());
      const now = epochNow();

      insertSkillUsage(makeUsage(skill.id, session.id, { id: 'usage-old', detected_at: now }));
      insertSkillUsage(makeUsage(skill.id, session.id, { id: 'usage-new', detected_at: now + 10 }));

      const rows = listUsageForSkill(skill.id);

      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('usage-new');
      expect(rows[1].id).toBe('usage-old');
    });

    it('returns empty array for a skill with no usage', () => {
      const skill = insertSkillRecord(makeSkillRecord());

      const rows = listUsageForSkill(skill.id);

      expect(rows).toEqual([]);
    });

    it('only returns usage for the requested skill', () => {
      const session = upsertSession(makeSession());
      const skillA = insertSkillRecord(makeSkillRecord());
      const skillB = insertSkillRecord(makeSkillRecord());
      const now = epochNow();

      insertSkillUsage(makeUsage(skillA.id, session.id, { id: 'usage-a', detected_at: now }));
      insertSkillUsage(makeUsage(skillB.id, session.id, { id: 'usage-b', detected_at: now + 1 }));

      const rows = listUsageForSkill(skillA.id);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('usage-a');
      expect(rows[0].skill_id).toBe(skillA.id);
    });

    it('respects the limit option', () => {
      const session = upsertSession(makeSession());
      const skill = insertSkillRecord(makeSkillRecord());
      const now = epochNow();

      for (let i = 0; i < 5; i++) {
        insertSkillUsage(makeUsage(skill.id, session.id, { detected_at: now + i }));
      }

      const rows = listUsageForSkill(skill.id, { limit: 3 });

      expect(rows).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // hasUsageForSkillAndSession
  // ---------------------------------------------------------------------------

  describe('hasUsageForSkillAndSession', () => {
    it('returns false when no usage exists for the skill/session pair', () => {
      const session = upsertSession(makeSession());
      const skill = insertSkillRecord(makeSkillRecord());

      expect(hasUsageForSkillAndSession(skill.id, session.id)).toBe(false);
    });

    it('returns true after a usage entry is inserted', () => {
      const session = upsertSession(makeSession());
      const skill = insertSkillRecord(makeSkillRecord());

      insertSkillUsage(makeUsage(skill.id, session.id));

      expect(hasUsageForSkillAndSession(skill.id, session.id)).toBe(true);
    });

    it('returns false for a different session even when usage exists for another', () => {
      const sessionA = upsertSession(makeSession());
      const sessionB = upsertSession(makeSession());
      const skill = insertSkillRecord(makeSkillRecord());

      insertSkillUsage(makeUsage(skill.id, sessionA.id));

      expect(hasUsageForSkillAndSession(skill.id, sessionA.id)).toBe(true);
      expect(hasUsageForSkillAndSession(skill.id, sessionB.id)).toBe(false);
    });

    it('returns false for a different skill even when usage exists for another', () => {
      const session = upsertSession(makeSession());
      const skillA = insertSkillRecord(makeSkillRecord());
      const skillB = insertSkillRecord(makeSkillRecord());

      insertSkillUsage(makeUsage(skillA.id, session.id));

      expect(hasUsageForSkillAndSession(skillA.id, session.id)).toBe(true);
      expect(hasUsageForSkillAndSession(skillB.id, session.id)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // countUsageForSkill
  // ---------------------------------------------------------------------------

  describe('countUsageForSkill', () => {
    it('returns the correct count after inserting usage entries', () => {
      const session = upsertSession(makeSession());
      const skill = insertSkillRecord(makeSkillRecord());
      const now = epochNow();

      insertSkillUsage(makeUsage(skill.id, session.id, { detected_at: now }));

      expect(countUsageForSkill(skill.id)).toBe(1);
    });

    it('returns 0 for a skill with no usage', () => {
      const skill = insertSkillRecord(makeSkillRecord());

      expect(countUsageForSkill(skill.id)).toBe(0);
    });

    it('counts all usage entries across multiple sessions', () => {
      const sessionA = upsertSession(makeSession());
      const sessionB = upsertSession(makeSession());
      const skill = insertSkillRecord(makeSkillRecord());
      const now = epochNow();

      insertSkillUsage(makeUsage(skill.id, sessionA.id, { detected_at: now }));
      insertSkillUsage(makeUsage(skill.id, sessionB.id, { detected_at: now + 1 }));
      insertSkillUsage(makeUsage(skill.id, sessionA.id, { detected_at: now + 2 }));

      expect(countUsageForSkill(skill.id)).toBe(3);
    });

    it('counts only for the requested skill', () => {
      const session = upsertSession(makeSession());
      const skillA = insertSkillRecord(makeSkillRecord());
      const skillB = insertSkillRecord(makeSkillRecord());
      const now = epochNow();

      insertSkillUsage(makeUsage(skillA.id, session.id, { detected_at: now }));
      insertSkillUsage(makeUsage(skillA.id, session.id, { detected_at: now + 1 }));
      insertSkillUsage(makeUsage(skillB.id, session.id, { detected_at: now + 2 }));

      expect(countUsageForSkill(skillA.id)).toBe(2);
      expect(countUsageForSkill(skillB.id)).toBe(1);
    });
  });
});
