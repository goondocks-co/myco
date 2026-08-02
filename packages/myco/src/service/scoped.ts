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
 * The scope-aware service facade (Overlay Coexistence spec §13.6, R-M1).
 *
 * ONE entry point dispatches `startAt × runAs × platform` onto a backend:
 *
 * | startAt × runAs        | darwin                       | linux                          | win32              |
 * |------------------------|------------------------------|--------------------------------|--------------------|
 * | login × invoking-user  | LaunchAgent (today)          | systemctl --user (today)       | Task Sched (today) |
 * | login × root           | refused at build             | refused at build               | refused at build   |
 * | boot × invoking-user   | BOOT backend (+UserName)     | LOGIN backend + linger sidecar | unsupported-shaped |
 * | boot × root            | BOOT backend                 | BOOT backend (system unit)     | unsupported-shaped |
 *
 * The login cells return the EXISTING managers untouched. The win32 boot
 * cells return an unsupported-SHAPED backend (read verbs benign, mutations
 * throw) rather than throwing at factory time, so read-only callers (the
 * doctor scope row, `myco remove`'s observed check) never crash (spec m6).
 */
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { getServiceManager } from './manager.js';
import {
  BootServiceManager,
  DEFAULT_LAUNCH_DAEMONS_DIR,
  DEFAULT_SYSTEMD_SYSTEM_DIR,
  checkRootAvailable,
  type BootManagerOptions,
  type ServiceCommandRunner,
} from './boot-backend.js';
import { SERVICE_UNIT_DIR_ENV, resolveServiceUnitDir } from './paths.js';
import { spawnCombinedOutput } from './run-command.js';
import {
  DEFAULT_SERVICE_SCOPE,
  resolveScope,
  type InstallOptions,
  type InstallResult,
  type ServiceManager,
  type ServiceScope,
  type ServiceSpec,
} from './types.js';

/**
 * Linger seam (spec m4): `loginctl enable-linger` is a MACHINE-GLOBAL,
 * per-user change (§13.9 — Myco enables it, never disables it). Injected —
 * never defaulted inside backends — and neutered under a sandboxed unit dir
 * so a test run can never enable REAL linger for the CI user.
 */
export interface LoginctlRunner {
  run(args: string[]): Promise<{ stdout: string; exitCode: number }>;
}

export class RealLoginctlRunner implements LoginctlRunner {
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    if (process.env[SERVICE_UNIT_DIR_ENV] !== undefined) {
      // Read-only queries stay answerable; MUTATIONS never reach the real
      // loginctl from a sandbox (enable-linger is machine-global and
      // deliberately never disabled — §13.9).
      if (args[0] === 'enable-linger' || args[0] === 'disable-linger') {
        return { stdout: `[sandbox] refused loginctl ${args.join(' ')}`, exitCode: 1 };
      }
    }
    const res = await spawnCombinedOutput('loginctl', args);
    return { stdout: res.stdout, exitCode: res.exitCode ?? 1 };
  }
}

/** Bounded real runner for the boot backend — a sudo prompt with no tty must
 *  time out, never hang (spec m8: never the unbounded spawn). Exported for
 *  the CLI transition path, whose ROLLBACK re-elevates through it. */
export const boundedServiceRunner: ServiceCommandRunner = {
  async run(command, args, opts) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: opts?.timeoutMs ?? 10 * 60 * 1000,
        encoding: 'utf-8',
      });
      return { stdout: `${stdout}${stderr}`, exitCode: 0 };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: `${err.stdout ?? ''}${err.stderr ?? ''}` || String(error),
        exitCode: typeof err.code === 'number' ? err.code : 1,
      };
    }
  },
};

/** Unsupported-shaped boot backend (win32 and anything else): read verbs
 *  benign, mutations throw — mirrors `unsupported.ts`'s fail-closed shape. */
class UnsupportedBootServiceManager implements ServiceManager {
  readonly supported = false;

  constructor(readonly platformName: string) {}

