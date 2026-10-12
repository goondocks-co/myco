/** Serialized parameters and process helpers for retained local-runtime callers. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { UPDATE_ERROR_PATH, RESTART_REASON_FILENAME } from '../constants/update.js';
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
  fromVersion: string;
  toVersion: string;
  mycoBinary: string;
  serviceManagedLabel?: string | null;
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

export function spawnApplyUpgrade(namePrefix: string, params: ApplyRestartParams | ApplyAdoptParams): string {
  const paramsFile = path.join(os.tmpdir(), `${namePrefix}-${Date.now()}.json`);
  fs.writeFileSync(paramsFile, JSON.stringify(params), 'utf-8');
  const binToRun = resolveOrchestratorBinary();
  const child = spawn(binToRun, ['__apply-update', paramsFile], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => {
    try {
      fs.writeFileSync(UPDATE_ERROR_PATH, `update orchestrator spawn failed: ${err.message}\n`, 'utf-8');
    } catch { /* best-effort */ }
    try {
      process.stderr.write(`[myco] update orchestrator spawn failed: ${err.message}\n`);
    } catch { /* best-effort */ }
  });
  child.unref();
  return paramsFile;
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
