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
import { upsertSession } from '@myco/db/queries/sessions.js';
import { epochSeconds } from '@myco/constants.js';
import {
  buildSkillEvolveInstruction,
  buildSkillGenerateInstruction,
  buildSkillSurveyInstruction,
  buildTaskInstruction,
  getSkillSurveyEligibility,
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

function createSession(id: string, status: 'active' | 'completed', createdAt: number): void {
  upsertSession({
    id,
    agent: 'claude-code',
    started_at: createdAt,
    created_at: createdAt,
    ended_at: status === 'completed' ? createdAt + 60 : null,
    status,
    title: `${id} title`,
    summary: `${id} summary covering repo-specific work`,
  });
}

function createSettledSurveyCorpus(): void {
  const now = epochSeconds();
  createSession('settled-1', 'completed', now - 300);
  createSession('settled-2', 'completed', now - 200);

  insertSpore({
    id: 'spore-survey-1',
    agent_id: TEST_AGENT_ID,
    session_id: 'settled-1',
    observation_type: 'decision',
    content: 'Use repo-specific daemon extension pattern in src/daemon/main.ts',
    importance: 7,
    created_at: now - 180,
  });
  insertSpore({
    id: 'spore-survey-2',
    agent_id: TEST_AGENT_ID,
    session_id: 'settled-1',
    observation_type: 'gotcha',
    content: 'Project-specific scheduler guard must read settled sessions only',
    importance: 6,
    created_at: now - 170,
  });
  insertSpore({
    id: 'spore-survey-3',
    agent_id: TEST_AGENT_ID,
    session_id: 'settled-2',
    observation_type: 'discovery',
    content: 'Named task YAML in packages/myco/src/agent/definitions/tasks anchors repo behavior',
    importance: 5,
    created_at: now - 160,
  });
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

describe('buildSkillSurveyInstruction', () => {
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

  it('returns undefined when only active-session data exists', () => {
    const now = epochSeconds();
    createSession('active-only', 'active', now - 100);
    insertSpore({
      id: 'active-spore-1',
      agent_id: TEST_AGENT_ID,
      session_id: 'active-only',
      observation_type: 'decision',
      content: 'Live in-flight work should not count',
      importance: 5,
      created_at: now - 90,
    });
    insertSpore({
      id: 'active-spore-2',
      agent_id: TEST_AGENT_ID,
      session_id: 'active-only',
      observation_type: 'gotcha',
      content: 'Still active session',
      importance: 5,
      created_at: now - 80,
    });
    insertSpore({
      id: 'active-spore-3',
      agent_id: TEST_AGENT_ID,
      session_id: 'active-only',
      observation_type: 'discovery',
      content: 'No settled knowledge yet',
      importance: 5,
      created_at: now - 70,
    });

    expect(getSkillSurveyEligibility(TEST_AGENT_ID)).toEqual({
      eligible: false,
      reason: 'insufficient-settled-sessions',
    });
    expect(buildSkillSurveyInstruction(TEST_AGENT_ID)).toBeUndefined();
  });

  it('returns undefined when settled corpus is still too sparse', () => {
    const now = epochSeconds();
    createSession('settled-only-one', 'completed', now - 100);
    insertSpore({
      id: 'settled-spore-1',
      agent_id: TEST_AGENT_ID,
      session_id: 'settled-only-one',
      observation_type: 'decision',
      content: 'One completed session is not enough',
      importance: 5,
      created_at: now - 90,
    });

    expect(getSkillSurveyEligibility(TEST_AGENT_ID)).toEqual({
      eligible: false,
      reason: 'insufficient-settled-sessions',
    });
    expect(buildSkillSurveyInstruction(TEST_AGENT_ID)).toBeUndefined();
  });

  it('returns instruction only after enough settled sessions and spores exist', () => {
    createSettledSurveyCorpus();

    const result = buildSkillSurveyInstruction(TEST_AGENT_ID);
    expect(result).toBeDefined();
    expect(result!.instruction).toContain('Eligibility gate: requires 2+ settled sessions and 3+ active spores');
    expect(result!.instruction).toContain('only propose project-specific procedural domains');
    expect(result!.instruction).toContain('settled-1');
    expect(result!.instruction).toContain('spore-survey-1');
  });

  it('returns undefined when no new settled knowledge exists after the watermark', () => {
    createSettledSurveyCorpus();

    expect(buildSkillSurveyInstruction(TEST_AGENT_ID)).toBeDefined();
    expect(getSkillSurveyEligibility(TEST_AGENT_ID)).toEqual({
      eligible: false,
      reason: 'no-new-settled-knowledge',
    });
    expect(buildSkillSurveyInstruction(TEST_AGENT_ID)).toBeUndefined();
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

  it('returns undefined for skill-survey when no settled survey corpus exists', () => {
    expect(buildTaskInstruction('skill-survey', undefined, TEST_AGENT_ID)).toBeUndefined();
  });

  it('returns bundle for skill-survey when settled survey corpus exists', () => {
    createSettledSurveyCorpus();

    const result = buildTaskInstruction('skill-survey', undefined, TEST_AGENT_ID);
    expect(result).toBeDefined();
    expect(result!.instruction).toContain('project-specific procedural domains');
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
