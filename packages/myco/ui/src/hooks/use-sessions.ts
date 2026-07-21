import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, deleteJson, patchJson, postJson } from '../lib/api';
import { usePowerQuery } from './use-power-query';
import { POLL_INTERVALS } from '../lib/constants';
import { isAttachedTenancyPending, resolveAttachedEmpty } from '../lib/degrade';
import { useProjectScopedQueryKey, useProjectSelection } from './use-project-selection';

/* ---------- Constants ---------- */

/** Poll interval for session list. */
const SESSIONS_POLL_INTERVAL = POLL_INTERVALS.SESSIONS;

/** Poll interval for session detail. */
const SESSION_DETAIL_POLL_INTERVAL = POLL_INTERVALS.SESSION_DETAIL;

/** Poll interval for batch list. */
const BATCHES_POLL_INTERVAL = POLL_INTERVALS.SESSION_DETAIL;

/** Cache TTL for activities list (30 seconds). */
const ACTIVITIES_STALE_TIME = 30_000;

/** Cache TTL for attachments (60 seconds — rarely changes). */
const ATTACHMENTS_STALE_TIME = 60_000;

/** Cache TTL for session impact counts (10 seconds — stable between dialog opens). */
const IMPACT_STALE_TIME = 10_000;

/** Poll interval for session plans. */
const PLANS_POLL_INTERVAL = POLL_INTERVALS.SESSION_DETAIL;

/* ---------- Types ---------- */

export interface SessionReleaseState {
  state: string;
  confidence?: string | null;
  basis_kind?: string | null;
  basis_ref?: string | null;
  checked_at?: number;
  reason?: string | null;
}

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
  release_state?: SessionReleaseState;
  /**
   * Lifetime activity distribution for the rail chart — prompt_batch counts
   * bucketed across the session duration, oldest bucket first.
   */
  activity_buckets: number[];
  /** Git branch captured for this session, or null when no provenance was recorded. */
  branch: string | null;
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
  release_state?: SessionReleaseState;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
  total: number;
  offset: number;
  limit: number;
}

/** Empty session list — the zero-state an attached project shows pre-first-capture. */
const EMPTY_SESSIONS: SessionsResponse = { sessions: [], total: 0, offset: 0, limit: 0 };

export type PromptBatchOrigin = 'human' | 'system' | 'agent_dispatch' | 'hook_injected';

export interface BatchRow {
  id: string;
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
  parent_prompt_batch_id: string | null;
  kind: string;
  origin: PromptBatchOrigin;
  /** Sub-agent thread identity (see `prompt_batches.thread_id`); null for main-thread batches. */
  thread_id: string | null;
  /** Human-readable sub-agent thread label (e.g. a Codex reviewer's name); null for main-thread batches. */
  thread_label: string | null;
  release_state?: SessionReleaseState;
}

export interface ActivityRow {
  id: number;
  session_id: string;
  prompt_batch_id: string | null;
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
  canopy_injection_tokens: number | null;
  /** Canonical Myco tool identity (resolved at capture), or null for non-Myco. */
  myco_tool: string | null;
  myco_op: string | null;
}

export interface AttachmentRow {
  id: string;
  session_id: string;
  prompt_batch_id: string | null;
  file_path: string;
  media_type: string | null;
  description: string | null;
  /**
   * Turn number parsed from the storage filename convention
   * (`{sessionShort}-t{promptNumber}-{n}.{ext}`) server-side. Use this as a
   * fallback grouping key when `prompt_batch_id` is null.
   */
  turn_number: number | null;
  created_at: number;
}

export interface SessionPlanRow {
  id: string;
  status: string;
  title: string | null;
  content: string | null;
  source_path: string | null;
  content_hash: string | null;
  session_id: string | null;
  created_at: number;
  updated_at: number | null;
}

export interface PlanStatusUpdateResult {
  ok: boolean;
  id: string;
  status: string;
  session_id: string | null;
  updated_at: number | null;
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
  hasPlan?: boolean;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.agent) params.set('agent', filters.agent);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.hasPlan) params.set('has_plan', 'true');
  if (filters?.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters?.offset !== undefined) params.set('offset', String(filters.offset));
  const qs = params.toString();
  const path = qs ? `/sessions?${qs}` : '/sessions';
  const selection = useProjectSelection();

  return resolveAttachedEmpty(
    usePowerQuery<SessionsResponse>({
      queryKey: ['sessions', filters],
      queryFn: ({ signal }) => fetchJson<SessionsResponse>(path, { signal }),
      pollCategory: 'standard',
      refetchInterval: (query) =>
        isAttachedTenancyPending(query.state.error, selection) ? false : SESSIONS_POLL_INTERVAL,
      retry: (failureCount, err) =>
        isAttachedTenancyPending(err, selection) ? false : failureCount < 3,
    }),
    selection,
    EMPTY_SESSIONS,
  );
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

