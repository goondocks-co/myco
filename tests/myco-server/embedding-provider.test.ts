import { afterEach, expect, test } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { settingsWriter } from '../../packages/myco-server/src/core/settings.js';
import { deploymentSecretStore } from '../../packages/myco-server/src/core/secrets.js';
import { configuredEmbeddingProvider } from '../../packages/myco-server/src/core/embedding/configured-provider.js';
import { EMBEDDING_TEXT_CHARS, EmbeddingUnavailable } from '../../packages/myco-server/src/core/embedding/provider.js';
import { cloudflareEmbeddingProvider, EMBEDDING_MODEL } from '../../packages/myco-server/src/platform/cloudflare/embedding.js';
import { wrappingKeyFromText } from '../../packages/myco-server/src/platform/wrapping-key.js';

const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });
function fixture() {
  const f = sqliteEnv(); opened.push(f);
  const key = wrappingKeyFromText(async () => btoa('k'.repeat(32)), 'test');
  const settings = settingsWriter(f.db);
  const configure = async (provider: string, base?: string) => {
    expect(await settings.setLeaf('embedding.provider', provider, 'operator', 1)).toEqual({ applied: true });
    if (base) expect(await settings.setLeaf('embedding.base_url', base, 'operator', 1)).toEqual({ applied: true });
  };
  return { ...f, key, configure, secrets: deploymentSecretStore(f.db, key) };
}

test('Cloudflare always calls the bound bge-m3 model with bounded input', async () => {
  const calls: unknown[] = [];
  const provider = cloudflareEmbeddingProvider({ run: async (...args) => { calls.push(args); return { data: [[1, 0]] }; } });
  expect(await provider.embed('x'.repeat(EMBEDDING_TEXT_CHARS * 2))).toEqual([1, 0]);
  expect(calls).toEqual([[EMBEDDING_MODEL, { text: [expect.stringContaining('[content truncated]')] }, { signal: expect.any(AbortSignal) }]]);
  expect((calls[0] as [string, { text: string[] }])[1].text[0].length).toBeLessThanOrEqual(EMBEDDING_TEXT_CHARS);
  await expect(cloudflareEmbeddingProvider({ run: async () => { throw new Error('provider details'); } }).embed('query')).rejects.toBeInstanceOf(EmbeddingUnavailable);
  await expect(cloudflareEmbeddingProvider({ run: async () => ({ data: [[0, 0]] }) }).embed('query')).rejects.not.toBeInstanceOf(EmbeddingUnavailable);
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
    const outbound = (async (url: string, init: RequestInit) => { request = new Request(url, init); return Response.json(response); }) as typeof fetch;
    const client = (await configuredEmbeddingProvider(f.db, f.key, outbound))!;
    expect(await client.embed('project architecture')).toEqual([1, 0]);
    expect(request!.url).toBe(endpoint);
    expect(request!.headers.get('authorization')).toBeNull();
    expect(request!.redirect).toBe('error');
    expect(await request!.json()).toEqual({ model: 'bge-m3', input: ['project architecture'] });
  }
});

test('a fixed provider requires its own sealed credential and does not send it to an overridden endpoint', async () => {
  const f = fixture();
  await f.configure('openai');
  let request: Request | undefined;
  const outbound = (async (url: string, init: RequestInit) => { request = new Request(url, init); return Response.json({ data: [{ embedding: [1, 0] }] }); }) as typeof fetch;
  expect(await configuredEmbeddingProvider(f.db, f.key, outbound)).toBeNull();
  await f.secrets.put('openai', 'fixed-provider-credential', 'operator', 1);
  await (await configuredEmbeddingProvider(f.db, f.key, outbound))!.embed('query');
  expect(request!.url).toBe('https://api.openai.com/v1/embeddings');
  expect(request!.headers.get('authorization')).toBe('Bearer fixed-provider-credential');
  await f.configure('openai', 'https://custom.example/v1');
  await (await configuredEmbeddingProvider(f.db, f.key, outbound))!.embed('query');
  expect(request!.headers.get('authorization')).toBeNull();
});

test('provider outages allow fallback while malformed successful replies remain errors', async () => {
  const f = fixture(); await f.configure('ollama');
  for (const response of [new Response(null, { status: 503 }), Response.json({ embeddings: [[NaN]] }), Response.json({ embeddings: [[0, 0]] })]) {
    const client = (await configuredEmbeddingProvider(f.db, f.key, (async () => response) as typeof fetch))!;
    if (response.status === 503) await expect(client.embed('query')).rejects.toBeInstanceOf(EmbeddingUnavailable);
    else await expect(client.embed('query')).rejects.not.toBeInstanceOf(EmbeddingUnavailable);
  }
});
