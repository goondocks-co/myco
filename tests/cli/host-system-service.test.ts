import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildOverlayServiceSpec,
  checkRootAvailable,
  installSystemService,
  isSystemServiceInstalled,
  systemUnitPath,
  uninstallSystemService,
  HEADSCALE_SERVICE_LABEL,
  type SystemServiceContext,
} from '@myco/team-host/system-service.js';
import * as systemServiceModule from '@myco/team-host/system-service.js';
import type { CommandRunner } from '@myco/team-host/binaries.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** A runner that records argv and, for `sudo install`/`sudo rm`, performs the fs effect
 *  so isSystemServiceInstalled() reflects reality. Everything else exits 0. */
function fakeSudoRunner(overrides: Record<string, number> = {}): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(command: string, args: string[]) {
      calls.push([command, ...args]);
      const joined = args.join(' ');
      for (const [pattern, exitCode] of Object.entries(overrides)) {
        if (joined.includes(pattern)) return { stdout: `forced-fail: ${pattern}`, exitCode };
      }
      if (command === 'sudo' && args[0] === 'install') {
        const src = args[args.length - 2];
        const dest = args[args.length - 1];
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
      if (command === 'sudo' && args[0] === 'rm') {
        fs.rmSync(args[args.length - 1], { force: true });
      }
      return { stdout: '', exitCode: 0 };
    },
  };
  return { runner, calls };
}

describe('system-service supervisor', () => {
  let tmp: string;
  let sysDir: string;
  let staging: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-svc-'));
    sysDir = path.join(tmp, 'system');
    staging = path.join(tmp, 'staging');
    fs.mkdirSync(sysDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const spec = () => buildOverlayServiceSpec({
    label: HEADSCALE_SERVICE_LABEL,
    executable: '/x/.myco-team/host/bin/headscale',
    args: ['serve', '--config', '/x/.myco-team/host/headscale/config.yaml'],
    workingDir: '/x/.myco-team/host/headscale',
    logDir: '/x/.myco-team/host/headscale/logs',
  });

  it('resolves the system unit path per platform', () => {
    const macCtx: SystemServiceContext = { runner: fakeSudoRunner().runner, platform: 'darwin', launchDaemonsDir: sysDir };
    expect(systemUnitPath(macCtx, 'co.x')).toBe(path.join(sysDir, 'co.x.plist'));
    const linCtx: SystemServiceContext = { runner: fakeSudoRunner().runner, platform: 'linux', systemdUnitDir: sysDir };
    expect(systemUnitPath(linCtx, 'co.x')).toBe(path.join(sysDir, 'co.x.service'));
  });

  it('installs headscale as a ROOT LaunchDaemon (system domain, not gui/<uid>) on macOS', async () => {
    const { runner, calls } = fakeSudoRunner();
    const ctx: SystemServiceContext = { runner, platform: 'darwin', launchDaemonsDir: sysDir, stagingDir: staging };

    await installSystemService(ctx, spec());

    // The plist landed in the system LaunchDaemons dir and is a valid launchd plist.
    const dest = path.join(sysDir, `${HEADSCALE_SERVICE_LABEL}.plist`);
    expect(isSystemServiceInstalled(ctx, HEADSCALE_SERVICE_LABEL)).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toContain('<key>RunAtLoad</key>');
    // Bootstrapped into the SYSTEM domain (the reboot-survival requirement), not gui/<uid>.
    const bootstrap = calls.find((c) => c.includes('bootstrap'))!;
    expect(bootstrap).toEqual(['sudo', 'launchctl', 'bootstrap', 'system', dest]);
    expect(calls.some((c) => c.join(' ').includes('gui/'))).toBe(false);
  });

  it('installs headscale as a systemd SYSTEM unit + enable --now on Linux', async () => {
    const { runner, calls } = fakeSudoRunner();
    const ctx: SystemServiceContext = { runner, platform: 'linux', systemdUnitDir: sysDir, stagingDir: staging };
    await installSystemService(ctx, spec());
    expect(fs.existsSync(path.join(sysDir, `${HEADSCALE_SERVICE_LABEL}.service`))).toBe(true);
    expect(calls.some((c) => c.join(' ') === `sudo systemctl enable --now ${HEADSCALE_SERVICE_LABEL}.service`)).toBe(true);
    expect(calls.some((c) => c.join(' ') === 'sudo systemctl daemon-reload')).toBe(true);
  });

  it('uninstall is idempotent and removes the unit file', async () => {
    const { runner, calls } = fakeSudoRunner();
    const ctx: SystemServiceContext = { runner, platform: 'darwin', launchDaemonsDir: sysDir, stagingDir: staging };
    await installSystemService(ctx, spec());
    expect(isSystemServiceInstalled(ctx, HEADSCALE_SERVICE_LABEL)).toBe(true);
    await uninstallSystemService(ctx, HEADSCALE_SERVICE_LABEL);
    expect(isSystemServiceInstalled(ctx, HEADSCALE_SERVICE_LABEL)).toBe(false);
    // A second uninstall on an already-absent unit does not throw.
    await expect(uninstallSystemService(ctx, HEADSCALE_SERVICE_LABEL)).resolves.toBeUndefined();
    expect(calls.some((c) => c.includes('bootout'))).toBe(true);
  });

  it('SURFACES a sudo failure instead of swallowing it', async () => {
    const { runner } = fakeSudoRunner({ install: 1 });
    const ctx: SystemServiceContext = { runner, platform: 'darwin', launchDaemonsDir: sysDir, stagingDir: staging };
    await expect(installSystemService(ctx, spec())).rejects.toThrow(/requires root|sudo/i);
  });

  it('checkRootAvailable reports availability from `sudo -n true` without prompting', async () => {
    const okCtx: SystemServiceContext = { runner: fakeSudoRunner().runner, platform: 'darwin' };
    expect(await checkRootAvailable(okCtx)).toEqual({ available: true, detail: expect.stringContaining('sudo') });
    const noCtx: SystemServiceContext = { runner: fakeSudoRunner({ 'true': 1 }).runner, platform: 'darwin' };
    const res = await checkRootAvailable(noCtx);
    expect(res.available).toBe(false);
    expect(res.detail).toMatch(/root privileges are required/);
  });

  it('supervises NO tailscaled at all — that moved to the unprivileged user domain', async () => {
    // This module used to install tailscaled via the vendor's own
    // `install-system-daemon`, which creates (and on teardown REMOVES) the
    // root com.tailscale.tailscaled LaunchDaemon — indistinguishable from
    // managing the user's genuine Tailscale. Coexistence C1/C2 moved host
    // tailscaled to a user-domain userspace service on private paths
    // (`team-host/overlay.ts`, `buildHostTailscaledSpec`). The property worth
    // guarding is that this root-domain module never grows it back.
    // Comment-stripped, so the header docstring EXPLAINING why the vendor
    // installer is gone does not read as the code being back.
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/myco/src/team-host/system-service.ts'),
      'utf-8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => (line.indexOf('//') === -1 ? line : line.slice(0, line.indexOf('//'))))
      .join('\n');
    expect(source).not.toContain('install-system-daemon');
    expect(Object.keys(systemServiceModule)).not.toContain('installTailscaledDaemon');
    expect(Object.keys(systemServiceModule)).not.toContain('uninstallTailscaledDaemon');
  });
});
