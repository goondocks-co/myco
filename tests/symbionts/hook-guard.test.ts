import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * The hook guard resolves which myco binary to invoke via the machine-
 * scope `~/.myco/runtime.command` file. Tests pin `MYCO_HOME` to a temp
 * directory so the guard reads the test's runtime.command without
 * touching the developer's actual home directory.
 *
 *     tmpDir/
 *       .agents/myco-run.cjs        (copy of the template)
 *       myco-home/runtime.command   (optional — absent means default)
 *       bin/<fake binaries>
 */

const guardSource = path.resolve('packages/myco/src/symbionts/templates/myco-run.cjs');

interface Fixture {
  tmpDir: string;
  guardCopy: string;
  cliCopy: string;
  binDir: string;
  mycoHome: string;
}

function makeFixture(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-guard-test-'));
  const agentsDir = path.join(tmpDir, '.agents');
  const mycoHome = path.join(tmpDir, 'myco-home');
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(agentsDir);
  fs.mkdirSync(mycoHome);
  fs.mkdirSync(binDir);
  const guardCopy = path.join(agentsDir, 'myco-run.cjs');
  const cliCopy = path.join(agentsDir, 'myco-cli.cjs');
  fs.copyFileSync(guardSource, guardCopy);
  fs.copyFileSync(guardSource, cliCopy);
  return { tmpDir, guardCopy, cliCopy, binDir, mycoHome };
}

function writeAlias(fixture: Fixture, alias: string): void {
  fs.writeFileSync(path.join(fixture.mycoHome, 'runtime.command'), alias, 'utf-8');
}

function createFakeBin(fixture: Fixture, name: string, script: string): string {
  const binPath = path.join(fixture.binDir, name);
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

const { MYCO_CMD: _stripMycoCmd, ...BASE_ENV } = process.env;

function envForFixture(fixture: Fixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...BASE_ENV, MYCO_HOME: fixture.mycoHome, PATH: fixture.binDir, ...extra };
}

