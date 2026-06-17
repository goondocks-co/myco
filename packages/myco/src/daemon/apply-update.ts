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
 * The flow mirrors the old scripts exactly:
 *   1. sleep UPDATE_SCRIPT_DELAY_SECONDS (let the old daemon release its lock)
 *   2. (update only) npm install the managed-runtime and/or global specs
 *   3. fan out `<myco> update --all-projects` (non-fatal)
 *   4. write the error / restart-reason side-channel files
 *   5. readiness guard — skip restart if the daemon is already on target
 *   6. restart via the platform ServiceManager (or a direct daemon spawn)
 *
 * The single overriding invariant: **the daemon must always come back.** Any
 * thrown error still falls through to the restart step.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { UPDATE_ERROR_PATH, UPDATE_SCRIPT_DELAY_SECONDS } from '../constants/update.js';
import { getServiceManager } from '../service/manager.js';
import type { ServiceManager } from '../service/types.js';

// ---------------------------------------------------------------------------
// Params (written by update-installer.ts, read here)
// ---------------------------------------------------------------------------

/** Discriminated union of the two orchestration kinds. */
export interface ApplyUpdateParams {
  kind: 'update';
  /** Fully-qualified npm specs to install globally. */
  packageSpecs: string[];
  /** Optional core Myco spec to install into the managed machine runtime. */
  localRuntimeSpec?: string;
  /** Remove the managed machine runtime after a successful stable apply. */
  removeLocalRuntime?: boolean;
  projectRoot: string;
  vaultDir: string;
  /** Literal myco binary used for the project fan-out and direct respawn. */
  mycoBinary: string;
  /** Service label to restart through, or null when not service-managed. */
  serviceManagedLabel?: string | null;
  daemonPort: number;
  targetVersion: string;
  // Machine-runtime paths, resolved by the daemon before it exits (the
  // orchestrator runs detached and shares the same MYCO_HOME).
  machineRuntimeDir: string;
  machineRuntimeTmpDir: string;
  machineRuntimeCommandPath: string;
  machineRuntimeMyco: string;
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

export type Params = ApplyUpdateParams | ApplyRestartParams;

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

function rmrf(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

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

async function runUpdate(p: ApplyUpdateParams, deps: ApplyUpdateDeps): Promise<void> {
  await deps.sleep(UPDATE_SCRIPT_DELAY_SECONDS * 1000);

  let updateFailed = false;
  let effectiveMycoBinary = p.mycoBinary;
  const failedSpecs = [...p.packageSpecs, p.localRuntimeSpec].filter(Boolean).join(', ');

  // 1. Managed machine runtime install (beta channel), atomic swap.
  if (p.localRuntimeSpec) {
    rmrf(p.machineRuntimeTmpDir);
    // Pass the prefix as a space-free basename resolved against `cwd` (the
    // parent dir), NOT the full `machineRuntimeTmpDir` — a spaced MYCO_HOME
    // would be word-split by the shell npm runs under (see spawnShellSafe).
    const { ok } = await deps.runNpm(
      ['install', '--prefix', path.basename(p.machineRuntimeTmpDir), p.localRuntimeSpec],
      path.dirname(p.machineRuntimeTmpDir),
    );
    if (ok) {
      rmrf(p.machineRuntimeDir);
      let renamed = false;
      try {
        fs.renameSync(p.machineRuntimeTmpDir, p.machineRuntimeDir);
        renamed = true;
      } catch (err) {
        // NOT silent: a failed swap must not leave us pinned to a binary in a
        // directory we just deleted. Log, mark failed, keep the original binary.
        process.stderr.write(`[myco] managed-runtime swap failed: ${String(err)}\n`);
      }
      if (renamed) {
        // Pin + adopt the managed binary only once it actually exists on disk.
        writeFileSafe(p.machineRuntimeCommandPath, `${p.machineRuntimeMyco}\n`);
        effectiveMycoBinary = p.machineRuntimeMyco;
      } else {
        rmrf(p.machineRuntimeTmpDir);
        updateFailed = true;
      }
    } else {
      rmrf(p.machineRuntimeTmpDir);
      updateFailed = true;
    }
  }

  // 2. Global package install.
  if (p.packageSpecs.length > 0 && !updateFailed) {
    const { ok } = await deps.runNpm(['install', '-g', ...p.packageSpecs]);
    if (!ok) updateFailed = true;
  }

  // 3. Remove the managed runtime (reverting beta → global stable).
  if (p.removeLocalRuntime && !updateFailed) {
    rmrf(p.machineRuntimeCommandPath);
    rmrf(p.machineRuntimeDir);
    effectiveMycoBinary = 'myco';
  }

  // 4. Side-channel: fan-out on success, error file on failure.
  if (!updateFailed) {
    const fanoutLog = path.join(path.dirname(UPDATE_ERROR_PATH), 'update-fanout.log');
    await deps.runFanout(effectiveMycoBinary, fanoutLog);
    try { fs.rmSync(UPDATE_ERROR_PATH, { force: true }); } catch { /* best-effort */ }
  } else {
    writeFileSafe(UPDATE_ERROR_PATH, JSON.stringify({ error: `npm install failed for ${failedSpecs}` }));
    effectiveMycoBinary = p.mycoBinary;
  }

  // 5. Readiness guard, then restart.
  if (await shouldSkipRestart(deps, p.daemonPort, p.targetVersion)) return;
  await restart(deps, p.serviceManagedLabel, effectiveMycoBinary, p.projectRoot);
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
