import { parseSystemdCommand } from '@myco/member/unit-parsers.js';
export { parseSystemdCommand } from '@myco/member/unit-parsers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep } from '@myco/utils/sleep.js';
import { spawnCombinedOutput, assertRunSucceeded } from './run-command.js';
import { SERVICE_UNIT_DIR_ENV } from '@myco/paths/service-units.js';


export interface SystemctlRunner {
  run(args: string[]): Promise<{ stdout: string; exitCode: number }>;
}

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
    unitDir?: string;
    sleep?: (delayMs: number) => Promise<void>;
}

const SYSTEMD_TEARDOWN_TIMEOUT_MS = 10_000;
const SYSTEMD_TEARDOWN_POLL_INTERVAL_MS = 100;

export class SystemdUserServiceManager {
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
