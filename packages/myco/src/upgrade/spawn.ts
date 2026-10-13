/** Serialized parameters and process helpers for retained local-runtime callers. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { RESTART_REASON_FILENAME } from '../constants/update.js';
export interface ApplyRestartParams {
  kind: 'restart';
  projectRoot: string;
  vaultDir: string;
  runLocalUpdate: boolean;
  fromVersion: string;
  toVersion: string;
  mycoBinary: string;
  serviceManagedLabel?: string | null;
  daemonPort: number;
  restartReasonPath: string;
}

export interface ApplyAdoptParams {
  kind: 'adopt';
  targetVersion: string;
  prevVersion: string;
  home: string;
  platform: NodeJS.Platform;
  localAppData?: string;
  daemonPort: number;
  serviceManagedLabel?: string | null;
  mycoBinary: string;
  projectRoot: string;
  maxHealthAttempts: number;
  healthIntervalMs: number;
  errorPath?: string;
  updateEventsPath?: string;
  inProgressSentinelPath?: string | null;
  keepVersions?: number;
}

export interface RestartParams {
  projectRoot: string;
  vaultDir: string;
  runLocalUpdate: boolean;
  /** The version currently running. */
  fromVersion: string;
  toVersion: string;
  /** Literal myco binary named by the request. */
  mycoBinary: string;
  /** Service label named by the request, or null when not service-managed. */
  serviceManagedLabel?: string | null;
  /** Canonical daemon port named by the request. */
  daemonPort: number;
}

export function resolveOrchestratorBinary(): string {
  if (process.platform !== 'win32') return process.execPath;
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith('myco-apply-') && name.endsWith('.exe')) {
        try { fs.rmSync(path.join(os.tmpdir(), name), { force: true }); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }

  const copyPath = path.join(os.tmpdir(), `myco-apply-${Date.now()}.exe`);
  fs.copyFileSync(process.execPath, copyPath);
  return copyPath;
}

/** Refuse the retired local-runtime updater before writing parameters or starting a process. */
export function spawnApplyUpgrade(_namePrefix: string, _params: ApplyRestartParams | ApplyAdoptParams): never {
  throw new Error('Myco 2.0 cannot run the retired __apply-update command. Use myco update for this machine or myco runner update for a registered runner.');
}

export function spawnRestartScript(params: RestartParams): string {
  const applyParams: ApplyRestartParams = {
    kind: 'restart',
    projectRoot: params.projectRoot,
    vaultDir: params.vaultDir,
    runLocalUpdate: params.runLocalUpdate,
    fromVersion: params.fromVersion,
    toVersion: params.toVersion,
    mycoBinary: params.mycoBinary,
    serviceManagedLabel: params.serviceManagedLabel ?? null,
    daemonPort: params.daemonPort,
    restartReasonPath: path.join(params.vaultDir, RESTART_REASON_FILENAME),
  };
  return spawnApplyUpgrade('myco-restart', applyParams);
}

function spawnShellSafe(
  bin: string,
  args: string[],
  opts: { detached?: boolean; stdio?: 'ignore' | 'pipe'; cwd?: string },
): ReturnType<typeof spawn> {
  const base = { ...opts, windowsHide: true } as const;
  return process.platform === 'win32'
    ? spawn(`"${bin}" ${args.join(' ')}`, { ...base, shell: true })
    : spawn(bin, args, base);
}

export function spawnDetached(bin: string, args: string[], cwd?: string): void {
  const child = spawnShellSafe(bin, args, { detached: true, stdio: 'ignore', ...(cwd ? { cwd } : {}) });
  child.on('error', (err) => {
    try {
      process.stderr.write(`[myco] apply-update spawn failed (${bin}): ${err.message}\n`);
    } catch { /* best-effort */ }
  });
  child.unref();
}
