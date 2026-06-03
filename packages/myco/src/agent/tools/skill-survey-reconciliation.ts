/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { CANDIDATE_STATUS } from '@myco/constants/skill-candidate-status.js';
import {
  parseSourceRefs,
  type SkillCandidateEvidenceBundle,
} from '@myco/agent/skill-candidate-evidence.js';
import {
  CANDIDATE_QUALITY_FAILURE_CODES,
  IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE,
  IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS,
  SKILL_SURVEY_RECONCILIATION_POLICY_MARKER,
  unknownCandidateQualityFailureCodes,
} from '@myco/agent/skill-candidate-quality.js';
import { hasHumanReviewEvidence } from '../skill-survey-prepare.js';

export type JsonRecord = Record<string, unknown>;

export const RECONCILIATION_HANDLED_GROUPS = ['Update', 'Defer', 'Dismiss', 'Blocked'] as const;
export const RECONCILIATION_RETAIN_GROUPS = ['Keep'] as const;

const RECONCILIATION_GROUP_ALIASES: Record<typeof RECONCILIATION_HANDLED_GROUPS[number], string[]> = {
  Update: ['Update', 'Updates', 'update', 'updates'],
  Defer: ['Defer', 'Defers', 'defer', 'defers'],
  Dismiss: ['Dismiss', 'Dismisses', 'dismiss', 'dismisses'],
  Blocked: ['Blocked', 'blocked'],
};

const RECONCILIATION_RETAIN_ALIASES: Record<typeof RECONCILIATION_RETAIN_GROUPS[number], string[]> = {
  Keep: ['Keep', 'Keeps', 'keep', 'keeps', 'Retain', 'Retains', 'retain', 'retains'],
};

const RECONCILIATION_CREATE_ALIASES = ['Create', 'Creates', 'create', 'creates'];

export function parseJsonArrayParam(
  fieldName: 'quality_failures' | 'coverage_matches',
  value: string | undefined,
): { array?: string[]; error?: string } {
  if (value === undefined) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { error: `${fieldName} must be a JSON array` };
  }

  if (!Array.isArray(parsed)) {
    return { error: `${fieldName} must be a JSON array` };
  }
  if (!parsed.every((entry) => typeof entry === 'string')) {
    return { error: `${fieldName} must be a JSON array of strings` };
  }
  if (fieldName === 'quality_failures') {
    const unknown = unknownCandidateQualityFailureCodes(parsed);
    if (unknown.length > 0) {
      return {
        error:
          `${fieldName} contains unknown reason code(s): ${unknown.join(', ')}. ` +
          `Accepted codes: ${CANDIDATE_QUALITY_FAILURE_CODES.join(', ')}`,
      };
    }
  }
  return { array: parsed };
}

export function validateCandidateSourceIds(
  sourceIds: string | undefined,
  options: { required: boolean; minRefs: number },
): { normalized?: string; error?: string } {
  if (sourceIds === undefined) {
    return options.required
      ? { error: 'source_ids is required for identified skill candidates' }
      : {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceIds);
  } catch {
    return { error: 'source_ids must be a JSON array of valid source references' };
  }
  if (!Array.isArray(parsed)) {
    return { error: 'source_ids must be a JSON array of valid source references' };
  }

  const invalidEntries = parsed.filter((entry) => parseSourceRefs([entry]).length !== 1);
  if (invalidEntries.length > 0) {
    return { error: 'source_ids contains invalid source reference entries' };
  }

  const refs = parseSourceRefs(parsed);
  if (refs.length < options.minRefs) {
    return { error: `source_ids must contain at least ${options.minRefs} valid source references` };
  }

  return { normalized: JSON.stringify(refs) };
}

export function parseSupersedesNames(value: string | undefined | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonObjectParam(fieldName: string, value: string): { object?: JsonRecord; error?: string } {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return { error: `${fieldName} must be a JSON object` };
    }
    return { object: parsed };
  } catch {
    return { error: `${fieldName} must be valid JSON` };
  }
}

export function parseOptionalStringArray(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return null;
  return value;
}

export function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((entry) => bSet.has(entry));
}

function getReconciliationActionRoot(plan: JsonRecord): JsonRecord {
  return isRecord(plan.actions) ? plan.actions : plan;
}

export function reconciliationEntries(
  plan: JsonRecord,
  group: typeof RECONCILIATION_HANDLED_GROUPS[number],
): JsonRecord[] {
  const root = getReconciliationActionRoot(plan);
  const entries: JsonRecord[] = [];
  for (const alias of RECONCILIATION_GROUP_ALIASES[group]) {
    const value = root[alias];
    if (Array.isArray(value)) {
      entries.push(...value.filter(isRecord));
    }
  }
  return entries;
}

