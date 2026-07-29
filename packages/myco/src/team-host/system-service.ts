/**
 * Root/system-domain service supervisor for the overlay control plane (Task 2.1).
 *
 * WHY THIS EXISTS (service-machinery reuse decision — see the task report):
 * Myco's own daemon is supervised as a USER service — `@myco/service`'s
 * `LaunchdServiceManager` bootstraps into `gui/<uid>` (a LaunchAgent) and
 * `SystemdUserServiceManager` into `systemd --user`. That is exactly WRONG for a
 * Team Host control plane: a LaunchAgent only runs while a user is logged in, so
 * it would NOT survive the reboot-before-login case — the precise failure the
 * spike caught (a nohup'd headscale died on reboot). Headscale + tailscaled must
 * be ROOT services (a `/Library/LaunchDaemons` plist / a `/etc/systemd/system`
 * unit) that launchd/systemd start at boot regardless of login.
 *
 * So this module REUSES the pure, low-risk unit RENDERERS (`renderLaunchdPlist`,
 * `renderSystemdUnit`) and the `ServiceSpec` shape from `@myco/service`, but
 * installs into the SYSTEM domain via `sudo`. It deliberately does NOT modify the
 * user-domain managers (they govern every released user's daemon lifecycle — too
 * load-bearing to grow a root-write mode) and does NOT fork their install logic:
 * the actual XML/INI generation is shared. tailscaled uses its OWN native
 * `install-system-daemon` on macOS (spike-proven headless) rather than a
 * hand-rolled plist.
 *
 * ROOT IS REQUIRED and never smuggled: every privileged step shells `sudo`
 * through the injectable {@link CommandRunner}. A password is never embedded; if
 * sudo is unavailable the failure is surfaced, not swallowed. All effects run
 * behind seams so this unit-tests with no real service install.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderLaunchdPlist } from '@myco/service/launchd-plist.js';
import { renderSystemdUnit } from '@myco/service/systemd-unit.js';
import type { ServiceSpec } from '@myco/service/types.js';

import type { CommandRunner } from './binaries.js';

/** Where root system units live, per platform. Injected by tests. */
export const DEFAULT_LAUNCH_DAEMONS_DIR = '/Library/LaunchDaemons';
export const DEFAULT_SYSTEMD_SYSTEM_DIR = '/etc/systemd/system';

export interface SystemServiceContext {
  runner: CommandRunner;
  platform?: NodeJS.Platform;
  /** macOS system-daemon dir. Default `/Library/LaunchDaemons`. */
  launchDaemonsDir?: string;
  /** Linux system-unit dir. Default `/etc/systemd/system`. */
  systemdUnitDir?: string;
  /** Unprivileged scratch dir for the rendered unit before the sudo copy. Default the OS tmp dir. */
  stagingDir?: string;
  logger?: (message: string) => void;
}

function ctxPlatform(ctx: SystemServiceContext): NodeJS.Platform {
  return ctx.platform ?? process.platform;
}

/** The on-disk path of the installed system unit for `label`. */
export function systemUnitPath(ctx: SystemServiceContext, label: string): string {
  if (ctxPlatform(ctx) === 'darwin') {
    return path.join(ctx.launchDaemonsDir ?? DEFAULT_LAUNCH_DAEMONS_DIR, `${label}.plist`);
  }
  return path.join(ctx.systemdUnitDir ?? DEFAULT_SYSTEMD_SYSTEM_DIR, `${label}.service`);
}

/** Cheap existence check — the system unit dirs are world-readable, so no sudo. */
export function isSystemServiceInstalled(ctx: SystemServiceContext, label: string): boolean {
  return fs.existsSync(systemUnitPath(ctx, label));
}

/**
 * Preflight: is `sudo` usable non-interactively right now? Returns a structured
 * result the operator surface can act on — NEVER prompts, never embeds a
 * password. `available: false` means the caller must tell the operator to run
 * with sudo (or pre-authenticate) before the privileged steps.
 */
export async function checkRootAvailable(ctx: SystemServiceContext): Promise<{ available: boolean; detail: string }> {
  const res = await ctx.runner.run('sudo', ['-n', 'true']);
  if (res.exitCode === 0) return { available: true, detail: 'passwordless sudo available' };
  return {
    available: false,
    detail:
      'root privileges are required to install the overlay control plane as system services '
      + '(a /Library/LaunchDaemons plist on macOS, a /etc/systemd/system unit on Linux). '
      + 'Re-run `myco host enable` from a shell where `sudo` can elevate (you may be prompted for your password).',
  };
}

/**
 * Install `spec` as a ROOT system service (idempotent). Renders the platform
 * unit from the shared `@myco/service` renderers, stages it unprivileged, then
 * `sudo install`s it into the system dir and bootstraps/enables it.
 */
