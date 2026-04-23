import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
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

interface Fixture {
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

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(vaultDir);
  fs.mkdirSync(subDir, { recursive: true });
  fs.mkdirSync(launcherBinDir, { recursive: true });
  fs.mkdirSync(binDir);

  const launcherCopy = path.join(launcherBinDir, 'myco-run');
  fs.copyFileSync(LAUNCHER_SOURCE, launcherCopy);
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

  return { projectDir, subDir, binDir, fakeInstallDir, launcherCopy };
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
 * from the parent process so each case starts clean, and scope PATH to
 * only the fixture bin dir so no real `myco` / `myco-dev` leaks in.
 */
function baseEnv(fixture: Fixture): NodeJS.ProcessEnv {
  const { MYCO_RUN_REDIRECTED: _stripRedirect, ...parentEnv } = process.env;
  return {
    ...parentEnv,
    PATH: `${fixture.binDir}:/usr/bin:/bin`,
  };
}

describe('bin/myco-run launcher', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(fixture.projectDir), { recursive: true, force: true });
  });

  describe('alias mode (runtime.command present)', () => {
    it('redirects to the alias binary with forwarded args', () => {
      writeRuntimeCommand(fixture, 'myco-dev');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "ALIAS:$*"');

      const result = execFileSync(
        process.execPath,
        [fixture.launcherCopy, 'mcp', '--foo', 'bar'],
        { cwd: fixture.projectDir, env: baseEnv(fixture), stdio: 'pipe', timeout: 5000 },
      );
      expect(result.toString().trim()).toBe('ALIAS:mcp --foo bar');
    });

    it('walks up from a nested cwd to find runtime.command', () => {
      writeRuntimeCommand(fixture, 'myco-dev');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "ALIAS:$*"');

      const result = execFileSync(
        process.execPath,
        [fixture.launcherCopy, 'mcp'],
        { cwd: fixture.subDir, env: baseEnv(fixture), stdio: 'pipe', timeout: 5000 },
      );
      expect(result.toString().trim()).toBe('ALIAS:mcp');
    });

    it('trims whitespace around the alias value', () => {
      writeRuntimeCommand(fixture, '  myco-dev\n');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "ALIAS:$*"');

      const result = execFileSync(
        process.execPath,
        [fixture.launcherCopy, 'mcp'],
        { cwd: fixture.projectDir, env: baseEnv(fixture), stdio: 'pipe', timeout: 5000 },
      );
      expect(result.toString().trim()).toBe('ALIAS:mcp');
    });

    it('treats an empty runtime.command file as absent and self-locates', () => {
      writeRuntimeCommand(fixture, '');

      const result = execFileSync(
        process.execPath,
        [fixture.launcherCopy, 'mcp'],
        { cwd: fixture.projectDir, env: baseEnv(fixture), stdio: 'pipe', timeout: 5000 },
      );
      expect(result.toString().trim()).toBe('SELF:mcp');
    });

    it('falls through to self-locate when the alias binary is not on PATH', () => {
      // Documented behavior: if a project pins `runtime.command=myco-dev`
      // but the current process can't reach `myco-dev`, we quietly serve
      // the self-located (prod) binary instead of failing the MCP spawn.
      writeRuntimeCommand(fixture, 'myco-dev');
      // No fake bin created — myco-dev is not resolvable.

      const result = execFileSync(
        process.execPath,
        [fixture.launcherCopy, 'mcp'],
        { cwd: fixture.projectDir, env: baseEnv(fixture), stdio: 'pipe', timeout: 5000 },
      );
      expect(result.toString().trim()).toBe('SELF:mcp');
    });

    it('surfaces non-ENOENT errors from the aliased binary instead of falling through', () => {
      writeRuntimeCommand(fixture, 'myco-dev');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "boom" >&2\nexit 42');

      try {
        execFileSync(
          process.execPath,
          [fixture.launcherCopy, 'mcp'],
          { cwd: fixture.projectDir, env: baseEnv(fixture), stdio: 'pipe', timeout: 5000 },
        );
        expect.fail('Should have exited non-zero');
      } catch (err: any) {
        expect(err.status).toBe(42);
        expect(err.stderr.toString()).toContain('boom');
      }
    });
  });

  describe('recursion guard', () => {
    it('skips the redirect when MYCO_RUN_REDIRECTED=1 is already set', () => {
      // Simulates a misconfigured `runtime.command=myco-run` loop — the
      // second entry must bypass the alias lookup and self-locate.
      writeRuntimeCommand(fixture, 'myco-dev');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "ALIAS:$*"');

      const result = execFileSync(
        process.execPath,
        [fixture.launcherCopy, 'mcp'],
        {
          cwd: fixture.projectDir,
          env: { ...baseEnv(fixture), MYCO_RUN_REDIRECTED: '1' },
          stdio: 'pipe',
          timeout: 5000,
        },
      );
      expect(result.toString().trim()).toBe('SELF:mcp');
    });

    it('sets MYCO_RUN_REDIRECTED=1 in the aliased child env', () => {
      writeRuntimeCommand(fixture, 'myco-dev');
      createFakeBin(
        fixture,
        'myco-dev',
        '#!/bin/sh\necho "REDIRECTED=${MYCO_RUN_REDIRECTED:-unset}"',
      );

      const result = execFileSync(
        process.execPath,
        [fixture.launcherCopy, 'mcp'],
        { cwd: fixture.projectDir, env: baseEnv(fixture), stdio: 'pipe', timeout: 5000 },
      );
      expect(result.toString().trim()).toBe('REDIRECTED=1');
    });
  });

  describe('self-locate mode (no runtime.command)', () => {
    it('invokes the self-located packaged launcher when no .myco/runtime.command exists above cwd', () => {
      // projectDir has .myco/ but no runtime.command file. subDir is
      // deeply nested and does not have its own .myco/. The walk-up
      // finds the vault dir but no alias file → self-locate.
      const result = execFileSync(
        process.execPath,
        [fixture.launcherCopy, 'mcp'],
        { cwd: fixture.subDir, env: baseEnv(fixture), stdio: 'pipe', timeout: 5000 },
      );
      expect(result.toString().trim()).toBe('SELF:mcp');
    });

    it('self-locates when invoked from a directory with no .myco anywhere above', () => {
      const orphanCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-cwd-'));
      try {
        const result = execFileSync(
          process.execPath,
          [fixture.launcherCopy, 'mcp'],
          { cwd: orphanCwd, env: baseEnv(fixture), stdio: 'pipe', timeout: 5000 },
        );
        expect(result.toString().trim()).toBe('SELF:mcp');
      } finally {
        fs.rmSync(orphanCwd, { recursive: true, force: true });
      }
    });

    it('forwards argv intact to the self-located packaged launcher', () => {
      const result = execFileSync(
        process.execPath,
        [fixture.launcherCopy, 'mcp', '--flag', 'value'],
        { cwd: fixture.subDir, env: baseEnv(fixture), stdio: 'pipe', timeout: 5000 },
      );
      expect(result.toString().trim()).toBe('SELF:mcp --flag value');
    });

    it('prefers global `myco` when invoked through a dev-link-style symlink with no runtime.command', () => {
      const symlinkPath = path.join(fixture.binDir, 'myco-run');
      fs.mkdirSync(path.join(fixture.fakeInstallDir, 'src'));
      fs.symlinkSync(fixture.launcherCopy, symlinkPath);
      createFakeBin(fixture, 'myco', '#!/bin/sh\necho "GLOBAL:$*"');

      const result = execFileSync(
        process.execPath,
        [symlinkPath, 'mcp'],
        { cwd: fixture.projectDir, env: baseEnv(fixture), stdio: 'pipe', timeout: 5000 },
      );
      expect(result.toString().trim()).toBe('GLOBAL:mcp');
    });
  });
});
