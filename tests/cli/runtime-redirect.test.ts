/**
 * Tests for bin/runtime-redirect.cjs — the CLI shim's project-local
 * runtime pin walker.
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
  findProjectRuntimePin: (cwd: string) => string | null;
  resolveSearchStart: (cwd: string) => string;
  pointsAtSelf: (target: string, selfPath: string) => boolean;
};

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
// findProjectRuntimePin
// ---------------------------------------------------------------------------

describe('findProjectRuntimePin', () => {
  it('returns null when no .myco/runtime.command exists in any ancestor', () => {
    const { findProjectRuntimePin } = loadModule();
    expect(findProjectRuntimePin(tmpRoot)).toBeNull();
  });

  it('returns the trimmed contents when runtime.command is found at cwd', () => {
    const mycoDir = path.join(tmpRoot, '.myco');
    fs.mkdirSync(mycoDir);
    fs.writeFileSync(path.join(mycoDir, 'runtime.command'), '/opt/pinned/myco\n');
    const { findProjectRuntimePin } = loadModule();
    expect(findProjectRuntimePin(tmpRoot)).toBe('/opt/pinned/myco');
  });

  it('finds the pin when cwd is a subdirectory of the project', () => {
    const mycoDir = path.join(tmpRoot, '.myco');
    fs.mkdirSync(mycoDir);
    fs.writeFileSync(path.join(mycoDir, 'runtime.command'), '/opt/pinned/myco');
    const subdir = path.join(tmpRoot, 'src', 'deep');
    fs.mkdirSync(subdir, { recursive: true });
    const { findProjectRuntimePin } = loadModule();
    expect(findProjectRuntimePin(subdir)).toBe('/opt/pinned/myco');
  });

  it('returns null when runtime.command exists but is empty', () => {
    const mycoDir = path.join(tmpRoot, '.myco');
    fs.mkdirSync(mycoDir);
    fs.writeFileSync(path.join(mycoDir, 'runtime.command'), '   \n');
    const { findProjectRuntimePin } = loadModule();
    expect(findProjectRuntimePin(tmpRoot)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveSearchStart — worktree awareness
// ---------------------------------------------------------------------------

describe('resolveSearchStart', () => {
  it('returns cwd when no .git is found in any ancestor', () => {
    const deep = path.join(tmpRoot, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    const { resolveSearchStart } = loadModule();
    expect(resolveSearchStart(deep)).toBe(deep);
  });

  it('returns the repo root when .git is a directory', () => {
    const repo = path.join(tmpRoot, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const inner = path.join(repo, 'src', 'nested');
    fs.mkdirSync(inner, { recursive: true });
    const { resolveSearchStart } = loadModule();
    expect(resolveSearchStart(inner)).toBe(repo);
  });

  it('returns the main repo root when cwd is inside a git worktree', () => {
    // Simulate: /tmp/<root>/main-repo/.git/  (main repo)
    //          /tmp/<root>/main-repo/.worktrees/feature/  (worktree)
    //          /tmp/<root>/main-repo/.worktrees/feature/.git → file
    const mainRepo = path.join(tmpRoot, 'main-repo');
    const mainGit = path.join(mainRepo, '.git');
    fs.mkdirSync(path.join(mainGit, 'worktrees', 'feature'), { recursive: true });

    const worktree = path.join(mainRepo, '.worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(mainGit, 'worktrees', 'feature')}\n`,
    );

    const nested = path.join(worktree, 'src', 'module');
    fs.mkdirSync(nested, { recursive: true });

    const { resolveSearchStart } = loadModule();
    expect(resolveSearchStart(nested)).toBe(mainRepo);
  });

  it('resolves relative gitdir paths against the .git file location', () => {
    const mainRepo = path.join(tmpRoot, 'main-repo');
    fs.mkdirSync(path.join(mainRepo, '.git', 'worktrees', 'feature'), { recursive: true });

    const worktree = path.join(mainRepo, '.worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.git'),
      'gitdir: ../../.git/worktrees/feature\n',
    );

    const { resolveSearchStart } = loadModule();
    expect(resolveSearchStart(worktree)).toBe(mainRepo);
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

  it('falls through to normal dispatch when no pin exists', () => {
    const { shimPath } = makeShim();
    const cwd = fs.mkdtempSync(path.join(tmpRoot, 'cwd-'));

    const res = spawnSync(process.execPath, [shimPath, 'doctor'], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('shim:doctor');
  });

  it('redirects to the pinned binary and forwards argv', () => {
    const { shimPath } = makeShim();
    const project = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });

    const pinned = path.join(tmpRoot, 'pinned.sh');
    fs.writeFileSync(
      pinned,
      [
        '#!/bin/sh',
        'printf "pinned:%s:redirected=%s" "$*" "${MYCO_REDIRECTED}"',
      ].join('\n'),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(project, '.myco', 'runtime.command'), pinned);

    const res = spawnSync(process.execPath, [shimPath, 'doctor', '--fix'], {
      cwd: project,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('pinned:doctor --fix:redirected=1');
  });

  it('skips redirect when MYCO_REDIRECTED is already set', () => {
    const { shimPath } = makeShim();
    const project = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.myco', 'runtime.command'),
      '/nonexistent/should/not/matter',
    );

    const res = spawnSync(process.execPath, [shimPath, 'ok'], {
      cwd: project,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_REDIRECTED: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('shim:ok');
  });

  it('falls through when the pin target is missing (ENOENT)', () => {
    const { shimPath } = makeShim();
    const project = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.myco', 'runtime.command'),
      '/definitely/not/a/real/binary',
    );

    const res = spawnSync(process.execPath, [shimPath, 'doctor'], {
      cwd: project,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('shim:doctor');
    expect(res.status).toBe(0);
  });

  it('propagates non-zero exit status from the pinned binary', () => {
    const { shimPath } = makeShim();
    const project = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });

    const pinned = path.join(tmpRoot, 'failing.sh');
    fs.writeFileSync(pinned, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    fs.writeFileSync(path.join(project, '.myco', 'runtime.command'), pinned);

    const res = spawnSync(process.execPath, [shimPath], {
      cwd: project,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_REDIRECTED: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(42);
  });

  it('stays silent on stderr by default when redirecting', () => {
    const { shimPath } = makeShim();
    const project = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    const pinned = path.join(tmpRoot, 'silent-pinned.sh');
    fs.writeFileSync(pinned, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(project, '.myco', 'runtime.command'), pinned);

    const res = spawnSync(process.execPath, [shimPath], {
      cwd: project,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_REDIRECTED: undefined, MYCO_DEBUG_REDIRECT: undefined } as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('traces the redirect to stderr when MYCO_DEBUG_REDIRECT is set', () => {
    const { shimPath } = makeShim();
    const project = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    const pinned = path.join(tmpRoot, 'traced-pinned.sh');
    fs.writeFileSync(pinned, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(project, '.myco', 'runtime.command'), pinned);

    const res = spawnSync(process.execPath, [shimPath], {
      cwd: project,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_REDIRECTED: undefined, MYCO_DEBUG_REDIRECT: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('[myco] redirect:');
    expect(res.stderr).toContain(shimPath);
    expect(res.stderr).toContain(pinned);
  });

  it('traces the skip reason when MYCO_DEBUG_REDIRECT is set and no pin exists', () => {
    const { shimPath } = makeShim();
    const cwd = fs.mkdtempSync(path.join(tmpRoot, 'nopin-'));

    const res = spawnSync(process.execPath, [shimPath], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_REDIRECTED: undefined, MYCO_DEBUG_REDIRECT: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('[myco] redirect: skip (no .myco/runtime.command pin found)');
  });

  it('traces the skip reason when MYCO_REDIRECTED is already set', () => {
    const { shimPath } = makeShim();
    const project = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    fs.writeFileSync(path.join(project, '.myco', 'runtime.command'), '/unused');

    const res = spawnSync(process.execPath, [shimPath], {
      cwd: project,
      encoding: 'utf-8',
      env: { ...process.env, MYCO_REDIRECTED: '1', MYCO_DEBUG_REDIRECT: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('[myco] redirect: skip (MYCO_REDIRECTED already set)');
  });
});
