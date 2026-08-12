import { describe, it, expect } from 'bun:test';
import { MIGRATIONS, CURRENT_MIGRATION_VERSION, runMigrations } from '@myco/config/migrations';

const v3 = MIGRATIONS.find((m) => m.version === 3)!;

describe('Migration v3: schedule-to-task-level', () => {
  it('migrates agent.auto_run + interval_seconds to full-intelligence schedule', () => {
    const doc: Record<string, unknown> = {
      agent: { auto_run: true, interval_seconds: 600 },
    };
    v3.migrate(doc, '/tmp');

    const agent = doc.agent as Record<string, unknown>;
    expect(agent.auto_run).toBeUndefined();
    expect(agent.interval_seconds).toBeUndefined();

    const tasks = agent.tasks as Record<string, Record<string, unknown>>;
    expect(tasks['full-intelligence'].schedule).toEqual({
      enabled: true,
      intervalSeconds: 600,
    });
  });

  it('migrates skills.auto_survey to skill-survey schedule', () => {
    const doc: Record<string, unknown> = {
      skills: { auto_survey: true },
    };
    v3.migrate(doc, '/tmp');

    const skills = doc.skills as Record<string, unknown>;
    expect(skills.auto_survey).toBeUndefined();

    const agent = doc.agent as Record<string, unknown>;
    const tasks = agent.tasks as Record<string, Record<string, unknown>>;
    expect(tasks['skill-survey'].schedule).toEqual({ enabled: true });
  });

  it('migrates skills.auto_evolve + evolve_cadence to skill-evolve schedule (valid cadence)', () => {
    const doc: Record<string, unknown> = {
      skills: { auto_evolve: true, evolve_cadence: 'idle' },
    };
    v3.migrate(doc, '/tmp');

    const skills = doc.skills as Record<string, unknown>;
    expect(skills.auto_evolve).toBeUndefined();
    expect(skills.evolve_cadence).toBeUndefined();

    const agent = doc.agent as Record<string, unknown>;
    const tasks = agent.tasks as Record<string, Record<string, unknown>>;
    expect(tasks['skill-evolve'].schedule).toEqual({
      enabled: true,
      runIn: ['idle'],
    });
  });

  it('falls back to idle runIn for invalid evolve_cadence values', () => {
    const doc: Record<string, unknown> = {
      skills: { auto_evolve: true, evolve_cadence: 'weekly' },
    };
    v3.migrate(doc, '/tmp');

    const agent = doc.agent as Record<string, unknown>;
    const tasks = agent.tasks as Record<string, Record<string, unknown>>;
    expect(tasks['skill-evolve'].schedule).toEqual({
      enabled: true,
      runIn: ['idle'],
    });
  });

  it('is a no-op when no old fields exist', () => {
    const doc: Record<string, unknown> = {
      agent: { model: 'claude-opus-4' },
      skills: { confidence_threshold: 0.8 },
    };
    v3.migrate(doc, '/tmp');

    const agent = doc.agent as Record<string, unknown>;
    expect(agent.model).toBe('claude-opus-4');
    // tasks should not have been created with old scheduling keys
    const tasks = (agent.tasks ?? {}) as Record<string, Record<string, unknown>>;
    expect(tasks['full-intelligence']).toBeUndefined();
    expect(tasks['skill-survey']).toBeUndefined();
    expect(tasks['skill-evolve']).toBeUndefined();
  });

  it('preserves existing task config (model, maxTurns) during migration', () => {
    const doc: Record<string, unknown> = {
      agent: {
        auto_run: false,
        interval_seconds: 300,
        tasks: {
          'full-intelligence': { model: 'claude-sonnet-4', maxTurns: 10 },
        },
      },
    };
    v3.migrate(doc, '/tmp');

    const agent = doc.agent as Record<string, unknown>;
    const tasks = agent.tasks as Record<string, Record<string, unknown>>;
    const fi = tasks['full-intelligence'];
    expect(fi.model).toBe('claude-sonnet-4');
    expect(fi.maxTurns).toBe(10);
    expect(fi.schedule).toEqual({ enabled: false, intervalSeconds: 300 });
  });

  it('handles partial migration (only agent fields, not skills)', () => {
    const doc: Record<string, unknown> = {
      agent: { auto_run: true, interval_seconds: 900 },
      skills: { confidence_threshold: 0.7, usage_stale_days: 30 },
    };
    v3.migrate(doc, '/tmp');

    const agent = doc.agent as Record<string, unknown>;
    expect(agent.auto_run).toBeUndefined();
    expect(agent.interval_seconds).toBeUndefined();

    const tasks = agent.tasks as Record<string, Record<string, unknown>>;
    expect(tasks['full-intelligence'].schedule).toEqual({
      enabled: true,
      intervalSeconds: 900,
    });
    expect(tasks['skill-survey']).toBeUndefined();
    expect(tasks['skill-evolve']).toBeUndefined();

    const skills = doc.skills as Record<string, unknown>;
    expect(skills.confidence_threshold).toBe(0.7);
    expect(skills.usage_stale_days).toBe(30);
  });

  it('preserves skills.confidence_threshold and skills.usage_stale_days', () => {
    const doc: Record<string, unknown> = {
      skills: {
        confidence_threshold: 0.9,
        usage_stale_days: 14,
        auto_survey: false,
        auto_evolve: false,
        evolve_cadence: 'monthly',
      },
    };
    v3.migrate(doc, '/tmp');

    const skills = doc.skills as Record<string, unknown>;
    expect(skills.confidence_threshold).toBe(0.9);
    expect(skills.usage_stale_days).toBe(14);
    // scheduling fields should be gone
    expect(skills.auto_survey).toBeUndefined();
    expect(skills.auto_evolve).toBeUndefined();
    expect(skills.evolve_cadence).toBeUndefined();
  });
});