  private refuse(verb: string): never {
    throw new Error(`Boot-scope services are not supported on ${this.platformName} (${verb}).`);
  }

  async isInstalled(): Promise<boolean> { return false; }

  async inspect(): Promise<null> { return null; }

  async install(): Promise<InstallResult> { this.refuse('install'); }

  async uninstall(): Promise<void> { this.refuse('uninstall'); }

  async start(): Promise<void> { this.refuse('start'); }

  async stop(): Promise<void> { this.refuse('stop'); }

  async restart(): Promise<void> { this.refuse('restart'); }

  restartShellCommand(): string { this.refuse('restartShellCommand'); }

  async status() {
    return { installed: false, running: false as const, pid: null, lastExitCode: null, unitPath: null };
  }
}

/**
 * The linger sidecar wrapper for the Linux boot+invoking-user cell: the unit
 * itself is the ORDINARY user unit (login backend, unprivileged — which is
 * what lets the daemon keep refreshing it across binary swaps, spec R-M2);
 * boot persistence comes from `loginctl enable-linger`, applied on install
 * even when the unit bytes are unchanged (§13.13 gate 5 — the content-match
 * early return must not swallow the linger half) and DISCLOSED as the
 * machine-scope change it is.
 */
class LingeringServiceManager implements ServiceManager {
  readonly supported: boolean;

  readonly platformName: string;

  constructor(
    private readonly inner: ServiceManager,
    private readonly loginctl: LoginctlRunner,
    private readonly disclose: (message: string) => void,
  ) {
    this.supported = inner.supported;
    this.platformName = `${inner.platformName} + linger`;
  }

  async install(spec: ServiceSpec, opts?: InstallOptions): Promise<InstallResult> {
    const result = await this.inner.install(spec, opts);
    const state = await this.loginctl.run(['show-user', String(process.env.USER ?? ''), '--property=Linger']);
    const lingering = state.exitCode === 0 && state.stdout.includes('Linger=yes');
    if (!lingering) {
      const enabled = await this.loginctl.run(['enable-linger']);
      if (enabled.exitCode === 0) {
        this.disclose(
          'Enabled systemd lingering for your user so Myco starts at boot. This is a machine-wide '
          + 'change: ALL of your user services now start without a login. Myco never disables it.',
        );
      } else {
        throw new Error(`Could not enable systemd lingering (loginctl enable-linger failed): ${enabled.stdout.trim()}`);
      }
    }
    return result;
  }

  isInstalled(label: string): Promise<boolean> { return this.inner.isInstalled(label); }

  inspect(label: string) { return this.inner.inspect(label); }

  uninstall(label: string): Promise<void> { return this.inner.uninstall(label); }

  start(label: string): Promise<void> { return this.inner.start(label); }

  stop(label: string): Promise<void> { return this.inner.stop(label); }

  restart(label: string): Promise<void> { return this.inner.restart(label); }

  restartShellCommand(label: string): string { return this.inner.restartShellCommand(label); }

  status(label: string) { return this.inner.status(label); }

  pruneSupersededUnits(keepLabel?: string): Promise<string[]> {
    return this.inner.pruneSupersededUnits?.(keepLabel) ?? Promise.resolve([]);
  }
}

export interface ScopedManagerOptions {
  scope?: ServiceScope;
  platform?: NodeJS.Platform;
  /** Test seams for the boot backend — REQUIRED runner/dir come from here or
   *  from the real defaults this factory (and only this factory) supplies. */
  bootOverrides?: Partial<Pick<BootManagerOptions, 'runner' | 'unitDir' | 'stagingDir' | 'logger'>>;
  loginctl?: LoginctlRunner;
  disclose?: (message: string) => void;
}

/** Resolve the backend for a declared scope. Login scope returns the existing
 *  manager UNTOUCHED — every legacy caller resolves through here unchanged. */
