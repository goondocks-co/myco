import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Miniflare } from 'miniflare';
import { diskBlobStore, DIGEST_MISMATCH_MESSAGE } from '@myco-server-worker/platform/bun/blobs.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { sqliteEnv } from './helpers/fixtures.js';

const body = () => new Blob(['durable body']).stream();

describe('blob publication durability', () => {
  it('acknowledges native publication after syncing the file and its directory entry', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-blob-durable-'));
    try {
      const calls: Array<'file' | 'directory'> = [];
      const store = diskBlobStore(root, async (handle, kind) => {
        calls.push(kind);
        await handle.sync();
      });
      const stored = await store.put('project/content', body());
      expect(stored).toEqual({ size: 12, durable: true });
      expect(calls.at(-2)).toBe('file');
      expect(calls.at(-1)).toBe('directory');
      expect(await fs.readFile(path.join(root, 'project/content'), 'utf8')).toBe('durable body');
      calls.length = 0;
      expect(await store.ensureDurable?.('project/content')).toBe(true);
      expect(calls).toContain('file');
      expect(calls.at(-1)).toBe('directory');
      expect(await store.ensureDurable?.('project/absent')).toBe(false);
      const faulted = diskBlobStore(root, async (handle, kind) => {
        if (kind === 'file') throw new Error('existing file sync failed');
        await handle.sync();
      });
      await expect(faulted.ensureDurable!('project/content')).rejects.toThrow('existing file sync failed');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an acknowledgement when the file or final directory sync fails', async () => {
    for (const failing of ['file', 'final-directory'] as const) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-blob-sync-fault-'));
      try {
        let fileSynced = false;
        const store = diskBlobStore(root, async (handle, kind) => {
          if (kind === 'file' && failing === 'file') throw new Error('lost file sync');
          if (kind === 'directory' && fileSynced && failing === 'final-directory') throw new Error('lost directory sync');
          await handle.sync();
          if (kind === 'file') fileSynced = true;
        });
        await expect(store.put('project/content', body())).rejects.toThrow('lost');
        expect((await fs.readdir(path.join(root, 'project'))).some((name) => name.endsWith('.partial'))).toBe(false);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it('keeps digest refusals before publication', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-blob-digest-'));
    try {
      const store = diskBlobStore(root);
      await expect(store.put('project/content', body(), { sha256: '0'.repeat(64) })).rejects.toThrow(DIGEST_MISMATCH_MESSAGE);
      expect(await store.head('project/content')).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('marks an acknowledged R2 publication durable at the Cloudflare adapter', async () => {
    const { env } = sqliteEnv();
    const serverEnv = serverEnvFromBindings(env);
    expect(await serverEnv.blobs.put('project/content', body())).toEqual({ size: 12, durable: true });
    expect(await serverEnv.blobs.ensureDurable?.('project/content')).toBe(true);
    expect(await serverEnv.blobs.ensureDurable?.('project/absent')).toBe(false);
  });

  it('marks acknowledged R2 publication and existing objects durable in workerd', async () => {
    const bundle = await Bun.build({ entrypoints: ['packages/myco-server/src/platform/cloudflare/env.ts'],
      format: 'esm', target: 'browser', external: ['cloudflare:workers'] });
    if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
    const environment = bundle.outputs.find((output) => output.path.endsWith('env.js'))!;
    const mf = new Miniflare({ modules: [
      { type: 'ESModule', path: 'worker.js', contents: `import { serverEnvFromBindings } from './env.js';
        export default { async fetch(request, bindings) {
          const env = serverEnvFromBindings({ MYCO_DB: bindings.DB, BUCKET: bindings.BUCKET,
            SOURCE_LIMIT: { limit: async () => ({ success: true }) }, TOKEN_LIMIT: { limit: async () => ({ success: true }) } });
          const stored = await env.blobs.put('project/content', request.body);
          const largeSize = 1024 * 1024 + 1;
          const large = await env.blobs.put('project/large', new Blob(['x'.repeat(largeSize)]).stream(), { size: largeSize });
          return Response.json({ stored, present: await env.blobs.ensureDurable('project/content'),
            absent: await env.blobs.ensureDurable('project/absent'), large,
            largePresent: await env.blobs.ensureDurable('project/large') });
        } };` },
      { type: 'ESModule', path: 'env.js', contents: await environment.text() },
    ], compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BUCKET'] });
    try {
      const response = await mf.dispatchFetch('http://durability/', { method: 'POST', body: 'durable body' });
      expect({ status: response.status, answer: await response.json() }).toEqual({ status: 200,
        answer: { stored: { size: 12, durable: true }, present: true, absent: false,
          large: { size: 1024 * 1024 + 1, durable: true }, largePresent: true } });
    } finally { await mf.dispose(); }
  }, 60_000);
});
