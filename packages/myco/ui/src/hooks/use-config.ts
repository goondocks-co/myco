import type { AppearanceValues } from '@myco/config/appearance-values';

/**
 * Shared MycoConfig type. The actual config read/write hook lives in
 * `use-scoped-config.ts` — that hook handles project + local overlay
 * fetching and dotted-path writes through the scoped endpoints.
 *
 * Kept as a separate file because several non-config components import the
 * shape (e.g., NotificationSettings reads `notifications.domains` types).
 */

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
    ignore_plan_dirs_in_git?: boolean;
  };
  agent: {
    summary_batch_interval: number;
    scheduled_tasks_enabled?: boolean;
    event_tasks_enabled?: boolean;
    runtime?: 'claude-sdk' | 'openai-agents';
    provider?: {
      runtime?: 'claude-sdk' | 'openai-agents';
      type: string;
      base_url?: string;
      model?: string;
      reasoning_map?: {
        low?: string;
        default?: string;
        high?: string;
      };
      context_length?: number;
    };
    model?: string;
    tasks?: Record<string, unknown>;
  };
  context: {
    digest_tier: number;
    operating_brief_enabled: boolean;
    operating_brief_inject_on: Array<'session_start'>;
    operating_brief_max_tokens: number;
    prompt_search: boolean;
    prompt_max_spores: number;
    [key: string]: unknown;
  };
  backup: {
    dir?: string;
  };
  notifications: {
    enabled: boolean;
    system_notifications: boolean;
    default_mode: 'banner' | 'summary';
    domains: Record<string, { enabled: boolean; mode?: 'banner' | 'summary' }>;
  };
  appearance: AppearanceValues;
}
