/**
 * Contract matrix for runtime/binary-resolution: every policy against every
 * pin state (absent / trusted / untrusted / dangling), managed-binary state
 * (runnable / present-not-executable / absent), platform, and pin scope.
 * Asserts `path`, `source`, `args`, and `facts` — not just the path.
 */

import { afterEach, describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bareCommandName,
  checkPinTrust,
  gatherFacts,
  isRunnableBinary,
  readLayeredPin,
  resolveBinary,
  type ResolutionEnv,
} from '@myco/runtime/binary-resolution.js';
import { managedBinaryPath } from '@myco/install/managed-binary.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

interface Fixture {
  home: string;
  env: ResolutionEnv;
  managed: string;
}

function fixture(overrides: Partial<ResolutionEnv> = {}): Fixture {
  const home = tmpdir('myco-binres-home-');
  const env: ResolutionEnv = {
    mycoHome: home,
    platform: 'linux',
    localAppData: undefined,
    execPath: '/proc/self/exe-stub',
    argv1: undefined,
    ...overrides,
  };
  return { home, env, managed: managedBinaryPath(home, env.platform!, env.localAppData) };
}

function writeManaged(fx: Fixture, mode = 0o755): void {
  fs.mkdirSync(path.dirname(fx.managed), { recursive: true });
  fs.writeFileSync(fx.managed, '#!/bin/sh\nexit 0\n', { mode });
}

function writePin(fx: Fixture, target: string, mode = 0o644): string {
  const pinPath = path.join(fx.home, 'runtime.command');
  fs.mkdirSync(fx.home, { recursive: true });
  fs.writeFileSync(pinPath, `${target}\n`, { mode });
  fs.chmodSync(pinPath, mode);
  return pinPath;
}

// ---------------------------------------------------------------------------
// Pin trust and layering
// ---------------------------------------------------------------------------

describe('pin trust (G7)', () => {
  it('trusts 0644 and refuses group/other-writable modes', () => {
    const fx = fixture();
    const pinPath = writePin(fx, '/x/myco', 0o644);
    expect(checkPinTrust(pinPath, fx.env)).toEqual({ ok: true });
    fs.chmodSync(pinPath, 0o664);
    expect(checkPinTrust(pinPath, fx.env).ok).toBe(false);
    fs.chmodSync(pinPath, 0o666);
    expect(checkPinTrust(pinPath, fx.env).ok).toBe(false);
  });

  it('refuses a foreign-owner pin', () => {
    const fx = fixture({ getuid: () => 424242 });
    const pinPath = writePin(fx, '/x/myco');
    const trust = checkPinTrust(pinPath, fx.env);
    expect(trust.ok).toBe(false);
    expect((trust as { reason: string }).reason).toContain('owned by uid');
  });

  it('always trusts on win32 (no POSIX modes)', () => {
    const fx = fixture({ platform: 'win32' });
    const pinPath = writePin(fx, 'C:\\x\\myco.exe', 0o666);
    expect(checkPinTrust(pinPath, fx.env)).toEqual({ ok: true });
  });

  it('an untrusted pin resolves as if absent', () => {
    const fx = fixture();
    writePin(fx, '/x/dev-myco', 0o666);
    writeManaged(fx);
    const result = resolveBinary('self-exec', { kind: 'machine' }, fx.env);
    expect(result.source).toBe('managed');
    expect(result.facts.pin).toBeNull();
  });
});

describe('pin layering', () => {
  it('machine scope ignores a project pin entirely', () => {
    const fx = fixture();
    const project = tmpdir('myco-binres-proj-');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    const projectPin = path.join(project, '.myco', 'runtime.command');
    fs.writeFileSync(projectPin, '/project/dev-myco\n', { mode: 0o644 });
    fs.chmodSync(projectPin, 0o644);

    expect(readLayeredPin({ kind: 'machine' }, fx.env)).toBeNull();
    const walked = readLayeredPin({ kind: 'walk-up', from: path.join(project, 'src') }, fx.env);
    expect(walked).toEqual({ pin: '/project/dev-myco', pinPath: projectPin, pinScope: 'project' });
  });

  it('walk-up falls through an untrusted project pin to the machine pin', () => {
    const fx = fixture();
    const project = tmpdir('myco-binres-proj-');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    const projectPin = path.join(project, '.myco', 'runtime.command');
    fs.writeFileSync(projectPin, '/project/dev-myco\n', { mode: 0o666 });
    fs.chmodSync(projectPin, 0o666);
    const machinePinPath = writePin(fx, '/machine/myco');

    const walked = readLayeredPin({ kind: 'walk-up', from: project }, fx.env);
    expect(walked).toEqual({ pin: '/machine/myco', pinPath: machinePinPath, pinScope: 'machine' });
  });
});

