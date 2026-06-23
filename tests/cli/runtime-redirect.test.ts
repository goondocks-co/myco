/**
 * Tests for bin/runtime-redirect.cjs — the CLI shim's layered runtime pin
 * reader (project pin via cwd walk-up, then machine pin at ~/.myco/).
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

type Found = { pin: string; source: string };
type Helpers = {
  readMachineRuntimeCommand: (env?: NodeJS.ProcessEnv, traceRefusal?: (reason: string) => void) => Found | null;
  readProjectRuntimeCommand: (startDir: string, traceRefusal?: (reason: string) => void) => Found | null;
  readLayeredRuntimeCommand: (startDir: string, env?: NodeJS.ProcessEnv, traceRefusal?: (reason: string) => void) => Found | null;
  readRuntimeHomeBeside: (commandSource: string, traceRefusal?: (reason: string) => void) => string | null;
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
    expect(readMachineRuntimeCommand({ MYCO_HOME: tmpRoot })?.pin).toBe('/opt/pinned/myco');
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
    expect(readMachineRuntimeCommand({ MYCO_HOME: tmpRoot })?.pin).toBe('/opt/pinned/myco');
  });

  it('accepts a pin file with 0o644 perms (group/other readable but not writable)', () => {
    if (!POSIX) return;
    const filePath = path.join(tmpRoot, 'runtime.command');
    fs.writeFileSync(filePath, '/opt/pinned/myco');
    fs.chmodSync(filePath, 0o644);
    const { readMachineRuntimeCommand } = loadModule();
    expect(readMachineRuntimeCommand({ MYCO_HOME: tmpRoot })?.pin).toBe('/opt/pinned/myco');
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
    const { readMachineRuntimeCommand } = loadModule();
    expect(() => readMachineRuntimeCommand({ MYCO_HOME: '~' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// readProjectRuntimeCommand — walk-up from cwd
// ---------------------------------------------------------------------------

describe('readProjectRuntimeCommand', () => {
  it('returns null when no ancestor of startDir has a .myco/runtime.command', () => {
    const { readProjectRuntimeCommand } = loadModule();
    expect(readProjectRuntimeCommand(tmpRoot)).toBeNull();
  });

  it('returns the pin when startDir itself has .myco/runtime.command', () => {
    fs.mkdirSync(path.join(tmpRoot, '.myco'));
    fs.writeFileSync(path.join(tmpRoot, '.myco', 'runtime.command'), '/dev/myco-dev\n');
    const { readProjectRuntimeCommand } = loadModule();
    expect(readProjectRuntimeCommand(tmpRoot)?.pin).toBe('/dev/myco-dev');
  });

  it('walks up from a nested subdirectory to find an ancestor pin', () => {
    fs.mkdirSync(path.join(tmpRoot, '.myco'));
    fs.writeFileSync(path.join(tmpRoot, '.myco', 'runtime.command'), '/dev/myco-dev');
    const nested = path.join(tmpRoot, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    const { readProjectRuntimeCommand } = loadModule();
    expect(readProjectRuntimeCommand(nested)?.pin).toBe('/dev/myco-dev');
  });

  it('returns the closest ancestor when multiple .myco/runtime.command files exist', () => {
    fs.mkdirSync(path.join(tmpRoot, '.myco'));
    fs.writeFileSync(path.join(tmpRoot, '.myco', 'runtime.command'), '/outer/myco');
    const inner = path.join(tmpRoot, 'inner');
    fs.mkdirSync(path.join(inner, '.myco'), { recursive: true });
    fs.writeFileSync(path.join(inner, '.myco', 'runtime.command'), '/inner/myco');
    const { readProjectRuntimeCommand } = loadModule();
    expect(readProjectRuntimeCommand(inner)?.pin).toBe('/inner/myco');
  });
});

// ---------------------------------------------------------------------------
// readLayeredRuntimeCommand — project pin overrides machine pin
// ---------------------------------------------------------------------------

describe('readLayeredRuntimeCommand', () => {
  it('returns project pin when both project and machine pins exist', () => {
    fs.mkdirSync(path.join(tmpRoot, '.myco'));
    fs.writeFileSync(path.join(tmpRoot, '.myco', 'runtime.command'), '/project/myco-dev');
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
    fs.writeFileSync(path.join(home, 'runtime.command'), '/machine/myco');
    const { readLayeredRuntimeCommand } = loadModule();
    expect(readLayeredRuntimeCommand(tmpRoot, { MYCO_HOME: home })?.pin).toBe('/project/myco-dev');
  });

  it('falls back to machine pin when no project pin exists in startDir ancestry', () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
    fs.writeFileSync(path.join(home, 'runtime.command'), '/machine/myco');
    const sub = path.join(tmpRoot, 'sub');
    fs.mkdirSync(sub);
    const { readLayeredRuntimeCommand } = loadModule();
    expect(readLayeredRuntimeCommand(sub, { MYCO_HOME: home })?.pin).toBe('/machine/myco');
  });

  it('returns null when neither layer has a pin', () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
    const { readLayeredRuntimeCommand } = loadModule();
    expect(readLayeredRuntimeCommand(tmpRoot, { MYCO_HOME: home })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readRuntimeHomeBeside — the runtime.home sibling of the winning command pin
// ---------------------------------------------------------------------------

describe('readRuntimeHomeBeside', () => {
  it('returns null when no runtime.home sits beside the command pin', () => {
    const commandSource = path.join(tmpRoot, '.myco', 'runtime.command');
    const { readRuntimeHomeBeside } = loadModule();
    expect(readRuntimeHomeBeside(commandSource)).toBeNull();
  });

  it('returns the absolute home when a trusted runtime.home sits beside the command pin', () => {
    fs.mkdirSync(path.join(tmpRoot, '.myco'));
    const commandSource = path.join(tmpRoot, '.myco', 'runtime.command');
    fs.writeFileSync(path.join(tmpRoot, '.myco', 'runtime.home'), '/home/user/.myco-dev\n');
    const { readRuntimeHomeBeside } = loadModule();
    expect(readRuntimeHomeBeside(commandSource)).toBe('/home/user/.myco-dev');
  });

  it('expands a leading ~ in the runtime.home value', () => {
    fs.mkdirSync(path.join(tmpRoot, '.myco'));
    const commandSource = path.join(tmpRoot, '.myco', 'runtime.command');
    fs.writeFileSync(path.join(tmpRoot, '.myco', 'runtime.home'), '~/.myco-dev');
    const { readRuntimeHomeBeside } = loadModule();
    expect(readRuntimeHomeBeside(commandSource)).toBe(path.join(os.homedir(), '.myco-dev'));
  });

  it('refuses (returns null + traces) a group-writable runtime.home', () => {
    if (!POSIX) return;
    fs.mkdirSync(path.join(tmpRoot, '.myco'));
    const commandSource = path.join(tmpRoot, '.myco', 'runtime.command');
    const homePin = path.join(tmpRoot, '.myco', 'runtime.home');
    fs.writeFileSync(homePin, '/home/user/.myco-dev');
    fs.chmodSync(homePin, 0o664);
    const traces: string[] = [];
    const { readRuntimeHomeBeside } = loadModule();
    expect(readRuntimeHomeBeside(commandSource, (reason) => traces.push(reason))).toBeNull();
    expect(traces.some((t) => t.includes('writable by group/other'))).toBe(true);
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
    // cwd is a fresh tmpRoot child with no `.myco/runtime.command` in any
    // ancestor and an empty MYCO_HOME — exercises the both-layers-empty
    // fallthrough trace.
    const cwd = fs.mkdtempSync(path.join(tmpRoot, 'cwd-'));

    const res = spawnSync(process.execPath, [shimPath], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined, MYCO_DEBUG_REDIRECT: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('[myco] redirect: skip (no project or machine runtime.command pin)');
  });

  it('honors a project pin over the machine pin when both are set', () => {
    const { shimPath } = makeShim();
    const home = makeMycoHome();

    const projectPinned = path.join(tmpRoot, 'project-pinned.sh');
    fs.writeFileSync(projectPinned, '#!/bin/sh\nprintf "project:%s" "$*"\n', { mode: 0o755 });
    const machinePinned = path.join(tmpRoot, 'machine-pinned.sh');
    fs.writeFileSync(machinePinned, '#!/bin/sh\nprintf "machine:%s" "$*"\n', { mode: 0o755 });

    const projectRoot = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
    fs.mkdirSync(path.join(projectRoot, '.myco'));
    fs.writeFileSync(path.join(projectRoot, '.myco', 'runtime.command'), projectPinned);
    fs.writeFileSync(path.join(home, 'runtime.command'), machinePinned);

    const res = spawnSync(process.execPath, [shimPath, 'doctor'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('project:doctor');
  });

  it('falls back to the machine pin when invoked outside any project pin tree', () => {
    const { shimPath } = makeShim();
    const home = makeMycoHome();
    const machinePinned = path.join(tmpRoot, 'machine-only.sh');
    fs.writeFileSync(machinePinned, '#!/bin/sh\nprintf "machine:%s" "$*"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(home, 'runtime.command'), machinePinned);
    // Walk up from tmpRoot finds no .myco/ dir — pure machine-pin path.
    const cwd = fs.mkdtempSync(path.join(tmpRoot, 'unrelated-'));

    const res = spawnSync(process.execPath, [shimPath, 'doctor'], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('machine:doctor');
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

  // -------------------------------------------------------------------------
  // runtime.home — the winning pin's sibling carries MYCO_HOME to the re-exec
  // -------------------------------------------------------------------------

  /** A pinned binary that prints the MYCO_HOME it was exec'd with. */
  function makeHomeEchoBinary(name: string): string {
    const pinned = path.join(tmpRoot, name);
    fs.writeFileSync(pinned, '#!/bin/sh\nprintf "home=%s" "${MYCO_HOME}"\n', { mode: 0o755 });
    return pinned;
  }

  it('carries a trusted project runtime.home into the re-exec as MYCO_HOME', () => {
    if (!POSIX) return;
    const { shimPath } = makeShim();
    const home = makeMycoHome();
    const pinned = makeHomeEchoBinary('home-echo.sh');

    // Project-scope pin + sibling runtime.home pointing at a dev home.
    const projectRoot = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
    const devHome = fs.mkdtempSync(path.join(tmpRoot, 'dev-home-'));
    fs.mkdirSync(path.join(projectRoot, '.myco'));
    fs.writeFileSync(path.join(projectRoot, '.myco', 'runtime.command'), pinned);
    fs.writeFileSync(path.join(projectRoot, '.myco', 'runtime.home'), devHome);

    const res = spawnSync(process.execPath, [shimPath], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`home=${devHome}`);
  });

  it('leaves MYCO_HOME at the inherited prod default when no runtime.home pin exists', () => {
    if (!POSIX) return;
    const { shimPath } = makeShim();
    const home = makeMycoHome();
    const pinned = makeHomeEchoBinary('home-echo-absent.sh');
    fs.writeFileSync(path.join(home, 'runtime.command'), pinned);

    const res = spawnSync(process.execPath, [shimPath], {
      cwd: tmpRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    // No runtime.home beside the machine pin → the child inherits the prod home.
    expect(res.stdout).toBe(`home=${home}`);
  });

  it('refuses an untrusted (group-writable) runtime.home — MYCO_HOME stays prod', () => {
    if (!POSIX) return;
    const { shimPath } = makeShim();
    const home = makeMycoHome();
    const pinned = makeHomeEchoBinary('home-echo-untrusted.sh');
    const devHome = fs.mkdtempSync(path.join(tmpRoot, 'dev-home-untrusted-'));

    fs.writeFileSync(path.join(home, 'runtime.command'), pinned);
    const homePin = path.join(home, 'runtime.home');
    fs.writeFileSync(homePin, devHome);
    fs.chmodSync(homePin, 0o664); // group-writable → refused by G7

    const res = spawnSync(process.execPath, [shimPath], {
      cwd: tmpRoot,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_HOME: home, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    // The untrusted dev-home pin is refused; the child keeps the prod home.
    expect(res.stdout).toBe(`home=${home}`);
  });
});
