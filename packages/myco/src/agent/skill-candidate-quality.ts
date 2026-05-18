import { getDatabase } from '@myco/db/client.js';
import { projectScopeClause, type ProjectScope } from '@myco/db/queries/project-scope.js';
import { parseSourceRefsWithRawCount } from './skill-candidate-evidence.js';

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

  const qualityFailures = parseJsonStringArray(candidate.quality_failures, 'quality_failures');
  if (qualityFailures.error) {
    issues.push(qualityFailures.error);
  } else {
    const unknownCodes = unknownCandidateQualityFailureCodes(qualityFailures.values);
    if (unknownCodes.length > 0) {
      issues.push(
        `quality_failures contains unknown reason code(s): ${unknownCodes.join(', ')}. ` +
        `Accepted codes: ${CANDIDATE_QUALITY_FAILURE_CODES.join(', ')}`,
      );
    } else if (qualityFailures.values.length > 0) {
      issues.push('quality_failures must be an empty array');
    }
  }

  const coverageMatches = parseJsonStringArray(candidate.coverage_matches, 'coverage_matches');
  if (coverageMatches.error) {
    issues.push(coverageMatches.error);
  }

  const { refs: sourceRefs, rawCount: rawSourceRefCount } =
    parseSourceRefsWithRawCount(candidate.source_ids);
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
      const missing = missingSourceRefs(sourceRefs, options.scope);
      if (missing.length > 0) {
        issues.push(`source_ids reference missing vault records: ${missing.map((ref) => `${ref.type}:${ref.id}`).join(', ')}`);
      }
    }
  }

  return issues;
}

/**
 * Pure JSON-array-of-strings parser. Returns the array on success, or
 * an `error` message when the JSON is malformed / not an array / not
 * all-strings. Empty/null/undefined inputs return `{ values: [] }` so
 * callers don't have to handle the "field not set" case separately.
 *
 * Per-field semantic validation (e.g. unknown quality-failure codes)
 * lives at the call site so this stays a single-purpose JSON helper.
 */
function parseJsonStringArray(
  value: string | null | undefined,
  fieldName: string,
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
  return { values: parsed };
}

/**
 * Returns the subset of `refs` whose target vault record does not
 * exist under `scope`. One DB round-trip per source TYPE (spore /
 * session / plan / artifact), batched via `WHERE id IN (...)`. The
 * earlier `sourceRefExists`-per-ref pattern was N round-trips per
 * approval which compounded badly on bundle-rich candidates.
 */
function missingSourceRefs(
  refs: ReadonlyArray<ReturnType<typeof parseSourceRefsWithRawCount>['refs'][number]>,
  scope: ProjectScope,
): Array<ReturnType<typeof parseSourceRefsWithRawCount>['refs'][number]> {
  if (refs.length === 0) return [];
  const byType = new Map<string, string[]>();
  for (const ref of refs) {
    const ids = byType.get(ref.type) ?? [];
    ids.push(ref.id);
    byType.set(ref.type, ids);
  }
  const present = new Map<string, Set<string>>();
  for (const [type, ids] of byType) {
    present.set(type, presentIdsForType(type, ids, scope));
  }
  return refs.filter((ref) => !(present.get(ref.type)?.has(ref.id) ?? false));
}

const SOURCE_REF_TABLE_BY_TYPE: Record<string, string> = {
  spore: 'spores',
  session: 'sessions',
  plan: 'plans',
  artifact: 'artifacts',
};

function presentIdsForType(type: string, ids: string[], scope: ProjectScope): Set<string> {
  const table = SOURCE_REF_TABLE_BY_TYPE[type];
  if (!table || ids.length === 0) return new Set();
  const clause = projectScopeClause(scope);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDatabase()
    .prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders})${clause.sql}`)
    .all(...ids, ...clause.params) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}
