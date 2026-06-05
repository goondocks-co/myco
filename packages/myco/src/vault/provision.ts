/**
 * Per-project vault provisioning.
 *
 * Called from the daemon's hook-event intake path when an event arrives
 * from a project root whose vault doesn't exist yet. Creates the minimal
 * set of files the project needs to participate in capture:
 *
 *   - `.myco/myco.yaml` — config stub (loader fills in defaults on read)
 *   - `.myco/.gitignore` — canonical body (`vault/gitignore.ts`)
 *   - `.myco/project.toml` — portable project + grove identity
 *   - `.myco/project.local.toml` — per-machine grove binding
 *   - `.myco/migration/global-install-complete.json` — pre-written
 *     sentinel. Born-global projects never need to run the one-shot
 *     migration; the sentinel's presence guarantees we never re-visit.
 *
 * The git-gate (caller responsibility) — `isSafeProjectRoot(projectRoot)`
 * — must pass before calling this function. A "project" for Myco's
 * purposes IS a git repository; random directories (a user's home dir,
 * `/tmp`, etc.) must not auto-register.
 *
 * Plan reference: 38cff0752c919ffd §6.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectVaultDir, currentDaemonVariant } from '../grove/paths.js';
import { resolveDefaultGroveForVariant } from '../grove/registry.js';
import { ensureProjectManifest } from '../config/project-manifest.js';
import { ensureVaultGitignoreCurrent } from './gitignore.js';
import { epochSeconds } from '@myco/constants.js';
import {
  resolveSentinelPath,
  type GlobalInstallMigrationSentinel,
} from '../grove/global-install-migration.js';
import { CAPABILITIES } from '../config/capabilities.js';
import { saveLocalConfig } from '../config/loader.js';
import { setAtPath } from '../utils/dot-path.js';
import type { MycoConfig } from '../config/schema.js';

const MINIMAL_MYCO_YAML = 'version: 3\n';

export interface EnsureProjectVaultOptions {
  /**
   * Override the project's display name. Defaults to `basename(projectRoot)`.
   * Symbiont metadata may pass a richer label when one is available.
   */
  projectName?: string;
}

export interface EnsureProjectVaultResult {
  /** Absolute path to the project's vault directory (`<projectRoot>/.myco`). */
  vaultDir: string;
  /** True when this call created the vault. False when it already existed. */
  created: boolean;
  /** Project id from the (possibly-just-written) project.toml. */
  projectId: string;
}

/**
 * Idempotently provision the per-project vault. When `.myco/myco.yaml`
 * already exists, returns the existing project id without rewriting
 * anything. When the vault is absent, creates the full minimal set
 * described in the module-level doc.
 *
 * Caller must have already verified `isSafeProjectRoot(projectRoot)`.
 * Errors (filesystem, manifest schema) propagate — the caller is
 * responsible for logging and falling through to "drop the event".
 */
export function ensureProjectVault(
  projectRoot: string,
  options: EnsureProjectVaultOptions = {},
): EnsureProjectVaultResult {
  const vaultDir = resolveProjectVaultDir(projectRoot);
  const mycoYamlPath = path.join(vaultDir, 'myco.yaml');

  // Hot path: vault already exists, re-resolve identity and return.
  if (fs.existsSync(mycoYamlPath)) {
    const projectName = options.projectName ?? path.basename(projectRoot);
    const manifest = ensureProjectManifest(vaultDir, { projectName });
    return { vaultDir, created: false, projectId: manifest.project.id };
  }

  // Cold path: create the vault from scratch.
  fs.mkdirSync(vaultDir, { recursive: true });

  // Canonical `.gitignore` body. Idempotent — rewrites only when stale.
  ensureVaultGitignoreCurrent(vaultDir);

  // project.toml + project.local.toml — portable identity + machine-local
  // binding. The Grove slug binds the project to a local Grove on this
  // machine; teammates cloning the repo get their own local Grove for
  // the same project id (cross-machine correlation handled by team-sync,
  // not by sharing Grove identity).
  // Resolve the local default Grove for this daemon variant. Callers
  // that need a non-default Grove can pass `options.groveSlug` (test
  // fixtures and future "claim" operations).
  const variant = currentDaemonVariant();
  const defaultGrove = resolveDefaultGroveForVariant(undefined, { servedBy: variant });
  const projectName = options.projectName ?? path.basename(projectRoot);

  const manifest = ensureProjectManifest(vaultDir, {
    projectName,
    groveId: defaultGrove?.id,
    groveSlug: defaultGrove?.slug,
    groveName: defaultGrove?.name,
  });

  // Migration sentinel — born-global projects never had legacy hooks
  // to clean up, so we pre-write the sentinel here. The daemon's
  // unknown-project path can short-circuit any migration step on the
  // strength of this file's existence.
  const sentinel: GlobalInstallMigrationSentinel = {
    schema_version: 1,
    migrated_at: epochSeconds(),
    pass_id: bornGlobalPassId(),
    archived_to: null,
  };
  const sentinelPath = resolveSentinelPath(projectRoot);
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  fs.writeFileSync(sentinelPath, JSON.stringify(sentinel, null, 2) + '\n', 'utf-8');

  // New vaults start capture-only: write local.yaml off-overrides for every
  // capability master gate so intelligence features only activate when the
  // user explicitly promotes the project.
  const captureOnlyPatch: Record<string, unknown> = {};
  for (const cap of Object.values(CAPABILITIES)) {
    setAtPath(captureOnlyPatch, cap.masterGate, false);
  }
  saveLocalConfig(vaultDir, captureOnlyPatch as Partial<MycoConfig>);

  // myco.yaml is written LAST — it is the hot-path existence sentinel (the
  // check at the top of this function). Writing it last means a mid-provision
  // crash leaves no sentinel on disk, so the next call re-runs the cold path
  // and self-heals to the correct capture-only state.
  fs.writeFileSync(mycoYamlPath, MINIMAL_MYCO_YAML, 'utf-8');

  return { vaultDir, created: true, projectId: manifest.project.id };
}

function bornGlobalPassId(): string {
  // Distinct prefix from migration-walker correlation ids so audit-log
  // readers can tell at a glance that this sentinel was pre-written by
  // the provisioner rather than a real migration pass.
  return 'born-global-' + Math.random().toString(16).slice(2, 10);
}

/**
 * Re-exports `version: 3` minimal body for tests asserting the
 * provisioner wrote the expected initial content.
 */
export { MINIMAL_MYCO_YAML };
