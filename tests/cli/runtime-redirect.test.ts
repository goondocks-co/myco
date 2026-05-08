/**
 * Tests for bin/runtime-redirect.cjs — the CLI shim's machine-scope
 * runtime pin reader.
 *
 * The orchestration in `maybeRedirect` calls `process.exit` on successful
 * redirect, so it's exercised via a spawned subprocess. The pure helpers
 * are unit-tested in-process via require().
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MODULE_PATH = path.resolve('packages/myco/bin/runtime-redirect.cjs');

type Helpers = {
  readMachineRuntimeCommand: (env?: NodeJS.ProcessEnv, traceRefusal?: (reason: string) => void) => string | null;
  pointsAtSelf: (target: string, selfPath: string) => boolean;
  checkRuntimeCommandTrust: (filePath: string) => { ok: boolean; reason?: string };
};

const POSIX = process.platform !== 'win32';

// Fresh require each test so module cache can't carry state between them.
function loadModule(): Helpers {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  delete require.cache[MODULE_PATH];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(MODULE_PATH) as Helpers;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-redirect-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readMachineRuntimeCommand
// ---------------------------------------------------------------------------

describe('readMachineRuntimeCommand', () => {
  it('returns null when ~/.myco/runtime.command does not exist', () => {
    const { readMachineRuntimeCommand } = loadModule();
    expect(readMachineRuntimeCommand({ MYCO_HOME: tmpRoot })).toBeNull();
  });

  it('returns the trimmed contents when runtime.command is present', () => {
    fs.writeFileSync(path.join(tmpRoot, 'runtime.command'), '/opt/pinned/myco\n');
    const { readMachineRuntimeCommand } = loadModule();
    expect(readMachineRuntimeCommand({ MYCO_HOME: tmpRoot })).toBe('/opt/pinned/myco');
  });

  it('returns null when runtime.command exists but is empty / whitespace only', () => {
    fs.writeFileSync(path.join(tmpRoot, 'runtime.command'), '   \n');
    const { readMachineRuntimeCommand } = loadModule();
    expect(readMachineRuntimeCommand({ MYCO_HOME: tmpRoot })).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // G7: refuse to honor a pin file that's group/other-writable or foreign-owned
  // ---------------------------------------------------------------------------

  it('refuses a pin file that is group-writable', () => {
    if (!POSIX) return;
    const filePath = path.join(tmpRoot, 'runtime.command');
    fs.writeFileSync(filePath, '/opt/pinned/myco');
    fs.chmodSync(filePath, 0o664);
    const traces: string[] = [];
    const { readMachineRuntimeCommand } = loadModule();
    expect(readMachineRuntimeCommand({ MYCO_HOME: tmpRoot }, (reason) => traces.push(reason))).toBeNull();
    expect(traces.some((t) => t.includes('writable by group/other'))).toBe(true);
  });

  it('refuses a pin file that is other-writable', () => {
    if (!POSIX) return;
    const filePath = path.join(tmpRoot, 'runtime.command');
    fs.writeFileSync(filePath, '/opt/pinned/myco');
    fs.chmodSync(filePath, 0o646);
    const { readMachineRuntimeCommand } = loadModule();
    expect(readMachineRuntimeCommand({ MYCO_HOME: tmpRoot })).toBeNull();
  });

  it('accepts a pin file with 0o600 perms', () => {
    if (!POSIX) return;
    const filePath = path.join(tmpRoot, 'runtime.command');
    fs.writeFileSync(filePath, '/opt/pinned/myco');
    fs.chmodSync(filePath, 0o600);
    const { readMachineRuntimeCommand } = loadModule();
    expect(readMachineRuntimeCommand({ MYCO_HOME: tmpRoot })).toBe('/opt/pinned/myco');
  });

  it('accepts a pin file with 0o644 perms (group/other readable but not writable)', () => {
    if (!POSIX) return;
    const filePath = path.join(tmpRoot, 'runtime.command');
    fs.writeFileSync(filePath, '/opt/pinned/myco');
    fs.chmodSync(filePath, 0o644);
    const { readMachineRuntimeCommand } = loadModule();
    expect(readMachineRuntimeCommand({ MYCO_HOME: tmpRoot })).toBe('/opt/pinned/myco');
  });

  it('checkRuntimeCommandTrust returns ok for owner-only files', () => {
    if (!POSIX) return;
    const filePath = path.join(tmpRoot, 'runtime.command');
    fs.writeFileSync(filePath, 'x', { mode: 0o600 });
    const { checkRuntimeCommandTrust } = loadModule();
    expect(checkRuntimeCommandTrust(filePath).ok).toBe(true);
  });

  it('checkRuntimeCommandTrust returns ok=false for missing files', () => {
    const { checkRuntimeCommandTrust } = loadModule();
    const result = checkRuntimeCommandTrust(path.join(tmpRoot, 'absent'));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/);
  });

  it('expands a leading ~ in MYCO_HOME', () => {
    // Write the file under the test's HOME so `MYCO_HOME=~/myco-home-test/.myco`
    // expands to a real path. Cleanup happens via afterEach since tmpRoot
    // already covers it — but we need to write under HOME for the expansion
    // case, so we just verify the no-throw / null branch.
    const { readMachineRuntimeCommand } = loadModule();
    // ~ alone is supported as a shorthand for HOME.
    expect(() => readMachineRuntimeCommand({ MYCO_HOME: '~' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// pointsAtSelf
// ---------------------------------------------------------------------------

describe('pointsAtSelf', () => {
  it('returns true when target and self resolve to the same realpath', () => {
    const binaryPath = path.join(tmpRoot, 'myco');
    fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const symlinkPath = path.join(tmpRoot, 'myco-link');
    fs.symlinkSync(binaryPath, symlinkPath);

    const { pointsAtSelf } = loadModule();
    expect(pointsAtSelf(symlinkPath, binaryPath)).toBe(true);
  });

  it('returns false for distinct files', () => {
    const a = path.join(tmpRoot, 'a');
    const b = path.join(tmpRoot, 'b');
    fs.writeFileSync(a, 'a');
    fs.writeFileSync(b, 'b');
    const { pointsAtSelf } = loadModule();
    expect(pointsAtSelf(a, b)).toBe(false);
  });

  it('returns false when the target does not exist', () => {
    const self = path.join(tmpRoot, 'self');
    fs.writeFileSync(self, 'self');
    const { pointsAtSelf } = loadModule();
    expect(pointsAtSelf(path.join(tmpRoot, 'missing'), self)).toBe(false);
  });

  it('returns false for unqualified PATH commands without a separator', () => {
    const self = path.join(tmpRoot, 'self');
    fs.writeFileSync(self, 'self');
    const { pointsAtSelf } = loadModule();
    expect(pointsAtSelf('myco', self)).toBe(false);
    expect(pointsAtSelf('myco-dev', self)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maybeRedirect — end-to-end via spawn (process.exit paths)
// ---------------------------------------------------------------------------

describe('maybeRedirect (integration)', () => {
  /** Build a self-contained shim fixture with our own runtime-redirect.cjs. */
  function makeShim(): { shimPath: string; runtimeRedirect: string } {
    const runtimeRedirect = path.join(tmpRoot, 'runtime-redirect.cjs');
    fs.copyFileSync(MODULE_PATH, runtimeRedirect);

    const shimPath = path.join(tmpRoot, 'shim.cjs');
    fs.writeFileSync(
      shimPath,
      [
        '#!/usr/bin/env node',
        `const { maybeRedirect } = require(${JSON.stringify(runtimeRedirect)});`,
        'maybeRedirect(__filename);',
        'process.stdout.write("shim:" + process.argv.slice(2).join(" "));',
      ].join('\n'),
      { mode: 0o755 },
    );
    return { shimPath, runtimeRedirect };
  }

  /** Make a fresh `~/.myco`-shaped MYCO_HOME and return its absolute path. */
  function makeMycoHome(): string {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'myco-home-'));
    return home;
  }

  it('falls through to normal dispatch when no pin exists', () => {
    const { shimPath } = makeShim();
    const home = makeMycoHome();

    const res = spawnSync(process.execPath, [shimPath, 'doctor'], {
      cwd: tmpRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('shim:doctor');
  });

  it('redirects to the pinned binary and forwards argv', () => {
    const { shimPath } = makeShim();
    const home = makeMycoHome();

    const pinned = path.join(tmpRoot, 'pinned.sh');
    fs.writeFileSync(
      pinned,
      [
        '#!/bin/sh',
        'printf "pinned:%s:redirected=%s" "$*" "${MYCO_REDIRECTED}"',
      ].join('\n'),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(home, 'runtime.command'), pinned);

    const res = spawnSync(process.execPath, [shimPath, 'doctor', '--fix'], {
      cwd: tmpRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('pinned:doctor --fix:redirected=1');
  });

  it('skips redirect when MYCO_REDIRECTED is already set', () => {
    const { shimPath } = makeShim();
    const home = makeMycoHome();
    fs.writeFileSync(path.join(home, 'runtime.command'), '/nonexistent/should/not/matter');

    const res = spawnSync(process.execPath, [shimPath, 'ok'], {
      cwd: tmpRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('shim:ok');
  });

  it('falls through when the pin target is missing (ENOENT)', () => {
    const { shimPath } = makeShim();
    const home = makeMycoHome();
    fs.writeFileSync(path.join(home, 'runtime.command'), '/definitely/not/a/real/binary');

    const res = spawnSync(process.execPath, [shimPath, 'doctor'], {
      cwd: tmpRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('shim:doctor');
  });

  it('propagates non-zero exit status from the pinned binary', () => {
    const { shimPath } = makeShim();
    const home = makeMycoHome();

    const pinned = path.join(tmpRoot, 'failing.sh');
    fs.writeFileSync(pinned, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    fs.writeFileSync(path.join(home, 'runtime.command'), pinned);

    const res = spawnSync(process.execPath, [shimPath], {
      cwd: tmpRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(42);
  });

  it('stays silent on stderr by default when redirecting', () => {
    const { shimPath } = makeShim();
    const home = makeMycoHome();
    const pinned = path.join(tmpRoot, 'silent-pinned.sh');
    fs.writeFileSync(pinned, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(home, 'runtime.command'), pinned);

    const res = spawnSync(process.execPath, [shimPath], {
      cwd: tmpRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined, MYCO_DEBUG_REDIRECT: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('traces the redirect to stderr when MYCO_DEBUG_REDIRECT is set', () => {
    const { shimPath } = makeShim();
    const home = makeMycoHome();
    const pinned = path.join(tmpRoot, 'traced-pinned.sh');
    fs.writeFileSync(pinned, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(home, 'runtime.command'), pinned);

    const res = spawnSync(process.execPath, [shimPath], {
      cwd: tmpRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined, MYCO_DEBUG_REDIRECT: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('[myco] redirect:');
    expect(res.stderr).toContain(shimPath);
    expect(res.stderr).toContain(pinned);
  });

  it('traces the skip reason when MYCO_DEBUG_REDIRECT is set and no pin exists', () => {
    const { shimPath } = makeShim();
    const home = makeMycoHome();

    const res = spawnSync(process.execPath, [shimPath], {
      cwd: tmpRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined, MYCO_DEBUG_REDIRECT: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('[myco] redirect: skip (no ~/.myco/runtime.command pin found)');
  });

  it('traces the skip reason when MYCO_REDIRECTED is already set', () => {
    const { shimPath } = makeShim();
    const home = makeMycoHome();
    fs.writeFileSync(path.join(home, 'runtime.command'), '/unused');

    const res = spawnSync(process.execPath, [shimPath], {
      cwd: tmpRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: '1', MYCO_DEBUG_REDIRECT: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('[myco] redirect: skip (MYCO_REDIRECTED already set)');
  });
});
