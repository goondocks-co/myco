/**
 * A 2.0 member home never runs the Myco 1.4 local daemon (`member/home-role.ts`):
 * nothing spawns it or asks a supervisor to start it, it exits at start, it
 * installs no service, the global agent install leaves every agent's config
 * alone, and credential-less `myco tool` and `myco mcp` refuse with the
 * credential-backed alternative. A home with no membership keeps 1.4's
 * behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonClient } from '@myco/daemon/client.js';
import { runSymbiontDetection } from '@myco/cli/bootstrap.js';
import { assertSafeServiceMutation } from '@myco/cli/service.js';
import { ensureSelfInstalledAsService } from '@myco/service/self-install.js';
import { isMemberHome } from '@myco/member/home-role.js';
import type { ServiceManager } from '@myco/service/types.js';
import { resolvePackageRoot } from '@myco/symbionts/detect.js';

const CLI = path.join(resolvePackageRoot(), 'src', 'cli.ts');

/** A service manager that records every call made to it. */
function recordingManager(calls: string[]): ServiceManager {
  return new Proxy({ supported: true, platformName: 'recording' } as unknown as ServiceManager, {
    get(target, prop) {
      if (prop in target) return (target as unknown as Record<string | symbol, unknown>)[prop];
      return async () => { calls.push(String(prop)); return prop === 'isInstalled' ? true : null; };
    },
  });
}

describe('a 2.0 member home and the 1.4 daemon', () => {
  let home: string;
  let mycoHome: string;
  let held: { HOME?: string; MYCO_HOME?: string };
  beforeEach(() => {
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-gate-')));
    mycoHome = path.join(home, '.myco');
    fs.mkdirSync(path.join(mycoHome, 'member', 'deployments'), { recursive: true });
    fs.writeFileSync(path.join(mycoHome, 'member', 'deployments', 'd.json'), '{}');
    held = { HOME: process.env.HOME, MYCO_HOME: process.env.MYCO_HOME };
    process.env.HOME = home;
    process.env.MYCO_HOME = mycoHome;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(held)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('knows a member home by its membership or its cutover record', () => {
    expect(isMemberHome(mycoHome)).toBe(true);
    const cutOver = path.join(home, 'cut');
    fs.mkdirSync(path.join(cutOver, 'member'), { recursive: true });
    expect(isMemberHome(cutOver)).toBe(false);
    fs.writeFileSync(path.join(cutOver, 'member', 'cutover.json'), '{}');
    expect(isMemberHome(cutOver)).toBe(true);
  });

  it('neither spawns the daemon nor asks a supervisor to start it', async () => {
    const calls: string[] = [];
    const client = new DaemonClient(path.join(home, 'proj', '.myco'), { serviceManager: recordingManager(calls) });
    expect(client.memberHomeRefusal()).toContain('is a Myco 2.0 member home');
    const started = Date.now();
    expect(await client.ensureRunning()).toBe(false);
    await client.spawnDaemon();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(mycoHome, 'service'))).toBe(false);
  });

  it('installs no service and rewrites no agent config', async () => {
    const calls: string[] = [];
    const logged: string[] = [];
    await ensureSelfInstalledAsService({ info: (_k: string, m: string) => logged.push(m), warn: () => {}, error: () => {} } as never, { mycoHome, manager: recordingManager(calls) });
    expect(calls).toEqual([]);
    expect(logged.join('\n')).toContain('is a Myco 2.0 member home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}\n');
    expect(runSymbiontDetection()).toEqual([]);
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe('{}\n');
    expect(fs.existsSync(path.join(mycoHome, 'skills'))).toBe(false);
  });

  it('refuses the daemon at start, and credential-less `myco mcp` and `myco tool`, with the alternative', () => {
    const project = path.join(home, 'proj');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    fs.writeFileSync(path.join(project, '.myco', 'myco.yaml'), 'version: 12\n');
    const env = { ...process.env, HOME: home, MYCO_HOME: mycoHome };
    const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: 'utf8', timeout: 60_000, input: '' });

    const daemon = run(['daemon']);
    expect(daemon.status).toBe(0);
    expect(daemon.stderr).toContain('is a Myco 2.0 member home');
    const mcp = run(['mcp']);
    expect(mcp.status).toBe(1);
    expect(mcp.stderr).toContain('--credential registry');
    const tool = run(['tool', 'call', 'myco_search', '--json', '--input', '{"query":"x"}']);
    expect(tool.status).toBe(1);
    expect(JSON.parse(tool.stdout).error.code).toBe('member_home');
    expect(fs.existsSync(path.join(mycoHome, 'service'))).toBe(false);
  });

  it('installs, starts and restarts no service unit through the service verbs, doctor\'s reinstall or restart', () => {
    const project = path.join(home, 'proj');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    fs.writeFileSync(path.join(project, '.myco', 'myco.yaml'), 'version: 12\n');
    const agents = path.join(home, 'LaunchAgents');
    const env = { ...process.env, HOME: home, MYCO_HOME: mycoHome, MYCO_LAUNCH_AGENTS_DIR: agents };
    const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: 'utf8', timeout: 60_000, input: '' });
    for (const args of [['service', 'install'], ['service', 'start'], ['service', 'restart'], ['service', 'reconcile'], ['restart']]) {
      const result = run(args);
      expect({ args, status: result.status }).toEqual({ args, status: 1 });
      expect(result.stderr).toContain('is a Myco 2.0 member home');
    }
    expect(fs.existsSync(agents) ? fs.readdirSync(agents) : []).toEqual([]);
    expect(assertSafeServiceMutation({ action: 'install' }, process.execPath, mycoHome)).toContain('is a Myco 2.0 member home');
    expect(assertSafeServiceMutation({ action: 'stop' }, process.execPath, mycoHome)).toBeNull();
  });

  it('keeps 1.4 behaviour for a home with no membership', () => {
    fs.rmSync(path.join(mycoHome, 'member'), { recursive: true });
    expect(isMemberHome(mycoHome)).toBe(false);
    expect(new DaemonClient(path.join(home, 'proj', '.myco')).memberHomeRefusal()).toBeNull();
  });
});
