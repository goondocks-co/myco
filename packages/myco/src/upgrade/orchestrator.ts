/**
 * Cross-platform update/restart orchestrator.
 *
 * Invoked as `myco __apply-update <params.json>` from a DETACHED child the
 * daemon spawns just before it exits (see `spawnUpdateScript` /
 * `spawnRestartScript` in update-installer.ts). The orchestration that used
 * to live in generated `#!/bin/sh` scripts now runs here in TypeScript, so it
 * works identically on macOS, Linux, and Windows — there is no `/bin/sh` on
 * Windows, so the old detached shell child ENOENT'd and stranded the daemon.
 *
 * Three paths are supported:
 *
 *   BINARY-SWAP PATH (myco self-update, stable + beta):
 *   1. sleep UPDATE_SCRIPT_DELAY_SECONDS (let the old daemon release its lock)
 *   2. `npm install -g` any operator-CLI specs (myco-team / myco-collective)
 *   3. fan out `<myco> update --all-projects` on the current binary (non-fatal)
 *   4. hand off to `applyBinaryUpdate` (download → verify → swap → restart →
 *      health-watch → auto-restore); it is the SOLE restart owner on this path
 *
 *   OPERATOR-CLI PATH (no myco binary swap — only operator npm packages):
 *   1. sleep UPDATE_SCRIPT_DELAY_SECONDS
 *   2. `npm install -g` the operator specs
 *   3. fan out `<myco> update --all-projects` (non-fatal)
 *   4. write the error / restart-reason side-channel files
 *   5. readiness guard — skip restart if the daemon is already on target
 *   6. restart via the platform ServiceManager (or a direct daemon spawn)
 *
 *   ADOPT PATH (staged-binary adopt — stop-confirmed → copy → restart → watch):
 *   1. sleep UPDATE_SCRIPT_DELAY_SECONDS (let the calling process release locks)
 *   2. request cooperative shutdown; poll /health until port is dark
 *   3a. win32 + stop-not-confirmed → abort (binary untouched, sentinel cleared, no restart needed)
 *   3b. POSIX stop-not-confirmed → proceed (inode-replace is safe against a live image)
 *   4. adoptStaged (copy versionDir binary → managedBinaryPath; THROWS on any failure)
 *   5. restart via ServiceManager or direct spawn
 *   6. health-watch (poll /health for targetVersion)
 *   7a. healthy on target → success; prune old versions; sentinel cleared
 *   7b. crash-loop → restoreVersion(prev) + restart + error side-channel + sentinel cleared
 *
 * The single overriding invariant: **the daemon must always come back.** Any
 * thrown error still falls through to the restart step.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  UPDATE_ERROR_PATH,
  UPDATE_SCRIPT_DELAY_SECONDS,
  BINARY_UPDATE_HEALTH_ATTEMPTS,
  BINARY_UPDATE_HEALTH_INTERVAL_MS,
} from '../constants/update.js';
import { getServiceManager } from '../service/manager.js';
import { clearJsonSentinel } from '../utils/json-sentinel.js';
import type { ServiceManager } from '../service/types.js';

// ---------------------------------------------------------------------------
// Params (written by update-installer.ts, read here)
// ---------------------------------------------------------------------------

/**
 * Already-resolved binary-update references (the daemon resolves the release
 * BEFORE spawning the orchestrator, since the orchestrator runs after the
 * daemon exits). Mirror of `AssetRefs` in release-assets; redeclared here so
 * apply-update has no install-layer import.
 */
export interface MycoBinaryUpdateRefs {
  assetUrl: string;
  sha256sumsUrl: string;
  assetName: string;
  targetVersion: string;
}