export function getScopedServiceManager(options: ScopedManagerOptions = {}): ServiceManager {
  const platform = options.platform ?? process.platform;
  const scope = resolveScope({ label: '<scope-dispatch>', scope: options.scope });
  if (scope.startAt === 'login') {
    return getServiceManager({ platform });
  }
  if (platform !== 'darwin' && platform !== 'linux') {
    return new UnsupportedBootServiceManager(String(platform));
  }
  if (platform === 'linux' && scope.runAs === 'invoking-user') {
    return new LingeringServiceManager(
      getServiceManager({ platform }),
      options.loginctl ?? new RealLoginctlRunner(),
      options.disclose ?? ((message) => process.stdout.write(`${message}\n`)),
    );
  }
  return new BootServiceManager({
    runner: options.bootOverrides?.runner ?? boundedServiceRunner,
    platform,
    unitDir: options.bootOverrides?.unitDir
      ?? (platform === 'darwin' ? DEFAULT_LAUNCH_DAEMONS_DIR : DEFAULT_SYSTEMD_SYSTEM_DIR),
    stagingDir: options.bootOverrides?.stagingDir,
    logger: options.bootOverrides?.logger,
  });
}

/**
 * Per-cell capability probe (§13.8): can THIS machine honor `scope` right
 * now? The UI/CLI gate the option on it; a boot install on a manager that
 * cannot honor it throws rather than silently doing nothing.
 */
export async function supportsScope(
  scope: ServiceScope,
  options: ScopedManagerOptions = {},
): Promise<{ supported: boolean; detail: string }> {
  const platform = options.platform ?? process.platform;
  if (scope.startAt === 'login' && scope.runAs === 'invoking-user') {
    return { supported: getServiceManager({ platform }).supported, detail: 'login scope is the platform default' };
  }
  if (scope.startAt === 'login') return { supported: false, detail: 'login+root is not supported on any platform' };
  if (platform !== 'darwin' && platform !== 'linux') {
    return { supported: false, detail: `boot scope is not supported on ${String(platform)}` };
  }
  if (platform === 'linux' && scope.runAs === 'invoking-user') {
    const loginctl = options.loginctl ?? new RealLoginctlRunner();
    const probe = await loginctl.run(['--version']);
    return probe.exitCode === 0
      ? { supported: true, detail: 'loginctl available for lingering' }
      : { supported: false, detail: 'loginctl unavailable — cannot enable lingering' };
  }
  const root = await checkRootAvailable({
    runner: options.bootOverrides?.runner ?? boundedServiceRunner,
    platform,
  });
  return { supported: root.available, detail: root.detail };
}

/**
 * What is ACTUALLY installed for `label`, read across both domains (§13.4:
 * a scope change needs the OLD scope to remove the old unit, and config
 * alone would convert silent reversion into silent non-realization).
 * File-system reads only — both unit locations are world-readable.
 */
export async function resolveObservedScope(
  label: string,
  options: {
    platform?: NodeJS.Platform;
    loginUnitDir?: string;
    bootUnitDir?: string;
    /** Linger consult seam (Linux only). Defaults to the real loginctl. */
    loginctl?: LoginctlRunner;
  } = {},
): Promise<'login' | 'boot' | 'both' | 'none'> {
  const platform = options.platform ?? process.platform;
  const loginDir = options.loginUnitDir ?? resolveServiceUnitDir({ platform });
  const loginUnit = platform === 'darwin'
    ? nodePath.join(loginDir, `${label}.plist`)
    : nodePath.join(loginDir, `${label}.service`);
  const bootDir = options.bootUnitDir
    ?? (platform === 'darwin' ? DEFAULT_LAUNCH_DAEMONS_DIR : DEFAULT_SYSTEMD_SYSTEM_DIR);
  const bootUnit = platform === 'darwin'
    ? nodePath.join(bootDir, `${label}.plist`)
    : nodePath.join(bootDir, `${label}.service`);
  const login = nodeFs.existsSync(loginUnit);
  // On win32 there is no boot domain; the login task is the only unit.
  const boot = platform === 'darwin' || platform === 'linux' ? nodeFs.existsSync(bootUnit) : false;
  if (login && boot) return 'both';
  if (boot) return 'boot';
  if (login) {
    // The Linux boot+invoking-user cell IS the user unit + linger (spec
    // R-M1) — pure file existence would read a correctly-lingering box as
    // 'login' forever: a permanent false doctor warn, and every `myco
    // service install` reclassified as a destructive scope change (M7).
    if (platform === 'linux') {
      const loginctl = options.loginctl ?? new RealLoginctlRunner();
      const state = await loginctl
        .run(['show-user', String(process.env.USER ?? ''), '--property=Linger'])
        .catch(() => ({ stdout: '', exitCode: 1 }));
      if (state.exitCode === 0 && state.stdout.includes('Linger=yes')) return 'boot';
    }
    return 'login';
  }
  return 'none';
}

