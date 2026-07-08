import { describe, expect, test, beforeEach } from 'bun:test';
import { withDatabase, openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertRunEvent } from '@myco/db/queries/agent-run-events.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { setState } from '@myco/db/queries/agent-state.js';
import { insertWriteIntent } from '@myco/db/queries/write-intents.js';
import { epochSeconds } from '@myco/constants.js';
import { checkPhasePostCondition, type PhasePostConditionInput } from '@myco/agent/phase-postconditions.js';
import {
  SKILL_EVOLVE_ASSESS_PHASE_NAME,
  SKILL_EVOLVE_ASSESS_REPORT_ACTION,
  SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
  SKILL_EVOLVE_INVENTORY_PHASE_NAME,
  SKILL_EVOLVE_INVENTORY_REPORT_ACTION,
  SKILL_EVOLVE_INVENTORY_STATE_KEY,
} from '@myco/agent/skill-evolve-output.js';

/**
 * Coverage for the skill-evolve inventory/assess phase postconditions.
 * Freshness is proved by harness event evidence (a successful
 * `vault_set_state` call in the relevant phase this run, or a run-scoped
 * write intent on dry runs) rather than a model-supplied `run_id` — the
 * model intermittently omits `run_id` from its JSON payload, and
 * `stampRunIdInPayload` only rewrites an existing key, never adds one.
 */
