/**
 * Unit tests for the phase-boundary postCondition validators
 * (checkPhasePostCondition / PHASE_POSTCONDITIONS) added on top of the
 * skill-evolve pair from PR #616:
 *   - cortex-prompt-builder-build
 *   - skill-generate-validate
 *   - skill-survey-reconcile-queue
 *   - skill-survey-persist-decisions
 *
 * Each validator is deterministic DB reads only; these tests seed
 * agent_reports / agent_state / agent_run_write_intents rows directly and
 * assert on the PhasePostConditionResult returned by checkPhasePostCondition.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { setState } from '@myco/db/queries/agent-state.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertWriteIntent } from '@myco/db/queries/write-intents.js';
import { checkPhasePostCondition, type PhasePostConditionInput } from '@myco/agent/phase-postconditions.js';
import { DEFAULT_AGENT_ID, epochSeconds } from '@myco/constants.js';

const TEST_PROJECT_ID = 'proj_phase_postconditions';
const TEST_RUN_ID = 'run-phase-postconditions';

function baseInput(overrides: Partial<PhasePostConditionInput> = {}): PhasePostConditionInput {
  return {
    runId: TEST_RUN_ID,
    agentId: DEFAULT_AGENT_ID,
    projectId: TEST_PROJECT_ID,
    dryRun: false,
    ...overrides,
  };
}

function seedRun(options: { dryRun?: boolean } = {}) {
  insertRun({
    id: TEST_RUN_ID,
    project_id: TEST_PROJECT_ID,
    agent_id: DEFAULT_AGENT_ID,
    task: 'test-task',
    status: 'running',
    started_at: epochSeconds(),
    dryRun: options.dryRun ?? false,
  });
}

describe('phase postconditions — new kinds', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'Myco Agent', created_at: epochSeconds() });
    seedRun();
  });

  // ---------------------------------------------------------------------
  // cortex-prompt-builder-build
  // ---------------------------------------------------------------------

  describe('cortex-prompt-builder-build', () => {
    it('fails when the phase completes with zero tool calls (no report at all)', () => {
      const result = checkPhasePostCondition('cortex-prompt-builder-build', baseInput());
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('cortex-prompt-builder completed without a cortex_prompt_builder report');
    });

    it('passes when a cortex_prompt_builder report has a non-empty details.prompt', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'cortex_prompt_builder',
        summary: 'Built prompt',
        details: JSON.stringify({ prompt: 'Do the thing.' }),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('cortex-prompt-builder-build', baseInput());
      expect(result.passed).toBe(true);
    });

    it('is identical on dry runs (vault_report is dry-run exempt)', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'cortex_prompt_builder',
        summary: 'Built prompt',
        details: JSON.stringify({ prompt: 'Do the thing.' }),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('cortex-prompt-builder-build', baseInput({ dryRun: true, projectId: null }));
      expect(result.passed).toBe(true);
    });

    it('fails when details.prompt is missing (falls back to empty string like the consumer)', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'cortex_prompt_builder',
        summary: 'Built prompt',
        details: JSON.stringify({}),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('cortex-prompt-builder-build', baseInput());
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('cortex-prompt-builder completed without a non-empty details.prompt');
    });

    it('fails when details.prompt is an empty string', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'cortex_prompt_builder',
        summary: 'Built prompt',
        details: JSON.stringify({ prompt: '' }),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('cortex-prompt-builder-build', baseInput());
      expect(result.passed).toBe(false);
    });

    it('does not require run_id anywhere in the gate', () => {
      // The build report shape carries no run_id key at all — this test
      // documents that a report without run_id still satisfies the gate.
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'cortex_prompt_builder',
        summary: 'Built prompt',
        details: JSON.stringify({ prompt: 'No run_id key here.' }),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('cortex-prompt-builder-build', baseInput());
      expect(result.passed).toBe(true);
    });

    it('takes the LAST matching report — first parseable, last malformed FAILS (mirrors the consumer)', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'cortex_prompt_builder',
        summary: 'First attempt',
        details: JSON.stringify({ prompt: 'A good prompt.' }),
        created_at: epochSeconds(),
      });
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'cortex_prompt_builder',
        summary: 'Second attempt (malformed)',
        details: JSON.stringify({}),
        created_at: epochSeconds() + 1,
      });

      const result = checkPhasePostCondition('cortex-prompt-builder-build', baseInput());
      expect(result.passed).toBe(false);
    });

    it('takes the LAST matching report — first malformed, last parseable PASSES', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'cortex_prompt_builder',
        summary: 'First attempt (malformed)',
        details: JSON.stringify({}),
        created_at: epochSeconds(),
      });
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'cortex_prompt_builder',
        summary: 'Second attempt',
        details: JSON.stringify({ prompt: 'A good prompt.' }),
        created_at: epochSeconds() + 1,
      });

      const result = checkPhasePostCondition('cortex-prompt-builder-build', baseInput());
      expect(result.passed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // skill-generate-validate
  // ---------------------------------------------------------------------

  describe('skill-generate-validate', () => {
    it('fails when the phase completes with zero tool calls', () => {
      const result = checkPhasePostCondition('skill-generate-validate', baseInput());
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('skill-generate completed without a skill_generate_validate report');
    });

    it('passes on a satisfied contract (finalized: true)', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'skill_generate_validate',
        summary: 'Validated and finalized',
        details: JSON.stringify({ run_id: TEST_RUN_ID, candidate_id: 'cand-1', finalized: true }),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('skill-generate-validate', baseInput());
      expect(result.passed).toBe(true);
    });

    it('passes when declined-to-finalize (finalized: false) — a designed outcome', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'skill_generate_validate',
        summary: 'Criteria failed; not finalized',
        details: JSON.stringify({ run_id: TEST_RUN_ID, candidate_id: 'cand-1', finalized: false }),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('skill-generate-validate', baseInput());
      expect(result.passed).toBe(true);
    });

    it('fails when the report run_id does not match the run', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'skill_generate_validate',
        summary: 'Validated',
        details: JSON.stringify({ run_id: 'some-other-run', candidate_id: 'cand-1', finalized: true }),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('skill-generate-validate', baseInput());
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('skill_generate_validate report run_id does not match the run');
    });

    it('is identical on dry runs (vault_report is dry-run exempt)', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'skill_generate_validate',
        summary: 'Validated',
        details: JSON.stringify({ run_id: TEST_RUN_ID, candidate_id: 'cand-1', finalized: true }),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('skill-generate-validate', baseInput({ dryRun: true, projectId: null }));
      expect(result.passed).toBe(true);
    });

    it('fails a dry run with zero tool calls, same as live', () => {
      const result = checkPhasePostCondition('skill-generate-validate', baseInput({ dryRun: true, projectId: null }));
      expect(result.passed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // skill-survey-reconcile-queue (asymmetric dry/live)
  // ---------------------------------------------------------------------

  describe('skill-survey-reconcile-queue', () => {
    it('LIVE: fails when the phase completes with zero tool calls', () => {
      const result = checkPhasePostCondition('skill-survey-reconcile-queue', baseInput());
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('skill-survey reconcile-queue completed without valid reconciliation plan state');
    });

    it('LIVE: passes when reconciliation state carries run_id + validated_at for this run', () => {
      setState(
        DEFAULT_AGENT_ID,
        TEST_PROJECT_ID,
        'skill-survey-reconciliation-decisions',
        JSON.stringify({ run_id: TEST_RUN_ID, validated_at: epochSeconds(), plan: { update: [] } }),
        epochSeconds(),
      );

      const result = checkPhasePostCondition('skill-survey-reconcile-queue', baseInput());
      expect(result.passed).toBe(true);
    });

    it('LIVE: fails when the state run_id does not match the run', () => {
      setState(
        DEFAULT_AGENT_ID,
        TEST_PROJECT_ID,
        'skill-survey-reconciliation-decisions',
        JSON.stringify({ run_id: 'some-other-run', validated_at: epochSeconds() }),
        epochSeconds(),
      );

      const result = checkPhasePostCondition('skill-survey-reconcile-queue', baseInput());
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('skill-survey reconciliation plan state run_id does not match the run');
    });

    it('LIVE: fails when state is missing validated_at (present but not server-stamped)', () => {
      setState(
        DEFAULT_AGENT_ID,
        TEST_PROJECT_ID,
        'skill-survey-reconciliation-decisions',
        JSON.stringify({ run_id: TEST_RUN_ID }),
        epochSeconds(),
      );

      const result = checkPhasePostCondition('skill-survey-reconcile-queue', baseInput());
      expect(result.passed).toBe(false);
    });

    it('DRY: passes when a vault_skill_survey_reconciliation_plan intent is present, with NO run_id/validated_at', () => {
      insertWriteIntent({
        runId: TEST_RUN_ID,
        toolName: 'vault_skill_survey_reconciliation_plan',
        toolInput: JSON.stringify({ plan: { update: [], defer: [], dismiss: [], blocked: [], keep: [] } }),
        syntheticOutput: '{}',
      });

      const result = checkPhasePostCondition('skill-survey-reconcile-queue', baseInput({ dryRun: true, projectId: null }));
      expect(result.passed).toBe(true);
    });

    it('DRY: fails with zero tool calls', () => {
      const result = checkPhasePostCondition('skill-survey-reconcile-queue', baseInput({ dryRun: true, projectId: null }));
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('skill-survey reconcile-queue dry-run completed without a vault_skill_survey_reconciliation_plan call');
    });

    it('DRY: an unrelated write intent does not satisfy the gate', () => {
      insertWriteIntent({
        runId: TEST_RUN_ID,
        toolName: 'vault_set_state',
        toolInput: JSON.stringify({ key: 'unrelated', value: '{}' }),
        syntheticOutput: '{}',
      });

      const result = checkPhasePostCondition('skill-survey-reconcile-queue', baseInput({ dryRun: true, projectId: null }));
      expect(result.passed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // skill-survey-persist-decisions
  // ---------------------------------------------------------------------

  describe('skill-survey-persist-decisions', () => {
    it('fails when the phase completes with zero tool calls', () => {
      const result = checkPhasePostCondition('skill-survey-persist-decisions', baseInput());
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('skill-survey completed without a skill_survey_persist report');
    });

    it('passes on a satisfied contract (outcome: applied)', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'skill_survey_persist',
        summary: 'Applied reconciliation plan',
        details: JSON.stringify({ run_id: TEST_RUN_ID, outcome: 'applied' }),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('skill-survey-persist-decisions', baseInput());
      expect(result.passed).toBe(true);
    });

    it('passes when blocked — a designed outcome', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'skill_survey_persist',
        summary: 'Apply rejected the plan',
        details: JSON.stringify({ run_id: TEST_RUN_ID, outcome: 'blocked' }),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('skill-survey-persist-decisions', baseInput());
      expect(result.passed).toBe(true);
    });

    it('fails when the report run_id does not match the run', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'skill_survey_persist',
        summary: 'Applied',
        details: JSON.stringify({ run_id: 'some-other-run', outcome: 'applied' }),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('skill-survey-persist-decisions', baseInput());
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('skill_survey_persist report run_id does not match the run');
    });

    it('is identical on dry runs (vault_report is dry-run exempt)', () => {
      insertReport({
        run_id: TEST_RUN_ID,
        agent_id: DEFAULT_AGENT_ID,
        action: 'skill_survey_persist',
        summary: 'Applied',
        details: JSON.stringify({ run_id: TEST_RUN_ID, outcome: 'applied' }),
        created_at: epochSeconds(),
      });

      const result = checkPhasePostCondition('skill-survey-persist-decisions', baseInput({ dryRun: true, projectId: null }));
      expect(result.passed).toBe(true);
    });

    it('fails a dry run with zero tool calls, same as live', () => {
      const result = checkPhasePostCondition('skill-survey-persist-decisions', baseInput({ dryRun: true, projectId: null }));
      expect(result.passed).toBe(false);
    });
  });
});