export function reconciliationRetainEntries(plan: JsonRecord): JsonRecord[] {
  const root = getReconciliationActionRoot(plan);
  const entries: JsonRecord[] = [];
  for (const alias of RECONCILIATION_RETAIN_ALIASES.Keep) {
    const value = root[alias];
    if (Array.isArray(value)) {
      entries.push(...value.filter(isRecord));
    }
  }
  return entries;
}

export function reconciliationCreateEntries(plan: JsonRecord): JsonRecord[] {
  const root = getReconciliationActionRoot(plan);
  const entries: JsonRecord[] = [];
  for (const alias of RECONCILIATION_CREATE_ALIASES) {
    const value = root[alias];
    if (Array.isArray(value)) {
      entries.push(...value.filter(isRecord));
    }
  }
  return entries;
}

export function reconciliationEntryCandidateId(entry: JsonRecord): string | null {
  for (const key of ['id', 'candidate_id', 'candidateId', 'target_candidate_id', 'targetCandidateId']) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

export function reconciliationEntryHasReason(entry: JsonRecord): boolean {
  return ['reason', 'rationale', 'reconciliation_reason', 'reconciliationReason']
    .some((key) => typeof entry[key] === 'string' && entry[key].trim().length > 0);
}

export function parsePlanStringArrayField(
  entry: JsonRecord,
  fieldName: 'quality_failures' | 'coverage_matches',
): { array?: string[]; error?: string } {
  const value = entry[fieldName];
  if (value === undefined) return {};

  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { error: `${fieldName} must be a JSON array` };
    }
  }

  if (!Array.isArray(parsed)) {
    return { error: `${fieldName} must be a JSON array` };
  }
  if (!parsed.every((item) => typeof item === 'string')) {
    return { error: `${fieldName} must be a JSON array of strings` };
  }
  if (fieldName === 'quality_failures') {
    const unknown = unknownCandidateQualityFailureCodes(parsed);
    if (unknown.length > 0) {
      return {
        error:
          `${fieldName} contains unknown reason code(s): ${unknown.join(', ')}. ` +
          `Accepted codes: ${CANDIDATE_QUALITY_FAILURE_CODES.join(', ')}`,
      };
    }
  }
  return { array: parsed };
}

export function rawSourceRefCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

export function planStringArrayAsJson(
  entry: JsonRecord,
  fieldName: 'quality_failures' | 'coverage_matches',
): string | undefined {
  const parsed = parsePlanStringArrayField(entry, fieldName);
  return parsed.array ? JSON.stringify(parsed.array) : undefined;
}

export function planSourceRefsAsJson(entry: JsonRecord): string | undefined {
  const rawCount = rawSourceRefCount(entry.source_ids);
  if (rawCount === null) return undefined;
  const refs = parseSourceRefs(entry.source_ids);
  return JSON.stringify(refs);
}

export function optionalStringField(entry: JsonRecord, key: string): string | undefined {
  const value = entry[key];
  return typeof value === 'string' ? value : undefined;
}

export function optionalNumberField(entry: JsonRecord, key: string): number | undefined {
  const value = entry[key];
  return typeof value === 'number' ? value : undefined;
}

export function reconciliationReason(entry: JsonRecord, fallback: string): string {
  const reason = optionalStringField(entry, 'reconciliation_reason')
    ?? optionalStringField(entry, 'reconciliationReason')
    ?? optionalStringField(entry, 'reason')
    ?? optionalStringField(entry, 'rationale')
    ?? fallback;
  return reason.includes(SKILL_SURVEY_RECONCILIATION_POLICY_MARKER)
    ? reason
    : `${SKILL_SURVEY_RECONCILIATION_POLICY_MARKER}: ${reason}`;
}

export function validateIdentifiedPlanEntry(entry: JsonRecord, label: string): string[] {
  const errors: string[] = [];
  if (typeof entry.evidence_bundle_id !== 'string' || entry.evidence_bundle_id.trim().length === 0) {
    errors.push(`${label}: evidence_bundle_id is required`);
  }
  if (typeof entry.quality_score !== 'number' || entry.quality_score < IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE) {
    errors.push(`${label}: quality_score must be >= ${IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE}`);
  }

  const qualityFailures = parsePlanStringArrayField(entry, 'quality_failures');
  if (qualityFailures.error) {
    errors.push(`${label}: ${qualityFailures.error}`);
  } else if (!qualityFailures.array || qualityFailures.array.length > 0) {
    errors.push(`${label}: quality_failures must be an empty array for identified candidates`);
  }

  const coverageMatches = parsePlanStringArrayField(entry, 'coverage_matches');
  if (coverageMatches.error) {
    errors.push(`${label}: ${coverageMatches.error}`);
  }

  const rawCount = rawSourceRefCount(entry.source_ids);
  const sourceRefs = parseSourceRefs(entry.source_ids);
  if (rawCount === null) {
    errors.push(`${label}: source_ids must be a JSON array of source references`);
  } else if (sourceRefs.length !== rawCount) {
    errors.push(`${label}: source_ids contains invalid source reference entries`);
  } else if (sourceRefs.length < IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS) {
    errors.push(`${label}: source_ids must contain at least ${IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS} valid source references`);
  }
  return errors;
}

