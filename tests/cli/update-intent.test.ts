import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';

// Stub DaemonClient.getInfoAsync — the only call --target-version makes
// before deciding whether to write an intent. Without this the real
// client would try to bring up a daemon against the temp vault dir.
const { fakeDaemon } = vi.hoisted(() => {
  const fakeDaemon: { info: { pid: number; port: number } | null } = {
    info: null,
  };
  return { fakeDaemon };
});

mock.module('@myco/hooks/client.js', () => ({
  DaemonClient: class {
    constructor(_vaultDir: string) {}
    async getInfoAsync() { return fakeDaemon.info; }
  },
}));

function writeDaemonJson(serviceDir: string, version: string) {
  fs.writeFileSync(
    path.join(serviceDir, 'daemon.json'),
    JSON.stringify({ pid: 12345, port: 20915, version, started: new Date().toISOString() }),
  );
}

import { run } from '@myco/cli/update.js';

describe('myco update --target-version writes intent', () => {
  let testDir: string;
  let vault: string;
  let serviceDir: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-intent-'));
    vault = path.join(testDir, '.myco');
    fs.mkdirSync(vault, { recursive: true });
    // resolveVaultDir() climbs from cwd looking for .myco/. Setting cwd
    // into testDir lets it pick up our fixture vault without forcing
    // every call site to thread an explicit vaultDir.
    originalCwd = process.cwd();
    process.chdir(testDir);
    // Seed myco.yaml so resolveVaultDir's existence check passes.
    fs.writeFileSync(path.join(vault, 'myco.yaml'), 'engine: claude\n');

    originalHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(testDir, '.home');
    serviceDir = path.join(process.env.MYCO_HOME, 'service');
    fs.mkdirSync(serviceDir, { recursive: true });

    fakeDaemon.info = null;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalHome;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('writes a [update] section with target_version when daemon is on a different version', async () => {
    fakeDaemon.info = { pid: 12345, port: 20915 };
    writeDaemonJson(serviceDir, '0.27.10');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['--target-version', '0.27.99']);

    const intentPath = path.join(serviceDir, 'intent.toml');
    expect(fs.existsSync(intentPath)).toBe(true);
    const parsed = parseToml(fs.readFileSync(intentPath, 'utf-8')) as {
      update?: { target_version: string; requested_at: string };
    };
    expect(parsed.update).toBeDefined();
    expect(parsed.update!.target_version).toBe('0.27.99');
    expect(parsed.update!.requested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    logSpy.mockRestore();
  });

  it('prints "already at version" and writes no intent when daemon matches target', async () => {
    fakeDaemon.info = { pid: 12345, port: 20915 };
    writeDaemonJson(serviceDir, '0.27.10');
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await run(['--target-version', '0.27.10']);

    const intentPath = path.join(serviceDir, 'intent.toml');
    expect(fs.existsSync(intentPath)).toBe(false);
    expect(logs.some((l) => l.toLowerCase().includes('already'))).toBe(true);
    logSpy.mockRestore();
  });

  it('exits non-zero when no daemon is discovered', async () => {
    fakeDaemon.info = null;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run(['--target-version', '0.27.99'])).rejects.toThrow('__exit__');

    const intentPath = path.join(serviceDir, 'intent.toml');
    expect(fs.existsSync(intentPath)).toBe(false);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('exits non-zero when --target-version has no argument', async () => {
    fakeDaemon.info = { pid: 12345, port: 20915 };
    writeDaemonJson(serviceDir, '0.27.10');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run(['--target-version'])).rejects.toThrow('__exit__');

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('--cancel-update clears a pending update intent', async () => {
    // Seed an existing update intent.
    const intentPath = path.join(serviceDir, 'intent.toml');
    fs.writeFileSync(
      intentPath,
      'update = { target_version = "0.27.99", requested_at = "2026-05-16T00:00:00Z" }\n',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['--cancel-update']);

    expect(fs.existsSync(intentPath)).toBe(false);
    logSpy.mockRestore();
  });

  it('--cancel-update is idempotent when no intent exists', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await run(['--cancel-update']);
    expect(logs.some((l) => l.toLowerCase().includes('no pending'))).toBe(true);
    logSpy.mockRestore();
  });
});
