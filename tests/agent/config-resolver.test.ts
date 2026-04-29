import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import type { AgentDefinition, AgentTask } from '@myco/agent/types.js';
import type { AgentRow } from '@myco/db/queries/agents.js';
import type { TaskRow } from '@myco/db/queries/tasks.js';
import { resolveRunConfig } from '@myco/agent/config-resolver.js';

const TEST_VAULT_DIR = '/tmp/test-vault';

const mockDefinition: AgentDefinition = {
  name: 'myco-agent',
  displayName: 'Myco Agent',
  description: 'Test agent',
  model: 'claude-sonnet-4-20250514',
  maxTurns: 30,
  timeoutSeconds: 300,
  systemPromptPath: '../prompts/agent.md',
  tools: ['vault_sessions'],
};

const mockTaskRow: TaskRow = {
  id: 'title-summary',
  agent_id: 'myco-agent',
  source: 'built-in',
  display_name: 'Title & Summary',
  description: 'Generate titles and summaries',
  prompt: 'Summarize the target session.',
  is_default: 0,
  tool_overrides: null,
  model: null,
  config: null,
  created_at: 1000,
  updated_at: null,
};

const mockYamlTask: AgentTask = {
  name: 'title-summary',
  displayName: 'Title & Summary',
  description: 'Generate titles and summaries',
  agent: 'myco-agent',
  prompt: 'Summarize the target session.',
  isDefault: false,
  maxTurns: 15,
  timeoutSeconds: 300,
};

const mockAgentRow: AgentRow = {
  id: 'myco-agent',
  name: 'Myco Agent',
  provider: null,
  model: null,
  system_prompt_hash: null,
  config: null,
  source: 'built-in',
  system_prompt: null,
  max_turns: null,
  timeout_seconds: null,
  tool_access: null,
  enabled: 1,
  created_at: 1000,
  updated_at: null,
};

mock.module('@myco/db/queries/agents.js', () => ({
  getAgent: () => mockAgentRow,
}));

mock.module('@myco/db/queries/tasks.js', () => ({
  getTask: () => mockTaskRow,
  getDefaultTask: () => mockTaskRow,
}));

mock.module('@myco/agent/loader.js', () => ({
  resolveDefinitionsDir: () => '/mock/definitions',
  loadAgentDefinition: () => mockDefinition,
  resolveEffectiveConfig: (_definition: AgentDefinition, _agentRow: AgentRow | null, taskOverrides?: AgentTask) => ({
    agentId: 'myco-agent',
    runtime: 'claude-sdk' as const,
    model: taskOverrides?.model ?? mockDefinition.model,
    ...(taskOverrides?.reasoningLevel ? { reasoningLevel: taskOverrides.reasoningLevel } : {}),
    maxTurns: taskOverrides?.maxTurns ?? mockDefinition.maxTurns,
    timeoutSeconds: taskOverrides?.timeoutSeconds ?? mockDefinition.timeoutSeconds,
    systemPromptPath: mockDefinition.systemPromptPath,
    tools: mockDefinition.tools,
    taskName: taskOverrides?.name ?? 'title-summary',
    taskDisplayName: taskOverrides?.displayName ?? 'Title & Summary',
    taskPrompt: taskOverrides?.prompt ?? 'Summarize the target session.',
  }),
}));

mock.module('@myco/agent/registry.js', () => ({
  loadAllTasks: () => new Map([['title-summary', mockYamlTask]]),
}));

const mockLoadMergedConfig = vi.fn();

mock.module('@myco/config/loader.js', () => ({
  loadMergedConfig: (...args: unknown[]) => mockLoadMergedConfig(...args),
}));

