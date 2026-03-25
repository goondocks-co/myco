import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usePowerQuery } from './use-power-query';
import { fetchJson, postJson, putJson, deleteJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

/* ---------- Constants ---------- */

/** Poll interval for agent run list (matches POLL_INTERVALS.STATS). */
const RUNS_POLL_INTERVAL = POLL_INTERVALS.STATS;

/** Poll interval for a single run detail (faster — watching active run). */
const RUN_DETAIL_POLL_INTERVAL = POLL_INTERVALS.HEALTH;

/** Poll interval for run reports (moderate — updates during execution). */
const REPORTS_POLL_INTERVAL = POLL_INTERVALS.STATS;

/** Poll interval for audit trail turns. */
const TURNS_POLL_INTERVAL = POLL_INTERVALS.STATS;

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
  maxTurns?: number;
  timeoutSeconds?: number;
  phases?: PhaseDefinition[];
  execution?: { model?: string; maxTurns?: number; timeoutSeconds?: number };
  contextQueries?: Record<string, unknown[]>;
  orchestrator?: { enabled: boolean; model?: string; maxTurns?: number };
  schemaVersion?: number;
}

export interface TriggerRunPayload {
  task?: string;
  instruction?: string;
}

export interface TriggerRunResponse {
  ok: boolean;
  message: string;
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

export function useAgentRuns(options?: { limit?: number }) {
  const limit = options?.limit ?? DEFAULT_RUNS_LIMIT;

  return usePowerQuery<RunsResponse>({
    queryKey: ['agent-runs', limit],
    queryFn: ({ signal }) =>
      fetchJson<RunsResponse>(`/agent/runs?limit=${limit}`, { signal }),
    pollCategory: 'standard',
    refetchInterval: RUNS_POLL_INTERVAL,
  });
}

export function useAgentRun(id: string | undefined) {
  return usePowerQuery<RunDetailResponse>({
    queryKey: ['agent-run', id],
    queryFn: ({ signal }) =>
      fetchJson<RunDetailResponse>(`/agent/runs/${id}`, { signal }),
    enabled: id !== undefined,
    pollCategory: 'realtime',
    refetchInterval: RUN_DETAIL_POLL_INTERVAL,
  });
}

export function useAgentReports(runId: string | undefined) {
  return usePowerQuery<ReportsResponse>({
    queryKey: ['agent-reports', runId],
    queryFn: ({ signal }) =>
      fetchJson<ReportsResponse>(`/agent/runs/${runId}/reports`, { signal }),
    enabled: runId !== undefined,
    pollCategory: 'standard',
    refetchInterval: REPORTS_POLL_INTERVAL,
  });
}

export function useAgentTurns(runId: string | undefined) {
  return usePowerQuery<TurnRow[]>({
    queryKey: ['agent-turns', runId],
    queryFn: ({ signal }) =>
      fetchJson<TurnRow[]>(`/agent/runs/${runId}/turns`, { signal }),
    enabled: runId !== undefined,
    pollCategory: 'standard',
    refetchInterval: TURNS_POLL_INTERVAL,
  });
}

export function useAgentTasks() {
  return useQuery<TasksResponse>({
    queryKey: ['agent-tasks'],
    queryFn: ({ signal }) => fetchJson<TasksResponse>('/agent/tasks', { signal }),
    staleTime: TASKS_STALE_TIME,
  });
}

export function useTask(taskId: string | undefined) {
  return useQuery<TaskDetailResponse>({
    queryKey: ['agent-task', taskId],
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
  return useQuery<{ yaml: string; source: string }>({
    queryKey: ['agent-task-yaml', taskId],
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
