/**
 * The dev wrapper a runtime pin names (`make dev-wrapper`, which `dev-install` and `dev-link-worktree` write), run as
 * the trampoline runs it: the launch preamble re-executes a hook into the pinned wrapper, and the wrapper starts the
 * binary under the dev home, ~/.myco-dev, only when no MYCO_HOME is set. An explicitly set MYCO_HOME wins, as at every
 * other layer: a test or a measurement that isolates its home and runs in a pinned repository stays in that home.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaunchPreamble, type LaunchPreambleDeps } from '@myco/cli/launch-preamble.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.ts';
import { REPO_ROOT } from '../helpers/import-closure.ts';

const hasMake = process.platform !== 'win32' && spawnSync('make', ['--version'], { stdio: 'ignore' }).status === 0;
const saved = { home: process.env.HOME, mycoHome: process.env.MYCO_HOME, trampolined: process.env.MYCO_TRAMPOLINED };
afterEach(() => {
  for (const [key, value] of [['HOME', saved.home], ['MYCO_HOME', saved.mycoHome], ['MYCO_TRAMPOLINED', saved.trampolined]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

class Exited extends Error {
  constructor(readonly code: number) { super(`exit(${code})`); }
}

describe.skipIf(!hasMake)('the dev wrapper a pinned hook re-executes into', () => {
  /** A wrapper the Makefile writes, around a binary that records the home it was started under. */
  function wrapper(): { dir: string; pin: string; seen: () => string } {
    const dir = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-dev-wrapper-')));
    const record = path.join(dir, 'seen');
    const binary = path.join(dir, 'myco');
    fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s' "$MYCO_HOME" > "${record}"\n`, { mode: 0o755 });
    const pin = path.join(dir, 'runtime-exec');
    execFileSync('make', ['-s', '-C', REPO_ROOT, 'dev-wrapper', `OUT=${pin}`, `WRAPPED=${binary}`]);
    return { dir, pin, seen: () => fs.readFileSync(record, 'utf-8') };
  }

  /** Run the launch preamble for a hook in a directory pinned to `pin`, as a hook process would. */
  function trampoline(pin: string, dir: string): void {
    delete process.env.MYCO_TRAMPOLINED;
    const clearHome = path.join(dir, 'bare-home.sh');
    fs.writeFileSync(clearHome, '#!/bin/sh\nunset MYCO_HOME\nexec "$@"\n', { mode: 0o755 });
    const withoutHome = process.env.MYCO_HOME === undefined;
    const deps: LaunchPreambleDeps = {
      execPath: path.join(dir, 'not-the-pin'), cwd: () => dir, chdir: () => {},
      exit: (code) => { throw new Exited(code); },
      resolveRuntimePin: () => pin, realpathSync: (p) => p, readFd0: () => Buffer.alloc(0),
      execFileSync: (file, args, options) => execFileSync(withoutHome ? clearHome : file, withoutHome ? [file, ...args] : args, options) as unknown as Buffer,
      platform: process.platform, existsSync: fs.existsSync, pathDirs: () => [], pathExts: () => [],
    };
    expect(() => runLaunchPreamble('hook', ['session-start', '--symbiont', 'claude-code'], deps)).toThrow('exit(0)');
  }

  it('keeps a MYCO_HOME the caller set: an isolated home stays isolated', () => {
    const { dir, pin, seen } = wrapper();
    process.env.MYCO_HOME = path.join(dir, 'isolated-home');
    trampoline(pin, dir);
    expect(seen()).toBe(path.join(dir, 'isolated-home'));
  });

  it('starts the binary under the dev home when no MYCO_HOME is set', () => {
    const { dir, pin, seen } = wrapper();
    delete process.env.MYCO_HOME;
    process.env.HOME = path.join(dir, 'user');
    trampoline(pin, dir);
    expect(seen()).toBe(path.join(dir, 'user', '.myco-dev'));
  });
});
