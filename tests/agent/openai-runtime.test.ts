import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import type { ProviderConfig } from '@myco/agent/types.js';
import { resolveOpenAIClientConfig, shouldUseResponsesApi } from '@myco/agent/harness/openai.js';
import { OPENAI_API_KEY_ENV, OPENROUTER_API_KEY_ENV } from '@myco/providers/env.js';

const LOCAL_BASE_URL = 'http://localhost:11434/v1';

describe('resolveOpenAIClientConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows openai-compatible providers without a configured key', () => {
    const provider: ProviderConfig = {
      type: 'openai-compatible',
      baseUrl: LOCAL_BASE_URL,
      model: 'google/gemma-4-26b-a4b',
    };

    expect(resolveOpenAIClientConfig(provider)).toEqual({
      apiKey: 'myco-local-openai-compatible',
      baseURL: LOCAL_BASE_URL,
    });
  });

  it('prefers an explicit openai-compatible key when configured', () => {
    const provider: ProviderConfig = {
      type: 'openai-compatible',
      baseUrl: LOCAL_BASE_URL,
      model: 'google/gemma-4-26b-a4b',
      apiKey: 'lmstudio-secret',
    };

    expect(resolveOpenAIClientConfig(provider)).toEqual({
      apiKey: 'lmstudio-secret',
      baseURL: LOCAL_BASE_URL,
    });
  });

  it('uses OpenAI env auth for the OpenAI provider', () => {
    vi.stubEnv(OPENAI_API_KEY_ENV, 'sk-openai');
    const provider: ProviderConfig = {
      type: 'openai',
      model: 'gpt-5.4-mini',
    };

    expect(resolveOpenAIClientConfig(provider)).toEqual({
      apiKey: 'sk-openai',
      baseURL: 'https://api.openai.com/v1',
    });
  });

  it('uses OpenRouter env auth for the OpenRouter provider', () => {
    vi.stubEnv(OPENROUTER_API_KEY_ENV, 'sk-openrouter');
    const provider: ProviderConfig = {
      type: 'openrouter',
      model: 'openrouter/auto',
    };

    expect(resolveOpenAIClientConfig(provider)).toEqual({
      apiKey: 'sk-openrouter',
      baseURL: 'https://openrouter.ai/api/v1',
    });
  });

  it('defaults Ollama-backed OpenAI runtime calls to the Ollama port', () => {
    expect(resolveOpenAIClientConfig({
      type: 'ollama',
      model: 'gemma4:26b',
    })).toEqual({
      apiKey: 'myco-local-openai-compatible',
      baseURL: 'http://localhost:11434/v1',
    });
  });

  it('normalizes localhost openai-compatible roots to the OpenAI /v1 path', () => {
    expect(resolveOpenAIClientConfig({
      type: 'openai-compatible',
      baseUrl: 'http://localhost:1234',
      model: 'google/gemma-4-26b-a4b',
    })).toEqual({
      apiKey: 'myco-local-openai-compatible',
      baseURL: 'http://localhost:1234/v1',
    });
  });

  it('uses the explicit local backend default for openai-compatible ollama', () => {
    expect(resolveOpenAIClientConfig({
      type: 'openai-compatible',
      localBackend: 'ollama',
      model: 'gemma4:26b',
    })).toEqual({
      apiKey: 'myco-local-openai-compatible',
      baseURL: 'http://localhost:11434/v1',
    });
  });

  it('uses chat completions mode for local-compatible providers', () => {
    expect(shouldUseResponsesApi({
      type: 'openai-compatible',
      baseUrl: LOCAL_BASE_URL,
      model: 'google/gemma-4-26b-a4b',
    })).toBe(false);
  });

  it('keeps responses mode for frontier OpenAI providers', () => {
    expect(shouldUseResponsesApi({
      type: 'openai',
      model: 'gpt-5.4-mini',
    })).toBe(true);
    expect(shouldUseResponsesApi({
      type: 'openrouter',
      model: 'openrouter/auto',
    })).toBe(true);
  });
});
