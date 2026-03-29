import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertSkillRecord, getSkillRecord } from '@myco/db/queries/skill-records.js';
import { detectSkillUsage } from '@myco/daemon/skill-usage.js';
import { countUsageForSkill } from '@myco/db/queries/skill-usage.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const TEST_AGENT_ID = 'myco-agent';

describe('skill usage detection', () => {
  let sessionId: string;
  let skillId: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    const now = epochNow();
    registerAgent({ id: TEST_AGENT_ID, name: TEST_AGENT_ID, created_at: now });
    sessionId = `sess-${Math.random().toString(36).slice(2, 8)}`;
    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });
    skillId = 'rec-usage-test';
    insertSkillRecord({
      id: skillId, agent_id: TEST_AGENT_ID, name: 'adding-a-symbiont',
      display_name: 'Adding a Symbiont', description: 'Guide',
      path: '.agents/skills/adding-a-symbiont/SKILL.md',
      created_at: now, updated_at: now,
    });
  });

  it('detects skill activation from SKILL.md path in transcript', () => {
    detectSkillUsage(sessionId, 'loaded skills/adding-a-symbiont/SKILL.md into context');
    expect(countUsageForSkill(skillId)).toBe(1);
    expect(getSkillRecord(skillId)!.usage_count).toBe(1);
  });

  it('detects skill activation from <skill> tag in transcript', () => {
    detectSkillUsage(sessionId, '<skill name="adding-a-symbiont">content</skill>');
    expect(countUsageForSkill(skillId)).toBe(1);
  });

  it('is idempotent for same session', () => {
    detectSkillUsage(sessionId, 'skills/adding-a-symbiont/SKILL.md');
    detectSkillUsage(sessionId, 'skills/adding-a-symbiont/SKILL.md');
    expect(countUsageForSkill(skillId)).toBe(1);
  });

  it('ignores unrecognized skill names', () => {
    detectSkillUsage(sessionId, 'skills/unknown-skill/SKILL.md');
    expect(countUsageForSkill(skillId)).toBe(0);
  });

  it('skips when no active skills exist', async () => {
    // Clean skill records
    const { getDatabase } = await import('@myco/db/client.js');
    const db = getDatabase();
    db.prepare('DELETE FROM skill_records').run();

    // Should not throw
    detectSkillUsage(sessionId, 'skills/adding-a-symbiont/SKILL.md');
    expect(countUsageForSkill(skillId)).toBe(0);
  });
});
