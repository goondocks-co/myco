import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { installGlobalLaunchers } from '@myco/grove/launcher-install.js';

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
      "#!/usr/bin/env node\nprocess.stdout.write('override-hook:' + process.argv.slice(2).join(',') + '\\n');\n",
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
      "#!/usr/bin/env node\nprocess.stdout.write('override-cli:' + process.argv.slice(2).join(',') + '\\n');\n",
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
      "#!/usr/bin/env node\nprocess.stdout.write('found\\n');\n",
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
