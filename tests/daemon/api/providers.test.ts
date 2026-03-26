/**
 * Tests for the providers API route handlers.
 *
 * Tests cover:
 * - handleGetProviders response shape
 * - handleTestProvider input validation
 * - handleTestProvider with valid provider types
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleGetProviders, handleTestProvider } from '@myco/daemon/api/providers';

// ---------------------------------------------------------------------------
// Mock: intelligence backends (avoid real network calls)
// ---------------------------------------------------------------------------

let ollamaAvailable = false;
let ollamaModels: string[] = [];
let lmStudioAvailable = false;
let lmStudioModels: string[] = [];

vi.mock('@myco/intelligence/ollama.js', () => ({
  OllamaBackend: class {
    static DEFAULT_BASE_URL = 'http://localhost:11434';
    async isAvailable() { return ollamaAvailable; }
    async listModels() { return ollamaModels; }
  },
}));

vi.mock('@myco/intelligence/lm-studio.js', () => ({
  LmStudioBackend: class {
    static DEFAULT_BASE_URL = 'http://localhost:1234';
    async isAvailable() { return lmStudioAvailable; }
    async listModels() { return lmStudioModels; }
  },
}));

afterEach(() => {
  ollamaAvailable = false;
  ollamaModels = [];
  lmStudioAvailable = false;
  lmStudioModels = [];
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// handleGetProviders
// ---------------------------------------------------------------------------

describe('handleGetProviders', () => {
  it('returns an array of providers', async () => {
    const result = await handleGetProviders();

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty('providers');
    const providers = (result.body as { providers: unknown[] }).providers;
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBe(3);
  });

  it('each provider has type, available, and models fields', async () => {
    const result = await handleGetProviders();
    const providers = (result.body as { providers: Array<Record<string, unknown>> }).providers;

    for (const p of providers) {
      expect(p).toHaveProperty('type');
      expect(p).toHaveProperty('available');
      expect(p).toHaveProperty('models');
      expect(Array.isArray(p.models)).toBe(true);
    }
  });

  it('reports ollama as available when backend responds', async () => {
    ollamaAvailable = true;
    ollamaModels = ['llama3', 'codellama'];

    const result = await handleGetProviders();
    const providers = (result.body as { providers: Array<Record<string, unknown>> }).providers;
    const ollama = providers.find((p) => p.type === 'ollama');

    expect(ollama).toBeDefined();
    expect(ollama!.available).toBe(true);
    expect(ollama!.models).toEqual(['llama3', 'codellama']);
  });

  it('always reports cloud as available', async () => {
    const result = await handleGetProviders();
    const providers = (result.body as { providers: Array<Record<string, unknown>> }).providers;
    const cloud = providers.find((p) => p.type === 'cloud');

    expect(cloud).toBeDefined();
    expect(cloud!.available).toBe(true);
    expect((cloud!.models as string[]).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// handleTestProvider — input validation
// ---------------------------------------------------------------------------

describe('handleTestProvider — validation', () => {
  it('returns 400 when type is missing', async () => {
    const result = await handleTestProvider({
      body: {},
      query: {},
      params: {},
      pathname: '/api/providers/test',
    });

    expect(result.status).toBe(400);
    expect((result.body as Record<string, unknown>).error).toBeDefined();
  });

  it('returns 400 for invalid provider type', async () => {
    const result = await handleTestProvider({
      body: { type: 'openai' },
      query: {},
      params: {},
      pathname: '/api/providers/test',
    });

    expect(result.status).toBe(400);
  });

  it('returns 400 when body is undefined', async () => {
    const result = await handleTestProvider({
      body: undefined,
      query: {},
      params: {},
      pathname: '/api/providers/test',
    });

    expect(result.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// handleTestProvider — valid providers
// ---------------------------------------------------------------------------

describe('handleTestProvider — connectivity', () => {
  it('tests ollama connectivity successfully', async () => {
    ollamaAvailable = true;

    const result = await handleTestProvider({
      body: { type: 'ollama' },
      query: {},
      params: {},
      pathname: '/api/providers/test',
    });

    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.latency_ms).toBeTypeOf('number');
  });

  it('tests ollama connectivity failure', async () => {
    ollamaAvailable = false;

    const result = await handleTestProvider({
      body: { type: 'ollama' },
      query: {},
      params: {},
      pathname: '/api/providers/test',
    });

    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();
  });

  it('tests cloud provider with API key set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');

    const result = await handleTestProvider({
      body: { type: 'cloud' },
      query: {},
      params: {},
      pathname: '/api/providers/test',
    });

    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it('tests cloud provider always returns ok', async () => {
    const result = await handleTestProvider({
      body: { type: 'cloud' },
      query: {},
      params: {},
      pathname: '/api/providers/test',
    });

    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });
});
