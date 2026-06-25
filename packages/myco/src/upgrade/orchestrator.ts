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
 * Two paths are supported:
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
  UPDATE_EVENTS_PATH,
  UPDATE_SCRIPT_DELAY_SECONDS,
} from '../constants/update.js';
import { getServiceManager } from '../service/manager.js';
import { clearJsonSentinel } from '../utils/json-sentinel.js';
import { resolveServiceDaemonStatePath } from '../grove/paths.js';
import { appendUpdateEvent, type UpdateEventLevel } from './update-events.js';
import type { ServiceManager } from '../service/types.js';

// ---------------------------------------------------------------------------
// Params (written by update-installer.ts, read here)
// ---------------------------------------------------------------------------

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
  /** Adopt-event side-channel path. Defaults to UPDATE_EVENTS_PATH; overridable
   *  for hermetic tests (the default is machine-global, not MYCO_HOME-scoped). */
  updateEventsPath?: string;
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
  /** Read the daemon's recorded version from daemon.json, gated on a live pid;
   *  null when absent/stale. The probe-independent second health signal. */
  probeDaemonState: (home: string) => { version?: string } | null;
  /** Sleep helper (overridable so tests don't actually wait). */
  sleep: (ms: number) => Promise<void>;
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
 * How many times `runAdopt` restarts onto the new binary and re-watches health
 * before restoring the previous version. >1 so a single transient failure (a
 * respawn racing the restart) converges instead of immediately rolling back —
 * the convergence the manual one-shot apply needs and the idle auto-adopt
 * previously provided only via its next-tick retry. Kept small so a genuinely
 * broken binary still rolls back promptly.
 */
const ADOPT_RESTART_ATTEMPTS = 2;

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

/** Probe /health; returns the parsed body or null. `Connection: close` forces a
 *  FRESH connection every probe so a pooled/keep-alive socket left dead by the
 *  daemon's restart can never poison the whole health-watch. */
