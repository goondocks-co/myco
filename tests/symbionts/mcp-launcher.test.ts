import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * `bin/myco-run` is the global MCP launcher every symbiont spawns
 * (`myco-run mcp`). It is cwd-independent by design. These tests cover
 * two dispatch modes:
 *
 *   1. Alias mode — a project with `.myco/runtime.command` redirects
 *      `myco-run` to that binary's CLI, same as the hook guard does.
 *      This is what keeps dogfooding (runtime.command=myco-dev) and
 *      custom aliases working for MCP, not just hooks.
 *
 *   2. Self-locate — with no runtime.command anywhere above cwd, the
 *      launcher resolves to its own install's packaged `bin/myco.cjs`
 *      via realpathSync.
 *
 * Regression axis: before this launcher honored runtime.command, a
 * dev machine that installed both the dev shim and the homebrew-
 * published `myco-run` had non-deterministic resolution. GUI apps
 * (opencode, Claude Code.app) hit homebrew prod via launchd PATH and
 * silently served stale schemas. Keep the cases below exhaustive.
 */

const LAUNCHER_SOURCE = path.resolve('packages/myco/bin/myco-run');
const RESOLUTION_SOURCE = path.resolve('packages/myco/bin/binary-resolution.cjs');

interface Fixture {
  tmpRoot: string;
  /** HOME for the launcher; its `.myco` is the MYCO_HOME, so no machine pin or managed binary leaks in. */
  homeDir: string;
  projectDir: string;
  subDir: string;
  binDir: string;
  fakeInstallDir: string;
  launcherCopy: string;
}

/**
 * Build an isolated fake install so `realpathSync(argv[1])` lands on a
 * deterministic packaged launcher we control. The layout:
 *
 *   fakeInstallDir/
 *     bin/myco-run          (copy of the real launcher)
 *     bin/myco.cjs          (fake packaged launcher that prints SELF:<args>)
 *
 * Tests invoke the launcher copy from that bin/ path so `argv[1]`
 * resolves to the fake install tree.
 */
