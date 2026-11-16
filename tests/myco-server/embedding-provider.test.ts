import { DIAGNOSTIC_PAYLOADS } from '../helpers/secret-corpus.ts';
import type { OutboundFetch } from '@myco-server-worker/core/adapters.js';
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

test('self-hosted Ollama uses its configured protocol without fixed-provider credentials', async () => {
  const f = fixture(); await f.configure('ollama', 'http://models:11434');
  await f.secrets.put('openai', 'fixed-provider-credential', 'operator', 1);
  let request: Request | undefined;
  const client = (await configuredEmbeddingProvider(f.db, f.key, (url, init) => { request = new Request(url, init); return Promise.resolve(Response.json({ embeddings: [[1, 0]] })); }, BUN_EMBEDDING_PLATFORM))!;
  expect(await client.embed('project architecture')).toEqual([1, 0]);
  expect(request!.url).toBe('http://models:11434/api/embed');
  expect(request!.headers.get('authorization')).toBeNull();
});

test('malformed successful HTTP replies remain errors', async () => {
  const f = fixture(); await f.configure('ollama');
  const client = (await configuredEmbeddingProvider(f.db, f.key, (async () => Response.json({ embeddings: [[NaN]] })) as OutboundFetch, BUN_EMBEDDING_PLATFORM))!;
  await expect(client.embed('query')).rejects.not.toBeInstanceOf(EmbeddingUnavailable);
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
