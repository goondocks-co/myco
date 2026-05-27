import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  installGlobalLaunchers,
  bindDaemonForLauncherRefresh,
  unbindDaemonForLauncherRefresh,
} from '@myco/grove/launcher-install.js';
import type { DaemonServiceState } from '@myco/daemon/service-state.js';

describe('installGlobalLaunchers', () => {
  let mycoHome: string;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-launcher-install-'));
  });
  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  it('writes both launcher files on a fresh home', () => {
    const report = installGlobalLaunchers(mycoHome);
    const launcherPath = path.join(mycoHome, 'launcher.cjs');
    const mcpLauncherPath = path.join(mycoHome, 'mcp-launcher.cjs');

    expect(report.written).toEqual([launcherPath, mcpLauncherPath]);
    expect(report.unchanged).toEqual([]);

    expect(fs.existsSync(launcherPath)).toBe(true);
    expect(fs.existsSync(mcpLauncherPath)).toBe(true);

    // Identical content under both filenames; the script self-distinguishes
    // mode from path.basename(__filename), so the source-of-truth is one file.
    const launcher = fs.readFileSync(launcherPath, 'utf-8');
    const mcpLauncher = fs.readFileSync(mcpLauncherPath, 'utf-8');
    expect(launcher).toBe(mcpLauncher);
    expect(launcher).toContain('Myco global launcher');
    expect(launcher).toContain('LAUNCHER_TO_OVERRIDE');
  });

  it('skips writes when content already matches (idempotent)', () => {
    installGlobalLaunchers(mycoHome);
    const second = installGlobalLaunchers(mycoHome);
    expect(second.written).toEqual([]);
    expect(second.unchanged.length).toBe(2);
  });

  it('rewrites a stale launcher whose content has drifted', () => {
    const launcherPath = path.join(mycoHome, 'launcher.cjs');
    fs.writeFileSync(launcherPath, '#!/usr/bin/env node\n// stale\n', { mode: 0o755 });

    const report = installGlobalLaunchers(mycoHome);
    expect(report.written).toContain(launcherPath);
    expect(fs.readFileSync(launcherPath, 'utf-8')).toContain('Myco global launcher');
  });

  it('installs both files with executable bits set', () => {
    installGlobalLaunchers(mycoHome);
    const launcherStat = fs.statSync(path.join(mycoHome, 'launcher.cjs'));
    const mcpStat = fs.statSync(path.join(mycoHome, 'mcp-launcher.cjs'));
    // User-exec bit set on both.
    expect(launcherStat.mode & 0o100).toBe(0o100);
    expect(mcpStat.mode & 0o100).toBe(0o100);
  });
});

