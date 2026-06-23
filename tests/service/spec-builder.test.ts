import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServiceSpec } from '../../packages/myco/src/service/spec-builder';
import { serviceLabel } from '../../packages/myco/src/service/labels';
import { SERVICE_UNIT_DIR_ENV } from '../../packages/myco/src/service/paths';

const DEFAULT_HOME = path.join(os.homedir(), '.myco');

function makeFakeBinary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-svc-spec-'));
  const bin = path.join(dir, 'myco');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}

/** A dev-build vendor binary, for the default-home dev-build guard tests. */
function makeVendorBinary(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-repo-'));
  const vendorDir = path.join(repoRoot, 'packages', 'myco', 'vendor', 'darwin-arm64');
  fs.mkdirSync(vendorDir, { recursive: true });
  const bin = path.join(vendorDir, 'myco');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}

describe('buildServiceSpec', () => {
  test('default home (~/.myco): prod label, service/ paths, MYCO_DAEMON_MANAGED=1 + MYCO_HOME, no MYCO_SERVICE_VARIANT', () => {
    const bin = makeFakeBinary();
    const spec = buildServiceSpec({ mycoHome: DEFAULT_HOME, executable: bin });
    expect(spec.label).toBe('co.goondocks.myco');
    expect(spec.variant).toBe('prod');
    expect(spec.executable).toBe(bin);
    expect(spec.args).toEqual(['daemon']);
    expect(spec.stdoutPath).toBe(path.join(DEFAULT_HOME, 'service', 'logs', 'daemon.out.log'));
    expect(spec.stderrPath).toBe(path.join(DEFAULT_HOME, 'service', 'logs', 'daemon.err.log'));
    expect(spec.runAtLoad).toBe(true);
    expect(spec.keepAlive).toBe(true);
    expect(spec.env.MYCO_HOME).toBe(DEFAULT_HOME);
    expect(spec.env.MYCO_DAEMON_MANAGED).toBe('1');
    expect(spec.env.MYCO_SERVICE_VARIANT).toBeUndefined();
    // Default home's claims already live in MYCO_HOME — no override needed.
    expect(spec.env.MYCO_CLAIMS_HOME).toBeUndefined();
  });

  test('a non-default home gets a distinct label and its own service/ dir', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const bin = makeFakeBinary();
    const spec = buildServiceSpec({ mycoHome: home, executable: bin });
    expect(spec.label).toBe(serviceLabel(home));
    expect(spec.label).not.toBe('co.goondocks.myco');
    expect(spec.variant).toBe('dev');
    expect(spec.stdoutPath).toBe(path.join(home, 'service', 'logs', 'daemon.out.log'));
    expect(spec.env.MYCO_DAEMON_MANAGED).toBe('1');
    // Non-default home reads subsystem claims from the canonical home.
    expect(spec.env.MYCO_CLAIMS_HOME).toBe(DEFAULT_HOME);
  });

  test('two distinct homes get distinct labels and distinct state dirs', () => {
    const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-a-'));
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-b-'));
    const bin = makeFakeBinary();
    const specA = buildServiceSpec({ mycoHome: homeA, executable: bin });
    const specB = buildServiceSpec({ mycoHome: homeB, executable: bin });
    expect(specA.label).not.toBe(specB.label);
    expect(specA.stdoutPath).not.toBe(specB.stdoutPath);
  });

  test('throws if executable does not exist on disk', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    expect(() => buildServiceSpec({
      mycoHome: home,
      executable: '/nonexistent/myco',
    })).toThrow(/executable not found/i);
  });

  test('rejects executable paths under /opt/homebrew/Cellar (versioned brew paths break on upgrade)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    expect(() => buildServiceSpec({
      mycoHome: home,
      executable: '/opt/homebrew/Cellar/node/25.9.0_2/bin/node',
    })).toThrow(/Cellar/);
  });

  test('darwin service PATH includes Homebrew bin + /usr/local/bin', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const bin = makeFakeBinary();
    const spec = buildServiceSpec({ mycoHome: home, executable: bin, platform: 'darwin' });
    expect(spec.env.PATH).toContain('/opt/homebrew/bin');
    expect(spec.env.PATH).toContain('/usr/local/bin');
  });

  test('linux service PATH omits Homebrew bin', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const bin = makeFakeBinary();
    const spec = buildServiceSpec({ mycoHome: home, executable: bin, platform: 'linux' });
    expect(spec.env.PATH).not.toContain('/opt/homebrew');
    expect(spec.env.PATH).toContain('/usr/bin');
    expect(spec.env.PATH).toContain('/usr/local/bin');
  });

  test('rejects bun/bun.exe/node/node.exe wrapper paths', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const mkExecutable = (name: string): string => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-wrapper-'));
      const file = path.join(dir, name);
      fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return file;
    };
    for (const name of ['bun', 'bun.exe', 'node', 'node.exe']) {
      const exe = mkExecutable(name);
      expect(() => buildServiceSpec({ mycoHome: home, executable: exe })).toThrow(/script-runner|standalone daemon binary/);
    }
  });

  // Regression: the prod plist was once written with a dev-build path,
  // after which launchd spawned the dev binary as the prod service —
  // running unreleased code against the prod Grove. The guard must refuse
  // the substitution for the DEFAULT home (the production install).
  test('refuses the default home (~/.myco) when executable is a dev-build path', () => {
    const devBin = makeVendorBinary();
    expect(() => buildServiceSpec({
      mycoHome: DEFAULT_HOME,
      executable: devBin,
    })).toThrow(/dev-build executable|packages\/<pkg>\/vendor/);
  });

  test('allows a non-default home with a dev-build path (the legitimate dogfood case)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const devBin = makeVendorBinary();
    const spec = buildServiceSpec({
      mycoHome: home,
      executable: devBin,
    });
    expect(spec.executable).toBe(devBin);
    expect(spec.variant).toBe('dev');
  });

  test('default home refuses a symlink whose realpath resolves into a vendor tree', () => {
    const realBin = makeVendorBinary();
    // The user installs via a symlink that lives outside vendor/.
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-link-'));
    const link = path.join(linkDir, 'myco');
    fs.symlinkSync(realBin, link);

    expect(() => buildServiceSpec({
      mycoHome: DEFAULT_HOME,
      executable: link,
    })).toThrow(/dev-build executable/);
  });

  // Regression for canonical-plist hijack. launchd's RunAtLoad fires the
  // moment we `launchctl bootstrap` the sandbox plist — the supervisor-
  // spawned child daemon then re-runs ensureSelfInstalledAsService during
  // its own startup. If the plist env block doesn't carry MYCO_LAUNCH_AGENTS_DIR,
  // the child resolves to the real ~/Library/LaunchAgents/ and writes the
  // user's canonical plist with sandbox MYCO_HOME paths, hijacking the
  // running daemon.
  describe('MYCO_LAUNCH_AGENTS_DIR propagation', () => {
    const originalEnv = process.env[SERVICE_UNIT_DIR_ENV];
    beforeEach(() => { delete process.env[SERVICE_UNIT_DIR_ENV]; });
    afterEach(() => {
      if (originalEnv === undefined) delete process.env[SERVICE_UNIT_DIR_ENV];
      else process.env[SERVICE_UNIT_DIR_ENV] = originalEnv;
    });

    test('plist env omits MYCO_LAUNCH_AGENTS_DIR when unset (default behavior is unchanged)', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
      const bin = makeFakeBinary();
      const spec = buildServiceSpec({ mycoHome: home, executable: bin });
      expect(spec.env[SERVICE_UNIT_DIR_ENV]).toBeUndefined();
    });

    test('plist env carries MYCO_LAUNCH_AGENTS_DIR through to the supervisor-spawned child', () => {
      process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-abc/Library/LaunchAgents';
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
      const bin = makeFakeBinary();
      const spec = buildServiceSpec({ mycoHome: home, executable: bin });
      expect(spec.env[SERVICE_UNIT_DIR_ENV]).toBe('/tmp/sandbox-abc/Library/LaunchAgents');
    });

    test('whitespace-only env value is not propagated', () => {
      process.env[SERVICE_UNIT_DIR_ENV] = '   ';
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
      const bin = makeFakeBinary();
      const spec = buildServiceSpec({ mycoHome: home, executable: bin });
      expect(spec.env[SERVICE_UNIT_DIR_ENV]).toBeUndefined();
    });
  });

  test('default home allows a normal globally-installed path (npm-style)', () => {
    // Simulate a global install layout: no 'packages/<pkg>/vendor/' segment.
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-global-'));
    const vendorDir = path.join(globalDir, 'node_modules', '@goondocks', 'myco', 'vendor', 'darwin-arm64');
    fs.mkdirSync(vendorDir, { recursive: true });
    const bin = path.join(vendorDir, 'myco');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const spec = buildServiceSpec({
      mycoHome: DEFAULT_HOME,
      executable: bin,
    });
    expect(spec.variant).toBe('prod');
    expect(spec.executable).toBe(bin);
  });
});
