import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { usePowerQuery } from './use-power-query';
import { fetchJson, postJson, putJson, deleteJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';
import { isAttachedTenancyPending, resolveAttachedEmpty } from '../lib/degrade';
import { projectScopedQueryKey, useProjectScopedQueryKey, useProjectSelection } from './use-project-selection';
import type { PhaseAudit } from '@myco/services/phase-audit';
import type { WriteIntentRow } from '@myco/db/queries/write-intents';
import type { DigestExtractRevisionRow } from '@myco/db/queries/digest-extracts';
import type { HarnessId, ReasoningLevel } from '@myco/agent/types';
import type { CapabilityId } from '@myco/config/scope';

/* ---------- Re-exported backend types ---------- */

export type { PhaseAudit, PhaseAuditEntry } from '@myco/services/phase-audit';
export type { WriteIntentRow } from '@myco/db/queries/write-intents';
export type DigestRevisionRow = DigestExtractRevisionRow;

/* ---------- Constants ---------- */

/** Poll interval for agent run list. */
const RUNS_POLL_INTERVAL = POLL_INTERVALS.RUNS_ACTIVE;

/** Poll interval for a single run detail (faster — watching active run). */
const RUN_DETAIL_POLL_INTERVAL = POLL_INTERVALS.RUN_DETAIL;

/** Poll interval for run reports (moderate — updates during execution). */
const REPORTS_POLL_INTERVAL = POLL_INTERVALS.STATS;

/** Run statuses that indicate the run is finished — stop polling. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'skipped']);

/** Poll interval for audit trail turns. */
const TURNS_POLL_INTERVAL = POLL_INTERVALS.STATS;

/** Poll interval for the run events stream (matches other live run-detail surfaces). */
const RUN_EVENTS_POLL_INTERVAL = POLL_INTERVALS.RUN_DETAIL;

/**
 * Server-side page size for `GET /agent/runs/:id/events` (mirrors
 * `AGENT_RUN_EVENTS_LIMIT` in `daemon/api/agent-runs.ts`). A response at
 * exactly this count means more rows may be waiting past the cursor.
 */
const RUN_EVENTS_PAGE_LIMIT = 1000;

/** Cache TTL for available task definitions (60 seconds — rarely changes). */
const TASKS_STALE_TIME = 60_000;

/** Default limit for run list queries. */
const DEFAULT_RUNS_LIMIT = 50;

/* ---------- Types ---------- */

export interface RunRow {
  id: string;
  agent_id: string;
  task: string | null;
  instruction: string | null;
  status: string;
  harness: string | null;
  provider: string | null;
  model: string | null;
  session_ref: string | null;
  resumable: boolean;
  resume_status: string | null;
  resume_mode: string | null;
  resumed_at: number | null;
  checkpoints: string | null;
  usage_data: string | null;
  started_at: number | null;
  completed_at: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  actual_cost_usd: number | null;
  estimated_cost_usd: number | null;
  cost_source: 'actual' | 'estimated' | 'unavailable' | null;
  cost_data: string | null;
  actions_taken: string | null;
  error: string | null;
  /** True when the run was executed in dry-run mode (no writes committed). */
  dry_run?: boolean;
  /** Parent evaluation id when this run is part of an evaluation matrix. */
  evaluation_id?: string | null;
  /**
   * Reasoning level the run actually used. Serialized from
   * `agent_runs.reasoning_level`. Null when the run inherited the task default.
   */
  reasoning_level?: ReasoningLevel | null;
  /**
   * Parsed `executionOverrides` packet (harness / reasoning / model / provider
   * / phases) the run was started with. Null when the run used task defaults
   * verbatim. Shape mirrors the server's serialized payload (camelCase on the
   * wire) — used by the "Rerun with same settings" flow to pre-fill the
   * RunTaskDialog from a source run.
   */
  execution_overrides?: {
    harness?: string;
    reasoningLevel?: string;
    model?: string;
    provider?: {
      type: 'anthropic' | 'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'openai-compatible';
      localBackend?: 'ollama' | 'lmstudio';
      baseUrl?: string;
      model?: string;
      reasoningMap?: Partial<Record<ReasoningLevel, string>>;
      contextLength?: number;
    };
    phases?: Record<string, {
      reasoningLevel?: string;
      model?: string;
      provider?: {
        type: 'anthropic' | 'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'openai-compatible';
        localBackend?: 'ollama' | 'lmstudio';
        baseUrl?: string;
        model?: string;
        reasoningMap?: Partial<Record<ReasoningLevel, string>>;
        contextLength?: number;
      };
      maxTurns?: number;
    }>;
  } | null;
  phase_checkpoints?: Array<{
    name: string;
    status: string;
    updatedAt: number;
    tokensUsed?: number;
    costUsd?: number;
    costSource?: 'actual' | 'estimated' | 'unavailable';
  }>;
  /**
   * Lifetime activity distribution for the rail chart — `agent_turns`
   * bucketed across the run duration, oldest bucket first. Optional because
   * legacy/serialized rows may omit it.
   */
  activity_buckets?: number[];
  /**
   * Git branch resolved from the run's session via the most recent
   * release-provenance capture. Null when no provenance was recorded for
   * the linked session, or when the run has no session_ref. Optional —
   * MCP / legacy serializers may omit the field entirely.
   */
  branch?: string | null;
}

export interface RunsResponse {
  runs: RunRow[];
  total: number;
  offset: number;
  limit: number;
}

/** Empty agent-run list — the zero-state an attached project shows pre-first-capture. */
const EMPTY_RUNS: RunsResponse = { runs: [], total: 0, offset: 0, limit: 0 };

/**
 * Run shape returned by `GET /agent/runs/:id` — a strict superset of
 * `RunRow` that always includes the `write_intents` and `duration_ms`
 * fields. The backend serializer populates both for single detail fetches
 * (see `run-serializer.ts`), so consumers reading from this endpoint can
 * rely on their presence. Matches `RunCompareSummary` on the overlapping
 * fields so `useRunsByIds` can reuse the shared comparison component.
 */
export interface SerializedRunDetail extends RunRow {
  write_intents: WriteIntentsSummary;
  duration_ms: number | null;
}

export interface RunDetailResponse {
  run: SerializedRunDetail;
}

export interface ReportRow {
  id: number;
  run_id: string;
  agent_id: string;
  action: string;
  summary: string;
  details: string | null;
  created_at: number;
}

export interface ReportsResponse {
  reports: ReportRow[];
}

export interface TurnRow {
  id: number;
  run_id: string;
  agent_id: string;
  turn_number: number;
  tool_name: string;
  tool_input: string | null;
  tool_output_summary: string | null;
  started_at: number | null;
  completed_at: number | null;
}

/**
 * Harness lifecycle event row (`GET /agent/runs/:id/events`). `event_type`
 * is an open TEXT column on the backend — new event kinds can appear
 * without a UI release, so consumers must render unrecognized values
 * gracefully rather than switching exhaustively over a closed set.
 */
export interface RunEventRow {
  id: number;
  run_id: string;
  phase_name: string | null;
  event_type: string;
  tool_name: string | null;
  outcome: string | null;
  duration_ms: number | null;
  payload: unknown;
  recorded_at: number;
}

/**
 * Task shape returned by the registry-backed API.
 * Uses camelCase field names matching the AgentTask interface on the backend.
 */
export interface TaskRow {
  name: string;
  displayName: string;
  description: string;
  agent: string;
  prompt: string;
  isDefault: boolean;
  source?: string;
  isBuiltin?: boolean;
  toolOverrides?: string[];
  model?: string;
  reasoningLevel?: 'low' | 'default' | 'high';
  maxTurns?: number;
  timeoutSeconds?: number;
  phases?: PhaseDefinition[];
  execution?: {
    harness?: string;
    provider?: {
      type?: string;
      model?: string;
      reasoning_map?: Partial<Record<'low' | 'default' | 'high', string>>;
    };
    model?: string;
    reasoningLevel?: 'low' | 'default' | 'high';
    maxTurns?: number;
    timeoutSeconds?: number;
  };
  contextQueries?: Record<string, unknown[]>;
  orchestrator?: { enabled: boolean; model?: string; reasoningLevel?: 'low' | 'default' | 'high'; maxTurns?: number };
  schedule?: { enabled: boolean; intervalSeconds: number; runIn: ('active' | 'idle' | 'sleep')[]; preCondition?: string };
  params?: Record<string, string | number | boolean>;
  schemaVersion?: number;
  /** The capability that governs manual dispatch of this task, or `null` when ungoverned. */
  governingCapability?: CapabilityId | null;
}

export interface TriggerRunPayload {
  task?: string;
  instruction?: string;
  /** Explicit operator run; task-specific builders may bypass scheduler gates. */
  force?: boolean;
  /** When true, writes are intercepted and recorded as write-intents. */
  dryRun?: boolean;
  /**
   * Per-run overrides that pin harness/reasoning/model (plus per-phase
   * reasoning & model) without touching the task YAML. Mirrors
   * `RunOptions.executionOverrides` in `@myco/agent/types`. Omit the field
   * entirely when nothing differs from task defaults — passing an empty
   * object still persists onto the run row.
   */
  executionOverrides?: {
    harness?: HarnessId;
    reasoningLevel?: ReasoningLevel;
    model?: string;
    /** Camel-case provider override (wire-shape, matches harness ProviderConfig). */
    provider?: {
      type: 'anthropic' | 'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'openai-compatible';
      localBackend?: 'ollama' | 'lmstudio';
      baseUrl?: string;
      model?: string;
      reasoningMap?: Partial<Record<ReasoningLevel, string>>;
      contextLength?: number;
    };
    phases?: Record<string, {
      reasoningLevel?: ReasoningLevel;
      model?: string;
      provider?: {
        type: 'anthropic' | 'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'openai-compatible';
        localBackend?: 'ollama' | 'lmstudio';
        baseUrl?: string;
        model?: string;
        reasoningMap?: Partial<Record<ReasoningLevel, string>>;
        contextLength?: number;
      };
      maxTurns?: number;
    }>;
  };
}

/* ---------- Run compare types ---------- */

/**
 * Aggregated write-intent counts for a single comparison run. `total` is the
 * sum across every tool. `by_tool` is the raw per-tool count map (safe to
 * feed into Object.entries for rendering). Non-dry-run children report
 * `{ total: 0, by_tool: {} }`.
 */
export interface WriteIntentsSummary {
  total: number;
  by_tool: Record<string, number>;
}

/**
 * Normalized run summary consumed by `ComparisonView`. Produced by
 * `useRunsByIds` from the single-run detail endpoint.
 */
export interface RunCompareSummary {
  id: string;
  agent_id: string;
  task: string | null;
  instruction: string | null;
  status: string;
  harness: string | null;
  provider: string | null;
  model: string | null;
  session_ref: string | null;
  started_at: number | null;
  completed_at: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  /**
   * Raw usage_data JSON string from agent_runs — consumers that need phase
   * breakdowns parse this on demand. Null for runs that never wrote usage.
   */
  usage_data: string | null;
  error: string | null;
  dry_run: boolean;
  /**
   * Reasoning level the run actually used. Serialized from
   * `agent_runs.reasoning_level`. Null when the run inherited the task
   * default (no override applied).
   */
  reasoning_level: ReasoningLevel | null;
  /**
   * Parsed `executionOverrides` packet (harness / reasoning / model / phases)
   * the run was started with. Null when the run used task defaults verbatim.
   */
  execution_overrides: {
    harness?: string;
    reasoningLevel?: string;
    model?: string;
    phases?: Record<string, { reasoningLevel?: string; model?: string }>;
  } | null;
  /** Per-run write-intent summary. Populated for every run (dry or not). */
  write_intents: WriteIntentsSummary;
  /**
   * Wall-clock duration of the run's current attempt in milliseconds,
   * computed server-side as `(completed_at - COALESCE(resumed_at,
   * started_at)) * 1000`. Null when either timestamp is missing (run
   * in-flight or never started).
   */
  duration_ms: number | null;
}

/* ---------- Write-intents / audit / revisions responses ---------- */

export interface WriteIntentsResponse {
  intents: WriteIntentRow[];
  count: number;
}

/** Response shape for `GET /agent/runs/:id/events` — no cursor field; the id of the last row IS the cursor. */
export interface RunEventsResponse {
  events: RunEventRow[];
  count: number;
}

export interface AuditResponse {
  audit: PhaseAudit;
}

export interface DigestRevisionsResponse {
  revisions: DigestRevisionRow[];
  count: number;
}

export interface RestoreDigestRevisionResponse {
  ok: boolean;
  restored: number;
  newRevisionId: number | null;
}

export interface TriggerRunResponse {
  ok: boolean;
  message: string;
  status?: 'running' | 'skipped';
  reason?: string;
  runId?: string;
}

export interface ResumeRunResponse {
  ok: boolean;
  message: string;
  runId?: string;
}

export interface TasksResponse {
  tasks: TaskRow[];
}

export interface TaskDetailResponse {
  task: TaskRow;
}

export interface PhaseDefinition {
  name: string;
  prompt: string;
  tools: string[];
  maxTurns: number;
  model?: string;
  reasoningLevel?: 'low' | 'default' | 'high';
  required: boolean;
}

export interface CreateTaskPayload {
  name: string;
  displayName: string;
  description: string;
  agent: string;
  prompt: string;
  isDefault: boolean;
  phases?: PhaseDefinition[];
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
}

export interface CopyTaskPayload {
  taskId: string;
  name?: string;
}

/* ---------- Hooks ---------- */

export function useAgentRuns(filters?: {
  limit?: number;
  offset?: number;
  search?: string;
  status?: string;
  task?: string;
}) {
  const limit = filters?.limit ?? DEFAULT_RUNS_LIMIT;
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (filters?.offset !== undefined) params.set('offset', String(filters.offset));
  if (filters?.search) params.set('search', filters.search);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.task) params.set('task', filters.task);
  const qs = params.toString();
  const selection = useProjectSelection();

  return resolveAttachedEmpty(
    usePowerQuery<RunsResponse>({
      queryKey: ['agent-runs', filters],
      queryFn: ({ signal }) =>
        fetchJson<RunsResponse>(`/agent/runs?${qs}`, { signal }),
      pollCategory: 'standard',
      refetchInterval: (query) =>
        isAttachedTenancyPending(query.state.error, selection) ? false : RUNS_POLL_INTERVAL,
      retry: (failureCount, err) =>
        isAttachedTenancyPending(err, selection) ? false : failureCount < 3,
    }),
    selection,
    EMPTY_RUNS,
  );
}