// ---------------------------------------------------------------------------
// Policy matrix
// ---------------------------------------------------------------------------

describe('self-exec', () => {
  it('pin wins over a runnable managed binary', () => {
    const fx = fixture();
    writeManaged(fx);
    writePin(fx, '/pinned/myco');
    const result = resolveBinary('self-exec', { kind: 'machine' }, fx.env);
    expect(result).toMatchObject({ path: '/pinned/myco', source: 'pin' });
  });

  it('a trusted pin wins even when its target does not exist (override semantics; doctor reports it)', () => {
    const fx = fixture();
    writeManaged(fx);
    writePin(fx, '/gone/myco');
    const result = resolveBinary('self-exec', { kind: 'machine' }, fx.env);
    expect(result).toMatchObject({ path: '/gone/myco', source: 'pin' });
  });

  it('managed binary when no pin', () => {
    const fx = fixture();
    writeManaged(fx);
    const result = resolveBinary('self-exec', { kind: 'machine' }, fx.env);
    expect(result).toMatchObject({ path: fx.managed, source: 'managed' });
    expect(result.facts).toMatchObject({ managedExists: true, managedRunnable: true, pin: null });
  });

  it('skips a present-but-not-executable managed binary', () => {
    const fx = fixture();
    writeManaged(fx, 0o644);
    const result = resolveBinary('self-exec', { kind: 'machine' }, fx.env);
    expect(result).toMatchObject({ path: fx.env.execPath!, source: 'last-resort' });
    expect(result.facts).toMatchObject({ managedExists: true, managedRunnable: false });
  });

  it('execPath when nothing else resolves', () => {
    const fx = fixture();
    const result = resolveBinary('self-exec', { kind: 'machine' }, fx.env);
    expect(result).toMatchObject({ path: fx.env.execPath!, source: 'last-resort' });
  });
});

describe('self-exec-entry', () => {
  it('never consults pin or managed — re-exec must stay on the running code', () => {
    const fx = fixture({ argv1: undefined });
    writeManaged(fx);
    writePin(fx, '/pinned/myco');
    const result = resolveBinary('self-exec-entry', { kind: 'machine' }, fx.env);
    expect(result).toMatchObject({ path: fx.env.execPath!, source: 'last-resort', args: [] });
  });

  it('carries the dev entry script as leading argv', () => {
    const fx = fixture({ argv1: '/repo/packages/myco/src/cli.ts' });
    const result = resolveBinary('self-exec-entry', { kind: 'machine' }, fx.env);
    expect(result.args).toEqual(['/repo/packages/myco/src/cli.ts']);
  });

  it('treats bun virtual-fs entries as compiled (no extra argv)', () => {
    for (const argv1 of ['/$bunfs/root/cli.darwin-arm64.js', 'B:\\~BUN\\root\\cli.js']) {
      const fx = fixture({ argv1 });
      expect(resolveBinary('self-exec-entry', { kind: 'machine' }, fx.env).args).toEqual([]);
    }
  });
});

describe('home-scoped-managed', () => {
  it('non-default home always self-execs, even with a runnable managed binary and a pin', () => {
    // Home isolation: a dogfood daemon's unit must never point at the default
    // home's binary, and a service unit follows no pin.
    const fx = fixture();
    writeManaged(fx);
    writePin(fx, '/pinned/myco');
    const result = resolveBinary('home-scoped-managed', { kind: 'machine' }, fx.env);
    expect(result).toMatchObject({ path: fx.env.execPath!, source: 'last-resort' });
  });

  it('default home uses the managed binary when runnable', () => {
    const home = path.join(os.homedir(), '.myco');
    const managed = managedBinaryPath(home, 'linux', undefined);
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      const env: ResolutionEnv = { mycoHome: home, platform: 'linux', localAppData: undefined, execPath: '/stub' };
      const result = resolveBinary('home-scoped-managed', { kind: 'machine' }, env);
      expect(result).toMatchObject({ path: managed, source: 'managed' });
    } finally {
      fs.rmSync(managed, { force: true });
    }
  });
});

