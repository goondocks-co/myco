/**
 * Tests for skill-evolve instruction builder.
 *
 * Exercises buildSkillEvolveInstruction(undefined, undefined, undefined, TEST_REQUEST_CONTEXT) against an in-memory database,
 * verifying filtering logic for watermarks, throttle intervals, and
 * content assembly.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
// Mock embedding before imports
mock.module('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { resolveRequestContextForVault } from '@myco/tools/request-context.js';
import { getDatabase } from '@myco/db/client.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { insertLineage } from '@myco/db/queries/skill-lineage.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { insertCandidate, updateCandidate } from '@myco/db/queries/skill-candidates.js';
import { upsertCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { epochSeconds, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { MycoConfigSchema } from '@myco/config/schema.js';
import { buildCortexInstructionsInput } from '@myco/context/cortex-brief.js';
import { resolveLegacyRequestContext } from '@myco/tools/request-context.js';
import {
  buildSkillEvolveInstruction,
  buildSkillGenerateInstruction,
  buildSkillSurveyInstruction,
  buildTaskInstruction,
  CORTEX_INSTRUCTIONS_TASK,
  getSkillSurveyEligibility,
  isInstructionRequiredTask,
  selectOutlierPairs,
  SKILL_GENERATE_TASK,
  SKILL_EVOLVE_TASK,
} from '@myco/agent/instruction-builders.js';
import { CANDIDATE_STATUS } from '@myco/constants/skill-candidate-status.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
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

function createSkillWithWatermark(
  name: string,
  watermark: number,
  lastAssessedAt?: number,
  description?: string,
): string {
  const id = `skill-${name}`;
  const now = epochSeconds();
  insertSkillRecord({
    id,
    agent_id: TEST_AGENT_ID,
    name,
    display_name: name,
    description: description ?? `Test skill ${name}`,
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

function createSpore(createdAt: number, content: string = 'Test spore content'): string {
  const id = `spore-${Math.random().toString(36).slice(2, 8)}`;
  insertSpore({
    id,
    agent_id: TEST_AGENT_ID,
    observation_type: 'discovery',
    content,
    importance: 5,
    created_at: createdAt,
  });
  return id;
}

function requestContext(projectId: string) {
  return resolveLegacyRequestContext('/tmp/myco-instruction-builders-test/.myco', {
    projectRoot: `/workspace/${projectId}`,
    projectId,
    groveId: 'grove-test',
    machineId: 'machine-test',
    source: 'explicit',
  });
}

function createSession(id: string, status: 'active' | 'completed', createdAt: number, projectId?: string): void {
  upsertSession({
    id,
    ...(projectId !== undefined ? { project_id: projectId } : {}),
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

function createAnchorRichSurveyCorpus(): void {
  const now = epochSeconds();
  createSession('settled-anchor-1', 'completed', now - 300);
  createSession('settled-anchor-2', 'completed', now - 200);

  insertSpore({
    id: 'spore-anchor-wisdom',
    agent_id: TEST_AGENT_ID,
    session_id: 'settled-anchor-1',
    observation_type: 'wisdom',
    content: 'Daemon restart workflow for `packages/myco/src/daemon/main.ts` requires `make build` and `myco-dev restart` before verification.',
    importance: 9,
    properties: JSON.stringify({ consolidated_from: ['spore-anchor-source-1', 'spore-anchor-source-2'] }),
    created_at: now - 180,
  });
  insertSpore({
    id: 'spore-anchor-decision',
    agent_id: TEST_AGENT_ID,
    session_id: 'settled-anchor-2',
    observation_type: 'decision',
    content: 'Keep hook entry points thin and validate daemon changes through `packages/myco/src/daemon/main.ts` after restart.',
    importance: 7,
    created_at: now - 170,
  });
  insertSpore({
    id: 'spore-anchor-gotcha',
    agent_id: TEST_AGENT_ID,
    session_id: 'settled-anchor-1',
    observation_type: 'gotcha',
    content: 'Dogfooding can keep running old daemon code until `myco-dev restart` follows `make build`.',
    importance: 6,
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

  it('returns skip message when no skills exist', async () => {
    const result = await buildSkillEvolveInstruction(undefined, undefined, undefined, TEST_REQUEST_CONTEXT);
    expect(result).toBeUndefined();
  });

  it('returns undefined when no new spores since watermark', async () => {
    const now = epochSeconds();
    // Watermark is in the future — no spores can be newer
    createSkillWithWatermark('no-spores-skill', now + 1000);
    // Create a spore before the watermark
    createSpore(now - 100);

    const result = await buildSkillEvolveInstruction(undefined, undefined, undefined, TEST_REQUEST_CONTEXT);
    expect(result).toBeUndefined();
  });

  it('includes skill when new spores exist since watermark', async () => {
    const now = epochSeconds();
    const watermark = now - 500;
    createSkillWithWatermark('active-skill', watermark);
    // Spore created after the watermark
    createSpore(now - 100);

    const result = await buildSkillEvolveInstruction(undefined, undefined, undefined, TEST_REQUEST_CONTEXT);
    expect(result).not.toContain('No skills need assessment');
    expect(result).toContain('active-skill');
  });

  it('skips skills assessed within throttle interval', async () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    // Last assessed only 1 hour ago — well within the default 24h interval
    const lastAssessedAt = now - 3600;
    createSkillWithWatermark('recently-assessed', watermark, lastAssessedAt);
    // Spore exists after watermark
    createSpore(now - 100);

    const result = await buildSkillEvolveInstruction(undefined, undefined, undefined, TEST_REQUEST_CONTEXT);
    expect(result).toBeUndefined();
  });

  it('respects max_skills_per_run param', async () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    // Create 3 skills, all needing assessment
    createSkillWithWatermark('skill-alpha', watermark);
    createSkillWithWatermark('skill-beta', watermark);
    createSkillWithWatermark('skill-gamma', watermark);
    // Spore after all watermarks
    createSpore(now - 100);

    const result = await buildSkillEvolveInstruction({ max_skills_per_run: 2, assess_interval_hours: 1 }, undefined, undefined, TEST_REQUEST_CONTEXT);
    expect(result).not.toContain('No skills need assessment');
    expect(result).toContain('max_skills_per_run: 2');
    // Should contain exactly 2 skill sections
    const skillMatches = result.match(/^## Skill:/gm);
    expect(skillMatches).toHaveLength(2);
  });

  it('prioritizes the oldest last_assessed_at values first', async () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    createSkillWithWatermark('never-assessed', watermark, 0);
    createSkillWithWatermark('oldest-assessed', watermark, now - 7200);
    createSkillWithWatermark('recently-assessed', watermark, now - 60);
    createSpore(now - 100);

    const result = await buildSkillEvolveInstruction({ max_skills_per_run: 2, assess_interval_hours: 1 }, undefined, undefined, TEST_REQUEST_CONTEXT);
    const selectedNames = [...result.matchAll(/^## Skill: ([^(]+)/gm)].map(match => match[1].trim());
    expect(selectedNames).toEqual(['never-assessed', 'oldest-assessed']);
  });

  it('respects custom assess_interval_hours param', async () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    // Last assessed 2 hours ago
    const lastAssessedAt = now - 7200;
    // With interval=1h, 2h ago is outside the interval — skill should be included
    createSkillWithWatermark('stale-enough', watermark, lastAssessedAt);
    createSpore(now - 100);

    const result = await buildSkillEvolveInstruction({ assess_interval_hours: 1 }, undefined, undefined, TEST_REQUEST_CONTEXT);
    expect(result).not.toContain('No skills need assessment');
    expect(result).toContain('stale-enough');
  });

  it('does not include full content in instruction (read on-demand via tool)', async () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    createSkillWithWatermark('content-check', watermark);
    createSpore(now - 100);

    const result = await buildSkillEvolveInstruction(undefined, undefined, undefined, TEST_REQUEST_CONTEXT);
    expect(result).not.toContain('### Current Content');
    expect(result).toContain('content-check'); // skill name still present in metadata
  });

  it('includes new spore IDs in the instruction', async () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    createSkillWithWatermark('spore-id-check', watermark);
    const sporeId = createSpore(now - 100);

    const result = await buildSkillEvolveInstruction(undefined, undefined, undefined, TEST_REQUEST_CONTEXT);
    expect(result).toContain(sporeId);
  });

  it('selects skill-relevant spore IDs instead of reusing the same global recent spores', async () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    createSkillWithWatermark(
      'sqlite-query-patterns',
      watermark,
      0,
      'Apply this skill when writing or reviewing SQLite queries in the Myco vault codebase.',
    );
    createSkillWithWatermark(
      'daemon-ui-development',
      watermark,
      0,
      'Use when building, extending, or reviewing any page or component in the Myco daemon web UI.',
    );

    const sqliteSporeId = createSpore(now - 100, 'SQLite hydration queries should use json_each for variable-length filters.');
    const uiSporeId = createSpore(now - 90, 'Daemon UI theme token regression affected SectionSaveRow layout.');
    const unrelatedSporeId = createSpore(now - 80, 'Cloudflare worker cron fanout timeout needs a tighter safety bound.');

    const result = await buildSkillEvolveInstruction({ max_skills_per_run: 2, assess_interval_hours: 1 }, undefined, undefined, TEST_REQUEST_CONTEXT);

    const sqliteSection = result.match(/## Skill: sqlite-query-patterns[\s\S]*?new_spore_ids: (\[[^\n]+\])/);
    const uiSection = result.match(/## Skill: daemon-ui-development[\s\S]*?new_spore_ids: (\[[^\n]+\])/);

    expect(sqliteSection?.[1]).toContain(sqliteSporeId);
    expect(sqliteSection?.[1]).not.toContain(uiSporeId);
    expect(sqliteSection?.[1]).not.toContain(unrelatedSporeId);

    expect(uiSection?.[1]).toContain(uiSporeId);
    expect(uiSection?.[1]).not.toContain(sqliteSporeId);
    expect(uiSection?.[1]).not.toContain(unrelatedSporeId);
  });

  it('uses semantic shortlisting when a retrieval provider is available', async () => {
    const now = epochSeconds();
    const watermark = now - 10000;
    createSkillWithWatermark(
      'sqlite-query-patterns',
      watermark,
      0,
      'Apply this skill when writing or reviewing SQLite queries in the Myco vault codebase.',
    );
    createSkillWithWatermark(
      'daemon-ui-development',
      watermark,
      0,
      'Use when building, extending, or reviewing any page or component in the Myco daemon web UI.',
    );

    const sqliteSporeId = createSpore(now - 100, 'generic semantic only note one');
    const uiSporeId = createSpore(now - 90, 'generic semantic only note two');

    const provider = {
      embedQuery: vi.fn(async (query: string) => query.includes('sqlite') ? [1] : [2]),
      searchVectors: vi.fn((query: number[]) => {
        if (query[0] === 1) {
          return [
            { id: sqliteSporeId, namespace: 'spores', similarity: 0.92, metadata: { status: 'active', created_at: now - 100 } },
            { id: uiSporeId, namespace: 'spores', similarity: 0.21, metadata: { status: 'active', created_at: now - 90 } },
          ];
        }
        return [
          { id: uiSporeId, namespace: 'spores', similarity: 0.95, metadata: { status: 'active', created_at: now - 90 } },
          { id: sqliteSporeId, namespace: 'spores', similarity: 0.22, metadata: { status: 'active', created_at: now - 100 } },
        ];
      }),
      pairwiseSimilarity: vi.fn(() => []),
    };

    const result = await buildSkillEvolveInstruction(
      { max_skills_per_run: 2, assess_interval_hours: 1 },
      undefined,
      provider,
      TEST_REQUEST_CONTEXT,
    );

    const sqliteSection = result.match(/## Skill: sqlite-query-patterns[\s\S]*?new_spore_ids: (\[[^\n]+\])/);
    const uiSection = result.match(/## Skill: daemon-ui-development[\s\S]*?new_spore_ids: (\[[^\n]+\])/);
    const sqliteIds = JSON.parse(sqliteSection?.[1] ?? '[]') as string[];
    const uiIds = JSON.parse(uiSection?.[1] ?? '[]') as string[];

    expect(sqliteIds[0]).toBe(sqliteSporeId);
    expect(uiIds[0]).toBe(uiSporeId);
    expect(provider.embedQuery).toHaveBeenCalled();
    expect(provider.searchVectors).toHaveBeenCalled();
  });

  it('returns undefined when all signals are zero with projectRoot', async () => {
    const now = epochSeconds();
    createSkillWithWatermark('steady-skill', now + 1000, 0, 'Steady skill');

    const root = mkdtempSync(join(tmpdir(), 'myco-evolve-'));
    mkdirSync(join(root, '.agents', 'skills', 'steady-skill'), { recursive: true });
    writeFileSync(
      join(root, '.agents', 'skills', 'steady-skill', 'SKILL.md'),
      '# Steady\n## Scope\nNo code refs.\n## Procedure\nNo changes.\n',
    );

    const result = await buildSkillEvolveInstruction({}, root, undefined, TEST_REQUEST_CONTEXT);
    expect(result).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('includes drift report when growth-only signal is present', async () => {
    const now = epochSeconds();
    const skillId = createSkillWithWatermark('growth-skill', now + 1000, 0, 'helpers skill');

    const db = getDatabase();
    db.prepare('UPDATE skill_records SET properties = ? WHERE id = ?').run(JSON.stringify({
      knowledge_watermark: now + 1000,
      file_fingerprints: {
        'packages/myco/src/helpers.ts': { exports: ['ExistingSymbol'] },
      },
    }), skillId);

    const root = mkdtempSync(join(tmpdir(), 'myco-evolve-'));
    mkdirSync(join(root, '.agents', 'skills', 'growth-skill'), { recursive: true });
    mkdirSync(join(root, 'packages', 'myco', 'src'), { recursive: true });
    writeFileSync(
      join(root, '.agents', 'skills', 'growth-skill', 'SKILL.md'),
      '# Growth\n## Scope\nUse `packages/myco/src/helpers.ts`.\n## Procedure\nKeep updated.\n',
    );
    writeFileSync(
      join(root, 'packages', 'myco', 'src', 'helpers.ts'),
      'export const ExistingSymbol = 1;\nexport const AddedOne = 2;\nexport const AddedTwo = 3;\n',
    );

    const result = await buildSkillEvolveInstruction({}, root, undefined, TEST_REQUEST_CONTEXT);
    expect(result).toContain('Pre-computed Drift Report');
    expect(result).toContain('growth=');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('selectOutlierPairs', () => {
  it('selects high outliers from distribution', () => {
    const pairs = [
      { idA: 'a', idB: 'b', similarity: 0.32 },
      { idA: 'a', idB: 'c', similarity: 0.35 },
      { idA: 'a', idB: 'd', similarity: 0.37 },
      { idA: 'a', idB: 'e', similarity: 0.39 },
      { idA: 'a', idB: 'f', similarity: 0.41 },
      { idA: 'a', idB: 'g', similarity: 0.43 },
      { idA: 'a', idB: 'h', similarity: 0.45 },
      { idA: 'a', idB: 'i', similarity: 0.48 },
      { idA: 'a', idB: 'j', similarity: 0.91 },
      { idA: 'a', idB: 'k', similarity: 0.89 },
    ];
    const selected = selectOutlierPairs(pairs, { kSigma: 2, minSamples: 10 });
    expect(selected.map(p => p.similarity)).toEqual([0.91]);
  });

  it('returns empty when under minimum sample size', () => {
    const selected = selectOutlierPairs([{ idA: 'a', idB: 'b', similarity: 0.99 }], { kSigma: 2, minSamples: 10 });
    expect(selected).toEqual([]);
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
      updateCandidate(id, { status, updated_at: now }, ALL_PROJECTS_SCOPE);
    }
  }

  it('returns undefined when no candidates exist', () => {
    expect(buildSkillGenerateInstruction(TEST_REQUEST_CONTEXT)).toBeUndefined();
  });

  it('returns undefined when all candidates are in identified state', () => {
    seedCandidate('c-1', CANDIDATE_STATUS.IDENTIFIED);
    seedCandidate('c-2', CANDIDATE_STATUS.IDENTIFIED);
    expect(buildSkillGenerateInstruction(TEST_REQUEST_CONTEXT)).toBeUndefined();
  });

  it('returns undefined when all candidates are in dismissed state', () => {
    seedCandidate('c-d', CANDIDATE_STATUS.DISMISSED);
    expect(buildSkillGenerateInstruction(TEST_REQUEST_CONTEXT)).toBeUndefined();
  });

  it('returns undefined when all candidates are in generated state', () => {
    seedCandidate('c-g', CANDIDATE_STATUS.GENERATED);
    expect(buildSkillGenerateInstruction(TEST_REQUEST_CONTEXT)).toBeUndefined();
  });

  it('returns instruction with context when an approved candidate exists', () => {
    seedCandidate('c-a', CANDIDATE_STATUS.APPROVED);
    const result = buildSkillGenerateInstruction(TEST_REQUEST_CONTEXT);
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

    expect(getSkillSurveyEligibility(TEST_AGENT_ID, TEST_REQUEST_CONTEXT)).toEqual({
      eligible: false,
      reason: 'insufficient-settled-sessions',
    });
    expect(buildSkillSurveyInstruction(TEST_AGENT_ID, TEST_REQUEST_CONTEXT)).toBeUndefined();
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

    expect(getSkillSurveyEligibility(TEST_AGENT_ID, TEST_REQUEST_CONTEXT)).toEqual({
      eligible: false,
      reason: 'insufficient-settled-sessions',
    });
    expect(buildSkillSurveyInstruction(TEST_AGENT_ID, TEST_REQUEST_CONTEXT)).toBeUndefined();
  });

  it('returns instruction only after enough settled sessions and spores exist', () => {
    createSettledSurveyCorpus();

    const result = buildSkillSurveyInstruction(TEST_AGENT_ID, TEST_REQUEST_CONTEXT);
    expect(result).toBeDefined();
    expect(result!.instruction).toContain('Eligibility gate: requires 2+ settled sessions and 3+ active spores');
    expect(result!.instruction).toContain('only propose project-specific procedural domains');
    expect(result!.instruction).toContain('### Candidate Evidence Bundles (0)');
    expect(result!.instruction).toContain('settled-1');
    expect(result!.instruction).toContain('spore-survey-1');
  });

  it('includes candidate evidence bundles from anchor-rich settled corpus', () => {
    createAnchorRichSurveyCorpus();

    const result = buildSkillSurveyInstruction(TEST_AGENT_ID, TEST_REQUEST_CONTEXT);

    expect(result).toBeDefined();
    expect(result!.instruction).toContain('### Candidate Evidence Bundles (1)');
    expect(result!.instruction).toContain('- score: 1.00');
    expect(result!.instruction).toContain('source_refs:');
    expect(result!.instruction).toContain('spore:spore-anchor-wisdom');
    expect(result!.instruction).toContain('spore:spore-anchor-source-1');
    expect(result!.instruction).toContain('session:settled-anchor-1');
    expect(result!.instruction).toContain('session:settled-anchor-2');
  });

  it('returns undefined when no new settled knowledge exists after the watermark', () => {
    createSettledSurveyCorpus();

    expect(buildSkillSurveyInstruction(TEST_AGENT_ID, TEST_REQUEST_CONTEXT)).toBeDefined();
    expect(getSkillSurveyEligibility(TEST_AGENT_ID, TEST_REQUEST_CONTEXT)).toEqual({
      eligible: false,
      reason: 'no-new-settled-knowledge',
    });
    expect(buildSkillSurveyInstruction(TEST_AGENT_ID, TEST_REQUEST_CONTEXT)).toBeUndefined();
  });

  it('evaluates eligibility inside the request-context project scope', () => {
    const now = epochSeconds();
    createSession('settled-project-a-1', 'completed', now - 300, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    createSession('settled-project-a-2', 'completed', now - 200, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    createSession('settled-project-b-1', 'completed', now - 100, 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    for (const [id, projectId] of [
      ['spore-project-a-1', 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      ['spore-project-a-2', 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      ['spore-project-a-3', 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      ['spore-project-b-1', 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    ] as const) {
      insertSpore({
        id,
        project_id: projectId,
        agent_id: TEST_AGENT_ID,
        session_id: projectId === 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ? 'settled-project-a-1' : 'settled-project-b-1',
        observation_type: 'decision',
        content: `${projectId} scoped observation`,
        importance: 5,
        created_at: now - 90,
      });
    }

    expect(getSkillSurveyEligibility(TEST_AGENT_ID, requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))).toEqual({
      eligible: true,
      reason: null,
    });
    expect(getSkillSurveyEligibility(TEST_AGENT_ID, requestContext('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))).toEqual({
      eligible: false,
      reason: 'insufficient-settled-sessions',
    });
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

  it('returns false for generic tasks like vault-evolve', () => {
    expect(isInstructionRequiredTask('vault-evolve')).toBe(false);
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

  it('returns undefined for tasks that do not use pre-assembled instructions', async () => {
    await expect(buildTaskInstruction('vault-evolve', undefined, undefined, undefined, undefined, undefined, undefined, TEST_REQUEST_CONTEXT)).resolves.toBeUndefined();
    await expect(buildTaskInstruction('skill-survey', undefined, undefined, undefined, undefined, undefined, undefined, TEST_REQUEST_CONTEXT)).resolves.toBeUndefined();
  });

  it('returns undefined for skill-generate when no approved candidates exist', async () => {
    await expect(buildTaskInstruction(SKILL_GENERATE_TASK, undefined, undefined, undefined, undefined, undefined, undefined, TEST_REQUEST_CONTEXT)).resolves.toBeUndefined();
  });

  it('returns undefined for skill-survey when no settled survey corpus exists', async () => {
    await expect(buildTaskInstruction('skill-survey', undefined, TEST_AGENT_ID, undefined, undefined, undefined, undefined, TEST_REQUEST_CONTEXT)).resolves.toBeUndefined();
  });

  it('returns bundle for skill-survey when settled survey corpus exists', async () => {
    createSettledSurveyCorpus();

    const result = await buildTaskInstruction('skill-survey', undefined, TEST_AGENT_ID, undefined, undefined, undefined, undefined, TEST_REQUEST_CONTEXT);
    expect(result).toBeDefined();
    expect(result!.instruction).toContain('project-specific procedural domains');
  });

  it('returns bundle for skill-generate when an approved candidate exists', async () => {
    const now = epochSeconds();
    insertCandidate({
      id: 'ready-to-generate',
      agent_id: TEST_AGENT_ID,
      topic: 'Ready topic',
      rationale: 'Ready rationale',
      created_at: now,
      updated_at: now,
    });
    updateCandidate('ready-to-generate', { status: CANDIDATE_STATUS.APPROVED, updated_at: now }, ALL_PROJECTS_SCOPE);

    const result = await buildTaskInstruction(SKILL_GENERATE_TASK, undefined, undefined, undefined, undefined, undefined, undefined, TEST_REQUEST_CONTEXT);
    expect(result).toBeDefined();
    expect(result!.instruction).toContain('Ready topic');
    expect(result!.context?.candidate_id).toBe('ready-to-generate');
  });

  it('returns undefined for cortex-instructions when stored input is already current', async () => {
    createAgent(DEFAULT_AGENT_ID);
    const config = MycoConfigSchema.parse({ version: 3 });
    // buildCortexInstructionsInput now requires a vaultDir for the
    // canopy-map gate AND a Grove project_id from the manifest. Use a
    // tmp dir with a pre-seeded manifest + machine_id so the build is
    // deterministic without writing to a real vault.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'myco-task-instr-'));
    const vaultDir = join(tmpRoot, '.myco');
    mkdirSync(vaultDir, { recursive: true });
    ensureProjectManifest(vaultDir, { projectName: 'task-instr-test' });
    writeFileSync(join(vaultDir, 'machine_id'), 'test-machine', 'utf-8');
    const requestContext = resolveRequestContextForVault(vaultDir);
    const built = await buildCortexInstructionsInput(config, vaultDir, undefined, requestContext);

    upsertCortexInstructions({
      agent_id: DEFAULT_AGENT_ID,
      content: 'Stored Cortex instructions',
      input_hash: built.inputHash,
      generated_at: epochSeconds(),
    });

    const result = await buildTaskInstruction(
      CORTEX_INSTRUCTIONS_TASK,
      undefined,
      undefined,
      tmpRoot,
      undefined,
      config,
      undefined,
      requestContext,
    );
    expect(result).toBeUndefined();
    rmSync(tmpRoot, { recursive: true, force: true });
  });
});
