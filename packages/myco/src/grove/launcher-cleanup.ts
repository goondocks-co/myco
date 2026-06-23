/**
 * Retired global launcher cleanup.
 *
 * `~/.myco/launcher.cjs` and `~/.myco/mcp-launcher.cjs` were the node
 * trampolines every symbiont's hook + MCP command invoked. The launcher
 * unification flipped all agent-facing commands to invoke the self-contained
 * myco binary directly, so nothing executes these files anymore. This module
 * deletes any that linger from a previous release.
 *
 * Cleanup runs directly — no `refresh-launchers` intent / daemon-thread
 * serialization. That machinery existed only to avoid racing a hook process
 * mid-exec of the launcher file; now that no hook references it, unlinking a
 * file nothing reads is race-free from any thread.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from './paths.js';
import { guardBySubsystemClaim, SYMBIONT_CONFIG_SUBSYSTEM } from './subsystem-claim.js';

export const GLOBAL_HOOK_LAUNCHER_FILENAME = 'launcher.cjs';
export const GLOBAL_MCP_LAUNCHER_FILENAME = 'mcp-launcher.cjs';
const RETIRED_LAUNCHER_FILENAMES = [GLOBAL_HOOK_LAUNCHER_FILENAME, GLOBAL_MCP_LAUNCHER_FILENAME] as const;

export interface RetiredLauncherReport { removed: string[] }

/** Delete any retired launcher trampolines from a previous release. Idempotent,
 *  best-effort — a missing file is success; a stale file is inert (never executed). */
function removeRetiredGlobalLaunchersImpl(mycoHome = resolveMycoHome()): RetiredLauncherReport {
  const report: RetiredLauncherReport = { removed: [] };
  for (const filename of RETIRED_LAUNCHER_FILENAMES) {
    const target = path.join(mycoHome, filename);
    try {
      if (fs.existsSync(target)) { fs.rmSync(target, { force: true }); report.removed.push(target); }
    } catch { /* inert file; ignore */ }
  }
  return report;
}

/** Cleanup mutates `~/.myco` (machine-global); a non-owner of the symbiont-config
 *  claim defers. Gated once here, not at each caller. */
export const removeRetiredGlobalLaunchers = guardBySubsystemClaim(
  SYMBIONT_CONFIG_SUBSYSTEM,
  removeRetiredGlobalLaunchersImpl,
  (): RetiredLauncherReport => ({ removed: [] }),
);