/**
 * §13.7: a scope change is ONE named operation — `stop-old → uninstall-old →
 * install-new → start-new` — never two independent calls from a caller, and
 * ALWAYS driven from a separate process (a daemon re-bootstrapping its own
 * job SIGTERMs itself mid-bootout; §13.5's sudo requirement makes it
 * CLI/UI-only anyway).
 *
 * Failure of install-new is LOUD and recovers by restoring the old unit's
 * ACTUAL BYTES (captured before uninstall — re-rendering would silently
 * upgrade a hand-edited or older-version unit), then starting it (spec
 * R-M5: §13.13 gate 6 requires the old unit LEFT RUNNING). A rollback into
 * the boot domain re-elevates, so it is attempted only while the preflight
 * still passes; a failed rollback reports BOTH errors.
 */
/** Terminal outcome of a rolled-back transition — the transition FAILED but
 *  the previous unit was restored and started (§13.13 gate 6). */
export class ScopeTransitionRolledBackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeTransitionRolledBackError';
  }
}

export async function transitionServiceScope(options: {
  label: string;
  spec: ServiceSpec;
  from: { manager: ServiceManager; scope: ServiceScope; unitPath: string };
  to: { manager: ServiceManager; scope: ServiceScope };
  /** Bounded runner for rollback re-registration commands. */
  runner: ServiceCommandRunner;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}): Promise<void> {
  const { label, spec, from, to } = options;
  const platform = options.platform ?? process.platform;
  const log = options.log ?? (() => {});

  // Capture the old unit's bytes BEFORE anything destructive. When the
  // caller's status carried no unitPath, derive it from the scope so a real
  // old unit is never misreported as "no old unit existed to restore".
  const oldUnitPath = from.unitPath || (from.scope.startAt === 'boot'
    ? nodePath.join(
      platform === 'darwin' ? DEFAULT_LAUNCH_DAEMONS_DIR : DEFAULT_SYSTEMD_SYSTEM_DIR,
      platform === 'darwin' ? `${label}.plist` : `${label}.service`,
    )
    : nodePath.join(
      resolveServiceUnitDir({ platform }),
      platform === 'darwin' ? `${label}.plist` : `${label}.service`,
    ));
  let oldUnitBytes: string | null = null;
  try {
    oldUnitBytes = nodeFs.readFileSync(oldUnitPath, 'utf-8');
  } catch { /* old unit already gone — nothing to roll back to */ }

  await from.manager.stop(label).catch(() => { /* stopped or never running */ });
  try {
    await from.manager.uninstall(label);
  } catch (uninstallError) {
    // Gate 6's invariant ("old unit left RUNNING") applies here too: the
    // service is stopped but still installed — restart it and report what
    // actually happened (a partial uninstall can leave the job booted out,
    // in which case start fails and claiming success would be a lie — N3).
    await from.manager.start(label).catch(() => { /* verified below */ });
    const after = await from.manager.status(label).catch(() => null);
    const outcome = after?.running === true
      ? 'the old unit was restarted and nothing was changed'
      : `a restart of the old unit was ATTEMPTED but its run state is ${after ? String(after.running) : 'unreadable'} — check \`myco service status\``;
    throw new Error(
      `Scope transition could not remove the ${from.scope.startAt}-scoped unit `
      + `(${uninstallError instanceof Error ? uninstallError.message : String(uninstallError)}); ${outcome}.`,
    );
  }
  log(`Removed ${from.scope.startAt}-scoped unit for ${label}.`);

  try {
    await to.manager.install({ ...spec, scope: to.scope }, { force: true });
    await to.manager.start(label);
    log(`Installed and started ${to.scope.startAt}-scoped unit for ${label}.`);
  } catch (installError) {
    const installMessage = installError instanceof Error ? installError.message : String(installError);
    if (oldUnitBytes === null) {
      throw new Error(
        `Scope transition failed installing the new ${to.scope.startAt} unit (${installMessage}), `
        + 'and no old unit existed to restore. The service is NOT installed — run `myco service install` again.',
      );
    }
    try {
      await restoreUnitBytes({
        label, unitPath: oldUnitPath, bytes: oldUnitBytes, scope: from.scope, platform, runner: options.runner,
      });
      await from.manager.start(label).catch(() => { /* verified below */ });
      const restored = await from.manager.status(label).catch(() => null);
      log(`Rolled back: restored the ${from.scope.startAt}-scoped unit for ${label}.`);
      throw new ScopeTransitionRolledBackError(
        `Scope transition failed installing the new ${to.scope.startAt} unit: ${installMessage}. `
        + `The previous ${from.scope.startAt}-scoped unit was RESTORED`
        + `${restored?.running === true ? ' and started' : ` (start attempted; run state ${restored ? String(restored.running) : 'unreadable'})`}.`,
      );
    } catch (rollbackError) {
      if (rollbackError instanceof ScopeTransitionRolledBackError) {
        throw rollbackError;
      }
      throw new Error(
        `Scope transition failed installing the new ${to.scope.startAt} unit (${installMessage}) AND the `
        + `rollback of the old unit also failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}). `
        + 'The service is NOT installed. Reinstall with `myco service install` from a shell that can elevate.',
      );
    }
  }
}

