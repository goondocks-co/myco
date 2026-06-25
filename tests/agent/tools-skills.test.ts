/**
 * Tests for vault skill lifecycle tools.
 *
 * Exercises vault_skill_candidates, vault_skill_records, and vault_write_skill
 * tool handlers directly against an in-memory database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';

// Mock embedding before imports
mock.module('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { getDatabase } from '@myco/db/client.js';
import { insertCandidate, getCandidate, updateCandidate } from '@myco/db/queries/skill-candidates.js';
import { getState } from '@myco/db/queries/agent-state.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { createVaultTools } from '@myco/agent/tools.js';
import { MAX_SKILL_DESCRIPTION_CHARS } from '@myco/agent/tools/skill-validator.js';
import { SKILL_SURVEY_RECONCILIATION_POLICY_MARKER } from '@myco/agent/skill-candidate-quality.js';
import { CANDIDATE_STATUS } from '@myco/constants/skill-candidate-status.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { ALL_PROJECTS_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';

import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'test-agent';
const TEST_RUN_ID = 'run-skills-001';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Build valid SKILL.md content with required frontmatter. */
function validSkillContent(name: string, body = '# Skill\n\nContent here.') {
  return `---\nname: myco:${name}\ndescription: Test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: Read, Grep, Glob\n---\n\n${body}`;
}

function validCandidateMetadata(overrides: Record<string, unknown> = {}) {
  return {
    evidence_bundle_id: 'bundle-test-001',
    quality_score: 0.82,
    quality_failures: '[]',
    coverage_matches: '[]',
    reconciliation_reason: `${SKILL_SURVEY_RECONCILIATION_POLICY_MARKER}: test reconciliation`,
    source_ids: JSON.stringify([
      { id: 'spore-test-001', type: 'spore' },
      { id: 'spore-test-002', type: 'spore' },
      { id: 'session-test-001', type: 'session' },
    ]),
    ...overrides,
  };
}

function detailedCandidateReviewRationale(subject = 'Candidate'): string {
  return [
    `PROCEDURE TEST: PASS - ${subject} covers repeatable Myco workflow procedures rather than static project facts.`,
    'PROJECT-SPECIFICITY TEST: PASS - Anchored to packages/myco source files, vault tools, and task orchestration conventions.',
    'REPEATABILITY TEST: PASS - Developers will repeat these procedures as the skill lifecycle evolves.',
    'BREADTH TEST: PASS - Covers multiple related procedures that belong in one reviewable skill domain.',
    'CROSS-SESSION EVIDENCE: PASS - Supported by multiple source refs from spores and sessions.',
    'QUALITY SCORE: PASS - Evidence metadata and coverage are explicit enough for human review.',
  ].join(' ');
}

function candidateMetadataWithSourceIds(
  sourceIds: Array<{ id: string; type: string }>,
  overrides: Record<string, unknown> = {},
) {
  return validCandidateMetadata({
    source_ids: JSON.stringify(sourceIds),
    ...overrides,
  });
}

