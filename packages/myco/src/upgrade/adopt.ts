/**
 * Adopt orchestration initiator.
 *
 * `initiateAdopt` drives the adopt path end-to-end from two entry points:
 *
 *   DAEMON PATH  (`source: 'daemon'`):
 *     Spawns the orchestrator detached via `spawnApplyUpgrade`, then POSTs
 *     `/api/shutdown` so the daemon exits and the orchestrator can proceed
 *     without racing the live image. The daemon is responsible for writing the
 *     `update.in-progress` sentinel before calling this.
 *
 *   CLI PATH     (`source: 'cli'`):
 *     On POSIX: orchestrates inline (same process) since the CLI is not the
 *       image being replaced and inode-replace is safe.
 *     On win32: re-execs via `resolveOrchestratorBinary` (a temp copy of the
 *       running exe) so the copy never targets the CLI's own running image.
 *       The temp copy runs the adopt orchestration detached.
 *
 * Operator-npm (myco-team / myco-collective) logic is intentionally absent —
 * the adopt path is ONLY about the staged binary; npm installs are the update
 * path's job.
 */

import fs from 'node:fs';
import os from 'node:os';

import { MYCO_GLOBAL_DIR } from '../constants/update.js';
import { spawnApplyUpgrade } from './spawn.js';
import type { ApplyUpdateDeps, ApplyAdoptParams } from './orchestrator.js';

// Re-export for consumers who need the type without importing orchestrator.
export type { ApplyAdoptParams };

// ---------------------------------------------------------------------------
// Initiate options
// ---------------------------------------------------------------------------

/** Shared fields required for both daemon and CLI initiation. */
interface AdoptBaseOpts {
  /** The version to adopt (must already be staged under `versions/<targetVersion>/`). */
  targetVersion: string;
  /** The previously-running version (rollback target on crash-loop). */
  prevVersion: string;
  /**
   * Myco home directory — always `resolveMycoHome()` on every platform
   * (see ApplyAdoptParams.home; Groves and the schema-gap scan live under
   * this dir, and binary-path helpers apply their own win32 mapping).
   */
  home: string;
  /** Target platform — controls binary-path computation and win32 copy-gate. */
  platform: NodeJS.Platform;
  /** On win32, the real `%LOCALAPPDATA%` value. Ignored on POSIX. */
  localAppData?: string;
  /** Canonical daemon port. */
  daemonPort: number;
  /** Service label or null when not service-managed. */
  serviceManagedLabel?: string | null;
  /** Literal myco binary for the direct-spawn restart fallback. */
  mycoBinary: string;
  /** Project root used as the cwd for a direct-spawn restart. */
  projectRoot: string;
  /** Max /health polls before declaring the new binary a crash-loop. Default 30. */
  maxHealthAttempts?: number;
  /** Delay between /health polls (ms). Default 2000. */
  healthIntervalMs?: number;
  /**
   * Path to the `update.in-progress` sentinel to clear on abort/restore/success.
   * If not provided, no sentinel is managed here.
   */
  inProgressSentinelPath?: string | null;
  /** Versions to retain after a successful adopt. Default 3. */
  keepVersions?: number;
}

export interface InitiateAdoptFromDaemon extends AdoptBaseOpts {
  source: 'daemon';
}

export interface InitiateAdoptFromCli extends AdoptBaseOpts {
  source: 'cli';
  /** Injectable deps — used for testing the inline CLI path. */
  deps?: ApplyUpdateDeps;
}

export type InitiateAdoptOpts = InitiateAdoptFromDaemon | InitiateAdoptFromCli;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAdoptParams(opts: AdoptBaseOpts): ApplyAdoptParams {
  return {
    kind: 'adopt',
    targetVersion: opts.targetVersion,
    prevVersion: opts.prevVersion,
    home: opts.home,
    platform: opts.platform,
    localAppData: opts.localAppData,
    daemonPort: opts.daemonPort,
    serviceManagedLabel: opts.serviceManagedLabel ?? null,
    mycoBinary: opts.mycoBinary,
    projectRoot: opts.projectRoot,
    maxHealthAttempts: opts.maxHealthAttempts ?? 30,
    healthIntervalMs: opts.healthIntervalMs ?? 2000,
    inProgressSentinelPath: opts.inProgressSentinelPath ?? null,
    keepVersions: opts.keepVersions ?? 3,
  };
}

/** Spawn the adopt orchestration detached via a temp-copy on win32. */
function spawnAdoptDetached(params: ApplyAdoptParams): void {
  // Ensure the global myco dir exists before writing any side-channel files.
  fs.mkdirSync(MYCO_GLOBAL_DIR, { recursive: true });
  spawnApplyUpgrade('myco-adopt', params);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initiate the adopt orchestration.
 *
 * DAEMON PATH: spawns the orchestrator detached + requests cooperative shutdown
 * so the daemon can exit cleanly. The orchestrator handles the copy, restart,
 * health-watch, and crash-loop restore.
 *
 * CLI PATH (POSIX): drives `run()` inline (the CLI is not the image being
 * replaced and the inode-replace is safe regardless of running state).
 *
 * CLI PATH (win32): re-execs via `resolveOrchestratorBinary` (a temp copy of
 * the running exe) so the copy never targets the CLI's own running image —
 * then requests cooperative shutdown so the daemon exits before the copy runs.
 */
export async function initiateAdopt(opts: InitiateAdoptOpts): Promise<void> {
  const params = buildAdoptParams(opts);

  if (opts.source === 'daemon') {
    // Spawn the orchestrator BEFORE requesting shutdown so it is already
    // running when the daemon exits and releases locks.
    spawnAdoptDetached(params);
    // Request cooperative shutdown so the daemon drains and exits cleanly.
    // We do NOT await the daemon's exit here — the detached orchestrator will
    // poll /health and handle the stop-confirm gate itself.
    try {
      const { requestCooperativeShutdown } = await import('../service/cooperative-shutdown.js');
      await requestCooperativeShutdown(opts.daemonPort);
    } catch {
      // Best-effort: the orchestrator's cooperative-shutdown gate will handle
      // the case where the daemon is still running.
    }
    return;
  }

  // CLI path
  if (opts.source === 'cli') {
    if (opts.platform === 'win32') {
      // win32: spawn via temp copy of the running exe so the adopt copy never
      // targets the CLI's own running image.
      spawnAdoptDetached(params);
      // Request cooperative shutdown so the daemon stops before the orchestrator
      // tries to copy the binary. Best-effort — the orchestrator's stop-confirm
      // gate will abort safely if the daemon doesn't stop in time.
      try {
        const { requestCooperativeShutdown } = await import('../service/cooperative-shutdown.js');
        await requestCooperativeShutdown(opts.daemonPort);
      } catch { /* best-effort */ }
      return;
    }

    // POSIX: inline orchestration (this process is not the image being replaced).
    // Use the injected deps (if provided) so tests can drive this path fully.
    const { run: runOrchestrator } = await import('./orchestrator.js');
    // Write the params to a temp file so `run()` can parse it (matching the
    // same protocol the detached orchestrator uses).
    const paramsFile = (() => {
      const f = `${os.tmpdir()}/myco-adopt-cli-${Date.now()}.json`;
      fs.writeFileSync(f, JSON.stringify(params), 'utf-8');
      return f;
    })();
    try {
      if (opts.deps) {
        await runOrchestrator([paramsFile], opts.deps);
      } else {
        await runOrchestrator([paramsFile]);
      }
    } finally {
      try { fs.rmSync(paramsFile, { force: true }); } catch { /* best-effort */ }
    }
  }
}
