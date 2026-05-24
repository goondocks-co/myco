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
 *     refuses to delegate AND queues the project for walker cleanup by
 *     appending its root to `~/.myco/intents/legacy-launcher-cleanup.txt`.
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

function intentPath(fix: Fixture): string {
  return path.join(fix.mycoHome, 'intents', 'legacy-launcher-cleanup.txt');
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
    // No cleanup queued — sentinel was honored.
    expect(fs.existsSync(intentPath(fix))).toBe(false);
  });

  it('refuses to delegate when sentinel is missing, runs global flow, queues cleanup', () => {
    writeStub(
      fix.projectRoot,
      `#!/usr/bin/env node
// pre-upgrade brownfield stub — no protocol marker
console.log('SHOULD-NOT-RUN');
`,
    );

    const { stdout, status } = runLauncher(fix, 'hook', 'session-start');
    expect(status).toBe(0);
    // Fell through to the global runtime.command pin.
    expect(stdout.trim()).toBe('GLOBAL:hook session-start');
    // Project root queued for cleanup.
    const queued = fs.readFileSync(intentPath(fix), 'utf-8').trim().split('\n');
    expect(queued).toEqual([fs.realpathSync(fix.projectRoot)]);
  });

  it('appends, not overwrites, when launcher fires multiple times from different projects', () => {
    writeStub(fix.projectRoot, `#!/usr/bin/env node\n// no sentinel\n`);
    runLauncher(fix, 'hook', 'session-start');

    // Second project, same MYCO_HOME, separate hook fire.
    const second = path.join(fix.tmpRoot, 'second-project');
    fs.mkdirSync(path.join(second, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(second, '.agents', 'myco-run.cjs'), `#!/usr/bin/env node\n// no sentinel\n`);
    execFileSync(process.execPath, [fix.launcherCopy, 'hook', 'stop'], {
      cwd: second,
      env: {
        ...process.env,
        MYCO_HOME: fix.mycoHome,
        CURSOR_PROJECT_DIR: '',
        CLAUDE_PROJECT_DIR: '',
        WINDSURF_PROJECT_DIR: '',
        MYCO_PROJECT_ROOT: '',
        MYCO_AGENT_SESSION: '',
      },
    });

    const queued = fs.readFileSync(intentPath(fix), 'utf-8').trim().split('\n');
    expect(queued).toContain(fs.realpathSync(fix.projectRoot));
    expect(queued).toContain(fs.realpathSync(second));
  });
});