const v4 = MIGRATIONS.find((m) => m.version === 4)!;
const v5 = MIGRATIONS.find((m) => m.version === 5)!;

describe('Migration v4: rename-cloud-provider-to-anthropic', () => {
  it('renames global agent provider type from cloud to anthropic', () => {
    const doc: Record<string, unknown> = {
      agent: { provider: { type: 'cloud', model: 'claude-sonnet-4-6' } },
    };
    v4.migrate(doc, '/tmp');

    const agent = doc.agent as Record<string, unknown>;
    const provider = agent.provider as Record<string, unknown>;
    expect(provider.type).toBe('anthropic');
    expect(provider.model).toBe('claude-sonnet-4-6');
  });

  it('renames per-task provider override from cloud to anthropic', () => {
    const doc: Record<string, unknown> = {
      agent: {
        tasks: {
          'full-intelligence': { provider: { type: 'cloud' } },
          'skill-survey': { provider: { type: 'ollama', model: 'gpt-oss' } },
        },
      },
    };
    v4.migrate(doc, '/tmp');

    const tasks = (doc.agent as Record<string, unknown>).tasks as Record<string, Record<string, unknown>>;
    expect((tasks['full-intelligence'].provider as Record<string, unknown>).type).toBe('anthropic');
    // ollama should be untouched
    expect((tasks['skill-survey'].provider as Record<string, unknown>).type).toBe('ollama');
  });

  it('renames per-phase provider override from cloud to anthropic', () => {
    const doc: Record<string, unknown> = {
      agent: {
        tasks: {
          'full-intelligence': {
            phases: {
              extract: { provider: { type: 'cloud' } },
              digest: { provider: { type: 'lmstudio', base_url: 'http://localhost:1234' } },
            },
          },
        },
      },
    };
    v4.migrate(doc, '/tmp');

    const tasks = (doc.agent as Record<string, unknown>).tasks as Record<string, Record<string, unknown>>;
    const phases = tasks['full-intelligence'].phases as Record<string, Record<string, unknown>>;
    expect((phases.extract.provider as Record<string, unknown>).type).toBe('anthropic');
    expect((phases.digest.provider as Record<string, unknown>).type).toBe('lmstudio');
  });

  it('is a no-op when no agent section exists', () => {
    const doc: Record<string, unknown> = { embedding: { provider: 'ollama' } };
    expect(() => v4.migrate(doc, '/tmp')).not.toThrow();
  });

  it('is a no-op when no provider is configured', () => {
    const doc: Record<string, unknown> = {
      agent: { scheduled_tasks_enabled: false },
    };
    v4.migrate(doc, '/tmp');
    const agent = doc.agent as Record<string, unknown>;
    expect(agent.provider).toBeUndefined();
  });
});

describe('CURRENT_MIGRATION_VERSION', () => {
  it('is 12', () => {
    expect(CURRENT_MIGRATION_VERSION).toBe(12);
  });
});

const v6 = MIGRATIONS.find((m) => m.version === 6)!;

