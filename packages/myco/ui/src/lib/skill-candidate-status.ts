/**
 * Canonical string values for skill_candidates.status — UI mirror of
 * src/constants/skill-candidate-status.ts. Kept as a separate file
 * because the UI is a distinct TypeScript project with no path alias
 * into the backend's src tree.
 *
 * MUST stay in sync with src/constants/skill-candidate-status.ts.
 * A smoke test asserts the two files agree so drift is caught at CI time.
 */
export const CANDIDATE_STATUS = {
  IDENTIFIED: 'identified',
  APPROVED: 'approved',
  GENERATED: 'generated',
  DISMISSED: 'dismissed',
} as const;

export type SkillCandidateStatus = (typeof CANDIDATE_STATUS)[keyof typeof CANDIDATE_STATUS];

/**
 * Composite UI filter value that the REST handler translates into a
 * multi-status query. Same wire encoding used on the backend.
 */
export const PIPELINE_FILTER_VALUE = `${CANDIDATE_STATUS.APPROVED},${CANDIDATE_STATUS.GENERATED}`;
