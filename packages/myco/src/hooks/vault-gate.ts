/**
 * Vault gate for hook clients.
 *
 * Every hook script's main() runs the same opening sequence:
 *
 *   const vaultDir = resolveVaultDir();
 *   if (!fs.existsSync(path.join(vaultDir, 'myco.yaml'))) return;
 *
 * Under the global-install model (plan 38cff0752c919ffd §6), that
 * early-return becomes the auto-provision trigger: when a hook event
 * arrives in a git-tracked project that hasn't been registered yet,
 * Myco creates the minimal `.myco/` scaffolding on the spot and lets
 * the capture flow continue. Non-git directories (a user's home dir,
 * `/tmp`, etc.) still bail silently — capture is git-project-scoped
 * by design.
 *
 * This module owns the gate logic so the 13+ hook scripts stay
 * uniform and a future change (e.g., tightening the git-gate or
 * adding a sentinel re-check) lands in one place.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveVaultDir, resolveProjectRoot, isSafeProjectRoot } from '../vault/resolve.js';
import { ensureProjectVault } from '../vault/provision.js';
import {
  hasGlobalInstallMigrationCompleted,
  migrateProjectToGlobalInstall,
} from '../grove/global-install-migration.js';
import { projectLifecycleForRoot } from '../grove/registry.js';
import { isProjectRootIgnored, agentHomeIgnorePaths } from '../vault/capture-ignore.js';
import { loadMachineConfig } from '../config/loader.js';

const lifecycleMemo = new Map<string, 'active' | 'archived' | 'unregistered'>();

function lifecycleForRootMemo(projectRoot: string): 'active' | 'archived' | 'unregistered' {
  const key = path.resolve(projectRoot);
  const cached = lifecycleMemo.get(key);
  if (cached) return cached;
  // Hook processes are short-lived, so process-lifetime memoization avoids
  // duplicate Grove registry reads without creating meaningful stale state.
  const lifecycle = projectLifecycleForRoot(projectRoot);
  lifecycleMemo.set(key, lifecycle);
  return lifecycle;
}

function isCaptureGateClosed(projectRoot: string): boolean {
  try {
    const machine = loadMachineConfig();
    if (isProjectRootIgnored(projectRoot, machine.capture.ignore, agentHomeIgnorePaths())) {
      if (process.env.MYCO_AGENT_DEBUG) {
        process.stderr.write(`[myco] capture skipped (ignored-root) root=${projectRoot}\n`);
      }
      return true;
    }
  } catch {
    if (isProjectRootIgnored(projectRoot, { paths: [], patterns: [] }, agentHomeIgnorePaths())) return true;
  }

  if (lifecycleForRootMemo(projectRoot) === 'archived') {
    if (process.env.MYCO_AGENT_DEBUG) {
      process.stderr.write(`[myco] capture skipped (archived-root) root=${projectRoot}\n`);
    }
    return true;
  }
  return false;
}

/**
 * Resolve the project's vault dir, provisioning it if absent. Returns:
 *
 *   - The vault dir path when the project has (or just got) a vault.
 *   - `null` when the hook should silently bail: the project isn't a
 *     safe git-tracked root, or auto-provision failed.
 *
 * Hook callers replace the historical pattern
 *   `const vaultDir = resolveVaultDir(); if (!fs.existsSync(...)) return;`
 * with
 *   `const vaultDir = resolveProvisionedVaultDir(); if (!vaultDir) return;`
 *
 * The function is cheap on the hot path (`.myco/myco.yaml` exists →
 * one stat call, no further work). Only fires the git-gate +
 * provision logic on the cold path when the vault is genuinely
 * absent — which is once per project lifetime.
 */
export function resolveProvisionedVaultDir(cwd: string = process.cwd()): string | null {
  const vaultDir = resolveVaultDir(cwd);
  const mycoYamlPath = path.join(vaultDir, 'myco.yaml');
  const projectRoot = resolveProjectRoot(vaultDir);

  if (fs.existsSync(mycoYamlPath)) {
    if (isCaptureGateClosed(projectRoot)) return null;
    if (lifecycleForRootMemo(projectRoot) === 'unregistered') {
      try { ensureProjectVault(projectRoot); }
      catch {
        // Re-admission is best-effort on the hot path; capture can still proceed
        // with the existing vault and the provisioning-failed trace remains
        // reserved for cold-path creation failures.
      }
    }
    // Vault exists. Check the global-install sentinel; if absent, this
    // project is legacy — its `.myco/` predates the global-install
    // model and still carries project-scope hook installs that need to
    // be cleaned up. Run the one-shot migration before returning. It's
    // idempotent (sentinel-gated) and fast on the cold path (a few
    // small file ops); subsequent hook fires skip the work entirely.
    if (!hasGlobalInstallMigrationCompleted(projectRoot)) {
      try { migrateProjectToGlobalInstall(projectRoot); }
      catch {
        // Migration failure must never break capture for the user.
        // The next hook fire retries; `recordMigrationPass` (wired
        // from `myco update`) is the audit surface.
      }
    }
    return vaultDir;
  }

  if (!isSafeProjectRoot(projectRoot)) {
    // Non-git / unsafe root: capture is git-project-scoped by design, so
    // dropping here is correct — but make it diagnosable. Gated behind
    // MYCO_AGENT_DEBUG because this fires on every event in an unwatched
    // directory; an unconditional trace would spam an agent run whose cwd
    // happens to be non-git.
    if (process.env.MYCO_AGENT_DEBUG) {
      process.stderr.write(`[myco] capture skipped (non-git-or-unsafe-root) root=${projectRoot}\n`);
    }
    return null;
  }

  if (isCaptureGateClosed(projectRoot)) return null;

  try {
    ensureProjectVault(projectRoot);
    return vaultDir;
  } catch (err) {
    // Provisioning failed (permissions, full disk, a half-written `.myco/`).
    // The hook still bails so a capture failure never breaks the user's tool
    // use — but it bails LOUDLY. This path never reaches the daemon, so the
    // daemon log cannot surface it; a stderr trace is the only signal, and a
    // silent drop here is exactly the "capture went dark with no log line"
    // failure mode that has recurred in this project. Mirrors the
    // buffer-fallback traces in send-event.ts.
    process.stderr.write(
      `[myco] capture skipped (provision-failed) root=${projectRoot}: ${(err as Error).message}\n`,
    );
    return null;
  }
}
