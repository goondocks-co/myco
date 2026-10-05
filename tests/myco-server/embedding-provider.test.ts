import { DIAGNOSTIC_PAYLOADS } from '../helpers/secret-corpus.ts';
import type { OutboundFetch } from '@myco-server-worker/core/adapters.js';
import { jsonBody } from '../helpers/json-body.js';
import { afterEach, expect, test } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { settingsWriter } from '../../packages/myco-server/src/core/settings.js';
import { deploymentSecretStore } from '../../packages/myco-server/src/core/secrets.js';
import { configuredEmbeddingProvider } from '../../packages/myco-server/src/core/embedding/configured-provider.js';
import { EMBEDDING_TEXT_CHARS, EmbeddingUnavailable, embeddingDiagnostic } from '../../packages/myco-server/src/core/embedding/provider.js';
import { cloudflareEmbeddingProvider, EMBEDDING_MODEL } from '../../packages/myco-server/src/platform/cloudflare/embedding.js';
import { wrappingKeyFromText } from '../../packages/myco-server/src/platform/wrapping-key.js';
import { BUN_EMBEDDING_PLATFORM } from '../../packages/myco-server/src/platform/bun/env.js';

const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });
function fixture() {
  const f = sqliteEnv(); opened.push(f);
  const key = wrappingKeyFromText(async () => btoa('k'.repeat(32)), 'test');
  const settings = settingsWriter(f.db, { target: 'bun' });
  const configure = async (provider: string, base?: string) => {
    expect(await settings.setLeaf('embedding.provider', provider, 'operator', 1)).toEqual({ applied: true });
    if (base) expect(await settings.setLeaf('embedding.base_url', base, 'operator', 1)).toEqual({ applied: true });
  };
  return { ...f, key, configure, secrets: deploymentSecretStore(f.db, key) };
}

/** The hosted default selection, under the vector identity hosted Deployments already hold. */
const BGE_M3 = { model: EMBEDDING_MODEL, modelKey: JSON.stringify(['cloudflare', EMBEDDING_MODEL]) };

test('Cloudflare calls the selected Workers AI model with bounded input', async () => {
  const calls: unknown[] = [];
  const provider = cloudflareEmbeddingProvider({ run: async (...args) => { calls.push(args); return { data: [[1, 0]] }; } }, BGE_M3);
  expect(await provider.embed('x'.repeat(EMBEDDING_TEXT_CHARS * 2))).toEqual([1, 0]);
  expect(calls).toEqual([[EMBEDDING_MODEL, { text: [expect.stringContaining('[content truncated]')] }, { signal: expect.any(AbortSignal) }]]);
  expect((calls[0] as [string, { text: string[] }])[1].text[0].length).toBeLessThanOrEqual(EMBEDDING_TEXT_CHARS);
  await expect(cloudflareEmbeddingProvider({ run: async () => { throw new Error('provider details'); } }, BGE_M3).embed('query')).rejects.toBeInstanceOf(EmbeddingUnavailable);
  await expect(cloudflareEmbeddingProvider({ run: async () => ({ data: [[0, 0]] }) }, BGE_M3).embed('query')).rejects.not.toBeInstanceOf(EmbeddingUnavailable);
});

test('self-hosted Ollama and OpenAI-compatible endpoints use their configured protocol without fixed-provider credentials', async () => {
  for (const [provider, base, endpoint, response] of [
    ['ollama', 'http://models:11434', 'http://models:11434/api/embed', { embeddings: [[1, 0]] }],
    ['openai-compatible', 'https://models.example/v1/', 'https://models.example/v1/embeddings', { data: [{ embedding: [1, 0] }] }],
  ] as const) {
    const f = fixture();
    await f.configure(provider, base);
    await f.secrets.put('openai', 'fixed-provider-credential', 'operator', 1);
    let request: Request | undefined;
    const outbound = ((url, init) => { request = new Request(url as string, init as RequestInit); return Promise.resolve(Response.json(response)); }) as OutboundFetch;
    const client = (await configuredEmbeddingProvider(f.db, f.key, outbound, BUN_EMBEDDING_PLATFORM))!;
    expect(await client.embed('project architecture')).toEqual([1, 0]);
    expect(request!.url).toBe(endpoint);
    expect(request!.headers.get('authorization')).toBeNull();
    expect(request!.redirect).toBe('error');
    expect(await jsonBody(request!)).toEqual({ model: 'bge-m3', input: ['project architecture'] });
  }
});

