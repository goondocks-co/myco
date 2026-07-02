/**
 * Mechanical per-phase postCondition checks.
 *
 * Each check is deterministic DB reads — no LLM turns. The phase loop runs
 * the check after harness execution on an otherwise-completed phase; on
 * failure the phase result is converted to `failed` (same deterministic
 * conversion contract as the semantic-check flagged-writes block), so a
 * `required: true` phase fails the run immediately instead of letting the
 * remaining phases run at full LLM cost and dying at the run-end task
 * postcondition. Live failure mode this closes: a model answers a phase
 * with prose only, makes zero tool calls, and the phase "completes"
 * without producing the state/report the rest of the pipeline consumes
 * (observed on skill-evolve inventory across two model families).
 *
 * These checks are the single source of truth for the skill-evolve output
 * contract: the run-end validator in task-postconditions.ts delegates to
 * the same functions (belt and suspenders — a later phase can still
 * clobber state the gate already validated, and resumes re-validate).
 *
 * Failure `reason` strings are load-bearing: the run-end validator
 * surfaces them verbatim as the run error, and tests assert them exactly.
 *
 * Adding a new kind: add one entry to `PHASE_POSTCONDITIONS` below and the
 * literal to phase-postcondition-kinds.ts. The type, the Zod enum, and the
 * runtime dispatch are all driven from that single tuple.
 */

import { getState } from '@myco/db/queries/agent-state.js';
import { listReports } from '@myco/db/queries/reports.js';
import { listWriteIntents } from '@myco/db/queries/write-intents.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import {
  findLatestVaultSetStateValue,
  parseSkillEvolveClassificationPayload,
  parseSkillEvolveInventoryPayload,
  skillEvolveClassificationPayloadsEqual,
  SKILL_EVOLVE_ASSESS_REPORT_ACTION,
  SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
  SKILL_EVOLVE_INVENTORY_REPORT_ACTION,
  SKILL_EVOLVE_INVENTORY_STATE_KEY,
} from './skill-evolve-output.js';
import { PHASE_POSTCONDITION_KINDS, type PhasePostConditionKind } from './phase-postcondition-kinds.js';

export { PHASE_POSTCONDITION_KINDS, type PhasePostConditionKind };

export interface PhasePostConditionResult {
  passed: boolean;
  /**
   * Human-readable reason — surfaced verbatim by the run-end validator
   * and prefixed with the phase name by the phase-boundary gate.
   */
  reason: string;
}

export interface PhasePostConditionInput {
  runId: string;
  agentId: string;
  /**
   * Project attribution matching the run row: callers pass
   * `rowProjectIdFromRequestContext(requestContext)` at phase time and
   * `run.project_id` at run end, so both gates read the same agent-state
   * rows that `vault_set_state` wrote.
   */
  projectId: string | null;
  dryRun: boolean;
}

type PhasePostConditionFn = (input: PhasePostConditionInput) => PhasePostConditionResult;

const PASSED: PhasePostConditionResult = { passed: true, reason: 'ok' };

function failed(reason: string): PhasePostConditionResult {
  return { passed: false, reason };
}

/**
 * Resolve the vault_set_state payload for `stateKey`: on live runs from the
 * agent-state row (what the tool wrote), on dry runs from the recorded
 * write intents (the dry-run interceptor blocks the state write itself).
 * Returns the raw value for the caller's parser, or a failure result when
 * the source itself is unavailable.
 */
function readStatePayloadValue(
  input: PhasePostConditionInput,
  stateKey: string,
): { ok: true; value: unknown } | { ok: false; failure: PhasePostConditionResult } {
  if (input.dryRun) {
    const intents = listWriteIntents(input.runId, { scope: ALL_PROJECTS_SCOPE });
    return { ok: true, value: findLatestVaultSetStateValue(intents, stateKey) };
  }
  if (!input.projectId) {
    return { ok: false, failure: failed('skill-evolve completed without a project scope for state validation') };
  }
  return { ok: true, value: getState(input.agentId, input.projectId, stateKey)?.value };
}

function checkSkillEvolveInventory(input: PhasePostConditionInput): PhasePostConditionResult {
  const reports = listReports(input.runId, { scope: ALL_PROJECTS_SCOPE });
  const inventoryReport = reports.find((report) => report.action === SKILL_EVOLVE_INVENTORY_REPORT_ACTION);
  if (!inventoryReport) {
    return failed('skill-evolve completed without a skill-evolve-inventory report');
  }

  const stateValue = readStatePayloadValue(input, SKILL_EVOLVE_INVENTORY_STATE_KEY);
  if (!stateValue.ok) return stateValue.failure;

  const inventoryPayload = parseSkillEvolveInventoryPayload(stateValue.value);
  if (!inventoryPayload) {
    return failed(input.dryRun
      ? 'skill-evolve dry-run completed without a valid skill-evolve-inventory write intent'
      : 'skill-evolve completed without valid skill-evolve-inventory state');
  }
  if (inventoryPayload.run_id !== input.runId) {
    return failed(input.dryRun
      ? 'skill-evolve inventory write intent run_id does not match the run'
      : 'skill-evolve inventory state run_id does not match the run');
  }
  return PASSED;
}

function checkSkillEvolveAssess(input: PhasePostConditionInput): PhasePostConditionResult {
  const reports = listReports(input.runId, { scope: ALL_PROJECTS_SCOPE });
  const assessReport = reports.find((report) => report.action === SKILL_EVOLVE_ASSESS_REPORT_ACTION);
  if (!assessReport) {
    return failed('skill-evolve completed without an assess report');
  }

  const assessPayload = parseSkillEvolveClassificationPayload(assessReport.details);
  if (!assessPayload) {
    return failed('skill-evolve assess report details are invalid');
  }
  if (assessPayload.run_id !== input.runId) {
    return failed('skill-evolve assess report run_id does not match the run');
  }

  const stateValue = readStatePayloadValue(input, SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY);
  if (!stateValue.ok) return stateValue.failure;

  const classificationPayload = parseSkillEvolveClassificationPayload(stateValue.value);
  if (!classificationPayload) {
    return failed(input.dryRun
      ? 'skill-evolve dry-run completed without a valid skill-evolve-classifications write intent'
      : 'skill-evolve completed without valid skill-evolve-classifications state');
  }
  if (classificationPayload.run_id !== input.runId) {
    return failed(input.dryRun
      ? 'skill-evolve classifications write intent run_id does not match the run'
      : 'skill-evolve classifications state run_id does not match the run');
  }
  if (!skillEvolveClassificationPayloadsEqual(classificationPayload, assessPayload)) {
    return failed(input.dryRun
      ? 'skill-evolve classifications write intent does not match assess report'
      : 'skill-evolve classifications state does not match assess report');
  }
  return PASSED;
}

const PHASE_POSTCONDITIONS: Record<PhasePostConditionKind, PhasePostConditionFn> = {
  'skill-evolve-inventory': checkSkillEvolveInventory,
  'skill-evolve-assess': checkSkillEvolveAssess,
};

export function checkPhasePostCondition(
  kind: PhasePostConditionKind,
  input: PhasePostConditionInput,
): PhasePostConditionResult {
  return PHASE_POSTCONDITIONS[kind](input);
}
