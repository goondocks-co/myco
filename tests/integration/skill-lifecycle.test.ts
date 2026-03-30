// tests/integration/skill-lifecycle.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertCandidate, getCandidate } from '@myco/db/queries/skill-candidates.js';
import {
  insertSkillRecord,
  getSkillRecordByName,
  listSkillRecords,
  updateSkillRecord,
} from '@myco/db/queries/skill-records.js';
import { insertLineage, listLineageForSkill } from '@myco/db/queries/skill-lineage.js';
import { detectSkillUsage } from '@myco/daemon/skill-usage.js';
import { countUsageForSkill } from '@myco/db/queries/skill-usage.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const AGENT_ID = 'myco-agent';

describe('skill lifecycle integration', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    const now = epochNow();
    registerAgent({ id: AGENT_ID, name: AGENT_ID, created_at: now });
  });

  it('full lifecycle: candidate → record → usage → lineage', () => {
    const now = epochNow();

    // 1. Create candidate (simulates skill-survey output)
    const candidate = insertCandidate({
      id: 'cand-lifecycle', agent_id: AGENT_ID,
      topic: 'Adding a new symbiont',
      rationale: '5 sessions, 3 wisdom spores about SymbiontInstaller',
      confidence: 0.85,
      source_ids: JSON.stringify([
        { id: 'spore-1', type: 'spore' },
        { id: 'sess-1', type: 'session' },
      ]),
      created_at: now, updated_at: now,
    });
    expect(candidate.status).toBe('identified');

    // 2. Create skill record (simulates skill-generate output)
    const record = insertSkillRecord({
      id: 'rec-lifecycle', agent_id: AGENT_ID,
      name: 'adding-a-symbiont',
      display_name: 'Adding a New Symbiont',
      description: 'How to add a new AI agent integration',
      path: '.agents/skills/adding-a-symbiont/SKILL.md',
      candidate_id: candidate.id,
      source_ids: candidate.source_ids,
      created_at: now, updated_at: now,
    });
    expect(record.generation).toBe(1);
    expect(record.status).toBe('active');

    // 3. Create initial lineage
    insertLineage({
      id: 'lin-1', skill_id: record.id, generation: 1,
      action: 'created', rationale: 'Initial generation',
      content_snapshot: '---\nname: adding-a-symbiont\nmanaged_by: myco\n---\nContent',
      created_at: now,
    });

    // 4. Usage detection is currently disabled (false positive issue).
    // Verify the function doesn't throw and doesn't count.
    const sessionId = 'sess-usage';
    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });
    detectSkillUsage(sessionId, 'loaded skills/adding-a-symbiont/SKILL.md into context');
    expect(countUsageForSkill(record.id)).toBe(0);

    const refreshed = getSkillRecordByName('adding-a-symbiont');
    expect(refreshed!.usage_count).toBe(0); // Detection disabled
    expect(refreshed!.last_used_at).toBeNull();

    // 5. Simulate evolution (add lineage entry)
    updateSkillRecord(record.id, {
      generation: 2,
      source_ids: JSON.stringify([
        { id: 'spore-1', type: 'spore' },
        { id: 'spore-new', type: 'spore' },
      ]),
      updated_at: now + 3600,
    });

    insertLineage({
      id: 'lin-2', skill_id: record.id, generation: 2,
      action: 'updated', rationale: 'New hook guard knowledge',
      source_ids_added: '[{"id":"spore-new","type":"spore"}]',
      content_snapshot: '---\nname: adding-a-symbiont\nmanaged_by: myco\ngeneration: 2\n---\nUpdated content',
      created_at: now + 3600,
    });

    const lineage = listLineageForSkill(record.id);
    expect(lineage).toHaveLength(2);
    expect(lineage[0].generation).toBe(2);
    expect(lineage[0].action).toBe('updated');
    expect(lineage[1].generation).toBe(1);
    expect(lineage[1].action).toBe('created');
  });

  it('active/retired status filtering works correctly', () => {
    const now = epochNow();

    insertSkillRecord({
      id: 'rec-active', agent_id: AGENT_ID, name: 'active-skill',
      display_name: 'Active', description: 'test',
      path: '.agents/skills/active-skill/SKILL.md',
      status: 'active', created_at: now, updated_at: now,
    });
    insertSkillRecord({
      id: 'rec-retired', agent_id: AGENT_ID, name: 'retired-skill',
      display_name: 'Retired', description: 'test',
      path: '.agents/skills/retired-skill/SKILL.md',
      status: 'retired', created_at: now, updated_at: now,
    });

    const active = listSkillRecords({ status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('active-skill');

    const retired = listSkillRecords({ status: 'retired' });
    expect(retired).toHaveLength(1);
    expect(retired[0].name).toBe('retired-skill');

    const all = listSkillRecords();
    expect(all).toHaveLength(2);
  });

  it('usage detection skips retired skills', () => {
    const now = epochNow();

    insertSkillRecord({
      id: 'rec-retired-usage', agent_id: AGENT_ID, name: 'retired-check',
      display_name: 'Retired', description: 'test',
      path: '.agents/skills/retired-check/SKILL.md',
      status: 'retired', created_at: now, updated_at: now,
    });

    const sessionId = 'sess-retired';
    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });
    detectSkillUsage(sessionId, 'skills/retired-check/SKILL.md');
    expect(countUsageForSkill('rec-retired-usage')).toBe(0);
  });
});