async function probeHealth(daemonPort: number): Promise<{ version?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/health`, {
      signal: controller.signal,
      headers: { connection: 'close' },
    });
    if (!res.ok) return null;
    return (await res.json()) as { version?: string };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const HEALTH_PROBE_TIMEOUT_MS = 4000;

/**
 * Cross-check the daemon's OWN recorded state: the version it wrote to
 * `<home>/service/daemon.json` on startup, gated on that pid being alive. This
 * is a file read + process-liveness check — immune to the HTTP-probe flakiness
 * that would otherwise roll back a demonstrably-healthy adopt. The health-watch
 * succeeds when EITHER /health OR this agrees the target is live, so a single
 * fragile signal can no longer fail a good update.
 */
function probeDaemonState(home: string): { version?: string } | null {
  try {
    const raw = fs.readFileSync(resolveServiceDaemonStatePath(home), 'utf-8');
    const d = JSON.parse(raw) as { version?: string; pid?: number };
    if (!d.version || typeof d.pid !== 'number') return null;
    try { process.kill(d.pid, 0); } catch { return null; } // pid not alive → stale record
    return { version: d.version };
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: ApplyUpdateDeps = {
  getServiceManager,
  runNpm,
  spawnDetached,
  runFanout,
  probeHealth,
  probeDaemonState,
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

async function runUpdate(p: ApplyUpdateParams, deps: ApplyUpdateDeps): Promise<void> {
  await deps.sleep(UPDATE_SCRIPT_DELAY_SECONDS * 1000);

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

interface HealthWatchResult {
  healthy: boolean;
  /** Last version EITHER signal reported (null = never reachable in the window).
   *  The adopt-failure discriminator: a window stuck on the OLD version means the
   *  restart never brought up the target; null means the daemon stayed down. */
  lastSeenVersion: string | null;
  /** Which signal confirmed the target — for the narration. */
  via: 'health' | 'daemon-state' | null;
}

/**
 * Watch for `targetVersion` up to `maxHealthAttempts` times using TWO
 * independent signals each poll: the HTTP /health probe AND the daemon's own
 * `daemon.json` record (version + live pid). Either confirming the target is
 * success — so a flaky HTTP probe can no longer roll back a daemon that is
 * demonstrably running the new version. Reports the last version seen + which
 * signal won so the caller can narrate WHY a watch failed.
 */
async function pollHealthForAdopt(
  deps: ApplyUpdateDeps,
  daemonPort: number,
  targetVersion: string,
  maxHealthAttempts: number,
  healthIntervalMs: number,
  home: string,
): Promise<HealthWatchResult> {
  let lastSeenVersion: string | null = null;
  for (let i = 0; i < maxHealthAttempts; i += 1) {
    if (i > 0) await deps.sleep(healthIntervalMs);
    // Signal 1: HTTP /health (fresh connection per probe).
    try {
      const body = await deps.probeHealth(daemonPort);
      if (body) {
        lastSeenVersion = body.version ?? lastSeenVersion;
        if (body.version === targetVersion) return { healthy: true, lastSeenVersion, via: 'health' };
      }
    } catch {
      /* probe failure → fall through to the file signal */
    }
    // Signal 2: daemon.json (version + live pid). Probe-independent.
    const state = deps.probeDaemonState(home);
    if (state) {
      lastSeenVersion = state.version ?? lastSeenVersion;
      if (state.version === targetVersion) return { healthy: true, lastSeenVersion, via: 'daemon-state' };
    }
  }
  return { healthy: false, lastSeenVersion, via: null };
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

  // Observability side-channel — the daemon replays these into log_entries on
  // its next startup (see update-events.ts). Path is injectable for hermetic tests.
  const eventsPath = p.updateEventsPath ?? UPDATE_EVENTS_PATH;
  const event = (level: UpdateEventLevel, message: string, data?: Record<string, unknown>): void =>
    appendUpdateEvent(eventsPath, level, message, data);

  event('info', 'adopt started', {
    from: p.prevVersion, to: p.targetVersion, platform: p.platform,
    daemon_port: p.daemonPort, service_managed_label: p.serviceManagedLabel ?? null,
  });

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
  event('info', stopConfirmed ? 'cooperative stop confirmed' : 'cooperative stop NOT confirmed', {
    daemon_port: p.daemonPort,
  });

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
    try {
      await restart(deps, p.serviceManagedLabel, p.mycoBinary, p.projectRoot);
    } catch { /* last-resort: binary already good/restored and sentinel already cleared; swallow */ }
    return;
  }

  // --- Step 4+5: restart onto the new binary, then confirm it reaches the
  // target version — RETRIED a bounded number of times before restoring.
  // Past this point the daemon MUST come back. Wrap in try/catch so an
  // unexpected throw (e.g. a deps bug) still ends in a final restart attempt.
  try {
    // A single restart can fail to "take" transiently (a respawn racing the
    // restart during the shutdown window, the supervisor not yet re-adopting).
    // Retrying the restart+health-watch makes BOTH entry points converge through
    // this one shared path: the manual one-shot apply now lands reliably instead
    // of relying on the idle auto-adopt's next-tick retry to eventually fix it.
    // The binary was already copied in Step 3, so each retry only re-restarts —
    // never re-copies. A genuinely broken binary that never reaches the target
    // version exhausts the attempts and falls through to the restore below.
    let healthy = false;
    for (let attempt = 1; attempt <= ADOPT_RESTART_ATTEMPTS; attempt += 1) {
      event('info', 'restart onto target', {
        attempt, of: ADOPT_RESTART_ATTEMPTS, target: p.targetVersion,
        service_managed_label: p.serviceManagedLabel ?? null,
      });
      await restart(deps, p.serviceManagedLabel, p.mycoBinary, p.projectRoot);
      const watch = await pollHealthForAdopt(
        deps,
        p.daemonPort,
        p.targetVersion,
        p.maxHealthAttempts,
        p.healthIntervalMs,
        p.home,
      );
      healthy = watch.healthy;
      event(healthy ? 'info' : 'warn', healthy ? 'target healthy' : 'health-watch did not reach target', {
        attempt, of: ADOPT_RESTART_ATTEMPTS, target: p.targetVersion,
        last_seen_version: watch.lastSeenVersion, // OLD version = restart never took; null = daemon stayed down
        via: watch.via, // 'health' = HTTP probe, 'daemon-state' = daemon.json cross-check
        health_polls: p.maxHealthAttempts, poll_interval_ms: p.healthIntervalMs,
      });
      if (healthy || attempt === ADOPT_RESTART_ATTEMPTS) break;
    }

    if (healthy) {
      event('info', 'adopt succeeded', { version: p.targetVersion, from: p.prevVersion });
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
      `new binary ${p.targetVersion} failed to become healthy after ${ADOPT_RESTART_ATTEMPTS} restart attempts `
      + `(${p.maxHealthAttempts} health polls each) — rollback to ${p.prevVersion} applied`,
    );
    event('error', 'rollback applied', {
      target: p.targetVersion, restored: p.prevVersion, restart_attempts: ADOPT_RESTART_ATTEMPTS,
    });
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
