/**
 * Tests for skill-evolve instruction builder.
 *
 * Exercises buildSkillEvolveInstruction() against an in-memory database,
 * verifying filtering logic for watermarks, throttle intervals, and
 * content assembly.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

// Mock embedding before imports
vi.mock('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { insertLineage } from '@myco/db/queries/skill-lineage.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { epochSeconds } from '@myco/constants.js';
import { buildSkillEvolveInstruction } from '@myco/agent/instruction-builders.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'test-agent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAgent(id: string): void {
  const db = getDatabase();
  db.prepare('INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)').run(id, id, epochSeconds());
}

function createSkillWithWatermark(name: string, watermark: number, lastAssessedAt?: number): string {
  const id = `skill-${name}`;
  const now = epochSeconds();
  insertSkillRecord({
    id,
    agent_id: TEST_AGENT_ID,
    name,
    display_name: name,
    description: `Test skill ${name}`,
    source_ids: '[]',
    path: `.agents/skills/${name}/SKILL.md`,
    created_at: now,
    updated_at: now,
    properties: JSON.stringify({
      knowledge_watermark: watermark,
      last_assessed_at: lastAssessedAt ?? 0,
    }),
  });
  insertLineage({
    id: `lineage-${name}`,
    skill_id: id,
    generation: 1,
    action: 'created',
    rationale: 'test',
    content_snapshot: `---\nname: myco:${name}\ndescription: Test\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: Read, Grep\n---\n# ${name}`,
    created_at: now,
  });
  return id;
}

function createSpore(createdAt: number): string {
  const id = `spore-${Math.random().toString(36).slice(2, 8)}`;
  insertSpore({
    id,
    agent_id: TEST_AGENT_ID,
    observation_type: 'discovery',
    content: 'Test spore content',
    importance: 5,
    created_at: createdAt,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('buildSkillEvolveInstruction', () => {
  beforeAll(() => {
    setupTestDb();
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    cleanTestDb();
    createAgent(TEST_AGENT_ID);
  });

  it('returns skip message when no skills exist', () => {
    const result = buildSkillEvolveInstruction();
    expect(result).toContain('No skills need assessment');
  });

  it('returns skip message when no new spores since watermark', () => {
    const now = epochSeconds();
    // Watermark is in the future — no spores can be newer
    createSkillWithWatermark('no-spores-skill', now + 1000);
    // Create a spore before the watermark
    createSpore(now - 100);

    const result = buildSkillEvolveInstruction();
    expect(result).toContain('No skills need assessment');
  });

  it('includes skill when new spores exist since watermark', () => {
    const now = epochSeconds();
    const watermark = now - 500;
    createSkillWithWatermark('active-skill', watermark);
    // Spore created after the watermark
    createSpore(now - 100);

    const result = buildSkillEvolveInstruction();
    expect(result).not.toContain('No skills need assessment');
    expect(result).toContain('active-skill');
  });

  it('skips skills assessed within throttle interval', () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    // Last assessed only 1 hour ago — well within the default 24h interval
    const lastAssessedAt = now - 3600;
    createSkillWithWatermark('recently-assessed', watermark, lastAssessedAt);
    // Spore exists after watermark
    createSpore(now - 100);

    const result = buildSkillEvolveInstruction();
    expect(result).toContain('No skills need assessment');
  });

  it('respects max_skills_per_run param', () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    // Create 3 skills, all needing assessment
    createSkillWithWatermark('skill-alpha', watermark);
    createSkillWithWatermark('skill-beta', watermark);
    createSkillWithWatermark('skill-gamma', watermark);
    // Spore after all watermarks
    createSpore(now - 100);

    const result = buildSkillEvolveInstruction({ max_skills_per_run: 2 });
    expect(result).not.toContain('No skills need assessment');
    expect(result).toContain('max_skills_per_run: 2');
    // Should contain exactly 2 skill sections
    const skillMatches = result.match(/^## Skill:/gm);
    expect(skillMatches).toHaveLength(2);
  });

  it('respects custom assess_interval_hours param', () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    // Last assessed 2 hours ago
    const lastAssessedAt = now - 7200;
    // With interval=1h, 2h ago is outside the interval — skill should be included
    createSkillWithWatermark('stale-enough', watermark, lastAssessedAt);
    createSpore(now - 100);

    const result = buildSkillEvolveInstruction({ assess_interval_hours: 1 });
    expect(result).not.toContain('No skills need assessment');
    expect(result).toContain('stale-enough');
  });

  it('includes skill content from lineage snapshot', () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    createSkillWithWatermark('content-check', watermark);
    createSpore(now - 100);

    const result = buildSkillEvolveInstruction();
    expect(result).toContain('### Current Content');
    expect(result).toContain('content-check');
  });

  it('includes new spore IDs in the instruction', () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    createSkillWithWatermark('spore-id-check', watermark);
    const sporeId = createSpore(now - 100);

    const result = buildSkillEvolveInstruction();
    expect(result).toContain(sporeId);
  });
});
