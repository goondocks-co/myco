import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, patchJson } from '../lib/api';
import type { CandidateReviewStatus, SkillCandidate } from '../../../src/core/skill-types';

export type { CandidateReviewStatus, SkillCandidate };
export const CANDIDATE_PAGE_SIZE = 50;

const path = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/skill-candidates`;

export function useSkillCandidates(projectId: string, status: SkillCandidate['status'], offset: number) {
  return useQuery({ queryKey: ['skill-candidates', projectId, status, offset],
    queryFn: ({ signal }) => fetchJson<{ candidates: SkillCandidate[]; hasMore: boolean }>(
      `${path(projectId)}?status=${status}&limit=${CANDIDATE_PAGE_SIZE}&offset=${offset}`, signal) });
}

export function useReviewCandidate(projectId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: { id: string; revision: number; status: CandidateReviewStatus }) =>
    patchJson<{ reviewed: boolean; candidate: SkillCandidate; warnings?: string[] }>(`${path(projectId)}/${encodeURIComponent(input.id)}`, { revision: input.revision, status: input.status }),
    onSettled: () => client.invalidateQueries({ queryKey: ['skill-candidates', projectId] }) });
}
