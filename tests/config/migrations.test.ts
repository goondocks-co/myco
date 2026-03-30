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

describe('CURRENT_MIGRATION_VERSION', () => {
  it('is 3', () => {
    expect(CURRENT_MIGRATION_VERSION).toBe(3);
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
    expect(doc.config_version).toBe(3);

    const agent = doc.agent as Record<string, unknown>;
    const tasks = agent.tasks as Record<string, Record<string, unknown>>;
    expect(tasks['full-intelligence'].schedule).toBeDefined();
  });

  it('skips v3 when config_version is already 3', () => {
    const doc: Record<string, unknown> = {
      config_version: 3,
      agent: { auto_run: true },
    };
    const ran = runMigrations(doc, '/tmp');
    expect(ran).toBe(false);
    // auto_run should NOT have been touched
    const agent = doc.agent as Record<string, unknown>;
    expect(agent.auto_run).toBe(true);
  });
});
