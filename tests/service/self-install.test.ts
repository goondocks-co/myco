import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSelfInstalledAsService } from '../../packages/myco/src/service/self-install';
import { serviceLabel } from '../../packages/myco/src/service/labels';
import { LaunchdServiceManager, type LaunchctlRunner } from '../../packages/myco/src/service/launchd';
import { getServiceManager } from '../../packages/myco/src/service/manager';
import { SERVICE_UNIT_DIR_ENV } from '../../packages/myco/src/service/paths';
import { FakeServiceManager } from '../helpers/fake-service-manager';

// The default home (`~/.myco`) yields the canonical `co.goondocks.myco` label;
// a non-default home (dogfood) yields a distinct, hash-suffixed label.
const DEFAULT_HOME = path.join(os.homedir(), '.myco');

// Local alias matches the legacy test naming. The shared fake exposes the
// same call-tracking arrays (installCalls, uninstallCalls, ...) and treats
// `preInstalled: true` as "every label looks installed", which is exactly
// the boolean semantics this suite relied on.
const FakeManager = FakeServiceManager;

class CapturingLogger {
  debugs: Array<{ kind: string; message: string; meta?: Record<string, unknown> }> = [];
  infos: Array<{ kind: string; message: string; meta?: Record<string, unknown> }> = [];
  warns: Array<{ kind: string; message: string; meta?: Record<string, unknown> }> = [];
  debug(kind: string, message: string, meta?: Record<string, unknown>): void { this.debugs.push({ kind, message, meta }); }
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
let originalAgentsDir: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
  originalHome = process.env.MYCO_HOME;
  originalAgentsDir = process.env[SERVICE_UNIT_DIR_ENV];
  process.env.MYCO_HOME = tmpHome;
  delete process.env[SERVICE_UNIT_DIR_ENV];
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = originalHome;
  if (originalAgentsDir === undefined) delete process.env[SERVICE_UNIT_DIR_ENV];
  else process.env[SERVICE_UNIT_DIR_ENV] = originalAgentsDir;
});

