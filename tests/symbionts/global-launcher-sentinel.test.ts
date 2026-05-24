import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * The global launcher (~/.myco/launcher.cjs) is the first thing every
 * agent's hook runs under the global install. When it walks up from cwd
 * and finds a project-local `.agents/myco-run.cjs` it delegates to that
 * stub — UNLESS the stub lacks the `MYCO_LAUNCHER_PROTOCOL=v2` sentinel.
 *
 * The sentinel discriminates two states:
 *   - sentineled: a current-template stub (dogfood, `myco init --project`).
 *     The launcher delegates, preserving the dev pin / opt-in path.
 *   - unsentineled: a pre-upgrade brownfield leftover. The launcher
 *     refuses to delegate and falls through to the global resolution
 *     chain. Cleanup happens through the migration walker on daemon
 *     first-start / auto-Grove-create, or explicitly via `myco doctor
 *     --fix`.
 *
 * Without this discrimination, post-upgrade first-hook-fire silently
 * routes through a stale stub and capture diverges from the new payload
 * shape. Locking the behavior down here.
 */

const TEMPLATE_PATH = path.resolve('packages/myco/src/symbionts/templates/_shared/global-launcher.cjs');

interface Fixture {
  tmpRoot: string;
  projectRoot: string;
  mycoHome: string;
  launcherCopy: string;
  globalRuntimeBin: string;
}

function makeFixture(): Fixture {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'global-launcher-sentinel-'));
  const projectRoot = path.join(tmpRoot, 'project');
  const mycoHome = path.join(tmpRoot, 'myco-home');
  const launcherDir = path.join(mycoHome);
  const binDir = path.join(tmpRoot, 'bin');
  fs.mkdirSync(path.join(projectRoot, '.agents'), { recursive: true });
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  // Install global launcher under MYCO_HOME so the launcher's
  // `path.basename(__filename) === 'launcher.cjs'` mode-selection works.
  const launcherCopy = path.join(launcherDir, 'launcher.cjs');
  fs.copyFileSync(TEMPLATE_PATH, launcherCopy);
  fs.chmodSync(launcherCopy, 0o755);

  // Pin the global runtime to a script that prints GLOBAL:<args> so we
  // can assert the launcher fell through to the global flow.
  const globalRuntimeBin = path.join(binDir, 'fake-myco');
  fs.writeFileSync(
    globalRuntimeBin,
    `#!/usr/bin/env node\nconsole.log('GLOBAL:' + process.argv.slice(2).join(' '));\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(mycoHome, 'runtime.command'), globalRuntimeBin + '\n');

  return { tmpRoot, projectRoot, mycoHome, launcherCopy, globalRuntimeBin };
}

function writeStub(projectRoot: string, body: string): string {
  const stub = path.join(projectRoot, '.agents', 'myco-run.cjs');
  fs.writeFileSync(stub, body, { mode: 0o755 });
  return stub;
}

function runLauncher(fix: Fixture, ...args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [fix.launcherCopy, ...args], {
      cwd: fix.projectRoot,
      env: {
        ...process.env,
        MYCO_HOME: fix.mycoHome,
        // Strip project-dir env vars so the launcher doesn't chdir away
        // from our test tree.
        CURSOR_PROJECT_DIR: '',
        CLAUDE_PROJECT_DIR: '',
        WINDSURF_PROJECT_DIR: '',
        MYCO_PROJECT_ROOT: '',
        MYCO_AGENT_SESSION: '',
      },
      encoding: 'utf-8',
    });
    return { stdout, status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

let fix: Fixture;
beforeEach(() => { fix = makeFixture(); });
afterEach(() => { fs.rmSync(fix.tmpRoot, { recursive: true, force: true }); });

describe('global launcher sentinel check', () => {
  it('delegates when stub carries MYCO_LAUNCHER_PROTOCOL=v2 sentinel', () => {
    writeStub(
      fix.projectRoot,
      `#!/usr/bin/env node
// MYCO_LAUNCHER_PROTOCOL=v2
console.log('OVERRIDE:' + process.argv.slice(2).join(' '));
`,
    );

    const { stdout, status } = runLauncher(fix, 'hook', 'session-start');
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('OVERRIDE:hook session-start');
  });

  it('refuses to delegate when sentinel is missing and falls through to the global flow', () => {
    writeStub(
      fix.projectRoot,
      `#!/usr/bin/env node
// pre-upgrade brownfield stub — no protocol marker
console.log('SHOULD-NOT-RUN');
`,
    );

    const { stdout, status } = runLauncher(fix, 'hook', 'session-start');
    expect(status).toBe(0);
    // Fell through to the global runtime.command pin — capture stays
    // online while the migration walker cleans the legacy stub on its
    // next pass (or via `myco doctor --fix`).
    expect(stdout.trim()).toBe('GLOBAL:hook session-start');
    // No queue file is written — the legacy intent queue is retired.
    expect(fs.existsSync(path.join(fix.mycoHome, 'intents', 'legacy-launcher-cleanup.txt'))).toBe(false);
  });
});