/** Discriminated union of the two orchestration kinds. */
export interface ApplyUpdateParams {
  kind: 'update';
  /** Fully-qualified npm specs to install globally (operator CLIs only). */
  packageSpecs: string[];
  projectRoot: string;
  vaultDir: string;
  /** Literal myco binary used for the project fan-out and direct respawn. */
  mycoBinary: string;
  /** Service label to restart through, or null when not service-managed. */
  serviceManagedLabel?: string | null;
  daemonPort: number;
  targetVersion: string;
  /**
   * When present, myco updates by BINARY SWAP through `applyBinaryUpdate` (both
   * stable and beta — and the revert-to-stable downgrade). `applyBinaryUpdate`
   * owns download→verify→myco.prev→swap→restart→health-watch→auto-restore, so it
   * is the SOLE restart owner on this path — runUpdate runs no restart of its
   * own. Operator-CLI specs in `packageSpecs` are STILL `npm install -g`'d.
   *
   * Resolved by the daemon before it spawns the detached orchestrator.
   */
  mycoBinaryUpdate?: MycoBinaryUpdateRefs;
  /** The managed binary to swap (`~/.myco/bin/myco`). Required with mycoBinaryUpdate. */
  managedBinaryPath?: string;
  /** Crash-loop /health poll budget for the binary swap. */
  maxHealthAttempts?: number;
  /** Crash-loop /health poll spacing (ms) for the binary swap. */
  healthIntervalMs?: number;
  /**
   * Absolute path to the `update.in-progress` sentinel the daemon wrote before
   * spawning this orchestrator. Forwarded to `applyBinaryUpdate` so an aborted
   * or rolled-back self-update clears it (the restored daemon comes back on the
   * OLD version, so the daemon-startup target-version clear won't fire).
   */
  inProgressSentinelPath?: string | null;
}

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
  /**
   * The versioned binary to adopt (must already be staged in the versions dir
   * by `stageBinary`). This is the version we expect the daemon to report on
   * /health after the restart succeeds.
   */
  targetVersion: string;
  /**
   * The previously-running version, used as the rollback target on crash-loop.
   * Must have a valid entry under `versions/<prevVersion>/` so `restoreVersion`
   * can copy it back.
   */
  prevVersion: string;
  /** Myco home directory (`~/.myco` on POSIX, `%LOCALAPPDATA%\Myco` on win32). */
  home: string;
  /** Target platform — controls managed-binary path computation + win32 gate. */
  platform: NodeJS.Platform;
  /** On win32, the real `%LOCALAPPDATA%` (for proper path computation). */
  localAppData?: string;
  /** Canonical daemon port for the cooperative-shutdown poll and /health watch. */
  daemonPort: number;
  /** Service label to restart through, or null when not service-managed. */
  serviceManagedLabel?: string | null;
  /** Literal myco binary used for a direct daemon respawn when not service-managed. */
  mycoBinary: string;
  /** Project root used as the cwd for a direct-spawn restart. */
  projectRoot: string;
  /** Max /health polls before declaring the new binary a crash-loop. */
  maxHealthAttempts: number;
  /** Delay between /health polls (ms). */
  healthIntervalMs: number;
  /** Error side-channel path. Defaults to UPDATE_ERROR_PATH; overridable for tests. */
  errorPath?: string;
  /**
   * Absolute path to the `update.in-progress` sentinel. Cleared on every
   * abort/restore exit path so a failed adopt never locks out future updates
   * for the full 10-minute stale window.
   */
  inProgressSentinelPath?: string | null;
  /**
   * Versions to retain after a successful adopt (floored at 2 by `pruneVersions`).
   * Default 3. Pass 0 to disable pruning.
   */
  keepVersions?: number;
}

export type Params = ApplyUpdateParams | ApplyRestartParams | ApplyAdoptParams;

// ---------------------------------------------------------------------------
// Injectable dependencies (real implementations by default; tests override)
// ---------------------------------------------------------------------------

