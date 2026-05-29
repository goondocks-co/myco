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
 * Returns the subset of `refs` whose target vault record does not exist under
 * `scope`. One DB round-trip per source TYPE (spore / session / plan /
 * artifact). A ref resolves when a stored id equals it OR begins with it —
 * source refs are frequently recorded in Myco's 8-char short-id form (the
 * display/reference format used everywhere else), while the tables store full
 * ids. An exact-only `id IN (...)` match silently reported short-id refs as
 * "missing" and 400'd otherwise-valid candidate approvals.
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
  const resolved = new Map<string, Set<string>>();
  for (const [type, ids] of byType) {
    resolved.set(type, resolvedRefIdsForType(type, ids, scope));
  }
  return refs.filter((ref) => !(resolved.get(ref.type)?.has(ref.id) ?? false));
}

const SOURCE_REF_TABLE_BY_TYPE: Record<string, string> = {
  spore: 'spores',
  session: 'sessions',
  plan: 'plans',
  artifact: 'artifacts',
};

/**
 * Of the given `refIds`, return those that resolve to a stored record under
 * `scope` — by exact id OR by prefix (a short id is a prefix of the full
 * stored id). Uses `substr(id, 1, length(ref)) = ref` rather than `LIKE` to
 * sidestep wildcard characters in ids; the JS pass re-confirms the prefix.
 */
function resolvedRefIdsForType(type: string, refIds: string[], scope: ProjectScope): Set<string> {
  const table = SOURCE_REF_TABLE_BY_TYPE[type];
  if (!table || refIds.length === 0) return new Set();
  const clause = projectScopeClause(scope);
  const conds = refIds.map(() => '(id = ? OR substr(id, 1, ?) = ?)').join(' OR ');
  const params: Array<string | number> = [];
  for (const id of refIds) params.push(id, id.length, id);
  const rows = getDatabase()
    .prepare(`SELECT id FROM ${table} WHERE (${conds})${clause.sql}`)
    .all(...params, ...clause.params) as Array<{ id: string }>;
  const storedIds = rows.map((row) => row.id);
  const resolved = new Set<string>();
  for (const ref of refIds) {
    if (storedIds.some((stored) => stored === ref || stored.startsWith(ref))) {
      resolved.add(ref);
    }
  }
  return resolved;
}
