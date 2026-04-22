import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
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

  // Detection is currently disabled (early return) due to false positives:
  // regex matching catches mentions of skill names in conversation, not just
  // actual skill activations. Re-enable tests when a reliable activation
  // signal is identified in agent transcripts.

  it('does not count usage when detection is disabled', () => {
    detectSkillUsage(sessionId, 'loaded skills/adding-a-symbiont/SKILL.md into context');
    expect(countUsageForSkill(skillId)).toBe(0);
  });

  it('skips vault_write_skill transcripts', () => {
    detectSkillUsage(sessionId, 'vault_write_skill skills/adding-a-symbiont/SKILL.md');
    expect(countUsageForSkill(skillId)).toBe(0);
  });

  it('does not throw on empty transcript', () => {
    detectSkillUsage(sessionId, '');
    expect(countUsageForSkill(skillId)).toBe(0);
  });
});
