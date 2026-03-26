import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, deleteJson } from '../lib/api';

/* ---------- Constants ---------- */

/** Cache TTL for session list (10 seconds). */
const SESSIONS_STALE_TIME = 10_000;

/** Cache TTL for session detail (30 seconds). */
const SESSION_DETAIL_STALE_TIME = 30_000;

/** Cache TTL for batch list (30 seconds). */
const BATCHES_STALE_TIME = 30_000;

/** Cache TTL for activities list (30 seconds). */
const ACTIVITIES_STALE_TIME = 30_000;

/** Cache TTL for attachments (60 seconds — rarely changes). */
const ATTACHMENTS_STALE_TIME = 60_000;

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

/* ---------- Hooks ---------- */

export function useSessions(filters?: { status?: string; limit?: number }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.limit !== undefined) params.set('limit', String(filters.limit));
  const qs = params.toString();
  const path = qs ? `/sessions?${qs}` : '/sessions';

  return useQuery<SessionsResponse>({
    queryKey: ['sessions', filters],
    queryFn: ({ signal }) => fetchJson<SessionsResponse>(path, { signal }),
    staleTime: SESSIONS_STALE_TIME,
  });
}

export function useSession(id: string | undefined) {
  return useQuery<SessionDetail>({
    queryKey: ['session', id],
    queryFn: ({ signal }) => fetchJson<SessionDetail>(`/sessions/${id}`, { signal }),
    enabled: id !== undefined,
    staleTime: SESSION_DETAIL_STALE_TIME,
  });
}

export function useSessionBatches(sessionId: string | undefined) {
  return useQuery<BatchRow[]>({
    queryKey: ['session-batches', sessionId],
    queryFn: ({ signal }) =>
      fetchJson<BatchRow[]>(`/sessions/${sessionId}/batches`, { signal }),
    enabled: sessionId !== undefined,
    staleTime: BATCHES_STALE_TIME,
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
    mutationFn: (sessionId: string) => deleteJson(`/sessions/${sessionId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
