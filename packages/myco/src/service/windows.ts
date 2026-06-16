import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { renderWindowsServiceScript } from './windows-task.js';
import { spawnCombinedOutput } from './run-command.js';
import { SERVICE_UNIT_DIR_ENV } from './paths.js';
import { requestCooperativeShutdown } from './cooperative-shutdown.js';
import { SERVICE_LABEL_DEV } from './labels.js';
import {
  resolveMycoHome,
  DAEMON_STATE_FILENAME,
  SERVICE_DIRNAME,
  SERVICE_DEV_DIRNAME,
} from '../grove/paths.js';
import type {
  InstallOptions,
  InstallResult,
  ServiceManager,
  ServiceSpec,
  ServiceStatus,
} from './types.js';

/**
 * Read the running daemon's loopback port from `daemon.json` for a service
 * label. Returns null when the file is absent/unreadable — the caller then
 * skips the cooperative drain and goes straight to `schtasks /end`.
 */
function readDaemonPortForLabel(label: string): number | null {
  try {
    const dirName = label.startsWith(SERVICE_LABEL_DEV) ? SERVICE_DEV_DIRNAME : SERVICE_DIRNAME;
    const statePath = path.join(resolveMycoHome(), dirName, DAEMON_STATE_FILENAME);
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { port?: number };
    return typeof parsed.port === 'number' ? parsed.port : null;
  } catch {
    return null;
  }
}

export interface SchtasksRunner {
  run(args: string[]): Promise<{ stdout: string; exitCode: number }>;
}

/**
 * Real `schtasks.exe` shell-out. Gated on `MYCO_LAUNCH_AGENTS_DIR` (set by
 * every sandboxed install / test harness) — same structural concern as
 * launchd/systemd: a sandboxed install must never register a real Task
 * Scheduler task the test cleanup can't reach. Tests inject a `SchtasksRunner`
 * stub to observe argv without touching the real scheduler.
 */
export class RealSchtasksRunner implements SchtasksRunner {
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    if (process.env[SERVICE_UNIT_DIR_ENV]?.trim()) {
      return { stdout: `[sandbox] skipped schtasks ${args.join(' ')}`, exitCode: 0 };
    }
    return spawnCombinedOutput('schtasks', args);
  }
}

export interface WindowsManagerOptions {
  runner?: SchtasksRunner;
  /** Directory holding the launcher `.cmd` scripts. */
  scriptDir?: string;
  /** Resolve the running daemon's loopback port for a label (reads daemon.json). */
  resolveDaemonPort?: (label: string) => number | null;
  /** Drain the daemon over HTTP before a hard `schtasks /end`. */
  cooperativeShutdown?: (port: number) => Promise<boolean>;
}

/**
 * Windows daemon service via Task Scheduler — the peer of the launchd /
 * systemd managers. There is no Windows equivalent of a launchd plist or a
 * systemd unit that both holds the env and supervises the process, so this
 * splits the two: a launcher `.cmd` carries the env + exec + log redirection
 * (`windows-task.ts`), and a Task Scheduler task triggers it at logon.
 *
 * Why Task Scheduler and not a real Windows service (`sc.exe`): a
 * `bun build --compile` binary has no `StartServiceCtrlDispatcher` /
 * `SERVICE_STATUS` handler, so SCM would mark it failed (error 1053) on
 * `sc start`. A logon-triggered scheduled task runs an ordinary process with
 * no service-protocol contract — the correct fit for a user daemon.
 *
 * Crash auto-restart (the launchd `KeepAlive` / systemd `Restart=always`
 * equivalent) is handled by the existing hook-respawn path — a hook fires,
 * finds no live daemon via the lifecycle lock, and spawns one. A Task
 * Scheduler `RestartOnFailure` policy (XML task definition) would add
 * scheduler-driven restarts; deferred until it earns its keep.
 */
export class WindowsTaskServiceManager implements ServiceManager {
  readonly supported = true;
  readonly platformName = 'Windows Task Scheduler';
  private readonly runner: SchtasksRunner;
  readonly scriptDir: string;
  private readonly resolveDaemonPort: (label: string) => number | null;
  private readonly cooperativeShutdown: (port: number) => Promise<boolean>;

  constructor(opts: WindowsManagerOptions = {}) {
    this.runner = opts.runner ?? new RealSchtasksRunner();
    this.scriptDir = opts.scriptDir ?? path.join(os.homedir(), '.myco', 'service');
    this.resolveDaemonPort = opts.resolveDaemonPort ?? readDaemonPortForLabel;
    this.cooperativeShutdown = opts.cooperativeShutdown ?? requestCooperativeShutdown;
  }

  private scriptPath(label: string): string {
    return path.join(this.scriptDir, `${label}.cmd`);
  }

  /**
   * Drain the daemon gracefully over HTTP before `schtasks /end` hard-kills it.
   * `/end` is an uncatchable TerminateProcess, so without this the daemon's
   * shutdown (in-flight runs, team-sync outbox, DB close) never runs and every
   * Windows stop/restart/update defers that work to the next boot. Best-effort:
   * a missing port or a wedged drain falls through to the `/end` that follows.
   */
  private async drainBeforeEnd(label: string): Promise<void> {
    const port = this.resolveDaemonPort(label);
    if (port === null) return;
    try {
      await this.cooperativeShutdown(port);
    } catch { /* fall through to schtasks /end */ }
  }

  async isInstalled(label: string): Promise<boolean> {
    const { exitCode } = await this.runner.run(['/query', '/tn', label]);
    return exitCode === 0;
  }

