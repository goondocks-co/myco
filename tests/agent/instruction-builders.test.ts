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
import { insertCandidate, updateCandidate } from '@myco/db/queries/skill-candidates.js';
import { epochSeconds } from '@myco/constants.js';
import {
  buildSkillEvolveInstruction,
  buildSkillGenerateInstruction,
  buildTaskInstruction,
  isInstructionRequiredTask,
  SKILL_GENERATE_TASK,
  SKILL_EVOLVE_TASK,
} from '@myco/agent/instruction-builders.js';
import { CANDIDATE_STATUS } from '@myco/constants/skill-candidate-status.js';

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

  it('does not include full content in instruction (read on-demand via tool)', () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    createSkillWithWatermark('content-check', watermark);
    createSpore(now - 100);

    const result = buildSkillEvolveInstruction();
    expect(result).not.toContain('### Current Content');
    expect(result).toContain('content-check'); // skill name still present in metadata
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

// ---------------------------------------------------------------------------
// buildSkillGenerateInstruction — returns undefined when no candidates are
// in the 'approved' state, which is the signal to the dispatcher that the
// run should be skipped rather than executed against the wrong candidate.
// ---------------------------------------------------------------------------

describe('buildSkillGenerateInstruction', () => {
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

  function seedCandidate(id: string, status: string): void {
    const now = epochSeconds();
    insertCandidate({
      id,
      agent_id: TEST_AGENT_ID,
      topic: `Topic for ${id}`,
      rationale: `Rationale for ${id}`,
      created_at: now,
      updated_at: now,
    });
    if (status !== CANDIDATE_STATUS.IDENTIFIED) {
      updateCandidate(id, { status, updated_at: now });
    }
  }

  it('returns undefined when no candidates exist', () => {
    expect(buildSkillGenerateInstruction()).toBeUndefined();
  });

  it('returns undefined when all candidates are in identified state', () => {
    seedCandidate('c-1', CANDIDATE_STATUS.IDENTIFIED);
    seedCandidate('c-2', CANDIDATE_STATUS.IDENTIFIED);
    expect(buildSkillGenerateInstruction()).toBeUndefined();
  });

  it('returns undefined when all candidates are in dismissed state', () => {
    seedCandidate('c-d', CANDIDATE_STATUS.DISMISSED);
    expect(buildSkillGenerateInstruction()).toBeUndefined();
  });

  it('returns undefined when all candidates are in generated state', () => {
    seedCandidate('c-g', CANDIDATE_STATUS.GENERATED);
    expect(buildSkillGenerateInstruction()).toBeUndefined();
  });

  it('returns instruction with context when an approved candidate exists', () => {
    seedCandidate('c-a', CANDIDATE_STATUS.APPROVED);
    const result = buildSkillGenerateInstruction();
    expect(result).toBeDefined();
    expect(result!.instruction).toContain('candidate_id: c-a');
    expect(result!.context).toEqual({ candidate_id: 'c-a' });
  });
});

// ---------------------------------------------------------------------------
// isInstructionRequiredTask — the dispatcher contract for "no work → skip".
// ---------------------------------------------------------------------------

describe('isInstructionRequiredTask', () => {
  it('returns true for skill-generate', () => {
    expect(isInstructionRequiredTask(SKILL_GENERATE_TASK)).toBe(true);
  });

  it('returns true for skill-evolve', () => {
    expect(isInstructionRequiredTask(SKILL_EVOLVE_TASK)).toBe(true);
  });

  it('returns false for generic tasks like full-intelligence', () => {
    expect(isInstructionRequiredTask('full-intelligence')).toBe(false);
    expect(isInstructionRequiredTask('skill-survey')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildTaskInstruction dispatch contract
// ---------------------------------------------------------------------------

describe('buildTaskInstruction', () => {
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

  it('returns undefined for tasks that do not use pre-assembled instructions', () => {
    expect(buildTaskInstruction('full-intelligence')).toBeUndefined();
    expect(buildTaskInstruction('skill-survey')).toBeUndefined();
  });

  it('returns undefined for skill-generate when no approved candidates exist', () => {
    expect(buildTaskInstruction(SKILL_GENERATE_TASK)).toBeUndefined();
  });

  it('returns bundle for skill-generate when an approved candidate exists', () => {
    const now = epochSeconds();
    insertCandidate({
      id: 'ready-to-generate',
      agent_id: TEST_AGENT_ID,
      topic: 'Ready topic',
      rationale: 'Ready rationale',
      created_at: now,
      updated_at: now,
    });
    updateCandidate('ready-to-generate', { status: CANDIDATE_STATUS.APPROVED, updated_at: now });

    const result = buildTaskInstruction(SKILL_GENERATE_TASK);
    expect(result).toBeDefined();
    expect(result!.instruction).toContain('Ready topic');
    expect(result!.context?.candidate_id).toBe('ready-to-generate');
  });
});
