import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, putJson } from '../lib/api';

export interface MycoConfig {
  version: 2;
  config_version: number;
  intelligence: {
    llm: {
      provider: 'ollama' | 'lm-studio' | 'anthropic' | 'openai-compatible';
      model: string;
      base_url?: string;
      context_window: number;
      max_tokens: number;
    };
    embedding: {
      provider: 'ollama' | 'lm-studio' | 'openai-compatible';
      model: string;
      base_url?: string;
    };
  };
  daemon: {
    port: number | null;
    log_level: 'debug' | 'info' | 'warn' | 'error';
    grace_period: number;
    max_log_size: number;
  };
  capture: {
    transcript_paths: string[];
    artifact_watch: string[];
    artifact_extensions: string[];
    buffer_max_events: number;
    extraction_max_tokens: number;
    summary_max_tokens: number;
    title_max_tokens: number;
    classification_max_tokens: number;
  };
  context: {
    max_tokens: number;
    layers: {
      plans: number;
      sessions: number;
      spores: number;
      team: number;
    };
  };
  team: {
    enabled: boolean;
    user: string;
    sync: 'git' | 'obsidian-sync' | 'manual';
  };
  digest: {
    enabled: boolean;
    tiers: number[];
    inject_tier: number | null;
    intelligence: {
      provider: 'ollama' | 'lm-studio' | 'anthropic' | 'openai-compatible' | null;
      model: string | null;
      base_url: string | null;
      context_window: number;
      keep_alive: string | null;
      gpu_kv_cache: boolean;
    };
    metabolism: {
      active_interval: number;
      cooldown_intervals: number[];
      dormancy_threshold: number;
    };
    substrate: {
      max_notes_per_cycle: number;
    };
  };
  pipeline: {
    retention_days: number;
    batch_size: number;
    tick_interval_seconds: number;
    retry: {
      transient_max: number;
      backoff_base_seconds: number;
    };
    circuit_breaker: {
      failure_threshold: number;
      cooldown_seconds: number;
      max_cooldown_seconds: number;
    };
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