export interface ApplyUpdateDeps {
  /** Resolve the platform ServiceManager. */
  getServiceManager: () => ServiceManager;
  /** Spawn npm with the given args (optionally in `cwd`); resolve with the exit
   *  outcome + output. Every arg MUST be space-free (see `runNpm`). */
  runNpm: (args: string[], cwd?: string) => Promise<{ ok: boolean; output: string }>;
  /** Spawn `<bin> <args>` detached + unref (the direct daemon respawn). */
  spawnDetached: (bin: string, args: string[], cwd?: string) => void;
  /** Run `<bin> update --all-projects`, capturing output to `logPath`. Awaited
   *  but non-fatal — never throws and never blocks the restart. */
  runFanout: (mycoBinary: string, logPath: string) => Promise<void>;
  /** Probe the daemon /health endpoint; null on any failure. */
  probeHealth: (daemonPort: number) => Promise<{ version?: string } | null>;
  /** Sleep helper (overridable so tests don't actually wait). */
  sleep: (ms: number) => Promise<void>;
  /**
   * The single-binary self-update primitive. Optional + injected so tests can
   * assert the binary path without network/fs; production resolves it lazily
   * (a static import would create an apply-update ⇄ apply-binary-update cycle).
   * Typed loosely here to keep the import one-directional.
   */
  applyBinaryUpdate?: (params: Record<string, unknown>) => Promise<void>;
  /**
   * Copy the staged versioned binary onto the managed binary path (atomic
   * temp+rename). ASSUMES the daemon is already stopped. Throws on any
   * fs/chmod failure — the caller must catch and call `restoreVersion`.
   * Optional + injected so tests can assert adopt behavior without real fs ops.
   * Production resolves lazily to avoid a static import cycle.
   */
  adoptStaged?: (params: {
    home: string;
    platform: NodeJS.Platform;
    version: string;
    localAppData?: string;
  }) => Promise<void>;
  /**
   * Copy the versioned binary for `version` back onto the managed binary path.
   * No restart — the caller owns the restart after restore.
   * Optional + injected so tests can assert restore calls without real fs ops.
   */
  restoreVersion?: (
    home: string,
    platform: NodeJS.Platform,
    version: string,
    localAppData?: string,
  ) => Promise<void>;
  /**
   * Request cooperative shutdown: POST /api/shutdown, then poll /health until
   * the port stops answering. Returns true when the daemon exited within the
   * budget. Optional + injected for tests; production uses the real implementation.
   */
  requestCooperativeShutdown?: (port: number) => Promise<boolean>;
  /**
   * Prune old version directories after a successful adopt.
   * Optional + injected for tests. Production resolves lazily.
   */
  pruneVersions?: (
    home: string,
    platform: NodeJS.Platform,
    keep: number,
    current: string,
    previous?: string,
    localAppData?: string,
  ) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spawn `<bin> <args>` cross-platform without letting the shell word-split a
 * spaced binary path.
 *
 * npm is `npm.cmd` and the myco bin is a `.cmd`/`.exe` shim on Windows, so the
 * shell must resolve them (a bare `spawn('npm')` ENOENTs). But `spawn(file,
 * args, { shell:true })` space-JOINS file+args UNQUOTED — a spaced path (a
 * `C:\Users\John Smith\…` profile, a spaced `MYCO_HOME`) is torn into separate
 * tokens. So on Windows we pass a single command string with the binary quoted;
 * `args` are always static space-free literals. POSIX uses `shell:false`, where
 * argv carries spaced paths intact. Callers must keep every `arg` space-free.
 */
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

function runNpm(args: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawnShellSafe('npm', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) });
    child.stdout?.on('data', (d) => { output += String(d); });
    child.stderr?.on('data', (d) => { output += String(d); });
    child.on('error', (err) => { resolve({ ok: false, output: `${output}${err.message}` }); });
    child.on('close', (code) => { resolve({ ok: code === 0, output }); });
  });
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

/**
 * Fan out `<bin> update --all-projects`, capturing combined output to a log so
 * a failure is diagnosable instead of silently discarded. Non-fatal — never
 * throws and never blocks the restart (mirrors the old script's `|| echo …`).
 * Not detached: the orchestrator awaits the sync before it restarts the daemon.
 */
function runFanout(mycoBinary: string, logPath: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawnShellSafe(mycoBinary, ['update', '--all-projects'], { stdio: 'pipe' });
    let out = '';
    child.stdout?.on('data', (d) => { out += String(d); });
    child.stderr?.on('data', (d) => { out += String(d); });
    child.on('error', (err) => {
      writeFileSafe(logPath, `${out}[update] project fan-out failed — ${err.message}\n`);
      resolve();
    });
    child.on('close', (code) => {
      writeFileSafe(logPath, code !== 0 ? `${out}[update] project fan-out failed — exit ${code}\n` : out);
      resolve();
    });
  });
}