export function useAgentRun(id: string | undefined) {
  const result = usePowerQuery<RunDetailResponse>({
    queryKey: ['agent-run', id],
    queryFn: ({ signal }) =>
      fetchJson<RunDetailResponse>(`/agent/runs/${id}`, { signal }),
    enabled: id !== undefined,
    pollCategory: 'standard',
    refetchInterval: (query) => {
      const status = query.state.data?.run?.status;
      if (status && TERMINAL_STATUSES.has(status)) return false;
      return RUN_DETAIL_POLL_INTERVAL;
    },
  });
  return result;
}

export function useAgentReports(runId: string | undefined, runStatus?: string) {
  const isTerminal = runStatus ? TERMINAL_STATUSES.has(runStatus) : false;

  return usePowerQuery<ReportsResponse>({
    queryKey: ['agent-reports', runId],
    queryFn: ({ signal }) =>
      fetchJson<ReportsResponse>(`/agent/runs/${runId}/reports`, { signal }),
    enabled: runId !== undefined,
    pollCategory: 'standard',
    refetchInterval: isTerminal ? false : REPORTS_POLL_INTERVAL,
  });
}

export function useAgentTurns(runId: string | undefined, runStatus?: string) {
  const isTerminal = runStatus ? TERMINAL_STATUSES.has(runStatus) : false;

  return usePowerQuery<TurnRow[]>({
    queryKey: ['agent-turns', runId],
    queryFn: ({ signal }) =>
      fetchJson<TurnRow[]>(`/agent/runs/${runId}/turns`, { signal }),
    enabled: runId !== undefined,
    pollCategory: 'standard',
    refetchInterval: isTerminal ? false : TURNS_POLL_INTERVAL,
  });
}

