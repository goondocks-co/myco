import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';

// Stub the DaemonClient: getInfoAsync is the only call the CLI makes
// before deciding whether to write the intent. The shared mutable
// state lets each test control "what does the CLI see for the
// current daemon" and "what does the CLI see during the polling
// loop". Without this, the real DaemonClient would try to read a
// non-existent daemon.json and hit the 37s spawn/retry path the
// vault memory warns about.
const { fakeDaemon } = vi.hoisted(() => {
  const fakeDaemon: {
    before: { pid: number; port: number } | null;
    pollResponses: ({ pid: number; port: number } | null)[];
  } = {
    before: null,
    pollResponses: [],
  };
  return { fakeDaemon };
});

mock.module('@myco/hooks/client.js', () => ({
  DaemonClient: class {
    constructor(_vaultDir: string) {}
    async getInfoAsync() {
      // First call serves `before`; subsequent calls drain
      // `pollResponses`. When the queue is empty the loop sees null
      // (treated as "still restarting") until the deadline.
      if (this._beforeServed === false) {
        this._beforeServed = true;
        return fakeDaemon.before;
      }
      return fakeDaemon.pollResponses.shift() ?? null;
    }
    private _beforeServed = false;
  },
}));

// Pin MYCO_HOME inside the test temp dir so resolveDaemonServiceState
// drops intent.toml under our fixture instead of ~/.myco.
import { run } from '@myco/cli/restart.js';

describe('myco restart writes intent', () => {
  let testDir: string;
  let vault: string;
  let serviceDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-restart-intent-'));
    vault = path.join(testDir, '.myco');
    fs.mkdirSync(vault, { recursive: true });

    originalHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(testDir, '.home');
    serviceDir = path.join(process.env.MYCO_HOME, 'service');
    fs.mkdirSync(serviceDir, { recursive: true });

    fakeDaemon.before = null;
    fakeDaemon.pollResponses = [];
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalHome;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('writes a [restart] section to intent.toml and converges on a new pid', async () => {
    fakeDaemon.before = { pid: 11111, port: 20915 };
    // First poll: still old pid (shouldn't happen, but defensive).
    // Second poll: new pid → CLI returns.
    fakeDaemon.pollResponses = [
      null, // gap during SIGTERM/respawn
      { pid: 22222, port: 20915 },
    ];

    await run([], vault);

    const intentPath = path.join(serviceDir, 'intent.toml');
    expect(fs.existsSync(intentPath)).toBe(true);
    const parsed = parseToml(fs.readFileSync(intentPath, 'utf-8')) as {
      restart?: { requested_at: string; reason?: string };
    };
    expect(parsed.restart).toBeDefined();
    expect(parsed.restart!.reason).toBe('cli');
    // ISO8601 timestamp shape
    expect(parsed.restart!.requested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does NOT write intent when no daemon is discovered', async () => {
    fakeDaemon.before = null;
    fakeDaemon.pollResponses = [];

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run([], vault)).rejects.toThrow('__exit__');

    const intentPath = path.join(serviceDir, 'intent.toml');
    expect(fs.existsSync(intentPath)).toBe(false);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('treats null poll responses as "still restarting" (no early exit)', async () => {
    fakeDaemon.before = { pid: 11111, port: 20915 };
    // Several nulls in a row, then convergence — proves the loop
    // doesn't bail on the first null.
    fakeDaemon.pollResponses = [
      null,
      null,
      null,
      { pid: 33333, port: 20915 },
    ];

    await run([], vault);

    const intentPath = path.join(serviceDir, 'intent.toml');
    expect(fs.existsSync(intentPath)).toBe(true);
  });
});
