/**
 * Skill lifecycle vault tools.
 *
 * 10 tools:
 *   - vault_skill_survey_prepare: read-only deterministic preparation for
 *     skill-survey runs, including queue snapshot and evidence bundles.
 *   - vault_skill_survey_bundle_decisions: validates review-bundles
 *     decisions against deterministic evidence bundles before phase handoff.
 *   - vault_skill_survey_reconciliation_plan: validates and stores the
 *     skill-survey queue reconciliation plan, rejecting incomplete plans.
 *   - vault_skill_survey_apply_reconciliation: applies only the validated
 *     reconciliation plan stored by vault_skill_survey_reconciliation_plan.
 *   - vault_skill_candidates: CRUD over skill candidate rows. The agent
 *     can only set 'identified' or 'dismissed' on updates; human-only
 *     'approved' transitions go through the UI / MCP approve action, and
 *     'generated' is set internally by vault_finalize_skill.
 *   - vault_skill_records: read/update/delete live skill records.
 *   - vault_scan_skill_contamination: read-only content lint over proposed
 *     SKILL.md prose, returning hard and warn spans.
 *   - vault_write_skill: one-shot create-or-evolve write path used by
 *     skill-evolve and any non-staged skill authoring.
 *   - vault_stage_skill: provisional write used by skill-generate's draft
 *     phase. Stages SKILL.md + manifest.json under .myco/staging/skills/
 *     without touching the live DB or .agents/skills/ directory.
 *   - vault_finalize_skill: promotes a staged skill. Only commit point;
 *     re-runs dedup + validation as defense in depth, then atomically
 *     inserts the skill_records row, lineage, candidate transition to
 *     'generated', disk file, and symlinks. Cleans up staging on success.
 */

import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds, DEFAULT_LIST_LIMIT } from '@myco/constants.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { getDatabase } from '@myco/db/client.js';
import {
  insertCandidate, getCandidate, listCandidates, updateCandidate, deleteCandidate,
} from '@myco/db/queries/skill-candidates.js';
import { getState, setState } from '@myco/db/queries/agent-state.js';
import {
  insertSkillRecord, getSkillRecord, getSkillRecordByName,
  listSkillRecords, updateSkillRecord, deleteSkillRecordCascade,
} from '@myco/db/queries/skill-records.js';
import { insertLineage } from '@myco/db/queries/skill-lineage.js';
import { verifySkillContentClaims } from '@myco/agent/skill-drift.js';
import { notify } from '@myco/notifications/notify.js';
import {
  CANDIDATE_STATUS,
  AGENT_SETTABLE_STATUSES,
} from '@myco/constants/skill-candidate-status.js';
import { parseSourceRefs } from '@myco/agent/skill-candidate-evidence.js';
import {
  IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE,
  IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS,
  SKILL_SURVEY_BUNDLE_DECISIONS_STATE_KEY,
  SKILL_SURVEY_RECONCILIATION_POLICY_MARKER,
  SKILL_SURVEY_RECONCILIATION_STATE_KEY,
  unknownCandidateQualityFailureCodes,
} from '@myco/agent/skill-candidate-quality.js';
import {
  validateSkillContent,
  checkFrontmatterPreservation,
  descriptionSimilarity,
  DESCRIPTION_DUPLICATE_THRESHOLD,
} from './skill-validator.js';
import { scanForContamination } from './skill-contamination.js';
import {
  writeStagedSkill,
  readStagedSkill,
  writeStagedManifest,
  readStagedManifest,
  cleanupStagedSkill,
  type StagedManifest,
} from './skill-staging.js';
import {
  publishedSkillRelativePath,
  removePublishedSkillFileOrDirectory,
  resolvePublishedSkillPaths,
  syncPublishedSkillSymlinks,
  writePublishedSkillFile,
} from '@myco/skills/publication.js';
import { textResult, dryRunResult, projectScopeFromVaultToolDeps, rowProjectIdFromVaultToolDeps, type VaultToolDeps } from './types.js';
import { buildSkillSurveyPreparation, hasHumanReviewEvidence } from '../skill-survey-prepare.js';
import {
  RECONCILIATION_HANDLED_GROUPS,
  evidenceBundleForPlanEntry,
  evidenceBundleMaps,
  evidenceBundleMetadataForPlan,
  isRecord,
  mergeHumanReviewEvidence,
  normalizedBundleLookupKey,
  optionalNumberField,
  optionalStringField,
  parseJsonArrayParam,
  parseJsonObjectParam,
  parseOptionalStringArray,
  parsePlanStringArrayField,
  planSourceRefsAsJson,
  planStringArrayAsJson,
  reconciliationCreateEntries,
  reconciliationEntries,
  reconciliationEntryCandidateId,
  reconciliationEntryHasReason,
  reconciliationReason,
  reconciliationRetainEntries,
  sameStringSet,
  validateIdentifiedPlanEntry,
  validateReconciliationPlanMetadata,
  parsedExistingQualityFailures,
  type JsonRecord,
} from './skill-survey-reconciliation.js';
import {
  candidateOverlapError,
  checkCandidateCoverage as checkCandidateCoverageForRows,
  validateCandidateWrite,
} from './skill-candidate-validation.js';
import {
  emitSkillNotification,
  requireGenerationReadyCandidate,
} from './skill-promotion-support.js';

const BUNDLE_DECISION_ACTIONS = new Set(['CREATE', 'UPDATE', 'DEFER', 'DISMISS', 'SKIP']);
const IDENTIFIED_BUNDLE_DECISION_ACTIONS = new Set(['CREATE', 'UPDATE']);

interface SkillClaimGatePayload {
  error: string;
  missing_paths: string[];
  missing_symbols: string[];
  unverified_example_symbols?: string[];
}