  async install(spec: ServiceSpec, _opts: InstallOptions = {}): Promise<InstallResult> {
    const scriptPath = this.scriptPath(spec.label);
    const rendered = renderWindowsServiceScript(spec);
    let existing: string | null = null;
    try { existing = fs.readFileSync(scriptPath, 'utf-8'); } catch { /* ENOENT */ }
    const taskExists = await this.isInstalled(spec.label);
    if (existing === rendered && taskExists) {
      return { changed: false, supervisorReloaded: false };
    }

    fs.mkdirSync(this.scriptDir, { recursive: true });
    fs.mkdirSync(path.dirname(spec.stdoutPath), { recursive: true });
    fs.mkdirSync(path.dirname(spec.stderrPath), { recursive: true });
    atomicWriteFileSync(scriptPath, rendered);

    // `/sc onlogon` starts the daemon at user logon (RunAtLoad); `/f`
    // overwrites an existing task; `/rl limited` runs with the user's normal
    // (non-elevated) rights. A non-RunAtLoad spec gets an on-demand task with
    // no automatic trigger.
    const trigger = spec.runAtLoad ? ['/sc', 'onlogon'] : ['/sc', 'once', '/st', '00:00', '/sd', '01/01/2099'];
    // Quote the /tr action: Task Scheduler re-parses the stored action string and
    // splits an unquoted path at the first space, so a default script dir under a
    // spaced user profile (`C:\Users\First Last\.myco\service\…cmd`) would fail to
    // launch at logon. The embedded quotes are part of the argv value (the runner
    // spawns schtasks without a shell), which is how schtasks delimits a spaced
    // executable path.
    const result = await this.runner.run(['/create', '/tn', spec.label, '/tr', `"${scriptPath}"`, ...trigger, '/rl', 'limited', '/f']);
    if (result.exitCode !== 0) {
      throw new Error(`schtasks /create /tn ${spec.label} failed (exit ${result.exitCode}): ${result.stdout.trim()}`);
    }
    return { changed: true, supervisorReloaded: true };
  }

  async uninstall(label: string): Promise<void> {
    await this.runner.run(['/end', '/tn', label]);
    await this.runner.run(['/delete', '/tn', label, '/f']);
    const scriptPath = this.scriptPath(label);
    if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
  }

  async start(label: string): Promise<void> {
    await this.runner.run(['/run', '/tn', label]);
  }

  async stop(label: string): Promise<void> {
    await this.drainBeforeEnd(label);
    await this.runner.run(['/end', '/tn', label]);
  }

  async restart(label: string): Promise<void> {
    await this.drainBeforeEnd(label);
    await this.runner.run(['/end', '/tn', label]);
    const result = await this.runner.run(['/run', '/tn', label]);
    if (result.exitCode !== 0) {
      throw new Error(`schtasks /run /tn ${label} failed (exit ${result.exitCode}): ${result.stdout.trim()}`);
    }
  }

  restartShellCommand(label: string): string {
    // Literal command the detached update / restart script invokes after the
    // daemon exits — re-triggers the task to bring the daemon back. Mirrors
    // the systemd/launchd restart primitives.
    return `schtasks /run /tn "${label}"`;
  }

  isManagedDaemon(label: string, _status: ServiceStatus, _myPid: number): boolean {
    // schtasks exposes no action PID (status.pid is always null), so the
    // launchd/systemd pid-match can't work. The launcher .cmd exports
    // MYCO_SERVICE_MANAGED=<label> (renderWindowsServiceScript); trust it.
    return process.env.MYCO_SERVICE_MANAGED === label;
  }

  async status(label: string): Promise<ServiceStatus> {
    const { stdout, exitCode } = await this.runner.run(['/query', '/tn', label, '/fo', 'LIST', '/v']);
    if (exitCode !== 0) {
      return { installed: false, running: false, pid: null, lastExitCode: null, unitPath: null };
    }
    const statusMatch = stdout.match(/Status:\s*(\S+)/i);
    const lastResultMatch = stdout.match(/Last Result:\s*(-?\d+)/i);
    const scriptPath = this.scriptPath(label);
    return {
      installed: true,
      running: statusMatch ? /running/i.test(statusMatch[1]) : false,
      // schtasks does not expose the action process's PID; the daemon's PID is
      // discoverable via daemon.json / the lifecycle-lock holder record.
      pid: null,
      lastExitCode: normalizeLastResult(lastResultMatch ? parseInt(lastResultMatch[1], 10) : null),
      unitPath: fs.existsSync(scriptPath) ? scriptPath : null,
    };
  }
}

/**
 * "Last Result" in schtasks is the last run's process exit code — EXCEPT while
 * the scheduler is mid-cycle, when it returns an informational SCHED_S_* HRESULT
 * (e.g. 0x41301 SCHED_S_TASK_RUNNING) that is not a process exit code at all.
 * Surfacing those as `lastExitCode` reads as a six-digit failure; map them to
 * null so callers see "no completed-run exit code yet". `running` is the
 * authoritative liveness signal.
 */
const SCHED_S_SENTINELS = new Set<number>([
  0x0004_1300, // SCHED_S_TASK_READY        (267008) — ready, not running
  0x0004_1301, // SCHED_S_TASK_RUNNING      (267009) — currently running
  0x0004_1302, // SCHED_S_TASK_DISABLED     (267010)
  0x0004_1303, // SCHED_S_TASK_HAS_NOT_RUN  (267011) — never run
]);

function normalizeLastResult(code: number | null): number | null {
  if (code === null) return null;
  return SCHED_S_SENTINELS.has(code) ? null : code;
}