/** Restore a unit's exact bytes and re-register it with its supervisor. */
async function restoreUnitBytes(input: {
  label: string;
  unitPath: string;
  bytes: string;
  scope: ServiceScope;
  platform: NodeJS.Platform;
  runner: ServiceCommandRunner;
}): Promise<void> {
  const boot = input.scope.startAt === 'boot' && (input.scope.runAs === 'root' || input.platform === 'darwin');
  if (!boot) {
    // Login-domain restore: the unit dirs are user-writable.
    nodeFs.writeFileSync(input.unitPath, input.bytes, 'utf-8');
    if (input.platform === 'darwin') {
      const uid = process.getuid?.() ?? 501;
      await input.runner.run('launchctl', ['bootstrap', `gui/${uid}`, input.unitPath]);
    } else {
      await input.runner.run('systemctl', ['--user', 'daemon-reload']);
    }
    return;
  }
  // Boot-domain restore re-elevates: only while sudo still answers.
  const root = await checkRootAvailable({ runner: input.runner, platform: input.platform });
  if (!root.available) throw new Error(`cannot restore the boot unit without sudo: ${root.detail}`);
  const staged = nodePath.join(nodeOs.tmpdir(), `${input.label}.rollback`);
  nodeFs.writeFileSync(staged, input.bytes, 'utf-8');
  const installArgs = input.platform === 'darwin'
    ? ['install', '-m', '0644', '-o', 'root', '-g', 'wheel', staged, input.unitPath]
    : ['install', '-m', '0644', staged, input.unitPath];
  const res = await input.runner.run('sudo', installArgs);
  nodeFs.rmSync(staged, { force: true });
  if (res.exitCode !== 0) throw new Error(`sudo install failed: ${res.stdout.trim()}`);
  if (input.platform === 'darwin') {
    await input.runner.run('sudo', ['launchctl', 'bootstrap', 'system', input.unitPath]);
  } else {
    await input.runner.run('sudo', ['systemctl', 'daemon-reload']);
  }
}

export { DEFAULT_SERVICE_SCOPE };
