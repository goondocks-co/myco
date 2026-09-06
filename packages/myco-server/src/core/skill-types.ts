export const CANDIDATE_STATUSES = ['identified', 'approved', 'deferred', 'dismissed', 'generated'] as const;
export const CANDIDATE_REVIEW_STATUSES = ['approved', 'deferred', 'dismissed', 'identified'] as const;
export type CandidateReviewStatus = (typeof CANDIDATE_REVIEW_STATUSES)[number];

export interface SkillCandidate {
  id: string; agentId: string; topic: string; rationale: string; confidence: number;
  status: (typeof CANDIDATE_STATUSES)[number]; sourceIds: string; skillId: string | null;
  supersedes: string | null; evidenceBundleId: string | null; qualityScore: number | null;
  qualityFailures: string; coverageMatches: string; lastReconciledAt: number | null;
  reconciliationReason: string | null; createdAt: number; updatedAt: number; approvedAt: number | null;
  revision: number; reviewedAt: number | null; reviewedBy: string | null; approvedBy: string | null;
}
