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
  it('is 7', () => {
    expect(CURRENT_MIGRATION_VERSION).toBe(7);
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
  it('runs v3 through v6 when config_version is 2', () => {
    const doc: Record<string, unknown> = {
      config_version: 2,
      agent: { auto_run: true, interval_seconds: 300 },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(7);

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

  it('runs v4 onward when config_version is 3', () => {
    const doc: Record<string, unknown> = {
      config_version: 3,
      agent: { provider: { type: 'cloud' } },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(7);
    const agent = doc.agent as Record<string, unknown>;
    expect((agent.provider as Record<string, unknown>).type).toBe('anthropic');
  });

  it('runs v5 onward when config_version is 4', () => {
    const doc: Record<string, unknown> = {
      config_version: 4,
      notifications: {
        default_mode: 'summary',
      },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(7);

    const notifications = doc.notifications as Record<string, unknown>;
    const domains = notifications.domains as Record<string, Record<string, unknown>>;
    expect(domains.settings).toEqual({
      enabled: true,
      mode: 'banner',
    });
  });

  it('runs v6 and v7 when config_version is 5', () => {
    const doc: Record<string, unknown> = {
      config_version: 5,
      agent: { tasks: { 'full-intelligence': { model: 'claude-sonnet-4-6' } } },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(7);
    const tasks = (doc.agent as Record<string, unknown>).tasks as Record<string, Record<string, unknown>>;
    expect(tasks['full-intelligence']).toBeUndefined();
    expect(tasks['vault-evolve']).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('runs only v7 when config_version is 6', () => {
    const doc: Record<string, unknown> = {
      config_version: 6,
      agent: { auto_run: true, provider: { type: 'cloud' } },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(7);
    const agent = doc.agent as Record<string, unknown>;
    expect(agent.auto_run).toBe(true);
    expect((agent.provider as Record<string, unknown>).type).toBe('cloud');
  });

  it('skips all migrations when config_version is already 7', () => {
    const doc: Record<string, unknown> = {
      config_version: 7,
      agent: { auto_run: true, provider: { type: 'cloud' } },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(false);
    const agent = doc.agent as Record<string, unknown>;
    expect(agent.auto_run).toBe(true);
    expect((agent.provider as Record<string, unknown>).type).toBe('cloud');
  });
});

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
    const patterns = ((doc.canopy as Record<string, unknown>).exclude as Record<string, unknown>).patterns;
    // Only the user-genuine extras survive.
    expect(patterns).toEqual(['fixtures/large/**', '**/*.snap']);
  });

  it('leaves the array alone when no entries match the baseline', () => {
    const doc: Record<string, unknown> = {
      config_version: 6,
      canopy: { exclude: { patterns: ['fixtures/large/**', '**/*.snap'] } },
    };
    runMigrations(doc, '/tmp');
    const patterns = ((doc.canopy as Record<string, unknown>).exclude as Record<string, unknown>).patterns;
    expect(patterns).toEqual(['fixtures/large/**', '**/*.snap']);
  });

  it('is a no-op when canopy.exclude is missing', () => {
    const doc: Record<string, unknown> = { config_version: 6 };
    expect(() => runMigrations(doc, '/tmp')).not.toThrow();
    expect(doc.config_version).toBe(7);
  });
});
