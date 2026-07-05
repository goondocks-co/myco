import { describe, expect, test, beforeEach } from 'bun:test';
import { withDatabase, openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertRunEvent } from '@myco/db/queries/agent-run-events.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { setState } from '@myco/db/queries/agent-state.js';
import { epochSeconds } from '@myco/constants.js';
import { validateTaskPostconditions } from './task-postconditions.js';
import {
  SKILL_EVOLVE_ASSESS_PHASE_NAME,
  SKILL_EVOLVE_ASSESS_REPORT_ACTION,
  SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
  SKILL_EVOLVE_INVENTORY_PHASE_NAME,
  SKILL_EVOLVE_INVENTORY_REPORT_ACTION,
  SKILL_EVOLVE_INVENTORY_STATE_KEY,
  SKILL_EVOLVE_TASK_NAME,
} from './skill-evolve-output.js';

/**
 * Run-end validator coverage for skill-evolve. `validateSkillEvolveRun`
 * delegates to the same phase postconditions the phase-boundary gates run
 * (belt and suspenders), so this exercises the run-end entry point rather
 * than re-deriving the postcondition logic.
 */
describe('validateTaskPostconditions — skill-evolve', () => {
  let db: Database;
  const agentId = 'test-agent';
  const runId = 'skill-evolve-run-1';
  const projectId = 'proj-1';
  const taskName = SKILL_EVOLVE_TASK_NAME;

  const classifications = [
    { skill_id: 'skill-a', name: 'skill-a', classification: 'CURRENT', target_skill: null, details: 'still accurate' },
  ];

  beforeEach(() => {
    db = openDatabase(':memory:');
    createSchema(db);
    withDatabase(db, () => {
      registerAgent({ id: agentId, name: 'Test Agent', created_at: epochSeconds() });
      insertRun({ id: runId, agent_id: agentId, project_id: projectId });
    });
  });

  function seedPassingRun(): void {
    insertReport({
      run_id: runId,
      agent_id: agentId,
      action: SKILL_EVOLVE_INVENTORY_REPORT_ACTION,
      summary: 'inventory done',
      created_at: epochSeconds(),
    });
    insertRunEvent({
      runId,
      phaseName: SKILL_EVOLVE_INVENTORY_PHASE_NAME,
      eventType: 'post_tool_use',
      toolName: 'vault_set_state',
      outcome: 'success',
    });
    setState(
      agentId,
      projectId,
      SKILL_EVOLVE_INVENTORY_STATE_KEY,
      JSON.stringify({ merge_candidates: [], narrow_candidates: [] }),
      epochSeconds(),
    );
    insertReport({
      run_id: runId,
      agent_id: agentId,
      action: SKILL_EVOLVE_ASSESS_REPORT_ACTION,
      summary: 'assess done',
      details: JSON.stringify({ classifications, deferred_skills: [] }),
      created_at: epochSeconds(),
    });
    insertRunEvent({
      runId,
      phaseName: SKILL_EVOLVE_ASSESS_PHASE_NAME,
      eventType: 'post_tool_use',
      toolName: 'vault_set_state',
      outcome: 'success',
    });
    setState(
      agentId,
      projectId,
      SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
      JSON.stringify({ classifications, deferred_skills: [] }),
      epochSeconds(),
    );
  }

  test('passes: run_id-less inventory and assess state, both freshly written this run', () => {
    withDatabase(db, () => {
      seedPassingRun();
      const error = validateTaskPostconditions({ runId, taskName });
      expect(error).toBeNull();
    });
  });

  test('fails: inventory state is stale (no inventory-phase write event this run)', () => {
    withDatabase(db, () => {
      seedPassingRun();
      // Overwrite: pretend the inventory-phase event never happened, by
      // starting a run with only the assess-side evidence.
      const staleRunId = 'skill-evolve-run-stale';
      insertRun({ id: staleRunId, agent_id: agentId, project_id: projectId });
      insertReport({
        run_id: staleRunId,
        agent_id: agentId,
        action: SKILL_EVOLVE_INVENTORY_REPORT_ACTION,
        summary: 'inventory done',
        created_at: epochSeconds(),
      });
      // No vault_set_state success event recorded for staleRunId's inventory phase.
      const error = validateTaskPostconditions({ runId: staleRunId, taskName });
      expect(error).not.toBeNull();
      expect(error).toContain('wrote no skill-evolve-inventory state this run');
    });
  });

  test('fails: missing assess report even though inventory passed', () => {
    withDatabase(db, () => {
      insertReport({
        run_id: runId,
        agent_id: agentId,
        action: SKILL_EVOLVE_INVENTORY_REPORT_ACTION,
        summary: 'inventory done',
        created_at: epochSeconds(),
      });
      insertRunEvent({
        runId,
        phaseName: SKILL_EVOLVE_INVENTORY_PHASE_NAME,
        eventType: 'post_tool_use',
        toolName: 'vault_set_state',
        outcome: 'success',
      });
      setState(
        agentId,
        projectId,
        SKILL_EVOLVE_INVENTORY_STATE_KEY,
        JSON.stringify({ merge_candidates: [], narrow_candidates: [] }),
        epochSeconds(),
      );
      const error = validateTaskPostconditions({ runId, taskName });
      expect(error).not.toBeNull();
      expect(error).toContain('assess report');
    });
  });

  test('other task names are unaffected by the skill-evolve rule', () => {
    withDatabase(db, () => {
      const error = validateTaskPostconditions({ runId, taskName: 'some-other-task' });
      expect(error).toBeNull();
    });
  });
});
