import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { renderSystemdUnit } from './systemd-unit.js';
import type {
  InstallOptions,
  InstallResult,
  ServiceManager,
  ServiceSpec,
  ServiceStatus,
} from './types.js';

export interface SystemctlRunner {
  run(args: string[]): Promise<{ stdout: string; exitCode: number }>;
}

class RealSystemctlRunner implements SystemctlRunner {
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve) => {
      const child = spawn('systemctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (b) => { stdout += b.toString(); });
      child.stderr.on('data', (b) => { stdout += b.toString(); });
      child.on('close', (code) => resolve({ stdout, exitCode: code ?? 0 }));
    });
  }
}

export interface SystemdManagerOptions {
  runner?: SystemctlRunner;
  /** `~/.config/systemd/user` by default. */
  unitDir?: string;
}

export class SystemdUserServiceManager implements ServiceManager {
  readonly supported = true;
  readonly platformName = 'systemd --user';
  private readonly runner: SystemctlRunner;
  private readonly unitDir: string;

  constructor(opts: SystemdManagerOptions = {}) {
    this.runner = opts.runner ?? new RealSystemctlRunner();
    this.unitDir = opts.unitDir ?? path.join(os.homedir(), '.config', 'systemd', 'user');
  }

  private unitPath(label: string): string {
    return path.join(this.unitDir, `${label}.service`);
  }

  async isInstalled(label: string): Promise<boolean> {
    return fs.existsSync(this.unitPath(label));
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
    await this.runner.run(['--user', 'daemon-reload']);
    await this.runner.run(['--user', 'enable', `${spec.label}.service`]);
    return { changed: true, supervisorReloaded: true };
  }

  async uninstall(label: string): Promise<void> {
    await this.runner.run(['--user', 'stop', `${label}.service`]);
    await this.runner.run(['--user', 'disable', `${label}.service`]);
    const unitPath = this.unitPath(label);
    if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath);
    await this.runner.run(['--user', 'daemon-reload']);
  }

  async start(label: string): Promise<void> {
    await this.runner.run(['--user', 'start', `${label}.service`]);
  }

  async stop(label: string): Promise<void> {
    await this.runner.run(['--user', 'stop', `${label}.service`]);
  }

  async restart(label: string): Promise<void> {
    const unit = `${label}.service`;
    const result = await this.runner.run(['--user', 'restart', unit]);
    if (result.exitCode !== 0) {
      throw new Error(`systemctl --user restart ${unit} failed (exit ${result.exitCode}): ${result.stdout.trim()}`);
    }
  }

  restartShellCommand(label: string): string {
    // Literal command the detached update / restart script invokes after the
    // daemon exits. Mirrors restart() above so systemd's Restart=always cannot
    // race a manually-spawned daemon child for the canonical port.
    return `systemctl --user restart ${label}.service`;
  }

  async status(label: string): Promise<ServiceStatus> {
    const unitPath = this.unitPath(label);
    if (!fs.existsSync(unitPath)) {
      return { installed: false, running: false, pid: null, lastExitCode: null, unitPath: null };
    }
    const { stdout } = await this.runner.run([
      '--user', 'show', `${label}.service`,
      '--property=MainPID',
      '--property=ExecMainStatus',
    ]);
    const pidMatch = stdout.match(/MainPID=(\d+)/);
    const exitMatch = stdout.match(/ExecMainStatus=(-?\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : 0;
    return {
      installed: true,
      running: pid > 0,
      pid: pid > 0 ? pid : null,
      lastExitCode: exitMatch ? parseInt(exitMatch[1], 10) : null,
      unitPath,
    };
  }
}
