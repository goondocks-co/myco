/**
 * Update installer — writes the orchestration parameters to a temp JSON file
 * and spawns the self-contained binary's `__apply-update` subcommand DETACHED.
 *
 * The orchestration itself (sleep → npm install → project fan-out → readiness
 * guard → restart) lives in cross-platform TypeScript (`apply-update.ts`), NOT
 * in a generated `#!/bin/sh` script. The old shell scripts ENOENT'd on Windows
 * (no `/bin/sh`), so after the daemon SIGTERM'd itself nothing brought it back.
 * Running the binary directly works identically on macOS, Linux, and Windows.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { MYCO_GLOBAL_DIR, UPDATE_ERROR_PATH, RESTART_REASON_FILENAME } from '../constants/update.js';
import {
  resolveMachineRuntimeCommandPath,
  resolveMachineRuntimeDir,
  resolveMachineRuntimeTmpDir,
} from '../grove/paths.js';
import type { ApplyUpdateParams, ApplyRestartParams } from './apply-update.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Parameters required to spawn an update orchestration. */
export interface InstallParams {
  /** Fully-qualified npm package specs to install globally (e.g. ["@goondocks/myco-team@0.11.0"]). */
  packageSpecs: string[];
  /** Optional core Myco package spec to install into the managed machine runtime. */
  localRuntimeSpec?: string;
  /** Remove the managed machine runtime after a successful stable-channel apply. */
  removeLocalRuntime?: boolean;
  /** Absolute path to the project root the daemon was running from (used as cwd for the respawn). */
  projectRoot: string;
  /** Absolute path to the vault directory the daemon was running against (used as cwd for the respawn). */
  vaultDir: string;
  /**
   * Literal myco binary the orchestrator should invoke for the post-install
   * project sync step and the final direct daemon respawn. See
   * `resolveMycoBinary()` in update-checker for how the daemon picks it (dev
   * build CLI entry in dev mode, bare `myco` in prod).
   */
  mycoBinary: string;
  /**
   * Service label to restart through, when this process is the
   * service-managed daemon (launchctl kickstart / systemctl restart /
   * schtasks). When set, the orchestrator restarts via the platform
   * ServiceManager instead of spawning `<mycoBinary> daemon` directly —
   * preventing the thundering-herd race between a manually-spawned daemon
   * child and the supervisor's KeepAlive/Restart policy.
   *
   * Null (or absent) means non-service-managed — the orchestrator respawns the
   * daemon directly. Callers derive this from `detectServiceManagedLabel()`.
   */
  serviceManagedLabel?: string | null;
  /**
   * Canonical daemon port for the variant this update is running against
   * (e.g. 20915 prod, 19344 dev). Used by the readiness guard to skip the
   * restart when the supervisor's KeepAlive has already brought the daemon
   * back at the target version.
   */
  daemonPort: number;
  /**
   * The version we expect the daemon to be running after this update
   * (e.g. "0.27.12"). The readiness probe verifies /health.version matches
   * before skipping the restart.
   */
  targetVersion: string;
}

/** Parameters for a restart-only orchestration (no global npm install). */
export interface RestartParams {
  /** Absolute path to the project root the daemon was running from (used as cwd for the respawn). */
  projectRoot: string;
  /** Absolute path to the vault directory (used to write restart-reason.json). */
  vaultDir: string;
  /** Whether to run `myco update --all-projects` before restarting. */
  runLocalUpdate: boolean;
  /** The version currently running. */
  fromVersion: string;
  /** The version that will be running after restart. */
  toVersion: string;
  /**
   * Literal myco binary the orchestrator should invoke for the optional
   * project sync step and the final direct daemon respawn.
   */
  mycoBinary: string;
  /** Service label to restart through, or null/absent when not service-managed.
   *  See `InstallParams.serviceManagedLabel`. */
  serviceManagedLabel?: string | null;
  /** Canonical daemon port for the readiness guard. See InstallParams. */
  daemonPort: number;
}

