export type CandidateSourceType = 'spore' | 'session' | 'plan' | 'artifact';

export interface CandidateSourceRef {
  id: string;
  type: CandidateSourceType;
}

const SOURCE_TYPES = new Set<CandidateSourceType>(['spore', 'session', 'plan', 'artifact']);

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

export function validateSkillCandidateQualityContract(
  candidate: CandidateQualityContractRow,
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
  }

  return issues;
}

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

export function parseSourceRefsWithRawCount(
  value: unknown,
): { refs: CandidateSourceRef[]; rawCount: number | null } {
  const raw = readJsonArray(value);
  if (raw === null) return { refs: [], rawCount: null };
  return { refs: normalizeSourceRefs(raw), rawCount: raw.length };
}

export function parseSourceRefs(value: unknown): CandidateSourceRef[] {
  return parseSourceRefsWithRawCount(value).refs;
}

function readJsonArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeSourceRefs(value: unknown): CandidateSourceRef[] {
  if (!Array.isArray(value)) return [];

  const refs: CandidateSourceRef[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const ref = sourceRefFromEntry(entry);
    if (!ref) continue;
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function sourceRefFromEntry(entry: unknown): CandidateSourceRef | null {
  if (typeof entry === 'string') {
    const id = cleanId(entry);
    const type = inferSourceType(id);
    return type ? { id, type } : null;
  }

  if (!isRecord(entry)) return null;
  const id = cleanId(entry.id);
  if (!id || typeof entry.type !== 'string') return null;
  if (!SOURCE_TYPES.has(entry.type as CandidateSourceType)) return null;
  return { id, type: entry.type as CandidateSourceType };
}

function inferSourceType(id: string): CandidateSourceType | null {
  if (/^spore-/i.test(id)) return 'spore';
  if (/^(?:session-|sess-)/i.test(id)) return 'session';
  if (/^plan-/i.test(id)) return 'plan';
  if (/^artifact-/i.test(id)) return 'artifact';
  return null;
}


function cleanId(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
