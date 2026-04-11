import { describe, it, expect } from 'vitest';
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
  it('is 4', () => {
    expect(CURRENT_MIGRATION_VERSION).toBe(4);
  });
});

describe('runMigrations', () => {
  it('runs v3 when config_version is 2', () => {
    const doc: Record<string, unknown> = {
      config_version: 2,
      agent: { auto_run: true, interval_seconds: 300 },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(4);

    const agent = doc.agent as Record<string, unknown>;
    const tasks = agent.tasks as Record<string, Record<string, unknown>>;
    expect(tasks['full-intelligence'].schedule).toBeDefined();
  });

  it('runs v4 when config_version is 3', () => {
    const doc: Record<string, unknown> = {
      config_version: 3,
      agent: { provider: { type: 'cloud' } },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(true);
    expect(doc.config_version).toBe(4);
    const agent = doc.agent as Record<string, unknown>;
    expect((agent.provider as Record<string, unknown>).type).toBe('anthropic');
  });

  it('skips all migrations when config_version is already 4', () => {
    const doc: Record<string, unknown> = {
      config_version: 4,
      agent: { auto_run: true, provider: { type: 'cloud' } },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(false);
    // auto_run and cloud should NOT have been touched
    const agent = doc.agent as Record<string, unknown>;
    expect(agent.auto_run).toBe(true);
    expect((agent.provider as Record<string, unknown>).type).toBe('cloud');
  });
});
