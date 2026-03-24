import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../lib/api';

/* ---------- Constants ---------- */

/** Cache TTL for agent run list (10 seconds — runs are polled while one is active). */
const RUNS_STALE_TIME = 10_000;

/** Cache TTL for a single run detail (10 seconds). */
const RUN_DETAIL_STALE_TIME = 10_000;

/** Cache TTL for run reports (30 seconds — reports don't change after a run ends). */
const REPORTS_STALE_TIME = 30_000;

/** Cache TTL for audit trail turns (30 seconds). */
const TURNS_STALE_TIME = 30_000;

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
  started_at: number | null;
  completed_at: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  actions_taken: string | null;
  error: string | null;
}

export interface RunsResponse {
  runs: RunRow[];
}

export interface RunDetailResponse {
  run: RunRow;
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

export interface TaskRow {
  id: string;
  agent_id: string;
  source: string;
  display_name: string | null;
  description: string | null;
  prompt: string;
  is_default: number;
  tool_overrides: string | null;
  config: string | null;
  created_at: number;
  updated_at: number | null;
}

export interface TriggerRunPayload {
  task?: string;
  instruction?: string;
}

export interface TriggerRunResponse {
  ok: boolean;
  message: string;
}

/* ---------- Hooks ---------- */

export function useAgentRuns(options?: { limit?: number }) {
  const limit = options?.limit ?? DEFAULT_RUNS_LIMIT;

  return useQuery<RunsResponse>({
    queryKey: ['agent-runs', limit],
    queryFn: ({ signal }) =>
      fetchJson<RunsResponse>(`/agent/runs?limit=${limit}`, { signal }),
    staleTime: RUNS_STALE_TIME,
  });
}

export function useAgentRun(id: string | undefined) {
  return useQuery<RunDetailResponse>({
    queryKey: ['agent-run', id],
    queryFn: ({ signal }) =>
      fetchJson<RunDetailResponse>(`/agent/runs/${id}`, { signal }),
    enabled: id !== undefined,
    staleTime: RUN_DETAIL_STALE_TIME,
  });
}

export function useAgentReports(runId: string | undefined) {
  return useQuery<ReportsResponse>({
    queryKey: ['agent-reports', runId],
    queryFn: ({ signal }) =>
      fetchJson<ReportsResponse>(`/agent/runs/${runId}/reports`, { signal }),
    enabled: runId !== undefined,
    staleTime: REPORTS_STALE_TIME,
  });
}

export function useAgentTurns(runId: string | undefined) {
  return useQuery<TurnRow[]>({
    queryKey: ['agent-turns', runId],
    queryFn: ({ signal }) =>
      fetchJson<TurnRow[]>(`/agent/runs/${runId}/turns`, { signal }),
    enabled: runId !== undefined,
    staleTime: TURNS_STALE_TIME,
  });
}

export function useAgentTasks() {
  return useQuery<TaskRow[]>({
    queryKey: ['agent-tasks'],
    queryFn: ({ signal }) => fetchJson<TaskRow[]>('/agent/tasks', { signal }),
    staleTime: TASKS_STALE_TIME,
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
