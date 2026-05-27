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

  if (!isSafeProjectRoot(projectRoot)) return null;

  try {
    ensureProjectVault(projectRoot);
    return vaultDir;
  } catch {
    // Hook silently bails — capture failures must never break the
    // user's tool use. The daemon's audit log will surface the
    // pattern if it recurs.
    return null;
  }
}
