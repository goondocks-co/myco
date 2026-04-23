/**
 * SSRF defense on /api/providers/test and /api/models.
 *
 * Caller-supplied baseUrl MUST be ignored for `openai`/`openrouter` so the
 * daemon's stored bearer key is never sent to an attacker-controlled host.
 * `openai-compatible` / `ollama` / `lmstudio` remain user-configurable.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleTestProvider } from '@myco/daemon/api/providers';
import { handleGetModels } from '@myco/daemon/api/models';
import { OPENAI_API_KEY_ENV } from '@myco/cli/providers/openai-embeddings.js';
import { OPENROUTER_API_KEY_ENV } from '@myco/cli/providers/openrouter.js';

const fetchMock = vi.fn();
global.fetch = fetchMock as unknown as typeof fetch;

mock.module('@myco/intelligence/ollama.js', () => ({
  OllamaBackend: class {
    static DEFAULT_BASE_URL = 'http://localhost:11434';
    async isAvailable() { return true; }
    async listModels() { return []; }
  },
}));
mock.module('@myco/intelligence/lm-studio.js', () => ({
  LmStudioBackend: class {
    static DEFAULT_BASE_URL = 'http://localhost:1234';
    async isAvailable() { return true; }
    async listModels() { return []; }
  },
}));

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
});

describe('POST /api/providers/test — SSRF defense', () => {
  it('IGNORES caller-supplied baseUrl for openai (uses hardcoded default)', async () => {
    vi.stubEnv(OPENAI_API_KEY_ENV, 'sk-sentinel-ssrf');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'gpt-5' }] }) });

    const result = await handleTestProvider({
      body: { type: 'openai', baseUrl: 'https://attacker.example/v1' },
      query: {}, params: {}, pathname: '/api/providers/test',
    });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl.startsWith('https://api.openai.com/v1/')).toBe(true);
    expect(calledUrl).not.toContain('attacker.example');
  });

  it('IGNORES caller-supplied baseUrl for openrouter (uses hardcoded default)', async () => {
    vi.stubEnv(OPENROUTER_API_KEY_ENV, 'sk-sentinel-ssrf');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'openai/gpt-5' }] }) });

    const result = await handleTestProvider({
      body: { type: 'openrouter', base_url: 'https://attacker.example/v1' },
      query: {}, params: {}, pathname: '/api/providers/test',
    });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl.startsWith('https://openrouter.ai/api/v1/')).toBe(true);
    expect(calledUrl).not.toContain('attacker.example');
  });

  it('HONORS caller-supplied baseUrl for openai-compatible (legitimate local path)', async () => {
    const result = await handleTestProvider({
      body: { type: 'openai-compatible', baseUrl: 'http://localhost:8080' },
      query: {}, params: {}, pathname: '/api/providers/test',
    });
    // We don't assert on outcome; just that the code path accepted the baseUrl
    // (backend mocks always report available), and importantly did NOT call
    // out to https://attacker.example.
    expect(result.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/models — SSRF defense', () => {
  it('IGNORES caller-supplied base_url for openai', async () => {
    vi.stubEnv(OPENAI_API_KEY_ENV, 'sk-sentinel-ssrf');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'gpt-5' }] }) });

    await handleGetModels({
      body: undefined, params: {}, pathname: '/api/models',
      query: { provider: 'openai', base_url: 'https://attacker.example/v1' },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl.startsWith('https://api.openai.com/v1/')).toBe(true);
  });

  it('IGNORES caller-supplied base_url for openrouter', async () => {
    vi.stubEnv(OPENROUTER_API_KEY_ENV, 'sk-sentinel-ssrf');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'gpt-5' }] }) });

    await handleGetModels({
      body: undefined, params: {}, pathname: '/api/models',
      query: { provider: 'openrouter', base_url: 'https://attacker.example/v1' },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl.startsWith('https://openrouter.ai/api/v1/')).toBe(true);
  });
});