describe('Migration v6: rename-full-intelligence-to-vault-evolve', () => {
  it('renames agent.tasks["full-intelligence"] to agent.tasks["vault-evolve"]', () => {
    const doc: Record<string, unknown> = {
      agent: {
        tasks: {
          'full-intelligence': {
            schedule: { enabled: true, intervalSeconds: 600 },
            model: 'claude-sonnet-4-6',
          },
        },
      },
    };
    v6.migrate(doc, '/tmp');

    const tasks = (doc.agent as Record<string, unknown>).tasks as Record<string, Record<string, unknown>>;
    expect(tasks['full-intelligence']).toBeUndefined();
    expect(tasks['vault-evolve']).toEqual({
      schedule: { enabled: true, intervalSeconds: 600 },
      model: 'claude-sonnet-4-6',
    });
  });

  it('keeps the existing vault-evolve entry when both keys are present', () => {
    const doc: Record<string, unknown> = {
      agent: {
        tasks: {
          'full-intelligence': { model: 'legacy' },
          'vault-evolve': { model: 'already-there' },
        },
      },
    };
    v6.migrate(doc, '/tmp');

    const tasks = (doc.agent as Record<string, unknown>).tasks as Record<string, Record<string, unknown>>;
    expect(tasks['full-intelligence']).toBeUndefined();
    expect(tasks['vault-evolve']).toEqual({ model: 'already-there' });
  });

  it('is a no-op when no full-intelligence key exists', () => {
    const doc: Record<string, unknown> = {
      agent: { tasks: { 'skill-survey': { schedule: { enabled: true } } } },
    };
    expect(() => v6.migrate(doc, '/tmp')).not.toThrow();
    const tasks = (doc.agent as Record<string, unknown>).tasks as Record<string, unknown>;
    expect(tasks['vault-evolve']).toBeUndefined();
  });

  it('is a no-op when there is no agent section', () => {
    const doc: Record<string, unknown> = { embedding: { provider: 'ollama' } };
    expect(() => v6.migrate(doc, '/tmp')).not.toThrow();
  });
});

describe('Migration v5: seed-settings-notification-domain-default', () => {
  it('adds the settings notification domain with banner mode when missing', () => {
    const doc: Record<string, unknown> = {
      notifications: {
        default_mode: 'summary',
      },
    };

    v5.migrate(doc, '/tmp');

    const notifications = doc.notifications as Record<string, unknown>;
    const domains = notifications.domains as Record<string, Record<string, unknown>>;
    expect(domains.settings).toEqual({
      enabled: true,
      mode: 'banner',
    });
  });

  it('preserves explicit settings domain preferences', () => {
    const doc: Record<string, unknown> = {
      notifications: {
        domains: {
          settings: {
            enabled: false,
            mode: 'summary',
          },
        },
      },
    };

    v5.migrate(doc, '/tmp');

    const notifications = doc.notifications as Record<string, unknown>;
    const domains = notifications.domains as Record<string, Record<string, unknown>>;
    expect(domains.settings).toEqual({
      enabled: false,
      mode: 'summary',
    });
  });
});

