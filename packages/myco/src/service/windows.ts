import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { renderWindowsServiceScript } from './windows-task.js';
import { spawnCombinedOutput, assertRunSucceeded } from './run-command.js';
import { SERVICE_UNIT_DIR_ENV } from './paths.js';
import {
  requestCooperativeShutdownResult,
  type CooperativeShutdownResult,
} from './cooperative-shutdown.js';
import {
  resolveServiceDir,
  DAEMON_STATE_FILENAME,
} from '../grove/paths.js';
import { withExternalMcpContainment } from './daemon-termination.js';
import type {
  InstallOptions,
  InstallResult,
  InstalledServiceCommand,
  ServiceManager,
  ServiceSpec,
  ServiceStatus,
} from './types.js';

/**
 * Read the running daemon's loopback port from `daemon.json`. Returns null when
 * the file is absent/unreadable — the caller then skips the cooperative drain
 * and goes straight to `schtasks /end`. The daemon's state dir derives from its
 * home (`<MYCO_HOME>/service/`); this manager only ever drains the daemon in
 * its own home, so the `_label` argument is informational.
 */
function readDaemonPortForLabel(_label: string): number | null {
  try {
    const statePath = path.join(resolveServiceDir(), DAEMON_STATE_FILENAME);
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { port?: number };
    return typeof parsed.port === 'number' ? parsed.port : null;
  } catch {
    return null;
  }
}

export interface SchtasksRunner {
  run(args: string[]): Promise<{ stdout: string; exitCode: number }>;
  queryState(label: string): Promise<TaskSchedulerState>;
}

export type TaskSchedulerState =
  | 'absent'
  | 'unknown'
  | 'disabled'
  | 'queued'
  | 'ready'
  | 'running';

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
      return {
        stdout: `[sandbox] skipped schtasks ${args.join(' ')}`,
        exitCode: args[0] === '/query' ? 1 : 0,
      };
    }
    return spawnCombinedOutput('schtasks', args);
  }

  async queryState(label: string): Promise<TaskSchedulerState> {
    if (process.env[SERVICE_UNIT_DIR_ENV]?.trim()) return 'absent';
    const escapedLabel = label.replace(/'/g, "''");
    const command = [
      'try {',
      `$tasks = @(Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object { $_.TaskName -ceq '${escapedLabel}' })`,
      "if ($tasks.Count -eq 0) { Write-Output '-1' }",
      'elseif ($tasks.Count -eq 1) { Write-Output ([int]$tasks[0].State) }',
      "else { throw 'Multiple exact-name tasks found' }",
      '} catch { Write-Error $_; exit 1 }',
    ].join('\n');
    const result = await this.runPowerShell([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ]);
    assertRunSucceeded(result, `PowerShell Get-ScheduledTask ${label}`);
    const output = result.stdout.trim();
    if (!/^-?\d+$/.test(output)) {
      throw new Error(`Invalid Task Scheduler state for ${label}: ${JSON.stringify(output)}`);
    }
    return taskSchedulerStateFromNumber(parseInt(output, 10), label);
  }

  protected runPowerShell(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    return spawnCombinedOutput('powershell.exe', args);
  }
}

export interface WindowsManagerOptions {
  runner?: SchtasksRunner;
  /** Directory holding the launcher `.cmd` scripts. */
  scriptDir?: string;
  /** Resolve the running daemon's loopback port for a label (reads daemon.json). */
  resolveDaemonPort?: (label: string) => number | null;
  /** Drain the daemon over HTTP before a hard `schtasks /end`. */
  cooperativeShutdown?: (port: number) => Promise<CooperativeShutdownResult>;
  /** Hold external MCP containment across every `/end` and exit confirmation. */
  withExternalMcpContainment?: <T>(continuation: () => Promise<T>) => Promise<T>;
  /** Wait between Task Scheduler teardown observations. */
  sleep?: (delayMs: number) => Promise<void>;
}

const WINDOWS_TEARDOWN_TIMEOUT_MS = 10_000;
const WINDOWS_TEARDOWN_POLL_INTERVAL_MS = 100;
const WINDOWS_TASK_SHELL = 'cmd.exe';

function windowsTaskShellArguments(scriptPath: string): string {
  return `/d /v:off /s /c ""${scriptPath}""`;
}

function windowsTaskRunCommand(scriptPath: string): string {
  return `${WINDOWS_TASK_SHELL} ${windowsTaskShellArguments(scriptPath)}`;
}

function assertNoWindowsPercentExpansion(
  spec: ServiceSpec,
  scriptPath: string,
): void {
  const inputs: Array<[label: string, value: string]> = [
    ['task script path', scriptPath],
    ['executable path', spec.executable],
    ['working directory', spec.workingDir],
    ['stdout path', spec.stdoutPath],
    ['stderr path', spec.stderrPath],
    ...spec.args.map((value, index): [string, string] => [`argument ${index}`, value]),
    ...Object.entries(spec.env).map(
      ([key, value]): [string, string] => [`environment value ${key}`, value],
    ),
  ];
  const unsafe = inputs.find(([, value]) => value.includes('%'));
  if (unsafe) {
    throw new Error(
      `Windows service ${unsafe[0]} contains unsupported percent expansion syntax`,
    );
  }
}

