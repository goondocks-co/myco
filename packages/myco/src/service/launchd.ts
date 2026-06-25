import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { renderLaunchdPlist } from './launchd-plist.js';
import { spawnCombinedOutput, assertRunSucceeded } from './run-command.js';
import { SERVICE_UNIT_DIR_ENV } from './paths.js';
import type {
  InstallOptions,
  InstallResult,
  ServiceManager,
  ServiceSpec,
  ServiceStatus,
} from './types.js';

export interface LaunchctlRunner {
  run(args: string[]): Promise<{ stdout: string; exitCode: number }>;
}

/**
 * Real launchctl shell-out. Gated on `MYCO_LAUNCH_AGENTS_DIR` (set by every
 * sandboxed install / test harness): when that env var is present the install
 * is by definition isolated from the user's real `gui/<uid>` launchd domain,
 * so calling `launchctl bootstrap`/`bootout` against that domain would
 * register a sandbox label that survives temp-dir cleanup and forces launchd
 * to respawn the daemon forever. The structural fix is to never make that
 * call in sandbox mode; tests that need to observe the launchctl argv inject
 * their own `LaunchctlRunner` stub via `LaunchdManagerOptions.runner`.
 */
export class RealLaunchctlRunner implements LaunchctlRunner {
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    if (process.env[SERVICE_UNIT_DIR_ENV]?.trim()) {
      return { stdout: `[sandbox] skipped launchctl ${args.join(' ')}`, exitCode: 0 };
    }
    return spawnCombinedOutput('launchctl', args);
  }
}

export interface LaunchdManagerOptions {
  runner?: LaunchctlRunner;
  /** `~/Library/LaunchAgents` by default. */
  agentsDir?: string;
  /** Current user's uid (for gui/<uid> domain). */
  uid?: number;
}

export class LaunchdServiceManager implements ServiceManager {
  readonly supported = true;
  readonly platformName = 'launchd';
  private readonly runner: LaunchctlRunner;
  readonly agentsDir: string;
  private readonly uid: number;

  constructor(opts: LaunchdManagerOptions = {}) {
    this.runner = opts.runner ?? new RealLaunchctlRunner();
    this.agentsDir = opts.agentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents');
    this.uid = opts.uid ?? process.getuid?.() ?? 501;
  }

  private plistPath(label: string): string {
    return path.join(this.agentsDir, `${label}.plist`);
  }

  private domainTarget(label: string): string {
    return `gui/${this.uid}/${label}`;
  }

  async isInstalled(label: string): Promise<boolean> {
    return fs.existsSync(this.plistPath(label));
  }

  async install(spec: ServiceSpec, opts: InstallOptions = {}): Promise<InstallResult> {
    const plistPath = this.plistPath(spec.label);
    const rendered = renderLaunchdPlist(spec);

    let existing: string | null = null;
    try { existing = fs.readFileSync(plistPath, 'utf-8'); } catch { /* ENOENT */ }

    if (existing === rendered) {
      // File already matches. `force` still re-bootstraps so the LOADED unit
      // adopts the on-disk policy — the case where a daemon wrote the corrected
      // (SuccessfulExit=false) plist during self-install but its launchd job is
      // still looping under the old bare-KeepAlive policy, which a content
      // compare can't see. Safe only because `force` comes solely from the CLI
      // (a separate process); a daemon re-bootstrapping its OWN job would
      // SIGTERM itself mid-bootout.
      if (opts.force) {
        await this.rebootstrap(spec.label, plistPath);
        return { changed: false, supervisorReloaded: true };
      }
      return { changed: false, supervisorReloaded: false };
    }

    fs.mkdirSync(this.agentsDir, { recursive: true });
    fs.mkdirSync(path.dirname(spec.stdoutPath), { recursive: true });
    fs.mkdirSync(path.dirname(spec.stderrPath), { recursive: true });
    atomicWriteFileSync(plistPath, rendered);

    if (existing === null) {
      await this.bootstrapEnable(spec.label, plistPath);
      return { changed: true, supervisorReloaded: true };
    }

    // A changed plist: bootout terminates the running service, so the default
    // is to write the new plist and let the supervisor's next restart pick it
    // up (reloading now would terminate the calling daemon during self-install).
    // `force: true` opts into an immediate swap.
    if (!opts.force) {
      return { changed: true, supervisorReloaded: false };
    }
    await this.rebootstrap(spec.label, plistPath);
    return { changed: true, supervisorReloaded: true };
  }

  /** bootstrap + enable for a freshly-written plist (first install). */
  private async bootstrapEnable(label: string, plistPath: string): Promise<void> {
    assertRunSucceeded(
      await this.runner.run(['bootstrap', `gui/${this.uid}`, plistPath]),
      `launchctl bootstrap gui/${this.uid}`,
    );
    assertRunSucceeded(
      await this.runner.run(['enable', this.domainTarget(label)]),
      `launchctl enable ${this.domainTarget(label)}`,
    );
  }

