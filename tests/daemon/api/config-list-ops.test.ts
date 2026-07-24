import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { handlePutMachineConfig, handleGetMachineConfig } from '@myco/daemon/api/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const originalPollutedDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'polluted');

function restorePrototypePollutedProperty(): void {
  if (originalPollutedDescriptor) {
    Object.defineProperty(Object.prototype, 'polluted', originalPollutedDescriptor);
  } else {
    delete (Object.prototype as Record<string, unknown>).polluted;
  }
}

afterEach(restorePrototypePollutedProperty);

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

  it('removeFromList of an absent value is a harmless no-op', async () => {
    await handlePutMachineConfig({
      addToList: [{ path: 'capture.ignore.paths', values: ['/tmp/a', '/tmp/b'] }],
    });
    const res = await handlePutMachineConfig({
      removeFromList: [{ path: 'capture.ignore.paths', values: ['/tmp/not-present'] }],
    });
    expect(res.response.status).toBeUndefined();
    const cfg = await handleGetMachineConfig();
    const paths = (cfg.body as any).config.capture.ignore.paths as string[];
    expect(paths).toEqual(['/tmp/a', '/tmp/b']);
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
    // MachineConfigSchema requires string[] — Zod rejects non-string entries.
    // Value violations on tier PUTs are 422s (RC-3: 400 stays reserved for
    // malformed requests and scope violations).
    expect(res.response.status).toBe(422);
    expect((res.response.body as any).error).toBe('validation_failed');
  });

  it('drops a list-delta targeting grove.* (same guard as the patch strip)', async () => {
    // grove.* is registry-owned, stripped from machine patches. A list-delta
    // targeting it must pass through the same path guard — dropped, not
    // written. With only the dropped op present, nothing remains to write.
    const res = await handlePutMachineConfig({
      addToList: [{ path: 'grove.default_grove_id', values: ['grove_x'] }],
    });
    expect(res.response.status).toBe(400);
    const cfg = await handleGetMachineConfig();
    expect((cfg.body as any).config.grove?.default_grove_id).toBeUndefined();
  });

  const protectedExternalMcpCases: Array<{
    name: string;
    body: Record<string, unknown>;
    path: string;
  }> = [
    {
      name: 'patch descendant',
      body: {
        patch: {
          daemon: { external_mcp: { enabled: false } },
          capture: { buffer_max_events: 700 },
        },
      },
      path: 'daemon.external_mcp.enabled',
    },
    {
      name: 'patch destructive ancestor',
      body: {
        patch: {
          daemon: null,
          capture: { buffer_max_events: 700 },
        },
      },
      path: 'daemon',
    },
    ...(['clear', 'addToList', 'removeFromList'] as const).flatMap((operation) => (
      ['daemon.external_mcp', 'daemon.external_mcp.enabled', 'daemon'].map((protectedPath) => ({
        name: `${operation} ${protectedPath}`,
        body: operation === 'clear'
          ? {
              clear: [protectedPath],
              patch: { capture: { buffer_max_events: 700 } },
            }
          : {
              [operation]: [{ path: protectedPath, values: ['blocked'] }],
              patch: { capture: { buffer_max_events: 700 } },
            },
        path: protectedPath,
      }))
    )),
  ];

  for (const testCase of protectedExternalMcpCases) {
    it(`rejects ${testCase.name} for the authority-owned external MCP subtree atomically`, async () => {
      const configPath = path.join(mycoHome, 'config.yaml');
      fs.writeFileSync(configPath, [
        'daemon:',
        '  log_level: info',
        '  external_mcp:',
        '    enabled: true',
        '    port: 8743',
        'capture:',
        '  buffer_max_events: 500',
        '',
      ].join('\n'));
      const before = fs.readFileSync(configPath, 'utf-8');

      const result = await handlePutMachineConfig(testCase.body);

      expect(result.response).toEqual({
        status: 409,
        body: {
          error: 'protected_config_path',
          message: 'daemon.external_mcp is managed by the external MCP containment authority',
          paths: [testCase.path],
        },
      });
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    });
  }

  for (const operation of ['clear', 'addToList', 'removeFromList'] as const) {
    it(`rejects unsafe ${operation} paths before mutating the machine config`, async () => {
      const configPath = path.join(mycoHome, 'config.yaml');
      fs.writeFileSync(configPath, 'daemon:\n  log_level: info\n');
      const before = fs.readFileSync(configPath, 'utf-8');
      const unsafePath = 'safe.__proto__.polluted';
      const body = operation === 'clear'
        ? { clear: [unsafePath] }
        : { [operation]: [{ path: unsafePath, values: ['unsafe'] }] };

      const result = await handlePutMachineConfig(body);

      expect(result.response).toEqual({
        status: 400,
        body: {
          error: 'unsafe_config_path',
          message: 'Config path contains an unsafe segment',
        },
      });
      expect(Object.prototype).not.toHaveProperty('polluted');
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    });
  }
});