/**
 * Fetch the prompt batches for a session.
 *
 * `origins` filters which batches are included. Default `['human']` hides
 * system-injected and agent-dispatched batches (e.g. <task-notification>,
 * <subagent_notification>, <skill> envelope expansions) from the main
 * Sessions view, leaving only user-typed prompts.
 *
 * Pass `'all'` to include every batch — useful for the developer drawer
 * or operator views where the full transcript shape matters.
 */
export function useSessionBatches(
  sessionId: string | undefined,
  origins: readonly PromptBatchOrigin[] | 'all' = ['human'],
) {
  const query = origins === 'all' ? '' : `?origins=${origins.join(',')}`;
  return usePowerQuery<BatchRow[]>({
    queryKey: ['session-batches', sessionId, origins === 'all' ? 'all' : [...origins].sort().join(',')],
    queryFn: ({ signal }) =>
      fetchJson<BatchRow[]>(`/sessions/${sessionId}/batches${query}`, { signal }),
    enabled: sessionId !== undefined,
    pollCategory: 'standard',
    refetchInterval: BATCHES_POLL_INTERVAL,
  });
}

export function useBatchActivities(batchId: string | undefined) {
  const queryKey = useProjectScopedQueryKey(['batch-activities', batchId]);
  return useQuery<ActivityRow[]>({
    queryKey,
    queryFn: ({ signal }) =>
      fetchJson<ActivityRow[]>(`/batches/${batchId}/activities`, { signal }),
    enabled: batchId !== undefined,
    staleTime: ACTIVITIES_STALE_TIME,
  });
}

export function useSessionAttachments(sessionId: string | undefined) {
  const queryKey = useProjectScopedQueryKey(['session-attachments', sessionId]);
  return useQuery<AttachmentRow[]>({
    queryKey,
    queryFn: ({ signal }) =>
      fetchJson<AttachmentRow[]>(`/sessions/${sessionId}/attachments`, { signal }),
    enabled: sessionId !== undefined,
    staleTime: ATTACHMENTS_STALE_TIME,
  });
}

export function useDeleteSession() {
  const queryClient = useQueryClient();
  return useMutation({
    // `force: true` overrides the daemon's live-session refusal (409
    // `session_live`) — callers re-send it from a second-stage confirm.
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      deleteJson<{ ok: boolean; counts: Record<string, number> }>(
        `/sessions/${id}`,
        force ? { force: true } : undefined,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useCompleteSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      postJson<{ ok: boolean; was_active: boolean }>(`/sessions/${sessionId}/complete`),
    onSuccess: (_data, sessionId) => {
      queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useSessionImpact(sessionId: string | null) {
  const queryKey = useProjectScopedQueryKey(['session-impact', sessionId]);
  return useQuery<SessionImpact>({
    queryKey,
    queryFn: ({ signal }) => fetchJson<SessionImpact>(`/sessions/${sessionId}/impact`, { signal }),
    enabled: sessionId !== null,
    staleTime: IMPACT_STALE_TIME,
  });
}

export function useSessionPlans(sessionId: string | undefined) {
  return usePowerQuery<SessionPlanRow[]>({
    queryKey: ['session-plans', sessionId],
    queryFn: async ({ signal }) => {
      const response = await fetchJson<{ plans: SessionPlanRow[] }>(
        `/sessions/${sessionId}/plans`,
        { signal },
      );
      return response.plans;
    },
    enabled: !!sessionId,
    pollCategory: 'standard',
    refetchInterval: PLANS_POLL_INTERVAL,
  });
}

export function useDeletePlan(sessionId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) =>
      deleteJson<{ ok: boolean; id: string; session_id: string | null }>(`/plans/${planId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session-plans', sessionId] });
    },
  });
}

export function useUpdatePlanStatus(sessionId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ planId, status }: { planId: string; status: string }) =>
      patchJson<PlanStatusUpdateResult>(`/plans/${planId}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session-plans', sessionId] });
    },
  });
}