describe('resolveRunConfig', () => {
  beforeEach(() => {
    mockLoadMergedConfig.mockReset();
  });

  it('applies task-level maxTurns and timeoutSeconds from myco.yaml', () => {
    mockLoadMergedConfig.mockReturnValue({
      version: 3,
      config_version: 5,
      embedding: { provider: 'ollama', model: 'bge-m3:latest' },
      daemon: { port: 21039, log_level: 'debug', log_retention_days: 30, stale_session_threshold_ms: 3600000 },
      capture: { transcript_paths: [], plan_dirs: [], ignore_plan_dirs_in_git: false, artifact_extensions: ['.md'], buffer_max_events: 500 },
      agent: {
        summary_batch_interval: 5,
        scheduled_tasks_enabled: false,
        event_tasks_enabled: true,
        tasks: {
          'title-summary': {
            runtime: 'openai-agents',
            maxTurns: 30,
            timeoutSeconds: 900,
          },
        },
      },
      cortex: { digest: { tier: 5000 }, spores: { inject_on_prompt_submit: true, max_per_prompt: 3 } },
      backup: {},
      maintenance: { auto_optimize: true, auto_optimize_interval_hours: 24 },
      team: { enabled: false, interval_minutes: 15 },
      skills: { confidence_threshold: 0.7, usage_stale_days: 30 },
      notifications: { enabled: true, system_notifications: false, default_mode: 'summary', domains: {} },
      appearance: { theme: 'sage', mode: 'dark', font: 'default', density: 'normal' },
    });

    const resolved = resolveRunConfig('myco-agent', 'title-summary', TEST_VAULT_DIR);

    expect(resolved.runtime).toBe('openai-agents');
    expect(resolved.config.runtime).toBe('openai-agents');
    expect(resolved.config.maxTurns).toBe(30);
    expect(resolved.config.timeoutSeconds).toBe(900);
  });

  it('applies task-level model override from myco.yaml', () => {
    mockLoadMergedConfig.mockReturnValue({
      version: 3,
      config_version: 5,
      embedding: { provider: 'ollama', model: 'bge-m3:latest' },
      daemon: { port: 21039, log_level: 'debug', log_retention_days: 30, stale_session_threshold_ms: 3600000 },
      capture: { transcript_paths: [], plan_dirs: [], ignore_plan_dirs_in_git: false, artifact_extensions: ['.md'], buffer_max_events: 500 },
      agent: {
        summary_batch_interval: 5,
        scheduled_tasks_enabled: false,
        event_tasks_enabled: true,
        tasks: {
          'title-summary': {
            model: 'gpt-5.4-mini',
          },
        },
      },
      cortex: { digest: { tier: 5000 }, spores: { inject_on_prompt_submit: true, max_per_prompt: 3 } },
      backup: {},
      maintenance: { auto_optimize: true, auto_optimize_interval_hours: 24 },
      team: { enabled: false, interval_minutes: 15 },
      skills: { confidence_threshold: 0.7, usage_stale_days: 30 },
      notifications: { enabled: true, system_notifications: false, default_mode: 'summary', domains: {} },
      appearance: { theme: 'sage', mode: 'dark', font: 'default', density: 'normal' },
    });

    const resolved = resolveRunConfig('myco-agent', 'title-summary', TEST_VAULT_DIR);

    expect(resolved.config.model).toBe('gpt-5.4-mini');
  });

  it('maps task-level openai-compatible local_backend config into runtime provider config', () => {
    mockLoadMergedConfig.mockReturnValue({
      version: 3,
      config_version: 5,
      embedding: { provider: 'ollama', model: 'bge-m3:latest' },
      daemon: { port: 21039, log_level: 'debug', log_retention_days: 30, stale_session_threshold_ms: 3600000 },
      capture: { transcript_paths: [], plan_dirs: [], ignore_plan_dirs_in_git: false, artifact_extensions: ['.md'], buffer_max_events: 500 },
      agent: {
        summary_batch_interval: 5,
        scheduled_tasks_enabled: false,
        event_tasks_enabled: true,
        tasks: {
          'title-summary': {
            provider: {
              type: 'openai-compatible',
              local_backend: 'ollama',
              base_url: 'http://localhost:11434',
              model: 'gemma4:26b',
            },
          },
        },
      },
      cortex: { digest: { tier: 5000 }, spores: { inject_on_prompt_submit: true, max_per_prompt: 3 } },
      backup: {},
      maintenance: { auto_optimize: true, auto_optimize_interval_hours: 24 },
      team: { enabled: false, interval_minutes: 15 },
      skills: { confidence_threshold: 0.7, usage_stale_days: 30 },
      notifications: { enabled: true, system_notifications: false, default_mode: 'summary', domains: {} },
      appearance: { theme: 'sage', mode: 'dark', font: 'default', density: 'normal' },
    });

    const resolved = resolveRunConfig('myco-agent', 'title-summary', TEST_VAULT_DIR);

    expect(resolved.taskProviderOverride).toEqual(expect.objectContaining({
      type: 'openai-compatible',
      localBackend: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'gemma4:26b',
    }));
    expect(resolved.runtime).toBe('openai-agents');
  });
});
