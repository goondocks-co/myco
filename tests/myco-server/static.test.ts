/**
 * The dashboard's static build, served beside the self-hosted server.
 *
 * The wrapper decides one thing: whether a path is the server's. Owned paths
 * reach the server untouched; every other GET answers a file or the shell.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { withStaticAssets } from '@myco-server-worker/platform/bun/static.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function build(): string {
  const root = mkdtempSync(join(tmpdir(), 'myco-ui-'));
  roots.push(root);
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  return root;
}

function recorder(): { seen: string[]; next: (request: Request) => Promise<Response> } {
  const seen: string[] = [];
  return { seen, next: async (request) => { seen.push(new URL(request.url).pathname); return new Response(null, { status: 401 }); } };
}

describe('static assets beside the self-hosted server', () => {
  it('hands every owned path to the server, live and retired, and never answers it with the shell', async () => {
    const { seen, next } = recorder();
    const handle = withStaticAssets(build(), next);
    const owned = ['/api/status', '/health', '/events', '/sessions/register', '/auth/login', '/runs/claim', '/blobs/abc', '/members/join'];
    for (const path of owned) {
      const res = await handle(new Request(`https://s${path}`));
      expect({ path, status: res.status, type: res.headers.get('content-type') }).toEqual({ path, status: 401, type: null });
    }
    expect(seen).toEqual(owned);
  });

  it('answers the shell for an unowned path with no file, and a file by its type', async () => {
    const { seen, next } = recorder();
    const handle = withStaticAssets(build(), next);

    const deep = await handle(new Request('https://s/p/proj_1/sessions'));
    expect({ status: deep.status, type: deep.headers.get('content-type'), cache: deep.headers.get('cache-control') })
      .toEqual({ status: 200, type: 'text/html; charset=utf-8', cache: 'no-cache' });
    expect(await deep.text()).toContain('id="root"');

    const asset = await handle(new Request('https://s/assets/app.js'));
    expect({ status: asset.status, type: asset.headers.get('content-type'), cache: asset.headers.get('cache-control') })
      .toEqual({ status: 200, type: 'text/javascript; charset=utf-8', cache: 'public, max-age=31536000, immutable' });

    const head = await handle(new Request('https://s/assets/app.js', { method: 'HEAD' }));
    expect({ status: head.status, body: await head.text() }).toEqual({ status: 200, body: '' });

    expect(seen).toEqual([]);
  });

  it('refuses a path that escapes the build directory, and a path carrying a NUL', async () => {
    const root = build();
    const outside = join(root, '..', `outside-${basename(root)}.txt`);
    writeFileSync(outside, 'not served');
    roots.push(outside);
    const handle = withStaticAssets(root, recorder().next);

    for (const path of [`/assets/..%2f..%2f${basename(outside)}`, `/..%2f${basename(outside)}`, '/%00index.html']) {
      const res = await handle(new Request(`https://s${path}`));
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
  });

  it('answers 405 to any method but GET and HEAD on an unowned path', async () => {
    const { seen, next } = recorder();
    const handle = withStaticAssets(build(), next);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await handle(new Request('https://s/p/proj_1', { method }));
      expect({ method, status: res.status, allow: res.headers.get('allow') }).toEqual({ method, status: 405, allow: 'GET, HEAD' });
    }
    expect(seen).toEqual([]);
  });

  it('answers 404 rather than an empty shell when the build directory holds none', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'myco-ui-empty-'));
    roots.push(empty);
    const handle = withStaticAssets(empty, recorder().next);
    expect((await handle(new Request('https://s/'))).status).toBe(404);
  });
});