/**
 * Tail the harness lifecycle event stream for a run.
 *
 * Unlike the other run-detail hooks, this endpoint has no cursor field in
 * its response — the highest `id` among the events already fetched IS the
 * cursor. Each poll requests `?since=<cursor>` and the new rows are
 * appended to accumulated state; nothing is ever dropped or replaced client
 * side. Polling runs at `POLL_INTERVALS.RUN_DETAIL` while `runStatus` is
 * non-terminal (see `TERMINAL_STATUSES`); a terminal run fetches once and
 * stops. A response that comes back at the server page limit
 * (`RUN_EVENTS_PAGE_LIMIT`) means more rows are waiting past the cursor, so
 * an immediate manual `refetch()` is triggered rather than waiting out the
 * rest of the poll interval. Accumulated state resets whenever `runId`
 * changes.
 *
 * The query key caches only the LAST incremental (`?since=`) page, not the
 * full event history — so a warm react-query cache is unsafe to read on
 * remount: within `gcTime` the cache still holds that stale tail page, and
 * the effect below would append it to freshly-reset (empty) local `events`
 * state, producing a cursor jumped past unseen events or duplicated rows.
 * `gcTime: 0` / `staleTime: 0` force every remount to start cold instead of
 * replaying that cached tail page. Event ids are also deduped on append as a
 * second, independent guard.
 */
