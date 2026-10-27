export interface CoverageIdentity {
  id: string;
  claim: string | null;
  key: string | null;
  thread: string | null;
  record: string | null;
  scheme: string;
  shape?: 'queued' | 'stamped';
}
export const COVERAGE_CANDIDATE_RULES = [
  { fields: ['claim', 'key', 'thread', 'record'] },
  { schemes: ['claude-v1', 'claude-v2'], shape: 'queued' },
  { schemes: ['stamp-or-offset-v1', 'stamp-or-offset-v2'], shape: 'stamped' },
] as const;
type CoverageSql = Record<keyof Required<CoverageIdentity>, string>;
const completeFields = COVERAGE_CANDIDATE_RULES[0].fields;

export function coverageCandidateSql(row: CoverageSql): string {
  return COVERAGE_CANDIDATE_RULES.map((rule) =>
    'fields' in rule
      ? rule.fields.map((field) => `${row[field]} IS NOT NULL`).join(' AND ')
      : `${row.scheme} IN (${rule.schemes.map((scheme) => `'${scheme}'`).join(',')}) AND ${row.shape}='${rule.shape}'`,
  )
    .map((sql) => `(${sql})`)
    .join(' OR ');
}

/** The transactional carry predicate uses the same source fields and scheme rules as metadata carry. */
export function carriesCoverageSql(legacy: CoverageSql, current: CoverageSql): string {
  const complete = completeFields.map((field) => `${legacy[field]} IS NOT NULL`).join(' AND ');
  const equal = completeFields.map((field) => `${legacy[field]} IS ${current[field]}`).join(' AND ');
  return `((${complete}) AND (${equal}) OR NOT (${complete}) AND (${coverageCandidateSql(legacy)})
    AND ${legacy.id}=${current.id} AND ${legacy.shape} IS ${current.shape})`;
}

/** Legacy identity can bound possible carry without reading transcript bodies. */
export function coverageCandidate(row: CoverageIdentity): boolean {
  return COVERAGE_CANDIDATE_RULES.some((rule) =>
    'fields' in rule
      ? rule.fields.every((field) => row[field] !== null)
      : rule.schemes.some((scheme) => scheme === row.scheme) && row.shape === rule.shape,
  );
}

/** Only complete source identity or a record-naming scheme proves a counterpart. */
export function carriesCoverage(legacy: CoverageIdentity, current: CoverageIdentity): boolean {
  if (completeFields.every((field) => legacy[field] !== null))
    return completeFields.every((field) => legacy[field] === current[field]);
  return coverageCandidate(legacy) && legacy.id === current.id && legacy.shape === current.shape;
}
