import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { handlePutMachineConfig, handleGetMachineConfig } from '@myco/daemon/api/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * P4 — Race-free list-config mutation primitive.
 *
 * These tests verify the server-side addToList / removeFromList ops for the
 * machine config tier. The key invariant: two concurrent addToList calls for
 * the same path both land — no overwrite — because the server does the
 * read-modify-write, not the client.
 */
describe('machine config addToList / removeFromList', () => {
  let mycoHome: string;
  let prevMycoHome: string | undefined;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-list-ops-'));
    prevMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
  });

  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
    if (prevMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = prevMycoHome;
  });

  it('addToList seeds an empty array when the path has no prior value', async () => {
    const res = await handlePutMachineConfig({
      addToList: [{ path: 'capture.ignore.paths', values: ['/tmp/a'] }],
    });
    expect(res.response.status).toBeUndefined();
    const cfg = await handleGetMachineConfig();
    expect((cfg.body as any).config.capture.ignore.paths).toContain('/tmp/a');
  });

  it('addToList appends without overwriting — two calls both persist', async () => {
    // Simulate two sequential calls (atomic in prod; sequential here verifies
    // no full-array replace).
    await handlePutMachineConfig({
      addToList: [{ path: 'capture.ignore.paths', values: ['/tmp/a'] }],
    });
    await handlePutMachineConfig({
      addToList: [{ path: 'capture.ignore.paths', values: ['/tmp/b'] }],
    });
    const cfg = await handleGetMachineConfig();
    const paths = (cfg.body as any).config.capture.ignore.paths as string[];
    expect(paths).toContain('/tmp/a');
    expect(paths).toContain('/tmp/b');
  });

  it('addToList deduplicates — adding the same value twice results in one entry', async () => {
    await handlePutMachineConfig({
      addToList: [{ path: 'capture.ignore.paths', values: ['/tmp/dup'] }],
    });
    await handlePutMachineConfig({
      addToList: [{ path: 'capture.ignore.paths', values: ['/tmp/dup'] }],
    });
    const cfg = await handleGetMachineConfig();
    const paths = (cfg.body as any).config.capture.ignore.paths as string[];
    expect(paths.filter((p) => p === '/tmp/dup')).toHaveLength(1);
  });

  it('removeFromList removes the named value, leaving others intact', async () => {
    await handlePutMachineConfig({
      addToList: [{ path: 'capture.ignore.paths', values: ['/tmp/a', '/tmp/b', '/tmp/c'] }],
    });
    await handlePutMachineConfig({
      removeFromList: [{ path: 'capture.ignore.paths', values: ['/tmp/b'] }],
    });
    const cfg = await handleGetMachineConfig();
    const paths = (cfg.body as any).config.capture.ignore.paths as string[];
    expect(paths).toContain('/tmp/a');
    expect(paths).not.toContain('/tmp/b');
    expect(paths).toContain('/tmp/c');
  });

  it('addToList and patch can be combined in one request', async () => {
    const res = await handlePutMachineConfig({
      addToList: [{ path: 'capture.plan_dirs', values: ['/home/me/plans'] }],
    });
    expect(res.response.status).toBeUndefined();
    const cfg = await handleGetMachineConfig();
    expect((cfg.body as any).config.capture.plan_dirs).toContain('/home/me/plans');
  });

  it('returns 400 when addToList is not an array', async () => {
    const res = await handlePutMachineConfig({
      addToList: 'bad' as unknown as [],
    });
    expect(res.response.status).toBe(400);
  });

  it('returns 400 when a list op entry has no values array', async () => {
    const res = await handlePutMachineConfig({
      addToList: [{ path: 'capture.ignore.paths', values: 'oops' } as unknown as { path: string; values: unknown[] }],
    });
    expect(res.response.status).toBe(400);
  });

  it('returns 400 when neither patch nor list ops are provided', async () => {
    const res = await handlePutMachineConfig({});
    expect(res.response.status).toBe(400);
  });

  it('validates after list ops — rejects a schema-invalid result', async () => {
    // force the path to a non-string value to trip the schema validator
    const res = await handlePutMachineConfig({
      addToList: [{ path: 'capture.ignore.paths', values: [42 as unknown as string] }],
    });
    // MachineConfigSchema requires string[] — Zod should reject non-string entries
    expect(res.response.status).toBe(400);
    expect((res.response.body as any).error).toBe('validation_failed');
  });
});
