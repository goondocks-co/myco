import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('hook-guard.cjs', () => {
  const guardPath = path.resolve('src/symbionts/templates/hook-guard.cjs');

  // Build a clean env without MYCO_CMD so tests use the default 'myco-run' binary
  const { MYCO_CMD: _, ...cleanEnv } = process.env;

  it('exits 0 when myco-run is not on PATH', () => {
    const result = execFileSync(process.execPath, [guardPath, 'hook', 'session-start'], {
      env: { ...cleanEnv, PATH: '' },
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(result.toString()).toBe('');
  });

  it('exits 0 with no arguments', () => {
    const result = execFileSync(process.execPath, [guardPath], {
      env: { ...cleanEnv, PATH: '' },
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(result.toString()).toBe('');
  });

  it('forwards arguments to myco-run when available', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-guard-test-'));
    const fakeBin = path.join(tmpDir, 'myco-run');
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho "CALLED:$*"', { mode: 0o755 });

    try {
      const result = execFileSync(process.execPath, [guardPath, 'hook', 'session-start'], {
        env: { ...cleanEnv, PATH: tmpDir },
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(result.toString().trim()).toBe('CALLED:hook session-start');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('surfaces real errors from myco-run (non-ENOENT)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-guard-test-'));
    const fakeBin = path.join(tmpDir, 'myco-run');
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho "vault not initialized" >&2\nexit 1', { mode: 0o755 });

    try {
      execFileSync(process.execPath, [guardPath, 'hook', 'session-start'], {
        env: { ...cleanEnv, PATH: tmpDir },
        stdio: 'pipe',
        timeout: 5000,
      });
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stderr.toString()).toContain('vault not initialized');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('respects MYCO_CMD override', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-guard-test-'));
    const fakeMyco = path.join(tmpDir, 'my-custom-myco');
    fs.writeFileSync(fakeMyco, '#!/bin/sh\necho "CUSTOM:$*"', { mode: 0o755 });

    try {
      const result = execFileSync(process.execPath, [guardPath, 'hook', 'stop'], {
        env: { ...cleanEnv, PATH: tmpDir, MYCO_CMD: fakeMyco },
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(result.toString().trim()).toBe('CUSTOM:hook stop');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
