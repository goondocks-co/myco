import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';

/**
 * `myco restart` now mirrors the UI: POST /api/restart synchronously
 * triggers the supervisor kickstart. The intent file write is reserved
 * for the HTTP-unreachable fallback path. These tests pin both surfaces:
 * the happy path (HTTP succeeds → no intent file) and the fallback
 * (HTTP fails → intent file written as a recovery marker).
 */
const { fakeDaemon } = vi.hoisted(() => {
  const fakeDaemon: {
    before: { pid: number; port: number } | null;
    pollResponses: ({ pid: number; port: number } | null)[];
    postResult: { ok: boolean; data?: unknown };
    postCalls: { endpoint: string; body: unknown }[];
  } = {
    before: null,
    pollResponses: [],
    postResult: { ok: true, data: { status: 'restarting' } },
    postCalls: [],
  };
  return { fakeDaemon };
});

mock.module('@myco/daemon/client.js', () => ({
  DaemonClient: class {
    constructor(_vaultDir: string) {}
    async getInfoAsync() {
      if (this._beforeServed === false) {
        this._beforeServed = true;
        return fakeDaemon.before;
      }
      return fakeDaemon.pollResponses.shift() ?? null;
    }
    async post(endpoint: string, body: unknown) {
      fakeDaemon.postCalls.push({ endpoint, body });
      return fakeDaemon.postResult;
    }
    private _beforeServed = false;
  },
}));

import { run } from '@myco/cli/restart.js';

describe('myco restart converges on /api/restart', () => {
  let testDir: string;
  let vault: string;
  let serviceDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-restart-'));
    vault = path.join(testDir, '.myco');
    fs.mkdirSync(vault, { recursive: true });

    originalHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(testDir, '.home');
    serviceDir = path.join(process.env.MYCO_HOME, 'service');
    fs.mkdirSync(serviceDir, { recursive: true });

    fakeDaemon.before = null;
    fakeDaemon.pollResponses = [];
    fakeDaemon.postResult = { ok: true, data: { status: 'restarting' } };
    fakeDaemon.postCalls = [];
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalHome;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('POSTs /api/restart and converges on new pid — no intent file written', async () => {
    fakeDaemon.before = { pid: 11111, port: 20915 };
    fakeDaemon.pollResponses = [
      null, // gap during SIGTERM/respawn
      { pid: 22222, port: 20915 },
    ];

    await run([], vault);

    expect(fakeDaemon.postCalls).toHaveLength(1);
    expect(fakeDaemon.postCalls[0]!.endpoint).toBe('/api/restart');
    expect(fakeDaemon.postCalls[0]!.body).toEqual({});

    // No intent file on the happy path — the supervisor kickstart is in flight.
    const intentPath = path.join(serviceDir, 'intent.restart.toml');
    expect(fs.existsSync(intentPath)).toBe(false);
  });

  it('forwards --force as { force: true } to the daemon', async () => {
    fakeDaemon.before = { pid: 11111, port: 20915 };
    fakeDaemon.pollResponses = [{ pid: 22222, port: 20915 }];

    await run(['--force'], vault);

    expect(fakeDaemon.postCalls[0]!.body).toEqual({ force: true });
  });

  it('does NOT call /api/restart when no daemon is discovered', async () => {
    fakeDaemon.before = null;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run([], vault)).rejects.toThrow('__exit__');

    expect(fakeDaemon.postCalls).toHaveLength(0);
    const intentPath = path.join(serviceDir, 'intent.restart.toml');
    expect(fs.existsSync(intentPath)).toBe(false);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('exits with a clear error when the daemon rejects with status=busy', async () => {
    fakeDaemon.before = { pid: 11111, port: 20915 };
    fakeDaemon.postResult = { ok: false, data: { status: 'busy', message: 'active ops' } };

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run([], vault)).rejects.toThrow('__exit__');

    expect(fakeDaemon.postCalls).toHaveLength(1);
    // No fallback intent on a structured 409 — user must explicitly --force.
    const intentPath = path.join(serviceDir, 'intent.restart.toml');
    expect(fs.existsSync(intentPath)).toBe(false);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('falls back to writing intent.restart.toml when /api/restart is unreachable', async () => {
    fakeDaemon.before = { pid: 11111, port: 20915 };
    // ok=false with no body shape signals transport failure (recoverAfterRequestFailure path).
    fakeDaemon.postResult = { ok: false };

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run([], vault)).rejects.toThrow('__exit__');

    const intentPath = path.join(serviceDir, 'intent.restart.toml');
    expect(fs.existsSync(intentPath)).toBe(true);
    const parsed = parseToml(fs.readFileSync(intentPath, 'utf-8')) as {
      requested_at: string;
      reason?: string;
    };
    expect(parsed.reason).toBe('cli');
    expect(parsed.requested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
