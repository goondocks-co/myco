import { afterAll, beforeAll, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { wrappingKeyFromText } from '@myco-server-worker/platform/wrapping-key.js';
import { schemaD1Root } from './helpers/schema-template.js';

let runtime: Miniflare | undefined;
let upstream: Server;
let status = 200;
beforeAll(async () => {
  upstream = createServer(async (request, response) => {
    const embedding = request.url!.startsWith('/embedding');
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || '{}');
    const valid = request.url!.includes('/redirected') || body.model === (embedding ? 'openai/text-embedding-3-small' : 'fixture')
      && request.headers.authorization === (embedding ? 'Bearer synthetic-provider-key' : undefined)
      && (embedding ? body.input?.[0] : body.messages?.[0]?.content) === 'fixture';
    response.writeHead(!valid ? 400 : request.url!.includes('/redirected') ? 200 : status, { 'content-type': 'application/json', location: `/${embedding ? 'embedding' : 'completion'}/redirected` });
    response.end(JSON.stringify(embedding ? { data: [{ embedding: [1, 0] }] } : { choices: [{ message: { content: 'fixture' } }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (address === null || typeof address === 'string') throw new Error('loopback address unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const bundle = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'provider-worker.ts', contents: `
    import { configuredEmbeddingProvider } from '@myco-server-worker/core/embedding/configured-provider.js';
    import { configuredCompletionProvider } from '@myco-server-worker/core/completion/configured-provider.js';
    import { providerFailureAction } from '@myco-server-worker/core/embedding/provider-failure.js';
    import { RUN_FAILURE_WORDS } from '@goondocks/myco-shared/run-control';
    import { wrappingKeyFromText } from '@myco-server-worker/platform/wrapping-key.js';
    export default { async fetch(request, env) {
      const kind = new URL(request.url).pathname.slice(1), key = wrappingKeyFromText(async () => env.KEY, 'fixture');
      const outbound = (url, init) => {
        if (url !== (kind === 'embedding' ? 'https://openrouter.ai/api/v1/embeddings' : env.ORIGIN + '/chat/completions')) throw new Error('unexpected provider endpoint');
        return fetch(env.ORIGIN + '/' + kind, init);
      };
      try {
        const provider = await (kind === 'embedding' ? configuredEmbeddingProvider : configuredCompletionProvider)(env.DB, key, outbound, { target: 'cloudflare' });
        if (provider === null) return Response.json({ unconfigured: true }, { status: 503 });
        const value = kind === 'embedding' ? await provider.embed('fixture') : await provider.complete({ messages: [{ role: 'user', content: 'fixture' }] });
        return Response.json({ value });
      } catch (error) { return Response.json({ error: error.message, code: error.code, failure: error.failure, policy: kind === 'embedding' ? providerFailureAction(error, 0, Date.now()) : undefined, words: RUN_FAILURE_WORDS['completion_' + error.code] }, { status: 502 }); }
    }};` }, bundle: true, write: false, platform: 'browser', format: 'esm' });
  runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0]!.text,
    compatibilityDate: '2026-08-01', compatibilityFlags: ['global_fetch_strictly_public'], d1Databases: ['DB'],
    resourcePersistencePath: await schemaD1Root(), bindings: { KEY: key, ORIGIN: origin } }));
  const db = await runtime.getD1Database('DB'), writer = settingsWriter(db, { target: 'cloudflare' });
  const secrets = deploymentSecretStore(db, wrappingKeyFromText(async () => key, 'fixture'));
  await secrets.put('openai', 'unrelated-provider-key', 'operator', Date.now());
  for (const [leaf, value] of [['embedding.provider', 'openrouter'], ['single_turn.model', 'fixture'], ['single_turn.base_url', origin]] as const) {
    expect(await writer.setLeaf(leaf, value, 'operator', Date.now())).toEqual({ applied: true });
  }
  expect((await runtime.dispatchFetch('https://fixture.invalid/embedding')).status).toBe(503);
  expect(await writer.setLeaf('embedding.base_url', 'https://custom.invalid', 'operator', Date.now())).toMatchObject({ applied: false, refusal: { detail: expect.stringContaining('uses its own endpoint') } });
  await secrets.put('openrouter', 'synthetic-provider-key', 'operator', Date.now());
}, 120_000);
afterAll(async () => {
  await runtime?.dispose();
  if (upstream?.listening) await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
});

for (const kind of ['embedding', 'completion']) it(`workerd ${kind} sends real HTTP and refuses a redirect by name`, async () => {
  status = 200;
  const success = await runtime!.dispatchFetch(`https://fixture.invalid/${kind}`);
  expect(success.status).toBe(200);
  expect(await success.json()).toMatchObject(kind === 'embedding' ? { value: [1, 0] } : { value: { text: 'fixture' } });
  status = 302;
  const refused = await runtime!.dispatchFetch(`https://fixture.invalid/${kind}`);
  expect(refused.status).toBe(502);
  expect(await refused.json()).toMatchObject(kind === 'embedding'
    ? { failure: { kind: 'redirect', status: 302 }, policy: { action: 'pause', reason: expect.stringContaining('Redirects are refused') } }
    : { code: 'redirect', error: 'completion_redirect (HTTP 302)', words: expect.stringContaining('redirect') });
});
