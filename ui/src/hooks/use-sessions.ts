import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, deleteJson } from '../lib/api';
import { usePowerQuery } from './use-power-query';
import { POLL_INTERVALS } from '../lib/constants';

/* ---------- Constants ---------- */

/** Poll interval for session list. */
const SESSIONS_POLL_INTERVAL = POLL_INTERVALS.STATS;

/** Poll interval for session detail. */
const SESSION_DETAIL_POLL_INTERVAL = POLL_INTERVALS.STATS;

/** Poll interval for batch list. */
const BATCHES_POLL_INTERVAL = POLL_INTERVALS.STATS;

/** Cache TTL for activities list (30 seconds). */
const ACTIVITIES_STALE_TIME = 30_000;

/** Cache TTL for attachments (60 seconds — rarely changes). */
const ATTACHMENTS_STALE_TIME = 60_000;

/** Cache TTL for session impact counts (10 seconds — stable between dialog opens). */
const IMPACT_STALE_TIME = 10_000;

/* ---------- Types ---------- */

/** Simplified shape returned by the list endpoint. */
export interface SessionSummary {
  id: string;
  date: string;
  title: string;
  status: string;
  agent: string;
  prompt_count: number;
  tool_count: number;
  started_at: number;
  ended_at: number | null;
}

/** Full session row returned by the detail endpoint. */
export interface SessionDetail {
  id: string;
  agent: string;
  user: string | null;
  project_root: string | null;
  branch: string | null;
  started_at: number;
  ended_at: number | null;
  status: string;
  prompt_count: number;
  tool_count: number;
  title: string | null;
  summary: string | null;
  transcript_path: string | null;
  parent_session_id: string | null;
  parent_session_reason: string | null;
  processed: number;
  content_hash: string | null;
  created_at: number;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface BatchRow {
  id: number;
  session_id: string;
  prompt_number: number | null;
  user_prompt: string | null;
  response_summary: string | null;
  classification: string | null;
  started_at: number | null;
  ended_at: number | null;
  status: string;
  activity_count: number;
  processed: number;
  content_hash: string | null;
  created_at: number;
}

export interface ActivityRow {
  id: number;
  session_id: string;
  prompt_batch_id: number | null;
  tool_name: string;
  tool_input: string | null;
  tool_output_summary: string | null;
  file_path: string | null;
  files_affected: string | null;
  duration_ms: number | null;
  success: number;
  error_message: string | null;
  timestamp: number;
  processed: number;
  content_hash: string | null;
  created_at: number;
}

export interface AttachmentRow {
  id: string;
  session_id: string;
  prompt_batch_id: number | null;
  file_path: string;
  media_type: string | null;
  description: string | null;
  created_at: number;
}

/** Cascade impact counts for a session delete. */
export interface SessionImpact {
  promptCount: number;
  sporeCount: number;
  attachmentCount: number;
  graphEdgeCount: number;
}

/* ---------- Hooks ---------- */

export function useSessions(filters?: {
  status?: string;
  agent?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.agent) params.set('agent', filters.agent);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters?.offset !== undefined) params.set('offset', String(filters.offset));
  const qs = params.toString();
  const path = qs ? `/sessions?${qs}` : '/sessions';

  return usePowerQuery<SessionsResponse>({
    queryKey: ['sessions', filters],
    queryFn: ({ signal }) => fetchJson<SessionsResponse>(path, { signal }),
    pollCategory: 'standard',
    refetchInterval: SESSIONS_POLL_INTERVAL,
  });
}

export function useSession(id: string | undefined) {
  return usePowerQuery<SessionDetail>({
    queryKey: ['session', id],
    queryFn: ({ signal }) => fetchJson<SessionDetail>(`/sessions/${id}`, { signal }),
    enabled: id !== undefined,
    pollCategory: 'standard',
    refetchInterval: SESSION_DETAIL_POLL_INTERVAL,
  });
}

export function useSessionBatches(sessionId: string | undefined) {
  return usePowerQuery<BatchRow[]>({
    queryKey: ['session-batches', sessionId],
    queryFn: ({ signal }) =>
      fetchJson<BatchRow[]>(`/sessions/${sessionId}/batches`, { signal }),
    enabled: sessionId !== undefined,
    pollCategory: 'standard',
    refetchInterval: BATCHES_POLL_INTERVAL,
  });
}

export function useBatchActivities(batchId: number | undefined) {
  return useQuery<ActivityRow[]>({
    queryKey: ['batch-activities', batchId],
    queryFn: ({ signal }) =>
      fetchJson<ActivityRow[]>(`/batches/${batchId}/activities`, { signal }),
    enabled: batchId !== undefined,
    staleTime: ACTIVITIES_STALE_TIME,
  });
}

export function useSessionAttachments(sessionId: string | undefined) {
  return useQuery<AttachmentRow[]>({
    queryKey: ['session-attachments', sessionId],
    queryFn: ({ signal }) =>
      fetchJson<AttachmentRow[]>(`/sessions/${sessionId}/attachments`, { signal }),
    enabled: sessionId !== undefined,
    staleTime: ATTACHMENTS_STALE_TIME,
  });
}

export function useDeleteSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      deleteJson<{ ok: boolean; counts: Record<string, number> }>(`/sessions/${sessionId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useSessionImpact(sessionId: string | null) {
  return useQuery<SessionImpact>({
    queryKey: ['session-impact', sessionId],
    queryFn: ({ signal }) => fetchJson<SessionImpact>(`/sessions/${sessionId}/impact`, { signal }),
    enabled: sessionId !== null,
    staleTime: IMPACT_STALE_TIME,
  });
}
