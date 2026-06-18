import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateServiceCheck, checkInstallSource } from '../../packages/myco/src/cli/doctor';
import type { ServiceStatus } from '../../packages/myco/src/service/types';

const goodBin = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-doc-'));
  const b = path.join(d, 'myco');
  fs.writeFileSync(b, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return b;
};

describe('evaluateServiceCheck', () => {
  test('not installed → warn (lazy spawn still works)', () => {
    const status: ServiceStatus = { installed: false, running: false, pid: null, lastExitCode: null, unitPath: null };
    const check = evaluateServiceCheck('co.goondocks.myco', status, '/some/path');
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/not installed/i);
    expect(check.fixable).toBe(true);
  });

  test('installed and running → ok', () => {
    const bin = goodBin();
    const status: ServiceStatus = { installed: true, running: true, pid: 4242, lastExitCode: 0, unitPath: '/x' };
    const check = evaluateServiceCheck('co.goondocks.myco', status, bin);
    expect(check.status).toBe('ok');
  });

  test('installed but executable missing → fail (the chris machine failure mode)', () => {
    const status: ServiceStatus = { installed: true, running: false, pid: null, lastExitCode: 78, unitPath: '/x' };
    const check = evaluateServiceCheck('co.goondocks.myco', status, '/nonexistent/path');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/executable.*not found|EX_CONFIG|exit code 78/i);
    expect(check.fixable).toBe(true);
  });

  test('installed with non-zero lastExitCode → warn', () => {
    const bin = goodBin();
    const status: ServiceStatus = { installed: true, running: true, pid: 1, lastExitCode: 1, unitPath: '/x' };
    const check = evaluateServiceCheck('co.goondocks.myco', status, bin);
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/last exit code/i);
  });

  test('installed but not running → warn', () => {
    const bin = goodBin();
    const status: ServiceStatus = { installed: true, running: false, pid: null, lastExitCode: null, unitPath: '/x' };
    const check = evaluateServiceCheck('co.goondocks.myco', status, bin);
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/not running/i);
  });

  // --- managed-binary assertion (Task 10) ---

  test('prod variant + service executable is NOT the managed binary → warn', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-doc-mb-'));
    // Create a managed binary at a canonical path
    const managedDir = path.join(tmpDir, 'managed', 'bin');
    fs.mkdirSync(managedDir, { recursive: true });
    const managedBin = path.join(managedDir, 'myco');
    fs.writeFileSync(managedBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // Service is configured to run a DIFFERENT binary (e.g. npm node_modules path)
    const serviceBin = path.join(tmpDir, 'node_modules', '.bin', 'myco');
    fs.mkdirSync(path.dirname(serviceBin), { recursive: true });
    fs.writeFileSync(serviceBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const status: ServiceStatus = { installed: true, running: true, pid: 1234, lastExitCode: 0, unitPath: '/x' };
    const check = evaluateServiceCheck('co.goondocks.myco', status, serviceBin, {
      variant: 'prod',
      managedBinary: managedBin,
    });
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/non-managed binary|managed binary|myco update|myco service install/i);
  });

  test('prod variant + service executable equals the managed binary → ok', () => {
    const managedBin = goodBin();
    const status: ServiceStatus = { installed: true, running: true, pid: 1234, lastExitCode: 0, unitPath: '/x' };
    const check = evaluateServiceCheck('co.goondocks.myco', status, managedBin, {
      variant: 'prod',
      managedBinary: managedBin,
    });
    expect(check.status).toBe('ok');
  });

  test('dev variant + non-managed service executable → NOT warned (dogfood guard)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-doc-dev-'));
    const managedBin = path.join(tmpDir, 'managed', 'bin', 'myco');
    fs.mkdirSync(path.dirname(managedBin), { recursive: true });
    fs.writeFileSync(managedBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // Dev binary is a packages/myco-arch/bin/myco path, not the managed binary
    const devBin = path.join(tmpDir, 'packages', 'myco-x64', 'bin', 'myco');
    fs.mkdirSync(path.dirname(devBin), { recursive: true });
    fs.writeFileSync(devBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const status: ServiceStatus = { installed: true, running: true, pid: 1234, lastExitCode: 0, unitPath: '/x' };
    const check = evaluateServiceCheck('co.goondocks.myco-dev', status, devBin, {
      variant: 'dev',
      managedBinary: managedBin,
    });
    // Dev variant must NOT warn about running a non-managed binary
    expect(check.status).toBe('ok');
  });

  test('no managed binary options → no regression on existing callers (3-arg form still ok)', () => {
    const bin = goodBin();
    const status: ServiceStatus = { installed: true, running: true, pid: 9, lastExitCode: 0, unitPath: '/x' };
    const check = evaluateServiceCheck('co.goondocks.myco', status, bin);
    expect(check.status).toBe('ok');
  });
});

// --- checkInstallSource (Task 10) ---

describe('checkInstallSource', () => {
  let tmpDir: string;
  let savedMycoHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-src-'));
    savedMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedMycoHome;
  });

  test('marker present (source=curl) → ok with source reported', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'install.json'),
      JSON.stringify({ source: 'curl', channel: 'stable', bin: path.join(tmpDir, 'bin', 'myco') }),
      'utf-8',
    );
    const check = await checkInstallSource();
    expect(check.status).toBe('ok');
    expect(check.name).toBe('Install');
    expect(check.detail).toMatch(/curl/);
  });

  test('marker present (source=npm) → ok with source reported', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'install.json'),
      JSON.stringify({ source: 'npm', channel: 'stable', bin: path.join(tmpDir, 'bin', 'myco') }),
      'utf-8',
    );
    const check = await checkInstallSource();
    expect(check.status).toBe('ok');
    expect(check.detail).toMatch(/npm/);
  });

  test('marker absent → ok with benign note (pre-convergence or source build)', async () => {
    // No install.json written
    const check = await checkInstallSource();
    expect(check.status).toBe('ok');
    expect(check.name).toBe('Install');
    expect(check.detail).toMatch(/no install marker|pre-convergence|source build/i);
  });

  test('always status:ok — never fails the exit code', async () => {
    // Even with a malformed marker file
    fs.writeFileSync(path.join(tmpDir, 'install.json'), 'not json', 'utf-8');
    const check = await checkInstallSource();
    expect(check.status).toBe('ok');
  });
});
