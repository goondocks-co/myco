import { expect, test } from 'bun:test';
import http from 'node:http';
import { installLocalProxyConnections } from './miniflare-stale-connection.js';

const POOL_LIFETIME_MS = 10;

/** Retires a connection after its response, injecting workerd's idle close on its next request. */
async function withProxy(run: (url: string) => Promise<void>, options: { dropWrite?: boolean } = {}): Promise<number> {
  const retired = new WeakSet<object>();
  let value = 0;
  const server = http.createServer((request, response) => {
    if (retired.has(request.socket)) { request.socket.destroy(); return; }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (body === 'write') value++;
      if (options.dropWrite && body === 'write') { request.socket.destroy(); return; }
      response.end(String(value), () => { if (body === 'park') retired.add(request.socket); });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/cdn-cgi/local/platform-proxy`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  return value;
}

test('async proxy reads and writes survive an idle connection close', async () => {
  const restore = installLocalProxyConnections(POOL_LIFETIME_MS);
  try {
    await withProxy(async url => {
      const send = async (body: string) => (await require('undici').fetch(url, { method: 'POST', body })).text();
      await send('park');
      await new Promise(resolve => setTimeout(resolve, POOL_LIFETIME_MS * 2));
      expect(await send('read')).toBe('0');
      await send('write');
      expect(await send('read')).toBe('1');
    });
  } finally { restore(); }
});

test('a proxy write whose response is lost fails without applying it twice', async () => {
  const value = await withProxy(async url => {
    await expect(require('undici').fetch(url, { method: 'POST', body: 'write' })).rejects.toThrow('The socket connection was closed unexpectedly');
  }, { dropWrite: true });
  expect(value).toBe(1);
});