function verifySkillContentClaimGate(args: {
  content: string;
  root: string;
  priorContent?: string;
  label: string;
  name: string;
}): SkillClaimGatePayload | null {
  const claimCheck = verifySkillContentClaims(args.content, args.root, args.priorContent);
  if (claimCheck.missingPaths.length > 0 || claimCheck.missingInlineSymbols.length > 0) {
    return {
      error: 'Skill write rejected: the content references code that does not exist in this repository. '
        + 'Verify every path and identifier with fs_read/code_grep and remove or correct the fabricated references before writing. '
        + 'Never invent a function, file, env var, or API to make an example look complete.',
      missing_paths: claimCheck.missingPaths,
      missing_symbols: claimCheck.missingInlineSymbols,
      ...(claimCheck.suspectFencedSymbols.length > 0 ? { unverified_example_symbols: claimCheck.suspectFencedSymbols } : {}),
    };
  }
  if (claimCheck.suspectFencedSymbols.length > 0) {
    console.warn(
      `[${args.label}] '${args.name}': code-fence examples reference symbols not found in the codebase: `
      + `${claimCheck.suspectFencedSymbols.join(', ')}. If these are real APIs, confirm they exist; `
      + 'if illustrative, prefer names that cannot be mistaken for real references.',
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSkillTools(deps: VaultToolDeps) {
  const { agentId, machineId, projectRoot, vaultDir, embeddingManager, dryRun } = deps;
  const projectId = rowProjectIdFromVaultToolDeps(deps);
  const scope = projectScopeFromVaultToolDeps(deps);

  function hydrateIdentifiedPlanEntriesFromBundles(
    plan: JsonRecord,
    currentPreparation: ReturnType<typeof buildSkillSurveyPreparation>,
  ): number {
    const { bundlesById, bundlesByTopic } = evidenceBundleMaps(currentPreparation.evidence_bundles);
    let hydrated = 0;

    const hydrate = (entry: JsonRecord): void => {
      const status = typeof entry.status === 'string' ? entry.status : CANDIDATE_STATUS.IDENTIFIED;
      if (status !== CANDIDATE_STATUS.IDENTIFIED) return;

      const decisionMetadata = validatedBundleDecisionMetadataForPlanEntry(entry);
      const bundle = evidenceBundleForPlanEntry(entry, bundlesById, bundlesByTopic);
      if (bundle) {
        entry.evidence_bundle_id = bundle.id;
        Object.assign(entry, evidenceBundleMetadataForPlan(bundle));
        mergeHumanReviewEvidence(entry, decisionMetadata);
        hydrated += 1;
        return;
      }

      if (decisionMetadata) {
        Object.assign(entry, decisionMetadata);
        hydrated += 1;
      }
    };

    for (const entry of reconciliationCreateEntries(plan)) hydrate(entry);
    for (const entry of reconciliationEntries(plan, 'Update')) hydrate(entry);

    return hydrated;
  }

  function validatedBundleDecisions(): JsonRecord[] {
    const stateProjectId = deps.requestContext?.projectId;
    if (!stateProjectId) return [];
    const state = getState(agentId, stateProjectId, SKILL_SURVEY_BUNDLE_DECISIONS_STATE_KEY);
    if (!state) return [];

    const parsed = parseJsonObjectParam(SKILL_SURVEY_BUNDLE_DECISIONS_STATE_KEY, state.value);
    if (
      parsed.error ||
      !parsed.object ||
      typeof parsed.object.validated_at !== 'number' ||
      parsed.object.run_id !== deps.runId
    ) {
      return [];
    }
    const decisions = parsed.object.decisions;
    return Array.isArray(decisions) ? decisions.filter(isRecord) : [];
  }

  function currentBundleDecisionState(): JsonRecord | null {
    const stateProjectId = deps.requestContext?.projectId;
    if (!stateProjectId) return null;
    const state = getState(agentId, stateProjectId, SKILL_SURVEY_BUNDLE_DECISIONS_STATE_KEY);
    if (!state) return null;
    const parsed = parseJsonObjectParam(SKILL_SURVEY_BUNDLE_DECISIONS_STATE_KEY, state.value);
    if (parsed.error || !parsed.object || typeof parsed.object.validated_at !== 'number') return null;
    if (parsed.object.run_id !== deps.runId) return null;
    return parsed.object;
  }

  function validatedBundleDecisionMetadataForPlanEntry(
    entry: JsonRecord,
  ): Pick<JsonRecord, 'evidence_bundle_id' | 'quality_score' | 'quality_failures' | 'coverage_matches' | 'source_ids' | 'rationale' | 'confidence'> | null {
    const entryIds = [
      entry.evidence_bundle_id,
      entry.bundle_id,
      entry.bundleId,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    const topicKey = normalizedBundleLookupKey(entry.topic);
    const decisions = validatedBundleDecisions();
    const matches = decisions.filter((decision) => {
      const decisionIds = [
        decision.evidence_bundle_id,
        decision.bundle_id,
        decision.bundleId,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      return entryIds.some((id) => decisionIds.includes(id))
        || (topicKey.length > 0 && normalizedBundleLookupKey(decision.topic) === topicKey);
    });
    if (matches.length !== 1) return null;

    const decision = matches[0]!;
    return {
      evidence_bundle_id: typeof decision.evidence_bundle_id === 'string'
        ? decision.evidence_bundle_id
        : typeof decision.bundle_id === 'string'
          ? decision.bundle_id
          : '',
      quality_score: decision.quality_score,
      quality_failures: parseOptionalStringArray(decision.quality_failures) ?? [],
      coverage_matches: parseOptionalStringArray(decision.coverage_matches) ?? [],
      source_ids: parseSourceRefs(decision.source_ids),
      rationale: decision.rationale,
      confidence: decision.confidence,
    };
  }

  function validateAndStoreSkillSurveyBundleDecisions(args: {
    decisions: string;
    ignore_watermark?: boolean;
  }): Record<string, unknown> {
    const parsed = parseJsonObjectParam('decisions', args.decisions);
    if (parsed.error || !parsed.object) return { error: parsed.error };

    const rawDecisions = parsed.object.decisions;
    if (!Array.isArray(rawDecisions)) {
      return { error: 'decisions must be a JSON object with a decisions array' };
    }

    const currentPreparation = buildSkillSurveyPreparation(agentId, deps.requestContext, {
      ignoreWatermark: args.ignore_watermark === true,
    });
    const { bundlesById, bundlesByTopic } = evidenceBundleMaps(currentPreparation.evidence_bundles);
    const errors: string[] = [];
    const canonicalDecisions: JsonRecord[] = [];
    let hydrated = 0;
    let rejected = 0;

    rawDecisions.filter(isRecord).forEach((decision, index) => {
      const action = typeof decision.action === 'string' ? decision.action.trim().toUpperCase() : '';
      if (!BUNDLE_DECISION_ACTIONS.has(action)) {
        errors.push(`decisions[${index}]: action must be CREATE, UPDATE, DEFER, DISMISS, or SKIP`);
        return;
      }

      const canonical: JsonRecord = {
        ...decision,
        action,
      };

      const bundle = evidenceBundleForPlanEntry(decision, bundlesById, bundlesByTopic);
      if (IDENTIFIED_BUNDLE_DECISION_ACTIONS.has(action)) {
        if (!bundle) {
          canonicalDecisions.push({
            ...canonical,
            action: 'SKIP',
            original_action: action,
            quality_score: 0,
            quality_failures: ['missing-evidence-bundle'],
            coverage_matches: [],
            source_ids: [],
            rejection_reason: 'CREATE/UPDATE decision did not reference an evidence bundle from vault_skill_survey_prepare',
          });
          rejected += 1;
          return;
        }
        Object.assign(canonical, {
          bundle_id: bundle.id,
          evidence_bundle_id: bundle.id,
          bundle_topic: bundle.topic,
          ...evidenceBundleMetadataForPlan(bundle),
        });
        if (!hasHumanReviewEvidence(optionalStringField(canonical, 'rationale'))) {
          errors.push(
            `decisions[${index}]: rationale must preserve human-review evidence with verdicts for procedure, project-specificity, repeatability, breadth, cross-session evidence, and quality`,
          );
          return;
        }
        const metadataIssues = validateIdentifiedPlanEntry(canonical, `decisions[${index}]`);
        if (metadataIssues.length > 0) {
          errors.push(...metadataIssues);
          return;
        }
        hydrated += 1;
      } else if (bundle) {
        Object.assign(canonical, {
          bundle_id: bundle.id,
          evidence_bundle_id: bundle.id,
          bundle_topic: bundle.topic,
          ...evidenceBundleMetadataForPlan(bundle),
        });
        hydrated += 1;
      } else {
        const failures = parsePlanStringArrayField(canonical, 'quality_failures');
        if (failures.error) {
          errors.push(`decisions[${index}]: ${failures.error}`);
          return;
        }
      }

      canonicalDecisions.push(canonical);
    });

    if (errors.length > 0) {
      return {
        error: 'Bundle decisions are not valid against the current evidence bundles',
        issues: errors,
      };
    }

    const stateProjectId = deps.requestContext?.projectId;
    if (!stateProjectId) {
      return { error: 'vault_skill_survey_bundle_decisions requires a project request context' };
    }

    const priorState = currentBundleDecisionState();
    const priorDecisions = Array.isArray(priorState?.decisions)
      ? priorState.decisions.filter(isRecord)
      : [];
    const mergedByKey = new Map<string, JsonRecord>();
    const decisionKey = (decision: JsonRecord, index: number): string => {
      for (const key of ['evidence_bundle_id', 'bundle_id', 'bundleId']) {
        const value = decision[key];
        if (typeof value === 'string' && value.trim().length > 0) return `id:${value}`;
      }
      const topicKey = normalizedBundleLookupKey(decision.topic);
      return topicKey.length > 0 ? `topic:${topicKey}` : `entry:${index}`;
    };
    priorDecisions.forEach((decision, index) => {
      mergedByKey.set(decisionKey(decision, index), decision);
    });
    canonicalDecisions.forEach((decision, index) => {
      mergedByKey.set(decisionKey(decision, priorDecisions.length + index), decision);
    });
    const mergedDecisions = [...mergedByKey.values()];
    const reviewedEvidenceBundleIds = currentPreparation.evidence_bundles
      .filter((bundle) => mergedDecisions.some((decision) =>
        decision.evidence_bundle_id === bundle.id ||
        decision.bundle_id === bundle.id ||
        normalizedBundleLookupKey(decision.topic) === normalizedBundleLookupKey(bundle.topic)
      ))
      .map((bundle) => bundle.id);
    const unreviewedEvidenceBundleIds = currentPreparation.evidence_bundles
      .map((bundle) => bundle.id)
      .filter((id) => !reviewedEvidenceBundleIds.includes(id));

    const now = epochSeconds();
    const stateValue = JSON.stringify({
      ...parsed.object,
      decisions: mergedDecisions,
      run_id: deps.runId,
      evidence_bundle_ids: currentPreparation.evidence_bundles.map((bundle) => bundle.id),
      reviewed_evidence_bundle_ids: reviewedEvidenceBundleIds,
      unreviewed_evidence_bundle_ids: unreviewedEvidenceBundleIds,
      complete: unreviewedEvidenceBundleIds.length === 0,
      validated_at: now,
      ignore_watermark: args.ignore_watermark === true,
    });
    const state = setState(agentId, stateProjectId, SKILL_SURVEY_BUNDLE_DECISIONS_STATE_KEY, stateValue, now);

    return {
      ok: true,
      state_key: SKILL_SURVEY_BUNDLE_DECISIONS_STATE_KEY,
      decision_count: mergedDecisions.length,
      reviewed_evidence_bundle_ids: reviewedEvidenceBundleIds,
      unreviewed_evidence_bundle_ids: unreviewedEvidenceBundleIds,
      complete: unreviewedEvidenceBundleIds.length === 0,
      hydrated_evidence_bundle_metadata_count: hydrated,
      rejected_decision_count: rejected,
      stored_at: state.updated_at,
    };
  }

  function validateDispositionReasonsAgainstCandidateState(plan: JsonRecord): string[] {
    const errors: string[] = [];
    for (const group of ['Defer', 'Dismiss'] as const) {
      reconciliationEntries(plan, group).forEach((entry, index) => {
        const id = reconciliationEntryCandidateId(entry);
        if (!id) return;
        const existing = getCandidate(id, scope);
        if (!existing) return;
        const parsedFailures = parsePlanStringArrayField(entry, 'quality_failures');
        if (parsedFailures.error || !parsedFailures.array) return;

        const existingFailures = parsedExistingQualityFailures(existing);
        const existingUnknownFailures = unknownCandidateQualityFailureCodes(existingFailures);
        const existingSourceRefCount = parseSourceRefs(existing.source_ids).length;

        for (const failure of parsedFailures.array) {
          if (failure === 'missing-quality-metadata' && existing.quality_score !== null) {
            errors.push(`${group}[${index}]: candidate ${id} already has quality_score; do not cite missing-quality-metadata`);
          }
          if (failure === 'quality-below-threshold' && (existing.quality_score === null || existing.quality_score >= IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE)) {
            errors.push(`${group}[${index}]: candidate ${id} is not below the identified quality threshold`);
          }
          if (failure === 'identified-has-quality-failures' && existingFailures.length === 0) {
            errors.push(`${group}[${index}]: candidate ${id} has no persisted quality_failures`);
          }
          if (failure === 'missing-evidence-bundle' && existing.evidence_bundle_id) {
            errors.push(`${group}[${index}]: candidate ${id} already has evidence_bundle_id; do not cite missing-evidence-bundle`);
          }
          if (failure === 'insufficient-source-refs' && existingSourceRefCount >= IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS) {
            errors.push(`${group}[${index}]: candidate ${id} has ${existingSourceRefCount} source refs; do not cite insufficient-source-refs`);
          }
          if (failure === 'missing-human-review-evidence' && hasHumanReviewEvidence(existing.rationale)) {
            errors.push(`${group}[${index}]: candidate ${id} already has human-review evidence in rationale`);
          }
          if (failure === 'invalid-quality-failure-codes' && existingUnknownFailures.length === 0) {
            errors.push(`${group}[${index}]: candidate ${id} has no unknown persisted quality failure codes`);
          }
          if (failure === 'never-reconciled' && existing.last_reconciled_at !== null) {
            errors.push(`${group}[${index}]: candidate ${id} has already been reconciled`);
          }
          if (
            failure === 'stale-reconciliation-policy' &&
            existing.reconciliation_reason?.includes(SKILL_SURVEY_RECONCILIATION_POLICY_MARKER)
          ) {
            errors.push(`${group}[${index}]: candidate ${id} is already reconciled under the current policy`);
          }
        }
      });
    }
    return errors;
  }

  function validateCreateEntriesDoNotRepresentActiveQueue(
    plan: JsonRecord,
    currentPreparation: ReturnType<typeof buildSkillSurveyPreparation>,
  ): string[] {
    const activeCandidates = currentPreparation.queue.candidates.filter((candidate) =>
      candidate.status === CANDIDATE_STATUS.IDENTIFIED ||
      candidate.status === CANDIDATE_STATUS.DEFERRED
    );
    const issues: string[] = [];

    reconciliationCreateEntries(plan).forEach((entry, index) => {
      const entryEvidenceBundleId =
        optionalStringField(entry, 'evidence_bundle_id') ??
        optionalStringField(entry, 'bundle_id') ??
        optionalStringField(entry, 'bundleId');
      const entryTopicKey = normalizedBundleLookupKey(entry.topic);
      const match = activeCandidates.find((candidate) => {
        if (entryEvidenceBundleId && candidate.evidence_bundle_id === entryEvidenceBundleId) return true;
        return entryTopicKey.length > 0 && normalizedBundleLookupKey(candidate.topic) === entryTopicKey;
      });
      if (!match) return;

      issues.push(
        `Create[${index}]: matches existing active queue candidate ${match.id}; ` +
        'classify that candidate as Keep, Update, Defer, Dismiss, or Blocked instead of Create',
      );
    });

    return issues;
  }

  function validateAndStoreSkillSurveyReconciliationPlan(args: {
    plan: string;
    ignore_watermark?: boolean;
  }): Record<string, unknown> {
    const parsed = parseJsonObjectParam('plan', args.plan);
    if (parsed.error || !parsed.object) return { error: parsed.error };

    const currentPreparation = buildSkillSurveyPreparation(agentId, deps.requestContext, {
      ignoreWatermark: args.ignore_watermark === true,
    });
    const createQueueIssues = validateCreateEntriesDoNotRepresentActiveQueue(
      parsed.object,
      currentPreparation,
    );
    if (createQueueIssues.length > 0) {
      return {
        error: 'Create entries cannot represent existing active queue candidates',
        issues: createQueueIssues,
      };
    }

    const bundleState = currentBundleDecisionState();
    const unreviewedEvidenceBundleIds = parseOptionalStringArray(bundleState?.unreviewed_evidence_bundle_ids);
    if (
      reconciliationCreateEntries(parsed.object).length > 0 &&
      bundleState &&
      unreviewedEvidenceBundleIds &&
      unreviewedEvidenceBundleIds.length > 0
    ) {
      return {
        error: 'Bundle review handoff is incomplete: every current evidence bundle must be classified before creating new candidates; submit a cleanup-only plan or complete bundle review',
        unreviewed_evidence_bundle_ids: unreviewedEvidenceBundleIds,
      };
    }
    const hydratedEvidenceBundleMetadataCount = hydrateIdentifiedPlanEntriesFromBundles(
      parsed.object,
      currentPreparation,
    );
    const cleanupTargetIds = currentPreparation.queue.cleanup_target_ids;
    const providedCleanupTargetIds = parseOptionalStringArray(parsed.object.cleanup_target_ids);
    if (parsed.object.cleanup_target_ids !== undefined && providedCleanupTargetIds === null) {
      return { error: 'cleanup_target_ids must be an array of strings when provided' };
    }
    if (providedCleanupTargetIds && !sameStringSet(providedCleanupTargetIds, cleanupTargetIds)) {
      return {
        error: 'cleanup_target_ids does not match the current vault_skill_survey_prepare worklist',
        expected_cleanup_target_ids: cleanupTargetIds,
        provided_cleanup_target_ids: providedCleanupTargetIds,
      };
    }
    if (cleanupTargetIds.length > 0 && reconciliationCreateEntries(parsed.object).length > 0) {
      return {
        error: 'Queue cleanup must complete before creating new skill candidates',
        cleanup_target_ids: cleanupTargetIds,
        message: 'Submit a cleanup-only plan with Update, Defer, Dismiss, Blocked, and Keep entries. Run skill-survey again after the active queue is clean to create new candidates.',
      };
    }

    const handledIds = new Set<string>();
    const missingReasonEntries: Array<{ group: string; index: number; id: string | null }> = [];
    for (const group of RECONCILIATION_HANDLED_GROUPS) {
      const entries = reconciliationEntries(parsed.object, group);
      entries.forEach((entry, index) => {
        const id = reconciliationEntryCandidateId(entry);
        if (id) handledIds.add(id);
        if ((group === 'Defer' || group === 'Dismiss' || group === 'Blocked') && !reconciliationEntryHasReason(entry)) {
          missingReasonEntries.push({ group, index, id });
        }
      });
    }

    if (missingReasonEntries.length > 0) {
      return {
        error: 'Defer, Dismiss, and Blocked reconciliation entries must include a concrete reason or rationale',
        entries: missingReasonEntries,
      };
    }

    const metadataErrors = validateReconciliationPlanMetadata(parsed.object);
    const dispositionConsistencyErrors = validateDispositionReasonsAgainstCandidateState(parsed.object);
    if (metadataErrors.length > 0 || dispositionConsistencyErrors.length > 0) {
      return {
        error: 'Reconciliation plan contains candidate metadata that would be rejected during persistence',
        issues: [...metadataErrors, ...dispositionConsistencyErrors],
      };
    }

    const handledCleanupTargetIds = cleanupTargetIds.filter((id) => handledIds.has(id));
    const unhandledCleanupTargetIds = cleanupTargetIds.filter((id) => !handledIds.has(id));
    if (unhandledCleanupTargetIds.length > 0) {
      return {
        error: 'Reconciliation plan is incomplete: every cleanup target must be handled by Update, Defer, Dismiss, or Blocked',
        cleanup_target_ids: cleanupTargetIds,
        handled_cleanup_target_ids: handledCleanupTargetIds,
        unhandled_cleanup_target_ids: unhandledCleanupTargetIds,
      };
    }

    const reviewedIds = new Set(handledIds);
    for (const entry of reconciliationRetainEntries(parsed.object)) {
      const id = reconciliationEntryCandidateId(entry);
      if (id) reviewedIds.add(id);
    }
    const activeQueueCandidateIds = currentPreparation.queue.actionable_candidates.map((candidate) => candidate.id);
    const reviewedCandidateIds = activeQueueCandidateIds.filter((id) => reviewedIds.has(id));
    const unreviewedCandidateIds = activeQueueCandidateIds.filter((id) => !reviewedIds.has(id));
    if (unreviewedCandidateIds.length > 0) {
      return {
        error: 'Reconciliation plan is incomplete: every active identified/deferred candidate must be classified as Update, Defer, Dismiss, Blocked, or Keep',
        active_queue_candidate_ids: activeQueueCandidateIds,
        reviewed_candidate_ids: reviewedCandidateIds,
        unreviewed_candidate_ids: unreviewedCandidateIds,
      };
    }

    const now = epochSeconds();
    const stateProjectId = deps.requestContext?.projectId;
    if (!stateProjectId) {
      return { error: 'vault_skill_survey_reconciliation_plan requires a project request context' };
    }
    const stateValue = JSON.stringify({
      ...parsed.object,
      cleanup_target_ids: cleanupTargetIds,
      handled_cleanup_target_ids: handledCleanupTargetIds,
      unhandled_cleanup_target_ids: [],
      active_queue_candidate_ids: activeQueueCandidateIds,
      reviewed_candidate_ids: reviewedCandidateIds,
      unreviewed_candidate_ids: [],
      run_id: deps.runId,
      validated_at: now,
    });
    const state = setState(agentId, stateProjectId, SKILL_SURVEY_RECONCILIATION_STATE_KEY, stateValue, now);

    return {
      ok: true,
      state_key: SKILL_SURVEY_RECONCILIATION_STATE_KEY,
      cleanup_target_ids: cleanupTargetIds,
      handled_cleanup_target_ids: handledCleanupTargetIds,
      unhandled_cleanup_target_ids: [],
      active_queue_candidate_ids: activeQueueCandidateIds,
      reviewed_candidate_ids: reviewedCandidateIds,
      unreviewed_candidate_ids: [],
      hydrated_evidence_bundle_metadata_count: hydratedEvidenceBundleMetadataCount,
      stored_at: state.updated_at,
    };
  }

  function checkCandidateCoverage(args: {
    topic: string;
    supersedes?: string | null;
    excludeCandidateId?: string;
  }) {
    const activeSkills = listSkillRecords({ scope, agent_id: agentId, status: 'active', limit: 100 });
    const allExisting = listCandidates({ scope, agent_id: agentId, limit: 500 });
    return checkCandidateCoverageForRows({
      ...args,
      activeSkills,
      existingCandidates: allExisting,
    });
  }

  function validateAndApplySkillSurveyReconciliation(args: {
    ignore_watermark?: boolean;
  }): Record<string, unknown> {
    const stateProjectId = deps.requestContext?.projectId;
    if (!stateProjectId) {
      return { error: 'vault_skill_survey_apply_reconciliation requires a project request context' };
    }

    const state = getState(agentId, stateProjectId, SKILL_SURVEY_RECONCILIATION_STATE_KEY);
    if (!state) {
      return {
        error: `Missing validated ${SKILL_SURVEY_RECONCILIATION_STATE_KEY} state. Run vault_skill_survey_reconciliation_plan first.`,
      };
    }
    const parsed = parseJsonObjectParam(SKILL_SURVEY_RECONCILIATION_STATE_KEY, state.value);
    if (parsed.error || !parsed.object) return { error: parsed.error };
    const reconciliationState = parsed.object;
    if (typeof reconciliationState.validated_at !== 'number') {
      return {
        error: `${SKILL_SURVEY_RECONCILIATION_STATE_KEY} is not validated. Run vault_skill_survey_reconciliation_plan first.`,
      };
    }
    if (reconciliationState.run_id !== deps.runId) {
      return {
        error: `Stale ${SKILL_SURVEY_RECONCILIATION_STATE_KEY} state belongs to a different run. Run vault_skill_survey_reconciliation_plan in this run first.`,
      };
    }

    const unhandled = parseOptionalStringArray(reconciliationState.unhandled_cleanup_target_ids);
    if (unhandled === null) {
      return { error: 'unhandled_cleanup_target_ids must be an array in reconciliation state' };
    }
    if (unhandled.length > 0) {
      return {
        error: 'Cannot apply reconciliation while cleanup targets remain unhandled',
        unhandled_cleanup_target_ids: unhandled,
      };
    }

    const currentPreparation = buildSkillSurveyPreparation(agentId, deps.requestContext, {
      ignoreWatermark: args.ignore_watermark === true,
    });
    const reviewedCandidateIds = parseOptionalStringArray(reconciliationState.reviewed_candidate_ids);
    if (reviewedCandidateIds === null) {
      return { error: 'reviewed_candidate_ids must be an array in reconciliation state' };
    }
    const unreviewedCurrentCandidateIds = currentPreparation.queue.actionable_candidates
      .map((candidate) => candidate.id)
      .filter((id) => !reviewedCandidateIds.includes(id));
    if (unreviewedCurrentCandidateIds.length > 0) {
      return {
        error: 'Cannot apply stale reconciliation state: current active queue has candidates not reviewed by the stored plan',
        unreviewed_current_candidate_ids: unreviewedCurrentCandidateIds,
      };
    }

    const now = epochSeconds();
    const errors: string[] = [];
    const skipped: Array<Record<string, unknown>> = [];

    const createOps = reconciliationCreateEntries(reconciliationState).map((entry, index) => {
      const topic = optionalStringField(entry, 'topic');
      const rationale = optionalStringField(entry, 'rationale') ?? optionalStringField(entry, 'reason');
      if (!topic || !rationale) {
        errors.push(`Create[${index}]: topic and rationale are required`);
        return null;
      }
      const argsForWrite = {
        status: CANDIDATE_STATUS.IDENTIFIED,
        source_ids: planSourceRefsAsJson(entry),
        evidence_bundle_id: optionalStringField(entry, 'evidence_bundle_id'),
        quality_score: optionalNumberField(entry, 'quality_score') ?? null,
        quality_failures: planStringArrayAsJson(entry, 'quality_failures'),
        coverage_matches: planStringArrayAsJson(entry, 'coverage_matches'),
      };
      const writeValidation = validateCandidateWrite(argsForWrite);
      if (writeValidation.error) {
        errors.push(`Create[${index}]: ${writeValidation.error}`);
        return null;
      }
      const coverage = checkCandidateCoverage({
        topic,
        supersedes: optionalStringField(entry, 'supersedes') ?? null,
      });
      if (coverage.error) {
        skipped.push({
          group: 'Create',
          index,
          topic,
          reason: coverage.error.error,
          existing_candidate: coverage.error.existing_candidate,
          overlapping_skills: coverage.error.overlapping_skills,
        });
        return null;
      }
      return {
        entry,
        topic,
        rationale,
        source_ids: writeValidation.normalizedSourceIds ?? argsForWrite.source_ids,
      };
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const updateOps = reconciliationEntries(reconciliationState, 'Update').map((entry, index) => {
      const id = reconciliationEntryCandidateId(entry);
      if (!id) {
        errors.push(`Update[${index}]: candidate id is required`);
        return null;
      }
      const existing = getCandidate(id, scope);
      if (!existing) {
        errors.push(`Update[${index}]: candidate not found: ${id}`);
        return null;
      }
      if (existing.status === CANDIDATE_STATUS.APPROVED || existing.status === CANDIDATE_STATUS.GENERATED) {
        errors.push(`Update[${index}]: candidate ${id} is ${existing.status}; skill-survey cannot mutate lifecycle-owned candidates`);
        return null;
      }
      const targetStatus = optionalStringField(entry, 'status') ?? CANDIDATE_STATUS.IDENTIFIED;
      const argsForWrite = {
        status: targetStatus,
        source_ids: planSourceRefsAsJson(entry),
        evidence_bundle_id: optionalStringField(entry, 'evidence_bundle_id') ?? existing.evidence_bundle_id,
        quality_score: optionalNumberField(entry, 'quality_score') ?? existing.quality_score,
        quality_failures: planStringArrayAsJson(entry, 'quality_failures') ?? existing.quality_failures,
        coverage_matches: planStringArrayAsJson(entry, 'coverage_matches') ?? existing.coverage_matches,
      };
      const writeValidation = validateCandidateWrite(argsForWrite, existing);
      if (writeValidation.error) {
        errors.push(`Update[${index}]: ${writeValidation.error}`);
        return null;
      }
      const resultingTopic = optionalStringField(entry, 'topic') ?? existing.topic;
      if (targetStatus === CANDIDATE_STATUS.IDENTIFIED) {
        const coverage = checkCandidateCoverage({
          topic: resultingTopic,
          supersedes: optionalStringField(entry, 'supersedes') ?? existing.supersedes,
          excludeCandidateId: existing.id,
        });
        if (coverage.error) {
          errors.push(`Update[${index}]: ${coverage.error.error}`);
          return null;
        }
      }
      return {
        entry,
        id,
        targetStatus,
        source_ids: writeValidation.normalizedSourceIds ?? argsForWrite.source_ids,
      };
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const dispositionOps = (['Defer', 'Dismiss'] as const).flatMap((group) =>
      reconciliationEntries(reconciliationState, group).map((entry, index) => {
        const id = reconciliationEntryCandidateId(entry);
        if (!id) {
          errors.push(`${group}[${index}]: candidate id is required`);
          return null;
        }
        const existing = getCandidate(id, scope);
        if (!existing) {
          errors.push(`${group}[${index}]: candidate not found: ${id}`);
          return null;
        }
        if (existing.status === CANDIDATE_STATUS.APPROVED || existing.status === CANDIDATE_STATUS.GENERATED) {
          errors.push(`${group}[${index}]: candidate ${id} is ${existing.status}; skill-survey cannot mutate lifecycle-owned candidates`);
          return null;
        }
        const status = group === 'Defer' ? CANDIDATE_STATUS.DEFERRED : CANDIDATE_STATUS.DISMISSED;
        const quality_failures = planStringArrayAsJson(entry, 'quality_failures');
        const writeValidation = validateCandidateWrite({
          status,
          quality_failures,
        }, existing);
        if (writeValidation.error) {
          errors.push(`${group}[${index}]: ${writeValidation.error}`);
          return null;
        }
        return { entry, id, status };
      }).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    );

    if (errors.length > 0) {
      return {
        error: 'Validated reconciliation state could not be applied',
        issues: errors,
      };
    }

    const db = getDatabase();
    const created: string[] = [];
    const updated: string[] = [];
    const deferred: string[] = [];
    const dismissed: string[] = [];
    db.transaction(() => {
      for (const op of createOps) {
        const entry = op.entry;
        const candidate = insertCandidate({
          id: crypto.randomUUID(),
          project_id: projectId,
          agent_id: agentId,
          machine_id: machineId,
          topic: op.topic,
          rationale: op.rationale,
          confidence: optionalNumberField(entry, 'confidence'),
          status: CANDIDATE_STATUS.IDENTIFIED,
          source_ids: op.source_ids,
          supersedes: optionalStringField(entry, 'supersedes'),
          evidence_bundle_id: optionalStringField(entry, 'evidence_bundle_id'),
          quality_score: optionalNumberField(entry, 'quality_score'),
          quality_failures: planStringArrayAsJson(entry, 'quality_failures'),
          coverage_matches: planStringArrayAsJson(entry, 'coverage_matches'),
          last_reconciled_at: now,
          reconciliation_reason: reconciliationReason(entry, 'skill-survey reconciliation create'),
          created_at: now,
          updated_at: now,
        });
        created.push(candidate.id);
      }

      for (const op of updateOps) {
        const entry = op.entry;
        const updatedCandidate = updateCandidate(op.id, {
          ...(optionalStringField(entry, 'topic') !== undefined ? { topic: optionalStringField(entry, 'topic') } : {}),
          ...(optionalStringField(entry, 'rationale') !== undefined ? { rationale: optionalStringField(entry, 'rationale') } : {}),
          ...(optionalNumberField(entry, 'confidence') !== undefined ? { confidence: optionalNumberField(entry, 'confidence') } : {}),
          status: op.targetStatus,
          ...(op.source_ids !== undefined ? { source_ids: op.source_ids } : {}),
          ...(optionalStringField(entry, 'supersedes') !== undefined ? { supersedes: optionalStringField(entry, 'supersedes') } : {}),
          ...(optionalStringField(entry, 'evidence_bundle_id') !== undefined ? { evidence_bundle_id: optionalStringField(entry, 'evidence_bundle_id') } : {}),
          ...(optionalNumberField(entry, 'quality_score') !== undefined ? { quality_score: optionalNumberField(entry, 'quality_score') } : {}),
          ...(planStringArrayAsJson(entry, 'quality_failures') !== undefined ? { quality_failures: planStringArrayAsJson(entry, 'quality_failures') } : {}),
          ...(planStringArrayAsJson(entry, 'coverage_matches') !== undefined ? { coverage_matches: planStringArrayAsJson(entry, 'coverage_matches') } : {}),
          last_reconciled_at: now,
          reconciliation_reason: reconciliationReason(entry, 'skill-survey reconciliation update'),
          updated_at: now,
        }, scope);
        if (updatedCandidate) updated.push(updatedCandidate.id);
      }

      for (const op of dispositionOps) {
        const entry = op.entry;
        const updatedCandidate = updateCandidate(op.id, {
          status: op.status,
          quality_failures: planStringArrayAsJson(entry, 'quality_failures'),
          last_reconciled_at: now,
          reconciliation_reason: reconciliationReason(entry, `skill-survey reconciliation ${op.status}`),
          updated_at: now,
        }, scope);
        if (updatedCandidate?.status === CANDIDATE_STATUS.DEFERRED) deferred.push(updatedCandidate.id);
        if (updatedCandidate?.status === CANDIDATE_STATUS.DISMISSED) dismissed.push(updatedCandidate.id);
      }
    })();

    for (const id of created) {
      const candidate = getCandidate(id, scope);
      if (!candidate) continue;
      notify(vaultDir, {
        domain: 'skills',
        type: 'skill.surveyed',
        title: `Skill candidate: ${candidate.topic}`,
        message: candidate.rationale.slice(0, 120),
        link: '/skills?tab=candidates',
        metadata: { candidateId: candidate.id, topic: candidate.topic },
      });
    }

    const after = buildSkillSurveyPreparation(agentId, deps.requestContext, {
      ignoreWatermark: args.ignore_watermark === true,
    });

    return {
      ok: true,
      state_key: SKILL_SURVEY_RECONCILIATION_STATE_KEY,
      applied_counts: {
        created: created.length,
        updated: updated.length,
        deferred: deferred.length,
        dismissed: dismissed.length,
        kept: reconciliationRetainEntries(reconciliationState).length,
        blocked: reconciliationEntries(reconciliationState, 'Blocked').length,
        skipped: skipped.length,
      },
      created_candidate_ids: created,
      updated_candidate_ids: updated,
      deferred_candidate_ids: deferred,
      dismissed_candidate_ids: dismissed,
      skipped_actions: skipped,
      remaining_cleanup_target_ids: after.queue.cleanup_target_ids,
      active_queue_count: after.queue.actionable,
    };
  }

  const vaultSkillSurveyPrepare = tool(
    'vault_skill_survey_prepare',
    'Prepare deterministic read-only context for a skill-survey run: watermark details, settled evidence, active skill coverage, existing candidate queue, and candidate evidence bundles.',
    {
      ignore_watermark: z.boolean().optional().describe('When true, prepare a full scan instead of applying the stored skill-survey watermark. Manual Run Now flows should pass the value from the run admission instruction.'),
    },
    async (args) => textResult(buildSkillSurveyPreparation(agentId, deps.requestContext, {
      ignoreWatermark: args.ignore_watermark === true,
    })),
    { annotations: { readOnlyHint: true } },
  );

  const vaultSkillSurveyBundleDecisions = tool(
    'vault_skill_survey_bundle_decisions',
    'Validate and store review-bundles decisions against deterministic skill-survey evidence bundles. Hydrates canonical evidence metadata before later reconciliation phases consume the decisions. INTERNAL: requires an active skill-survey run context (deps.runId); external MCP callers will see errors about stale or missing run state.',
    {
      decisions: z.string().describe('JSON object with a decisions array. CREATE/UPDATE decisions must reference an evidence bundle from vault_skill_survey_prepare by bundle_id, evidence_bundle_id, or exact topic.'),
      ignore_watermark: z.boolean().optional().describe('Use the same ignore_watermark value passed to vault_skill_survey_prepare for this run.'),
    },
    async (args) => textResult(validateAndStoreSkillSurveyBundleDecisions({
      decisions: args.decisions,
      ignore_watermark: args.ignore_watermark,
    })),
    // Explicitly NOT idempotent: each call updates agent_state
    // (validated_at, stored_at, merged decisions list). MCP auto-retry
    // layers must not treat a repeat call as a safe replay.
    { annotations: { idempotentHint: false, readOnlyHint: false } },
  );

  const vaultSkillSurveyReconciliationPlan = tool(
    'vault_skill_survey_reconciliation_plan',
    'Validate and store the skill-survey reconciliation plan. Rejects plans that do not classify every active queue candidate and handle every cleanup target from vault_skill_survey_prepare. INTERNAL: requires an active skill-survey run context (deps.runId); external MCP callers will see errors about stale or missing run state.',
    {
      plan: z.string().describe('JSON object containing reconciliation actions. Every identified/deferred queue candidate must appear in Update, Defer, Dismiss, Blocked, or Keep. Cleanup targets must appear in Update, Defer, Dismiss, or Blocked.'),
      ignore_watermark: z.boolean().optional().describe('Use the same ignore_watermark value passed to vault_skill_survey_prepare for this run.'),
    },
    async (args) => textResult(validateAndStoreSkillSurveyReconciliationPlan({
      plan: args.plan,
      ignore_watermark: args.ignore_watermark,
    })),
    // Explicitly NOT idempotent: persists plan state keyed by runId.
    { annotations: { idempotentHint: false, readOnlyHint: false } },
  );

  const vaultSkillSurveyApplyReconciliation = tool(
    'vault_skill_survey_apply_reconciliation',
    'Apply only the validated skill-survey reconciliation plan stored by vault_skill_survey_reconciliation_plan. This is the sole write path for skill-survey queue persistence. INTERNAL: requires an active skill-survey run context (deps.runId); external MCP callers will see errors about stale or missing run state.',
    {
      ignore_watermark: z.boolean().optional().describe('Use the same ignore_watermark value passed to vault_skill_survey_prepare and vault_skill_survey_reconciliation_plan for this run.'),
    },
    async (args) => textResult(validateAndApplySkillSurveyReconciliation({
      ignore_watermark: args.ignore_watermark,
    })),
    // Explicitly NOT idempotent: performs CRUD on skill_candidates
    // within a DB transaction (insertCandidate, updateCandidate,
    // notify). Replays can double-apply mutations.
    { annotations: { idempotentHint: false, readOnlyHint: false, destructiveHint: true } },
  );

  /**
   * Self-contained dedup gate for skill create paths. Returns `null`
   * when the write is allowed, or an error payload object ready for
   * textResult() when it should be rejected.
   *
   * The gate is a no-op on the evolve path (same name as an existing
   * active skill) — the caller does not need to guard the call.
   *
   * Three checks, in order:
   *   (1) Same-name exists: delegate to the evolve path. Return null
   *       so vault_write_skill's existing-record branch can handle it;
   *       callers that only want create (vault_stage_skill,
   *       vault_finalize_skill) opt in via `rejectSameName: true`.
   *   (2) Candidate-already-fulfilled: if the candidate is already
   *       linked to a different-named active skill.
   *   (3) Description similarity: Jaccard on significant-word tokens
   *       against all active skills for this agent.
   */
  function checkDedupGates(args: {
    candidate_id?: string;
    name: string;
    description: string;
    /**
     * When true, treat an existing skill with the same name as a
     * rejection (create-only callers). When false, same-name passes
     * through silently so the caller can dispatch the evolve path.
     */
    rejectSameName?: boolean;
  }): Record<string, unknown> | null {
    // (1) Same-name check
    const existingSameName = getSkillRecordByName(args.name, scope);
    if (existingSameName) {
      if (args.rejectSameName) {
        return {
          error:
            `Skill "${args.name}" already exists. This path is create-only. ` +
            'Use vault_write_skill to evolve the existing skill (it bumps the generation), ' +
            'or mark the current record stale via vault_skill_records first.',
          existing_skill: {
            id: existingSameName.id,
            name: existingSameName.name,
            path: existingSameName.path,
          },
        };
      }
      return null;
    }

    // (2) Candidate-already-fulfilled check
    if (args.candidate_id) {
      const candidate = getCandidate(args.candidate_id, scope);
      if (candidate?.skill_id) {
        const linkedSkill = getSkillRecord(candidate.skill_id, scope);
        if (linkedSkill && linkedSkill.name !== args.name) {
          return {
            error:
              `Candidate ${args.candidate_id} is already fulfilled by skill "${linkedSkill.name}". ` +
              'Do not create a sibling skill. If the existing skill needs changes, ' +
              'write to the same name to evolve it (this bumps its generation), or ' +
              'mark it stale via vault_skill_records before replacing.',
            existing_skill: {
              id: linkedSkill.id,
              name: linkedSkill.name,
              description: linkedSkill.description,
              path: linkedSkill.path,
            },
          };
        }
      }
    }

    // (3) Description similarity check
    const activeSkills = listSkillRecords({ scope, agent_id: agentId, status: 'active', limit: 200 });
    let bestMatch: { skill: typeof activeSkills[number]; score: number } | null = null;
    for (const skill of activeSkills) {
      const score = descriptionSimilarity(args.description, skill.description);
      if (score >= DESCRIPTION_DUPLICATE_THRESHOLD && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { skill, score };
      }
    }
    if (bestMatch) {
      return {
        error:
          `Description overlaps with existing active skill "${bestMatch.skill.name}" ` +
          `(Jaccard ${bestMatch.score.toFixed(2)}, threshold ${DESCRIPTION_DUPLICATE_THRESHOLD}). ` +
          'Do not create a duplicate. Either evolve the existing skill by writing to ' +
          `its name ("${bestMatch.skill.name}"), or reframe this skill so its description ` +
          'describes a distinct procedure.',
        overlapping_skill: {
          id: bestMatch.skill.id,
          name: bestMatch.skill.name,
          description: bestMatch.skill.description,
          path: bestMatch.skill.path,
        },
        similarity: bestMatch.score,
      };
    }

    return null;
  }

  /**
   * Shared create-path promotion: write SKILL.md to the live
   * .agents/skills/<name>/ directory, create symbiont symlinks, then
   * insert the skill_records row + lineage entry in one DB transaction.
   * If the transaction throws, the disk write is reversed so no orphan
   * file survives.
   *
   * Used by both vault_write_skill's create branch and
   * vault_finalize_skill. Evolve (generation > 1) stays inline in
   * vault_write_skill because its rollback semantics differ — it
   * restores prior content rather than deleting the whole directory.
   *
   * `linkCandidate` runs inside the same transaction after the record
   * is inserted. Callers use it for their own candidate-linking policy:
   * vault_write_skill does an exact/prefix search over approved
   * candidates; vault_finalize_skill sets the candidate directly from
   * the staged manifest.
   */
  async function promoteNewSkill(params: {
    name: string;
    display_name: string;
    description: string;
    content: string;
    source_ids?: string;
    candidate_id?: string | null;
    rationale?: string;
    linkCandidate?: (recordId: string, now: number) => void;
    label: string;
  }): Promise<
    | { id: string; name: string; path: string; generation: number }
    | { error: string }
  > {
    const root = projectRoot ?? process.cwd();
    const publishedPaths = resolvePublishedSkillPaths(root, params.name);
    if (!publishedPaths.ok) {
      return { error: 'Invalid skill name: resolved path escapes .agents/skills' };
    }
    // If the directory already exists for a create, it's an orphan
    // from a prior failed run — we overwrite the file and only remove
    // the file itself on rollback (not the whole directory) to avoid
    // clobbering anything else that may share the dir.
    const skillDirPreexisted = existsSync(publishedPaths.paths.skillDir);

    async function cleanupCreatedSkillArtifactsOnRollback(): Promise<void> {
      try {
        removePublishedSkillFileOrDirectory(root, params.name, { fileOnly: skillDirPreexisted });
      } catch (rollbackErr) {
        console.warn(
          `[${params.label}] file rollback after DB failure also failed:`,
          rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
        );
      }

      try {
        syncPublishedSkillSymlinks(root, params.name, { remove: true });
      } catch (rollbackErr) {
        console.warn(
          `[${params.label}] symlink rollback after DB failure also failed:`,
          rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
        );
      }
    }

    try {
      const writeResult = writePublishedSkillFile(root, params.name, params.content);
      if (!writeResult.ok) {
        return { error: 'Invalid skill name: resolved path escapes .agents/skills' };
      }
    } catch (err) {
      return {
        error: `Failed to write skill file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      syncPublishedSkillSymlinks(root, params.name);
    } catch (err) {
      console.warn(
        `[${params.label}] syncSkillSymlinks failed:`,
        err instanceof Error ? err.message : err,
      );
    }

    const now = epochSeconds();
    const relativePath = publishedSkillRelativePath(params.name);
    const recordId = crypto.randomUUID();
    const generation = 1;

    const txDb = getDatabase();
    try {
      txDb.transaction(() => {
        insertSkillRecord({
          id: recordId,
          project_id: projectId,
          agent_id: agentId,
          machine_id: machineId,
          name: params.name,
          display_name: params.display_name,
          description: params.description,
          candidate_id: params.candidate_id ?? null,
          source_ids: params.source_ids,
          path: relativePath,
          created_at: now,
          updated_at: now,
        });

        insertLineage({
          id: crypto.randomUUID(),
          project_id: projectId,
          skill_id: recordId,
          generation,
          action: 'created',
          rationale: params.rationale ?? 'Initial skill creation',
          source_ids_added: params.source_ids,
          content_snapshot: params.content,
          created_at: now,
        });

        params.linkCandidate?.(recordId, now);
      })();
    } catch (err) {
      await cleanupCreatedSkillArtifactsOnRollback();
      return {
        error: `Skill write aborted: database transaction failed and on-disk state was rolled back. ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      id: recordId,
      name: params.name,
      path: relativePath,
      generation,
    };
  }

  const vaultSkillCandidates = tool(
    'vault_skill_candidates',
    'Manage skill candidates (identified topics that may become skills). Supports list, get, create, and update actions.',
    {
      action: z.enum(['list', 'get', 'create', 'update', 'delete']).describe('Action to perform'),
      id: z.string().optional().describe('Candidate ID (required for get/update)'),
      topic: z.string().optional().describe('Skill topic (required for create)'),
      rationale: z.string().optional().describe('Why this should be a skill (required for create)'),
      confidence: z.number().optional().describe('Confidence score 0-1'),
      status: z.enum(AGENT_SETTABLE_STATUSES as readonly [string, ...string[]]).optional().describe(
        "Candidate status — agent-settable values only. 'identified' is " +
        "the initial state; 'dismissed' retires a candidate. 'approved' " +
        "and 'generated' are lifecycle transitions owned by the human UI " +
        'and vault_finalize_skill respectively.',
      ),
      statuses: z.array(z.enum([
        CANDIDATE_STATUS.IDENTIFIED,
        CANDIDATE_STATUS.DEFERRED,
        CANDIDATE_STATUS.DISMISSED,
        CANDIDATE_STATUS.APPROVED,
        CANDIDATE_STATUS.GENERATED,
      ] as const)).optional().describe('Candidate statuses to include for list. Takes precedence over status.'),
      source_ids: z.string().optional().describe('JSON array of source spore/entity IDs'),
      skill_id: z.string().optional().describe('Associated skill record ID (after materialization)'),
      supersedes: z.string().optional().describe('JSON array of skill record names this candidate would replace (for domain-level candidates that subsume existing narrow skills)'),
      evidence_bundle_id: z.string().optional().describe('Evidence bundle ID supporting an identified candidate'),
      quality_score: z.number().optional().describe('Evidence quality score for an identified candidate'),
      quality_failures: z.string().optional().describe('JSON array of quality gate failure identifiers'),
      coverage_matches: z.string().optional().describe('JSON array of existing skill/candidate coverage matches'),
      last_reconciled_at: z.number().optional().describe('Epoch seconds timestamp for the last reconciliation pass'),
      reconciliation_reason: z.string().optional().describe('Reason for the latest reconciliation update'),
      limit: z.number().optional().describe('Maximum candidates to return (for list)'),
    },
    async (args) => {
      switch (args.action) {
        case 'list': {
          // `statuses` takes precedence over `status` per the schema
          // description. Enforce that at the tool boundary so downstream
          // listCandidates receives only one of the two filters and the
          // contract is not implicit in the query layer's resolution.
          const candidates = listCandidates({
            scope,
            agent_id: agentId,
            status: args.statuses !== undefined ? undefined : args.status,
            statuses: args.statuses,
            limit: args.limit ?? DEFAULT_LIST_LIMIT,
          });
          return textResult(candidates);
        }

        case 'get': {
          if (!args.id) return textResult({ error: 'id is required for get action' });
          const candidate = getCandidate(args.id, scope);
          if (!candidate) return textResult({ error: `Candidate not found: ${args.id}` });
          return textResult(candidate);
        }

        case 'create': {
          if (!args.topic || !args.rationale) {
            return textResult({ error: 'topic and rationale are required for create action' });
          }

          const writeValidation = validateCandidateWrite(args);
          if (writeValidation.error) return textResult({ error: writeValidation.error });

          const resultingStatus = args.status ?? CANDIDATE_STATUS.IDENTIFIED;
          const coverage = resultingStatus === CANDIDATE_STATUS.IDENTIFIED
            ? checkCandidateCoverage({ topic: args.topic, supersedes: args.supersedes })
            : {};
          if (coverage.error) return textResult(coverage.error);

          const dismissedMatch = coverage.dismissedMatch;

          const now = epochSeconds();
          const candidate = insertCandidate({
            id: crypto.randomUUID(),
            project_id: projectId,
            agent_id: agentId,
            machine_id: machineId,
            topic: args.topic,
            rationale: args.rationale,
            confidence: args.confidence,
            status: args.status,
            source_ids: writeValidation.normalizedSourceIds ?? args.source_ids,
            supersedes: args.supersedes,
            evidence_bundle_id: args.evidence_bundle_id,
            quality_score: args.quality_score,
            quality_failures: args.quality_failures,
            coverage_matches: args.coverage_matches,
            last_reconciled_at: args.last_reconciled_at,
            reconciliation_reason: args.reconciliation_reason,
            created_at: now,
            updated_at: now,
          });
          const result: Record<string, unknown> = { ...candidate };
          if (dismissedMatch) {
            result.warning = candidateOverlapError(dismissedMatch.candidate);
            result.similar_dismissed_candidate = {
              id: dismissedMatch.candidate.id,
              topic: dismissedMatch.candidate.topic,
            };
          }
          notify(vaultDir, {
            domain: 'skills',
            type: 'skill.surveyed',
            title: `Skill candidate: ${args.topic}`,
            message: args.rationale.slice(0, 120),
            link: '/skills?tab=candidates',
            metadata: { candidateId: candidate.id, topic: args.topic },
          });
          return textResult(result);
        }

        case 'update': {
          if (!args.id) return textResult({ error: 'id is required for update action' });
          const existing = getCandidate(args.id, scope);
          if (!existing) return textResult({ error: `Candidate not found: ${args.id}` });

          const writeValidation = validateCandidateWrite(args, existing);
          if (writeValidation.error) return textResult({ error: writeValidation.error });

          const resultingStatus = args.status ?? existing.status;
          const resultingTopic = args.topic ?? existing.topic;
          const coverage = resultingStatus === CANDIDATE_STATUS.IDENTIFIED
            ? checkCandidateCoverage({
              topic: resultingTopic,
              supersedes: args.supersedes ?? existing.supersedes,
              excludeCandidateId: existing.id,
            })
            : {};
          if (coverage.error) return textResult(coverage.error);

          const now = epochSeconds();
          const updated = updateCandidate(args.id, {
            ...(args.topic !== undefined ? { topic: args.topic } : {}),
            ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
            ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.source_ids !== undefined ? { source_ids: writeValidation.normalizedSourceIds ?? args.source_ids } : {}),
            ...(args.skill_id !== undefined ? { skill_id: args.skill_id } : {}),
            ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
            ...(args.evidence_bundle_id !== undefined ? { evidence_bundle_id: args.evidence_bundle_id } : {}),
            ...(args.quality_score !== undefined ? { quality_score: args.quality_score } : {}),
            ...(args.quality_failures !== undefined ? { quality_failures: args.quality_failures } : {}),
            ...(args.coverage_matches !== undefined ? { coverage_matches: args.coverage_matches } : {}),
            ...(args.last_reconciled_at !== undefined ? { last_reconciled_at: args.last_reconciled_at } : {}),
            ...(args.reconciliation_reason !== undefined ? { reconciliation_reason: args.reconciliation_reason } : {}),
            updated_at: now,
          }, scope);
          if (!updated) return textResult({ error: `Candidate not found: ${args.id}` });
          if (coverage.dismissedMatch) {
            return textResult({
              ...updated,
              warning: candidateOverlapError(coverage.dismissedMatch.candidate),
              similar_dismissed_candidate: {
                id: coverage.dismissedMatch.candidate.id,
                topic: coverage.dismissedMatch.candidate.topic,
              },
            });
          }
          return textResult(updated);
        }

        case 'delete': {
          if (!args.id) return textResult({ error: 'id is required for delete action' });
          const deleted = deleteCandidate(args.id, scope);
          if (!deleted) return textResult({ error: `Candidate not found: ${args.id}` });
          return textResult({ deleted: true, id: args.id });
        }

        default:
          return textResult({ error: `Unknown action: ${args.action}` });
      }
    },
    { annotations: {} },
  );

  const vaultSkillRecords = tool(
    'vault_skill_records',
    'Read, update, and delete skill records (materialized skills on disk). Supports list, get, update, and delete actions. The get action includes the full SKILL.md file content. For update, at least one mutating field (status, generation, source_ids, description, or properties) is required — calls with only {action, id} are rejected to prevent silent no-op updates.',
    {
      action: z.enum(['list', 'get', 'update', 'delete']).describe('Action to perform'),
      id: z.string().optional().describe('Skill record ID or name (required for get/update/delete)'),
      status: z.enum(['active', 'stale', 'retired']).optional().describe('Filter by status or new status (for update)'),
      generation: z.number().optional().describe('New generation number (for update)'),
      source_ids: z.string().optional().describe('JSON array of source IDs (for update)'),
      description: z.string().optional().describe('Updated description (for update)'),
      properties: z.string().optional().describe('JSON-encoded object of properties to MERGE into the existing properties (for update). Example: \'{"last_verified_at": 1776580022}\'. Existing keys not included in the payload are preserved; included keys overwrite. Used by skill-evolve to persist watermarks like last_assessed_at, knowledge_watermark, last_verified_at, last_classification.'),
      limit: z.number().optional().describe('Maximum records to return (for list)'),
    },
    async (args) => {
      switch (args.action) {
        case 'list': {
          const records = listSkillRecords({
            scope,
            agent_id: agentId,
            status: args.status,
            limit: args.limit ?? DEFAULT_LIST_LIMIT,
          });
          return textResult(records);
        }

        case 'get': {
          if (!args.id) return textResult({ error: 'id is required for get action' });
          const record = getSkillRecord(args.id, scope) ?? getSkillRecordByName(args.id, scope);
          if (!record) return textResult({ error: `Skill record not found: ${args.id}` });
          // Include file content so evolve/merge operations can read skill bodies
          const result: Record<string, unknown> = { ...record };
          if (record.path && projectRoot) {
            try {
              result.content = readFileSync(resolve(projectRoot, record.path), 'utf-8');
            } catch {
              // File missing — return record without content
            }
          }
          return textResult(result);
        }

        case 'update': {
          if (!args.id) return textResult({ error: 'id is required for update action' });
          // Structural guard: reject no-op updates so silent-success bugs can't
          // accumulate. Callers that only bump updated_at should not use this path.
          const hasMutatingField = args.status !== undefined
            || args.generation !== undefined
            || args.source_ids !== undefined
            || args.description !== undefined
            || args.properties !== undefined;
          if (!hasMutatingField) {
            return textResult({
              error: 'update action requires at least one mutating field (status, generation, source_ids, description, or properties). Calls with only {action, id} are rejected to prevent silent no-op updates.',
            });
          }

          // Resolve by id or name
          const existing = getSkillRecord(args.id, scope) ?? getSkillRecordByName(args.id, scope);
          if (!existing) return textResult({ error: `Skill record not found: ${args.id}` });

          // Shallow-merge incoming properties into existing so multiple callers
          // (assess, verify) can each write distinct keys without clobbering.
          let mergedProperties: string | undefined;
          if (args.properties !== undefined) {
            let incoming: Record<string, unknown>;
            try {
              const parsed = JSON.parse(args.properties);
              if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return textResult({ error: 'properties must be a JSON-encoded object (not null, array, or primitive).' });
              }
              incoming = parsed as Record<string, unknown>;
            } catch (err) {
              return textResult({ error: `properties is not valid JSON: ${errorMessage(err)}` });
            }
            let existingProps: Record<string, unknown> = {};
            try {
              const parsedExisting = JSON.parse(existing.properties || '{}');
              if (parsedExisting && typeof parsedExisting === 'object' && !Array.isArray(parsedExisting)) {
                existingProps = parsedExisting as Record<string, unknown>;
              }
            } catch (err) {
              // Loud about corrupt stored properties so we don't silently
              // wipe data on the next merge.
              console.warn(`[vault_skill_records] Skill ${existing.id} has unparseable properties; treating as empty for merge. Error: ${errorMessage(err)}`);
            }
            mergedProperties = JSON.stringify({ ...existingProps, ...incoming });
          }

          const now = epochSeconds();
          const updated = updateSkillRecord(existing.id, {
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.generation !== undefined ? { generation: args.generation } : {}),
            ...(args.source_ids !== undefined ? { source_ids: args.source_ids } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(mergedProperties !== undefined ? { properties: mergedProperties } : {}),
            updated_at: now,
          }, scope);
          if (!updated) return textResult({ error: `Failed to update skill record: ${existing.id}` });
          return textResult(updated);
        }

        case 'delete': {
          if (!args.id) return textResult({ error: 'id is required for delete action' });
          const result = deleteSkillRecordCascade(args.id, scope);
          if (!result) return textResult({ error: `Skill record not found: ${args.id}` });
          try { embeddingManager?.onRemoved('skill_records', result.id); } catch { /* best-effort */ }
          // Disk + symlink cleanup (best-effort)
          const root = projectRoot ?? process.cwd();
          if (!/[/\\]|\.\./.test(result.name)) {
            try { removePublishedSkillFileOrDirectory(root, result.name); } catch (err) {
              console.warn('[vault_skill_records] Failed to remove skill directory:', err instanceof Error ? err.message : err);
            }
            try {
              syncPublishedSkillSymlinks(root, result.name, { remove: true });
            } catch (err) {
              console.warn('[vault_skill_records] Failed to remove symlinks:', err instanceof Error ? err.message : err);
            }
          }
          return textResult({ deleted: true, id: result.id, name: result.name });
        }

        default:
          return textResult({ error: `Unknown action: ${args.action}` });
      }
    },
    { annotations: {} },
  );

  const vaultScanSkillContamination = tool(
    'vault_scan_skill_contamination',
    'Read-only lint for proposed SKILL.md content. Returns hard and warn spans; live skill write gates reject either kind.',
    {
      content: z.string().describe('Full SKILL.md content to scan, including frontmatter. The scanner ignores non-description frontmatter, code blocks, inline code, and explicit history sections.'),
      strict: z.boolean().optional().describe('Retained for callers that label strict scans. ok=false whenever either hard or warn spans are present, matching live write gates.'),
    },
    async (args) => {
      const scan = scanForContamination(args.content);
      const strict = args.strict === true;
      const ok = scan.hard.length === 0 && scan.warn.length === 0;
      return textResult({
        ok,
        strict,
        hard: scan.hard,
        warn: scan.warn,
        hard_count: scan.hard.length,
        warn_count: scan.warn.length,
      });
    },
    { annotations: { readOnlyHint: true } },
  );

  const vaultWriteSkill = tool(
    'vault_write_skill',
    'Write a SKILL.md file to disk and create or update the corresponding skill record and lineage entry.',
    {
      name: z.string().describe('Skill directory name (kebab-case, NO colon). The myco: prefix goes in the SKILL.md frontmatter name field, not here.'),
      display_name: z.string().describe('Human-readable display name'),
      description: z.string().describe('Short description of what the skill does'),
      content: z.string().describe('Full SKILL.md content in markdown'),
      source_ids: z.string().optional().describe('JSON array of source spore/entity IDs'),
      candidate_id: z.string().optional().describe('Candidate ID that prompted this skill creation'),
      rationale: z.string().optional().describe('Why this skill was created or updated'),
    },
    async (args) => {
      // Validate skill content before writing -- reject malformed skills
      const validationErrors = validateSkillContent(args.content, args.name);
      if (validationErrors.length > 0) {
        return textResult({
          error: 'Skill validation failed. Fix these issues and try again.',
          issues: validationErrors,
        });
      }

      // Path traversal guard -- reject names containing path separators or dot-dot sequences
      if (!args.name || /[/\\]|\.\./.test(args.name)) {
        return textResult({
          error: 'Invalid skill name: must be a simple directory name without path separators or ".."',
        });
      }

      // Dedup gate is self-gating: returns null when same-name exists
      // (the evolve path) so the caller falls through.
      const dedupError = checkDedupGates({
        candidate_id: args.candidate_id,
        name: args.name,
        description: args.description,
      });
      if (dedupError) {
        return textResult(dedupError);
      }
      const existing = getSkillRecordByName(args.name, scope);

      const root = projectRoot ?? process.cwd();
      // Path shape is owned by the publication module — don't hand-build it.
      const skillPath = resolve(root, publishedSkillRelativePath(args.name));

      // Frontmatter preservation guard — when updating an existing skill,
      // reject writes that change protected fields (user-invocable, allowed-tools).
      const priorContent = existsSync(skillPath) ? readFileSync(skillPath, 'utf-8') : undefined;
      if (priorContent !== undefined) {
        const violations = checkFrontmatterPreservation(priorContent, args.content);
        if (violations.length > 0) {
          return textResult({
            error: 'Skill update rejected: protected frontmatter fields were changed. Read the existing skill and preserve these values exactly.',
            violations,
          });
        }
      }

      // Fabrication gate — skills are authoritative content that agents load
      // and follow, so a confidently-wrong code reference is worse than none.
      // Deterministically verify the concrete code claims in the proposed
      // content against the codebase. This is the one check a cheap model or a
      // skipped prompt-level verification cannot bypass. Inline path/symbol
      // claims that do not exist are rejected (asserted as real → clear
      // fabrication); symbols that appear only inside ```code``` examples are
      // surfaced as warnings, since illustrative pseudo-code may legitimately
      // use invented names. On evolve, only NEWLY introduced claims are gated.
      const claimGateError = verifySkillContentClaimGate({
        content: args.content,
        root,
        priorContent,
        label: 'vault_write_skill',
        name: args.name,
      });
      if (claimGateError) return textResult(claimGateError);

      // Create path: delegate to the shared promoteNewSkill helper.
      // Candidate linking uses exact-then-prefix matching since the
      // agent may pass a truncated UUID in the instruction.
      if (!existing) {
        // Structural gate: if the caller passed a candidate_id, the
        // candidate must be approved and generation-ready. Evolve path
        // (above) skips this because the caller is updating an existing
        // skill, not materializing a fresh candidate.
        if (args.candidate_id) {
          const candidateError = requireGenerationReadyCandidate(args.candidate_id, scope);
          if (candidateError) {
            return textResult(candidateError);
          }
        }

        const linkCandidate = (recordId: string, now: number) => {
          if (!args.candidate_id) return;
          const exact = updateCandidate(args.candidate_id, {
            status: CANDIDATE_STATUS.GENERATED, skill_id: recordId, updated_at: now,
          }, scope);
          if (exact) return;
          const approvedCandidates = listCandidates({ scope, status: CANDIDATE_STATUS.APPROVED, limit: 10 });
          const prefixMatch = approvedCandidates.find((c) => c.id.startsWith(args.candidate_id!));
          if (prefixMatch) {
            updateCandidate(prefixMatch.id, {
              status: CANDIDATE_STATUS.GENERATED, skill_id: recordId, updated_at: now,
            }, scope);
          }
        };

        const result = await promoteNewSkill({
          name: args.name,
          display_name: args.display_name,
          description: args.description,
          content: args.content,
          source_ids: args.source_ids,
          candidate_id: args.candidate_id,
          rationale: args.rationale,
          linkCandidate,
          label: 'vault_write_skill',
        });
        if ('error' in result) return textResult(result);
        emitSkillNotification(vaultDir, 'created', {
          name: result.name,
          display_name: args.display_name,
          description: args.description,
          recordId: result.id,
          generation: result.generation,
        });
        embeddingManager?.onContentWritten('skill_records', result.id, args.description, {
          status: 'active',
          name: args.name,
          ...(scope.kind === 'project' ? { project_id: scope.id } : {}),
        }).catch(() => {});
        return textResult(result);
      }

      // Evolve path: update existing record, bump generation, preserve
      // prior SKILL.md content on rollback. This branch stays inline
      // because its rollback semantics (restore prior content) differ
      // from the create helper.
      const priorSkillContent = readFileSync(skillPath, 'utf-8');

      try {
        const writeResult = writePublishedSkillFile(root, args.name, args.content);
        if (!writeResult.ok) {
          return textResult({ error: 'Invalid skill name: resolved path escapes .agents/skills' });
        }
      } catch (err) {
        return textResult({ error: `Failed to write skill file: ${err instanceof Error ? err.message : String(err)}` });
      }

      try {
        syncPublishedSkillSymlinks(root, args.name);
      } catch (err) {
        console.warn('[vault_write_skill] syncSkillSymlinks failed:', err instanceof Error ? err.message : err);
      }

      const now = epochSeconds();
      const relativePath = publishedSkillRelativePath(args.name);
      const generation = existing.generation + 1;
      const recordId = existing.id;

      const txDb = getDatabase();
      try {
        txDb.transaction(() => {
          updateSkillRecord(existing.id, {
            display_name: args.display_name,
            description: args.description,
            generation,
            ...(args.source_ids !== undefined ? { source_ids: args.source_ids } : {}),
            path: relativePath,
            updated_at: now,
          }, scope);

          insertLineage({
            id: crypto.randomUUID(),
            project_id: projectId,
            skill_id: existing.id,
            generation,
            action: 'updated',
            rationale: args.rationale ?? 'Skill content updated',
            source_ids_added: args.source_ids,
            content_snapshot: args.content,
            created_at: now,
          });
        })();
      } catch (err) {
        // Route the rollback through the single skill-artifact writer too, so
        // path/guard semantics can never diverge between write and rollback.
        try {
          const rollback = writePublishedSkillFile(root, args.name, priorSkillContent);
          if (!rollback.ok) {
            console.warn('[vault_write_skill] file rollback refused:', rollback.reason);
          }
        } catch (rollbackErr) {
          console.warn(
            '[vault_write_skill] file rollback after DB failure also failed:',
            rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
          );
        }
        return textResult({
          error: `Skill write aborted: database transaction failed and on-disk state was rolled back. ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      emitSkillNotification(vaultDir, 'evolved', {
        name: args.name,
        display_name: args.display_name,
        description: args.description,
        recordId,
        generation,
      });
      embeddingManager?.onContentWritten('skill_records', recordId, args.description, {
        status: 'active',
        name: args.name,
        ...(scope.kind === 'project' ? { project_id: scope.id } : {}),
      }).catch(() => {});

      return textResult({
        id: recordId,
        name: args.name,
        path: relativePath,
        generation,
      });
    },
    { annotations: { openWorldHint: true } },
  );

  const vaultStageSkill = tool(
    'vault_stage_skill',
    "Stage a provisional SKILL.md under .myco/staging/skills/<candidate_id>/ for later promotion by vault_finalize_skill. Use this from the skill-generate draft phase. The write is NOT live — the skill does not appear under .agents/skills/ and no DB rows are created until vault_finalize_skill is called with the same candidate_id.",
    {
      candidate_id: z.string().describe(
        'Candidate ID from the instruction. Required — staging is keyed by candidate so the validate phase (and on-failure cleanup) can find the staged content.',
      ),
      name: z.string().describe('Final skill directory name (kebab-case, no colon). Stored in the manifest for finalize.'),
      display_name: z.string().describe('Human-readable display name'),
      description: z.string().describe('Short description — used for the dedup gate and the final skill record'),
      content: z.string().describe('Full SKILL.md content in markdown including frontmatter'),
      source_ids: z.string().optional().describe('JSON array of source spore/entity IDs'),
      rationale: z.string().optional().describe('Why this skill is being created — stored in lineage after finalize'),
    },
    async (args) => {
      if (!vaultDir) {
        return textResult({
          error: 'vault_stage_skill requires vaultDir on the tool deps — staging has no location otherwise',
        });
      }

      // Static validation — same rules as vault_write_skill
      const validationErrors = validateSkillContent(args.content, args.name);
      if (validationErrors.length > 0) {
        return textResult({
          error: 'Skill validation failed. Fix these issues and re-stage.',
          issues: validationErrors,
        });
      }

      // Path traversal guard for the skill name (which becomes a directory)
      if (!args.name || /[/\\]|\.\./.test(args.name)) {
        return textResult({
          error: 'Invalid skill name: must be a simple directory name without path separators or ".."',
        });
      }

      // Structural gate: candidate must exist, be approved, and carry
      // complete resolvable evidence metadata.
      const candidateError = requireGenerationReadyCandidate(args.candidate_id, scope);
      if (candidateError) return textResult(candidateError);

      // Dedup gate — create-only, so rejectSameName surfaces the
      // evolve path as an explicit error. Finalize re-runs the same
      // gate as defense in depth.
      const dedupError = checkDedupGates({
        candidate_id: args.candidate_id,
        name: args.name,
        description: args.description,
        rejectSameName: true,
      });
      if (dedupError) return textResult(dedupError);

      const root = projectRoot ?? process.cwd();
      const claimGateError = verifySkillContentClaimGate({
        content: args.content,
        root,
        label: 'vault_stage_skill',
        name: args.name,
      });
      if (claimGateError) return textResult(claimGateError);

      // Write staging content + manifest
      let stagingFilePath: string;
      try {
        stagingFilePath = writeStagedSkill(vaultDir, args.candidate_id, args.content);
        const manifest: StagedManifest = {
          candidate_id: args.candidate_id,
          name: args.name,
          display_name: args.display_name,
          description: args.description,
          source_ids: args.source_ids ?? '[]',
          rationale: args.rationale ?? 'Initial draft',
        };
        writeStagedManifest(vaultDir, args.candidate_id, manifest);
      } catch (err) {
        return textResult({
          error: `Failed to write staged skill: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      return textResult({
        candidate_id: args.candidate_id,
        staging_path: stagingFilePath,
        status: 'staged',
      });
    },
    { annotations: { openWorldHint: true } },
  );

  const vaultFinalizeSkill = tool(
    'vault_finalize_skill',
    'Promote a staged skill to live at .agents/skills/<name>/ and insert the skill_records / lineage rows. Call this from skill-generate validate phase after your quality checks pass. Requires vault_stage_skill to have been called earlier with the same candidate_id; reads the staged SKILL.md + manifest rather than taking duplicate metadata.',
    {
      candidate_id: z.string().describe('Candidate ID whose staged skill should be promoted. Must match a previous vault_stage_skill call.'),
    },
    async (args) => {
      // Dry-run block: finalize promotes a real skill (writes SKILL.md,
      // inserts skill_records, flips the candidate to 'generated'). None
      // of that can be meaningfully stubbed — the staged dir may not
      // even exist in a dry-run where vault_stage_skill ran for real
      // (staging IS allowed in dry-run) but downstream disk/DB promotion
      // must not happen. Short-circuit with a positive-signal ack.
      if (dryRun) {
        return dryRunResult('vault_finalize_skill', {
          reason: 'finalize blocked in dry-run',
          candidate_id: args.candidate_id,
        });
      }

      if (!vaultDir) {
        return textResult({
          error: 'vault_finalize_skill requires vaultDir on the tool deps',
        });
      }

      // Read staged content + manifest
      const stagedContent = readStagedSkill(vaultDir, args.candidate_id);
      const manifest = readStagedManifest(vaultDir, args.candidate_id);
      if (!stagedContent || !manifest) {
        return textResult({
          error:
            `No staged skill found for candidate ${args.candidate_id}. ` +
            'Call vault_stage_skill first.',
        });
      }
      if (manifest.candidate_id !== args.candidate_id) {
        return textResult({
          error:
            `Staged skill manifest candidate_id mismatch: expected ${args.candidate_id}, ` +
            `found ${manifest.candidate_id}. Re-stage the skill before finalizing.`,
        });
      }

      // Defense-in-depth: candidate must still be 'approved' at
      // finalize time. If a human (or another tool) dismissed the
      // candidate between stage and finalize, the finalize should
      // refuse rather than promote the now-rescinded skill.
      const candidateError = requireGenerationReadyCandidate(args.candidate_id, scope);
      if (candidateError) return textResult(candidateError);

      // Defense-in-depth: re-run validation against the staged content.
      // The staging write already validated once, but the file on disk
      // could have been mutated (tests do this explicitly to check the
      // guard; a crash between stage and finalize could too).
      const validationErrors = validateSkillContent(stagedContent, manifest.name);
      if (validationErrors.length > 0) {
        return textResult({
          error: 'Staged skill failed validation on finalize. Re-stage with valid content.',
          issues: validationErrors,
        });
      }

      const root = projectRoot ?? process.cwd();
      const claimGateError = verifySkillContentClaimGate({
        content: stagedContent,
        root,
        label: 'vault_finalize_skill',
        name: manifest.name,
      });
      if (claimGateError) return textResult(claimGateError);

      // Defense-in-depth: re-run dedup against the manifest-declared
      // description. Catches the "agent staged a fresh description,
      // then tampered the manifest to collide with a live skill" case,
      // and also trips if a concurrent evolve landed a same-named skill
      // between stage and finalize.
      const dedupError = checkDedupGates({
        candidate_id: args.candidate_id,
        name: manifest.name,
        description: manifest.description,
        rejectSameName: true,
      });
      if (dedupError) return textResult(dedupError);

      // Promote via the shared helper. Candidate link is direct — the
      // staged manifest guarantees candidate_id exists, so no search.
      // updateCandidate moves the candidate OUT of 'approved' so its
      // approved_at audit timestamp is preserved by construction.
      const result = await promoteNewSkill({
        name: manifest.name,
        display_name: manifest.display_name,
        description: manifest.description,
        content: stagedContent,
        source_ids: manifest.source_ids,
        candidate_id: manifest.candidate_id,
        rationale: manifest.rationale,
        linkCandidate: (recordId, now) => {
          updateCandidate(manifest.candidate_id, {
            status: CANDIDATE_STATUS.GENERATED,
            skill_id: recordId,
            updated_at: now,
          }, scope);
        },
        label: 'vault_finalize_skill',
      });
      if ('error' in result) return textResult(result);

      // Success — clean up staging and notify.
      cleanupStagedSkill(vaultDir, args.candidate_id);
      emitSkillNotification(vaultDir, 'created', {
        name: manifest.name,
        display_name: manifest.display_name,
        description: manifest.description,
        recordId: result.id,
        generation: result.generation,
      });
      embeddingManager?.onContentWritten('skill_records', result.id, manifest.description, {
        status: 'active',
        name: manifest.name,
        ...(scope.kind === 'project' ? { project_id: scope.id } : {}),
      }).catch(() => {});

      return textResult(result);
    },
    { annotations: { openWorldHint: true } },
  );

  return [
    vaultSkillSurveyPrepare,
    vaultSkillSurveyBundleDecisions,
    vaultSkillSurveyReconciliationPlan,
    vaultSkillSurveyApplyReconciliation,
    vaultSkillCandidates,
    vaultSkillRecords,
    vaultScanSkillContamination,
    vaultWriteSkill,
    vaultStageSkill,
    vaultFinalizeSkill,
  ];
}