// ---------------------------------------------------------------------------
// Detached spawn of the `__apply-update` subcommand
// ---------------------------------------------------------------------------

/**
 * Resolve the binary to spawn the orchestrator with.
 *
 * On Windows, `npm install -g` cannot overwrite a *running* `.exe`, so spawning
 * `process.execPath` directly would lock the global binary the update is trying
 * to replace. We copy the running exe to a temp path (reading a running exe for
 * copy IS allowed on Windows) and spawn the COPY, freeing the global binary.
 *
 * On POSIX, replacing a running binary's file is fine — the process keeps the
 * old inode — so we spawn `process.execPath` directly. This is the ONE
 * legitimate platform branch in the update flow.
 */
function resolveOrchestratorBinary(): string {
  if (process.platform !== 'win32') return process.execPath;
  // Sweep leaked copies from prior updates first: a running .exe can't delete
  // itself, so the orchestrator can never clean up its own copy — the NEXT
  // update does. Best-effort; a copy still in use stays locked and is skipped.
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith('myco-apply-') && name.endsWith('.exe')) {
        try { fs.rmSync(path.join(os.tmpdir(), name), { force: true }); } catch { /* in use / gone */ }
      }
    }
  } catch { /* best-effort */ }
  // Windows binary-lock workaround: copy the running exe to a temp path so the
  // global install is free to be replaced while the orchestrator runs.
  const copyPath = path.join(os.tmpdir(), `myco-apply-${Date.now()}.exe`);
  fs.copyFileSync(process.execPath, copyPath);
  return copyPath;
}

/**
 * Writes the orchestration params to a temp JSON file and spawns
 * `<binary> __apply-update <paramsFile>` detached + unreffed so the daemon can
 * exit immediately. Returns the params file path.
 */
function spawnApplyUpdate(namePrefix: string, params: ApplyUpdateParams | ApplyRestartParams): string {
  const paramsFile = path.join(os.tmpdir(), `${namePrefix}-${Date.now()}.json`);
  fs.writeFileSync(paramsFile, JSON.stringify(params), 'utf-8');

  const binToRun = resolveOrchestratorBinary();
  const child = spawn(binToRun, ['__apply-update', paramsFile], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // A spawn-class failure (EAGAIN/EMFILE under fork pressure, ENOENT) emits
  // 'error' asynchronously; with no listener that's an uncaught exception —
  // process exit. Leave the trace where the update UI already looks for it.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawns the update orchestrator. Returns the params file path.
 */
export function spawnUpdateScript(params: InstallParams): string {
  // Ensure ~/.myco/ exists before writing the error path or checking state.
  fs.mkdirSync(MYCO_GLOBAL_DIR, { recursive: true });

  const machineRuntimeDir = resolveMachineRuntimeDir();
  const applyParams: ApplyUpdateParams = {
    kind: 'update',
    packageSpecs: params.packageSpecs,
    localRuntimeSpec: params.localRuntimeSpec,
    removeLocalRuntime: params.removeLocalRuntime ?? false,
    projectRoot: params.projectRoot,
    vaultDir: params.vaultDir,
    mycoBinary: params.mycoBinary,
    serviceManagedLabel: params.serviceManagedLabel ?? null,
    daemonPort: params.daemonPort,
    targetVersion: params.targetVersion,
    machineRuntimeDir,
    machineRuntimeTmpDir: resolveMachineRuntimeTmpDir(),
    machineRuntimeCommandPath: resolveMachineRuntimeCommandPath(),
    machineRuntimeMyco: path.join(machineRuntimeDir, 'node_modules', '.bin', 'myco'),
  };
  return spawnApplyUpdate('myco-update', applyParams);
}

/**
 * Spawns the restart-only orchestrator. Returns the params file path.
 */
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
  return spawnApplyUpdate('myco-restart', applyParams);
}