describe('global launcher — project-local override delegation', () => {
  let mycoHome: string;
  let projectRoot: string;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-launcher-home-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-launcher-proj-'));
    installGlobalLaunchers(mycoHome);
  });
  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function spawnLauncher(launcher: 'launcher.cjs' | 'mcp-launcher.cjs', args: string[]) {
    return spawnSync(
      process.execPath,
      [path.join(mycoHome, launcher), ...args],
      { cwd: projectRoot, env: { ...process.env, MYCO_HOME: mycoHome }, encoding: 'utf-8' },
    );
  }

  it('hook launcher delegates to .agents/myco-run.cjs when present', () => {
    const overrideDir = path.join(projectRoot, '.agents');
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.writeFileSync(
      path.join(overrideDir, 'myco-run.cjs'),
      "#!/usr/bin/env node\n// MYCO_LAUNCHER_PROTOCOL=v2\nprocess.stdout.write('override-hook:' + process.argv.slice(2).join(',') + '\\n');\n",
      { mode: 0o755 },
    );

    const result = spawnLauncher('launcher.cjs', ['hook', 'session-start', '--symbiont', 'claude-code']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('override-hook:hook,session-start,--symbiont,claude-code');
  });

  it('mcp launcher delegates to .agents/myco-cli.cjs when present', () => {
    const overrideDir = path.join(projectRoot, '.agents');
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.writeFileSync(
      path.join(overrideDir, 'myco-cli.cjs'),
      "#!/usr/bin/env node\n// MYCO_LAUNCHER_PROTOCOL=v2\nprocess.stdout.write('override-cli:' + process.argv.slice(2).join(',') + '\\n');\n",
      { mode: 0o755 },
    );

    const result = spawnLauncher('mcp-launcher.cjs', ['tool', 'list', '--json']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('override-cli:tool,list,--json');
  });

  it('hook launcher delegation walks up from cwd to find the project root', () => {
    const overrideDir = path.join(projectRoot, '.agents');
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.writeFileSync(
      path.join(overrideDir, 'myco-run.cjs'),
      "#!/usr/bin/env node\n// MYCO_LAUNCHER_PROTOCOL=v2\nprocess.stdout.write('found\\n');\n",
      { mode: 0o755 },
    );
    const nested = path.join(projectRoot, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });

    const result = spawnSync(
      process.execPath,
      [path.join(mycoHome, 'launcher.cjs'), 'hook', 'stop'],
      { cwd: nested, env: { ...process.env, MYCO_HOME: mycoHome }, encoding: 'utf-8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('found');
  });

  it('runtime resolution falls through to runtime.command pin when no override exists', () => {
    // Pretend the pinned binary is a tiny script that just echoes its argv —
    // exercises the project-local runtime.command pin (step 1 of the chain).
    const fakeBin = path.join(projectRoot, 'fake-myco.cjs');
    fs.writeFileSync(
      fakeBin,
      "#!/usr/bin/env node\nprocess.stdout.write('pin:' + process.argv.slice(2).join(',') + '\\n');\n",
      { mode: 0o755 },
    );
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.myco', 'runtime.command'),
      `${process.execPath} ${fakeBin}\n`,
    );

    // The runtime.command pin is read verbatim by the launcher and passed
    // to execFileSync. Use a script form that survives the bare-execFile
    // shape: write a tiny exec-wrapper that bridges.
    fs.writeFileSync(
      path.join(projectRoot, '.myco', 'runtime.command'),
      fakeBin,
    );
    fs.chmodSync(fakeBin, 0o755);

    const result = spawnLauncher('launcher.cjs', ['hook', 'stop']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('pin:hook,stop');
  });
});

/**
 * Regression coverage for the daemon-bound bypass path.
 *
 * `installGlobalLaunchers()` checks the module-level `daemonIntentContext`
 * binding and, when set, raises a `refresh-launchers` intent instead of
 * writing — so the daemon's reconciler thread is the single writer. The
 * reconciler ITSELF then calls `installGlobalLaunchers(undefined,
 * { skipIntent: true })`. Without `skipIntent`, the reconciler would
 * observe the same binding it owns and raise a new intent every tick —
 * an infinite re-queue with no actual launcher files ever landing on
 * disk. That bug (commit 56b5bc9a) made every agent hook ENOENT and
 * silently broke capture across the global-symbiont-install branch.
 *
 * These tests lock the bypass contract: with the binding active,
 *   - `skipIntent: true`  ⇒ files written, NO intent file produced.
 *   - default (no opts)   ⇒ intent file produced, files NOT written.
 */
describe('installGlobalLaunchers — daemon-bound intent bypass', () => {
  let mycoHome: string;
  let stateDir: string;
  let daemonService: DaemonServiceState;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-launcher-bypass-'));
    // The intent writer atomicWrites into `daemonService.stateDir`, so
    // it must exist on disk. Co-locate under `mycoHome/service` to
    // mirror the real layout.
    stateDir = path.join(mycoHome, 'service');
    fs.mkdirSync(stateDir, { recursive: true });
    daemonService = {
      scope: 'global',
      stateDir,
      // `statePath` and `lockPath` aren't read by the intent writer, but
      // the field is required by the DaemonServiceState type.
      statePath: path.join(stateDir, 'daemon.json') as DaemonServiceState['statePath'],
      lockPath: path.join(stateDir, 'daemon.lock'),
      canonicalPort: 0,
    };
    bindDaemonForLauncherRefresh(daemonService);
  });
  afterEach(() => {
    unbindDaemonForLauncherRefresh();
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  it('skipIntent: true writes launchers directly even with daemonIntentContext bound', () => {
    const report = installGlobalLaunchers(mycoHome, { skipIntent: true });

    const launcherPath = path.join(mycoHome, 'launcher.cjs');
    const mcpLauncherPath = path.join(mycoHome, 'mcp-launcher.cjs');
    expect(report.written).toEqual([launcherPath, mcpLauncherPath]);
    expect(report.unchanged).toEqual([]);

    // Files actually exist on disk with executable bits set.
    expect(fs.existsSync(launcherPath)).toBe(true);
    expect(fs.existsSync(mcpLauncherPath)).toBe(true);
    expect(fs.statSync(launcherPath).mode & 0o100).toBe(0o100);
    expect(fs.statSync(mcpLauncherPath).mode & 0o100).toBe(0o100);

    // Content matches the template (sanity — substring lifted from the
    // global-launcher.cjs header).
    expect(fs.readFileSync(launcherPath, 'utf-8')).toContain('Myco global launcher');

    // And NO intent file was written — bypass means we skipped the queue.
    const intentPath = path.join(stateDir, 'intent.refresh-launchers.toml');
    expect(fs.existsSync(intentPath)).toBe(false);
  });

  it('default (no skipIntent) raises the refresh-launchers intent and does NOT write the launchers', () => {
    const report = installGlobalLaunchers(mycoHome);

    const launcherPath = path.join(mycoHome, 'launcher.cjs');
    const mcpLauncherPath = path.join(mycoHome, 'mcp-launcher.cjs');

    // Both launchers reported as `unchanged` (pending the reconciler's
    // bypass-write pass — the contract documented in launcher-install.ts).
    expect(report.written).toEqual([]);
    expect(report.unchanged).toContain(launcherPath);
    expect(report.unchanged).toContain(mcpLauncherPath);

    // Launcher files were NOT written directly — the intent path owns it.
    expect(fs.existsSync(launcherPath)).toBe(false);
    expect(fs.existsSync(mcpLauncherPath)).toBe(false);

    // Intent file IS on disk for the reconciler to drain.
    const intentPath = path.join(stateDir, 'intent.refresh-launchers.toml');
    expect(fs.existsSync(intentPath)).toBe(true);
    const intentContent = fs.readFileSync(intentPath, 'utf-8');
    expect(intentContent).toContain('requested_at');
    expect(intentContent).toContain('detection-tick');
  });
});
