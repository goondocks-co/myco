import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, writeScopedConfig } from '../lib/api';

export interface MycoConfig {
  version: 3;
  config_version: number;
  embedding: {
    provider: 'ollama' | 'openai-compatible';
    model: string;
    base_url?: string;
  };
  daemon: {
    port: number | null;
    log_level: 'debug' | 'info' | 'warn' | 'error';
    log_retention_days: number;
  };
  maintenance: {
    auto_optimize: boolean;
    auto_optimize_interval_hours: number;
  };
  capture: {
    transcript_paths: string[];
    plan_dirs: string[];
    artifact_extensions: string[];
    buffer_max_events: number;
  };
  agent: {
    summary_batch_interval: number;
    scheduled_tasks_enabled?: boolean;
    event_tasks_enabled?: boolean;
    provider?: { type: string; base_url?: string; model?: string; context_length?: number };
    model?: string;
    tasks?: Record<string, unknown>;
  };
  context: {
    digest_tier: number;
    prompt_search: boolean;
    prompt_max_spores: number;
    [key: string]: unknown;
  };
  notifications: {
    enabled: boolean;
    system_notifications: boolean;
    default_mode: 'banner' | 'summary';
    domains: Record<string, { enabled: boolean; mode?: 'banner' | 'summary' }>;
  };
}

/** Recursive partial — lets each caller send only the sections (and nested fields) it owns. */
export type MycoConfigPatch = {
  [K in keyof MycoConfig]?: MycoConfig[K] extends Record<string, unknown>
    ? Partial<MycoConfig[K]>
    : MycoConfig[K];
};

export function useConfig() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['config'],
    queryFn: ({ signal }) => fetchJson<MycoConfig>('/config', { signal }),
  });

  const mutation = useMutation({
    mutationFn: (patch: MycoConfigPatch) =>
      writeScopedConfig('project', patch as Record<string, unknown>) as Promise<MycoConfig>,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['config'] }),
  });

  return {
    config: query.data,
    isLoading: query.isLoading,
    error: query.error,
    saveConfig: mutation.mutateAsync,
    isSaving: mutation.isPending,
    saveError: mutation.error,
  };
}
