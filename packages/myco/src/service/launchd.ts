import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderLaunchdPlist } from './launchd-plist.js';
import type { ServiceManager, ServiceSpec, ServiceStatus } from './types.js';

export interface LaunchctlRunner {
  run(args: string[]): Promise<{ stdout: string; exitCode: number }>;
}

class RealLaunchctlRunner implements LaunchctlRunner {
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve) => {
      const child = spawn('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (b) => { stdout += b.toString(); });
      child.stderr.on('data', (b) => { stdout += b.toString(); });
      child.on('close', (code) => resolve({ stdout, exitCode: code ?? 0 }));
    });
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
  private readonly agentsDir: string;
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

  async install(spec: ServiceSpec): Promise<void> {
    const plistPath = this.plistPath(spec.label);
    const rendered = renderLaunchdPlist(spec);

    const existing = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf-8') : null;
    if (existing === rendered) return; // idempotent no-op

    if (existing !== null) {
      // Spec changed — unload the old definition before writing the new one.
      await this.runner.run(['bootout', this.domainTarget(spec.label)]);
    }

    fs.mkdirSync(this.agentsDir, { recursive: true });
    fs.mkdirSync(path.dirname(spec.stdoutPath), { recursive: true });
    fs.mkdirSync(path.dirname(spec.stderrPath), { recursive: true });
    fs.writeFileSync(plistPath, rendered);

    await this.runner.run(['bootstrap', `gui/${this.uid}`, plistPath]);
    await this.runner.run(['enable', this.domainTarget(spec.label)]);
  }

  async uninstall(label: string): Promise<void> {
    const plistPath = this.plistPath(label);
    await this.runner.run(['bootout', this.domainTarget(label)]);
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  }

  async start(label: string): Promise<void> {
    await this.runner.run(['kickstart', '-k', this.domainTarget(label)]);
  }

  async stop(label: string): Promise<void> {
    await this.runner.run(['kill', 'SIGTERM', this.domainTarget(label)]);
  }

  async restart(label: string): Promise<void> {
    // kickstart -k SIGTERMs the running instance then starts it again.
    // Requires the service to be installed (loaded). We don't check first
    // because launchctl returns a clear error if not.
    const result = await this.runner.run(['kickstart', '-k', this.domainTarget(label)]);
    if (result.exitCode !== 0) {
      throw new Error(`launchctl kickstart failed (exit ${result.exitCode}): ${result.stdout.trim()}`);
    }
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
}