describe('ensureSelfInstalledAsService', () => {
  test('installs the default-home daemon when the platform supports it and no unit exists', async () => {
    const mgr = new FakeManager();
    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, mycoHome: DEFAULT_HOME, executable: fakeBinary() });
    expect(mgr.installCalls).toHaveLength(1);
    expect(mgr.installCalls[0].label).toBe('co.goondocks.myco');
    expect(mgr.installCalls[0].variant).toBe('prod');
    expect(logger.infos.some((e) => e.message.includes('Installed managed service'))).toBe(true);
  });

  test('installs a non-default (dogfood) home daemon with a distinct label', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-dogfood-'));
    const mgr = new FakeManager();
    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, mycoHome: home, executable: fakeBinary() });
    expect(mgr.installCalls[0].label).toBe(serviceLabel(home));
    expect(mgr.installCalls[0].label).not.toBe('co.goondocks.myco');
    expect(mgr.installCalls[0].variant).toBe('dev');
  });

  test('passes the current spec to install when a unit is already present, so content-compare can refresh a stale unit file', async () => {
    const mgr = new FakeManager({ preInstalled: true });
    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, mycoHome: DEFAULT_HOME, executable: fakeBinary() });
    expect(mgr.installCalls).toHaveLength(1);
    expect(mgr.installCalls[0].label).toBe('co.goondocks.myco');
    expect(logger.infos.some((e) => e.message.includes('Wrote updated managed service'))).toBe(true);
  });

  test('calls install without force (a supervisor reload would terminate the calling daemon)', async () => {
    const mgr = new FakeManager({ preInstalled: true });
    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, mycoHome: DEFAULT_HOME, executable: fakeBinary() });
    expect(mgr.installCalls).toHaveLength(1);
    expect(mgr.installOptions[0]?.force).toBeFalsy();
  });

  test('emits debug (not info) when the existing unit matches the current spec', async () => {
    const mgr = new FakeManager();
    mgr.installResultOverride = { changed: false, supervisorReloaded: false };
    mgr.installed.add('co.goondocks.myco');
    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, mycoHome: DEFAULT_HOME, executable: fakeBinary() });
    expect(logger.infos.some((e) => e.message.includes('managed service'))).toBe(false);
    expect(logger.debugs.some((e) => e.message.includes('unchanged'))).toBe(true);
  });

  test('skips and logs info when the platform is unsupported', async () => {
    const mgr = new FakeManager({ supported: false, platformName: 'unsupported (win32)' });
    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, mycoHome: DEFAULT_HOME, executable: fakeBinary() });
    expect(mgr.installCalls).toHaveLength(0);
    expect(mgr.statusCalls).toBe(0);
    expect(logger.infos.some((e) => e.message.includes('Skipping service install'))).toBe(true);
  });

  test('catches install errors, logs a warning, does not throw', async () => {
    const mgr = new FakeManager();
    mgr.install = async () => { throw new Error('launchctl exploded'); };
    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, mycoHome: DEFAULT_HOME, executable: fakeBinary() });
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0].meta?.error).toBe('launchctl exploded');
  });

  test('rejects script-runner executables via the spec-builder Cellar/wrapper guards', async () => {
    const mgr = new FakeManager();
    const logger = new CapturingLogger();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bun-'));
    const bun = path.join(dir, 'bun');
    fs.writeFileSync(bun, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await ensureSelfInstalledAsService(logger, { manager: mgr, mycoHome: DEFAULT_HOME, executable: bun });
    expect(mgr.installCalls).toHaveLength(0);
    expect(logger.warns).toHaveLength(1);
    expect(String(logger.warns[0].meta?.error)).toMatch(/script-runner|standalone daemon binary/);
  });

  // Regression guard: a sandboxed install (HOME=/tmp/sandbox-…) must not
  // write the plist into the real user's ~/Library/LaunchAgents/. The default
  // `getServiceManager()` MUST pick up MYCO_LAUNCH_AGENTS_DIR so the plist
  // lands in the sandbox and the launchd label gets a sandbox-distinct suffix.
  test('sandbox install: plist is written to MYCO_LAUNCH_AGENTS_DIR, never to real ~/Library/LaunchAgents', async () => {
    if (process.platform !== 'darwin') return; // launchd only
    const sandboxAgentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-sandbox-launchagents-'));
    process.env[SERVICE_UNIT_DIR_ENV] = sandboxAgentsDir;

    const launchctlCalls: string[][] = [];
    const runner: LaunchctlRunner = {
      async run(args) { launchctlCalls.push(args); return { stdout: '', exitCode: 0 }; },
    };
    // Use the real getServiceManager() to prove the wiring; swap the runner
    // so we don't actually shell out to launchctl.
    const built = getServiceManager({ platform: 'darwin' }) as LaunchdServiceManager;
    expect(built.agentsDir).toBe(sandboxAgentsDir);
    const mgr = new LaunchdServiceManager({ agentsDir: built.agentsDir, runner, uid: 501 });
    const logger = new CapturingLogger();

    const realLaunchAgentsBefore = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const realBefore = fs.existsSync(realLaunchAgentsBefore)
      ? new Set(fs.readdirSync(realLaunchAgentsBefore))
      : new Set<string>();

    await ensureSelfInstalledAsService(logger, { manager: mgr, mycoHome: DEFAULT_HOME, executable: fakeBinary() });

    // Sandbox dir got the plist.
    const sandboxPlists = fs.readdirSync(sandboxAgentsDir).filter((f) => f.endsWith('.plist'));
    expect(sandboxPlists.length).toBeGreaterThan(0);
    // Plist name carries the sandbox label suffix so two parallel sandboxes
    // can't race for the same launchd registration. The default home keeps the
    // canonical base label (`co.goondocks.myco`) with only the sandbox suffix.
    expect(sandboxPlists[0]).toMatch(/^co\.goondocks\.myco\.sandbox-[0-9a-f]{8}\.plist$/);

    // Real ~/Library/LaunchAgents/ was not mutated.
    const realAfter = fs.existsSync(realLaunchAgentsBefore)
      ? new Set(fs.readdirSync(realLaunchAgentsBefore))
      : new Set<string>();
    expect([...realAfter]).toEqual([...realBefore]);

    // launchctl bootstrap target uses the sandbox plist path, not the real one.
    const bootstrapCall = launchctlCalls.find((c) => c[0] === 'bootstrap');
    expect(bootstrapCall).toBeDefined();
    expect(bootstrapCall![2].startsWith(sandboxAgentsDir)).toBe(true);
  });

  // Regression for the canonical-plist hijack. Repro from the smoke matrix:
  // a dogfood (non-default-home) daemon bootstraps the sandbox plist;
  // launchd's RunAtLoad immediately spawns a child daemon from that plist. If
  // the plist EnvironmentVariables block does NOT carry MYCO_LAUNCH_AGENTS_DIR,
  // the child resolves to the real `~/Library/LaunchAgents/`, computes the
  // un-suffixed label, and overwrites the user's real plist with sandbox
  // MYCO_HOME paths.
  test('sandbox install of a dogfood home writes a plist whose env propagates MYCO_LAUNCH_AGENTS_DIR (no canonical-plist hijack via supervisor-spawned child)', async () => {
    if (process.platform !== 'darwin') return;
    const dogfoodHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-dogfood-home-'));
    const sandboxAgentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-sandbox-launchagents-dev-'));
    process.env[SERVICE_UNIT_DIR_ENV] = sandboxAgentsDir;

    let capturedSpec: { env: Record<string, string>; label: string } | null = null;
    const launchctlCalls: string[][] = [];
    const runner: LaunchctlRunner = {
      async run(args) { launchctlCalls.push(args); return { stdout: '', exitCode: 0 }; },
    };
    const built = getServiceManager({ platform: 'darwin' }) as LaunchdServiceManager;
    const mgr = new LaunchdServiceManager({ agentsDir: built.agentsDir, runner, uid: 501 });
    // Intercept install so we can assert the rendered spec's env block.
    const origInstall = mgr.install.bind(mgr);
    mgr.install = async (spec, opts) => {
      capturedSpec = { env: { ...spec.env }, label: spec.label };
      return origInstall(spec, opts);
    };

    const logger = new CapturingLogger();
    await ensureSelfInstalledAsService(logger, { manager: mgr, mycoHome: dogfoodHome, executable: fakeBinary() });

    expect(capturedSpec).not.toBeNull();
    // The home suffix (distinct dogfood home) and sandbox suffix stack.
    expect(capturedSpec!.label).toMatch(/^co\.goondocks\.myco\.[0-9a-f]{8}\.sandbox-[0-9a-f]{8}$/);
    // The plist env block MUST carry MYCO_LAUNCH_AGENTS_DIR so the supervisor-
    // spawned child daemon inherits the sandbox isolation and does NOT fall
    // back to the real ~/Library/LaunchAgents/.
    expect(capturedSpec!.env[SERVICE_UNIT_DIR_ENV]).toBe(sandboxAgentsDir);
    // Sanity: the standard env block is intact (managed signal + home).
    expect(capturedSpec!.env.MYCO_DAEMON_MANAGED).toBe('1');
    expect(capturedSpec!.env.MYCO_HOME).toBe(dogfoodHome);
  });
});