export function useRunEvents(runId: string | undefined, runStatus?: string) {
  const isTerminal = runStatus ? TERMINAL_STATUSES.has(runStatus) : false;

  const [events, setEvents] = useState<RunEventRow[]>([]);
  const cursorRef = useRef<number | undefined>(undefined);
  const runIdRef = useRef<string | undefined>(runId);
  const seenIdsRef = useRef<Set<number>>(new Set());

  // Reset accumulated state and cursor whenever the run being viewed changes.
  if (runIdRef.current !== runId) {
    runIdRef.current = runId;
    cursorRef.current = undefined;
    seenIdsRef.current = new Set();
    if (events.length > 0) setEvents([]);
  }

  const query = usePowerQuery<RunEventsResponse>({
    queryKey: ['agent-run-events', runId],
    queryFn: ({ signal }) => {
      const qs = cursorRef.current !== undefined ? `?since=${cursorRef.current}` : '';
      return fetchJson<RunEventsResponse>(`/agent/runs/${runId}/events${qs}`, { signal });
    },
    enabled: runId !== undefined,
    pollCategory: 'standard',
    refetchInterval: isTerminal ? false : RUN_EVENTS_POLL_INTERVAL,
    // Never serve a cached incremental page to a fresh mount — see the
    // doc comment above.
    gcTime: 0,
    staleTime: 0,
  });

  const { data, refetch } = query;

  useEffect(() => {
    if (!data || runIdRef.current !== runId) return;
    if (data.events.length > 0) {
      const fresh = data.events.filter((e) => !seenIdsRef.current.has(e.id));
      if (fresh.length > 0) {
        for (const e of fresh) seenIdsRef.current.add(e.id);
        const maxId = fresh.reduce((max, e) => (e.id > max ? e.id : max), cursorRef.current ?? 0);
        cursorRef.current = maxId;
        setEvents((prev) => [...prev, ...fresh]);
      }
    }
    // A full page means more rows are waiting past the new cursor — catch up
    // immediately instead of waiting for the next scheduled poll tick.
    if (data.count === RUN_EVENTS_PAGE_LIMIT) {
      void refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, runId]);

  return { ...query, events };
}

export function useAgentTasks() {
  const queryKey = useProjectScopedQueryKey(['agent-tasks']);
  return useQuery<TasksResponse>({
    queryKey,
    queryFn: ({ signal }) => fetchJson<TasksResponse>('/agent/tasks', { signal }),
    staleTime: TASKS_STALE_TIME,
  });
}

export function useTask(taskId: string | undefined) {
  const queryKey = useProjectScopedQueryKey(['agent-task', taskId]);
  return useQuery<TaskDetailResponse>({
    queryKey,
    queryFn: ({ signal }) =>
      fetchJson<TaskDetailResponse>(`/agent/tasks/${taskId}`, { signal }),
    enabled: taskId !== undefined,
    staleTime: TASKS_STALE_TIME,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation<TaskDetailResponse, Error, CreateTaskPayload>({
    mutationFn: (payload) => postJson<TaskDetailResponse>('/agent/tasks', payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-tasks'] });
    },
  });
}

export function useCopyTask() {
  const queryClient = useQueryClient();
  return useMutation<TaskDetailResponse, Error, CopyTaskPayload>({
    mutationFn: ({ taskId, name }) =>
      postJson<TaskDetailResponse>(`/agent/tasks/${taskId}/copy`, name ? { name } : {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-tasks'] });
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (taskId) => deleteJson<{ ok: boolean }>(`/agent/tasks/${taskId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-tasks'] });
    },
  });
}

/** Fetch a task's YAML representation for editing. */
export function useTaskYaml(taskId: string | undefined) {
  const queryKey = useProjectScopedQueryKey(['agent-task-yaml', taskId]);
  return useQuery<{ yaml: string; source: string }>({
    queryKey,
    queryFn: ({ signal }) =>
      fetchJson<{ yaml: string; source: string }>(`/agent/tasks/${taskId}/yaml`, { signal }),
    enabled: taskId !== undefined,
    staleTime: TASKS_STALE_TIME,
  });
}

/** Update a user task from raw YAML content. */
export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation<TaskDetailResponse, Error, { taskId: string; yaml: string }>({
    mutationFn: ({ taskId, yaml }) =>
      putJson<TaskDetailResponse>(`/agent/tasks/${taskId}`, { yaml }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['agent-task'] });
      void queryClient.invalidateQueries({ queryKey: ['agent-task-yaml'] });
    },
  });
}

export function useTriggerRun() {
  const queryClient = useQueryClient();

  return useMutation<TriggerRunResponse, Error, TriggerRunPayload>({
    mutationFn: (payload: TriggerRunPayload) =>
      postJson<TriggerRunResponse>('/agent/run', payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-runs'] });
    },
  });
}

export function useResumeRun() {
  const queryClient = useQueryClient();
  const selection = useProjectSelection();

  return useMutation<ResumeRunResponse, Error, { runId: string; mode?: 'manual' | 'scheduled' }>({
    mutationFn: ({ runId, mode }) =>
      postJson<ResumeRunResponse>(`/agent/runs/${runId}/resume`, mode ? { mode } : {}),
    onSuccess: (_data, variables) => {
      // Optimistically flip the cached detail to 'running': `useAgentRun`
      // stops polling at a terminal status, so the resumed run must become
      // non-terminal in the cache for detail polling to restart immediately
      // rather than waiting on the invalidation refetch to observe it.
      const detailKey = projectScopedQueryKey(selection, ['agent-run', variables.runId]);
      queryClient.setQueryData<RunDetailResponse>(detailKey, (prev) =>
        prev ? { ...prev, run: { ...prev.run, status: 'running' } } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['agent-runs'] });
      void queryClient.invalidateQueries({ queryKey: ['agent-run', variables.runId] });
    },
  });
}

/* ---------- Dry-run / audit / digest-revisions hooks ---------- */

/**
 * Fetch the write-intents recorded for a dry-run. When `runId` is null the
 * hook is disabled and returns an empty state. The caller is responsible for
 * only invoking the hook on dry-run runs — the endpoint tolerates non-dry
 * runs (returns an empty array) but an explicit null guard saves a request.
 */
export function useAgentRunWriteIntents(runId: string | null) {
  return usePowerQuery<WriteIntentsResponse>({
    queryKey: ['agent-run-write-intents', runId],
    queryFn: ({ signal }) =>
      fetchJson<WriteIntentsResponse>(`/agent/runs/${runId}/write-intents`, { signal }),
    enabled: runId !== null,
    pollCategory: 'standard',
    refetchInterval: false,
  });
}

/**
 * Fetch the phase-audit view for a run. The audit view is a READ-ONLY join
 * across runs/reports/turns/write-intents so it's cheap enough to refetch
 * on every page load.
 */
export function useAgentRunAudit(runId: string | null) {
  return usePowerQuery<AuditResponse>({
    queryKey: ['agent-run-audit', runId],
    queryFn: ({ signal }) =>
      fetchJson<AuditResponse>(`/agent/runs/${runId}/audit`, { signal }),
    enabled: runId !== null,
    pollCategory: 'standard',
    refetchInterval: false,
  });
}

/**
 * List digest revisions for (agentId, tier). Operators use this to roll back
 * a bad digest write without losing audit history.
 */
export function useDigestRevisions(agentId: string, tier: number) {
  const params = new URLSearchParams();
  params.set('agentId', agentId);
  params.set('tier', String(tier));
  const qs = params.toString();

  return usePowerQuery<DigestRevisionsResponse>({
    queryKey: ['digest-revisions', agentId, tier],
    queryFn: ({ signal }) =>
      fetchJson<DigestRevisionsResponse>(`/digest/revisions?${qs}`, { signal }),
    enabled: Boolean(agentId) && Number.isFinite(tier),
    pollCategory: 'standard',
    refetchInterval: false,
  });
}

/**
 * Restore a prior digest revision. On success, invalidates the matching
 * revision list so the caller sees the newly-appended (rollback-of)
 * revision without a manual refetch.
 */
export function useRestoreDigestRevision() {
  const queryClient = useQueryClient();
  return useMutation<RestoreDigestRevisionResponse, Error, { revisionId: number; runId?: string }>({
    mutationFn: ({ revisionId, runId }) =>
      postJson<RestoreDigestRevisionResponse>(
        `/digest/revisions/${revisionId}/restore`,
        runId ? { runId } : {},
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['digest-revisions'] });
    },
  });
}

/**
 * Coerce a `SerializedRunDetail` (the shape `/agent/runs/:id` returns) to
 * a `RunCompareSummary`. The server emits every required field, but the
 * two types still differ in `required` vs `optional` for a handful of
 * columns (dry_run, reasoning_level, execution_overrides) — this tiny
 * normalizer absorbs that gap without an `as unknown as` cast.
 */
function serializedRunToSummary(run: SerializedRunDetail): RunCompareSummary {
  return {
    id: run.id,
    agent_id: run.agent_id,
    task: run.task,
    instruction: run.instruction,
    status: run.status,
    harness: run.harness,
    provider: run.provider,
    model: run.model,
    session_ref: run.session_ref,
    started_at: run.started_at,
    completed_at: run.completed_at,
    tokens_used: run.tokens_used,
    cost_usd: run.cost_usd,
    usage_data: run.usage_data,
    error: run.error,
    dry_run: run.dry_run ?? false,
    reasoning_level: run.reasoning_level ?? null,
    execution_overrides: run.execution_overrides ?? null,
    write_intents: run.write_intents,
    duration_ms: run.duration_ms,
  };
}

/**
 * Fetch the detail payload for N runs in parallel. Backing each run is a
 * plain `GET /agent/runs/:id` call (the single-run detail endpoint now
 * serializes `write_intents` + `duration_ms` alongside the usual fields).
 *
 * Returned shape matches `RunCompareSummary` so it can flow directly into
 * `ComparisonView` — the shared comparison component.
 *
 * Missing / failed / still-in-flight runs are filtered out of `runs`;
 * `isLoading` is true while any underlying query is pending; `errors` has
 * one entry per failed query for surfacing in the UI.
 */
export function useRunsByIds(runIds: string[]) {
  const selection = useProjectSelection();
  const results = useQueries({
    queries: runIds.map((id) => ({
      queryKey: projectScopedQueryKey(selection, ['agent-run', id] as const),
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        fetchJson<RunDetailResponse>(`/agent/runs/${id}`, { signal }),
      enabled: Boolean(id),
    })),
  });

  const runs: RunCompareSummary[] = [];
  const errors: Error[] = [];
  let isLoading = false;
  for (const r of results) {
    if (r.isLoading) isLoading = true;
    if (r.error) errors.push(r.error as Error);
    const run = r.data?.run;
    if (run) {
      // `/agent/runs/:id` returns `SerializedRunDetail`, which is a strict
      // superset of `RunCompareSummary` on the overlapping fields. We still
      // go through `serializedRunToSummary` to resolve the required-vs-
      // optional gap for fields the run shape leaves optional but the
      // summary type requires (e.g. `dry_run`, `reasoning_level`).
      runs.push(serializedRunToSummary(run));
    }
  }

  return { runs, isLoading, errors, isError: errors.length > 0 };
}