describe('skill-evolve phase postconditions', () => {
  let db: Database;
  const agentId = 'test-agent';
  const runId = 'test-run-1';
  const projectId = 'proj-1';

  beforeEach(() => {
    db = openDatabase(':memory:');
    createSchema(db);
    withDatabase(db, () => {
      registerAgent({ id: agentId, name: 'Test Agent', created_at: epochSeconds() });
      insertRun({ id: runId, agent_id: agentId, project_id: projectId });
    });
  });

  function input(overrides: Partial<PhasePostConditionInput> = {}): PhasePostConditionInput {
    return { runId, agentId, projectId, dryRun: false, ...overrides };
  }

  function insertInventoryReport(): void {
    insertReport({
      run_id: runId,
      agent_id: agentId,
      action: SKILL_EVOLVE_INVENTORY_REPORT_ACTION,
      summary: 'inventory done',
      created_at: epochSeconds(),
    });
  }

  function writeInventoryStateEvent(): void {
    insertRunEvent({
      runId,
      phaseName: SKILL_EVOLVE_INVENTORY_PHASE_NAME,
      eventType: 'post_tool_use',
      toolName: 'vault_set_state',
      outcome: 'success',
    });
  }

  function writeAssessStateEvent(): void {
    insertRunEvent({
      runId,
      phaseName: SKILL_EVOLVE_ASSESS_PHASE_NAME,
      eventType: 'post_tool_use',
      toolName: 'vault_set_state',
      outcome: 'success',
    });
  }

  describe('skill-evolve-inventory', () => {
    test('PASSES: run_id-less inventory state written this run + report + success event in inventory phase', () => {
      withDatabase(db, () => {
        insertInventoryReport();
        writeInventoryStateEvent();
        setState(
          agentId,
          projectId,
          SKILL_EVOLVE_INVENTORY_STATE_KEY,
          JSON.stringify({ merge_candidates: [], narrow_candidates: [] }),
          epochSeconds(),
        );
        const result = checkPhasePostCondition('skill-evolve-inventory', input());
        expect(result.passed).toBe(true);
      });
    });

    test('FAILS: missing inventory report', () => {
      withDatabase(db, () => {
        writeInventoryStateEvent();
        setState(
          agentId,
          projectId,
          SKILL_EVOLVE_INVENTORY_STATE_KEY,
          JSON.stringify({ merge_candidates: [], narrow_candidates: [] }),
          epochSeconds(),
        );
        const result = checkPhasePostCondition('skill-evolve-inventory', input());
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('skill-evolve-inventory report');
      });
    });

    test('FAILS (freshness): no inventory-phase vault_set_state success event this run, even though a stale prior-run inventory-shaped state exists', () => {
      withDatabase(db, () => {
        insertInventoryReport();
        // Simulates a prior run's state value still sitting in agent_state —
        // no write event was recorded for THIS run.
        setState(
          agentId,
          projectId,
          SKILL_EVOLVE_INVENTORY_STATE_KEY,
          JSON.stringify({ merge_candidates: [], narrow_candidates: [] }),
          epochSeconds(),
        );
        const result = checkPhasePostCondition('skill-evolve-inventory', input());
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('wrote no skill-evolve-inventory state this run');
      });
    });

    test('FAILS (structure): inventory-phase state write happened this run but the value is not inventory-shaped', () => {
      withDatabase(db, () => {
        insertInventoryReport();
        writeInventoryStateEvent();
        setState(
          agentId,
          projectId,
          SKILL_EVOLVE_INVENTORY_STATE_KEY,
          JSON.stringify({ some_other_shape: true }),
          epochSeconds(),
        );
        const result = checkPhasePostCondition('skill-evolve-inventory', input());
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('valid skill-evolve-inventory state');
      });
    });

    test('PASSES even when the state payload DOES carry a run_id (backward compatible)', () => {
      withDatabase(db, () => {
        insertInventoryReport();
        writeInventoryStateEvent();
        setState(
          agentId,
          projectId,
          SKILL_EVOLVE_INVENTORY_STATE_KEY,
          JSON.stringify({ run_id: runId, merge_candidates: [], narrow_candidates: [] }),
          epochSeconds(),
        );
        const result = checkPhasePostCondition('skill-evolve-inventory', input());
        expect(result.passed).toBe(true);
      });
    });

    test('dry-run PASSES: run_id-less write intent for skill-evolve-inventory this run + report', () => {
      withDatabase(db, () => {
        insertInventoryReport();
        insertWriteIntent({
          runId,
          projectId: null,
          toolName: 'vault_set_state',
          toolInput: JSON.stringify({ key: SKILL_EVOLVE_INVENTORY_STATE_KEY, value: JSON.stringify({ merge_candidates: [], narrow_candidates: [] }) }),
          syntheticOutput: JSON.stringify({ ok: true }),
        });
        const result = checkPhasePostCondition('skill-evolve-inventory', input({ dryRun: true }));
        expect(result.passed).toBe(true);
      });
    });

    test('dry-run FAILS: no skill-evolve-inventory write intent recorded this run', () => {
      withDatabase(db, () => {
        insertInventoryReport();
        const result = checkPhasePostCondition('skill-evolve-inventory', input({ dryRun: true }));
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('write intent');
      });
    });
  });

  describe('skill-evolve-assess', () => {
    const classifications = [
      { skill_id: 'skill-a', name: 'skill-a', classification: 'CURRENT', target_skill: null, details: 'still accurate' },
    ];

    function insertAssessReport(overrideClassifications = classifications): void {
      insertReport({
        run_id: runId,
        agent_id: agentId,
        action: SKILL_EVOLVE_ASSESS_REPORT_ACTION,
        summary: 'assess done',
        details: JSON.stringify({ classifications: overrideClassifications, deferred_skills: [] }),
        created_at: epochSeconds(),
      });
    }

    test('PASSES: run_id-less classifications state + assess report + assess-phase success event + matching payloads', () => {
      withDatabase(db, () => {
        insertAssessReport();
        writeAssessStateEvent();
        setState(
          agentId,
          projectId,
          SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
          JSON.stringify({ classifications, deferred_skills: [] }),
          epochSeconds(),
        );
        const result = checkPhasePostCondition('skill-evolve-assess', input());
        expect(result.passed).toBe(true);
      });
    });

    test('FAILS: missing assess report', () => {
      withDatabase(db, () => {
        writeAssessStateEvent();
        setState(
          agentId,
          projectId,
          SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
          JSON.stringify({ classifications, deferred_skills: [] }),
          epochSeconds(),
        );
        const result = checkPhasePostCondition('skill-evolve-assess', input());
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('assess report');
      });
    });

    test('FAILS: classifications state does not match the assess report', () => {
      withDatabase(db, () => {
        insertAssessReport();
        writeAssessStateEvent();
        setState(
          agentId,
          projectId,
          SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
          JSON.stringify({
            classifications: [
              { skill_id: 'skill-a', name: 'skill-a', classification: 'STALE', target_skill: null, details: 'differs' },
            ],
            deferred_skills: [],
          }),
          epochSeconds(),
        );
        const result = checkPhasePostCondition('skill-evolve-assess', input());
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('does not match assess report');
      });
    });

    test('FAILS (freshness): no assess-phase state write this run even though a stale prior-run classifications state matches the report', () => {
      withDatabase(db, () => {
        insertAssessReport();
        // No writeAssessStateEvent() — simulates a prior run's leftover state.
        setState(
          agentId,
          projectId,
          SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
          JSON.stringify({ classifications, deferred_skills: [] }),
          epochSeconds(),
        );
        const result = checkPhasePostCondition('skill-evolve-assess', input());
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('wrote no skill-evolve-classifications state this run');
      });
    });

    test('PASSES even when both report and state DO carry a run_id (backward compatible)', () => {
      withDatabase(db, () => {
        insertReport({
          run_id: runId,
          agent_id: agentId,
          action: SKILL_EVOLVE_ASSESS_REPORT_ACTION,
          summary: 'assess done',
          details: JSON.stringify({ run_id: runId, classifications, deferred_skills: [] }),
          created_at: epochSeconds(),
        });
        writeAssessStateEvent();
        setState(
          agentId,
          projectId,
          SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
          JSON.stringify({ run_id: runId, classifications, deferred_skills: [] }),
          epochSeconds(),
        );
        const result = checkPhasePostCondition('skill-evolve-assess', input());
        expect(result.passed).toBe(true);
      });
    });

    test('dry-run PASSES: run_id-less classifications write intent this run + assess report + matching payloads', () => {
      withDatabase(db, () => {
        insertAssessReport();
        insertWriteIntent({
          runId,
          projectId: null,
          toolName: 'vault_set_state',
          toolInput: JSON.stringify({ key: SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY, value: JSON.stringify({ classifications, deferred_skills: [] }) }),
          syntheticOutput: JSON.stringify({ ok: true }),
        });
        const result = checkPhasePostCondition('skill-evolve-assess', input({ dryRun: true }));
        expect(result.passed).toBe(true);
      });
    });

    test('dry-run FAILS: no skill-evolve-classifications write intent recorded this run', () => {
      withDatabase(db, () => {
        insertAssessReport();
        const result = checkPhasePostCondition('skill-evolve-assess', input({ dryRun: true }));
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('write intent');
      });
    });
  });
});
