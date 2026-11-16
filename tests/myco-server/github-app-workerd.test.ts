import { expect, it } from 'bun:test';
import { createServer } from 'node:http';
import { verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { APP_KEY, APP_RESPONSE, APP_RSA } from '../setup/fixtures/github.js';

it('workerd sends a signed App request through real fetch and refuses a redirect without following it', async () => {
  let redirect = false;
  const upstream = createServer((request, response) => {
    const [header, payload, signature] = (request.headers.authorization ?? '').slice('Bearer '.length).split('.');
    const valid = signature !== undefined && verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), APP_RSA.publicKey, Buffer.from(signature, 'base64url'));
    response.writeHead(valid ? (redirect ? 302 : 200) : 401, { 'content-type': 'application/json', location: '/unexpected' });
    response.end(JSON.stringify(APP_RESPONSE));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let runtime: Miniflare | undefined;
  try {
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('loopback address unavailable');
    const bundle = await Bun.build({ entrypoints: [fileURLToPath(import.meta.resolve('@goondocks/myco-shared/github-app'))], format: 'esm', target: 'browser' });
    if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
    runtime = new Miniflare(convertV4MiniflareOptions({ modules: [
      { type: 'ESModule', path: 'worker.js', contents: `import { githubAppAccess } from './shared.js';
        export default { async fetch(request, env) {
          try { return Response.json(await githubAppAccess({ clientId: '${APP_RESPONSE.client_id}', privateKey: env.KEY,
            fetchImpl: (url, init) => fetch('http://127.0.0.1:${address.port}/app', init) }).identity()); }
          catch (error) { return Response.json({ reason: error.message }, { status: 502 }); }
        }};` },
      { type: 'ESModule', path: 'shared.js', contents: await bundle.outputs[0]!.text() },
    ], compatibilityDate: '2026-08-01', bindings: { KEY: APP_KEY } }));
    expect(await (await runtime.dispatchFetch('https://fixture.invalid')).json()).toMatchObject({ slug: APP_RESPONSE.slug });
    redirect = true;
    const refused = await runtime.dispatchFetch('https://fixture.invalid');
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ reason: expect.stringContaining('HTTP 302') });
  } finally {
    await runtime?.dispose();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});