describe('managed-destination', () => {
  it('returns the managed path with no existence gate — it is a copy target', () => {
    const fx = fixture();
    const result = resolveBinary('managed-destination', { kind: 'machine' }, fx.env);
    expect(result).toMatchObject({ path: fx.managed, source: 'managed' });
    expect(result.facts.managedExists).toBe(false);
  });
});

describe('instruction', () => {
  it('pin, then runnable managed, then the bare name — never execPath', () => {
    const fx = fixture();
    expect(resolveBinary('instruction', { kind: 'machine' }, fx.env)).toMatchObject({
      path: 'myco',
      source: 'last-resort',
    });

    writeManaged(fx);
    expect(resolveBinary('instruction', { kind: 'machine' }, fx.env)).toMatchObject({
      path: fx.managed,
      source: 'managed',
    });

    writePin(fx, '/pinned/myco');
    expect(resolveBinary('instruction', { kind: 'machine' }, fx.env)).toMatchObject({
      path: '/pinned/myco',
      source: 'pin',
    });
  });

  it('bare name is platform-suffixed', () => {
    expect(bareCommandName('win32')).toBe('myco.exe');
    expect(bareCommandName('linux')).toBe('myco');
    const fx = fixture({ platform: 'win32' });
    const result = resolveBinary('instruction', { kind: 'machine' }, fx.env);
    expect(result.path).toBe('myco.exe');
  });
});

// ---------------------------------------------------------------------------
// Facts and helpers
// ---------------------------------------------------------------------------

describe('facts', () => {
  it('reports layout, managed state, and pin state for doctor to consume raw', () => {
    const fx = fixture();
    writeManaged(fx, 0o644);
    const pinPath = writePin(fx, '/pinned/myco');
    const facts = gatherFacts({ kind: 'machine' }, fx.env);
    expect(facts).toEqual({
      binDir: path.dirname(fx.managed),
      managedBinary: fx.managed,
      managedExists: true,
      managedRunnable: false,
      pin: '/pinned/myco',
      pinPath,
      pinScope: 'machine',
      pinRefusal: null,
    });
  });

  it('win32 layout roots at LOCALAPPDATA', () => {
    const fx = fixture({ platform: 'win32', localAppData: 'C:\\Users\\u\\AppData\\Local' });
    const facts = gatherFacts({ kind: 'machine' }, fx.env);
    expect(facts.managedBinary).toBe('C:\\Users\\u\\AppData\\Local\\Myco\\bin\\myco.exe');
    expect(facts.binDir).toBe('C:\\Users\\u\\AppData\\Local\\Myco\\bin');
  });
});

describe('pin refusal fact', () => {
  it('a refused machine pin surfaces in facts.pinRefusal', () => {
    const fx = fixture();
    writePin(fx, '/x/myco', 0o666);
    const facts = gatherFacts({ kind: 'machine' }, fx.env);
    expect(facts.pin).toBeNull();
    expect(facts.pinRefusal?.reason).toContain('writable by group/other');
  });

  it('an absent pin leaves pinRefusal null', () => {
    const fx = fixture();
    expect(gatherFacts({ kind: 'machine' }, fx.env).pinRefusal).toBeNull();
  });
});

describe('home-scoped-managed executability', () => {
  it('skips a present-but-not-executable managed binary', () => {
    const home = path.join(os.homedir(), '.myco');
    const managed = managedBinaryPath(home, 'linux', undefined);
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    try {
      const env: ResolutionEnv = { mycoHome: home, platform: 'linux', localAppData: undefined, execPath: '/stub' };
      const result = resolveBinary('home-scoped-managed', { kind: 'machine' }, env);
      expect(result).toMatchObject({ path: '/stub', source: 'last-resort' });
    } finally {
      fs.rmSync(managed, { force: true });
    }
  });
});

describe('isRunnableBinary', () => {
  it('rejects directories and 0644 files, accepts 0755 files', () => {
    const fx = fixture();
    expect(isRunnableBinary(fx.home, fx.env)).toBe(false);
    writeManaged(fx, 0o644);
    expect(isRunnableBinary(fx.managed, fx.env)).toBe(false);
    fs.chmodSync(fx.managed, 0o755);
    expect(isRunnableBinary(fx.managed, fx.env)).toBe(true);
  });
});