export function evidenceBundleMetadataForPlan(
  bundle: SkillCandidateEvidenceBundle,
): Pick<JsonRecord, 'quality_score' | 'quality_failures' | 'coverage_matches' | 'source_ids'> {
  const sourceRefs = parseSourceRefs(bundle.sourceRefs);
  return {
    quality_score: bundle.score,
    quality_failures: bundle.failures,
    coverage_matches: bundle.coverageMatches,
    source_ids: sourceRefs,
  };
}

export function mergeHumanReviewEvidence(entry: JsonRecord, metadata: JsonRecord | null): boolean {
  if (!metadata) return false;
  let merged = false;
  const rationale = optionalStringField(metadata, 'rationale');
  if (rationale && !hasHumanReviewEvidence(optionalStringField(entry, 'rationale'))) {
    entry.rationale = rationale;
    merged = true;
  }
  const confidence = optionalNumberField(metadata, 'confidence');
  if (confidence !== undefined && optionalNumberField(entry, 'confidence') === undefined) {
    entry.confidence = confidence;
    merged = true;
  }
  return merged;
}

export function normalizedBundleLookupKey(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
    : '';
}

export function evidenceBundleMaps(
  evidenceBundles: SkillCandidateEvidenceBundle[],
): {
  bundlesById: Map<string, SkillCandidateEvidenceBundle>;
  bundlesByTopic: Map<string, SkillCandidateEvidenceBundle[]>;
} {
  const bundlesById = new Map(
    evidenceBundles.map(bundle => [bundle.id, bundle]),
  );
  const bundlesByTopic = new Map<string, SkillCandidateEvidenceBundle[]>();
  for (const bundle of evidenceBundles) {
    const key = normalizedBundleLookupKey(bundle.topic);
    const existing = bundlesByTopic.get(key) ?? [];
    existing.push(bundle);
    bundlesByTopic.set(key, existing);
  }
  return { bundlesById, bundlesByTopic };
}

export function evidenceBundleForPlanEntry(
  entry: JsonRecord,
  bundlesById: Map<string, SkillCandidateEvidenceBundle>,
  bundlesByTopic: Map<string, SkillCandidateEvidenceBundle[]>,
): SkillCandidateEvidenceBundle | null {
  if (typeof entry.evidence_bundle_id === 'string') {
    const exact = bundlesById.get(entry.evidence_bundle_id);
    if (exact) return exact;
  }

  const byTopic = bundlesByTopic.get(normalizedBundleLookupKey(entry.topic));
  if (byTopic?.length === 1) return byTopic[0];

  return null;
}

export function validateNonIdentifiedPlanEntry(
  entry: JsonRecord,
  label: string,
  options: { requireQualityFailures: boolean },
): string[] {
  const failures = parsePlanStringArrayField(entry, 'quality_failures');
  if (failures.error) return [`${label}: ${failures.error}`];
  if (options.requireQualityFailures && (!failures.array || failures.array.length === 0)) {
    return [`${label}: quality_failures must include at least one canonical reason code`];
  }
  return [];
}

export function validateReconciliationPlanMetadata(plan: JsonRecord): string[] {
  const errors: string[] = [];
  reconciliationCreateEntries(plan).forEach((entry, index) => {
    errors.push(...validateIdentifiedPlanEntry(entry, `Create[${index}]`));
  });

  reconciliationEntries(plan, 'Update').forEach((entry, index) => {
    const status = typeof entry.status === 'string' ? entry.status : CANDIDATE_STATUS.IDENTIFIED;
    if (status === CANDIDATE_STATUS.IDENTIFIED) {
      errors.push(...validateIdentifiedPlanEntry(entry, `Update[${index}]`));
    } else {
      errors.push(...validateNonIdentifiedPlanEntry(entry, `Update[${index}]`, {
        requireQualityFailures: status === CANDIDATE_STATUS.DEFERRED || status === CANDIDATE_STATUS.DISMISSED,
      }));
    }
  });

  for (const group of ['Defer', 'Dismiss'] as const) {
    reconciliationEntries(plan, group).forEach((entry, index) => {
      errors.push(...validateNonIdentifiedPlanEntry(entry, `${group}[${index}]`, {
        requireQualityFailures: true,
      }));
    });
  }
  reconciliationEntries(plan, 'Blocked').forEach((entry, index) => {
    errors.push(...validateNonIdentifiedPlanEntry(entry, `Blocked[${index}]`, {
      requireQualityFailures: false,
    }));
  });
  return errors;
}

export function parsedExistingQualityFailures(candidate: { quality_failures: string }): string[] {
  const parsed = parseJsonArrayParam('quality_failures', candidate.quality_failures);
  return parsed.array ?? [];
}