test('a fixed provider requires its own sealed credential and refuses an endpoint of its own', async () => {
  const f = fixture();
  await f.configure('openai');
  let request: Request | undefined;
  const outbound = (async (url: string, init: RequestInit) => { request = new Request(url, init); return Response.json({ data: [{ embedding: [1, 0] }] }); }) as typeof fetch;
  expect(await configuredEmbeddingProvider(f.db, f.key, outbound, BUN_EMBEDDING_PLATFORM)).toBeNull();
  await f.secrets.put('openai', 'fixed-provider-credential', 'operator', 1);
  await (await configuredEmbeddingProvider(f.db, f.key, outbound, BUN_EMBEDDING_PLATFORM))!.embed('query');
  expect(request!.url).toBe('https://api.openai.com/v1/embeddings');
  expect(request!.headers.get('authorization')).toBe('Bearer fixed-provider-credential');
  expect(await settingsWriter(f.db, { target: 'bun' }).setLeaf('embedding.base_url', 'https://custom.example/v1', 'operator', 2))
    .toMatchObject({ applied: false, refusal: { reason: 'invalid_value', detail: expect.stringContaining('uses its own endpoint') } });
});

test('provider outages allow fallback while malformed successful replies remain errors', async () => {
  const f = fixture(); await f.configure('ollama');
  for (const response of [new Response(null, { status: 503 }), Response.json({ embeddings: [[NaN]] }), Response.json({ embeddings: [[0, 0]] })]) {
    const client = (await configuredEmbeddingProvider(f.db, f.key, (async () => response) as OutboundFetch, BUN_EMBEDDING_PLATFORM))!;
    if (response.status === 503) await expect(client.embed('query')).rejects.toBeInstanceOf(EmbeddingUnavailable);
    else await expect(client.embed('query')).rejects.not.toBeInstanceOf(EmbeddingUnavailable);
  }
});

test('OpenRouter preserves its existing default model and opens only its own credential', async () => {
  const f = fixture(); await f.configure('openrouter');
  await f.secrets.put('openrouter', 'router-credential', 'operator', 1);
  await f.secrets.put('openai', 'openai-credential', 'operator', 1);
  let request: Request | undefined;
  const provider = (await configuredEmbeddingProvider(f.db, f.key, (async (url: string, init: RequestInit) => {
    request = new Request(url, init); return Response.json({ data: [{ embedding: [1, 0] }] });
  }) as typeof fetch, BUN_EMBEDDING_PLATFORM))!;
  await provider.embed('query');
  expect(request!.url).toBe('https://openrouter.ai/api/v1/embeddings');
  expect(request!.headers.get('authorization')).toBe('Bearer router-credential');
  expect((await jsonBody<{ model: string }>(request!)).model).toBe('openai/text-embedding-3-small');
});

for (const leak of DIAGNOSTIC_PAYLOADS) {
  test(`HTTP and binding failures project ${leak.name} before returning diagnostic detail`, async () => {
    const f = fixture();
    await f.configure('ollama');
    const http = (await configuredEmbeddingProvider(f.db, f.key, (async () => new Response(leak.command, { status: 400 })) as OutboundFetch, BUN_EMBEDDING_PLATFORM))!;
    const binding = cloudflareEmbeddingProvider({ run: async () => { throw new Error(leak.command); } }, BGE_M3);
    for (const provider of [http, binding]) {
      let caught: unknown;
      try { await provider.embed('source knowledge'); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(EmbeddingUnavailable);
      if (!(caught instanceof EmbeddingUnavailable)) throw new Error('provider failure missing');
      const diagnostic = JSON.stringify([caught.failure, embeddingDiagnostic(caught.failure)]);
      for (const secret of leak.secrets) expect(diagnostic).not.toContain(secret);
      if (provider === http) expect(caught.failure).toMatchObject({ kind: 'http', status: 400 });
      else if (leak.command.includes('4006')) expect(caught.failure.kind).toBe('quota');
      else if (leak.command.includes('3010')) expect(caught.failure.kind).toBe('input');
      else expect(caught.failure.kind).toBe('unreachable');
    }
  });
}
