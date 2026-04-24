/**
 * Unit tests for daemon eviction.
 *
 * The pure helpers (`parseLsofOutput`, `findVaultFromCwd`) are tested
 * directly. The orchestration (`evictDaemonsForVault`) is exercised via
 * the exported `findDaemonTargetsForVault` using in-process state: a
 * real live PID (the test process itself) stands in for "alive daemon,"
 * a guaranteed-dead PID stands in for "stale daemon.json entry."
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import {
  parseLsofOutput,
  findVaultFromCwd,
  findDaemonTargetsForVault,
  findPidsListeningOn,
  terminateProcess,
  isMycoDaemonForVault,
} from '@myco/daemon/eviction.js';
import { derivePort } from '@myco/daemon/port.js';

// ---------------------------------------------------------------------------
// parseLsofOutput
// ---------------------------------------------------------------------------

describe('parseLsofOutput()', () => {
  it('parses a single p/n record pair', () => {
    const out = ['p1234', 'n127.0.0.1:21039'].join('\n');
    expect(parseLsofOutput(out)).toEqual([{ pid: 1234, port: 21039 }]);
  });

  it('parses multiple records', () => {
    const out = [
      'p1234',
      'n127.0.0.1:21039',
      'p5678',
      'n127.0.0.1:21040',
    ].join('\n');
    expect(parseLsofOutput(out)).toEqual([
      { pid: 1234, port: 21039 },
      { pid: 5678, port: 21040 },
    ]);
  });

  it('ignores records without a port suffix', () => {
    const out = ['p1234', 'nSOME_UNRELATED_NAME'].join('\n');
    expect(parseLsofOutput(out)).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(parseLsofOutput('')).toEqual([]);
  });

  it('pairs an n-line with its most recent p-line', () => {
    const out = [
      'p1000',
      'p2000',
      'n127.0.0.1:9000',
    ].join('\n');
    expect(parseLsofOutput(out)).toEqual([{ pid: 2000, port: 9000 }]);
  });
});

// ---------------------------------------------------------------------------
// findVaultFromCwd
// ---------------------------------------------------------------------------

describe('findVaultFromCwd()', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-evict-cwd-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns null when no .myco/ exists in any ancestor', () => {
    const nested = path.join(tmpRoot, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    expect(findVaultFromCwd(nested)).toBeNull();
  });

  it('returns the .myco/ path when cwd is the project root', () => {
    const vault = path.join(tmpRoot, '.myco');
    fs.mkdirSync(vault);
    expect(findVaultFromCwd(tmpRoot)).toBe(vault);
  });

  it('walks up to find the enclosing .myco/ from a subdirectory', () => {
    const vault = path.join(tmpRoot, '.myco');
    fs.mkdirSync(vault);
    const nested = path.join(tmpRoot, 'src', 'deep', 'path');
    fs.mkdirSync(nested, { recursive: true });
    expect(findVaultFromCwd(nested)).toBe(vault);
  });

  it('returns null when .myco exists only as a file (not a dir)', () => {
    fs.writeFileSync(path.join(tmpRoot, '.myco'), 'not a directory');
    expect(findVaultFromCwd(tmpRoot)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findPidsListeningOn — touches the real system
// ---------------------------------------------------------------------------

describe('findPidsListeningOn()', () => {
  it('returns empty when no ports are requested', () => {
    expect(findPidsListeningOn([])).toEqual([]);
  });

  it('finds a real listener and reports the current pid', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };

    try {
      const owners = findPidsListeningOn([addr.port]);
      const mine = owners.find((o) => o.pid === process.pid);
      expect(mine).toBeDefined();
      expect(mine?.port).toBe(addr.port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// isMycoDaemonForVault — touches `ps`
// ---------------------------------------------------------------------------

describe('isMycoDaemonForVault()', () => {
  it('returns false for the current test process (not a myco daemon)', () => {
    expect(isMycoDaemonForVault(process.pid, '/any/vault')).toBe(false);
  });

  it('returns false for a dead PID', () => {
    expect(isMycoDaemonForVault(999_999_999, '/any/vault')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findDaemonTargetsForVault
// ---------------------------------------------------------------------------

describe('findDaemonTargetsForVault()', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-evict-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  it('returns no targets when daemon.json is absent and no port squatter', () => {
    // Use a port derived from a fake path guaranteed not to be squatted.
    const canonicalPort = derivePort(tmpVault);
    expect(findDaemonTargetsForVault(tmpVault, canonicalPort)).toEqual([]);
  });

  it('ignores daemon.json entries for dead PIDs', () => {
    const deadPid = 999_999_999;
    fs.writeFileSync(
      path.join(tmpVault, 'daemon.json'),
      JSON.stringify({ pid: deadPid, port: 30000 }),
    );
    expect(findDaemonTargetsForVault(tmpVault, 30000)).toEqual([]);
  });

  it('excludes the current process from the kill list', () => {
    fs.writeFileSync(
      path.join(tmpVault, 'daemon.json'),
      JSON.stringify({ pid: process.pid, port: 30000 }),
    );
    expect(findDaemonTargetsForVault(tmpVault, 30000)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// terminateProcess — real subprocess
// ---------------------------------------------------------------------------

describe('terminateProcess()', () => {
  it('is a no-op for a dead pid', async () => {
    await terminateProcess(999_999_999, { graceMs: 100, pollMs: 25 });
    // No throw — success.
  });

  it('SIGTERMs a live subprocess that responds to signals', async () => {
    const { spawn } = await import('node:child_process');
    // A trivial Node subprocess that idles until killed.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: 'ignore',
      detached: false,
    });

    // Give the child a moment to become process-visible.
    await new Promise((r) => setTimeout(r, 100));

    await terminateProcess(child.pid!, { graceMs: 1000, pollMs: 50 });

    // process.kill(pid, 0) should now throw (dead).
    let alive = true;
    try { process.kill(child.pid!, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { spawn } = await import('node:child_process');
    // Subprocess that traps SIGTERM and stays alive.
    const child = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);",
    ], {
      stdio: 'ignore',
      detached: false,
    });

    await new Promise((r) => setTimeout(r, 100));

    const logs: Array<{ level: string; msg: string }> = [];
    await terminateProcess(child.pid!, {
      graceMs: 250,
      pollMs: 25,
      logger: {
        info: (_k, msg) => logs.push({ level: 'info', msg }),
        warn: (_k, msg) => logs.push({ level: 'warn', msg }),
      },
    });

    let alive = true;
    try { process.kill(child.pid!, 0); } catch { alive = false; }
    expect(alive).toBe(false);
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('SIGKILL'))).toBe(true);
  });
});
