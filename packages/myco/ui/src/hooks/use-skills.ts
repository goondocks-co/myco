import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, putJson, postJson, deleteJson } from '../lib/api';

/* ---------- Types ---------- */

export interface SkillCandidate {
  id: string;
  agent_id: string;
  topic: string;
  rationale: string;
  confidence: number;
  status: string;
  source_ids: string; // JSON-encoded string
  skill_id: string | null;
  /**
   * Epoch seconds of the first transition into status='approved'.
   * Null for candidates that have never been approved. Auto-set by
   * the backend and never overwritten. Drives the "Approved Xd ago"
   * card badge and the combined "pending + generated" filter view.
   */
  approved_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SkillRecord {
  id: string;
  name: string;
  display_name: string;
  description: string;
  status: string;
  generation: number;
  candidate_id: string | null;
  source_ids: string;
  path: string | null;
  usage_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  properties: string | null;
}

export interface SkillLineageEntry {
  id: string;
  skill_id: string;
  generation: number;
  action: string;
  rationale: string;
  source_ids_added: string | null;
  content_snapshot: string | null;
  created_at: number;
}

export interface SkillRecordDetail extends SkillRecord {
  lineage: SkillLineageEntry[];
  usage_total: number;
  frontmatter?: Record<string, string>;
}

export interface CandidateListResponse {
  candidates: SkillCandidate[];
  total: number;
}

export interface SkillRecordListResponse {
  records: SkillRecord[];
  total: number;
}

/* ---------- Hooks ---------- */

export function useSkillCandidates(filters?: {
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters?.offset !== undefined) params.set('offset', String(filters.offset));
  const qs = params.toString();
  const path = qs ? `/skill-candidates?${qs}` : '/skill-candidates';

  return useQuery<CandidateListResponse>({
    queryKey: ['skill-candidates', filters],
    queryFn: ({ signal }) => fetchJson<CandidateListResponse>(path, { signal }),
  });
}

export function useUpdateCandidate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; [key: string]: unknown }) =>
      putJson<SkillCandidate>(`/skill-candidates/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skill-candidates'] });
    },
  });
}

export function useSkillRecords(filters?: {
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters?.offset !== undefined) params.set('offset', String(filters.offset));
  const qs = params.toString();
  const path = qs ? `/skill-records?${qs}` : '/skill-records';

  return useQuery<SkillRecordListResponse>({
    queryKey: ['skill-records', filters],
    queryFn: ({ signal }) => fetchJson<SkillRecordListResponse>(path, { signal }),
  });
}

export function useSkillRecord(idOrName: string | undefined) {
  return useQuery<SkillRecordDetail>({
    queryKey: ['skill-record', idOrName],
    queryFn: ({ signal }) =>
      fetchJson<SkillRecordDetail>(`/skill-records/${idOrName}`, { signal }),
    enabled: !!idOrName,
  });
}

export function useTriggerAgentRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ task, instruction }: { task: string; instruction: string }) =>
      postJson<{ ok: boolean }>('/agent/run', { task, instruction }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skill-candidates'] });
      queryClient.invalidateQueries({ queryKey: ['skill-records'] });
    },
  });
}

export function useDeleteSkillRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (idOrName: string) =>
      deleteJson<{ deleted: boolean; id: string; name: string }>(`/skill-records/${encodeURIComponent(idOrName)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skill-records'] });
      qc.invalidateQueries({ queryKey: ['skill-record'] });
    },
  });
}
