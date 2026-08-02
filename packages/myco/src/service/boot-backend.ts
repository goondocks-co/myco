/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * BOOT-scope privileged service mechanics (Overlay Coexistence spec §13.6).
 *
 * Moved verbatim-in-behavior from `team-host/system-service.ts` (which now
 * re-exports from here): the general user-domain managers are "too
 * load-bearing to grow a root-write mode", so boot scope is a SEPARATE
 * backend behind the scoped facade rather than a sudo branch inside them.
 *
 * ROOT IS REQUIRED and never smuggled: every privileged step shells `sudo`
 * through the injectable {@link ServiceCommandRunner}. A password is never
 * embedded; if sudo is unavailable the failure is surfaced, not swallowed.
 *
 * FAIL-SAFE CONSTRUCTION (spec R-B3): there is NO default runner and NO
 * default unit dir on this module's context — callers must supply both.
 * Only the scoped facade (`service/scoped.ts`) wires real values; every test
 * exercises the flow through injected fakes, so forgetting the sandbox env
 * var cannot sudo-write the real `/Library/LaunchDaemons`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderLaunchdPlist } from './launchd-plist.js';
import { renderSystemdUnit } from './systemd-unit.js';
import type { ServiceSpec } from './types.js';

/**
 * The service layer's own runner seam (spec R-Q4: never import the tailscale
 * provisioning module's `CommandRunner` into the service layer). Structurally
 * identical, so `team-host` adapters satisfy it without conversion. Real
 * implementations must bound execution — a sudo prompt with no tty must time
 * out, never hang (the host layer's `realCommandRunner` caps at 10 minutes).
 */
export interface ServiceCommandRunner {
  /** Run `command args`, resolving with combined output + exit code (never rejects on non-zero). */
  run(command: string, args: string[], opts?: { input?: string; timeoutMs?: number }): Promise<{ stdout: string; exitCode: number }>;
}

/** Where root system units live, per platform. */
export const DEFAULT_LAUNCH_DAEMONS_DIR = '/Library/LaunchDaemons';
export const DEFAULT_SYSTEMD_SYSTEM_DIR = '/etc/systemd/system';

export interface BootServiceContext {
  /** REQUIRED — no default. The facade supplies the real (bounded) runner. */
  runner: ServiceCommandRunner;
  platform?: NodeJS.Platform;
  /** macOS system-daemon dir. Default `/Library/LaunchDaemons`. */
  launchDaemonsDir?: string;
  /** Linux system-unit dir. Default `/etc/systemd/system`. */
  systemdUnitDir?: string;
  /** Unprivileged scratch dir for the rendered unit before the sudo copy. Default the OS tmp dir. */
  stagingDir?: string;
  logger?: (message: string) => void;
}

function ctxPlatform(ctx: BootServiceContext): NodeJS.Platform {
  return ctx.platform ?? process.platform;
}

/** The on-disk path of the installed system unit for `label`. */
export function systemUnitPath(ctx: BootServiceContext, label: string): string {
  if (ctxPlatform(ctx) === 'darwin') {
    return path.join(ctx.launchDaemonsDir ?? DEFAULT_LAUNCH_DAEMONS_DIR, `${label}.plist`);
  }
  return path.join(ctx.systemdUnitDir ?? DEFAULT_SYSTEMD_SYSTEM_DIR, `${label}.service`);
}

/** Cheap existence check — the system unit dirs are world-readable, so no sudo. */
export function isSystemServiceInstalled(ctx: BootServiceContext, label: string): boolean {
  return fs.existsSync(systemUnitPath(ctx, label));
}

/**
 * Preflight: is `sudo` usable non-interactively right now? Returns a structured
 * result the operator surface can act on — NEVER prompts, never embeds a
 * password. `available: false` means the caller must tell the operator to run
 * with sudo (or pre-authenticate) before the privileged steps.
 */
export async function checkRootAvailable(ctx: BootServiceContext): Promise<{ available: boolean; detail: string }> {
  const res = await ctx.runner.run('sudo', ['-n', 'true']);
  if (res.exitCode === 0) return { available: true, detail: 'passwordless sudo available' };
  return {
    available: false,
    detail:
      'root privileges are required to install system services '
      + '(a /Library/LaunchDaemons plist on macOS, a /etc/systemd/system unit on Linux). '
      + 'Re-run the command from a shell where `sudo` can elevate (you may be prompted for your password).',
  };
}

/**
 * Install `spec` as a ROOT system service (idempotent). Renders the platform
 * unit from the shared renderers, stages it unprivileged, then `sudo install`s
 * it into the system dir and bootstraps/enables it.
 */
