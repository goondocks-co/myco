import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Launch-failure diagnostics for the global launcher template
 * (`~/.myco/launcher.cjs` / `~/.myco/mcp-launcher.cjs`).
 *
 * Failure classes by exit-status shape:
 *
 *   - numeric `err.status`  → the child's own exit code; propagated in
 *     every context (the binary's hook handlers are fail-open, so a real
 *     nonzero numeric status means something real happened downstream).
 *   - null/undefined status → signal kill or spawn-class failure
 *     (EAGAIN/EMFILE/EACCES/ETXTBSY). Hook contexts exit 0 so the agent
 *     never reports a phantom hook error; everything else exits 1.
 *
 * Every failure path emits one diagnostic line to stderr and appends it
 * to `<MYCO_HOME>/logs/launcher.log` — and that logging is best-effort:
 * an unwritable logs dir must not change launcher behavior.
 */

const TEMPLATE_SOURCE = path.resolve(
  'packages/myco/src/symbionts/templates/_shared/global-launcher.cjs',
);

interface Fixture {
  root: string;
  projectDir: string;
  mycoHome: string;
  launcherPath: string;
  logPath: string;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-launcher-diag-'));
  const projectDir = path.join(root, 'project');
  const mycoHome = path.join(root, 'myco-home');
  fs.mkdirSync(path.join(projectDir, '.myco'), { recursive: true });
  fs.mkdirSync(mycoHome, { recursive: true });

  const launcherPath = path.join(root, 'launcher.cjs');
  fs.copyFileSync(TEMPLATE_SOURCE, launcherPath);

  return {
    root,
    projectDir,
    mycoHome,
    launcherPath,
    logPath: path.join(mycoHome, 'logs', 'launcher.log'),
  };
}

/** Pin the project's runtime.command at a fake binary built from `body`. */
function pinFakeBinary(fixture: Fixture, body: string): string {
  const binPath = path.join(fixture.root, 'fake-myco.cjs');
  fs.writeFileSync(binPath, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fixture.projectDir, '.myco', 'runtime.command'), `${binPath}\n`);
  return binPath;
}

/**
 * Run the launcher with `node` from the fixture project dir. Strips the
 * project-dir env vars agents set (a real CLAUDE_PROJECT_DIR from the test
 * harness would chdir the launcher out of the sandbox) and the agent-session
 * short-circuit; pins MYCO_HOME at the sandbox so the log lands there.
 */
function runLauncher(fixture: Fixture, args: string[]) {
  const env = { ...process.env, MYCO_HOME: fixture.mycoHome };
  delete env.MYCO_AGENT_SESSION;
  delete env.CURSOR_PROJECT_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.WINDSURF_PROJECT_DIR;
  delete env.MYCO_PROJECT_ROOT;
  return spawnSync('node', [fixture.launcherPath, ...args], {
    cwd: fixture.projectDir,
    env,
    input: '',
    encoding: 'utf-8',
  });
}

describe('global launcher launch-failure diagnostics', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });
  afterEach(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it('hook context: signal-killed child exits 0 and writes the diagnostic', () => {
    pinFakeBinary(fixture, "process.kill(process.pid, 'SIGTERM');");
    const result = runLauncher(fixture, ['hook', 'post-tool-use']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('launch-failure');
    expect(result.stderr).toContain('signal=SIGTERM');
    expect(result.stderr).toContain('status=none');

    const log = fs.readFileSync(fixture.logPath, 'utf-8');
    expect(log).toContain('launch-failure args=[hook post-tool-use]');
    expect(log).toContain('signal=SIGTERM');
  });

  it('tool context: signal-killed child exits 1 and writes the diagnostic', () => {
    pinFakeBinary(fixture, "process.kill(process.pid, 'SIGTERM');");
    const result = runLauncher(fixture, ['tool', 'call', 'myco_search']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('signal=SIGTERM');

    const log = fs.readFileSync(fixture.logPath, 'utf-8');
    expect(log).toContain('launch-failure args=[tool call myco_search]');
  });

  it('hook context: numeric child exit code still propagates, with a log line', () => {
    pinFakeBinary(fixture, 'process.exit(3);');
    const result = runLauncher(fixture, ['hook', 'post-tool-use']);

    expect(result.status).toBe(3);

    const log = fs.readFileSync(fixture.logPath, 'utf-8');
    expect(log).toContain('status=3');
    expect(log).toContain('signal=none');
  });

  it('tool context: numeric child exit code propagates unchanged', () => {
    pinFakeBinary(fixture, 'process.exit(7);');
    const result = runLauncher(fixture, ['tool', 'call', 'myco_search']);

    expect(result.status).toBe(7);
    const log = fs.readFileSync(fixture.logPath, 'utf-8');
    expect(log).toContain('status=7');
  });

  it('unwritable logs dir: behavior unchanged, stderr diagnostic still emitted', () => {
    pinFakeBinary(fixture, "process.kill(process.pid, 'SIGTERM');");
    const logsDir = path.join(fixture.mycoHome, 'logs');
    fs.mkdirSync(logsDir);
    fs.chmodSync(logsDir, 0o555);
    try {
      const result = runLauncher(fixture, ['hook', 'post-tool-use']);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('signal=SIGTERM');
      expect(fs.existsSync(fixture.logPath)).toBe(false);
    } finally {
      fs.chmodSync(logsDir, 0o755);
    }
  });

  it('ENOENT pin target, hook context: exits 0 and logs code=ENOENT', () => {
    fs.writeFileSync(
      path.join(fixture.projectDir, '.myco', 'runtime.command'),
      `${path.join(fixture.root, 'does-not-exist')}\n`,
    );
    const result = runLauncher(fixture, ['hook', 'post-tool-use']);

    expect(result.status).toBe(0);
    const log = fs.readFileSync(fixture.logPath, 'utf-8');
    expect(log).toContain('code=ENOENT');
  });

  it('ENOENT pin target, tool context: exits 1 with the runtime_unavailable envelope and logs', () => {
    fs.writeFileSync(
      path.join(fixture.projectDir, '.myco', 'runtime.command'),
      `${path.join(fixture.root, 'does-not-exist')}\n`,
    );
    const result = runLauncher(fixture, ['tool', 'call', 'myco_search']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('runtime_unavailable');

    const log = fs.readFileSync(fixture.logPath, 'utf-8');
    expect(log).toContain('code=ENOENT');
    expect(log).toContain('args=[tool call myco_search]');
  });

  it('successful launch writes no log file', () => {
    pinFakeBinary(fixture, 'process.exit(0);');
    const result = runLauncher(fixture, ['hook', 'post-tool-use']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(fs.existsSync(fixture.logPath)).toBe(false);
  });
});
