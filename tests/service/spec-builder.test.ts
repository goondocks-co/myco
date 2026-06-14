import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServiceSpec } from '../../packages/myco/src/service/spec-builder';
import { SERVICE_UNIT_DIR_ENV } from '../../packages/myco/src/service/paths';

function makeFakeBinary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-svc-spec-'));
  const bin = path.join(dir, 'myco');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}

describe('buildServiceSpec', () => {
  test('prod spec has prod label, service/ paths, no MYCO_HOME override', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const bin = makeFakeBinary();
    const spec = buildServiceSpec({ variant: 'prod', mycoHome: home, executable: bin });
    expect(spec.label).toBe('co.goondocks.myco');
    expect(spec.variant).toBe('prod');
    expect(spec.executable).toBe(bin);
    expect(spec.args).toEqual(['daemon']);
    expect(spec.stdoutPath).toBe(path.join(home, 'service', 'logs', 'daemon.out.log'));
    expect(spec.stderrPath).toBe(path.join(home, 'service', 'logs', 'daemon.err.log'));
    expect(spec.runAtLoad).toBe(true);
    expect(spec.keepAlive).toBe(true);
    expect(spec.env.MYCO_HOME).toBe(home);
    expect(spec.env.MYCO_SERVICE_VARIANT).toBe('prod');
  });

  test('dev spec uses dev label and service-dev/ log paths', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const bin = makeFakeBinary();
    const spec = buildServiceSpec({ variant: 'dev', mycoHome: home, executable: bin });
    expect(spec.label).toBe('co.goondocks.myco-dev');
    expect(spec.stdoutPath).toBe(path.join(home, 'service-dev', 'logs', 'daemon.out.log'));
    expect(spec.env.MYCO_SERVICE_VARIANT).toBe('dev');
  });

  test('throws if executable does not exist on disk', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    expect(() => buildServiceSpec({
      variant: 'prod',
      mycoHome: home,
      executable: '/nonexistent/myco',
    })).toThrow(/executable not found/i);
  });

  test('rejects executable paths under /opt/homebrew/Cellar (versioned brew paths break on upgrade)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    expect(() => buildServiceSpec({
      variant: 'prod',
      mycoHome: home,
      executable: '/opt/homebrew/Cellar/node/25.9.0_2/bin/node',
    })).toThrow(/Cellar/);
  });

  test('darwin service PATH includes Homebrew bin + /usr/local/bin', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const bin = makeFakeBinary();
    const spec = buildServiceSpec({ variant: 'prod', mycoHome: home, executable: bin, platform: 'darwin' });
    expect(spec.env.PATH).toContain('/opt/homebrew/bin');
    expect(spec.env.PATH).toContain('/usr/local/bin');
  });

  test('linux service PATH omits Homebrew bin', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const bin = makeFakeBinary();
    const spec = buildServiceSpec({ variant: 'prod', mycoHome: home, executable: bin, platform: 'linux' });
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
      expect(() => buildServiceSpec({ variant: 'prod', mycoHome: home, executable: exe })).toThrow(/script-runner|standalone daemon binary/);
    }
  });

  // Regression: the prod plist was once written with a dev-build path,
  // after which launchd spawned the dev binary as the prod service —
  // running unreleased code against the prod Grove. The guard must
  // refuse the substitution regardless of which caller invoked us.
  test('refuses prod variant when executable is a dev-build path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-repo-'));
    const vendorDir = path.join(repoRoot, 'packages', 'myco', 'vendor', 'darwin-arm64');
    fs.mkdirSync(vendorDir, { recursive: true });
    const devBin = path.join(vendorDir, 'myco');
    fs.writeFileSync(devBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    expect(() => buildServiceSpec({
      variant: 'prod',
      mycoHome: home,
      executable: devBin,
    })).toThrow(/dev-build executable|packages\/<pkg>\/vendor/);
  });

  test('allows dev variant with a dev-build path (the legitimate dogfood case)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-repo-'));
    const vendorDir = path.join(repoRoot, 'packages', 'myco', 'vendor', 'darwin-arm64');
    fs.mkdirSync(vendorDir, { recursive: true });
    const devBin = path.join(vendorDir, 'myco');
    fs.writeFileSync(devBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const spec = buildServiceSpec({
      variant: 'dev',
      mycoHome: home,
      executable: devBin,
    });
    expect(spec.executable).toBe(devBin);
    expect(spec.variant).toBe('dev');
  });

  test('prod refuses a symlink whose realpath resolves into a vendor tree', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-repo-'));
    const vendorDir = path.join(repoRoot, 'packages', 'myco', 'vendor', 'darwin-arm64');
    fs.mkdirSync(vendorDir, { recursive: true });
    const realBin = path.join(vendorDir, 'myco');
    fs.writeFileSync(realBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // The user installs via a symlink that lives outside vendor/.
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-link-'));
    const link = path.join(linkDir, 'myco');
    fs.symlinkSync(realBin, link);

    expect(() => buildServiceSpec({
      variant: 'prod',
      mycoHome: home,
      executable: link,
    })).toThrow(/dev-build executable/);
  });

  // Regression for canonical-plist hijack. launchd's RunAtLoad fires the
  // moment we `launchctl bootstrap` the sandbox plist — the supervisor-
  // spawned child daemon then re-runs ensureSelfInstalledAsService during
  // its own startup. If the plist env block doesn't carry MYCO_LAUNCH_AGENTS_DIR,
  // the child resolves to the real ~/Library/LaunchAgents/ and writes the
  // user's canonical plist with sandbox MYCO_HOME paths, hijacking the
  // running dev/prod daemon. Burned the variant-pinned smoke test.
  describe('MYCO_LAUNCH_AGENTS_DIR propagation', () => {
    const originalEnv = process.env[SERVICE_UNIT_DIR_ENV];
    beforeEach(() => { delete process.env[SERVICE_UNIT_DIR_ENV]; });
    afterEach(() => {
      if (originalEnv === undefined) delete process.env[SERVICE_UNIT_DIR_ENV];
      else process.env[SERVICE_UNIT_DIR_ENV] = originalEnv;
    });

    test('plist env omits MYCO_LAUNCH_AGENTS_DIR when unset (default prod behavior is unchanged)', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
      const bin = makeFakeBinary();
      const spec = buildServiceSpec({ variant: 'prod', mycoHome: home, executable: bin });
      expect(spec.env[SERVICE_UNIT_DIR_ENV]).toBeUndefined();
    });

    test('plist env carries MYCO_LAUNCH_AGENTS_DIR through to the supervisor-spawned child', () => {
      process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-abc/Library/LaunchAgents';
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
      const bin = makeFakeBinary();
      const spec = buildServiceSpec({ variant: 'dev', mycoHome: home, executable: bin });
      expect(spec.env[SERVICE_UNIT_DIR_ENV]).toBe('/tmp/sandbox-abc/Library/LaunchAgents');
    });

    test('whitespace-only env value is not propagated', () => {
      process.env[SERVICE_UNIT_DIR_ENV] = '   ';
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
      const bin = makeFakeBinary();
      const spec = buildServiceSpec({ variant: 'prod', mycoHome: home, executable: bin });
      expect(spec.env[SERVICE_UNIT_DIR_ENV]).toBeUndefined();
    });
  });

  test('prod allows a normal globally-installed path (npm-style)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    // Simulate a global install layout: no 'packages/<pkg>/vendor/' segment.
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-global-'));
    const vendorDir = path.join(globalDir, 'node_modules', '@goondocks', 'myco', 'vendor', 'darwin-arm64');
    fs.mkdirSync(vendorDir, { recursive: true });
    const bin = path.join(vendorDir, 'myco');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const spec = buildServiceSpec({
      variant: 'prod',
      mycoHome: home,
      executable: bin,
    });
    expect(spec.variant).toBe('prod');
    expect(spec.executable).toBe(bin);
  });
});