export async function installSystemService(ctx: BootServiceContext, spec: ServiceSpec): Promise<void> {
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

/**
 * Stop + remove a root system service. Idempotent — tolerates an
 * already-absent unit (bootout/disable are best-effort) but the REMOVAL
 * itself is asserted: reporting success while the root unit survives means
 * "✓ Unregistered" over a LaunchDaemon that keeps respawning (§13.13 gate 7),
 * and a scope transition that leaves both domains populated (§13.5).
 */
export async function uninstallSystemService(ctx: BootServiceContext, label: string): Promise<void> {
  const platform = ctxPlatform(ctx);
  const dest = systemUnitPath(ctx, label);

  if (platform === 'darwin') {
    await ctx.runner.run('sudo', ['launchctl', 'bootout', `system/${label}`]);
    await sudo(ctx, ['rm', '-f', dest], `rm ${dest}`);
    return;
  }
  if (platform === 'linux') {
    await ctx.runner.run('sudo', ['systemctl', 'disable', '--now', `${label}.service`]);
    await sudo(ctx, ['rm', '-f', dest], `rm ${dest}`);
    await sudo(ctx, ['systemctl', 'daemon-reload'], 'systemctl daemon-reload');
    return;
  }
  throw new Error(`Team Host system services are not supported on ${platform}.`);
}

/**
 * Restart a ROOT system service in place (§14.4's replace-and-restart other
 * half for boot-scoped units like headscale). Driven by the caller's
 * existing {@link BootServiceContext} — NEVER via the scoped facade, whose
 * real-dir defaults are exactly what this module's fail-safe construction
 * forbids reaching from orchestration code.
 */
export async function restartSystemService(ctx: BootServiceContext, label: string): Promise<void> {
  if (ctxPlatform(ctx) === 'darwin') {
    await sudo(ctx, ['launchctl', 'kickstart', '-k', `system/${label}`], `launchctl kickstart -k system/${label}`);
    return;
  }
  await sudo(ctx, ['systemctl', 'restart', `${label}.service`], `systemctl restart ${label}`);
}

/** Run a `sudo <args>` step, throwing a clear error (not swallowing) on failure. */
async function sudo(ctx: BootServiceContext, args: string[], label: string): Promise<void> {
  const res = await ctx.runner.run('sudo', args);
  if (res.exitCode !== 0) {
    throw new Error(
      `\`sudo ${label}\` failed (exit ${res.exitCode}): ${res.stdout.trim()}. `
      + 'Team Host requires root to supervise the overlay services; ensure sudo can elevate and retry.',
    );
  }
}

// ---------------------------------------------------------------------------
// BootServiceManager — the boot-scope backend behind the scoped facade
// ---------------------------------------------------------------------------

import { SERVICE_UNIT_DIR_ENV } from './paths.js';
import { parsePlistCommand } from './launchd.js';
import { parseSystemdCommand } from './systemd.js';
import { resolveScope } from './types.js';
import type {
  InstallOptions,
  InstallResult,
  InstalledServiceCommand,
  ServiceManager,
  ServiceStatus,
} from './types.js';

/**
 * A sandboxed run may NEVER touch the system domain. Unlike the login
 * managers' success-shaped `exitCode: 0` no-ops (`launchd.ts`), this THROWS —
 * a "[sandbox] skipped" that reads as an installed boot service would be a
 * success-shaped log for an install that never happened, and the failure
 * this guards is a root plist named `co.goondocks.myco.sandbox-<hash>`
 * respawning forever (spec §13.6, R-B3).
 */
export class SandboxedBootScopeError extends Error {
  constructor(verb: string) {
    super(
      `Refusing boot-scope service ${verb} under a sandboxed service unit dir `
      + `(${SERVICE_UNIT_DIR_ENV} is set). Boot scope writes the REAL system domain via sudo; `
      + 'tests must inject a fake runner and unit dir instead.',
    );
    this.name = 'SandboxedBootScopeError';
  }
}

export interface BootManagerOptions {
  /** REQUIRED — no default (spec R-B3): only the scoped facade wires a real,
   *  bounded runner; every test injects a fake. */
  runner: ServiceCommandRunner;
  platform: NodeJS.Platform;
  /** REQUIRED — the system unit dir this manager owns. */
  unitDir: string;
  stagingDir?: string;
  logger?: (message: string) => void;
}

/**
 * `ServiceManager` over the SYSTEM domain (darwin LaunchDaemons / linux
 * /etc/systemd/system). Reads are unprivileged (the unit dirs are
 * world-readable); every mutation shells `sudo` through the injected runner.
 * `status.running` degrades to `'unknown'` rather than guessing — a
 * permission error is never read as "absent" or "stopped" (spec R-M6).
 */
export class BootServiceManager implements ServiceManager {
  readonly supported: boolean;

  readonly platformName: string;

  private readonly ctx: BootServiceContext;

  private readonly platform: NodeJS.Platform;

  constructor(options: BootManagerOptions) {
    this.platform = options.platform;
    this.supported = options.platform === 'darwin' || options.platform === 'linux';
    this.platformName = options.platform === 'darwin' ? 'launchd (system domain)' : 'systemd (system)';
    this.ctx = {
      runner: options.runner,
      platform: options.platform,
      launchDaemonsDir: options.unitDir,
      systemdUnitDir: options.unitDir,
      stagingDir: options.stagingDir,
      logger: options.logger,
    };
  }

  private unitPath(label: string): string {
    return systemUnitPath(this.ctx, label);
  }

  private assertMutable(verb: string): void {
    if (!this.supported) {
      throw new Error(`Boot-scope services are not supported on ${this.platform}.`);
    }
    // `isSandboxedServiceUnitDir()` is true exactly when the env var is set;
    // the single check is the whole gate.
    if (process.env[SERVICE_UNIT_DIR_ENV] !== undefined) {
      throw new SandboxedBootScopeError(verb);
    }
  }

  async isInstalled(label: string): Promise<boolean> {
    return isSystemServiceInstalled(this.ctx, label);
  }

  async inspect(label: string): Promise<InstalledServiceCommand | null> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.unitPath(label), 'utf-8');
    } catch {
      return null;
    }
    return this.platform === 'darwin'
      ? parsePlistCommand(raw, label)
      : parseSystemdCommand(raw);
  }

  async install(spec: ServiceSpec, _opts?: InstallOptions): Promise<InstallResult> {
    const scope = resolveScope(spec);
    if (scope.startAt !== 'boot') {
      throw new Error(
        `BootServiceManager refuses a ${scope.startAt}-scoped spec for ${spec.label} — route it through the scoped facade.`,
      );
    }
    // Gate FIRST (minor 16): "every mutating verb throws under a sandbox"
    // holds without a content-match carve-out — an idempotent no-op answer
    // from a sandboxed boot manager would still be a lie about the domain.
    this.assertMutable('install');
    const rendered = this.platform === 'darwin' ? renderLaunchdPlist(spec) : renderSystemdUnit(spec);
    // Idempotence WITHOUT sudo: the unit dirs are world-readable, so a
    // content match never elevates (fixes the always-bootstrap asymmetry of
    // the pre-facade installer).
    try {
      if (fs.readFileSync(this.unitPath(spec.label), 'utf-8') === rendered) {
        return { changed: false, supervisorReloaded: false };
      }
    } catch { /* absent or unreadable → full install */ }
    await installSystemService(this.ctx, spec);
    return { changed: true, supervisorReloaded: true };
  }

  async uninstall(label: string): Promise<void> {
    this.assertMutable('uninstall');
    await uninstallSystemService(this.ctx, label);
  }

  async start(label: string): Promise<void> {
    this.assertMutable('start');
    if (this.platform === 'darwin') {
      await sudo(this.ctx, ['launchctl', 'kickstart', `system/${label}`], `launchctl kickstart system/${label}`);
      return;
    }
    await sudo(this.ctx, ['systemctl', 'start', `${label}.service`], `systemctl start ${label}`);
  }

  async stop(label: string): Promise<void> {
    this.assertMutable('stop');
    if (this.platform === 'darwin') {
      // SIGTERM the job without booting it out — bootout would UNINSTALL it
      // from the supervisor, which `uninstall` owns.
      await this.ctx.runner.run('sudo', ['launchctl', 'kill', 'SIGTERM', `system/${label}`]);
      return;
    }
    await sudo(this.ctx, ['systemctl', 'stop', `${label}.service`], `systemctl stop ${label}`);
  }

  async restart(label: string): Promise<void> {
    this.assertMutable('restart');
    if (this.platform === 'darwin') {
      await sudo(this.ctx, ['launchctl', 'kickstart', '-k', `system/${label}`], `launchctl kickstart -k system/${label}`);
      return;
    }
    await sudo(this.ctx, ['systemctl', 'restart', `${label}.service`], `systemctl restart ${label}`);
  }

  restartShellCommand(label: string): string {
    // Detached restart scripts running this need passwordless sudo; the
    // transition preflight (`checkRootAvailable`) is what admits boot scope.
    return this.platform === 'darwin'
      ? `sudo launchctl kickstart -k system/${label}`
      : `sudo systemctl restart ${label}.service`;
  }

  async status(label: string): Promise<ServiceStatus> {
    const unitPath = this.unitPath(label);
    const installed = fs.existsSync(unitPath);
    if (!installed) {
      return { installed: false, running: false, pid: null, lastExitCode: null, unitPath: null };
    }
    let running: boolean | 'unknown' = 'unknown';
    let pid: number | null = null;
    let lastExitCode: number | null = null;
    try {
      if (this.platform === 'darwin') {
        // Unprivileged `launchctl print system/<label>` is readable on some
        // configurations; a refusal degrades to 'unknown', NEVER to false.
        const res = await this.ctx.runner.run('launchctl', ['print', `system/${label}`]);
        if (res.exitCode === 0) {
          const pidMatch = res.stdout.match(/\bpid = (\d+)/);
          pid = pidMatch ? Number(pidMatch[1]) : null;
          running = pid !== null;
          const exitMatch = res.stdout.match(/last exit code = (-?\d+)/);
          lastExitCode = exitMatch ? Number(exitMatch[1]) : null;
        }
      } else {
        const res = await this.ctx.runner.run('systemctl', ['is-active', `${label}.service`]);
        if (res.stdout.trim() === 'active') running = true;
        else if (['inactive', 'failed'].includes(res.stdout.trim())) running = false;
      }
    } catch { /* degrade to 'unknown' */ }
    return { installed, running, pid, lastExitCode, unitPath };
  }
}