describe('myco-run.cjs', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  });

  describe('default resolution (no runtime.command)', () => {
    it('exits 0 when default `myco` is not on PATH', () => {
      // No runtime.command file, default to `myco`, PATH has no myco → ENOENT → silent exit.
      const result = execFileSync(process.execPath, [fixture.guardCopy, 'hook', 'session-start'], {
        env: envForFixture(fixture),
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(result.toString()).toBe('');
    });

    it('returns a JSON runtime error for tool calls when default `myco` is not on PATH', () => {
      try {
        execFileSync(process.execPath, [fixture.guardCopy, 'tool', 'call', 'canopy_map', '--json', '--input', '{}'], {
          env: envForFixture(fixture),
          stdio: 'pipe',
          timeout: 5000,
        });
        expect.fail('Should have thrown');
      } catch (err: any) {
        const envelope = JSON.parse(err.stdout.toString());
        expect(err.status).toBe(1);
        expect(envelope).toEqual({
          ok: false,
          tool: 'canopy_map',
          error: {
            code: 'runtime_unavailable',
            message: "Myco runtime command 'myco' could not be found. Check <project>/.myco/runtime.command and ~/.myco/runtime.command, or run Myco update from a shell where Myco is installed.",
          },
        });
      }
    });

    it('exits 0 with no arguments and no binary available', () => {
      const result = execFileSync(process.execPath, [fixture.guardCopy], {
        env: envForFixture(fixture),
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(result.toString()).toBe('');
    });

    it('invokes default `myco` when it is on PATH', () => {
      createFakeBin(fixture, 'myco', '#!/bin/sh\necho "DEFAULT:$*"');
      const result = execFileSync(process.execPath, [fixture.guardCopy, 'hook', 'session-start'], {
        env: envForFixture(fixture),
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(result.toString().trim()).toBe('DEFAULT:hook session-start');
    });

    it('treats an empty runtime.command file as absent and uses default', () => {
      writeAlias(fixture, '');
      createFakeBin(fixture, 'myco', '#!/bin/sh\necho "DEFAULT:$*"');
      const result = execFileSync(process.execPath, [fixture.guardCopy, 'hook', 'stop'], {
        env: envForFixture(fixture),
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(result.toString().trim()).toBe('DEFAULT:hook stop');
    });
  });

  describe('runtime.command alias', () => {
    it('invokes the alias recorded in ~/.myco/runtime.command', () => {
      writeAlias(fixture, 'myco-dev');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "ALIASED:$*"');
      const result = execFileSync(process.execPath, [fixture.guardCopy, 'hook', 'user-prompt-submit', '--symbiont', 'codex'], {
        env: envForFixture(fixture),
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(result.toString().trim()).toBe('ALIASED:hook user-prompt-submit --symbiont codex');
    });

    it('trims whitespace around the alias value', () => {
      writeAlias(fixture, '  myco-dev\n');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "ALIASED:$*"');
      const result = execFileSync(process.execPath, [fixture.guardCopy, 'hook', 'stop'], {
        env: envForFixture(fixture),
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(result.toString().trim()).toBe('ALIASED:hook stop');
    });

    it('exits 0 when the aliased binary is not on PATH (ENOENT silent)', () => {
      writeAlias(fixture, 'myco-dev');
      // myco-dev is NOT on PATH — ENOENT → silent exit.
      const result = execFileSync(process.execPath, [fixture.guardCopy, 'hook', 'session-start'], {
        env: envForFixture(fixture),
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(result.toString()).toBe('');
    });

    it('returns a JSON runtime error for tool calls when the aliased binary is not on PATH', () => {
      writeAlias(fixture, 'myco-dev');
      try {
        execFileSync(process.execPath, [fixture.guardCopy, 'tool', 'list', '--json'], {
          env: envForFixture(fixture),
          stdio: 'pipe',
          timeout: 5000,
        });
        expect.fail('Should have thrown');
      } catch (err: any) {
        const envelope = JSON.parse(err.stdout.toString());
        expect(err.status).toBe(1);
        expect(envelope.ok).toBe(false);
        expect(envelope.error.code).toBe('runtime_unavailable');
        expect(envelope.error.message).toContain("'myco-dev'");
      }
    });

    it('invokes the alias at an absolute path even when PATH is empty', () => {
      // When runtime.command holds an absolute path, the guard execs it
      // directly — no PATH lookup needed. This is the recovery path for
      // GUI-launched agents (Cursor, Claude Code desktop on macOS) that
      // inherit launchd's minimal PATH: `make dev-link` writes the full
      // `$(HOME)/.local/bin/myco-dev` path instead of a bare name so the
      // guard doesn't depend on the caller's PATH at all.
      const outBin = path.join(fixture.binDir, 'myco-dev');
      fs.writeFileSync(outBin, '#!/bin/sh\necho "ABS:$*"', { mode: 0o755 });
      writeAlias(fixture, outBin);

      const result = execFileSync(process.execPath, [fixture.guardCopy, 'hook', 'stop'], {
        // PATH deliberately excludes outBin's directory — only the absolute
        // path in runtime.command should resolve the binary.
        env: envForFixture(fixture, { PATH: '/nonexistent-dir' }),
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(result.toString().trim()).toBe('ABS:hook stop');
    });

    it('ignores MYCO_CMD — runtime.command is the only source', () => {
      // Regression guard: the old implementation honored MYCO_CMD. This PR
      // removes that dispatch path entirely. The alias file wins, and a
      // stray MYCO_CMD in the environment must have no effect.
      writeAlias(fixture, 'myco-dev');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "DEV:$*"');
      createFakeBin(fixture, 'some-other-binary', '#!/bin/sh\necho "SHOULD-NOT-RUN:$*"');
      const result = execFileSync(process.execPath, [fixture.guardCopy, 'hook', 'stop'], {
        env: envForFixture(fixture, { MYCO_CMD: path.join(fixture.binDir, 'some-other-binary') }),
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(result.toString().trim()).toBe('DEV:hook stop');
    });
  });

  describe('error surfacing', () => {
    it('surfaces real non-ENOENT errors from the resolved binary', () => {
      writeAlias(fixture, 'myco-dev');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "vault not initialized" >&2\nexit 1');
      try {
        execFileSync(process.execPath, [fixture.guardCopy, 'hook', 'session-start'], {
          env: envForFixture(fixture),
          stdio: 'pipe',
          timeout: 5000,
        });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.status).toBe(1);
        expect(err.stderr.toString()).toContain('vault not initialized');
      }
    });
  });

  describe('MYCO_AGENT_SESSION guard', () => {
    it('exits 0 immediately when MYCO_AGENT_SESSION is set', () => {
      // Internal Myco agent-pipeline sessions must be invisible to hooks.
      // The resolved binary would normally run — this env var short-circuits.
      writeAlias(fixture, 'myco-dev');
      createFakeBin(fixture, 'myco-dev', '#!/bin/sh\necho "SHOULD-NOT-RUN"\nexit 1');
      const result = execFileSync(process.execPath, [fixture.guardCopy, 'hook', 'session-start'], {
        env: envForFixture(fixture, { MYCO_AGENT_SESSION: '1' }),
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(result.toString()).toBe('');
    });
  });
});
