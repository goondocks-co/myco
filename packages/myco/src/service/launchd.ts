import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { renderLaunchdPlist } from './launchd-plist.js';
import { spawnCombinedOutput, assertRunSucceeded } from './run-command.js';
import { SERVICE_UNIT_DIR_ENV } from './paths.js';
import { ensureServiceLogDirs } from './log-dirs.js';
import type {
  InstallOptions,
  InstallResult,
  InstalledServiceCommand,
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
      return {
        stdout: `[sandbox] skipped launchctl ${args.join(' ')}`,
        exitCode: args[0] === 'print' ? 1 : 0,
      };
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
  /** Wait between launchd teardown observations. */
  sleep?: (delayMs: number) => Promise<void>;
}

const LAUNCHD_TEARDOWN_TIMEOUT_MS = 10_000;
const LAUNCHD_TEARDOWN_POLL_INTERVAL_MS = 100;

export class LaunchdServiceManager implements ServiceManager {
  readonly supported = true;
  readonly platformName = 'launchd';
  private readonly runner: LaunchctlRunner;
  readonly agentsDir: string;
  private readonly uid: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(opts: LaunchdManagerOptions = {}) {
    this.runner = opts.runner ?? new RealLaunchctlRunner();
    this.agentsDir = opts.agentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents');
    this.uid = opts.uid ?? process.getuid?.() ?? 501;
    this.sleep = opts.sleep ?? sleep;
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

  async inspect(label: string): Promise<InstalledServiceCommand | null> {
    let plist: string;
    try {
      plist = fs.readFileSync(this.plistPath(label), 'utf-8');
    } catch {
      return null;
    }
    return parsePlistCommand(plist, label);
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
    ensureServiceLogDirs(spec);
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
    await this.unloadIfLoaded(label);
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
    const installed = fs.existsSync(plistPath);
    const { stdout, exitCode } = await this.runner.run(['print', this.domainTarget(label)]);
    if (exitCode !== 0) {
      return {
        installed,
        running: false,
        pid: null,
        lastExitCode: null,
        unitPath: installed ? plistPath : null,
      };
    }
    const pidMatch = stdout.match(/pid\s*=\s*(\d+)/);
    const exitMatch = stdout.match(/last exit code\s*=\s*(-?\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
    return {
      installed,
      running: pid !== null,
      pid,
      lastExitCode: exitMatch ? parseInt(exitMatch[1], 10) : null,
      unitPath: installed ? plistPath : null,
    };
  }

  private async isLoaded(label: string): Promise<boolean> {
    const result = await this.runner.run(['print', this.domainTarget(label)]);
    if (result.exitCode === 0) return true;
    if (isLaunchdJobAbsent(result.stdout)) return false;
    assertRunSucceeded(result, `launchctl print ${this.domainTarget(label)}`);
    return false;
  }

  private async waitUntilUnloaded(label: string): Promise<void> {
    const maxPolls = Math.ceil(LAUNCHD_TEARDOWN_TIMEOUT_MS / LAUNCHD_TEARDOWN_POLL_INTERVAL_MS);
    for (let poll = 0; poll <= maxPolls; poll++) {
      if (!(await this.isLoaded(label))) return;
      if (poll < maxPolls) await this.sleep(LAUNCHD_TEARDOWN_POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for launchd job ${label} to exit`);
  }

  private async unloadIfLoaded(label: string): Promise<void> {
    if (!(await this.isLoaded(label))) return;
    assertRunSucceeded(
      await this.runner.run(['bootout', this.domainTarget(label)]),
      `launchctl bootout ${this.domainTarget(label)}`,
    );
    await this.waitUntilUnloaded(label);
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
      const exe = parsePlistExecutable(content, label);
      // Only prune a unit we can positively identify as dead (executable gone).
      // Unparseable or still-present → leave it; never delete by label pattern.
      if (!exe || fs.existsSync(exe)) continue;
      await this.unloadIfLoaded(label);
      fs.unlinkSync(plistPath);
      pruned.push(label);
    }
    return pruned;
  }
}

/** First ProgramArguments <string> (the executable) from a launchd plist. */
function parsePlistExecutable(plist: string, expectedLabel?: string): string | null {
  return parsePlistCommand(plist, expectedLabel)?.executable ?? null;
}

export function parsePlistCommand(plist: string, expectedLabel?: string): InstalledServiceCommand | null {
  const parsed = parsePlistDocument(plist);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
  if (expectedLabel !== undefined && parsed.Label !== expectedLabel) return null;
  if (Object.hasOwn(parsed, 'Program')) return null;
  if (!Array.isArray(parsed.ProgramArguments) || parsed.ProgramArguments.length === 0) return null;
  if (!parsed.ProgramArguments.every((value) => typeof value === 'string')) return null;
  const [executable, ...args] = parsed.ProgramArguments;
  return { executable, args };
}

function decodePlistString(value: string): string | null {
  if (/&(?!(?:amp|lt|gt|quot);)/.test(value)) return null;
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function isLaunchdJobAbsent(stdout: string): boolean {
  // A PERMISSION refusal is not absence (spec R-M6): reading "Operation not
  // permitted" as "no job" would report a live service as gone.
  if (/not privileged|operation not permitted|permission denied/i.test(stdout)) return false;
  return /^\[sandbox\] skipped launchctl print /i.test(stdout)
    || /(?:could not find|not found|unknown) service/i.test(stdout);
}

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function parsePlistDocument(plist: string): { [key: string]: PlistValue } | null {
  const xml = plist
    .replace(/^\s*<\?xml[^>]*\?>/, '')
    .replace(/^\s*<!DOCTYPE[^>]*>/, '');
  let index = 0;

  const skipWhitespace = (): void => {
    while (/\s/.test(xml[index] ?? '')) index++;
  };
  const consume = (pattern: RegExp): string | null => {
    skipWhitespace();
    const match = xml.slice(index).match(pattern);
    if (!match || match.index !== 0) return null;
    index += match[0].length;
    return match[0];
  };
  const textElement = (tag: 'key' | 'string'): string | undefined => {
    if (consume(new RegExp(`^<${tag}>`)) === null) return undefined;
    const close = `</${tag}>`;
    const closeIndex = xml.indexOf(close, index);
    if (closeIndex === -1) return undefined;
    const encoded = xml.slice(index, closeIndex);
    if (encoded.includes('<')) return undefined;
    index = closeIndex + close.length;
    return decodePlistString(encoded) ?? undefined;
  };
  const value = (): PlistValue | undefined => {
    skipWhitespace();
    if (xml.startsWith('<string>', index)) return textElement('string');
    if (consume(/^<true\s*\/>/) !== null) return true;
    if (consume(/^<false\s*\/>/) !== null) return false;
    if (consume(/^<integer>/) !== null) {
      const closeIndex = xml.indexOf('</integer>', index);
      if (closeIndex === -1) return undefined;
      const raw = xml.slice(index, closeIndex);
      if (!/^-?\d+$/.test(raw)) return undefined;
      index = closeIndex + '</integer>'.length;
      return parseInt(raw, 10);
    }
    if (consume(/^<array>/) !== null) {
      const result: PlistValue[] = [];
      while (true) {
        skipWhitespace();
        if (consume(/^<\/array>/) !== null) return result;
        const item = value();
        if (item === undefined) return undefined;
        result.push(item);
      }
    }
    if (consume(/^<dict>/) !== null) {
      const result: { [key: string]: PlistValue } = Object.create(null) as { [key: string]: PlistValue };
      while (true) {
        skipWhitespace();
        if (consume(/^<\/dict>/) !== null) return result;
        const key = textElement('key');
        if (key === undefined || Object.hasOwn(result, key)) return undefined;
        const item = value();
        if (item === undefined) return undefined;
        result[key] = item;
      }
    }
    return undefined;
  };

  if (consume(/^<plist(?:\s[^>]*)?>/) === null) return null;
  const root = value();
  if (!root || Array.isArray(root) || typeof root !== 'object') return null;
  if (consume(/^<\/plist>/) === null) return null;
  skipWhitespace();
  return index === xml.length ? root : null;
}