function seedCandidateSourceRecords(
  projectId: string | null = null,
  sourceIds = {
    session: 'session-test-001',
    spores: ['spore-test-001', 'spore-test-002'],
  },
): void {
  const now = epochNow();
  upsertSession({
    id: sourceIds.session,
    project_id: projectId,
    agent: 'claude-code',
    started_at: now - 100,
    ended_at: null,
    status: 'active',
    title: 'Candidate source session',
    summary: 'Candidate source session covering resolved skill evidence.',
    created_at: now - 100,
  });
  for (const id of sourceIds.spores) {
    insertSpore({
      id,
      project_id: projectId,
      agent_id: TEST_AGENT_ID,
      session_id: sourceIds.session,
      observation_type: 'decision',
      content: `Resolved source ${id} for skill candidate quality tests.`,
      importance: 5,
      created_at: now - 90,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flip a candidate to 'approved' so downstream tools (vault_stage_skill,
 * vault_write_skill create path, vault_finalize_skill) accept it. The
 * structural gate rejects non-approved candidates, matching the real
 * skill-generate workflow where only human-approved candidates reach
 * these tools.
 */
function approveCandidate(id: string, projectId?: string | null): void {
  const scope = projectId == null ? ALL_PROJECTS_SCOPE : projectScope(projectId as GroveProjectId);
  updateCandidate(id, { status: CANDIDATE_STATUS.APPROVED, updated_at: epochNow() }, scope);
}

/** Insert an agent directly into the agents table. */
function createAgent(id: string): void {
  const db = getDatabase();
  const now = epochNow();
  db.prepare(
    `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, `agent-${id}`, now);
}

/** Insert an agent run directly (required FK for turns). */
function createRun(id: string, agentId: string): void {
  insertRun({
    id,
    agent_id: agentId,
    status: 'running',
    started_at: epochNow(),
  });
}

/** Look up a tool by name from the tools array. */
function findTool(tools: ReturnType<typeof createVaultTools>, name: string) {
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as SdkMcpToolDefinition<any>;
}

/** Parse the JSON text from a tool result. */
function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

function makeRequestContext(
  projectRoot: string,
  vaultDir: string,
  projectId: string,
): MycoRequestContext {
  return {
    projectRoot,
    projectId,
    groveId: `grove-${projectId}`,
    machineId: 'machine-test',
    sessionId: null,
    projectVaultDir: vaultDir,
    databasePath: path.join(vaultDir, 'vault.db'),
    source: 'explicit',
    // Explicit project/grove context = caller-asserted tenancy; the scope seam
    // binds it to project scope only when caller-asserted.
    tenancySource: 'caller',
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('vault skill tools', () => {
  let tools: ReturnType<typeof createVaultTools>;
  let tmpDir: string;
  let vaultDir: string;

  beforeAll(() => {
    setupTestDb();
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    cleanTestDb();

    // Per-test mkdtemp so tests never share staging or .agents/skills/
    // state. Eliminates cross-test coupling by construction — no manual
    // rm -rf needed between tests.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-skills-test-'));
    vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    ensureProjectManifest(vaultDir, { projectName: 'tools-skills-test' });

    createAgent(TEST_AGENT_ID);
    createRun(TEST_RUN_ID, TEST_AGENT_ID);
    seedCandidateSourceRecords();

    tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProjectTools(projectId: string): ReturnType<typeof createVaultTools> {
    return createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      projectRoot: tmpDir,
      vaultDir,
      requestContext: makeRequestContext(tmpDir, vaultDir, projectId),
    });
  }

  // -------------------------------------------------------------------------
  // vault_skill_survey_prepare
  // -------------------------------------------------------------------------

  describe('vault_skill_survey_prepare', () => {
    function createSession(id: string, createdAt: number): void {
      upsertSession({
        id,
        agent: 'claude-code',
        started_at: createdAt,
        created_at: createdAt,
        ended_at: createdAt + 60,
        status: 'completed',
        title: `${id} title`,
        summary: `${id} summary covering repo-specific work`,
      });
    }

    it('is read-only and returns prepared survey context', async () => {
      const now = epochNow();
      createSession('survey-tool-session-1', now - 300);
      createSession('survey-tool-session-2', now - 200);
      insertSpore({
        id: 'survey-tool-wisdom',
        agent_id: TEST_AGENT_ID,
        session_id: 'survey-tool-session-1',
        observation_type: 'wisdom',
        content: 'Daemon workflow in `packages/myco/src/daemon/main.ts` requires `make build` before `myco-dev restart`.',
        importance: 9,
        properties: JSON.stringify({ consolidated_from: ['survey-tool-source-1', 'survey-tool-source-2'] }),
        created_at: now - 180,
      });
      insertSpore({
        id: 'survey-tool-decision',
        agent_id: TEST_AGENT_ID,
        session_id: 'survey-tool-session-2',
        observation_type: 'decision',
        content: 'Keep PowerManager task wiring project-specific in `packages/myco/src/daemon/power-manager.ts`.',
        importance: 7,
        created_at: now - 170,
      });
      insertSpore({
        id: 'survey-tool-gotcha',
        agent_id: TEST_AGENT_ID,
        session_id: 'survey-tool-session-1',
        observation_type: 'gotcha',
        content: 'Dogfooding can keep old daemon code until restart after build.',
        importance: 6,
        created_at: now - 160,
      });
      insertCandidate({
        id: 'survey-tool-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Daemon workflow candidate',
        rationale: 'Existing candidate should be visible to queue reconciliation.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        created_at: now - 150,
        updated_at: now - 150,
      });

      const t = findTool(tools, 'vault_skill_survey_prepare');
      expect(t.annotations?.readOnlyHint).toBe(true);

      const result = await t.handler({ ignore_watermark: true }, undefined);
      const data = parseResult(result) as {
        watermark: { ignore_watermark: boolean };
        corpus_counts: { wisdom_spores: number; decisions: number; gotchas: number; sessions: number };
        queue: {
          total: number;
          actionable: number;
          cleanup_targets: Array<{ id: string; reconciliation_reasons: string[] }>;
          cleanup_target_ids: string[];
        };
        evidence_bundles: unknown[];
        prompt_markdown: string;
      };

      expect(data.watermark.ignore_watermark).toBe(true);
      expect(data.corpus_counts).toMatchObject({
        wisdom_spores: 1,
        decisions: 1,
        gotchas: 1,
        sessions: 2,
      });
      expect(data.queue).toMatchObject({ total: 1, actionable: 1 });
      expect(data.queue.cleanup_targets).toEqual([
        expect.objectContaining({
          id: 'survey-tool-candidate',
          reconciliation_reasons: expect.arrayContaining([
            'missing-quality-metadata',
            'missing-evidence-bundle',
            'insufficient-source-refs',
            'never-reconciled',
          ]),
        }),
      ]);
      expect(data.queue.cleanup_target_ids).toEqual(['survey-tool-candidate']);
      expect(data.evidence_bundles.length).toBeGreaterThanOrEqual(1);
      expect(data.prompt_markdown).toContain('### Existing Candidate Queue (1; 1 actionable; 1 cleanup targets)');
      expect(data.prompt_markdown).toContain('Required cleanup target IDs: ["survey-tool-candidate"]');
      expect(data.prompt_markdown).toContain('survey-tool-candidate');
      expect(data.prompt_markdown).toContain('### Candidate Evidence Bundles');
      expect(JSON.stringify(data).length).toBeLessThan(25_000);
    });

    it('marks stale policy and active coverage overlap candidates as cleanup targets', async () => {
      const now = epochNow();
      insertCandidate({
        id: 'survey-stale-policy-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Stale policy candidate',
        rationale: 'Looks mechanically valid but was reviewed before the current queue policy.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        ...validCandidateMetadata({
          last_reconciled_at: now - 20,
          reconciliation_reason: 'old survey review',
        }),
        created_at: now - 150,
        updated_at: now - 150,
      });
      insertCandidate({
        id: 'survey-active-coverage-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Active coverage candidate',
        rationale: 'Looks mechanically valid but carries active skill overlap coverage.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        ...validCandidateMetadata({
          coverage_matches: JSON.stringify(['skill_existing_active']),
          last_reconciled_at: now - 20,
        }),
        created_at: now - 140,
        updated_at: now - 140,
      });

      const t = findTool(tools, 'vault_skill_survey_prepare');
      const prepare = parseResult(await t.handler({ ignore_watermark: true }, undefined)) as {
        queue: {
          cleanup_targets: Array<{ id: string; reconciliation_reasons: string[] }>;
          cleanup_target_ids: string[];
        };
      };

      expect(prepare.queue.cleanup_target_ids).toHaveLength(2);
      expect(prepare.queue.cleanup_target_ids).toEqual(expect.arrayContaining([
        'survey-stale-policy-candidate',
        'survey-active-coverage-candidate',
      ]));
      expect(prepare.queue.cleanup_targets).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'survey-stale-policy-candidate',
          reconciliation_reasons: expect.arrayContaining([
            'stale-reconciliation-policy',
            'missing-human-review-evidence',
          ]),
        }),
        expect.objectContaining({
          id: 'survey-active-coverage-candidate',
          reconciliation_reasons: expect.arrayContaining([
            'active-skill-overlap',
            'missing-human-review-evidence',
          ]),
        }),
      ]));
    });

    it('treats reconciled candidates with thin human-review evidence as eligible cleanup work', async () => {
      const now = epochNow();
      insertCandidate({
        id: 'survey-thin-evidence-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Thin evidence candidate',
        rationale: 'Updating with validated bundle evidence.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        ...validCandidateMetadata({
          last_reconciled_at: now - 20,
        }),
        created_at: now - 140,
        updated_at: now - 140,
      });

      const t = findTool(tools, 'vault_skill_survey_prepare');
      const prepare = parseResult(await t.handler({}, undefined)) as {
        eligibility_gate: { eligible: boolean; reason: string | null };
        queue: {
          cleanup_targets: Array<{ id: string; reconciliation_reasons: string[] }>;
          cleanup_target_ids: string[];
        };
      };

      expect(prepare.eligibility_gate).toMatchObject({ eligible: true, reason: null });
      expect(prepare.queue.cleanup_target_ids).toEqual(['survey-thin-evidence-candidate']);
      expect(prepare.queue.cleanup_targets).toEqual([
        expect.objectContaining({
          id: 'survey-thin-evidence-candidate',
          reconciliation_reasons: ['missing-human-review-evidence'],
        }),
      ]);
    });

    it('validates and stores exhaustive reconciliation plans', async () => {
      const now = epochNow();
      insertCandidate({
        id: 'survey-plan-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Daemon workflow candidate',
        rationale: 'Legacy candidate must be reconciled.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        created_at: now - 150,
        updated_at: now - 150,
      });

      const t = findTool(tools, 'vault_skill_survey_reconciliation_plan');

      const incomplete = await t.handler({
        ignore_watermark: true,
        plan: JSON.stringify({ Update: [] }),
      }, undefined);
      expect(parseResult(incomplete)).toMatchObject({
        error: expect.stringContaining('incomplete'),
        unhandled_cleanup_target_ids: ['survey-plan-candidate'],
      });

      const complete = await t.handler({
        ignore_watermark: true,
        plan: JSON.stringify({
          Update: [{
            id: 'survey-plan-candidate',
            rationale: 'Attach valid evidence metadata.',
            evidence_bundle_id: 'bundle-survey-plan-candidate',
            quality_score: 0.82,
            quality_failures: [],
            coverage_matches: [],
            source_ids: [
              { id: 'spore-plan-1', type: 'spore' },
              { id: 'spore-plan-2', type: 'spore' },
              { id: 'session-plan-1', type: 'session' },
            ],
          }],
        }),
      }, undefined);
      expect(parseResult(complete)).toMatchObject({
        ok: true,
        state_key: 'skill-survey-reconciliation-decisions',
        cleanup_target_ids: ['survey-plan-candidate'],
        handled_cleanup_target_ids: ['survey-plan-candidate'],
        unhandled_cleanup_target_ids: [],
      });

      const state = getState(TEST_AGENT_ID, TEST_REQUEST_CONTEXT.projectId, 'skill-survey-reconciliation-decisions');
      expect(state).not.toBeNull();
      expect(JSON.parse(state!.value)).toMatchObject({
        cleanup_target_ids: ['survey-plan-candidate'],
        handled_cleanup_target_ids: ['survey-plan-candidate'],
        unhandled_cleanup_target_ids: [],
      });
    });

    it('rejects new candidate creation while queue cleanup targets remain', async () => {
      const now = epochNow();
      insertCandidate({
        id: 'survey-cleanup-before-create',
        agent_id: TEST_AGENT_ID,
        topic: 'Legacy cleanup candidate',
        rationale: 'Existing candidate must be cleaned before adding new queue work.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        created_at: now - 150,
        updated_at: now - 150,
      });

      const t = findTool(tools, 'vault_skill_survey_reconciliation_plan');
      const result = await t.handler({
        ignore_watermark: true,
        plan: JSON.stringify({
          Create: [{
            topic: 'New candidate while cleanup pending',
            rationale: 'Should wait until the review queue is clean.',
            confidence: 0.8,
            ...validCandidateMetadata({ evidence_bundle_id: 'new-cleanup-blocked-bundle' }),
          }],
          Dismiss: [{
            id: 'survey-cleanup-before-create',
            reason: 'Legacy candidate is missing required evidence metadata.',
            quality_failures: ['missing-quality-metadata', 'missing-evidence-bundle'],
          }],
        }),
      }, undefined);

      expect(parseResult(result)).toMatchObject({
        error: 'Queue cleanup must complete before creating new skill candidates',
        cleanup_target_ids: ['survey-cleanup-before-create'],
      });
    });

    it('requires reconciliation plans to classify the full active queue', async () => {
      const now = epochNow();
      insertCandidate({
        id: 'survey-plan-clean-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Clean candidate',
        rationale: detailedCandidateReviewRationale('Clean candidate'),
        status: CANDIDATE_STATUS.IDENTIFIED,
        ...validCandidateMetadata({
          evidence_bundle_id: 'bundle-clean-candidate',
          quality_score: 0.88,
          last_reconciled_at: now - 20,
        }),
        created_at: now - 150,
        updated_at: now - 150,
      });
      insertCandidate({
        id: 'survey-plan-legacy-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Legacy candidate',
        rationale: 'Legacy candidate must be reconciled.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        created_at: now - 140,
        updated_at: now - 140,
      });

      const t = findTool(tools, 'vault_skill_survey_reconciliation_plan');
      const missingQueueReview = await t.handler({
        ignore_watermark: true,
        plan: JSON.stringify({
          Dismiss: [{
            id: 'survey-plan-legacy-candidate',
            reason: 'Weak legacy candidate.',
            quality_failures: ['missing-quality-metadata', 'missing-evidence-bundle'],
          }],
        }),
      }, undefined);
      expect(parseResult(missingQueueReview)).toMatchObject({
        error: expect.stringContaining('every active identified/deferred candidate'),
        unreviewed_candidate_ids: ['survey-plan-clean-candidate'],
      });

      const complete = await t.handler({
        ignore_watermark: true,
        plan: JSON.stringify({
          Dismiss: [{
            id: 'survey-plan-legacy-candidate',
            reason: 'Weak legacy candidate.',
            quality_failures: ['missing-quality-metadata', 'missing-evidence-bundle'],
          }],
          Keep: [{
            id: 'survey-plan-clean-candidate',
            rationale: 'Reviewed and remains suitable for human review.',
          }],
        }),
      }, undefined);
      expect(parseResult(complete)).toMatchObject({
        ok: true,
        active_queue_candidate_ids: expect.arrayContaining([
          'survey-plan-clean-candidate',
          'survey-plan-legacy-candidate',
        ]),
        reviewed_candidate_ids: expect.arrayContaining([
          'survey-plan-clean-candidate',
          'survey-plan-legacy-candidate',
        ]),
        unreviewed_candidate_ids: [],
      });
    });

    it('applies only the validated reconciliation state', async () => {
      const now = epochNow();
      insertCandidate({
        id: 'survey-apply-clean-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Clean apply candidate',
        rationale: detailedCandidateReviewRationale('Clean apply candidate'),
        status: CANDIDATE_STATUS.IDENTIFIED,
        ...validCandidateMetadata({
          evidence_bundle_id: 'bundle-clean-apply-candidate',
          quality_score: 0.88,
          last_reconciled_at: now - 20,
        }),
        created_at: now - 150,
        updated_at: now - 150,
      });
      insertCandidate({
        id: 'survey-apply-legacy-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Legacy apply candidate',
        rationale: 'Legacy candidate should leave the active queue.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        created_at: now - 140,
        updated_at: now - 140,
      });
      const planTool = findTool(tools, 'vault_skill_survey_reconciliation_plan');
      const plan = await planTool.handler({
        ignore_watermark: true,
        plan: JSON.stringify({
          Dismiss: [{
            id: 'survey-apply-legacy-candidate',
            reason: 'Weak legacy candidate.',
            quality_failures: ['missing-quality-metadata', 'missing-evidence-bundle'],
          }],
          Keep: [{
            id: 'survey-apply-clean-candidate',
            rationale: 'Reviewed and remains suitable for human review.',
          }],
        }),
      }, undefined);
      expect(parseResult(plan)).toMatchObject({ ok: true });

      const applyTool = findTool(tools, 'vault_skill_survey_apply_reconciliation');
      const applied = await applyTool.handler({ ignore_watermark: true }, undefined);
      expect(parseResult(applied)).toMatchObject({
        ok: true,
        applied_counts: expect.objectContaining({
          dismissed: 1,
          kept: 1,
          skipped: 0,
        }),
        dismissed_candidate_ids: ['survey-apply-legacy-candidate'],
        remaining_cleanup_target_ids: [],
      });

      expect(getCandidate('survey-apply-legacy-candidate', ALL_PROJECTS_SCOPE)?.status).toBe(CANDIDATE_STATUS.DISMISSED);
      expect(getCandidate('survey-apply-clean-candidate', ALL_PROJECTS_SCOPE)?.status).toBe(CANDIDATE_STATUS.IDENTIFIED);
      const listed = parseResult(await findTool(tools, 'vault_skill_candidates').handler({
        action: 'list',
        statuses: [CANDIDATE_STATUS.IDENTIFIED],
        limit: 10,
      }, undefined)) as Array<{ topic: string }>;
      expect(listed.filter((candidate) => candidate.topic === 'Clean apply candidate')).toHaveLength(1);
    });

    it('hydrates identified plan metadata from deterministic evidence bundles', async () => {
      const now = epochNow();
      createSession('survey-hydrate-session-1', now - 300);
      createSession('survey-hydrate-session-2', now - 200);
      insertSpore({
        id: 'survey-hydrate-wisdom',
        agent_id: TEST_AGENT_ID,
        session_id: 'survey-hydrate-session-1',
        observation_type: 'wisdom',
        content: 'Agent task authoring in `packages/myco/src/agent/definitions/tasks/skill-survey.yaml` uses phased YAML, dependsOn, and vault tools.',
        importance: 9,
        created_at: now - 180,
      });
      insertSpore({
        id: 'survey-hydrate-decision',
        agent_id: TEST_AGENT_ID,
        session_id: 'survey-hydrate-session-2',
        observation_type: 'decision',
        content: 'Agent task authoring in `packages/myco/src/agent/definitions/tasks/skill-generate.yaml` must budget maxTurns across phases.',
        importance: 7,
        created_at: now - 170,
      });
      insertSpore({
        id: 'survey-hydrate-gotcha',
        agent_id: TEST_AGENT_ID,
        session_id: 'survey-hydrate-session-1',
        observation_type: 'gotcha',
        content: 'Agent task authoring in `packages/myco/src/agent/definitions/tasks/skill-evolve.yaml` fails when phase handoff state is stale.',
        importance: 6,
        created_at: now - 160,
      });

      const prepareTool = findTool(tools, 'vault_skill_survey_prepare');
      const prepare = parseResult(await prepareTool.handler({ ignore_watermark: true }, undefined)) as {
        evidence_bundles: Array<{
          id: string;
          score: number;
          failures: string[];
          coverageMatches: string[];
          sourceRefs: Array<{ id: string; type: string }>;
        }>;
      };
      const bundle = prepare.evidence_bundles.find((entry) =>
        entry.failures.length === 0 && entry.sourceRefs.length >= 3,
      );
      expect(bundle).toBeTruthy();

      const planTool = findTool(tools, 'vault_skill_survey_reconciliation_plan');
      const result = await planTool.handler({
        ignore_watermark: true,
        plan: JSON.stringify({
          Create: [{
            topic: bundle!.topic,
            rationale: 'The plan selects the deterministic bundle topic but sends malformed source ids and an invented bundle id.',
            confidence: 0.82,
            evidence_bundle_id: 'invented-agent-task-authoring-bundle',
            quality_score: 0.99,
            quality_failures: [],
            coverage_matches: [],
            source_ids: ['not-a-valid-source-ref'],
          }],
        }),
      }, undefined);

      expect(parseResult(result)).toMatchObject({
        ok: true,
        hydrated_evidence_bundle_metadata_count: 1,
      });

      const state = getState(TEST_AGENT_ID, TEST_REQUEST_CONTEXT.projectId, 'skill-survey-reconciliation-decisions');
      expect(state).not.toBeNull();
      const stored = JSON.parse(state!.value) as {
        Create: Array<{
          evidence_bundle_id: string;
          quality_score: number;
          quality_failures: string[];
          coverage_matches: string[];
          source_ids: Array<{ id: string; type: string }>;
        }>;
      };
      expect(stored.Create[0]).toMatchObject({
        evidence_bundle_id: bundle!.id,
        quality_score: bundle!.score,
        quality_failures: bundle!.failures,
        coverage_matches: bundle!.coverageMatches,
      });
      expect(stored.Create[0].source_ids).toEqual(bundle!.sourceRefs);
    });

    it('validates bundle decisions before reconciliation consumes them', async () => {
      const now = epochNow();
      createSession('survey-decision-session-1', now - 300);
      createSession('survey-decision-session-2', now - 200);
      insertSpore({
        id: 'survey-decision-wisdom',
        agent_id: TEST_AGENT_ID,
        session_id: 'survey-decision-session-1',
        observation_type: 'wisdom',
        content: 'Skill survey queue management in `packages/myco/src/agent/tools/skill-tools.ts` validates bundle decisions before reconciliation.',
        importance: 9,
        created_at: now - 180,
      });
      insertSpore({
        id: 'survey-decision-followup',
        agent_id: TEST_AGENT_ID,
        session_id: 'survey-decision-session-2',
        observation_type: 'decision',
        content: 'Skill survey queue management in `packages/myco/src/agent/definitions/tasks/skill-survey.yaml` must not use vault_set_state for bundle decisions.',
        importance: 8,
        created_at: now - 170,
      });
      insertSpore({
        id: 'survey-decision-gotcha',
        agent_id: TEST_AGENT_ID,
        session_id: 'survey-decision-session-1',
        observation_type: 'gotcha',
        content: 'Skill survey queue management in `packages/myco/src/agent/skill-survey-prepare.ts` can produce stale queue data if phase handoff is unvalidated.',
        importance: 7,
        created_at: now - 160,
      });

      const prepareTool = findTool(tools, 'vault_skill_survey_prepare');
      const prepare = parseResult(await prepareTool.handler({ ignore_watermark: true }, undefined)) as {
        evidence_bundles: Array<{
          id: string;
          topic: string;
          score: number;
          failures: string[];
          coverageMatches: string[];
          sourceRefs: Array<{ id: string; type: string }>;
        }>;
      };
      const bundle = prepare.evidence_bundles.find((entry) =>
        entry.failures.length === 0 && entry.sourceRefs.length >= 3,
      );
      expect(bundle).toBeTruthy();

      const decisionTool = findTool(tools, 'vault_skill_survey_bundle_decisions');
      const detailedRationale = [
        'PROCEDURE TEST: PASS - Covers how to validate skill survey queue management, bundle handoff, and reconciliation writes in this project.',
        'PROJECT-SPECIFICITY TEST: PASS - Anchored to packages/myco/src/agent/tools/skill-tools.ts, packages/myco/src/agent/definitions/tasks/skill-survey.yaml, and packages/myco/src/agent/skill-survey-prepare.ts.',
        'REPEATABILITY TEST: PASS - These procedures recur whenever the survey harness or queue policy changes.',
        'BREADTH TEST: PASS - Covers bundle review, reconciliation validation, and persisted queue cleanup.',
        'CROSS-SESSION EVIDENCE: PASS - Supported by multiple spores and sessions in the prepared source refs.',
        'QUALITY SCORE: PASS - Strong source coverage with no active skill overlap.',
      ].join(' ');
      const rejected = await decisionTool.handler({
        ignore_watermark: true,
        decisions: JSON.stringify({
          decisions: [{
            action: 'CREATE',
            topic: 'Invented survey queue architecture',
            evidence_bundle_id: 'invented-bundle-id',
          }],
        }),
      }, undefined);
      expect(parseResult(rejected)).toMatchObject({
        ok: true,
        state_key: 'skill-survey-bundle-decisions',
        decision_count: 1,
        complete: false,
        rejected_decision_count: 1,
      });

      const accepted = await decisionTool.handler({
        ignore_watermark: true,
        decisions: JSON.stringify({
          decisions: [{
            action: 'CREATE',
            topic: bundle!.topic,
            evidence_bundle_id: bundle!.id,
            rationale: detailedRationale,
            source_ids: ['bad-agent-copied-source'],
            quality_score: 0.99,
            quality_failures: [],
            coverage_matches: [],
          }],
          summary: { created: 1 },
        }),
      }, undefined);
      expect(parseResult(accepted)).toMatchObject({
        ok: true,
        state_key: 'skill-survey-bundle-decisions',
        decision_count: 2,
        reviewed_evidence_bundle_ids: expect.arrayContaining([bundle!.id]),
        hydrated_evidence_bundle_metadata_count: 1,
      });

      const state = getState(TEST_AGENT_ID, TEST_REQUEST_CONTEXT.projectId, 'skill-survey-bundle-decisions');
      expect(state).not.toBeNull();
      const stored = JSON.parse(state!.value) as {
        validated_at: number;
        decisions: Array<{
          bundle_id: string;
          evidence_bundle_id: string;
          quality_score: number;
          quality_failures: string[];
          coverage_matches: string[];
          source_ids: Array<{ id: string; type: string }>;
          rationale: string;
        }>;
      };
      expect(stored.validated_at).toBeGreaterThan(0);
      const storedBundleDecision = stored.decisions.find((decision) => decision.bundle_id === bundle!.id);
      expect(storedBundleDecision).toMatchObject({
        bundle_id: bundle!.id,
        evidence_bundle_id: bundle!.id,
        quality_score: bundle!.score,
        quality_failures: bundle!.failures,
        coverage_matches: bundle!.coverageMatches,
      });
      expect(storedBundleDecision!.source_ids).toEqual(bundle!.sourceRefs);
      expect(storedBundleDecision!.rationale).toBe(detailedRationale);

      const planTool = findTool(tools, 'vault_skill_survey_reconciliation_plan');
      const plan = await planTool.handler({
        ignore_watermark: true,
        plan: JSON.stringify({
          Create: [{
            topic: bundle!.topic,
            evidence_bundle_id: bundle!.id,
          }],
        }),
      }, undefined);
      expect(parseResult(plan)).toMatchObject({
        ok: true,
        hydrated_evidence_bundle_metadata_count: 1,
      });
      const reconciliationState = getState(TEST_AGENT_ID, TEST_REQUEST_CONTEXT.projectId, 'skill-survey-reconciliation-decisions');
      const storedPlan = JSON.parse(reconciliationState!.value) as { Create: Array<{ rationale: string }> };
      expect(storedPlan.Create[0]!.rationale).toBe(detailedRationale);
    });

    it('allows existing queue cleanup while fresh evidence bundle review is incomplete', async () => {
      const now = epochNow();
      createSession('survey-cleanup-incomplete-bundle-session-1', now - 300);
      createSession('survey-cleanup-incomplete-bundle-session-2', now - 200);
      insertSpore({
        id: 'survey-cleanup-incomplete-bundle-wisdom',
        agent_id: TEST_AGENT_ID,
        session_id: 'survey-cleanup-incomplete-bundle-session-1',
        observation_type: 'wisdom',
        content: 'Skill survey queue cleanup in `packages/myco/src/agent/tools/skill-tools.ts` must clean existing candidates even when new bundle review is incomplete.',
        importance: 9,
        created_at: now - 180,
      });
      insertSpore({
        id: 'survey-cleanup-incomplete-bundle-decision',
        agent_id: TEST_AGENT_ID,
        session_id: 'survey-cleanup-incomplete-bundle-session-2',
        observation_type: 'decision',
        content: 'Skill survey queue cleanup in `packages/myco/src/agent/definitions/tasks/skill-survey.yaml` separates existing candidate reconciliation from fresh candidate creation.',
        importance: 8,
        created_at: now - 170,
      });
      insertSpore({
        id: 'survey-cleanup-incomplete-bundle-gotcha',
        agent_id: TEST_AGENT_ID,
        session_id: 'survey-cleanup-incomplete-bundle-session-1',
        observation_type: 'gotcha',
        content: 'Skill survey queue cleanup in `packages/myco/src/agent/skill-survey-prepare.ts` can expose fresh evidence bundles that are unrelated to pending queue candidates.',
        importance: 7,
        created_at: now - 160,
      });
      insertCandidate({
        id: 'survey-cleanup-active-overlap',
        agent_id: TEST_AGENT_ID,
        topic: 'Agent harness overlap candidate',
        rationale: 'Existing queue item should be dismissed without requiring every new bundle to be reviewed first.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        ...validCandidateMetadata({
          evidence_bundle_id: 'queue-overlap-bundle',
          quality_failures: JSON.stringify(['active-skill-overlap']),
          coverage_matches: JSON.stringify(['skill-agent-harness']),
          last_reconciled_at: now - 60,
        }),
        created_at: now - 150,
        updated_at: now - 150,
      });

      const decisionTool = findTool(tools, 'vault_skill_survey_bundle_decisions');
      const incompleteBundleState = await decisionTool.handler({
        ignore_watermark: true,
        decisions: JSON.stringify({
          decisions: [{
            action: 'CREATE',
            topic: 'Invented unrelated bundle',
            evidence_bundle_id: 'not-a-current-bundle',
          }],
        }),
      }, undefined);
      expect(parseResult(incompleteBundleState)).toMatchObject({
        ok: true,
        complete: false,
      });

      const planTool = findTool(tools, 'vault_skill_survey_reconciliation_plan');
      const plan = await planTool.handler({
        ignore_watermark: true,
        plan: JSON.stringify({
          Dismiss: [{
            id: 'survey-cleanup-active-overlap',
            reason: 'Covered by an existing active skill.',
            quality_failures: ['active-skill-overlap'],
          }],
        }),
      }, undefined);

      expect(parseResult(plan)).toMatchObject({
        ok: true,
        cleanup_target_ids: ['survey-cleanup-active-overlap'],
        reviewed_candidate_ids: ['survey-cleanup-active-overlap'],
      });
    });

    it('rejects Create entries that represent existing active queue candidates', async () => {
      const now = epochNow();
      insertCandidate({
        id: 'survey-create-existing-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Existing survey candidate',
        rationale: 'The queue already has this candidate.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        ...validCandidateMetadata({
          evidence_bundle_id: 'existing-survey-candidate-bundle',
          last_reconciled_at: now - 60,
        }),
        created_at: now - 150,
        updated_at: now - 150,
      });

      const planTool = findTool(tools, 'vault_skill_survey_reconciliation_plan');
      const plan = await planTool.handler({
        ignore_watermark: true,
        plan: JSON.stringify({
          Create: [{
            topic: 'Existing survey candidate',
            rationale: 'Incorrectly modeled as a fresh candidate.',
            evidence_bundle_id: 'existing-survey-candidate-bundle',
            quality_score: 0.82,
            quality_failures: [],
            coverage_matches: [],
            source_ids: [
              { id: 'spore-test-001', type: 'spore' },
              { id: 'spore-test-002', type: 'spore' },
              { id: 'session-test-001', type: 'session' },
            ],
          }],
        }),
      }, undefined);

      expect(parseResult(plan)).toMatchObject({
        error: expect.stringContaining('Create entries cannot represent existing active queue candidates'),
        issues: expect.arrayContaining([
          expect.stringContaining('survey-create-existing-candidate'),
        ]),
      });
    });

    it('rejects reconciliation plans with invalid identified metadata before persistence', async () => {
      const now = epochNow();
      insertCandidate({
        id: 'survey-plan-invalid-metadata',
        agent_id: TEST_AGENT_ID,
        topic: 'Daemon workflow candidate',
        rationale: 'Legacy candidate must be reconciled.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        created_at: now - 150,
        updated_at: now - 150,
      });

      const t = findTool(tools, 'vault_skill_survey_reconciliation_plan');
      const result = await t.handler({
        ignore_watermark: true,
        plan: JSON.stringify({
          Update: [{
            id: 'survey-plan-invalid-metadata',
            rationale: 'Bad source refs should be rejected before persist.',
            evidence_bundle_id: 'bundle-invalid-metadata',
            quality_score: 0.82,
            quality_failures: [],
            coverage_matches: [],
            source_ids: [
              { id: 'spore-plan-1', type: 'spore' },
              { id: 'spore-plan-2', type: 'spore' },
            ],
          }],
        }),
      }, undefined);

      expect(parseResult(result)).toMatchObject({
        error: expect.stringContaining('candidate metadata'),
        issues: expect.arrayContaining([
          expect.stringContaining('source_ids must contain at least 3 valid source references'),
        ]),
      });

      const state = getState(TEST_AGENT_ID, TEST_REQUEST_CONTEXT.projectId, 'skill-survey-reconciliation-decisions');
      expect(state).toBeNull();
    });

    it('rejects cleanup deferrals without canonical quality failure reasons', async () => {
      const now = epochNow();
      insertCandidate({
        id: 'survey-plan-defer-without-failures',
        agent_id: TEST_AGENT_ID,
        topic: 'Daemon workflow candidate',
        rationale: 'Legacy candidate must be reconciled.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        created_at: now - 150,
        updated_at: now - 150,
      });

      const t = findTool(tools, 'vault_skill_survey_reconciliation_plan');
      const result = await t.handler({
        ignore_watermark: true,
        plan: JSON.stringify({
          Defer: [{
            id: 'survey-plan-defer-without-failures',
            reason: 'Needs better evidence later.',
            quality_failures: [],
          }],
        }),
      }, undefined);

      expect(parseResult(result)).toMatchObject({
        error: expect.stringContaining('candidate metadata'),
        issues: expect.arrayContaining([
          expect.stringContaining('quality_failures must include at least one canonical reason code'),
        ]),
      });

      const state = getState(TEST_AGENT_ID, TEST_REQUEST_CONTEXT.projectId, 'skill-survey-reconciliation-decisions');
      expect(state).toBeNull();
    });

    it('rejects disposition reasons contradicted by current candidate metadata', async () => {
      const now = epochNow();
      insertCandidate({
        id: 'survey-plan-contradicted-reason',
        agent_id: TEST_AGENT_ID,
        topic: 'Canopy file safety candidate',
        rationale: 'Candidate already carries evidence metadata.',
        status: CANDIDATE_STATUS.IDENTIFIED,
        ...validCandidateMetadata({
          evidence_bundle_id: 'bundle-canopy-file-safety',
          quality_score: 0.82,
          last_reconciled_at: now - 20,
        }),
        created_at: now - 150,
        updated_at: now - 150,
      });

      const t = findTool(tools, 'vault_skill_survey_reconciliation_plan');
      const result = await t.handler({
        ignore_watermark: true,
        plan: JSON.stringify({
          Dismiss: [{
            id: 'survey-plan-contradicted-reason',
            reason: 'Bad handoff claimed this candidate had no bundle.',
            quality_failures: ['missing-evidence-bundle'],
          }],
        }),
      }, undefined);

      expect(parseResult(result)).toMatchObject({
        error: expect.stringContaining('candidate metadata'),
        issues: expect.arrayContaining([
          expect.stringContaining('already has evidence_bundle_id'),
        ]),
      });

      const state = getState(TEST_AGENT_ID, TEST_REQUEST_CONTEXT.projectId, 'skill-survey-reconciliation-decisions');
      expect(state).toBeNull();
    });

    it('does not mark reconciled deferred candidates as immediate cleanup targets', async () => {
      const now = epochNow();
      insertCandidate({
        id: 'survey-prepare-reconciled-deferred',
        agent_id: TEST_AGENT_ID,
        topic: 'Reconciled deferred candidate',
        rationale: 'Candidate was intentionally deferred with a reason.',
        status: CANDIDATE_STATUS.DEFERRED,
        ...validCandidateMetadata({
          quality_failures: JSON.stringify(['existing-candidate-overlap']),
          last_reconciled_at: now - 20,
        }),
        created_at: now - 150,
        updated_at: now - 150,
      });

      const prepareTool = findTool(tools, 'vault_skill_survey_prepare');
      const prepare = parseResult(await prepareTool.handler({ ignore_watermark: true }, undefined)) as {
        queue: {
          actionable: number;
          cleanup_target_ids: string[];
        };
      };

      expect(prepare.queue.actionable).toBe(1);
      expect(prepare.queue.cleanup_target_ids).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // vault_skill_candidates
  // -------------------------------------------------------------------------

  describe('vault_skill_candidates', () => {
    it('list returns empty array when no candidates exist', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const result = await t.handler({ action: 'list' }, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });

    it('list supports multi-status filtering for active review queue audits', async () => {
      const now = epochNow();
      insertCandidate({
        id: 'identified-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Identified candidate',
        rationale: 'Active queue item',
        status: CANDIDATE_STATUS.IDENTIFIED,
        created_at: now,
        updated_at: now,
      });
      insertCandidate({
        id: 'deferred-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Deferred candidate',
        rationale: 'Deferred queue item',
        status: CANDIDATE_STATUS.DEFERRED,
        created_at: now,
        updated_at: now,
      });
      insertCandidate({
        id: 'dismissed-candidate',
        agent_id: TEST_AGENT_ID,
        topic: 'Dismissed candidate',
        rationale: 'Not active queue item',
        status: CANDIDATE_STATUS.DISMISSED,
        created_at: now,
        updated_at: now,
      });

      const t = findTool(tools, 'vault_skill_candidates');
      const result = await t.handler({
        action: 'list',
        statuses: [CANDIDATE_STATUS.IDENTIFIED, CANDIDATE_STATUS.DEFERRED],
        limit: 50,
      }, undefined);
      const data = parseResult(result) as Array<{ id: string }>;

      expect(data.map((candidate) => candidate.id).sort()).toEqual([
        'deferred-candidate',
        'identified-candidate',
      ]);
    });

    it('create rejects identified candidate without evidence metadata', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const result = await t.handler(
        {
          action: 'create',
          topic: 'Missing evidence metadata',
          rationale: 'Should not enter the identified queue without a bundle',
          source_ids: validCandidateMetadata().source_ids as string,
        },
        undefined,
      );

      const data = parseResult(result) as { error?: string };
      expect(data.error).toContain('evidence_bundle_id is required');
    });

    it('create rejects identified candidate without source evidence', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const { source_ids: _drop, ...metadata } = validCandidateMetadata();
      const result = await t.handler(
        {
          action: 'create',
          topic: 'Missing source evidence',
          rationale: 'Should not enter the identified queue without source refs',
          ...metadata,
        },
        undefined,
      );

      const data = parseResult(result) as { error?: string };
      expect(data.error).toContain('source_ids is required');
    });

    it('create rejects identified candidate with score below quality gate', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const result = await t.handler(
        {
          action: 'create',
          topic: 'Low quality metadata',
          rationale: 'Should not enter the identified queue below threshold',
          ...validCandidateMetadata({ quality_score: 0.69 }),
        },
        undefined,
      );

      const data = parseResult(result) as { error?: string };
      expect(data.error).toContain('quality_score must be >= 0.7');
    });

    it('create rejects identified candidate with non-empty quality failures', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const result = await t.handler(
        {
          action: 'create',
          topic: 'Failure metadata',
          rationale: 'Should not enter the identified queue with quality failures',
          ...validCandidateMetadata({ quality_failures: JSON.stringify(['missing-project-anchor']) }),
        },
        undefined,
      );

      const data = parseResult(result) as { error?: string };
      expect(data.error).toContain('quality_failures must be an empty array');
    });

    it('create with valid identified metadata succeeds and persists metadata', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const metadata = validCandidateMetadata({
        evidence_bundle_id: 'bundle-valid-001',
        quality_score: 0.91,
        coverage_matches: JSON.stringify(['active-skill:myco-existing']),
        last_reconciled_at: 1_777_000_000,
        reconciliation_reason: 'survey-refresh',
      });
      const result = await t.handler(
        {
          action: 'create',
          topic: 'Valid quality metadata',
          rationale: 'Carries evidence quality details for review',
          ...metadata,
        },
        undefined,
      );

      const candidate = parseResult(result) as {
        error?: string;
        evidence_bundle_id?: string;
        quality_score?: number;
        quality_failures?: string;
        coverage_matches?: string;
        last_reconciled_at?: number;
        reconciliation_reason?: string;
      };
      expect(candidate.error).toBeUndefined();
      expect(candidate.evidence_bundle_id).toBe('bundle-valid-001');
      expect(candidate.quality_score).toBe(0.91);
      expect(candidate.quality_failures).toBe('[]');
      expect(candidate.coverage_matches).toBe(JSON.stringify(['active-skill:myco-existing']));
      expect(candidate.last_reconciled_at).toBe(1_777_000_000);
      expect(candidate.reconciliation_reason).toBe('survey-refresh');
    });

    it('create rejects malformed source_ids when provided', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const result = await t.handler(
        {
          action: 'create',
          topic: 'Malformed source refs',
          rationale: 'Should reject source refs that cannot be normalized',
          ...validCandidateMetadata({ source_ids: JSON.stringify([{ id: 'unknown-001', type: 'unknown' }]) }),
        },
        undefined,
      );

      const data = parseResult(result) as { error?: string };
      expect(data.error).toContain('source_ids contains invalid source reference entries');
    });

    it('create rejects identified candidate with fewer than three source refs', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const result = await t.handler(
        {
          action: 'create',
          topic: 'Too few source refs',
          rationale: 'Should not enter the identified queue with weak source coverage',
          ...validCandidateMetadata({
            source_ids: JSON.stringify([
              { id: 'spore-test-001', type: 'spore' },
              { id: 'session-test-001', type: 'session' },
            ]),
          }),
        },
        undefined,
      );

      const data = parseResult(result) as { error?: string };
      expect(data.error).toContain('source_ids must contain at least 3 valid source references');
    });

    it('create rejects mixed valid and invalid source_ids entries', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const result = await t.handler(
        {
          action: 'create',
          topic: 'Partially malformed source refs',
          rationale: 'Should reject arrays that mix valid refs with junk',
          ...validCandidateMetadata({
            source_ids: JSON.stringify([
              { id: 'spore-test-001', type: 'spore' },
              { id: 'spore-test-002', type: 'spore' },
              { id: 'bad-ref', type: 'note' },
            ]),
          }),
        },
        undefined,
      );

      const data = parseResult(result) as { error?: string };
      expect(data.error).toContain('source_ids contains invalid source reference entries');
    });

    it('create rejects non-string quality metadata arrays', async () => {
      const t = findTool(tools, 'vault_skill_candidates');

      const badCoverage = parseResult(
        await t.handler(
          {
            action: 'create',
            topic: 'Bad coverage metadata',
            rationale: 'coverage_matches must be string identifiers',
            ...validCandidateMetadata({ coverage_matches: JSON.stringify([{}]) }),
          },
          undefined,
        ),
      ) as { error?: string };
      expect(badCoverage.error).toContain('coverage_matches must be a JSON array of strings');

      const badFailures = parseResult(
        await t.handler(
          {
            action: 'create',
            topic: 'Bad failure metadata',
            rationale: 'quality_failures must be string identifiers',
            ...validCandidateMetadata({ quality_failures: JSON.stringify([null]) }),
          },
          undefined,
        ),
      ) as { error?: string };
      expect(badFailures.error).toContain('quality_failures must be a JSON array of strings');
    });

    it('rejects unknown quality failure codes', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const result = await t.handler({
        action: 'create',
        topic: 'Deferred candidate with invalid failure code',
        rationale: 'Unknown failure codes should not be persisted.',
        status: CANDIDATE_STATUS.DEFERRED,
        quality_failures: JSON.stringify(['insufficient_source_references']),
      }, undefined);

      const data = parseResult(result) as { error?: string };
      expect(data.error).toContain('quality_failures contains unknown reason code');
      expect(data.error).toContain('insufficient-source-refs');
    });

    it('update enforces identified quality gate', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const dismissed = parseResult(
        await t.handler(
          {
            action: 'create',
            status: 'dismissed',
            topic: 'Deferred until evidence exists',
            rationale: 'Cleanup path records why it left the active queue',
            quality_failures: JSON.stringify(['missing-evidence-bundle']),
          },
          undefined,
        ),
      ) as { id: string; error?: string };
      expect(dismissed.error).toBeUndefined();

      const identifiedResult = await t.handler(
        { action: 'update', id: dismissed.id, status: 'identified' },
        undefined,
      );
      const identified = parseResult(identifiedResult) as { error?: string };
      expect(identified.error).toContain('source_ids must contain at least 3 valid source references');

      const missingBundleResult = await t.handler(
        {
          action: 'update',
          id: dismissed.id,
          status: 'identified',
          source_ids: validCandidateMetadata().source_ids,
        },
        undefined,
      );
      const missingBundle = parseResult(missingBundleResult) as { error?: string };
      expect(missingBundle.error).toContain('evidence_bundle_id is required');

      const valid = parseResult(
        await t.handler(
          {
            action: 'update',
            id: dismissed.id,
            status: 'identified',
            ...validCandidateMetadata({ evidence_bundle_id: 'bundle-update-001' }),
          },
          undefined,
        ),
      ) as { error?: string; status?: string };
      expect(valid.error).toBeUndefined();
      expect(valid.status).toBe('identified');

      const lowScoreResult = await t.handler(
        { action: 'update', id: dismissed.id, quality_score: 0.5 },
        undefined,
      );
      const lowScore = parseResult(lowScoreResult) as { error?: string };
      expect(lowScore.error).toContain('quality_score must be >= 0.7');
    });

    it('update to dismissed or deferred requires quality failure metadata', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const created = parseResult(
        await t.handler(
          {
            action: 'create',
            topic: 'Dismiss quality metadata not required',
            rationale: 'Identified candidate begins valid then exits queue',
            ...validCandidateMetadata({ evidence_bundle_id: 'bundle-dismiss-001' }),
          },
          undefined,
        ),
      ) as { id: string; error?: string };
      expect(created.error).toBeUndefined();

      const missingReason = parseResult(
        await t.handler({ action: 'update', id: created.id, status: 'dismissed' }, undefined),
      ) as { error?: string };
      expect(missingReason.error).toContain('quality_failures must include at least one canonical reason code');

      const dismissed = parseResult(
        await t.handler({
          action: 'update',
          id: created.id,
          status: 'dismissed',
          quality_failures: JSON.stringify(['active-skill-overlap']),
        }, undefined),
      ) as { status?: string; error?: string };
      expect(dismissed.error).toBeUndefined();
      expect(dismissed.status).toBe('dismissed');

      const deferred = parseResult(
        await t.handler({
          action: 'update',
          id: created.id,
          status: 'deferred',
          quality_failures: JSON.stringify(['deferred-review-required']),
        }, undefined),
      ) as { status?: string; error?: string };
      expect(deferred.error).toBeUndefined();
      expect(deferred.status).toBe('deferred');
    });

    it('update to dismissed can proceed for legacy candidates without source evidence', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const now = epochNow();
      const inserted = insertCandidate({
        id: 'candidate-legacy-dismiss-without-source',
        agent_id: TEST_AGENT_ID,
        topic: 'Legacy candidate without source refs',
        rationale: 'Old row should still be removable from the queue',
        evidence_bundle_id: 'bundle-legacy-dismiss',
        quality_score: 0.9,
        quality_failures: '[]',
        created_at: now,
        updated_at: now,
      });

      const result = parseResult(
        await t.handler({
          action: 'update',
          id: inserted.id,
          status: 'dismissed',
          quality_failures: JSON.stringify(['missing-evidence-bundle']),
        }, undefined),
      ) as { status?: string; error?: string };

      expect(result.error).toBeUndefined();
      expect(result.status).toBe('dismissed');
    });

    it('update rejects identified candidate when existing source evidence is empty', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const now = epochNow();
      const inserted = insertCandidate({
        id: 'candidate-empty-source-update',
        agent_id: TEST_AGENT_ID,
        topic: 'Empty source update',
        rationale: 'Legacy row without source refs',
        evidence_bundle_id: 'bundle-empty-source',
        quality_score: 0.9,
        quality_failures: '[]',
        created_at: now,
        updated_at: now,
      });

      const result = parseResult(
        await t.handler({ action: 'update', id: inserted.id, rationale: 'Still identified' }, undefined),
      ) as { error?: string };

      expect(result.error).toContain('source_ids must contain at least 3 valid source references');
    });

    it('update rejects identified candidate when existing coverage metadata is malformed', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const now = epochNow();
      const inserted = insertCandidate({
        id: 'candidate-bad-coverage-update',
        agent_id: TEST_AGENT_ID,
        topic: 'Malformed coverage update',
        rationale: 'Legacy row with malformed coverage metadata',
        ...validCandidateMetadata({
          evidence_bundle_id: 'bundle-bad-coverage-update',
          coverage_matches: JSON.stringify([{}]),
        }),
        created_at: now,
        updated_at: now,
      });

      const result = parseResult(
        await t.handler({ action: 'update', id: inserted.id, rationale: 'Still identified' }, undefined),
      ) as { error?: string };

      expect(result.error).toContain('coverage_matches must be a JSON array of strings');
    });

    it('update rejects topic overlap with an active skill while identified', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const now = epochNow();
      insertSkillRecord({
        id: 'skill-daemon-lifecycle',
        agent_id: TEST_AGENT_ID,
        name: 'daemon-process-lifecycle',
        display_name: 'Daemon Process Lifecycle',
        description: 'Manage daemon process lifecycle',
        path: '.agents/skills/daemon-process-lifecycle/SKILL.md',
        created_at: now,
        updated_at: now,
      });
      const candidate = parseResult(
        await t.handler(
          {
            action: 'create',
            topic: 'Distinct queue topic',
            rationale: 'Starts distinct before update',
            ...validCandidateMetadata({ evidence_bundle_id: 'bundle-active-overlap-update' }),
          },
          undefined,
        ),
      ) as { id: string };

      const result = parseResult(
        await t.handler(
          { action: 'update', id: candidate.id, topic: 'Daemon process lifecycle' },
          undefined,
        ),
      ) as { error?: string; overlapping_skills?: Array<{ name: string }> };

      expect(result.error).toContain('active skill');
      expect(result.overlapping_skills?.[0].name).toBe('daemon-process-lifecycle');
    });

    it('update rejects topic overlap with another non-dismissed candidate', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const existing = parseResult(
        await t.handler(
          {
            action: 'create',
            topic: 'Register PowerManager jobs',
            rationale: 'Existing identified candidate',
            ...validCandidateMetadata({ evidence_bundle_id: 'bundle-existing-candidate' }),
          },
          undefined,
        ),
      ) as { id: string };
      const candidate = parseResult(
        await t.handler(
          {
            action: 'create',
            topic: 'Distinct update candidate',
            rationale: 'Starts distinct before update',
            ...validCandidateMetadata({ evidence_bundle_id: 'bundle-update-candidate' }),
          },
          undefined,
        ),
      ) as { id: string };

      const result = parseResult(
        await t.handler(
          { action: 'update', id: candidate.id, topic: 'Register recurring PowerManager job' },
          undefined,
        ),
      ) as { error?: string; existing_candidate?: { id: string } };

      expect(result.error).toContain('review queue');
      expect(result.existing_candidate?.id).toBe(existing.id);
    });

    it('update allows topic overlap with a dismissed candidate as a warning', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const dismissed = parseResult(
        await t.handler(
          {
            action: 'create',
            topic: 'Author MCP tools for the vault daemon',
            rationale: 'Dismissed older candidate',
            ...validCandidateMetadata({ evidence_bundle_id: 'bundle-dismissed-overlap-source' }),
          },
          undefined,
        ),
      ) as { id: string };
      updateCandidate(dismissed.id, { status: 'dismissed', updated_at: epochNow() }, ALL_PROJECTS_SCOPE);
      const candidate = parseResult(
        await t.handler(
          {
            action: 'create',
            topic: 'Distinct dismissed-overlap update target',
            rationale: 'Starts distinct before update',
            ...validCandidateMetadata({ evidence_bundle_id: 'bundle-dismissed-overlap-target' }),
          },
          undefined,
        ),
      ) as { id: string };

      const result = parseResult(
        await t.handler(
          { action: 'update', id: candidate.id, topic: 'Author MCP tools for vault daemon' },
          undefined,
        ),
      ) as { error?: string; warning?: string; similar_dismissed_candidate?: { id: string } };

      expect(result.error).toBeUndefined();
      expect(result.warning).toMatch(/dismissed/);
      expect(result.similar_dismissed_candidate?.id).toBe(dismissed.id);
    });

    it('create rejects a non-dismissed overlap even when a dismissed overlap scores higher', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const dismissed = parseResult(
        await t.handler(
          {
            action: 'create',
            topic: 'PowerManager recurring jobs',
            rationale: 'Dismissed exact match',
            ...validCandidateMetadata({ evidence_bundle_id: 'bundle-dismissed-best-match' }),
          },
          undefined,
        ),
      ) as { id: string };
      updateCandidate(dismissed.id, { status: 'dismissed', updated_at: epochNow() }, ALL_PROJECTS_SCOPE);

      const activeCandidate = parseResult(
        await t.handler(
          {
            action: 'create',
            topic: 'Recurring PowerManager jobs',
            rationale: 'Non-dismissed overlapping candidate',
            ...validCandidateMetadata({ evidence_bundle_id: 'bundle-non-dismissed-overlap' }),
          },
          undefined,
        ),
      ) as { id: string; error?: string };
      expect(activeCandidate.error).toBeUndefined();

      const result = parseResult(
        await t.handler(
          {
            action: 'create',
            topic: 'PowerManager recurring jobs',
            rationale: 'Should reject because active candidate overlaps too',
            ...validCandidateMetadata({ evidence_bundle_id: 'bundle-dismissed-mask-attempt' }),
          },
          undefined,
        ),
      ) as { error?: string; existing_candidate?: { id: string } };

      expect(result.error).toContain('review queue');
      expect(result.existing_candidate?.id).toBe(activeCandidate.id);
    });

    it('create returns candidate with topic', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const result = await t.handler(
        {
          action: 'create',
          topic: 'Error handling patterns',
          rationale: 'Recurring pattern across sessions',
          confidence: 0.8,
          ...validCandidateMetadata(),
        },
        undefined,
      );
      const candidate = parseResult(result) as {
        id: string;
        topic: string;
        rationale: string;
        confidence: number;
        agent_id: string;
      };
      expect(candidate.id).toBeDefined();
      expect(candidate.topic).toBe('Error handling patterns');
      expect(candidate.rationale).toBe('Recurring pattern across sessions');
      expect(candidate.confidence).toBe(0.8);
      expect(candidate.agent_id).toBe(TEST_AGENT_ID);
    });

    it('get retrieves a created candidate', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const createResult = await t.handler(
        { action: 'create', topic: 'Test topic', rationale: 'Test rationale', ...validCandidateMetadata() },
        undefined,
      );
      const created = parseResult(createResult) as { id: string };

      const getResult = await t.handler(
        { action: 'get', id: created.id },
        undefined,
      );
      const fetched = parseResult(getResult) as { id: string; topic: string };
      expect(fetched.id).toBe(created.id);
      expect(fetched.topic).toBe('Test topic');
    });

    it('update modifies candidate fields', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      const createResult = await t.handler(
        { action: 'create', topic: 'Original', rationale: 'Original rationale', ...validCandidateMetadata() },
        undefined,
      );
      const created = parseResult(createResult) as { id: string };

      const updateResult = await t.handler(
        { action: 'update', id: created.id, status: 'validated', confidence: 0.95 },
        undefined,
      );
      const updated = parseResult(updateResult) as { status: string; confidence: number };
      expect(updated.status).toBe('validated');
      expect(updated.confidence).toBe(0.95);
    });

    it('list returns created candidates', async () => {
      const t = findTool(tools, 'vault_skill_candidates');
      await t.handler(
        { action: 'create', topic: 'Author agent pipeline tasks', rationale: 'Rationale A', ...validCandidateMetadata() },
        undefined,
      );
      await t.handler(
        { action: 'create', topic: 'Configure cross-platform hook guard', rationale: 'Rationale B', ...validCandidateMetadata() },
        undefined,
      );

      const listResult = await t.handler({ action: 'list' }, undefined);
      const data = parseResult(listResult) as unknown[];
      expect(data).toHaveLength(2);
    });

    it('scopes candidate lifecycle actions to the request project', async () => {
      const projectATool = findTool(createProjectTools('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'vault_skill_candidates');
      const projectBTool = findTool(createProjectTools('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), 'vault_skill_candidates');

      const createdA = parseResult(
        await projectATool.handler(
          { action: 'create', topic: 'Shared project topic', rationale: 'Project A rationale', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string; project_id: string; error?: string };
      const createdB = parseResult(
        await projectBTool.handler(
          { action: 'create', topic: 'Shared project topic', rationale: 'Project B rationale', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string; project_id: string; error?: string };

      expect(createdA.error).toBeUndefined();
      expect(createdB.error).toBeUndefined();
      expect(createdA.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(createdB.project_id).toBe('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

      const listA = parseResult(
        await projectATool.handler({ action: 'list' }, undefined),
      ) as Array<{ id: string; project_id: string }>;
      expect(listA).toHaveLength(1);
      expect(listA[0].id).toBe(createdA.id);
      expect(listA[0].project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const crossGet = parseResult(
        await projectATool.handler({ action: 'get', id: createdB.id }, undefined),
      ) as { error?: string };
      expect(crossGet.error).toContain('Candidate not found');

      const crossUpdate = parseResult(
        await projectATool.handler(
          { action: 'update', id: createdB.id, status: 'dismissed' },
          undefined,
        ),
      ) as { error?: string };
      expect(crossUpdate.error).toContain('Candidate not found');

      const crossDelete = parseResult(
        await projectATool.handler({ action: 'delete', id: createdB.id }, undefined),
      ) as { error?: string };
      expect(crossDelete.error).toContain('Candidate not found');

      const stillInB = parseResult(
        await projectBTool.handler({ action: 'get', id: createdB.id }, undefined),
      ) as { id: string; project_id: string };
      expect(stillInB.id).toBe(createdB.id);
      expect(stillInB.project_id).toBe('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    });

    // Cross-status dedup — skill-survey must not re-identify topics
    // that were already dismissed, generated, approved, or left as
    // open identified candidates. The existing active-skill check is
    // not enough; the full candidate table must be consulted. This is
    // the structural fix for the 2026-04-08 "dismissed candidates keep
    // coming back" workflow bug.
    describe('create: cross-status candidate dedup', () => {
      function makeTool() {
        return findTool(tools, 'vault_skill_candidates');
      }

      async function seedCandidate(
        topic: string,
        targetStatus: string,
      ): Promise<string> {
        const t = makeTool();
        const created = parseResult(
          await t.handler({ action: 'create', topic, rationale: 'seed', ...validCandidateMetadata() }, undefined),
        ) as { id: string };
        if (targetStatus !== 'identified') {
          updateCandidate(created.id, { status: targetStatus, updated_at: epochNow() }, ALL_PROJECTS_SCOPE);
        }
        return created.id;
      }

      it('allows creation with warning when topic overlaps a dismissed candidate', async () => {
        await seedCandidate('How to add a new MCP tool to the Myco vault daemon', 'dismissed');

        const t = makeTool();
        const result = parseResult(
          await t.handler(
            {
              action: 'create',
              topic: 'Add a new MCP tool to the Myco vault daemon',
              rationale: 'Re-identified from a later survey run',
              ...validCandidateMetadata(),
            },
            undefined,
          ),
        ) as { id?: string; warning?: string; similar_dismissed_candidate?: { topic: string } };

        // Dismissed overlap produces a soft warning, not a hard rejection
        expect(result.id).toBeDefined();
        expect(result.warning).toBeDefined();
        expect(result.warning).toMatch(/dismissed/);
        expect(result.similar_dismissed_candidate?.topic).toMatch(/MCP tool/);
      });

      it('rejects a new candidate whose topic overlaps a generated candidate', async () => {
        await seedCandidate('Register a recurring PowerManager job', 'generated');

        const t = makeTool();
        const result = parseResult(
          await t.handler(
            {
              action: 'create',
              topic: 'Register a new PowerManager job',
              rationale: 'Duplicate of already-generated skill',
              ...validCandidateMetadata(),
            },
            undefined,
          ),
        ) as { error?: string; existing_candidate?: { status: string } };

        expect(result.error).toBeDefined();
        expect(result.error).toMatch(/already fulfilled|generated/);
        expect(result.existing_candidate?.status).toBe('generated');
      });

      it('rejects a new candidate whose topic overlaps an approved candidate', async () => {
        await seedCandidate('Configure Cloudflare team sync for Myco', 'approved');

        const t = makeTool();
        const result = parseResult(
          await t.handler(
            {
              action: 'create',
              topic: 'Configure Cloudflare team sync',
              rationale: 'Duplicate of an already-queued candidate',
              ...validCandidateMetadata(),
            },
            undefined,
          ),
        ) as { error?: string; existing_candidate?: { status: string } };

        expect(result.error).toBeDefined();
        expect(result.error).toMatch(/already queued|approved/);
        expect(result.existing_candidate?.status).toBe('approved');
      });

      it('rejects a new candidate whose topic overlaps an identified candidate', async () => {
        await seedCandidate('Install and initialize Myco in a new project', 'identified');

        const t = makeTool();
        const result = parseResult(
          await t.handler(
            {
              action: 'create',
              topic: 'Install and initialize Myco',
              rationale: 'Duplicate of a pending identified candidate',
              ...validCandidateMetadata(),
            },
            undefined,
          ),
        ) as { error?: string; existing_candidate?: { status: string } };

        expect(result.error).toBeDefined();
        expect(result.error).toMatch(/review queue|update existing|identified/);
        expect(result.existing_candidate?.status).toBe('identified');
      });

      it('allows a genuinely distinct topic alongside a dismissed one', async () => {
        await seedCandidate('How to author an agent pipeline task', 'dismissed');

        const t = makeTool();
        const result = parseResult(
          await t.handler(
            {
              action: 'create',
              topic: 'How to render a notification banner in the UI',
              rationale: 'Unrelated topic',
              ...validCandidateMetadata(),
            },
            undefined,
          ),
        ) as { error?: string; id?: string };

        expect(result.error).toBeUndefined();
        expect(result.id).toBeDefined();
      });
    });

    // Privilege separation — humans approve, agents cannot. The MCP boundary
    // parses args against the tool's inputSchema before invoking the handler.
    // These tests exercise the schema directly (the test harness calls handler
    // without schema validation) to prove the Zod enum refuses values the
    // agent is not allowed to set.
    describe('status enum narrowing (privilege separation)', () => {
      it('inputSchema.status rejects "approved"', () => {
        const t = findTool(tools, 'vault_skill_candidates');
        const parsed = z.object(t.inputSchema).safeParse({
          action: 'update',
          id: 'some-id',
          status: 'approved',
        });
        expect(parsed.success).toBe(false);
      });

      it('inputSchema.status rejects "generated"', () => {
        const t = findTool(tools, 'vault_skill_candidates');
        const parsed = z.object(t.inputSchema).safeParse({
          action: 'update',
          id: 'some-id',
          status: 'generated',
        });
        expect(parsed.success).toBe(false);
      });

      it('inputSchema.status accepts "identified" and "dismissed"', () => {
        const t = findTool(tools, 'vault_skill_candidates');
        for (const allowed of ['identified', 'dismissed'] as const) {
          const parsed = z.object(t.inputSchema).safeParse({
            action: 'update',
            id: 'some-id',
            status: allowed,
          });
          expect(parsed.success, `expected ${allowed} to be accepted`).toBe(true);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // vault_skill_records
  // -------------------------------------------------------------------------

  describe('vault_skill_records', () => {
    it('list returns empty array when no records exist', async () => {
      const t = findTool(tools, 'vault_skill_records');
      const result = await t.handler({ action: 'list' }, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });

    it('list returns records after insertion', async () => {
      const now = epochNow();
      insertSkillRecord({
        id: 'skill-rec-1',
        agent_id: TEST_AGENT_ID,
        name: 'error-handling',
        display_name: 'Error Handling',
        description: 'Patterns for error handling',
        path: '.agents/skills/error-handling/SKILL.md',
        created_at: now,
        updated_at: now,
      });

      const t = findTool(tools, 'vault_skill_records');
      const result = await t.handler({ action: 'list' }, undefined);
      const data = parseResult(result) as Array<{ name: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe('error-handling');
    });

    it('get retrieves a record by name', async () => {
      const now = epochNow();
      insertSkillRecord({
        id: 'skill-rec-2',
        agent_id: TEST_AGENT_ID,
        name: 'testing-patterns',
        display_name: 'Testing Patterns',
        description: 'Patterns for testing',
        path: '.agents/skills/testing-patterns/SKILL.md',
        created_at: now,
        updated_at: now,
      });

      const t = findTool(tools, 'vault_skill_records');
      const result = await t.handler({ action: 'get', id: 'testing-patterns' }, undefined);
      const record = parseResult(result) as { name: string; display_name: string };
      expect(record.name).toBe('testing-patterns');
      expect(record.display_name).toBe('Testing Patterns');
    });

    it('scopes record lifecycle actions to the request project', async () => {
      const now = epochNow();
      insertSkillRecord({
        id: 'skill-project-a',
        project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        agent_id: TEST_AGENT_ID,
        name: 'project-a-skill',
        display_name: 'Project A Skill',
        description: 'Project A scoped skill',
        path: '.agents/skills/project-a-skill/SKILL.md',
        created_at: now,
        updated_at: now,
      });
      insertSkillRecord({
        id: 'skill-project-b',
        project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        agent_id: TEST_AGENT_ID,
        name: 'project-b-skill',
        display_name: 'Project B Skill',
        description: 'Project B scoped skill',
        path: '.agents/skills/project-b-skill/SKILL.md',
        created_at: now,
        updated_at: now,
      });

      const projectATool = findTool(createProjectTools('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'vault_skill_records');
      const projectBTool = findTool(createProjectTools('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), 'vault_skill_records');

      const listA = parseResult(
        await projectATool.handler({ action: 'list' }, undefined),
      ) as Array<{ id: string; project_id: string }>;
      expect(listA).toHaveLength(1);
      expect(listA[0].id).toBe('skill-project-a');
      expect(listA[0].project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const crossGet = parseResult(
        await projectATool.handler({ action: 'get', id: 'skill-project-b' }, undefined),
      ) as { error?: string };
      expect(crossGet.error).toContain('Skill record not found');

      const crossUpdate = parseResult(
        await projectATool.handler(
          { action: 'update', id: 'skill-project-b', status: 'stale' },
          undefined,
        ),
      ) as { error?: string };
      expect(crossUpdate.error).toContain('Skill record not found');

      const crossDelete = parseResult(
        await projectATool.handler({ action: 'delete', id: 'skill-project-b' }, undefined),
      ) as { error?: string };
      expect(crossDelete.error).toContain('Skill record not found');

      const stillInB = parseResult(
        await projectBTool.handler({ action: 'get', id: 'skill-project-b' }, undefined),
      ) as { id: string; project_id: string };
      expect(stillInB.id).toBe('skill-project-b');
      expect(stillInB.project_id).toBe('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    });
  });

  // -------------------------------------------------------------------------
  // vault_write_skill
  // -------------------------------------------------------------------------

  describe('vault_write_skill', () => {
    it('creates a skill file and record', async () => {
      const t = findTool(tools, 'vault_write_skill');
      const result = await t.handler(
        {
          name: 'error-handling',
          display_name: 'Error Handling',
          description: 'Best practices for error handling',
          content: validSkillContent('error-handling', '# Error Handling\n\nAlways use try-catch blocks.'),
          rationale: 'Observed in multiple sessions',
        },
        undefined,
      );
      const data = parseResult(result) as {
        id: string;
        name: string;
        path: string;
        generation: number;
      };

      expect(data.id).toBeDefined();
      expect(data.name).toBe('error-handling');
      expect(data.path).toBe('.agents/skills/error-handling/SKILL.md');
      expect(data.generation).toBe(1);

      // Verify file was written to disk
      const filePath = path.join(tmpDir, '.agents', 'skills', 'error-handling', 'SKILL.md');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toContain('# Error Handling');

      // Verify skill record exists in DB
      const recordsTool = findTool(tools, 'vault_skill_records');
      const recordsResult = await recordsTool.handler({ action: 'get', id: 'error-handling' }, undefined);
      const record = parseResult(recordsResult) as { name: string; generation: number };
      expect(record.name).toBe('error-handling');
      expect(record.generation).toBe(1);
    });

    it('rejects a write that references a nonexistent file path (fabrication gate)', async () => {
      // Seed a real source file so the codebase is visible (otherwise the gate
      // skips verification on an unseeable root).
      fs.mkdirSync(path.join(tmpDir, 'packages', 'myco', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'packages', 'myco', 'src', 'real.ts'), 'export const realThing = 1;\n');

      const t = findTool(tools, 'vault_write_skill');
      const result = parseResult(await t.handler(
        {
          name: 'fabricated-skill',
          display_name: 'Fabricated Skill',
          description: 'References a file that does not exist',
          content: validSkillContent('fabricated-skill', '# Skill\n\nSee `packages/myco/src/does-not-exist.ts`.'),
          rationale: 'test',
        },
        undefined,
      )) as { error?: string; missing_paths?: string[] };

      expect(result.error).toContain('does not exist in this repository');
      expect(result.missing_paths).toContain('packages/myco/src/does-not-exist.ts');
      // No file should have been written for a rejected skill.
      expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'fabricated-skill', 'SKILL.md'))).toBe(false);
    });

    it('allows a write that references only real paths/symbols', async () => {
      fs.mkdirSync(path.join(tmpDir, 'packages', 'myco', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'packages', 'myco', 'src', 'real.ts'), 'export const realThing = 1;\n');

      const t = findTool(tools, 'vault_write_skill');
      const result = parseResult(await t.handler(
        {
          name: 'honest-skill',
          display_name: 'Honest Skill',
          description: 'References only real code',
          content: validSkillContent('honest-skill', '# Skill\n\nSee `packages/myco/src/real.ts` and `realThing`.'),
          rationale: 'test',
        },
        undefined,
      )) as { error?: string; id?: string };

      expect(result.error).toBeUndefined();
      expect(result.id).toBeDefined();
    });

    it('rejects names with path separators or dot-dot segments', async () => {
      const t = findTool(tools, 'vault_write_skill');
      const liveSkillsDir = path.join(tmpDir, '.agents', 'skills');

      for (const name of ['../../etc', '../foo', 'foo/bar', '..', 'foo/../bar']) {
        const result = parseResult(
          await t.handler(
            {
              name,
              display_name: 'Invalid Skill',
              description: 'Should be rejected before any write occurs',
              content: validSkillContent(name),
            },
            undefined,
          ),
        ) as { error?: string };

        expect(result.error).toContain('Invalid skill name');
      }

      expect(fs.existsSync(liveSkillsDir)).toBe(false);
    });

    it('updates existing skill and bumps generation', async () => {
      const t = findTool(tools, 'vault_write_skill');

      // Create initial skill
      await t.handler(
        {
          name: 'versioned-skill',
          display_name: 'Versioned Skill',
          description: 'A skill that gets updated',
          content: validSkillContent('versioned-skill', '# Version 1'),
        },
        undefined,
      );

      // Update the skill
      const result = await t.handler(
        {
          name: 'versioned-skill',
          display_name: 'Versioned Skill',
          description: 'Updated description',
          content: validSkillContent('versioned-skill', '# Version 2'),
          rationale: 'New evidence found',
        },
        undefined,
      );
      const data = parseResult(result) as { generation: number; name: string };
      expect(data.generation).toBe(2);
      expect(data.name).toBe('versioned-skill');

      // Verify file content was updated
      const filePath = path.join(tmpDir, '.agents', 'skills', 'versioned-skill', 'SKILL.md');
      expect(fs.readFileSync(filePath, 'utf-8')).toContain('# Version 2');
    });

    it('updates candidate status when candidate_id provided', async () => {
      // Create a candidate first, then flip to approved so the
      // skill-write tools' structural gate accepts it.
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidateResult = await candidateTool.handler(
        { action: 'create', topic: 'My topic', rationale: 'My rationale', ...validCandidateMetadata() },
        undefined,
      );
      const candidate = parseResult(candidateResult) as { id: string };
      approveCandidate(candidate.id);

      // Write skill with candidate_id
      const t = findTool(tools, 'vault_write_skill');
      await t.handler(
        {
          name: 'from-candidate',
          display_name: 'From Candidate',
          description: 'Materialized from a candidate',
          content: validSkillContent('from-candidate', '# From Candidate'),
          candidate_id: candidate.id,
        },
        undefined,
      );

      // Verify candidate was updated to materialized
      const getResult = await candidateTool.handler(
        { action: 'get', id: candidate.id },
        undefined,
      );
      const updatedCandidate = parseResult(getResult) as { status: string; skill_id: string };
      expect(updatedCandidate.status).toBe('generated');
      expect(updatedCandidate.skill_id).toBeDefined();
    });

    it('creates skill records and candidate transitions in the request project', async () => {
      const projectATools = createProjectTools('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const projectBTools = createProjectTools('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      seedCandidateSourceRecords('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        session: 'session-project-a-source-001',
        spores: ['spore-project-a-source-001', 'spore-project-a-source-002'],
      });
      const candidateToolA = findTool(projectATools, 'vault_skill_candidates');
      const created = parseResult(
        await candidateToolA.handler(
          {
            action: 'create',
            topic: 'Scoped skill write',
            rationale: 'Project A only',
            ...candidateMetadataWithSourceIds([
              { id: 'spore-project-a-source-001', type: 'spore' },
              { id: 'spore-project-a-source-002', type: 'spore' },
              { id: 'session-project-a-source-001', type: 'session' },
            ]),
          },
          undefined,
        ),
      ) as { id: string; project_id: string };
      approveCandidate(created.id, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const writeToolA = findTool(projectATools, 'vault_write_skill');
      const written = parseResult(
        await writeToolA.handler(
          {
            name: 'scoped-skill-write',
            display_name: 'Scoped Skill Write',
            description: 'Materialized in one request project',
            content: validSkillContent('scoped-skill-write', '# Scoped Skill Write'),
            candidate_id: created.id,
          },
          undefined,
        ),
      ) as { id: string; name: string; error?: string };
      expect(written.error).toBeUndefined();
      expect(written.name).toBe('scoped-skill-write');

      const recordA = parseResult(
        await findTool(projectATools, 'vault_skill_records').handler(
          { action: 'get', id: 'scoped-skill-write' },
          undefined,
        ),
      ) as { id: string; project_id: string; candidate_id: string };
      expect(recordA.id).toBe(written.id);
      expect(recordA.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(recordA.candidate_id).toBe(created.id);

      const candidateA = parseResult(
        await candidateToolA.handler({ action: 'get', id: created.id }, undefined),
      ) as { status: string; skill_id: string; project_id: string };
      expect(candidateA.status).toBe('generated');
      expect(candidateA.skill_id).toBe(written.id);
      expect(candidateA.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const recordB = parseResult(
        await findTool(projectBTools, 'vault_skill_records').handler(
          { action: 'get', id: 'scoped-skill-write' },
          undefined,
        ),
      ) as { error?: string };
      expect(recordB.error).toContain('Skill record not found');

      const candidateB = parseResult(
        await findTool(projectBTools, 'vault_skill_candidates').handler(
          { action: 'get', id: created.id },
          undefined,
        ),
      ) as { error?: string };
      expect(candidateB.error).toContain('Candidate not found');
    });

    it('rejects update that changes user-invocable value', async () => {
      const t = findTool(tools, 'vault_write_skill');

      // First write: user-invocable: true
      await t.handler(
        {
          name: 'protected-test',
          display_name: 'Protected Test',
          description: 'Test frontmatter preservation',
          content: validSkillContent('protected-test'),
        },
        undefined,
      );

      // Second write: change user-invocable to false — should be rejected
      const badContent = validSkillContent('protected-test').replace(
        'user-invocable: true',
        'user-invocable: false',
      );
      const result = await t.handler(
        {
          name: 'protected-test',
          display_name: 'Protected Test',
          description: 'Test frontmatter preservation',
          content: badContent,
        },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string; violations?: string[] };
      expect(parsed.error).toContain('protected frontmatter fields were changed');
      expect(parsed.violations).toBeDefined();
      expect(parsed.violations!.some(v => v.includes('user-invocable'))).toBe(true);
    });

    it('rejects update that changes allowed-tools value', async () => {
      const t = findTool(tools, 'vault_write_skill');

      // First write
      await t.handler(
        {
          name: 'tools-test',
          display_name: 'Tools Test',
          description: 'Test allowed-tools preservation',
          content: validSkillContent('tools-test'),
        },
        undefined,
      );

      // Second write: change allowed-tools — should be rejected
      const badContent = validSkillContent('tools-test').replace(
        'allowed-tools: Read, Grep, Glob',
        'allowed-tools: Read, Edit, Write, Bash, Grep, Glob',
      );
      const result = await t.handler(
        {
          name: 'tools-test',
          display_name: 'Tools Test',
          description: 'Test allowed-tools preservation',
          content: badContent,
        },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string; violations?: string[] };
      expect(parsed.error).toContain('protected frontmatter fields were changed');
      expect(parsed.violations!.some(v => v.includes('allowed-tools'))).toBe(true);
    });

    it('allows update that preserves protected fields', async () => {
      const t = findTool(tools, 'vault_write_skill');

      // First write
      await t.handler(
        {
          name: 'preserve-test',
          display_name: 'Preserve Test',
          description: 'Test preservation allows valid updates',
          content: validSkillContent('preserve-test', '# Version 1'),
        },
        undefined,
      );

      // Second write: different body but same frontmatter — should succeed
      const result = await t.handler(
        {
          name: 'preserve-test',
          display_name: 'Preserve Test',
          description: 'Updated description',
          content: validSkillContent('preserve-test', '# Version 2\n\nNew content.'),
        },
        undefined,
      );
      const parsed = parseResult(result) as { generation?: number };
      expect(parsed.generation).toBe(2);
    });

    it('rejects skill writes with hard semantic contract violations', async () => {
      const t = findTool(tools, 'vault_write_skill');
      const result = await t.handler(
        {
          name: 'semantic-contract-bad',
          display_name: 'Semantic Contract Bad',
          description: 'Test semantic contract rejection',
          content: validSkillContent('semantic-contract-bad', [
            '# Semantic Contract Bad',
            '',
            'Run `myco skill lint` before writing generated skills.',
            'Generated survey candidates should be pending or approved.',
            'Treat inactive session rows as status = "settled".',
            'Read skill_candidates.evidence_metadata for survey evidence.',
          ].join('\n')),
        },
        undefined,
      );

      const parsed = parseResult(result) as { error?: string; issues?: string[] };
      expect(parsed.error).toContain('Skill validation failed');
      expect(parsed.issues).toEqual(expect.arrayContaining([
        expect.stringContaining('invented-myco-skill-lint-command'),
        expect.stringContaining('invalid-survey-candidate-status'),
        expect.stringContaining('invalid-session-status'),
        expect.stringContaining('invalid-skill-candidate-field'),
      ]));
    });

    it('accepts skill writes with correct semantic contract facts', async () => {
      const t = findTool(tools, 'vault_write_skill');
      const result = await t.handler(
        {
          name: 'semantic-contract-good',
          display_name: 'Semantic Contract Good',
          description: 'Test semantic contract acceptance',
          content: validSkillContent('semantic-contract-good', [
            '# Semantic Contract Good',
            '',
            'Run npm run lint:skills:strict -- --json before accepting generated skill content.',
            'Treat inactive session rows as completed/non-active session history.',
            'Skill-survey creates candidates with status identified.',
            'Approval is a later human dashboard step before generation.',
          ].join('\n')),
        },
        undefined,
      );

      const parsed = parseResult(result) as { error?: string; name?: string };
      expect(parsed.error).toBeUndefined();
      expect(parsed.name).toBe('semantic-contract-good');
    });

    // -----------------------------------------------------------------------
    // Dedup gates — prevent sibling skills for the same topic.
    // -----------------------------------------------------------------------

    it('rejects writes whose candidate_id is already fulfilled by a different skill', async () => {
      // Seed a candidate and fulfill it by writing a first skill.
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidateResult = await candidateTool.handler(
        { action: 'create', topic: 'Validator coercion', rationale: 'Seen twice in contributor PRs', ...validCandidateMetadata() },
        undefined,
      );
      const candidate = parseResult(candidateResult) as { id: string };
      approveCandidate(candidate.id);

      const t = findTool(tools, 'vault_write_skill');
      await t.handler(
        {
          name: 'validator-coercion-pattern',
          display_name: 'Validator Coercion Pattern',
          description: 'Use the coerced validated_data, not the original params',
          content: validSkillContent('validator-coercion-pattern', '# Step 1'),
          candidate_id: candidate.id,
        },
        undefined,
      );

      // Second write for the same candidate under a different name — should be rejected
      const result = await t.handler(
        {
          name: 'validator-registry-coercion',
          display_name: 'Validator Registry Coercion',
          description: 'A different write targeting the same candidate',
          content: validSkillContent('validator-registry-coercion', '# Step 1'),
          candidate_id: candidate.id,
        },
        undefined,
      );

      const parsed = parseResult(result) as {
        error?: string;
        existing_skill?: { name: string };
      };
      expect(parsed.error).toContain('already fulfilled');
      expect(parsed.existing_skill?.name).toBe('validator-coercion-pattern');

      // The second skill's directory must NOT exist on disk — rejection is early.
      const rejectedPath = path.join(
        tmpDir, '.agents', 'skills', 'validator-registry-coercion', 'SKILL.md',
      );
      expect(fs.existsSync(rejectedPath)).toBe(false);
    });

    it('allows writes to the same name when candidate is already linked (evolve path)', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidateResult = await candidateTool.handler(
        { action: 'create', topic: 'Evolution test', rationale: 'Needs to allow bumping generation', ...validCandidateMetadata() },
        undefined,
      );
      const candidate = parseResult(candidateResult) as { id: string };
      approveCandidate(candidate.id);

      const t = findTool(tools, 'vault_write_skill');
      await t.handler(
        {
          name: 'evolution-test',
          display_name: 'Evolution Test',
          description: 'Initial version',
          content: validSkillContent('evolution-test', '# Version 1'),
          candidate_id: candidate.id,
        },
        undefined,
      );

      // Same name — should bump generation, not trip the dedup gate.
      const result = await t.handler(
        {
          name: 'evolution-test',
          display_name: 'Evolution Test',
          description: 'Initial version',
          content: validSkillContent('evolution-test', '# Version 2'),
          candidate_id: candidate.id,
        },
        undefined,
      );
      const parsed = parseResult(result) as { generation?: number; error?: string };
      expect(parsed.error).toBeUndefined();
      expect(parsed.generation).toBe(2);
    });

    it('rejects writes whose description overlaps an existing active skill', async () => {
      const t = findTool(tools, 'vault_write_skill');

      // Seed an active skill with a distinctive description.
      await t.handler(
        {
          name: 'validator-coercion-first',
          display_name: 'First Skill',
          description:
            'Use when implementing or modifying tools that use UniFiValidatorRegistry.validate(). ' +
            'Ensures you use the coerced normalized validated_data returned by the registry ' +
            'rather than the original params, preventing silent failures in the controller.',
          content: validSkillContent('validator-coercion-first', '# Content'),
        },
        undefined,
      );

      // New skill with a near-duplicate description — should be rejected.
      const result = await t.handler(
        {
          name: 'validator-coercion-second',
          display_name: 'Second Skill',
          description:
            'Use when implementing or modifying any tool in unifi-mcp that uses ' +
            'UniFiValidatorRegistry.validate(). Prevents the silent bypass bug by ensuring ' +
            'the coerced normalized validated_data is used instead of the original params dict.',
          content: validSkillContent('validator-coercion-second', '# Content'),
        },
        undefined,
      );

      const parsed = parseResult(result) as {
        error?: string;
        overlapping_skill?: { name: string };
        similarity?: number;
      };
      expect(parsed.error).toContain('overlaps with existing active skill');
      expect(parsed.overlapping_skill?.name).toBe('validator-coercion-first');
      expect(parsed.similarity).toBeGreaterThanOrEqual(0.4);
    });

    it('allows writes whose description is distinct from existing skills', async () => {
      const t = findTool(tools, 'vault_write_skill');

      await t.handler(
        {
          name: 'error-logging',
          display_name: 'Error Logging',
          description: 'Structured error logging patterns for async handlers',
          content: validSkillContent('error-logging', '# Logging'),
        },
        undefined,
      );

      // Completely unrelated topic — should be allowed.
      const result = await t.handler(
        {
          name: 'database-migrations',
          display_name: 'Database Migrations',
          description: 'Safe schema migration procedures for production SQLite',
          content: validSkillContent('database-migrations', '# Migrations'),
        },
        undefined,
      );
      const parsed = parseResult(result) as { generation?: number; error?: string };
      expect(parsed.error).toBeUndefined();
      expect(parsed.generation).toBe(1);
    });

    it('rejects writes with hard skill-content contamination', async () => {
      const t = findTool(tools, 'vault_write_skill');

      const result = await t.handler(
        {
          name: 'contaminated-skill',
          display_name: 'Contaminated Skill',
          description: 'Skill with release-state contamination',
          content: validSkillContent(
            'contaminated-skill',
            '# Contaminated\n\nCritical discovery (v0.27.17): use the new workflow.',
          ),
        },
        undefined,
      );

      const parsed = parseResult(result) as { error?: string; issues?: string[] };
      expect(parsed.error).toContain('Skill validation failed');
      expect(parsed.issues).toEqual(expect.arrayContaining([
        expect.stringContaining('myco-version-parenthetical'),
      ]));
      expect(parsed.issues).toEqual(expect.arrayContaining([
        expect.stringContaining('(v0.27.17)'),
      ]));
    });

    it('rejects writes with strict skill-lint warnings', async () => {
      const t = findTool(tools, 'vault_write_skill');

      const result = await t.handler(
        {
          name: 'warn-only-skill',
          display_name: 'Warn Only Skill',
          description: 'Skill with durable third-party references',
          content: validSkillContent(
            'warn-only-skill',
            [
              '# Warn Only',
              '',
              'Use Node (v22.11.0) for local testing.',
              'Use npm@v10.1.0 for package scripts.',
              'Use Node version >= v22.12.0 for local runtime checks.',
              'SQLite does not support DROP COLUMN before version 3.35.0.',
              'Use PR #346 as a teaching example for docs placement.',
            ].join('\n'),
          ),
        },
        undefined,
      );

      const parsed = parseResult(result) as { error?: string; issues?: string[] };
      expect(parsed.error).toContain('Skill validation failed');
      expect(parsed.issues).toEqual(expect.arrayContaining([
        expect.stringContaining('third-party-version'),
        expect.stringContaining('reference-id'),
      ]));
      expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'warn-only-skill', 'SKILL.md'))).toBe(false);
    });

    it('allows updating an existing skill that overlaps its own description', async () => {
      const t = findTool(tools, 'vault_write_skill');

      // Seed
      await t.handler(
        {
          name: 'self-overlap',
          display_name: 'Self Overlap',
          description: 'Structured error logging patterns for async background handlers',
          content: validSkillContent('self-overlap', '# V1'),
        },
        undefined,
      );

      // Update with a description that obviously overlaps its own prior description —
      // should NOT trip the dedup gate because existingSameName is found first.
      const result = await t.handler(
        {
          name: 'self-overlap',
          display_name: 'Self Overlap',
          description: 'Structured error logging patterns for async background handlers, refined',
          content: validSkillContent('self-overlap', '# V2'),
        },
        undefined,
      );
      const parsed = parseResult(result) as { generation?: number; error?: string };
      expect(parsed.error).toBeUndefined();
      expect(parsed.generation).toBe(2);
    });
  });

  describe('vault_scan_skill_contamination', () => {
    it('is read-only and returns hard and warn spans', async () => {
      const t = findTool(tools, 'vault_scan_skill_contamination');
      expect(t.annotations?.readOnlyHint).toBe(true);

      const result = await t.handler(
        {
          content: validSkillContent(
            'scan-target',
            [
              '# Scan Target',
              '',
              'Critical discovery (v0.27.17): hard contamination.',
              'The procedure was drafted on ck/skill-lifecycle-content-hygiene.',
              'The source came from session-abc123 and spore-gotcha-skill-survey.',
              'SQLite does not support DROP COLUMN before version 3.35.0.',
            ].join('\n'),
          ),
          strict: true,
        },
        undefined,
      );

      const parsed = parseResult(result) as {
        ok: boolean;
        strict: boolean;
        hard: Array<{ kind: string; text: string; start: number; end: number }>;
        warn: Array<{ kind: string; text: string; start: number; end: number }>;
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.strict).toBe(true);
      expect(parsed.hard).toEqual([
        expect.objectContaining({ kind: 'myco-version-parenthetical', text: '(v0.27.17)' }),
        expect.objectContaining({ kind: 'branch-name', text: 'ck/skill-lifecycle-content-hygiene' }),
        expect.objectContaining({ kind: 'state-id', text: 'session-abc123' }),
        expect.objectContaining({ kind: 'state-id', text: 'spore-gotcha-skill-survey' }),
      ]);
      expect(parsed.warn).toEqual([
        expect.objectContaining({ kind: 'third-party-version', text: '3.35.0' }),
      ]);
    });

    it('reports ok=false for warning-only content to match live write gates', async () => {
      const t = findTool(tools, 'vault_scan_skill_contamination');

      const result = await t.handler(
        {
          content: validSkillContent(
            'scan-warn-target',
            [
              '# Scan Warn Target',
              '',
              'Use Node (v22.11.0) for local testing.',
            ].join('\n'),
          ),
        },
        undefined,
      );

      const parsed = parseResult(result) as {
        ok: boolean;
        strict: boolean;
        hard: Array<{ kind: string; text: string }>;
        warn: Array<{ kind: string; text: string }>;
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.strict).toBe(false);
      expect(parsed.hard).toEqual([]);
      expect(parsed.warn).toEqual([
        expect.objectContaining({ kind: 'third-party-version', text: 'v22.11.0' }),
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // vault_stage_skill — provisional writes used by skill-generate's draft
  // phase. Writes SKILL.md + manifest.json to .myco/staging/skills/<cand>/
  // but does NOT touch the live DB or .agents/skills/ directory.
  // -------------------------------------------------------------------------

  describe('vault_stage_skill', () => {
    it('stages a SKILL.md + manifest without creating a skill_records row', async () => {
      // Seed a candidate
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidateResult = await candidateTool.handler(
        { action: 'create', topic: 'Staging topic', rationale: 'Test rationale', ...validCandidateMetadata() },
        undefined,
      );
      const candidate = parseResult(candidateResult) as { id: string };
      approveCandidate(candidate.id);

      // Stage a skill
      const stageTool = findTool(tools, 'vault_stage_skill');
      const result = await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'staged-skill',
          display_name: 'Staged Skill',
          description: 'A skill written to staging',
          content: validSkillContent('staged-skill', '# Staged'),
          rationale: 'Initial stage',
        },
        undefined,
      );
      const data = parseResult(result) as {
        candidate_id: string;
        staging_path: string;
        status: string;
      };

      // Assert staging metadata returned
      expect(data.candidate_id).toBe(candidate.id);
      expect(data.status).toBe('staged');
      expect(data.staging_path).toContain(candidate.id);
      expect(fs.existsSync(data.staging_path)).toBe(true);

      // Assert NO skill record was created
      const recordsTool = findTool(tools, 'vault_skill_records');
      const recordsResult = await recordsTool.handler({ action: 'list' }, undefined);
      expect(parseResult(recordsResult)).toEqual([]);

      // Assert the live .agents/skills/ directory does NOT contain the skill
      const liveFile = path.join(tmpDir, '.agents', 'skills', 'staged-skill', 'SKILL.md');
      expect(fs.existsSync(liveFile)).toBe(false);

      // Candidate stays in 'approved' state — staging does not advance
      // the lifecycle to 'generated' (that's finalize's job).
      const getResult = await candidateTool.handler(
        { action: 'get', id: candidate.id },
        undefined,
      );
      const updated = parseResult(getResult) as { status: string; skill_id: string | null };
      expect(updated.status).toBe('approved');
      expect(updated.skill_id).toBeNull();
    });

    it('rejects invalid skill directory names before writing staging files', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Invalid name topic', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      const stagingDir = path.join(vaultDir, 'staging', 'skills');

      for (const name of ['../../etc', '../foo', 'foo/bar', '..', 'foo/../bar']) {
        const result = parseResult(
          await stageTool.handler(
            {
              candidate_id: candidate.id,
              name,
              display_name: 'Invalid Staged Skill',
              description: 'Should be rejected before staging',
              content: validSkillContent(name),
            },
            undefined,
          ),
        ) as { error?: string };

        expect(result.error).toContain('Invalid skill name');
      }

      expect(fs.existsSync(stagingDir)).toBe(false);
    });

    it('overwrites a prior staged version for the same candidate (iterative drafts)', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Iteration test', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'iter-skill',
          display_name: 'Iter Skill',
          description: 'First draft',
          content: validSkillContent('iter-skill', '# Version 1'),
          rationale: 'first pass',
        },
        undefined,
      );

      const secondResult = await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'iter-skill',
          display_name: 'Iter Skill',
          description: 'Second draft',
          content: validSkillContent('iter-skill', '# Version 2'),
          rationale: 'revision',
        },
        undefined,
      );
      const parsed = parseResult(secondResult) as { staging_path: string; status: string };
      expect(parsed.status).toBe('staged');

      // Read back via staging helper and confirm it reflects v2
      expect(fs.readFileSync(parsed.staging_path, 'utf-8')).toContain('# Version 2');
    });

    it('rejects staging when validation fails on the content', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Invalid staging', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      const result = await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'broken-skill',
          display_name: 'Broken',
          description: 'Bad content',
          content: 'no frontmatter here — should fail validation',
          rationale: 'test',
        },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string };
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/validation failed/i);
    });

    it('rejects staging when hard skill-content contamination is present', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Contaminated staging', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      const result = await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'contaminated-stage',
          display_name: 'Contaminated Stage',
          description: 'Bad staged content',
          content: validSkillContent(
            'contaminated-stage',
            '# Stage\n\nThis operational pattern was added in PR #508.',
          ),
          rationale: 'test',
        },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string; issues?: string[] };
      expect(parsed.error).toContain('validation failed');
      expect(parsed.issues).toEqual(expect.arrayContaining([
        expect.stringContaining('marker-artifact'),
      ]));

      const stagedFile = path.join(vaultDir, 'staging', 'skills', candidate.id, 'SKILL.md');
      expect(fs.existsSync(stagedFile)).toBe(false);
    });

    it('rejects staging when content references nonexistent code paths', async () => {
      fs.mkdirSync(path.join(tmpDir, 'packages', 'myco', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'packages', 'myco', 'src', 'real.ts'), 'export const realThing = 1;\n');

      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Fabricated staging', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      const result = await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'fabricated-stage',
          display_name: 'Fabricated Stage',
          description: 'Bad staged content',
          content: validSkillContent(
            'fabricated-stage',
            '# Stage\n\nSee `packages/myco/src/does-not-exist.ts` before changing this workflow.',
          ),
          rationale: 'test',
        },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string; missing_paths?: string[] };
      expect(parsed.error).toContain('does not exist in this repository');
      expect(parsed.missing_paths).toContain('packages/myco/src/does-not-exist.ts');

      const stagedFile = path.join(vaultDir, 'staging', 'skills', candidate.id, 'SKILL.md');
      expect(fs.existsSync(stagedFile)).toBe(false);
    });

    it('rejects staging when description overlaps an existing active skill', async () => {
      // Seed an active skill via vault_write_skill
      const writeTool = findTool(tools, 'vault_write_skill');
      await writeTool.handler(
        {
          name: 'existing-live',
          display_name: 'Existing Live',
          description: 'Structured error logging patterns for async background handlers',
          content: validSkillContent('existing-live', '# Live'),
        },
        undefined,
      );

      // Try to stage a new skill with a near-duplicate description
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Overlap test', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      const result = await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'overlap-stage',
          display_name: 'Overlap Stage',
          description: 'Structured error logging patterns for async background handlers, retried',
          content: validSkillContent('overlap-stage', '# Stage'),
          rationale: 'test',
        },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string };
      expect(parsed.error).toContain('overlaps with existing active skill');
    });
  });

  // -------------------------------------------------------------------------
  // Approved-status gate — skill-write tools must refuse to operate on
  // candidates that are not in 'approved' state. This is the structural
  // enforcement that prevents skill-generate from writing skills for
  // candidates a human never signed off on.
  // -------------------------------------------------------------------------

  describe('approved-status gate', () => {
    async function stage(candidateId: string, name: string) {
      const stageTool = findTool(tools, 'vault_stage_skill');
      return parseResult(
        await stageTool.handler(
          {
            candidate_id: candidateId,
            name,
            display_name: name,
            description: `Gate test for ${name}`,
            content: validSkillContent(name),
            rationale: 'gate test',
          },
          undefined,
        ),
      ) as { error?: string; status?: string };
    }

    it('vault_stage_skill rejects a candidate in identified state', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate identified', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string; status: string };
      expect(candidate.status).toBe('identified');

      const result = await stage(candidate.id, 'gate-identified');
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/identified/);
      expect(result.error).toMatch(/approved/);
    });

    it('vault_stage_skill rejects a candidate in dismissed state', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate dismissed', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      updateCandidate(candidate.id, { status: 'dismissed', updated_at: epochNow() }, ALL_PROJECTS_SCOPE);

      const result = await stage(candidate.id, 'gate-dismissed');
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/dismissed|not approved/i);
    });

    it('vault_stage_skill rejects a candidate in generated state', async () => {
      // A generated candidate is already fulfilled — re-staging would
      // create a duplicate under a different name.
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate generated', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      updateCandidate(candidate.id, { status: 'generated', updated_at: epochNow() }, ALL_PROJECTS_SCOPE);

      const result = await stage(candidate.id, 'gate-generated');
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/generated|already fulfilled|not approved/i);
    });

    it('vault_stage_skill rejects when candidate_id does not exist', async () => {
      const result = await stage('cand-does-not-exist', 'gate-missing');
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/not found|missing/i);
    });

    it('vault_stage_skill accepts a candidate in approved state', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate approved', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const result = await stage(candidate.id, 'gate-approved');
      expect(result.error).toBeUndefined();
      expect(result.status).toBe('staged');
    });

    it('vault_stage_skill rejects malformed YAML frontmatter', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate malformed yaml', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      const result = parseResult(
        await stageTool.handler(
          {
            candidate_id: candidate.id,
            name: 'gate-malformed-yaml',
            display_name: 'Gate Malformed YAML',
            description: 'Malformed YAML skill',
            content:
              '---\n' +
              'name: myco:gate-malformed-yaml\n' +
              'description: Use this skill for end-to-end delivery: planning, coding, verification\n' +
              'managed_by: myco\n' +
              'user-invocable: true\n' +
              'allowed-tools: Read, Grep, Glob\n' +
              '---\n\n# Broken',
            rationale: 'gate test',
          },
          undefined,
        ),
      ) as { error?: string; issues?: string[] };

      expect(result.error).toContain('validation failed');
      expect(result.issues?.some((issue) => issue.includes('Invalid YAML frontmatter'))).toBe(true);
    });

    it('vault_stage_skill rejects descriptions over the compatibility limit', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate long description', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const tooLongDescription = 'a'.repeat(MAX_SKILL_DESCRIPTION_CHARS + 1);
      const stageTool = findTool(tools, 'vault_stage_skill');
      const result = parseResult(
        await stageTool.handler(
          {
            candidate_id: candidate.id,
            name: 'gate-long-description',
            display_name: 'Gate Long Description',
            description: tooLongDescription,
            content:
              '---\n' +
              'name: myco:gate-long-description\n' +
              `description: ${tooLongDescription}\n` +
              'managed_by: myco\n' +
              'user-invocable: true\n' +
              'allowed-tools: Read, Grep, Glob\n' +
              '---\n\n# Too long',
            rationale: 'gate test',
          },
          undefined,
        ),
      ) as { error?: string; issues?: string[] };

      expect(result.error).toContain('validation failed');
      expect(
        result.issues?.some((issue) =>
          issue.includes(`description exceeds maximum length of ${MAX_SKILL_DESCRIPTION_CHARS}`)),
      ).toBe(true);
    });

    it('vault_write_skill rejects create path when candidate is not approved', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Gate write identified', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      // Leave candidate in 'identified' state.

      const writeTool = findTool(tools, 'vault_write_skill');
      const result = parseResult(
        await writeTool.handler(
          {
            name: 'gate-write-identified',
            display_name: 'Gate Write',
            description: 'Test write gate against identified candidate',
            content: validSkillContent('gate-write-identified'),
            candidate_id: candidate.id,
          },
          undefined,
        ),
      ) as { error?: string };
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/identified/);
      expect(result.error).toMatch(/approved/);
    });

    it('vault_write_skill allows evolve path regardless of candidate_id status', async () => {
      // Seed a live skill first (no candidate linkage).
      const writeTool = findTool(tools, 'vault_write_skill');
      await writeTool.handler(
        {
          name: 'evolve-no-candidate',
          display_name: 'Evolve Gate Test',
          description: 'Seed for evolve-path gate test',
          content: validSkillContent('evolve-no-candidate', '# V1'),
        },
        undefined,
      );

      // Evolve path is triggered by same-name write. Candidate status is
      // irrelevant here — the caller is updating an existing skill, not
      // creating a new one. No structural gate should fire.
      const result = parseResult(
        await writeTool.handler(
          {
            name: 'evolve-no-candidate',
            display_name: 'Evolve Gate Test',
            description: 'Updated during evolve path',
            content: validSkillContent('evolve-no-candidate', '# V2'),
          },
          undefined,
        ),
      ) as { generation?: number; error?: string };
      expect(result.error).toBeUndefined();
      expect(result.generation).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // vault_finalize_skill — promotes a staged skill to live. Reads the
  // manifest.json + SKILL.md written by vault_stage_skill, re-runs the
  // dedup + validation gates as defense in depth, then atomically creates
  // the skill_records row, lineage entry, candidate transition to
  // 'generated', disk file, and symbiont symlinks. Cleans up staging on
  // success.
  // -------------------------------------------------------------------------

  describe('vault_finalize_skill', () => {
    async function stageForFinalize(candidateId: string, name: string) {
      const stageTool = findTool(tools, 'vault_stage_skill');
      return parseResult(
        await stageTool.handler(
          {
            candidate_id: candidateId,
            name,
            display_name: name,
            description: `Description for ${name}`,
            content: validSkillContent(name, `# ${name}`),
            rationale: 'Initial draft',
          },
          undefined,
        ),
      );
    }

    it('promotes a staged skill to .agents/skills and creates DB rows', async () => {
      // Seed candidate + stage content
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Finalize topic', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);
      await stageForFinalize(candidate.id, 'finalize-me');

      // Finalize
      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      const result = await finalizeTool.handler(
        { candidate_id: candidate.id },
        undefined,
      );
      const data = parseResult(result) as {
        id: string;
        name: string;
        path: string;
        generation: number;
      };

      expect(data.name).toBe('finalize-me');
      expect(data.generation).toBe(1);
      expect(data.path).toBe('.agents/skills/finalize-me/SKILL.md');

      // Disk file
      const liveFile = path.join(tmpDir, '.agents', 'skills', 'finalize-me', 'SKILL.md');
      expect(fs.existsSync(liveFile)).toBe(true);

      // DB row
      const recordsTool = findTool(tools, 'vault_skill_records');
      const record = parseResult(
        await recordsTool.handler({ action: 'get', id: 'finalize-me' }, undefined),
      ) as { name: string };
      expect(record.name).toBe('finalize-me');

      // Candidate flipped to generated
      const updated = parseResult(
        await candidateTool.handler({ action: 'get', id: candidate.id }, undefined),
      ) as { status: string; skill_id: string };
      expect(updated.status).toBe('generated');
      expect(updated.skill_id).toBe(data.id);

      // Staging cleaned up
      const stagingFile = path.join(
        vaultDir,
        'staging',
        'skills',
        candidate.id,
        'SKILL.md',
      );
      expect(fs.existsSync(stagingFile)).toBe(false);
    });

    it('errors when no staged content exists for the candidate', async () => {
      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      const result = await finalizeTool.handler(
        { candidate_id: 'cand-never-staged' },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string };
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/no staged/i);
    });

    it('re-runs content contamination validation on staged content before promoting', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Finalize contamination', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);
      await stageForFinalize(candidate.id, 'finalize-contamination');

      const stagedFile = path.join(vaultDir, 'staging', 'skills', candidate.id, 'SKILL.md');
      fs.writeFileSync(
        stagedFile,
        validSkillContent(
          'finalize-contamination',
          '# Finalize Contamination\n\nCritical discovery (v0.27.17): use the new workflow.',
        ),
      );

      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      const result = await finalizeTool.handler(
        { candidate_id: candidate.id },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string; issues?: string[] };
      expect(parsed.error).toContain('Staged skill failed validation');
      expect(parsed.issues).toEqual(expect.arrayContaining([
        expect.stringContaining('myco-version-parenthetical'),
      ]));

      const liveFile = path.join(tmpDir, '.agents', 'skills', 'finalize-contamination', 'SKILL.md');
      expect(fs.existsSync(liveFile)).toBe(false);
    });

    it('re-runs fabricated code-claim validation on staged content before promoting', async () => {
      fs.mkdirSync(path.join(tmpDir, 'packages', 'myco', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'packages', 'myco', 'src', 'real.ts'), 'export const realThing = 1;\n');

      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Finalize fabrication', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);
      await stageForFinalize(candidate.id, 'finalize-fabrication');

      const stagedFile = path.join(vaultDir, 'staging', 'skills', candidate.id, 'SKILL.md');
      fs.writeFileSync(
        stagedFile,
        validSkillContent(
          'finalize-fabrication',
          '# Finalize Fabrication\n\nSee `packages/myco/src/does-not-exist.ts` before changing this workflow.',
        ),
      );

      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      const result = await finalizeTool.handler(
        { candidate_id: candidate.id },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string; missing_paths?: string[] };
      expect(parsed.error).toContain('does not exist in this repository');
      expect(parsed.missing_paths).toContain('packages/myco/src/does-not-exist.ts');

      const liveFile = path.join(tmpDir, '.agents', 'skills', 'finalize-fabrication', 'SKILL.md');
      expect(fs.existsSync(liveFile)).toBe(false);
    });

    it('rejects finalize when the staged manifest candidate_id differs from the requested candidate', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidateA = parseResult(
        await candidateTool.handler(
          {
            action: 'create',
            topic: 'Finalize manifest mismatch alpha',
            rationale: 'r',
            ...validCandidateMetadata({ evidence_bundle_id: 'bundle-finalize-manifest-a' }),
          },
          undefined,
        ),
      ) as { id?: string; error?: string };
      const candidateB = parseResult(
        await candidateTool.handler(
          {
            action: 'create',
            topic: 'Graph cache retention omega',
            rationale: 'r',
            ...validCandidateMetadata({ evidence_bundle_id: 'bundle-finalize-manifest-b' }),
          },
          undefined,
        ),
      ) as { id?: string; error?: string };
      expect(candidateA.error).toBeUndefined();
      expect(candidateB.error).toBeUndefined();
      expect(candidateA.id).toBeDefined();
      expect(candidateB.id).toBeDefined();
      const candidateAId = candidateA.id!;
      const candidateBId = candidateB.id!;
      approveCandidate(candidateAId);
      approveCandidate(candidateBId);
      await stageForFinalize(candidateAId, 'finalize-manifest-mismatch');

      const manifestPath = path.join(vaultDir, 'staging', 'skills', candidateAId, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.candidate_id = candidateBId;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      const result = await finalizeTool.handler(
        { candidate_id: candidateAId },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string };
      expect(parsed.error).toContain('Staged skill manifest candidate_id mismatch');

      const liveFile = path.join(tmpDir, '.agents', 'skills', 'finalize-manifest-mismatch', 'SKILL.md');
      expect(fs.existsSync(liveFile)).toBe(false);
      const updatedB = parseResult(
        await candidateTool.handler({ action: 'get', id: candidateBId }, undefined),
      ) as { status: string; skill_id: string | null };
      expect(updatedB.status).toBe('approved');
      expect(updatedB.skill_id).toBeNull();
    });

    it('re-runs dedup gate on the staged content before promoting', async () => {
      // Seed a live skill with a distinctive description
      const writeTool = findTool(tools, 'vault_write_skill');
      await writeTool.handler(
        {
          name: 'live-defense',
          display_name: 'Live Defense',
          description: 'Very specific error retry patterns for async worker queues and jobs',
          content: validSkillContent('live-defense', '# Live'),
        },
        undefined,
      );

      // Stage a skill with a fresh candidate whose description does NOT overlap
      // (to bypass stage-time gate), then mutate the staged content to overlap
      // before finalize.
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Defense test', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);

      const stageTool = findTool(tools, 'vault_stage_skill');
      await stageTool.handler(
        {
          candidate_id: candidate.id,
          name: 'defense-stage',
          display_name: 'Defense Stage',
          description: 'Completely unrelated topic about caching',
          content: validSkillContent('defense-stage', '# Defense'),
          rationale: 'Defense test',
        },
        undefined,
      );

      // Tamper the manifest to overlap with the live skill's description.
      const manifestPath = path.join(
        vaultDir,
        'staging',
        'skills',
        candidate.id,
        'manifest.json',
      );
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.description =
        'Very specific error retry patterns for async worker queues and jobs, tuned';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      // Finalize should reject
      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      const result = await finalizeTool.handler(
        { candidate_id: candidate.id },
        undefined,
      );
      const parsed = parseResult(result) as { error?: string };
      expect(parsed.error).toContain('overlaps with existing active skill');

      // Assert no skill record created and no live file
      const liveFile = path.join(tmpDir, '.agents', 'skills', 'defense-stage', 'SKILL.md');
      expect(fs.existsSync(liveFile)).toBe(false);
      const recordsTool = findTool(tools, 'vault_skill_records');
      const records = parseResult(
        await recordsTool.handler({ action: 'list' }, undefined),
      ) as Array<{ name: string }>;
      expect(records.find((r) => r.name === 'defense-stage')).toBeUndefined();
    });

    it('removes symbiont symlinks when finalize rolls back after creating them', async () => {
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidate = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Rollback cleanup topic', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };
      approveCandidate(candidate.id);
      await stageForFinalize(candidate.id, 'rollback-symlink-cleanup');

      // Force the candidate-link step to fail inside promoteNewSkill's
      // DB transaction after the live file and symbiont symlinks have
      // already been created.
      const db = getDatabase();
      db.exec(`
        CREATE TEMP TRIGGER test_finalize_candidate_update_fail
        BEFORE UPDATE OF status ON skill_candidates
        WHEN NEW.status = 'generated'
        BEGIN
          SELECT RAISE(FAIL, 'forced rollback after publish');
        END;
      `);

      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      let result: { error?: string };
      try {
        result = parseResult(
          await finalizeTool.handler({ candidate_id: candidate.id }, undefined),
        ) as { error?: string };
      } finally {
        db.exec('DROP TRIGGER IF EXISTS test_finalize_candidate_update_fail');
      }

      expect(result.error).toContain('database transaction failed');

      const liveFile = path.join(
        tmpDir,
        '.agents',
        'skills',
        'rollback-symlink-cleanup',
        'SKILL.md',
      );
      const claudeSymlink = path.join(
        tmpDir,
        '.claude',
        'skills',
        'rollback-symlink-cleanup',
      );
      const cursorSymlink = path.join(
        tmpDir,
        '.cursor',
        'skills',
        'rollback-symlink-cleanup',
      );

      expect(fs.existsSync(liveFile)).toBe(false);
      expect(fs.existsSync(claudeSymlink)).toBe(false);
      expect(fs.existsSync(cursorSymlink)).toBe(false);
    });

    it('preserves approved_at on the candidate after transition to generated', async () => {
      // Seed an already-approved candidate with a known approved_at
      const candidateTool = findTool(tools, 'vault_skill_candidates');
      const candidateRaw = parseResult(
        await candidateTool.handler(
          { action: 'create', topic: 'Approved audit', rationale: 'r', ...validCandidateMetadata() },
          undefined,
        ),
      ) as { id: string };

      // Flip to approved via the REST handler path (simulates UI click).
      // The agent tool has been locked down in Task 2, so we use the
      // query helper directly to simulate the human approval.
      const { updateCandidate } = await import('@myco/db/queries/skill-candidates.js');
      const approvedAt = epochNow();
      updateCandidate(candidateRaw.id, {
        status: 'approved',
        updated_at: approvedAt,
      }, ALL_PROJECTS_SCOPE);

      await stageForFinalize(candidateRaw.id, 'audit-preserve');
      const finalizeTool = findTool(tools, 'vault_finalize_skill');
      await finalizeTool.handler(
        { candidate_id: candidateRaw.id },
        undefined,
      );

      const final = parseResult(
        await candidateTool.handler({ action: 'get', id: candidateRaw.id }, undefined),
      ) as { status: string; approved_at: number | null };
      expect(final.status).toBe('generated');
      expect(final.approved_at).toBe(approvedAt);
    });
  });
});