function makeFixture(): Fixture {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-run-test-'));
  const projectDir = path.join(tmpRoot, 'project');
  const vaultDir = path.join(projectDir, '.myco');
  const subDir = path.join(projectDir, 'nested', 'deep');
  const fakeInstallDir = path.join(tmpRoot, 'install');
  const launcherBinDir = path.join(fakeInstallDir, 'bin');
  const binDir = path.join(tmpRoot, 'path');
  const homeDir = path.join(tmpRoot, 'home');

  fs.mkdirSync(path.join(homeDir, '.myco'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(vaultDir);
  fs.mkdirSync(subDir, { recursive: true });
  fs.mkdirSync(launcherBinDir, { recursive: true });
  fs.mkdirSync(binDir);

  const launcherCopy = path.join(launcherBinDir, 'myco-run');
  fs.copyFileSync(LAUNCHER_SOURCE, launcherCopy);
  fs.copyFileSync(RESOLUTION_SOURCE, path.join(launcherBinDir, 'binary-resolution.cjs'));
  fs.chmodSync(launcherCopy, 0o755);

  const cliEntry = path.join(launcherBinDir, 'myco.cjs');
  fs.writeFileSync(
    cliEntry,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
console.log('SELF:' + args.join(' '));
`,
    { mode: 0o755 },
  );

  return { tmpRoot, homeDir, projectDir, subDir, binDir, fakeInstallDir, launcherCopy };
}

function writeRuntimeCommand(fixture: Fixture, value: string): void {
  fs.writeFileSync(
    path.join(fixture.projectDir, '.myco', 'runtime.command'),
    value,
    'utf-8',
  );
}

function createFakeBin(fixture: Fixture, name: string, script: string): string {
  const binPath = path.join(fixture.binDir, name);
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

/**
 * Environment we invoke the launcher with. Strip any MYCO_RUN_REDIRECTED
 * from the parent process so each case starts clean, scope PATH to only the
 * fixture bin dir so no real `myco` / `myco-dev` leaks in, and give the
 * launcher the fixture's own HOME and MYCO_HOME: the test run's MYCO_HOME is
 * shared by every suite in it, and a machine pin or managed binary another
 * suite leaves there would change which binary the launcher dispatches to.
 */
function baseEnv(fixture: Fixture): NodeJS.ProcessEnv {
  const { MYCO_RUN_REDIRECTED: _stripRedirect, ...parentEnv } = process.env;
  return {
    ...parentEnv,
    HOME: fixture.homeDir,
    MYCO_HOME: path.join(fixture.homeDir, '.myco'),
    PATH: `${fixture.binDir}:/usr/bin:/bin`,
  };
}

/** Every `.myco/runtime.command` on the walk from `dir` up to the filesystem root. */
function pinsAbove(dir: string): string[] {
  const found: string[] = [];
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const pin = path.join(at, '.myco', 'runtime.command');
    if (fs.existsSync(pin)) found.push(pin);
    if (path.dirname(at) === at) return found;
  }
}

interface LauncherRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a launcher without blocking the test process. The launcher starts one
 * or two further runtimes, which a loaded machine can take seconds to do, so
 * it runs under the test's own budget rather than a spawn deadline of its own;
 * `stop` ends it if the test does.
 */
function runLauncher(
  launcher: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stop: AbortSignal },
): Promise<LauncherRun> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [launcher, ...args],
      { cwd: options.cwd, env: options.env, signal: options.stop },
      (error, stdout, stderr) => {
        if (error === null) { resolve({ status: 0, stdout, stderr }); return; }
        if (typeof error.code === 'number') { resolve({ status: error.code, stdout, stderr }); return; }
        reject(error);
      },
    );
  });
}

describe('bin/myco-run launcher', () => {
  let fixture: Fixture;
  let running: AbortController;

  beforeEach(() => {
    fixture = makeFixture();
    running = new AbortController();
  });

  afterEach(() => {
    running.abort();
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  });

  const launch = (args: string[], cwd: string, env: NodeJS.ProcessEnv = baseEnv(fixture), launcher = fixture.launcherCopy) =>
    runLauncher(launcher, args, { cwd, env, stop: running.signal });

  describe('alias mode (runtime.command present)', () => {
    it('redirects to the alias binary with forwarded args', async () => {
      writeRuntimeCommand(fixture, 'myco-dev');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "ALIAS:$*"');

      const result = await launch(['mcp', '--foo', 'bar'], fixture.projectDir);
      expect(result.stdout.trim()).toBe('ALIAS:mcp --foo bar');
    });

    it('walks up from a nested cwd to find runtime.command', async () => {
      writeRuntimeCommand(fixture, 'myco-dev');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "ALIAS:$*"');

      const result = await launch(['mcp'], fixture.subDir);
      expect(result.stdout.trim()).toBe('ALIAS:mcp');
    });

    it('trims whitespace around the alias value', async () => {
      writeRuntimeCommand(fixture, '  myco-dev\n');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "ALIAS:$*"');

      const result = await launch(['mcp'], fixture.projectDir);
      expect(result.stdout.trim()).toBe('ALIAS:mcp');
    });

    it('treats an empty runtime.command file as absent and self-locates', async () => {
      writeRuntimeCommand(fixture, '');

      const result = await launch(['mcp'], fixture.projectDir);
      expect(result.stdout.trim()).toBe('SELF:mcp');
    });

    it('falls through to self-locate when the alias binary is not on PATH', async () => {
      // Documented behavior: if a project pins `runtime.command=myco-dev`
      // but the current process can't reach `myco-dev`, we quietly serve
      // the self-located (prod) binary instead of failing the MCP spawn.
      writeRuntimeCommand(fixture, 'myco-dev');
      // No fake bin created — myco-dev is not resolvable.

      const result = await launch(['mcp'], fixture.projectDir);
      expect(result.stdout.trim()).toBe('SELF:mcp');
    });

    it('surfaces non-ENOENT errors from the aliased binary instead of falling through', async () => {
      writeRuntimeCommand(fixture, 'myco-dev');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "boom" >&2\nexit 42');

      const result = await launch(['mcp'], fixture.projectDir);
      expect(result.status).toBe(42);
      expect(result.stderr).toContain('boom');
    });
  });

  describe('recursion guard', () => {
    it('skips the redirect when MYCO_RUN_REDIRECTED=1 is already set', async () => {
      // Simulates a misconfigured `runtime.command=myco-run` loop — the
      // second entry must bypass the alias lookup and self-locate.
      writeRuntimeCommand(fixture, 'myco-dev');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "ALIAS:$*"');

      const result = await launch(['mcp'], fixture.projectDir, { ...baseEnv(fixture), MYCO_RUN_REDIRECTED: '1' });
      expect(result.stdout.trim()).toBe('SELF:mcp');
    });

    it('sets MYCO_RUN_REDIRECTED=1 in the aliased child env', async () => {
      writeRuntimeCommand(fixture, 'myco-dev');
      createFakeBin(
        fixture,
        'myco-dev',
        '#!/bin/sh\necho "REDIRECTED=${MYCO_RUN_REDIRECTED:-unset}"',
      );

      const result = await launch(['mcp'], fixture.projectDir);
      expect(result.stdout.trim()).toBe('REDIRECTED=1');
    });
  });

  describe('self-locate mode (no runtime.command)', () => {
    it('invokes the self-located packaged launcher when no .myco/runtime.command exists above cwd', async () => {
      // projectDir has .myco/ but no runtime.command file. subDir is
      // deeply nested and does not have its own .myco/. The walk-up
      // finds the vault dir but no alias file → self-locate.
      const result = await launch(['mcp'], fixture.subDir);
      expect(result.stdout.trim()).toBe('SELF:mcp');
    });

    it('self-locates when invoked from a directory with no .myco anywhere above', async () => {
      // Beside the fixture's project, not under it, so the walk up passes no
      // vault of the fixture's. A pin some other process left on the way up
      // would redirect the launcher, so the walk is checked before relying on it.
      const orphanCwd = path.join(fixture.tmpRoot, 'orphan');
      fs.mkdirSync(orphanCwd);
      expect(pinsAbove(orphanCwd)).toEqual([]);

      const result = await launch(['mcp'], orphanCwd);
      expect(result.stdout.trim()).toBe('SELF:mcp');
    });

    it('forwards argv intact to the self-located packaged launcher', async () => {
      const result = await launch(['mcp', '--flag', 'value'], fixture.subDir);
      expect(result.stdout.trim()).toBe('SELF:mcp --flag value');
    });

    it('prefers global `myco` when invoked through a dev-link-style symlink with no runtime.command', async () => {
      const symlinkPath = path.join(fixture.binDir, 'myco-run');
      fs.mkdirSync(path.join(fixture.fakeInstallDir, 'src'));
      fs.symlinkSync(fixture.launcherCopy, symlinkPath);
      createFakeBin(fixture, 'myco', '#!/bin/sh\necho "GLOBAL:$*"');

      const result = await launch(['mcp'], fixture.projectDir, baseEnv(fixture), symlinkPath);
      expect(result.stdout.trim()).toBe('GLOBAL:mcp');
    });
  });
});