describe('runMigrations', () => {
  it('runs v3 through v12 when config_version is 2', () => {
    const doc: Record<string, unknown> = {
      config_version: 2,
      agent: { auto_run: true, interval_seconds: 300 },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(12);

    const agent = doc.agent as Record<string, unknown>;
    const tasks = agent.tasks as Record<string, Record<string, unknown>>;
    // v3 creates the schedule under the legacy key; v6 renames it.
    expect(tasks['full-intelligence']).toBeUndefined();
    expect(tasks['vault-evolve'].schedule).toBeDefined();
    const notifications = doc.notifications as Record<string, unknown>;
    const domains = notifications.domains as Record<string, Record<string, unknown>>;
    expect(domains.settings).toEqual({
      enabled: true,
      mode: 'banner',
    });
  });

  it('runs v4 onward when config_version is 3 (target v12)', () => {
    const doc: Record<string, unknown> = {
      config_version: 3,
      agent: { provider: { type: 'cloud' } },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(12);
    const agent = doc.agent as Record<string, unknown>;
    expect((agent.provider as Record<string, unknown>).type).toBe('anthropic');
  });

  it('runs v5 onward when config_version is 4 (target v11)', () => {
    const doc: Record<string, unknown> = {
      config_version: 4,
      notifications: {
        default_mode: 'summary',
      },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(12);

    const notifications = doc.notifications as Record<string, unknown>;
    const domains = notifications.domains as Record<string, Record<string, unknown>>;
    expect(domains.settings).toEqual({
      enabled: true,
      mode: 'banner',
    });
  });

  it('runs v6 through v11 when config_version is 5', () => {
    const doc: Record<string, unknown> = {
      config_version: 5,
      agent: { tasks: { 'full-intelligence': { model: 'claude-sonnet-4-6' } } },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(12);
    const tasks = (doc.agent as Record<string, unknown>).tasks as Record<string, Record<string, unknown>>;
    expect(tasks['full-intelligence']).toBeUndefined();
    expect(tasks['vault-evolve']).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('runs v7 through v11 when config_version is 6', () => {
    const doc: Record<string, unknown> = {
      config_version: 6,
      agent: { auto_run: true, provider: { type: 'cloud' } },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(12);
    const agent = doc.agent as Record<string, unknown>;
    expect(agent.auto_run).toBe(true);
    expect((agent.provider as Record<string, unknown>).type).toBe('cloud');
  });

  it('runs v9 through v11 when config_version is 8', () => {
    const doc: Record<string, unknown> = {
      config_version: 8,
      agent: { auto_run: true, provider: { type: 'cloud' } },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(12);
    const agent = doc.agent as Record<string, unknown>;
    expect(agent.auto_run).toBe(true);
    expect((agent.provider as Record<string, unknown>).type).toBe('cloud');
  });

  it('skips all migrations when config_version is already 12', () => {
    const doc: Record<string, unknown> = {
      config_version: 12,
      agent: { auto_run: true, provider: { type: 'cloud' } },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(false);
    const agent = doc.agent as Record<string, unknown>;
    expect(agent.auto_run).toBe(true);
    expect((agent.provider as Record<string, unknown>).type).toBe('cloud');
  });
});

/**
 * v7 strips baseline duplicates from canopy.exclude.patterns. v8 then
 * moves the canopy block under cortex.canopy. Tests run the full chain
 * and assert on the post-v8 location.
 */
describe('Migration v7: dedupe-canopy-exclude-patterns-against-baseline', () => {
  it('strips entries that exactly match the new Myco baseline', () => {
    const doc: Record<string, unknown> = {
      config_version: 6,
      canopy: {
        exclude: {
          patterns: [
            'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
            '**/*.lock', '**/package-lock.json',
            'fixtures/large/**', '**/*.snap',
          ],
        },
      },
    };
    runMigrations(doc, '/tmp');
    // After v8, canopy.exclude lives under cortex.canopy.exclude.
    const patterns = (((doc.cortex as Record<string, unknown>).canopy as Record<string, unknown>)
      .exclude as Record<string, unknown>).patterns;
    expect(patterns).toEqual(['fixtures/large/**', '**/*.snap']);
  });

  it('leaves the array alone when no entries match the baseline', () => {
    const doc: Record<string, unknown> = {
      config_version: 6,
      canopy: { exclude: { patterns: ['fixtures/large/**', '**/*.snap'] } },
    };
    runMigrations(doc, '/tmp');
    const patterns = (((doc.cortex as Record<string, unknown>).canopy as Record<string, unknown>)
      .exclude as Record<string, unknown>).patterns;
    expect(patterns).toEqual(['fixtures/large/**', '**/*.snap']);
  });

  it('is a no-op when canopy.exclude is missing', () => {
    const doc: Record<string, unknown> = { config_version: 6 };
    expect(() => runMigrations(doc, '/tmp')).not.toThrow();
    expect(doc.config_version).toBe(12);
  });
});

const v8 = MIGRATIONS.find((m) => m.version === 8)!;

describe('Migration v8: unify-cortex-config-shape', () => {
  it('moves context.* injection settings under cortex.*', () => {
    const doc: Record<string, unknown> = {
      config_version: 7,
      context: {
        cortex_enabled: false,
        digest_tier: 1500,
        session_start_digest_enabled: true,
        prompt_search: false,
        prompt_max_spores: 7,
      },
    };
    v8.migrate(doc, '/tmp');
    expect(doc.context).toBeUndefined();
    const cortex = doc.cortex as Record<string, Record<string, unknown>>;
    expect(cortex.instructions).toEqual({ inject_on_session_start: false });
    expect(cortex.digest).toEqual({ tier: 1500, inject_on_session_start: true });
    expect(cortex.spores).toEqual({ inject_on_prompt_submit: false, max_per_prompt: 7 });
  });

  it('moves root canopy.* (refresh + exclude) under cortex.canopy.*', () => {
    const doc: Record<string, unknown> = {
      config_version: 7,
      canopy: {
        refresh: { background_enabled: false, background_period_minutes: 15 },
        exclude: { patterns: ['custom/**'] },
      },
    };
    v8.migrate(doc, '/tmp');
    expect(doc.canopy).toBeUndefined();
    const canopy = (doc.cortex as Record<string, Record<string, unknown>>).canopy;
    expect(canopy.refresh).toEqual({ background_enabled: false, background_period_minutes: 15 });
    expect((canopy.exclude as Record<string, unknown>).patterns).toEqual(['custom/**']);
  });

  it('flattens cortex.canopy.injection.* onto cortex.canopy', () => {
    const doc: Record<string, unknown> = {
      config_version: 7,
      cortex: { canopy: { injection: { enabled: false, size_threshold: 1200 } } },
    };
    v8.migrate(doc, '/tmp');
    const canopy = (doc.cortex as Record<string, Record<string, unknown>>).canopy;
    expect(canopy.injection).toBeUndefined();
    expect(canopy.inject_on_pre_tool_use).toBe(false);
    expect(canopy.min_file_bytes).toBe(1200);
  });

  it('handles a sparse local.yaml-style doc without throwing', () => {
    // local.yaml might have ONLY a single override under context. The
    // migration must tolerate every parent being missing.
    const doc: Record<string, unknown> = {
      context: { prompt_max_spores: 10 },
    };
    expect(() => v8.migrate(doc, '/tmp')).not.toThrow();
    expect(doc.context).toBeUndefined();
    const cortex = doc.cortex as Record<string, Record<string, unknown>>;
    expect(cortex.spores).toEqual({ max_per_prompt: 10 });
  });

  it('rewrites the legacy operating_brief_enabled key', () => {
    const doc: Record<string, unknown> = {
      context: { operating_brief_enabled: false },
    };
    v8.migrate(doc, '/tmp');
    expect(doc.context).toBeUndefined();
    const cortex = doc.cortex as Record<string, Record<string, unknown>>;
    expect(cortex.instructions).toEqual({ inject_on_session_start: false });
  });

  it('is a no-op on a doc that already uses the new shape', () => {
    const doc: Record<string, unknown> = {
      cortex: {
        enabled: true,
        digest: { tier: 5000 },
      },
    };
    expect(() => v8.migrate(doc, '/tmp')).not.toThrow();
    const cortex = doc.cortex as Record<string, Record<string, unknown>>;
    expect((cortex.digest as Record<string, unknown>).tier).toBe(5000);
  });
});

const v9 = MIGRATIONS.find((m) => m.version === 9)!;

describe('Migration v9: rename-agent-runtime-to-harness', () => {
  it('rewrites global, task, and provider runtime keys to harness', () => {
    const doc: Record<string, unknown> = {
      config_version: 8,
      agent: {
        runtime: 'claude-sdk',
        provider: {
          type: 'openai',
          model: 'gpt-5',
          runtime: 'openai-agents',
        },
        tasks: {
          'review-session': {
            runtime: 'openai-agents',
            provider: {
              type: 'openrouter',
              model: 'openai/gpt-5.4-mini',
              runtime: 'openai-agents',
            },
          },
          'skill-survey': {
            provider: {
              type: 'anthropic',
              model: 'claude-sonnet-4-6',
              runtime: 'claude-sdk',
            },
          },
        },
      },
    };

    v9.migrate(doc, '/tmp');

    const agent = doc.agent as Record<string, unknown>;
    expect(agent.runtime).toBeUndefined();
    expect(agent.harness).toBe('openai-agents');
    expect((agent.provider as Record<string, unknown>).runtime).toBeUndefined();

    const tasks = agent.tasks as Record<string, Record<string, unknown>>;
    expect(tasks['review-session'].runtime).toBeUndefined();
    expect(tasks['review-session'].harness).toBe('openai-agents');
    expect((tasks['review-session'].provider as Record<string, unknown>).runtime).toBeUndefined();
    expect(tasks['skill-survey'].harness).toBe('claude-sdk');
    expect((tasks['skill-survey'].provider as Record<string, unknown>).runtime).toBeUndefined();
  });

  it('preserves existing harness when both runtime and harness are present', () => {
    const doc: Record<string, unknown> = {
      agent: {
        runtime: 'claude-sdk',
        harness: 'openai-agents',
        tasks: {
          'review-session': {
            runtime: 'claude-sdk',
            harness: 'openai-agents',
          },
        },
      },
    };

    v9.migrate(doc, '/tmp');

    const agent = doc.agent as Record<string, unknown>;
    expect(agent.runtime).toBeUndefined();
    expect(agent.harness).toBe('openai-agents');
    const tasks = agent.tasks as Record<string, Record<string, unknown>>;
    expect(tasks['review-session'].runtime).toBeUndefined();
    expect(tasks['review-session'].harness).toBe('openai-agents');
  });

  it('preserves legacy global provider precedence over stale agent runtime', () => {
    const doc: Record<string, unknown> = {
      agent: {
        runtime: 'claude-sdk',
        provider: {
          type: 'openai',
        },
      },
    };

    v9.migrate(doc, '/tmp');

    const agent = doc.agent as Record<string, unknown>;
    expect(agent.runtime).toBeUndefined();
    expect(agent.harness).toBe('openai-agents');
  });

  it('removes phase provider runtime without introducing per-phase harness', () => {
    const doc: Record<string, unknown> = {
      agent: {
        tasks: {
          'vault-evolve': {
            phases: {
              map: {
                provider: {
                  type: 'openai-compatible',
                  runtime: 'openai-agents',
                },
              },
            },
          },
        },
      },
    };

    v9.migrate(doc, '/tmp');

    const tasks = (doc.agent as Record<string, unknown>).tasks as Record<string, Record<string, unknown>>;
    const phases = tasks['vault-evolve'].phases as Record<string, Record<string, unknown>>;
    expect(phases.map.harness).toBeUndefined();
    expect((phases.map.provider as Record<string, unknown>).runtime).toBeUndefined();
    expect((phases.map.provider as Record<string, unknown>).type).toBe('openai-compatible');
  });
});

describe('runMigrations on local.yaml: appliesToLocal flag', () => {
  it('skips v5 (notification-default seeder) when target = local without injecting defaults', () => {
    // Sparse local.yaml with no notifications block. Running the chain
    // with target='local' must NOT inject the notifications.domains.settings
    // defaults — that would override project-level config via merge.
    const doc: Record<string, unknown> = { appearance: { theme: 'sage' } };
    runMigrations(doc, '/tmp', undefined, 'local');
    expect(doc.notifications).toBeUndefined();
    // config_version stays untouched because no migration body actually
    // mutated this sparse doc — a stamp here would force a no-op
    // write-back of pre-existing legacy local.yaml files.
    expect(doc.config_version).toBeUndefined();
  });

  it('runs v8 (path rename) on a local.yaml with context overrides', () => {
    const doc: Record<string, unknown> = {
      context: { cortex_enabled: false, prompt_max_spores: 1 },
    };
    runMigrations(doc, '/tmp', undefined, 'local');
    expect(doc.context).toBeUndefined();
    const cortex = doc.cortex as Record<string, Record<string, unknown>>;
    expect(cortex.instructions).toEqual({ inject_on_session_start: false });
    expect(cortex.spores).toEqual({ max_per_prompt: 1 });
  });
});

describe('v11 — embedding.run_in_deep_sleep → prevent_deep_sleep', () => {
  it('carries the old value over and drops the old key', () => {
    const doc: Record<string, unknown> = {
      embedding: { provider: 'ollama', run_in_deep_sleep: false },
    };
    runMigrations(doc, '/tmp', undefined, 'project');
    const embedding = doc.embedding as Record<string, unknown>;
    expect(embedding.prevent_deep_sleep).toBe(false);
    expect('run_in_deep_sleep' in embedding).toBe(false);
    expect(embedding.provider).toBe('ollama');
  });

  it('does not invent the key on a doc that never had it', () => {
    // Key-relocation, not a seeder: a sparse local.yaml must stay sparse.
    const doc: Record<string, unknown> = { embedding: { provider: 'ollama' } };
    runMigrations(doc, '/tmp', undefined, 'local');
    const embedding = doc.embedding as Record<string, unknown>;
    expect('prevent_deep_sleep' in embedding).toBe(false);
  });

  it('leaves an already-migrated doc alone', () => {
    const doc: Record<string, unknown> = {
      embedding: { prevent_deep_sleep: true, run_in_deep_sleep: false },
    };
    runMigrations(doc, '/tmp', undefined, 'project');
    const embedding = doc.embedding as Record<string, unknown>;
    expect(embedding.prevent_deep_sleep).toBe(true);
    expect('run_in_deep_sleep' in embedding).toBe(false);
  });

  it('is a no-op when there is no embedding block at all', () => {
    const doc: Record<string, unknown> = { cortex: {} };
    expect(() => runMigrations(doc, '/tmp', undefined, 'project')).not.toThrow();
    expect(doc.embedding).toBeUndefined();
  });
});
