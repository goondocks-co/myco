import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { renderSystemdUnit } from './systemd-unit.js';
import { spawnCombinedOutput, assertRunSucceeded } from './run-command.js';
import { SERVICE_UNIT_DIR_ENV } from './paths.js';
import type {
  InstallOptions,
  InstallResult,
  InstalledServiceCommand,
  ServiceManager,
  ServiceSpec,
  ServiceStatus,
} from './types.js';

export interface SystemctlRunner {
  run(args: string[]): Promise<{ stdout: string; exitCode: number }>;
}

/**
 * Real systemctl shell-out. Gated on `MYCO_LAUNCH_AGENTS_DIR` (set by every
 * sandboxed install / test harness): same structural concern as launchd —
 * a sandboxed install must never touch the user's real `systemd --user`
 * registry, or `daemon-reload` + `enable` would leave persistent units the
 * test cleanup can't reach. Tests that need to observe systemctl argv inject
 * a `SystemctlRunner` stub via `SystemdManagerOptions.runner`.
 */
export class RealSystemctlRunner implements SystemctlRunner {
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    if (process.env[SERVICE_UNIT_DIR_ENV]?.trim()) {
      return {
        stdout: `[sandbox] skipped systemctl ${args.join(' ')}`,
        exitCode: args.includes('show') ? 1 : 0,
      };
    }
    return spawnCombinedOutput('systemctl', args);
  }
}

export interface SystemdManagerOptions {
  runner?: SystemctlRunner;
  /** `~/.config/systemd/user` by default. */
  unitDir?: string;
  /** Wait between systemd teardown observations. */
  sleep?: (delayMs: number) => Promise<void>;
}

const SYSTEMD_TEARDOWN_TIMEOUT_MS = 10_000;
const SYSTEMD_TEARDOWN_POLL_INTERVAL_MS = 100;

export class SystemdUserServiceManager implements ServiceManager {
  readonly supported = true;
  readonly platformName = 'systemd --user';
  private readonly runner: SystemctlRunner;
  readonly unitDir: string;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(opts: SystemdManagerOptions = {}) {
    this.runner = opts.runner ?? new RealSystemctlRunner();
    this.unitDir = opts.unitDir ?? path.join(os.homedir(), '.config', 'systemd', 'user');
    this.sleep = opts.sleep ?? sleep;
  }

  private unitPath(label: string): string {
    return path.join(this.unitDir, `${label}.service`);
  }

  async isInstalled(label: string): Promise<boolean> {
    return fs.existsSync(this.unitPath(label));
  }

  async inspect(label: string): Promise<InstalledServiceCommand | null> {
    const unitPath = this.unitPath(label);
    const metadata = await this.runner.run([
      '--user', 'show', `${label}.service`,
      '--property=FragmentPath',
      '--property=DropInPaths',
    ]);
    if (metadata.exitCode !== 0) return null;
    const fragmentPath = parseSingleSystemdProperty(metadata.stdout, 'FragmentPath');
    const dropInPaths = parseSingleSystemdProperty(metadata.stdout, 'DropInPaths');
    if (fragmentPath !== unitPath || dropInPaths !== '') return null;

    let unit: string;
    try {
      unit = fs.readFileSync(unitPath, 'utf-8');
    } catch {
      return null;
    }
    return parseSystemdCommand(unit);
  }

  async install(spec: ServiceSpec, _opts: InstallOptions = {}): Promise<InstallResult> {
    const unitPath = this.unitPath(spec.label);
    const rendered = renderSystemdUnit(spec);
    let existing: string | null = null;
    try { existing = fs.readFileSync(unitPath, 'utf-8'); } catch { /* ENOENT */ }
    if (existing === rendered) {
      return { changed: false, supervisorReloaded: false };
    }

    fs.mkdirSync(this.unitDir, { recursive: true });
    fs.mkdirSync(path.dirname(spec.stdoutPath), { recursive: true });
    fs.mkdirSync(path.dirname(spec.stderrPath), { recursive: true });
    atomicWriteFileSync(unitPath, rendered);

    // `daemon-reload` only re-reads unit files; it doesn't restart
    // running services. Always safe to call regardless of `opts.force`.
    assertRunSucceeded(await this.runner.run(['--user', 'daemon-reload']), 'systemctl --user daemon-reload');
    assertRunSucceeded(
      await this.runner.run(['--user', 'enable', `${spec.label}.service`]),
      `systemctl --user enable ${spec.label}.service`,
    );
    return { changed: true, supervisorReloaded: true };
  }

