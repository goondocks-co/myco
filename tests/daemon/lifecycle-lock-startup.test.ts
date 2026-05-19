/**
 * Phase 3 tests for `attemptDaemonStartup`'s bounded-poll behavior
 * and the lock's clean SIGTERM release.
 *
 * The Phase 0 regression test covers the orphan-holds-lock + open
 * SQLite transaction shape end-to-end. These tests cover the new
 * Phase 3 contracts:
 *
 *   - waitForReleaseMs polls until the budget elapses or the lock
 *     becomes available
 *   - a child process that handles SIGTERM cleanly releases the lock
 *     in time for a respawn-style acquire to succeed quickly
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { attemptDaemonStartup } from '@myco/daemon/lifecycle-lock-startup.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';
const ORPHAN_HELPER = path.resolve('tests/helpers/lifecycle-lock-orphan-helper.ts');

async function spawnHolder(scriptArgs: string[], stdoutSignal: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['run', ORPHAN_HELPER, ...scriptArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('helper did not become ready')), 5000);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf-8').includes(stdoutSignal)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`helper exited prematurely with code ${code}`));
    });
  });
  return child;
}

describe.skipIf(!supported)('attemptDaemonStartup — Phase 3', () => {
  let tmpDir: string;
  let lockPath: string;
  let dbPath: string;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-lock-startup-'));
    lockPath = path.join(tmpDir, 'daemon.lock');
    dbPath = path.join(tmpDir, 'myco.db');
  });

  afterEach(() => {
    if (child && child.pid) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already dead */ }
    }
    child = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('without waitForReleaseMs, returns refused immediately when the lock is held', async () => {
    child = await spawnHolder([lockPath], 'READY');

    const t0 = Date.now();
    const result = await attemptDaemonStartup({
      lockPath,
      databasePath: dbPath,
    });
    const elapsed = Date.now() - t0;

    expect(result.outcome).toBe('refused');
    expect(elapsed).toBeLessThan(500);
  }, 10_000);

  it('with waitForReleaseMs, polls until the budget elapses if the lock stays held', async () => {
    child = await spawnHolder([lockPath], 'READY');

    const t0 = Date.now();
    const result = await attemptDaemonStartup({
      lockPath,
      databasePath: dbPath,
      waitForReleaseMs: 600,
      pollIntervalMs: 50,
    });
    const elapsed = Date.now() - t0;

    expect(result.outcome).toBe('refused');
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(2000);
  }, 10_000);

  it('with waitForReleaseMs, acquires as soon as the holder releases mid-poll', async () => {
    child = await spawnHolder([lockPath], 'READY');

    // Schedule the holder to exit after ~200ms so the polling acquire
    // observes the release inside its window.
    setTimeout(() => {
      if (child && child.pid) {
        try { process.kill(child.pid, 'SIGTERM'); } catch { /* already dead */ }
      }
    }, 200);

    const t0 = Date.now();
    const result = await attemptDaemonStartup({
      lockPath,
      databasePath: dbPath,
      waitForReleaseMs: 2000,
      pollIntervalMs: 50,
    });
    const elapsed = Date.now() - t0;

    expect(result.outcome).toBe('acquired');
    if (result.outcome !== 'acquired') throw new Error('unreachable');
    // Acquired well before the full budget.
    expect(elapsed).toBeLessThan(1500);
    result.lock.release();
  }, 10_000);

  it('a holder that handles SIGTERM releases the lock before exiting', async () => {
    // The shared orphan helper installs a SIGTERM handler that exits 0.
    // OS releases the flock on process death — the SIGTERM handler also
    // calls process.exit(0), firing Node's 'exit' event and the
    // LifecycleLock release. Either path is sufficient; this test just
    // confirms that the post-SIGTERM acquire succeeds quickly without
    // waiting for SIGKILL escalation.
    child = await spawnHolder([lockPath, dbPath], 'READY');

    const childPid = child.pid!;
    process.kill(childPid, 'SIGTERM');
    await new Promise<void>((resolve) => {
      child!.on('exit', () => resolve());
    });

    const t0 = Date.now();
    const result = await attemptDaemonStartup({
      lockPath,
      databasePath: dbPath,
    });
    const elapsed = Date.now() - t0;

    expect(result.outcome).toBe('acquired');
    if (result.outcome !== 'acquired') throw new Error('unreachable');
    expect(elapsed).toBeLessThan(500);
    result.lock.release();
  }, 10_000);
});
