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
 * The skill-evolve checks are the single source of truth for that task's
 * output contract: the run-end validator in task-postconditions.ts
 * delegates to the same functions (belt and suspenders — a later phase can
 * still clobber state the gate already validated, and resumes re-validate).
 * The other kinds (cortex-prompt-builder, skill-generate, skill-survey,
 * harness-health) are phase-boundary-only — no run-end validator delegates
 * to them today.
 *
 * Failure `reason` strings are load-bearing: the skill-evolve run-end
 * validator surfaces them verbatim as the run error, and tests assert them
 * exactly. The newer kinds are gate-only but follow the same reason-string
 * voice for consistency.
 *
 * Adding a new kind: add one entry to `PHASE_POSTCONDITIONS` below and the
 * literal to phase-postcondition-kinds.ts. The type, the Zod enum, and the
 * runtime dispatch are all driven from that single tuple.
 */

import { getState } from '@myco/db/queries/agent-state.js';
import { countPhaseToolCallsByOutcome } from '@myco/db/queries/agent-run-events.js';
import { listReports } from '@myco/db/queries/reports.js';
import { listWriteIntents, type WriteIntentRow } from '@myco/db/queries/write-intents.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { SKILL_SURVEY_RECONCILIATION_STATE_KEY } from './skill-candidate-quality.js';
import {
  findLatestVaultSetStateValue,
  parseSkillEvolveClassificationPayload,
  parseSkillEvolveInventoryPayload,
  skillEvolveClassificationPayloadsEqual,
  SKILL_EVOLVE_ASSESS_PHASE_NAME,
  SKILL_EVOLVE_ASSESS_REPORT_ACTION,
  SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY,
  SKILL_EVOLVE_INVENTORY_PHASE_NAME,
  SKILL_EVOLVE_INVENTORY_REPORT_ACTION,
  SKILL_EVOLVE_INVENTORY_STATE_KEY,
  SKILL_EVOLVE_TASK_NAME,
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
 * Resolve the `vault_set_state` payload for `stateKey`: on live runs from
 * the agent-state row (what the tool wrote), on dry runs from the recorded
 * write intents (the dry-run interceptor blocks the state write itself, so
 * the intent is the only record of what would have been written). Returns
 * the raw value for the caller's parser, or a failure result when the
 * source itself is unavailable.
 *
 * Generalized from the original skill-evolve-only helper: `taskName`
 * parameterizes the no-project-scope failure string so callers outside
 * skill-evolve get an accurate reason instead of a hardcoded "skill-evolve"
 * prefix. Existing skill-evolve call sites pass `SKILL_EVOLVE_TASK_NAME`,
 * making this byte-identical to the pre-extraction behavior.
 */
function readStatePayloadValue(
  input: PhasePostConditionInput,
  stateKey: string,
  taskName: string,
): { ok: true; value: unknown } | { ok: false; failure: PhasePostConditionResult } {
  if (input.dryRun) {
    const intents = listWriteIntents(input.runId, { scope: ALL_PROJECTS_SCOPE });
    return { ok: true, value: findLatestVaultSetStateValue(intents, stateKey) };
  }
  if (!input.projectId) {
    return { ok: false, failure: failed(`${taskName} completed without a project scope for state validation`) };
  }
  return { ok: true, value: getState(input.agentId, input.projectId, stateKey)?.value };
}

/**
 * Find the latest write intent whose `tool_name` matches `toolNameMatcher`,
 * for tools whose dry-run intent records raw call arguments rather than a
 * `vault_set_state`-style `{ key, value }` envelope (no `normalizeArgs` on
 * the tool, so nothing is stamped or reshaped before the intent is stored).
 * Used by the asymmetric dry-run branches below, where dry-run gate
 * satisfaction is "the tool was called", not "the value it would have
 * written round-trips" — the intercepted tool never ran the live handler
 * that computes that value.
 */
function findLatestIntentByToolName(
  intents: WriteIntentRow[],
  toolNameMatcher: string,
): WriteIntentRow | undefined {
  for (let index = intents.length - 1; index >= 0; index -= 1) {
    const intent = intents[index];
    if (intent.tool_name === toolNameMatcher) return intent;
  }
  return undefined;
}

/**
 * True when this run's harness events prove a live `vault_set_state` call
 * succeeded in `phaseName` — the only evidence that `getState`'s
 * global-latest-value read reflects this run rather than a stale prior run.
 * Dry runs never reach this: `readStatePayloadValue`'s dry-run branch reads
 * `listWriteIntents(runId, ...)`, which is already run-scoped, so a
 * recorded intent is itself the freshness proof.
 */
function hasFreshStateWrite(input: PhasePostConditionInput, phaseName: string): boolean {
  if (input.dryRun) return true;
  return countPhaseToolCallsByOutcome(input.runId, phaseName, 'vault_set_state', 'success') > 0;
}

function checkSkillEvolveInventory(input: PhasePostConditionInput): PhasePostConditionResult {
  const reports = listReports(input.runId, { scope: ALL_PROJECTS_SCOPE });
  const inventoryReport = reports.find((report) => report.action === SKILL_EVOLVE_INVENTORY_REPORT_ACTION);
  if (!inventoryReport) {
    return failed('skill-evolve completed without a skill-evolve-inventory report');
  }

  if (!hasFreshStateWrite(input, SKILL_EVOLVE_INVENTORY_PHASE_NAME)) {
    return failed('skill-evolve inventory phase wrote no skill-evolve-inventory state this run');
  }

  const stateValue = readStatePayloadValue(input, SKILL_EVOLVE_INVENTORY_STATE_KEY, SKILL_EVOLVE_TASK_NAME);
  if (!stateValue.ok) return stateValue.failure;

  const inventoryPayload = parseSkillEvolveInventoryPayload(stateValue.value);
  if (!inventoryPayload) {
    return failed(input.dryRun
      ? 'skill-evolve dry-run completed without a valid skill-evolve-inventory write intent'
      : 'skill-evolve completed without valid skill-evolve-inventory state');
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

  if (!hasFreshStateWrite(input, SKILL_EVOLVE_ASSESS_PHASE_NAME)) {
    return failed('skill-evolve assess phase wrote no skill-evolve-classifications state this run');
  }

  const stateValue = readStatePayloadValue(input, SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY, SKILL_EVOLVE_TASK_NAME);
  if (!stateValue.ok) return stateValue.failure;

  const classificationPayload = parseSkillEvolveClassificationPayload(stateValue.value);
  if (!classificationPayload) {
    return failed(input.dryRun
      ? 'skill-evolve dry-run completed without a valid skill-evolve-classifications write intent'
      : 'skill-evolve completed without valid skill-evolve-classifications state');
  }
  if (!skillEvolveClassificationPayloadsEqual(classificationPayload, assessPayload)) {
    return failed(input.dryRun
      ? 'skill-evolve classifications write intent does not match assess report'
      : 'skill-evolve classifications state does not match assess report');
  }
  return PASSED;
}

export function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * cortex-prompt-builder `build`: gate = a `cortex_prompt_builder` report
 * exists with a non-empty `details.prompt` string. Mirrors the consumer's
 * own reverse scan (`getCortexPromptResult` / `getLatestReportForAction`,
 * daemon/cortex.ts:149-155,306-320) by taking the LAST matching report
 * rather than the first — a deliberate departure from the skill-evolve
 * first-match precedent, so the gate fails exactly when the consumer would
 * fall back to `prompt: ''`.
 *
 * No run_id requirement, unlike the validate/persist gates below: the
 * build report shape carries no `run_id` key (stampRunIdInPayload only
 * rewrites a key that's already present — it never adds one, so a gate
 * requiring `details.run_id` here could never be satisfied). Attribution
 * doesn't need it either — `listReports(runId, ...)` is already run-scoped,
 * so there's no stale/fabricated agent-state row this report could be
 * confused with the way `vault_set_state` payloads can.
 */
function checkCortexPromptBuilderBuild(input: PhasePostConditionInput): PhasePostConditionResult {
  const reports = listReports(input.runId, { scope: ALL_PROJECTS_SCOPE });
  let promptReport: (typeof reports)[number] | undefined;
  for (let index = reports.length - 1; index >= 0; index -= 1) {
    if (reports[index]?.action === 'cortex_prompt_builder') {
      promptReport = reports[index];
      break;
    }
  }
  if (!promptReport) {
    return failed('cortex-prompt-builder completed without a cortex_prompt_builder report');
  }

  const details = asPlainRecord(promptReport.details);
  const prompt = details?.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return failed('cortex-prompt-builder completed without a non-empty details.prompt');
  }
  return PASSED;
}

/**
 * skill-generate `validate`: gate = a `skill_generate_validate` report
 * exists with `details.run_id` matching the run. `details.finalized` is
 * NOT required to be `true` — declining to finalize is a designed outcome
 * (criterion failure, re-stage needed) and must still satisfy the gate;
 * only the report's existence and run attribution are load-bearing here.
 */
function checkSkillGenerateValidate(input: PhasePostConditionInput): PhasePostConditionResult {
  const reports = listReports(input.runId, { scope: ALL_PROJECTS_SCOPE });
  const validateReport = reports.find((report) => report.action === 'skill_generate_validate');
  if (!validateReport) {
    return failed('skill-generate completed without a skill_generate_validate report');
  }

  const details = asPlainRecord(validateReport.details);
  if (!details || typeof details.run_id !== 'string') {
    return failed('skill-generate completed without a valid skill_generate_validate report');
  }
  if (details.run_id !== input.runId) {
    return failed('skill_generate_validate report run_id does not match the run');
  }
  return PASSED;
}

/**
 * skill-survey `reconcile-queue`: ASYMMETRIC dry/live semantics, because
 * `run_id`/`validated_at` are stamped server-side inside the LIVE
 * `vault_skill_survey_reconciliation_plan` handler only (skill-tools.ts,
 * around the `setState(..., SKILL_SURVEY_RECONCILIATION_STATE_KEY, ...)`
 * call). On a dry run the tool is intercepted before the handler runs (it
 * is destructiveHint-free but not readOnly and not in DRY_RUN_EXEMPT_TOOLS,
 * so the dry-run interceptor takes it) — the intent records the raw call
 * args verbatim, and there is no `normalizeArgs` on this tool to inject
 * run_id/validated_at into that recording. A dry intent can therefore
 * NEVER carry run_id/validated_at; requiring them on dry runs would make
 * this gate permanently unsatisfiable in dry mode.
 *
 * - dry: PASS when a `vault_skill_survey_reconciliation_plan` write
 *   intent exists (tool-call existence is the only dry-run signal
 *   available); FAIL when none was recorded (prose-only phase).
 * - live: full state-payload check — state must parse, and both run_id
 *   and validated_at must be present (validated_at confirms the live
 *   handler actually ran and stamped the row, not just that some prior
 *   state value happens to exist).
 */
function checkSkillSurveyReconcileQueue(input: PhasePostConditionInput): PhasePostConditionResult {
  if (input.dryRun) {
    const intents = listWriteIntents(input.runId, { scope: ALL_PROJECTS_SCOPE });
    const intent = findLatestIntentByToolName(intents, 'vault_skill_survey_reconciliation_plan');
    if (!intent) {
      return failed('skill-survey reconcile-queue dry-run completed without a vault_skill_survey_reconciliation_plan call');
    }
    return PASSED;
  }

  if (!input.projectId) {
    return failed('skill-survey completed without a project scope for state validation');
  }
  const stateValue = getState(input.agentId, input.projectId, SKILL_SURVEY_RECONCILIATION_STATE_KEY)?.value;
  const plan = asPlainRecord(stateValue);
  if (!plan || typeof plan.run_id !== 'string' || plan.validated_at === undefined || plan.validated_at === null) {
    return failed('skill-survey reconcile-queue completed without valid reconciliation plan state');
  }
  if (plan.run_id !== input.runId) {
    return failed('skill-survey reconciliation plan state run_id does not match the run');
  }
  return PASSED;
}

/**
 * skill-survey `persist-decisions`: gate = a `skill_survey_persist` report
 * exists with `details.run_id` matching the run. `details.outcome` may be
 * `applied` or `blocked` — blocked (vault_skill_survey_apply_reconciliation
 * rejected the plan) is a designed outcome the phase reports and moves on
 * from, so it must satisfy the gate the same as `applied`.
 */
function checkSkillSurveyPersistDecisions(input: PhasePostConditionInput): PhasePostConditionResult {
  const reports = listReports(input.runId, { scope: ALL_PROJECTS_SCOPE });
  const persistReport = reports.find((report) => report.action === 'skill_survey_persist');
  if (!persistReport) {
    return failed('skill-survey completed without a skill_survey_persist report');
  }

  const details = asPlainRecord(persistReport.details);
  if (!details || typeof details.run_id !== 'string') {
    return failed('skill-survey completed without a valid skill_survey_persist report');
  }
  if (details.run_id !== input.runId) {
    return failed('skill_survey_persist report run_id does not match the run');
  }
  return PASSED;
}

/**
 * harness-health (phase `assess`, kind `harness-health-report`): gate = a
 * `harness-health` report exists with parseable `details`. Mirrors
 * `checkCortexPromptBuilderBuild`'s last-match scan (the notification
 * consumer in harness-health-consumer.ts does the same reverse scan for the
 * same report action) and its no-run_id rationale: the report shape has no
 * `run_id` key for `stampRunIdInPayload` to rewrite, and
 * `listReports(runId, ...)` is already run-scoped, so there is no cross-run
 * state row this report could be confused with.
 *
 * Does NOT require bucket contents (findings) — an all-clear report (every
 * bucket's `entries` empty) is a designed success; the gate exists to catch
 * a prose-only phase that never called `vault_report` at all, not to demand
 * findings. It DOES enforce bucket *shape*: structural enforcement over a
 * prompt contract (repo doctrine — gates belong in tool code, not in the
 * model's self-discipline). Every `details` value that is a plain object
 * must carry an `entries` array; a model that narrates a bucket as prose
 * and drops its `entries` array produces a report the consumer silently
 * mis-reads (a missing key reads as "no findings") instead of failing the
 * phase boundary where the mistake actually happened. Array- or
 * scalar-valued top-level details keys are unaffected — only plain-object
 * values are required to carry `entries`.
 */
function checkHarnessHealthReport(input: PhasePostConditionInput): PhasePostConditionResult {
  const reports = listReports(input.runId, { scope: ALL_PROJECTS_SCOPE });
  let healthReport: (typeof reports)[number] | undefined;
  for (let index = reports.length - 1; index >= 0; index -= 1) {
    if (reports[index]?.action === 'harness-health') {
      healthReport = reports[index];
      break;
    }
  }
  if (!healthReport) {
    return failed('harness-health completed without a harness-health report');
  }

  const details = asPlainRecord(healthReport.details);
  if (!details || Object.keys(details).length === 0) {
    return failed('harness-health completed without parseable harness-health report details');
  }

  for (const [key, value] of Object.entries(details)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const bucket = value as Record<string, unknown>;
    if (!Array.isArray(bucket.entries)) {
      return failed(`harness-health report bucket "${key}" is missing its entries array`);
    }
  }
  return PASSED;
}

/**
 * Passes when the `seed-spores` phase made at least one successful
 * `vault_create_spore` call. Checkers receive no phase name, so each kind
 * hardcodes its target phase. `outcome: 'success'` means the call did not
 * throw — an app-level `textResult({ error })` return still counts.
 */
function checkVaultSeedSpores(input: PhasePostConditionInput): PhasePostConditionResult {
  const count = countPhaseToolCallsByOutcome(input.runId, 'seed-spores', 'vault_create_spore', 'success');
  if (count < 1) {
    return failed('vault-seed seed-spores phase completed without a successful vault_create_spore call');
  }
  return PASSED;
}

/**
 * Passes when the matching digest-tier phase made at least one successful
 * `vault_write_digest` call. Not gated on `digest_extracts` existence:
 * that table has no `run_id` column and keeps only the latest content per
 * (project_id, agent_id, tier), so a row can already exist from a prior run.
 */
function checkVaultSeedDigestTier(phaseName: string, tierLabel: string): PhasePostConditionFn {
  return (input: PhasePostConditionInput): PhasePostConditionResult => {
    const count = countPhaseToolCallsByOutcome(input.runId, phaseName, 'vault_write_digest', 'success');
    if (count < 1) {
      return failed(`vault-seed ${phaseName} phase completed without a successful vault_write_digest call for tier ${tierLabel}`);
    }
    return PASSED;
  };
}

const checkVaultSeedDigest10000 = checkVaultSeedDigestTier('digest-10000', '10000');
const checkVaultSeedDigest5000 = checkVaultSeedDigestTier('digest-5000', '5000');
const checkVaultSeedDigest1500 = checkVaultSeedDigestTier('digest-1500', '1500');

const PHASE_POSTCONDITIONS: Record<PhasePostConditionKind, PhasePostConditionFn> = {
  'skill-evolve-inventory': checkSkillEvolveInventory,
  'skill-evolve-assess': checkSkillEvolveAssess,
  'cortex-prompt-builder-build': checkCortexPromptBuilderBuild,
  'skill-generate-validate': checkSkillGenerateValidate,
  'skill-survey-reconcile-queue': checkSkillSurveyReconcileQueue,
  'skill-survey-persist-decisions': checkSkillSurveyPersistDecisions,
  'harness-health-report': checkHarnessHealthReport,
  'vault-seed-spores': checkVaultSeedSpores,
  'vault-seed-digest-10000': checkVaultSeedDigest10000,
  'vault-seed-digest-5000': checkVaultSeedDigest5000,
  'vault-seed-digest-1500': checkVaultSeedDigest1500,
};

export function checkPhasePostCondition(
  kind: PhasePostConditionKind,
  input: PhasePostConditionInput,
): PhasePostConditionResult {
  return PHASE_POSTCONDITIONS[kind](input);
}
