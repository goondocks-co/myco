import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderSystemdUnit } from './systemd-unit.js';
import type { ServiceManager, ServiceSpec, ServiceStatus } from './types.js';

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

  async install(spec: ServiceSpec): Promise<void> {
    const unitPath = this.unitPath(spec.label);
    const rendered = renderSystemdUnit(spec);
    const existing = fs.existsSync(unitPath) ? fs.readFileSync(unitPath, 'utf-8') : null;
    if (existing === rendered) return;

    fs.mkdirSync(this.unitDir, { recursive: true });
    fs.mkdirSync(path.dirname(spec.stdoutPath), { recursive: true });
    fs.mkdirSync(path.dirname(spec.stderrPath), { recursive: true });
    fs.writeFileSync(unitPath, rendered);

    await this.runner.run(['--user', 'daemon-reload']);
    await this.runner.run(['--user', 'enable', `${spec.label}.service`]);
    await this.runner.run(['--user', 'start', `${spec.label}.service`]);
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