export async function installSystemService(ctx: SystemServiceContext, spec: ServiceSpec): Promise<void> {
  const log = ctx.logger ?? (() => {});
  const platform = ctxPlatform(ctx);
  const dest = systemUnitPath(ctx, spec.label);
  const staging = ctx.stagingDir ?? os.tmpdir();
  fs.mkdirSync(staging, { recursive: true });

  if (platform === 'darwin') {
    const staged = path.join(staging, `${spec.label}.plist`);
    fs.writeFileSync(staged, renderLaunchdPlist(spec), 'utf-8');
    await sudo(ctx, ['install', '-m', '0644', '-o', 'root', '-g', 'wheel', staged, dest], `install ${dest}`);
    fs.rmSync(staged, { force: true });
    // bootout any prior instance (tolerated), then bootstrap + enable into the system domain.
    await ctx.runner.run('sudo', ['launchctl', 'bootout', `system/${spec.label}`]);
    await sudo(ctx, ['launchctl', 'bootstrap', 'system', dest], `launchctl bootstrap system ${dest}`);
    await ctx.runner.run('sudo', ['launchctl', 'enable', `system/${spec.label}`]);
    log(`installed root LaunchDaemon ${spec.label} at ${dest}`);
    return;
  }

  if (platform === 'linux') {
    const staged = path.join(staging, `${spec.label}.service`);
    fs.writeFileSync(staged, renderSystemdUnit(spec), 'utf-8');
    await sudo(ctx, ['install', '-m', '0644', staged, dest], `install ${dest}`);
    fs.rmSync(staged, { force: true });
    await sudo(ctx, ['systemctl', 'daemon-reload'], 'systemctl daemon-reload');
    await sudo(ctx, ['systemctl', 'enable', '--now', `${spec.label}.service`], `systemctl enable --now ${spec.label}`);
    log(`installed systemd system unit ${spec.label} at ${dest}`);
    return;
  }

  throw new Error(`Team Host system services are not supported on ${platform}.`);
}

/** Stop + remove a root system service. Idempotent — tolerates an already-absent unit. */
export async function uninstallSystemService(ctx: SystemServiceContext, label: string): Promise<void> {
  const platform = ctxPlatform(ctx);
  const dest = systemUnitPath(ctx, label);

  if (platform === 'darwin') {
    await ctx.runner.run('sudo', ['launchctl', 'bootout', `system/${label}`]);
    await ctx.runner.run('sudo', ['rm', '-f', dest]);
    return;
  }
  if (platform === 'linux') {
    await ctx.runner.run('sudo', ['systemctl', 'disable', '--now', `${label}.service`]);
    await ctx.runner.run('sudo', ['rm', '-f', dest]);
    await ctx.runner.run('sudo', ['systemctl', 'daemon-reload']);
    return;
  }
  throw new Error(`Team Host system services are not supported on ${platform}.`);
}

// ---------------------------------------------------------------------------
// ServiceSpec builder for a supervised overlay binary
// ---------------------------------------------------------------------------

/**
 * Build a {@link ServiceSpec} for an overlay binary supervised as a root service.
 * Distinct from `@myco/service`'s `buildServiceSpec` (which is daemon-self-specific:
 * it hardcodes `args:['daemon']`, MYCO_HOME env, and dev-build guards). This is
 * the generic form for an arbitrary managed binary — the "supervise an arbitrary
 * managed binary" extension the brief allows, kept here rather than grown into
 * the daemon's own spec builder.
 */
export function buildOverlayServiceSpec(input: {
  label: string;
  executable: string;
  args: string[];
  workingDir: string;
  logDir: string;
  env?: Record<string, string>;
}): ServiceSpec {
  return {
    label: input.label,
    variant: 'prod',
    executable: input.executable,
    args: input.args,
    workingDir: input.workingDir,
    env: input.env ?? {},
    stdoutPath: path.join(input.logDir, `${input.label}.out.log`),
    stderrPath: path.join(input.logDir, `${input.label}.err.log`),
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 10,
  };
}

/** Stable label for the supervised headscale control plane. */
export const HEADSCALE_SERVICE_LABEL = 'co.goondocks.myco-headscale';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Run a `sudo <args>` step, throwing a clear error (not swallowing) on failure. */
async function sudo(ctx: SystemServiceContext, args: string[], label: string): Promise<void> {
  const res = await ctx.runner.run('sudo', args);
  if (res.exitCode !== 0) {
    throw new Error(
      `\`sudo ${label}\` failed (exit ${res.exitCode}): ${res.stdout.trim()}. `
      + 'Team Host requires root to supervise the overlay services; ensure sudo can elevate and retry.',
    );
  }
}