  async uninstall(label: string): Promise<void> {
    const unitPath = this.unitPath(label);
    const unit = `${label}.service`;
    const loaded = await this.queryTeardownState(unit);
    if (loaded === null && !fs.existsSync(unitPath)) return;

    if (loaded !== null) {
      assertRunSucceeded(
        await this.runner.run(['--user', 'stop', unit]),
        `systemctl --user stop ${unit}`,
      );
      await this.waitUntilStopped(unit);
    }
    assertRunSucceeded(
      await this.runner.run(['--user', 'disable', unit]),
      `systemctl --user disable ${unit}`,
    );
    if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath);
    assertRunSucceeded(
      await this.runner.run(['--user', 'daemon-reload']),
      'systemctl --user daemon-reload',
    );
  }

  async start(label: string): Promise<void> {
    assertRunSucceeded(
      await this.runner.run(['--user', 'start', `${label}.service`]),
      `systemctl --user start ${label}.service`,
    );
  }

  async stop(label: string): Promise<void> {
    await this.runner.run(['--user', 'stop', `${label}.service`]);
  }

  async restart(label: string): Promise<void> {
    const unit = `${label}.service`;
    assertRunSucceeded(await this.runner.run(['--user', 'restart', unit]), `systemctl --user restart ${unit}`);
  }

  restartShellCommand(label: string): string {
    // Literal command the detached update / restart script invokes after the
    // daemon exits. Mirrors restart() above so systemd's Restart=on-failure
    // cannot race a manually-spawned daemon child for the canonical port.
    return `systemctl --user restart ${label}.service`;
  }

  async status(label: string): Promise<ServiceStatus> {
    const unitPath = this.unitPath(label);
    const installed = fs.existsSync(unitPath);
    const { stdout, exitCode } = await this.runner.run([
      '--user', 'show', `${label}.service`,
      '--property=MainPID',
      '--property=ExecMainStatus',
    ]);
    if (exitCode !== 0) {
      return {
        installed,
        running: false,
        pid: null,
        lastExitCode: null,
        unitPath: installed ? unitPath : null,
      };
    }
    const pidMatch = stdout.match(/MainPID=(\d+)/);
    const exitMatch = stdout.match(/ExecMainStatus=(-?\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : 0;
    return {
      installed,
      running: pid > 0,
      pid: pid > 0 ? pid : null,
      lastExitCode: exitMatch ? parseInt(exitMatch[1], 10) : null,
      unitPath: installed ? unitPath : null,
    };
  }

  private async queryTeardownState(
    unit: string,
  ): Promise<{ mainPid: number; activeState: string } | null> {
    const result = await this.runner.run([
      '--user', 'show', unit,
      '--property=MainPID',
      '--property=ActiveState',
    ]);
    const { stdout, exitCode } = result;
    if (exitCode !== 0) {
      if (isSystemdUnitAbsent(stdout)) return null;
      assertRunSucceeded(result, `systemctl --user show ${unit}`);
    }
    const pidText = parseSingleSystemdProperty(stdout, 'MainPID');
    if (pidText === undefined || !/^\d+$/.test(pidText)) {
      throw new Error(`Missing or invalid MainPID for systemd service ${unit}`);
    }
    const activeState = parseSingleSystemdProperty(stdout, 'ActiveState');
    if (activeState === undefined || activeState === '') {
      throw new Error(`Missing or invalid ActiveState for systemd service ${unit}`);
    }
    return {
      mainPid: parseInt(pidText, 10),
      activeState,
    };
  }

  private async waitUntilStopped(unit: string): Promise<void> {
    const maxPolls = Math.ceil(SYSTEMD_TEARDOWN_TIMEOUT_MS / SYSTEMD_TEARDOWN_POLL_INTERVAL_MS);
    for (let poll = 0; poll <= maxPolls; poll++) {
      const state = await this.queryTeardownState(unit);
      if (state === null || (state.mainPid === 0 && state.activeState === 'inactive')) return;
      if (poll < maxPolls) await this.sleep(SYSTEMD_TEARDOWN_POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for systemd service ${unit} to stop`);
  }
}

function parseSystemdCommand(unit: string): InstalledServiceCommand | null {
  const serviceSections = [...unit.matchAll(/^\[Service\]\s*$/gm)];
  if (serviceSections.length !== 1) return null;
  const sectionStart = serviceSections[0].index! + serviceSections[0][0].length;
  const sectionRemainder = unit.slice(sectionStart);
  const nextSection = sectionRemainder.search(/^\[[^\]]+\]\s*$/m);
  const serviceSection = nextSection === -1
    ? sectionRemainder
    : sectionRemainder.slice(0, nextSection);
  const execStartLines = serviceSection
    .split(/\r?\n/)
    .filter((line) => line.startsWith('ExecStart='));
  if (execStartLines.length !== 1) return null;
  const words = parseSystemdQuotedWords(execStartLines[0].slice('ExecStart='.length));
  if (!words || words.length === 0) return null;
  return { executable: words[0], args: words.slice(1) };
}

function parseSystemdQuotedWords(value: string): string[] | null {
  const words: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (value[index] === ' ') index++;
    if (index === value.length) break;
    if (value[index] !== '"') return null;
    index++;
    let word = '';
    let closed = false;
    while (index < value.length) {
      const char = value[index++];
      if (char === '"') {
        closed = true;
        break;
      }
      if (char === '\\') {
        const escaped = value[index++];
        if (escaped !== '\\' && escaped !== '"') return null;
        word += escaped;
      } else {
        word += char;
      }
    }
    if (!closed || (index < value.length && value[index] !== ' ')) return null;
    words.push(word);
  }
  return words;
}

function isSystemdUnitAbsent(stdout: string): boolean {
  return /^\[sandbox\] skipped systemctl .*show /i.test(stdout)
    || /(?:could not be found|not found|does not exist)/i.test(stdout);
}

function parseSingleSystemdProperty(stdout: string, property: string): string | undefined {
  const prefix = `${property}=`;
  const values = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  return values.length === 1 ? values[0] : undefined;
}
