import { describe, it, expect } from 'vitest';
import {
  buildEmbeddingConfig,
  buildAgentConfig,
  type WizardAnswers,
} from '@myco/cli/init-wizard';

describe('buildEmbeddingConfig', () => {
  it('builds ollama config', () => {
    const answers: WizardAnswers = {
      intelligenceProvider: 'cloud',
      embeddingProvider: 'ollama',
      embeddingModel: 'bge-m3',
    };
    const config = buildEmbeddingConfig(answers);
    expect(config).toEqual({
      provider: 'ollama',
      model: 'bge-m3',
    });
  });

  it('builds openrouter config without api_key in output', () => {
    const answers: WizardAnswers = {
      intelligenceProvider: 'cloud',
      embeddingProvider: 'openrouter',
      embeddingModel: 'openai/text-embedding-3-small',
      embeddingApiKey: 'sk-or-test',
    };
    const config = buildEmbeddingConfig(answers);
    expect(config).toEqual({
      provider: 'openrouter',
      model: 'openai/text-embedding-3-small',
    });
  });

  it('builds openai config without api_key in output', () => {
    const answers: WizardAnswers = {
      intelligenceProvider: 'cloud',
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      embeddingApiKey: 'sk-test',
    };
    const config = buildEmbeddingConfig(answers);
    expect(config).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
  });

  it('builds skip config with defaults', () => {
    const answers: WizardAnswers = {
      intelligenceProvider: 'cloud',
      embeddingProvider: 'skip',
    };
    const config = buildEmbeddingConfig(answers);
    expect(config).toEqual({
      provider: 'ollama',
      model: 'bge-m3',
    });
  });
});

describe('buildAgentConfig', () => {
  it('returns cloud provider config', () => {
    const answers: WizardAnswers = {
      intelligenceProvider: 'cloud',
      embeddingProvider: 'ollama',
    };
    expect(buildAgentConfig(answers)).toEqual({
      provider: { type: 'cloud' },
    });
  });

  it('returns ollama provider config with model', () => {
    const answers: WizardAnswers = {
      intelligenceProvider: 'ollama',
      intelligenceModel: 'llama3.2',
      embeddingProvider: 'ollama',
    };
    expect(buildAgentConfig(answers)).toEqual({
      provider: { type: 'ollama', model: 'llama3.2' },
      model: 'llama3.2',
    });
  });

  it('returns lmstudio provider config with model and base_url', () => {
    const answers: WizardAnswers = {
      intelligenceProvider: 'lmstudio',
      intelligenceModel: 'qwen2.5-7b',
      intelligenceBaseUrl: 'http://localhost:1234',
      embeddingProvider: 'ollama',
    };
    expect(buildAgentConfig(answers)).toEqual({
      provider: {
        type: 'lmstudio',
        model: 'qwen2.5-7b',
        base_url: 'http://localhost:1234',
      },
      model: 'qwen2.5-7b',
    });
  });

  it('omits base_url when not provided', () => {
    const answers: WizardAnswers = {
      intelligenceProvider: 'ollama',
      intelligenceModel: 'llama3.2',
      embeddingProvider: 'skip',
    };
    const config = buildAgentConfig(answers);
    expect(config?.provider).not.toHaveProperty('base_url');
  });
});