  /** bootout the loaded job (best-effort — it may not be loaded) then
   *  bootstrap + enable: the immediate swap that makes the supervisor adopt the
   *  on-disk plist NOW. MUST NOT be called by the daemon whose own job this is —
   *  the bootout would SIGTERM the caller before bootstrap runs. */
  private async rebootstrap(label: string, plistPath: string): Promise<void> {
    await this.runner.run(['bootout', this.domainTarget(label)]);
    await this.bootstrapEnable(label, plistPath);
  }

  async uninstall(label: string): Promise<void> {
    const plistPath = this.plistPath(label);
    await this.runner.run(['bootout', this.domainTarget(label)]);
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
    // Sweep any sibling plists whose target binary is gone (old version dirs,
    // removed dev-build worktrees) so launchd stops churning on dead units.
    await this.pruneSupersededUnits(label);
  }

  async start(label: string): Promise<void> {
    assertRunSucceeded(
      await this.runner.run(['kickstart', '-k', this.domainTarget(label)]),
      `launchctl kickstart -k ${this.domainTarget(label)}`,
    );
  }

  async stop(label: string): Promise<void> {
    await this.runner.run(['kill', 'SIGTERM', this.domainTarget(label)]);
  }

  async restart(label: string): Promise<void> {
    // kickstart -k SIGTERMs the running instance then starts it again.
    // Requires the service to be installed (loaded). We don't check first
    // because launchctl returns a clear error if not.
    assertRunSucceeded(
      await this.runner.run(['kickstart', '-k', this.domainTarget(label)]),
      `launchctl kickstart -k ${this.domainTarget(label)}`,
    );
  }

  restartShellCommand(label: string): string {
    // Literal command the detached update / restart script invokes after the
    // daemon exits. Mirrors restart() above so launchd's KeepAlive cannot race
    // a manually-spawned daemon child for the canonical port.
    return `launchctl kickstart -k ${this.domainTarget(label)}`;
  }

  async status(label: string): Promise<ServiceStatus> {
    const plistPath = this.plistPath(label);
    if (!fs.existsSync(plistPath)) {
      return { installed: false, running: false, pid: null, lastExitCode: null, unitPath: null };
    }
    const { stdout } = await this.runner.run(['print', this.domainTarget(label)]);
    const pidMatch = stdout.match(/pid\s*=\s*(\d+)/);
    const exitMatch = stdout.match(/last exit code\s*=\s*(-?\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
    return {
      installed: true,
      running: pid !== null,
      pid,
      lastExitCode: exitMatch ? parseInt(exitMatch[1], 10) : null,
      unitPath: plistPath,
    };
  }

  /**
   * Bootout + remove `co.goondocks.myco*.plist` units whose target binary no
   * longer exists on disk — superseded leftovers (an old version dir, a removed
   * dev-build worktree) that launchd keeps trying to respawn.
   *
   * Identity is verified by READING each plist's executable, never by matching
   * the label pattern: home-hash and sandbox-suffix labels are by design, so a
   * still-live non-default-home daemon must never be pruned. A unit is removed
   * ONLY when its executable is parseable AND missing; an unparseable plist or a
   * present binary is left untouched. `keepLabel` is an extra guard for the unit
   * the caller is actively managing. Returns the labels pruned.
   */
  async pruneSupersededUnits(keepLabel?: string): Promise<string[]> {
    const pruned: string[] = [];
    let entries: string[];
    try { entries = fs.readdirSync(this.agentsDir); } catch { return pruned; }
    for (const file of entries) {
      if (!/^co\.goondocks\.myco.*\.plist$/.test(file)) continue;
      const label = file.slice(0, -'.plist'.length);
      if (keepLabel && label === keepLabel) continue;
      const plistPath = path.join(this.agentsDir, file);
      let content: string;
      try { content = fs.readFileSync(plistPath, 'utf-8'); } catch { continue; }
      const exe = parsePlistExecutable(content);
      // Only prune a unit we can positively identify as dead (executable gone).
      // Unparseable or still-present → leave it; never delete by label pattern.
      if (!exe || fs.existsSync(exe)) continue;
      await this.runner.run(['bootout', this.domainTarget(label)]);
      try { fs.unlinkSync(plistPath); } catch { /* best-effort */ }
      pruned.push(label);
    }
    return pruned;
  }
}

/** First ProgramArguments <string> (the executable) from a launchd plist. */
function parsePlistExecutable(plist: string): string | null {
  const arrayBlock = plist.split('<key>ProgramArguments</key>')[1]?.split('</array>')[0];
  const m = arrayBlock?.match(/<string>([^<]*)<\/string>/);
  return m ? m[1] : null;
}
