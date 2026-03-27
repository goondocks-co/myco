import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, putJson } from '../lib/api';

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
  capture: {
    transcript_paths: string[];
    plan_dirs: string[];
    artifact_extensions: string[];
    buffer_max_events: number;
  };
  agent: {
    auto_run: boolean;
    interval_seconds: number;
    summary_batch_interval: number;
    /** Fields below are set via Agent Tasks page, not Settings — preserve on save. */
    provider?: { type: string; base_url?: string; model?: string; context_length?: number };
    model?: string;
    tasks?: Record<string, unknown>;
  };
  context: {
    digest_tier: number;
    prompt_search: boolean;
    prompt_max_spores: number;
    /** Extensible — preserve unknown fields on save. */
    [key: string]: unknown;
  };
}

export function useConfig() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['config'],
    queryFn: ({ signal }) => fetchJson<MycoConfig>('/config', { signal }),
  });

  const mutation = useMutation({
    mutationFn: (config: MycoConfig) => putJson<MycoConfig>('/config', config),
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
