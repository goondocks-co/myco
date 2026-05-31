import { describe, it, expect } from 'bun:test';
import { MycoConfigSchema } from '@myco/config/schema';

describe('MycoConfigSchema v3', () => {
  const minimal = {
    version: 3,
  };

  it('accepts minimal valid v3 config', () => {
    const result = MycoConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('applies embedding defaults', () => {
    const config = MycoConfigSchema.parse(minimal);
    expect(config.embedding.provider).toBe('ollama');
    expect(config.embedding.model).toBe('bge-m3');
  });

  it('rejects version 1 config', () => {
    const result = MycoConfigSchema.safeParse({
      version: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects version 2 config', () => {
    const result = MycoConfigSchema.safeParse({
      version: 2,
    });
    expect(result.success).toBe(false);
  });

  it('accepts custom embedding provider and model', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      embedding: {
        provider: 'openai-compatible',
        model: 'bge-m3',
        base_url: 'http://gpu-box:11434',
      },
    });
    expect(config.embedding.provider).toBe('openai-compatible');
    expect(config.embedding.base_url).toBe('http://gpu-box:11434');
  });

  it('applies defaults for omitted sections', () => {
    const config = MycoConfigSchema.parse(minimal);
    expect(config.capture.buffer_max_events).toBe(500);
    expect(config.daemon.log_level).toBe('info');
    expect(config.notifications.default_mode).toBe('summary');
  });

  it('accepts custom capture config', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      capture: {
        transcript_paths: ['/custom/path'],
        buffer_max_events: 1000,
      },
    });
    expect(config.capture.transcript_paths).toEqual(['/custom/path']);
    expect(config.capture.buffer_max_events).toBe(1000);
  });

  it('defaults release provenance to enabled but unreconciled until refs are configured', () => {
    const config = MycoConfigSchema.parse({ version: 3 });
    expect(config.release_provenance.enabled).toBe(true);
    expect(config.release_provenance.production_refs).toEqual([]);
    expect(config.release_provenance.integration_refs).toEqual([]);
    expect(config.release_provenance.reconcile_interval_minutes).toBe(15);
    expect(config.release_provenance.production_debug_include_unknown).toBe(true);
  });

  it('accepts project release provenance refs', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      release_provenance: {
        production_refs: ['refs/tags/v1.2.3'],
        integration_refs: ['origin/main'],
      },
    });
    expect(config.release_provenance.production_refs).toEqual(['refs/tags/v1.2.3']);
    expect(config.release_provenance.integration_refs).toEqual(['origin/main']);
  });

  it('does not include removed v2 sections', () => {
    const config = MycoConfigSchema.parse({ version: 3 });
    const raw = config as Record<string, unknown>;
    expect(raw.intelligence).toBeUndefined();
    expect(raw.digest).toBeUndefined();
    expect(raw.pipeline).toBeUndefined();
  });

  it('applies cortex feature defaults', () => {
    const config = MycoConfigSchema.parse({ version: 3 });
    expect(config.cortex.enabled).toBe(true);
    expect(config.cortex.instructions.inject_on_session_start).toBe(true);
    expect(config.cortex.instructions.inject_on_subagent_start).toBe(true);
    expect(config.cortex.digest.tier).toBe(5000);
    expect(config.cortex.digest.inject_on_session_start).toBe(false);
    expect(config.cortex.spores.inject_on_prompt_submit).toBe(true);
    expect(config.cortex.spores.max_per_prompt).toBe(3);
    expect(config.cortex.plans.inject_intent_nudge_on_prompt_submit).toBe(true);
  });

  it('accepts custom cortex feature config', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      cortex: {
        instructions: { inject_on_session_start: false, inject_on_subagent_start: false },
        digest: { tier: 10000, inject_on_session_start: true },
        spores: { inject_on_prompt_submit: false, max_per_prompt: 5 },
      },
    });
    expect(config.cortex.instructions.inject_on_session_start).toBe(false);
    expect(config.cortex.instructions.inject_on_subagent_start).toBe(false);
    expect(config.cortex.digest.tier).toBe(10000);
    expect(config.cortex.digest.inject_on_session_start).toBe(true);
    expect(config.cortex.spores.inject_on_prompt_submit).toBe(false);
    expect(config.cortex.spores.max_per_prompt).toBe(5);
  });

  it('accepts openrouter embedding provider', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      embedding: {
        provider: 'openrouter',
        model: 'openai/text-embedding-3-small',
      },
    });
    expect(config.embedding.provider).toBe('openrouter');
  });

  it('accepts openai embedding provider', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
    });
    expect(config.embedding.provider).toBe('openai');
  });

  it('accepts plan_dirs in capture section', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      capture: { plan_dirs: ['docs/superpowers/specs/', 'docs/superpowers/plans/'] },
    });
    expect(config.capture.plan_dirs).toEqual(['docs/superpowers/specs/', 'docs/superpowers/plans/']);
  });

  it('defaults plan_dirs to empty array', () => {
    const config = MycoConfigSchema.parse({ version: 3 });
    expect(config.capture.plan_dirs).toEqual([]);
  });

  it('parses skills config with defaults', () => {
    const config = MycoConfigSchema.parse({ version: 3 });
    expect(config.skills.confidence_threshold).toBe(0.7);
    expect(config.skills.usage_stale_days).toBe(30);
  });

  it('accepts custom skills config', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      skills: {
        confidence_threshold: 0.8,
        usage_stale_days: 14,
      },
    });
    expect(config.skills.confidence_threshold).toBe(0.8);
    expect(config.skills.usage_stale_days).toBe(14);
  });

  it('accepts task schedule override in agent.tasks', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      agent: {
        tasks: {
          'skill-survey': {
            schedule: {
              enabled: true,
              intervalSeconds: 900,
            },
          },
        },
      },
    });
    expect(config.agent.tasks?.['skill-survey']?.schedule?.enabled).toBe(true);
    expect(config.agent.tasks?.['skill-survey']?.schedule?.intervalSeconds).toBe(900);
  });

  it('rejects legacy runtime keys after config migration', () => {
    expect(MycoConfigSchema.safeParse({
      version: 3,
      config_version: 9,
      agent: { runtime: 'claude-sdk' },
    }).success).toBe(false);

    expect(MycoConfigSchema.safeParse({
      version: 3,
      config_version: 9,
      agent: {
        provider: { type: 'anthropic', runtime: 'claude-sdk' },
      },
    }).success).toBe(false);

    expect(MycoConfigSchema.safeParse({
      version: 3,
      config_version: 9,
      agent: {
        tasks: {
          'review-session': { runtime: 'openai-agents' },
        },
      },
    }).success).toBe(false);
  });

  it('accepts task schedule accelerator overrides in agent.tasks', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      agent: {
        tasks: {
          'canopy-describe': {
            schedule: {
              accelerator: {
                name: 'canopy-pending-describe',
                thresholds: { steady: 25, accelerated: 250 },
              },
            },
          },
        },
      },
    });
    expect(config.agent.tasks?.['canopy-describe']?.schedule?.accelerator).toEqual({
      name: 'canopy-pending-describe',
      thresholds: { steady: 25, accelerated: 250 },
    });
  });

  it('fills in default appearance section when absent', () => {
    const parsed = MycoConfigSchema.parse({ version: 3 });
    expect(parsed.appearance).toEqual({
      theme: 'sage',
      mode: 'dark',
      font: 'default',
      density: 'normal',
    });
  });

  it('accepts partial appearance and fills missing fields', () => {
    const parsed = MycoConfigSchema.parse({
      version: 3,
      appearance: { theme: 'moss' },
    });
    expect(parsed.appearance.theme).toBe('moss');
    expect(parsed.appearance.mode).toBe('dark');
    expect(parsed.appearance.font).toBe('default');
    expect(parsed.appearance.density).toBe('normal');
  });

  it('accepts all valid appearance enum values', () => {
    const parsed = MycoConfigSchema.parse({
      version: 3,
      appearance: {
        theme: 'terracotta',
        mode: 'light',
        font: 'jetbrains-mono',
        density: 'compact',
      },
    });
    expect(parsed.appearance).toEqual({
      theme: 'terracotta',
      mode: 'light',
      font: 'jetbrains-mono',
      density: 'compact',
    });
  });

  it('rejects invalid appearance theme', () => {
    const result = MycoConfigSchema.safeParse({
      version: 3,
      appearance: { theme: 'not-a-theme' },
    });
    expect(result.success).toBe(false);
  });
});

describe('MaintenanceSchema', () => {
  it('defaults auto_optimize to true and interval to 24 hours', () => {
    const config = MycoConfigSchema.parse({ version: 3 });
    expect(config.maintenance.auto_optimize).toBe(true);
    expect(config.maintenance.auto_optimize_interval_hours).toBe(24);
  });

  it('accepts explicit overrides', () => {
    const config = MycoConfigSchema.parse({
      version: 3,
      maintenance: { auto_optimize: false, auto_optimize_interval_hours: 168 },
    });
    expect(config.maintenance.auto_optimize).toBe(false);
    expect(config.maintenance.auto_optimize_interval_hours).toBe(168);
  });

  it('rejects interval below 1 hour', () => {
    expect(() =>
      MycoConfigSchema.parse({
        version: 3,
        maintenance: { auto_optimize: true, auto_optimize_interval_hours: 0 },
      }),
    ).toThrow();
  });

  it('rejects interval above 720 hours', () => {
    expect(() =>
      MycoConfigSchema.parse({
        version: 3,
        maintenance: { auto_optimize: true, auto_optimize_interval_hours: 721 },
      }),
    ).toThrow();
  });
});
