import { describe, it, expect } from 'vitest';
import { MycoConfigSchema } from '@myco/config/schema';
import type { MycoConfig } from '@myco/config/schema';
import { withValue, withEmbedding, withTaskConfig } from '@myco/config/updates';

function baseConfig(): MycoConfig {
  return MycoConfigSchema.parse({ version: 3 });
}

describe('withValue', () => {
  it('sets a top-level field', () => {
    const result = withValue(baseConfig(), 'daemon.log_level', 'debug');
    expect(result.daemon.log_level).toBe('debug');
  });

  it('sets a nested field', () => {
    const result = withValue(baseConfig(), 'embedding.model', 'nomic-embed-text');
    expect(result.embedding.model).toBe('nomic-embed-text');
  });

  it('creates intermediate objects along the path', () => {
    const config = baseConfig();
    const result = withValue(config, 'agent.provider.type', 'ollama');
    expect(result.agent.provider?.type).toBe('ollama');
  });

  it('sets numeric values correctly', () => {
    const result = withValue(baseConfig(), 'capture.buffer_max_events', 1000);
    expect(result.capture.buffer_max_events).toBe(1000);
  });

  it('preserves all other fields unchanged', () => {
    const config = baseConfig();
    const result = withValue(config, 'embedding.model', 'nomic-embed-text');
    expect(result.embedding.provider).toBe('ollama');
    expect(result.daemon.log_level).toBe('info');
  });

  it('does not mutate the input config', () => {
    const config = baseConfig();
    const originalModel = config.embedding.model;
    withValue(config, 'embedding.model', 'nomic-embed-text');
    expect(config.embedding.model).toBe(originalModel);
  });
});

describe('withEmbedding', () => {
  it('merges partial embedding updates', () => {
    const result = withEmbedding(baseConfig(), { model: 'nomic-embed-text' });
    expect(result.embedding.model).toBe('nomic-embed-text');
    expect(result.embedding.provider).toBe('ollama');
  });

  it('replaces provider and model together', () => {
    const result = withEmbedding(baseConfig(), {
      provider: 'openrouter',
      model: 'text-embedding-3-small',
      base_url: 'https://openrouter.ai/api/v1',
    });
    expect(result.embedding.provider).toBe('openrouter');
    expect(result.embedding.model).toBe('text-embedding-3-small');
    expect(result.embedding.base_url).toBe('https://openrouter.ai/api/v1');
  });

  it('does not mutate the input config', () => {
    const config = baseConfig();
    withEmbedding(config, { model: 'nomic-embed-text' });
    expect(config.embedding.model).toBe('bge-m3');
  });

  it('preserves non-embedding sections', () => {
    const config = baseConfig();
    config.daemon.log_level = 'debug';
    const result = withEmbedding(config, { model: 'nomic-embed-text' });
    expect(result.daemon.log_level).toBe('debug');
  });
});

describe('withTaskConfig', () => {
  it('sets provider on a new task entry', () => {
    const result = withTaskConfig(baseConfig(), 'title-summary', {
      provider: { type: 'ollama', model: 'granite4:small-h' },
    });
    expect(result.agent.tasks?.['title-summary']?.provider?.type).toBe('ollama');
    expect(result.agent.tasks?.['title-summary']?.provider?.model).toBe('granite4:small-h');
  });

  it('sets model and maxTurns', () => {
    const result = withTaskConfig(baseConfig(), 'title-summary', {
      model: 'granite4:small-h',
      maxTurns: 5,
    });
    expect(result.agent.tasks?.['title-summary']?.model).toBe('granite4:small-h');
    expect(result.agent.tasks?.['title-summary']?.maxTurns).toBe(5);
  });

  it('null removes a field from an existing task', () => {
    let config = withTaskConfig(baseConfig(), 'title-summary', {
      model: 'granite4:small-h',
      maxTurns: 5,
    });
    config = withTaskConfig(config, 'title-summary', { maxTurns: null });
    expect(config.agent.tasks?.['title-summary']?.model).toBe('granite4:small-h');
    expect(config.agent.tasks?.['title-summary']?.maxTurns).toBeUndefined();
  });

  it('null provider removes the provider', () => {
    let config = withTaskConfig(baseConfig(), 'title-summary', {
      provider: { type: 'ollama', model: 'granite4:small-h' },
    });
    config = withTaskConfig(config, 'title-summary', { provider: null });
    expect(config.agent.tasks?.['title-summary']?.provider).toBeUndefined();
  });

  it('sets phase-level overrides', () => {
    const result = withTaskConfig(baseConfig(), 'full-intelligence', {
      phases: {
        extraction: {
          provider: { type: 'ollama', model: 'granite4:small-h' },
          maxTurns: 3,
        },
      },
    });
    const phase = result.agent.tasks?.['full-intelligence']?.phases?.extraction;
    expect(phase?.provider?.type).toBe('ollama');
    expect(phase?.maxTurns).toBe(3);
  });

  it('null phase removes a specific phase', () => {
    let config = withTaskConfig(baseConfig(), 'full-intelligence', {
      phases: {
        extraction: { provider: { type: 'ollama' } },
        linking: { provider: { type: 'cloud' } },
      },
    });
    config = withTaskConfig(config, 'full-intelligence', {
      phases: { extraction: null },
    });
    expect(config.agent.tasks?.['full-intelligence']?.phases?.extraction).toBeUndefined();
    expect(config.agent.tasks?.['full-intelligence']?.phases?.linking).toBeDefined();
  });

  it('removes empty task entries', () => {
    let config = withTaskConfig(baseConfig(), 'title-summary', {
      model: 'granite4:small-h',
    });
    config = withTaskConfig(config, 'title-summary', { model: null });
    expect(config.agent.tasks?.['title-summary']).toBeUndefined();
  });

  it('removes empty phases map', () => {
    let config = withTaskConfig(baseConfig(), 'test-task', {
      model: 'some-model',
      phases: { extraction: { maxTurns: 3 } },
    });
    config = withTaskConfig(config, 'test-task', {
      phases: { extraction: null },
    });
    expect(config.agent.tasks?.['test-task']?.phases).toBeUndefined();
    expect(config.agent.tasks?.['test-task']?.model).toBe('some-model');
  });

  it('does not mutate the input config', () => {
    const config = baseConfig();
    withTaskConfig(config, 'title-summary', {
      provider: { type: 'ollama' },
    });
    expect(config.agent.tasks).toBeUndefined();
  });

  it('preserves existing tasks when updating a different task', () => {
    let config = withTaskConfig(baseConfig(), 'task-a', { model: 'model-a' });
    config = withTaskConfig(config, 'task-b', { model: 'model-b' });
    expect(config.agent.tasks?.['task-a']?.model).toBe('model-a');
    expect(config.agent.tasks?.['task-b']?.model).toBe('model-b');
  });
});
