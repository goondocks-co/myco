/**
 * Canonical string values for skill_candidates.status.
 *
 * The skill lifecycle uses four states:
 *   - identified: discovered by skill-survey, awaiting human review
 *   - approved:   human approved; queued for skill-generate
 *   - generated:  vault_finalize_skill promoted the staged skill to live
 *   - dismissed:  retired (human or agent)
 *
 * See docs/superpowers/plans/2026-04-08-skill-lifecycle-audit-and-staging.md
 * for the lifecycle transitions and who is allowed to make each one.
 */
export const CANDIDATE_STATUS = {
  IDENTIFIED: 'identified',
  APPROVED: 'approved',
  GENERATED: 'generated',
  DISMISSED: 'dismissed',
} as const;

export type SkillCandidateStatus = (typeof CANDIDATE_STATUS)[keyof typeof CANDIDATE_STATUS];

/**
 * Statuses the agent-facing vault_skill_candidates tool is allowed to set
 * on an update. Human-only transitions (approved) and internal-only
 * transitions (generated, via vault_finalize_skill) are excluded.
 */
export const AGENT_SETTABLE_STATUSES: readonly SkillCandidateStatus[] = [
  CANDIDATE_STATUS.IDENTIFIED,
  CANDIDATE_STATUS.DISMISSED,
];

/**
 * Statuses REST callers (UI + MCP myco_skill_candidates) are allowed to
 * set. 'generated' is internal — only vault_finalize_skill sets it, and
 * that path calls updateCandidate directly rather than going through REST.
 */
export const REST_SETTABLE_STATUSES: readonly SkillCandidateStatus[] = [
  CANDIDATE_STATUS.IDENTIFIED,
  CANDIDATE_STATUS.APPROVED,
  CANDIDATE_STATUS.DISMISSED,
];

/**
 * Composite UI filter value that the REST handler translates into a
 * multi-status query (`status IN ('approved', 'generated')`). Kept here
 * so the UI and backend share a single source of truth for the wire
 * encoding.
 */
export const PIPELINE_FILTER_VALUE = `${CANDIDATE_STATUS.APPROVED},${CANDIDATE_STATUS.GENERATED}`;