/** Probe /health with a ~2s timeout; returns the parsed body or null. */
async function probeHealth(daemonPort: number): Promise<{ version?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as { version?: string };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_DEPS: ApplyUpdateDeps = {
  getServiceManager,
  runNpm,
  spawnDetached,
  runFanout,
  probeHealth,
  sleep,
};

// ---------------------------------------------------------------------------
// Filesystem helpers (cross-platform — no shell)
// ---------------------------------------------------------------------------

export function writeFileSafe(p: string, content: string): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Readiness guard: probe /health; if the daemon already reports the target
 * version, the supervisor (launchd KeepAlive etc.) has already brought it back
 * from the fresh binary — restarting would force a redundant, user-visible
 * kill+respawn through the throttle window. Returns true when restart should be
 * SKIPPED.
 */
async function shouldSkipRestart(
  deps: ApplyUpdateDeps,
  daemonPort: number,
  targetVersion: string,
): Promise<boolean> {
  try {
    const body = await deps.probeHealth(daemonPort);
    if (body && body.version === targetVersion) {
      process.stderr.write(`[myco] daemon already on ${targetVersion} — skipping restart\n`);
      return true;
    }
  } catch { /* probe failure → proceed to restart */ }
  return false;
}

/**
 * Restart step (cross-platform). Prefer the platform ServiceManager so the
 * supervisor owns the lifecycle (no thundering-herd race with KeepAlive). Fall
 * back to a direct detached `<bin> daemon` spawn — both when there is no
 * service AND when the service restart itself throws, so the daemon ALWAYS
 * comes back.
 */
export async function restart(
  deps: ApplyUpdateDeps,
  serviceManagedLabel: string | null | undefined,
  effectiveMycoBinary: string,
  projectRoot: string,
): Promise<void> {
  if (serviceManagedLabel) {
    try {
      await deps.getServiceManager().restart(serviceManagedLabel);
      return;
    } catch (err) {
      process.stderr.write(
        `[myco] service restart failed (${serviceManagedLabel}); falling back to direct spawn: ${String(err)}\n`,
      );
      // fall through to direct spawn
    }
  }
  deps.spawnDetached(effectiveMycoBinary, ['daemon'], projectRoot);
}

/**
 * Resolve the binary-update primitive: the injected fake in tests, or the real
 * one via a lazy dynamic import in production. The dynamic import is what keeps
 * the static graph acyclic (apply-binary-update imports apply-update, not the
 * reverse).
 */
async function resolveApplyBinaryUpdate(
  deps: ApplyUpdateDeps,
): Promise<(params: Record<string, unknown>) => Promise<void>> {
  if (deps.applyBinaryUpdate) return deps.applyBinaryUpdate;
  const mod = await import('./apply-binary.js');
  return mod.applyBinaryUpdate as unknown as (params: Record<string, unknown>) => Promise<void>;
}

/**
 * Myco BINARY self-update path (stable + beta). `applyBinaryUpdate` OWNS the
 * download→verify→myco.prev→swap→restart→health-watch→auto-restore, so it is
 * the SOLE restart owner here — this function never runs a restart of its own
 * (that would race the supervisor and double-restart). Operator-CLI npm specs
 * STILL `npm install -g`; the project fan-out runs on the CURRENT binary (config
 * regen is version-agnostic) BEFORE the swap so the daemon comes back exactly
 * once, on the new binary.
 */
async function runBinaryUpdate(p: ApplyUpdateParams, deps: ApplyUpdateDeps): Promise<void> {
  const refs = p.mycoBinaryUpdate!;

  // Operator CLIs (myco-team / myco-collective) stay on npm. A failure here is
  // recorded but NON-FATAL to the myco self-update — the binary swap below is
  // independent and the daemon must still come back on the new myco binary.
  // Wrapped in try/catch so an unexpected throw (e.g. a broken deps injection)
  // cannot propagate to run()'s outer catch and strand the binary swap.
  if (p.packageSpecs.length > 0) {
    try {
      const { ok } = await deps.runNpm(['install', '-g', ...p.packageSpecs]);
      if (!ok) {
        writeFileSafe(
          UPDATE_ERROR_PATH,
          JSON.stringify({ error: `npm install failed for ${p.packageSpecs.join(', ')}` }),
        );
      }
    } catch (err) {
      process.stderr.write(
        `[myco] operator npm install threw unexpectedly; proceeding to binary swap: ${String(err)}\n`,
      );
      writeFileSafe(
        UPDATE_ERROR_PATH,
        JSON.stringify({ error: `npm install threw: ${String(err)}` }),
      );
    }
  }

  // Fan out the per-project config sync on the still-running (pre-swap) binary.
  // Non-fatal; never blocks the swap. Wrapped in try/catch so an unexpected
  // throw cannot strand the binary swap — applyBinaryUpdate must always run.
  const fanoutLog = path.join(path.dirname(UPDATE_ERROR_PATH), 'update-fanout.log');
  try {
    await deps.runFanout(p.mycoBinary, fanoutLog);
  } catch (err) {
    process.stderr.write(
      `[myco] project fan-out threw unexpectedly; proceeding to binary swap: ${String(err)}\n`,
    );
  }

  // Hand the whole restart lifecycle to the primitive. It is the LAST step and
  // the ONLY restart owner on this path.
  const applyBinaryUpdate = await resolveApplyBinaryUpdate(deps);
  await applyBinaryUpdate({
    assetUrl: refs.assetUrl,
    sha256sumsUrl: refs.sha256sumsUrl,
    assetName: refs.assetName,
    targetVersion: refs.targetVersion,
    binaryPath: p.managedBinaryPath!,
    daemonPort: p.daemonPort,
    serviceManagedLabel: p.serviceManagedLabel ?? null,
    projectRoot: p.projectRoot,
    maxHealthAttempts: p.maxHealthAttempts ?? BINARY_UPDATE_HEALTH_ATTEMPTS,
    healthIntervalMs: p.healthIntervalMs ?? BINARY_UPDATE_HEALTH_INTERVAL_MS,
    inProgressSentinelPath: p.inProgressSentinelPath ?? null,
  });
}

async function runUpdate(p: ApplyUpdateParams, deps: ApplyUpdateDeps): Promise<void> {
  await deps.sleep(UPDATE_SCRIPT_DELAY_SECONDS * 1000);

  // Myco binary self-update (stable + beta, including the revert-to-stable
  // downgrade): the primitive owns the restart.
  if (p.mycoBinaryUpdate && p.managedBinaryPath) {
    await runBinaryUpdate(p, deps);
    return;
  }

  // Operator-CLI-only update (no myco binary swap): `npm install -g` the
  // operator specs, fan out the per-project sync, then restart.
  let updateFailed = false;
  const failedSpecs = p.packageSpecs.join(', ');

  if (p.packageSpecs.length > 0) {
    const { ok } = await deps.runNpm(['install', '-g', ...p.packageSpecs]);
    if (!ok) updateFailed = true;
  }

  // Side-channel: fan-out on success, error file on failure.
  if (!updateFailed) {
    const fanoutLog = path.join(path.dirname(UPDATE_ERROR_PATH), 'update-fanout.log');
    await deps.runFanout(p.mycoBinary, fanoutLog);
    try { fs.rmSync(UPDATE_ERROR_PATH, { force: true }); } catch { /* best-effort */ }
  } else {
    writeFileSafe(UPDATE_ERROR_PATH, JSON.stringify({ error: `npm install failed for ${failedSpecs}` }));
  }

  // Readiness guard, then restart.
  if (await shouldSkipRestart(deps, p.daemonPort, p.targetVersion)) return;
  await restart(deps, p.serviceManagedLabel, p.mycoBinary, p.projectRoot);
}

async function runRestart(p: ApplyRestartParams, deps: ApplyUpdateDeps): Promise<void> {
  await deps.sleep(UPDATE_SCRIPT_DELAY_SECONDS * 1000);

  if (p.runLocalUpdate) {
    const fanoutLog = path.join(path.dirname(p.restartReasonPath), 'update-fanout.log');
    await deps.runFanout(p.mycoBinary, fanoutLog);
  }

  writeFileSafe(
    p.restartReasonPath,
    JSON.stringify({
      reason: 'version_sync',
      from_version: p.fromVersion,
      to_version: p.toVersion,
      local_update_ran: p.runLocalUpdate,
    }),
  );

  if (await shouldSkipRestart(deps, p.daemonPort, p.toVersion)) return;
  await restart(deps, p.serviceManagedLabel, p.mycoBinary, p.projectRoot);
}

// ---------------------------------------------------------------------------
// Lazy-resolve adopt primitives (keeps import graph acyclic)
// ---------------------------------------------------------------------------

async function resolveAdoptStaged(
  deps: ApplyUpdateDeps,
): Promise<(params: { home: string; platform: NodeJS.Platform; version: string; localAppData?: string }) => Promise<void>> {
  if (deps.adoptStaged) return deps.adoptStaged;
  const mod = await import('./apply-binary.js');
  return mod.adoptStaged;
}

async function resolveRestoreVersion(
  deps: ApplyUpdateDeps,
): Promise<(home: string, platform: NodeJS.Platform, version: string, localAppData?: string) => Promise<void>> {
  if (deps.restoreVersion) return deps.restoreVersion;
  const mod = await import('./apply-binary.js');
  return mod.restoreVersion;
}

async function resolveRequestCooperativeShutdown(
  deps: ApplyUpdateDeps,
): Promise<(port: number) => Promise<boolean>> {
  if (deps.requestCooperativeShutdown) return deps.requestCooperativeShutdown;
  const mod = await import('../service/cooperative-shutdown.js');
  return (port: number) => mod.requestCooperativeShutdown(port);
}

async function resolvePruneVersions(
  deps: ApplyUpdateDeps,
): Promise<(home: string, platform: NodeJS.Platform, keep: number, current: string, previous?: string, localAppData?: string) => void> {
  if (deps.pruneVersions) return deps.pruneVersions;
  const mod = await import('./apply-binary.js');
  return mod.pruneVersions;
}

// ---------------------------------------------------------------------------
// Adopt path
// ---------------------------------------------------------------------------

/**
 * Poll /health up to `maxHealthAttempts` times for `targetVersion`.
 * Returns true on success.
 */
async function pollHealthForAdopt(
  deps: ApplyUpdateDeps,
  daemonPort: number,
  targetVersion: string,
  maxHealthAttempts: number,
  healthIntervalMs: number,
): Promise<boolean> {
  for (let i = 0; i < maxHealthAttempts; i += 1) {
    if (i > 0) await deps.sleep(healthIntervalMs);
    try {
      const body = await deps.probeHealth(daemonPort);
      if (body && body.version === targetVersion) return true;
    } catch {
      /* probe failure → not yet healthy */
    }
  }
  return false;
}

/**
 * Adopt orchestration: stop-confirmed → adoptStaged → restart → health-watch →
 * restoreVersion(prev) on crash-loop. Sentinel is ALWAYS cleared before exit.
 *
 * CR-1 lesson: the daemon MUST come back in EVERY scenario — including the
 * non-service path. On stop-not-confirmed/win32 the binary is NEVER touched and
 * no restart is needed (the daemon is still running). On all other exit paths
 * (abort, restore, success) the daemon is restarted explicitly.
 */
async function runAdopt(p: ApplyAdoptParams, deps: ApplyUpdateDeps): Promise<void> {
  await deps.sleep(UPDATE_SCRIPT_DELAY_SECONDS * 1000);

  const errorPath = p.errorPath ?? UPDATE_ERROR_PATH;
  const writeError = (message: string): void => {
    writeFileSafe(errorPath, JSON.stringify({ error: message }));
  };
  const clearSentinel = (): void => {
    if (p.inProgressSentinelPath) {
      try { clearJsonSentinel(p.inProgressSentinelPath); } catch { /* best-effort */ }
    }
  };

  // --- Step 1: cooperative stop ---
  const cooperativeShutdown = await resolveRequestCooperativeShutdown(deps);
  const stopConfirmed = await cooperativeShutdown(p.daemonPort);

  // --- Step 2: cross-platform stop-confirm gate ---
  // win32 invariant: NEVER copy over a live image (Windows locks running .exe
  // files). If the daemon didn't stop, abort safely — binary untouched, sentinel
  // cleared. The daemon is still running so NO restart is needed.
  if (!stopConfirmed && p.platform === 'win32') {
    writeError(
      `adopt aborted: daemon at port ${p.daemonPort} did not stop within the cooperative grace period — binary untouched, no restart needed`,
    );
    clearSentinel();
    // The daemon is still answering — do NOT restart.
    return;
  }

  // POSIX: even if stop-not-confirmed, inode-replace is safe (a running process
  // keeps its old inode). Proceed with the adopt. The daemon might be briefly
  // running on the old inode but the new managed binary path is safe to write.

  // --- Step 3: adoptStaged (THROWS on any fs/chmod failure) ---
  const adoptStagedFn = await resolveAdoptStaged(deps);
  const restoreVersionFn = await resolveRestoreVersion(deps);

  try {
    await adoptStagedFn({
      home: p.home,
      platform: p.platform,
      version: p.targetVersion,
      localAppData: p.localAppData,
    });
  } catch (adoptErr) {
    // adoptStaged threw → managed binary may be untouched or in a bad state.
    // restoreVersion copies the previous version back to be safe, then restart.
    writeError(`adoptStaged failed: ${String(adoptErr)} — restoring previous version ${p.prevVersion}`);
    try {
      await restoreVersionFn(p.home, p.platform, p.prevVersion, p.localAppData);
    } catch (restoreErr) {
      writeError(
        `adoptStaged failed AND restoreVersion also failed: ${String(restoreErr)} — restarting on whatever binary is on disk`,
      );
    }
    clearSentinel();
    await restart(deps, p.serviceManagedLabel, p.mycoBinary, p.projectRoot);
    return;
  }

  // --- Step 4: restart onto the new binary ---
  // Past this point the daemon MUST come back. Wrap in try/catch so an
  // unexpected throw (e.g. a deps bug) still ends in a final restart attempt.
  try {
    await restart(deps, p.serviceManagedLabel, p.mycoBinary, p.projectRoot);

    // --- Step 5: health-watch ---
    const healthy = await pollHealthForAdopt(
      deps,
      p.daemonPort,
      p.targetVersion,
      p.maxHealthAttempts,
      p.healthIntervalMs,
    );

    if (healthy) {
      // Success: prune old versions, clear error, clear sentinel.
      // The daemon-startup clear fires when the new daemon sees targetVersion ==
      // sentinel.targetVersion — but we also clear here so the sentinel is gone
      // even if the daemon's startup-clear path is not reached (e.g. a race).
      try { fs.rmSync(errorPath, { force: true }); } catch { /* best-effort */ }
      clearSentinel();
      const pruneFn = await resolvePruneVersions(deps);
      try {
        const keep = typeof p.keepVersions === 'number' ? p.keepVersions : 3;
        if (keep > 0) {
          pruneFn(p.home, p.platform, keep, p.targetVersion, p.prevVersion, p.localAppData);
        }
      } catch { /* prune failure is non-fatal; never strand on a cleanup step */ }
      return;
    }

    // Crash-loop: new binary never reported the target version. Restore prev +
    // restart again. clearSentinel fires because the restored daemon comes back
    // on the OLD version — the daemon-startup target-version clear won't fire.
    try {
      await restoreVersionFn(p.home, p.platform, p.prevVersion, p.localAppData);
    } catch (restoreErr) {
      writeError(
        `crash-loop restore failed: ${String(restoreErr)} — restarting on current disk binary`,
      );
    }
    writeError(
      `new binary ${p.targetVersion} failed to become healthy after ${p.maxHealthAttempts} attempts — rollback to ${p.prevVersion} applied`,
    );
    clearSentinel();
    await restart(deps, p.serviceManagedLabel, p.mycoBinary, p.projectRoot);
  } catch (err) {
    // Last resort: record the failure and attempt one final restart.
    writeError(`adopt orchestration post-copy recovery failed: ${String(err)}`);
    clearSentinel();
    try {
      await restart(deps, p.serviceManagedLabel, p.mycoBinary, p.projectRoot);
    } catch { /* nothing more we can do */ }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the orchestration described by the params JSON at `argv[0]`.
 *
 * Robustness contract: any unexpected failure still attempts a restart so the
 * daemon is never stranded. Exported `deps` injection is test-only; production
 * callers pass `argv` and get the real implementations.
 */
export async function run(argv: string[], deps: ApplyUpdateDeps = DEFAULT_DEPS): Promise<void> {
  const paramsPath = argv[0];
  let params: Params | null = null;
  try {
    params = JSON.parse(fs.readFileSync(paramsPath, 'utf-8')) as Params;
  } catch (err) {
    writeFileSafe(UPDATE_ERROR_PATH, JSON.stringify({ error: `apply-update could not read params: ${String(err)}` }));
    return; // No params → nothing to restart against; the supervisor (if any) will recover.
  }

  try {
    if (params.kind === 'update') {
      await runUpdate(params, deps);
    } else if (params.kind === 'adopt') {
      await runAdopt(params, deps);
    } else {
      await runRestart(params, deps);
    }
  } catch (err) {
    // Never strand the daemon: record the failure and still attempt a restart
    // with the original binary.
    writeFileSafe(UPDATE_ERROR_PATH, JSON.stringify({ error: `apply-update failed: ${String(err)}` }));
    try {
      await restart(deps, params.serviceManagedLabel, params.mycoBinary, params.projectRoot);
    } catch { /* last-resort: nothing more we can do */ }
  }
}
