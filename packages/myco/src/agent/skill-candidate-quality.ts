import { getDatabase } from '@myco/db/client.js';
import { getPlan } from '@myco/db/queries/plans.js';
import { projectScopeClause, type ProjectScope } from '@myco/db/queries/project-scope.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { getSpore } from '@myco/db/queries/spores.js';
import { parseSourceRefs } from './skill-candidate-evidence.js';

export const CANDIDATE_QUALITY_FAILURE_CODES = [
  'insufficient-source-refs',
  'insufficient-distinct-sessions',
  'missing-project-anchor',
  'active-skill-overlap',
  'existing-candidate-overlap',
  'missing-quality-metadata',
  'missing-evidence-bundle',
  'quality-below-threshold',
  'identified-has-quality-failures',
  'invalid-quality-failure-codes',
  'deferred-review-required',
  'missing-human-review-evidence',
  'never-reconciled',
  'stale-reconciliation-policy',
] as const;

export type CandidateQualityFailureCode = (typeof CANDIDATE_QUALITY_FAILURE_CODES)[number];

const CANDIDATE_QUALITY_FAILURE_CODE_SET = new Set<string>(CANDIDATE_QUALITY_FAILURE_CODES);

export function isCandidateQualityFailureCode(value: string): value is CandidateQualityFailureCode {
  return CANDIDATE_QUALITY_FAILURE_CODE_SET.has(value);
}

export function unknownCandidateQualityFailureCodes(values: readonly string[]): string[] {
  return values.filter((value) => !isCandidateQualityFailureCode(value));
}

export const IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE = 0.7;
export const IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS = 3;
export const SKILL_SURVEY_RECONCILIATION_STATE_KEY = 'skill-survey-reconciliation-decisions';
export const SKILL_SURVEY_BUNDLE_DECISIONS_STATE_KEY = 'skill-survey-bundle-decisions';
export const SKILL_SURVEY_RECONCILIATION_POLICY_MARKER = 'skill-survey-reconciliation-policy:v2';

export interface CandidateQualityContractRow {
  id?: string;
  status?: string;
  source_ids?: string | null;
  evidence_bundle_id?: string | null;
  quality_score?: number | null;
  quality_failures?: string | null;
  coverage_matches?: string | null;
}

export interface CandidateQualityContractOptions {
  requireResolvedSources?: boolean;
  scope?: ProjectScope;
}

export function validateSkillCandidateQualityContract(
  candidate: CandidateQualityContractRow,
  options: CandidateQualityContractOptions = {},
): string[] {
  const issues: string[] = [];
  if (!candidate.evidence_bundle_id || candidate.evidence_bundle_id.trim().length === 0) {
    issues.push('evidence_bundle_id is required');
  }
  if (
    typeof candidate.quality_score !== 'number' ||
    candidate.quality_score < IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE
  ) {
    issues.push(`quality_score must be >= ${IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE}`);
  }

  const qualityFailures = parseStringArrayField(candidate.quality_failures, 'quality_failures');
  if (qualityFailures.error) {
    issues.push(qualityFailures.error);
  } else if (qualityFailures.values.length > 0) {
    issues.push('quality_failures must be an empty array');
  }

  const coverageMatches = parseStringArrayField(candidate.coverage_matches, 'coverage_matches');
  if (coverageMatches.error) {
    issues.push(coverageMatches.error);
  }

  const sourceRefs = parseSourceRefs(candidate.source_ids);
  const rawSourceRefCount = rawJsonArrayLength(candidate.source_ids);
  if (rawSourceRefCount === null) {
    issues.push('source_ids must be a JSON array of source references');
  } else if (sourceRefs.length !== rawSourceRefCount) {
    issues.push('source_ids contains invalid source reference entries');
  } else if (sourceRefs.length < IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS) {
    issues.push(`source_ids must contain at least ${IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS} valid source references`);
  } else if (options.requireResolvedSources) {
    if (!options.scope) {
      issues.push('project scope is required to resolve source_ids');
    } else {
      const missing = sourceRefs.filter((ref) => !sourceRefExists(ref, options.scope!));
      if (missing.length > 0) {
        issues.push(`source_ids reference missing vault records: ${missing.map((ref) => `${ref.type}:${ref.id}`).join(', ')}`);
      }
    }
  }

  return issues;
}

function parseStringArrayField(
  value: string | null | undefined,
  fieldName: 'quality_failures' | 'coverage_matches',
): { values: string[]; error?: string } {
  if (value === undefined || value === null || value === '') {
    return { values: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { values: [], error: `${fieldName} must be a JSON array` };
  }
  if (!Array.isArray(parsed)) {
    return { values: [], error: `${fieldName} must be a JSON array` };
  }
  if (!parsed.every((entry) => typeof entry === 'string')) {
    return { values: [], error: `${fieldName} must be a JSON array of strings` };
  }
  if (fieldName === 'quality_failures') {
    const unknown = unknownCandidateQualityFailureCodes(parsed);
    if (unknown.length > 0) {
      return {
        values: parsed,
        error:
          `${fieldName} contains unknown reason code(s): ${unknown.join(', ')}. ` +
          `Accepted codes: ${CANDIDATE_QUALITY_FAILURE_CODES.join(', ')}`,
      };
    }
  }
  return { values: parsed };
}

function rawJsonArrayLength(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

function sourceRefExists(ref: ReturnType<typeof parseSourceRefs>[number], scope: ProjectScope): boolean {
  switch (ref.type) {
    case 'spore':
      return getSpore(ref.id, scope) !== null;
    case 'session':
      return getSession(ref.id, scope) !== null;
    case 'plan':
      return getPlan(ref.id, scope) !== null;
    case 'artifact':
      return artifactExists(ref.id, scope);
  }
}

function artifactExists(id: string, scope: ProjectScope): boolean {
  const clause = projectScopeClause(scope);
  const row = getDatabase()
    .prepare(`SELECT id FROM artifacts WHERE id = ?${clause.sql} LIMIT 1`)
    .get(id, ...clause.params) as { id: string } | undefined;
  return Boolean(row);
}
