export { parsePlistDocument, type PlistValue } from '@myco/member/unit-parsers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep } from '@myco/utils/sleep.js';
import { spawnCombinedOutput, assertRunSucceeded } from './run-command.js';
import { SERVICE_UNIT_DIR_ENV } from '@myco/paths/service-units.js';

export interface LaunchctlRunner {
  run(args: string[]): Promise<{ stdout: string; exitCode: number }>;
}

export class RealLaunchctlRunner implements LaunchctlRunner {
  protected spawn(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    return spawnCombinedOutput('launchctl', args);
  }
  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    if (process.env[SERVICE_UNIT_DIR_ENV]?.trim()) {
      return {
        stdout: `[sandbox] skipped launchctl ${args.join(' ')}`,
        exitCode: args[0] === 'print' ? 1 : 0,
      };
    }
    return this.spawn(args);
  }
}

export interface LaunchdManagerOptions {
  runner?: LaunchctlRunner;
    agentsDir?: string;
    uid?: number;
    sleep?: (delayMs: number) => Promise<void>;
}

const LAUNCHD_TEARDOWN_TIMEOUT_MS = 10_000;
const LAUNCHD_TEARDOWN_POLL_INTERVAL_MS = 100;

export class LaunchdServiceManager {
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

  async uninstall(label: string): Promise<void> {
    const plistPath = this.plistPath(label);
    await this.unloadIfLoaded(label);
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
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
}

function isLaunchdJobAbsent(stdout: string): boolean {
  if (/not privileged|operation not permitted|permission denied/i.test(stdout)) return false;
  return /^\[sandbox\] skipped launchctl print /i.test(stdout)
    || /^Could not print domain: 125: Domain does not support specified action\s*$/i.test(stdout.trim())
    || /(?:could not find|not found|unknown) service/i.test(stdout);
}