export class ExternalMcpHardKillBlockedError extends Error {
  constructor(options?: ErrorOptions) {
    super('External MCP containment was not confirmed; refusing hard process termination', options);
    this.name = 'ExternalMcpHardKillBlockedError';
  }
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
 * Crash auto-restart (the launchd `KeepAlive` / systemd `Restart=on-failure`
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
  private readonly cooperativeShutdown: (port: number) => Promise<CooperativeShutdownResult>;
  private readonly withExternalMcpContainment: <T>(
    continuation: () => Promise<T>,
  ) => Promise<T>;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(opts: WindowsManagerOptions = {}) {
    this.runner = opts.runner ?? new RealSchtasksRunner();
    this.scriptDir = opts.scriptDir ?? path.join(os.homedir(), '.myco', 'service');
    this.resolveDaemonPort = opts.resolveDaemonPort ?? readDaemonPortForLabel;
    this.cooperativeShutdown = opts.cooperativeShutdown ?? requestCooperativeShutdownResult;
    this.withExternalMcpContainment = opts.withExternalMcpContainment
      ?? withExternalMcpContainment;
    this.sleep = opts.sleep ?? sleep;
  }

  private scriptPath(label: string): string {
    return path.join(this.scriptDir, `${label}.cmd`);
  }

  /**
   * Ask the daemon to drain before the independent containment gate decides
   * whether an uncatchable Task Scheduler termination is safe.
   */
  private async drainBeforeEnd(label: string): Promise<void> {
    const port = this.resolveDaemonPort(label);
    if (port === null) return;
    try {
      await this.cooperativeShutdown(port);
    } catch {
      // The out-of-process containment gate determines hard-kill safety.
    }
  }

  private async hardEnd(
    label: string,
    options: { allowAbsent?: boolean } = {},
  ): Promise<boolean> {
    await this.drainBeforeEnd(label);
    let terminationStarted = false;
    try {
      return await this.withExternalMcpContainment(async () => {
        terminationStarted = true;
        if (options.allowAbsent
          && await this.requireTaskState(label) === 'absent') {
          return false;
        }
        assertRunSucceeded(
          await this.runner.run(['/end', '/tn', label]),
          `schtasks /end /tn ${label}`,
        );
        await this.waitUntilNotRunning(label);
        return true;
      });
    } catch (error) {
      if (terminationStarted) throw error;
      throw new ExternalMcpHardKillBlockedError({ cause: error });
    }
  }

  async isInstalled(label: string): Promise<boolean> {
    return (await this.runner.queryState(label)) !== 'absent';
  }

  async inspect(label: string): Promise<InstalledServiceCommand | null> {
    const scriptPath = this.scriptPath(label);
    let script: string;
    try {
      script = fs.readFileSync(scriptPath, 'utf-8');
    } catch {
      return null;
    }

    const task = await this.runner.run(['/query', '/tn', label, '/xml']);
    if (task.exitCode !== 0) {
      if (await this.runner.queryState(label) === 'absent') return null;
      throw new Error(
        `Task Scheduler task inspection failed for ${label}: `
        + `schtasks /query exited ${task.exitCode}: ${task.stdout}`,
      );
    }
    const taskAction = parseTaskAction(task.stdout);
    if (taskAction?.command.toLowerCase() !== WINDOWS_TASK_SHELL
      || taskAction.arguments !== windowsTaskShellArguments(scriptPath)) {
      return null;
    }
    return parseWindowsLauncherCommand(script);
  }

  async install(spec: ServiceSpec, _opts: InstallOptions = {}): Promise<InstallResult> {
    const scriptPath = this.scriptPath(spec.label);
    assertNoWindowsPercentExpansion(spec, scriptPath);
    const rendered = renderWindowsServiceScript(spec);
    let existing: string | null = null;
    try { existing = fs.readFileSync(scriptPath, 'utf-8'); } catch { /* ENOENT */ }
    const installed = existing === rendered
      ? await this.inspect(spec.label)
      : null;
    if (installed?.executable === spec.executable
      && installed.args.length === spec.args.length
      && installed.args.every((arg, index) => arg === spec.args[index])) {
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
    assertRunSucceeded(
      await this.runner.run([
        '/create',
        '/tn',
        spec.label,
        '/tr',
        windowsTaskRunCommand(scriptPath),
        ...trigger,
        '/rl',
        'limited',
        '/f',
      ]),
      `schtasks /create /tn ${spec.label}`,
    );
    return { changed: true, supervisorReloaded: true };
  }

  async uninstall(label: string): Promise<void> {
    const scriptPath = this.scriptPath(label);
    if (!await this.hardEnd(label, { allowAbsent: true })) {
      if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
      return;
    }

    await this.hardEnd(label);
    assertRunSucceeded(
      await this.runner.run(['/delete', '/tn', label, '/f']),
      `schtasks /delete /tn ${label}`,
    );
    await this.waitUntilDeleted(label);
    if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
  }

  async start(label: string): Promise<void> {
    assertRunSucceeded(await this.runner.run(['/run', '/tn', label]), `schtasks /run /tn ${label}`);
  }

  async stop(label: string): Promise<void> {
    await this.hardEnd(label);
  }

  async restart(label: string): Promise<void> {
    await this.hardEnd(label);
    assertRunSucceeded(await this.runner.run(['/run', '/tn', label]), `schtasks /run /tn ${label}`);
  }

  restartShellCommand(label: string): string {
    // Literal command the detached update / restart script invokes after the
    // daemon exits — re-triggers the task to bring the daemon back. Mirrors
    // the systemd/launchd restart primitives.
    return `schtasks /run /tn "${label}"`;
  }

  async status(label: string): Promise<ServiceStatus> {
    const state = await this.requireTaskState(label);
    if (state === 'absent') {
      return { installed: false, running: false, pid: null, lastExitCode: null, unitPath: null };
    }
    const result = await this.runner.run(['/query', '/tn', label, '/fo', 'LIST', '/v']);
    const lastResultMatch = result.exitCode === 0
      ? result.stdout.match(/Last Result:\s*(-?\d+)/i)
      : null;
    const scriptPath = this.scriptPath(label);
    return {
      installed: true,
      running: state === 'running',
      // schtasks does not expose the action process's PID; the daemon's PID is
      // discoverable via daemon.json / the lifecycle-lock holder record.
      pid: null,
      lastExitCode: normalizeLastResult(lastResultMatch ? parseInt(lastResultMatch[1], 10) : null),
      unitPath: fs.existsSync(scriptPath) ? scriptPath : null,
    };
  }

  private async requireTaskState(label: string): Promise<TaskSchedulerState> {
    const state = await this.runner.queryState(label);
    if (state === 'unknown') {
      throw new Error(`Unknown Task Scheduler state for ${label}`);
    }
    return state;
  }

  private async waitUntilNotRunning(label: string): Promise<void> {
    const maxPolls = Math.ceil(WINDOWS_TEARDOWN_TIMEOUT_MS / WINDOWS_TEARDOWN_POLL_INTERVAL_MS);
    for (let poll = 0; poll <= maxPolls; poll++) {
      const state = await this.requireTaskState(label);
      if (state === 'absent' || state !== 'running') return;
      if (poll < maxPolls) await this.sleep(WINDOWS_TEARDOWN_POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for Task Scheduler task ${label} to exit`);
  }

  private async waitUntilDeleted(label: string): Promise<void> {
    const maxPolls = Math.ceil(WINDOWS_TEARDOWN_TIMEOUT_MS / WINDOWS_TEARDOWN_POLL_INTERVAL_MS);
    for (let poll = 0; poll <= maxPolls; poll++) {
      if ((await this.requireTaskState(label)) === 'absent') return;
      if (poll < maxPolls) await this.sleep(WINDOWS_TEARDOWN_POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for Task Scheduler task ${label} deletion`);
  }
}

function parseTaskAction(
  xml: string,
): { command: string; arguments: string } | null {
  const commands = [...xml.matchAll(/<Command>([\s\S]*?)<\/Command>/gi)];
  const argumentsElements = [...xml.matchAll(/<Arguments>([\s\S]*?)<\/Arguments>/gi)];
  if (commands.length !== 1 || argumentsElements.length !== 1) return null;
  const command = decodeXmlText(commands[0][1]);
  const argumentsValue = decodeXmlText(argumentsElements[0][1]);
  return command === null || argumentsValue === null
    ? null
    : { command, arguments: argumentsValue };
}

function parseWindowsLauncherCommand(script: string): InstalledServiceCommand | null {
  const commands = script
    .split(/\r?\n/)
    .map((line) => line.match(/^"([^"\r\n]+)" ([^"\r\n]*?) >> "[^"\r\n]+" 2>> "[^"\r\n]+"$/))
    .filter((match): match is RegExpMatchArray => match !== null);
  if (commands.length !== 1) return null;
  const argumentText = commands[0][2].trim();
  const args = argumentText === '' ? [] : argumentText.split(' ');
  if (args.some((arg) => arg === '')) return null;
  return { executable: commands[0][1], args };
}

function decodeXmlText(value: string): string | null {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) return null;
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function taskSchedulerStateFromNumber(state: number, label: string): TaskSchedulerState {
  switch (state) {
    case -1: return 'absent';
    case 0: return 'unknown';
    case 1: return 'disabled';
    case 2: return 'queued';
    case 3: return 'ready';
    case 4: return 'running';
    default: throw new Error(`Invalid Task Scheduler state ${state} for ${label}`);
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
