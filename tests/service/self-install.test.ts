import { describe, expect, test, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSelfInstalledAsService } from '../../packages/myco/src/service/self-install';
import { FakeServiceManager } from '../helpers/fake-service-manager';

// Local alias matches the legacy test naming. The shared fake exposes the
// same call-tracking arrays (installCalls, uninstallCalls, ...) and treats
// `preInstalled: true` as "every label looks installed", which is exactly
// the boolean semantics this suite relied on.
const FakeManager = FakeServiceManager;

class CapturingLogger {
  infos: Array<{ kind: string; message: string; meta?: Record<string, unknown> }> = [];
  warns: Array<{ kind: string; message: string; meta?: Record<string, unknown> }> = [];
  info(kind: string, message: string, meta?: Record<string, unknown>): void { this.infos.push({ kind, message, meta }); }
  warn(kind: string, message: string, meta?: Record<string, unknown>): void { this.warns.push({ kind, message, meta }); }
}

function fakeBinary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-self-install-'));
  const bin = path.join(dir, 'myco');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
  originalHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = tmpHome;
});

describe('ensureSelfInstalledAsService', () => {
  test('installs the prod variant when the platform supports it and no unit exists', async () => {
    const mgr = new FakeManager();
    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, variant: 'prod', executable: fakeBinary() });
    expect(mgr.installCalls).toHaveLength(1);
    expect(mgr.installCalls[0].label).toBe('co.goondocks.myco');
    expect(mgr.installCalls[0].variant).toBe('prod');
    expect(logger.infos.some((e) => e.message.includes('Installed managed service'))).toBe(true);
  });

  test('installs the dev variant when requested', async () => {
    const mgr = new FakeManager();
    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, variant: 'dev', executable: fakeBinary() });
    expect(mgr.installCalls[0].label).toBe('co.goondocks.myco-dev');
    expect(mgr.installCalls[0].variant).toBe('dev');
  });

  test('passes the current spec to install when a unit is already present, so content-compare can refresh a stale unit file', async () => {
    const mgr = new FakeManager({ preInstalled: true });
    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, variant: 'prod', executable: fakeBinary() });
    expect(mgr.installCalls).toHaveLength(1);
    expect(mgr.installCalls[0].label).toBe('co.goondocks.myco');
    expect(logger.infos.some((e) => e.message.includes('Refreshed managed service'))).toBe(true);
    expect(logger.infos.some((e) => e.meta?.refreshed === true)).toBe(true);
  });

  test('skips and logs info when the platform is unsupported', async () => {
    const mgr = new FakeManager({ supported: false, platformName: 'unsupported (win32)' });
    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, variant: 'prod', executable: fakeBinary() });
    expect(mgr.installCalls).toHaveLength(0);
    expect(mgr.statusCalls).toBe(0);
    expect(logger.infos.some((e) => e.message.includes('Skipping service install'))).toBe(true);
  });

  test('catches install errors, logs a warning, does not throw', async () => {
    const mgr = new FakeManager();
    mgr.install = async () => { throw new Error('launchctl exploded'); };
    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, variant: 'prod', executable: fakeBinary() });
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0].meta?.error).toBe('launchctl exploded');
  });

  test('rejects script-runner executables via the spec-builder Cellar/wrapper guards', async () => {
    const mgr = new FakeManager();
    const logger = new CapturingLogger();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bun-'));
    const bun = path.join(dir, 'bun');
    fs.writeFileSync(bun, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await ensureSelfInstalledAsService(logger, { manager: mgr, variant: 'prod', executable: bun });
    expect(mgr.installCalls).toHaveLength(0);
    expect(logger.warns).toHaveLength(1);
    expect(String(logger.warns[0].meta?.error)).toMatch(/script-runner|standalone daemon binary/);
  });
});
