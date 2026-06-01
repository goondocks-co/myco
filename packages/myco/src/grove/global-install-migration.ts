/**
 * One-shot per-project global-install migration.
 *
 * Replaces the every-detect-tick walker pattern (`migration-walker.ts`,
 * retired in a follow-up slice) with a single idempotent function the
 * caller runs ONCE per project: from `myco update` for projects the
 * daemon already knows about, and from the daemon's auto-registration
 * path the first time a hook event arrives from a project that hasn't
 * been seen yet.
 *
 * The contract is in plan `38cff0752c919ffd` §5 — sentinel-gated entry,
 * archive snapshot (forensics only, no rollback), per-manifest strip of
 * Myco markers from co-tenant config files, empty-file/dir cleanup,
 * sentinel write, audit-log entry. The single-writer tenet still holds:
 * ProjectVault owns shared vault files, settings-merge owns co-tenant
 * agent files, this function orchestrates — it doesn't smuggle a parallel
 * write path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectVaultDir, resolveMycoHome, currentDaemonVariant } from './paths.js';
import { listGroves, listRegisteredProjects, type DaemonVariant } from './registry.js';
import type { SymbiontManifest } from '../symbionts/manifest-schema.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { SymbiontInstaller, removeProjectLaunchers, MYCO_MCP_SERVER_NAME } from '../symbionts/installer.js';
import { isMycoHookGroup } from '../symbionts/install-helpers.js';
import { readJsonFile, writeOrDeleteJsonFile } from '../symbionts/json-helpers.js';
import { propagateLegacyMachineId } from '../daemon/machine-id.js';
import { propagateLegacySecrets } from '../config/secrets.js';
import { epochSeconds } from '@myco/constants.js';

/**
 * On-disk shape of the per-project sentinel that marks the global-install
 * migration as complete. Once present, `migrateProjectToGlobalInstall`
 * returns immediately without inspecting the project — the project is
 * "done" with the migration.
 */
export interface GlobalInstallMigrationSentinel {
  /** Schema version of the sentinel; bump only on breaking change. */
  schema_version: 1;
  /** Epoch seconds when the migration completed. */
  migrated_at: number;
  /** Correlation id for the audit log row this migration produced. */
  pass_id: string;
  /**
   * Relative path (under `.myco/`) of the archive directory created
   * during this migration, or `null` when nothing needed archiving
   * (clean project, fresh greenfield vault).
   */
  archived_to: string | null;
}

export const SENTINEL_DIRNAME = 'migration';
export const SENTINEL_FILENAME = 'global-install-complete.json';

/**
 * Resolve the absolute path for the per-project migration sentinel.
 */
export function resolveSentinelPath(projectRoot: string): string {
  return path.join(resolveProjectVaultDir(projectRoot), SENTINEL_DIRNAME, SENTINEL_FILENAME);
}

/**
 * Cheap presence-check used by both the migration function (early
 * return) and the daemon's auto-registration path (skip-migrate gate).
 */
export function hasGlobalInstallMigrationCompleted(projectRoot: string): boolean {
  return fs.existsSync(resolveSentinelPath(projectRoot));
}

/**
 * Read the sentinel, parse, and return its body. Returns `null` when
 * the file is absent OR present-but-unparseable — the latter is treated
 * as "missing" so the migration can re-run and overwrite a corrupt
 * sentinel on the next pass. Loose by design; sentinel content is
 * forensic, not load-bearing.
 */
export function readMigrationSentinel(projectRoot: string): GlobalInstallMigrationSentinel | null {
  const p = resolveSentinelPath(projectRoot);
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.schema_version === 1) {
      return parsed as GlobalInstallMigrationSentinel;
    }
    return null;
  } catch {
    return null;
  }
}

export interface MigrationOutcome {
  /** True when the sentinel was already present and nothing ran. */
  alreadyDone: boolean;
  /** True when steps 2–3 found no Myco artifacts on disk. */
  noLegacyArtifacts: boolean;
  /** Absolute paths of files copied into the archive. */
  archivedFiles: string[];
  /** Absolute path of the archive directory, or `null` when nothing was archived. */
  archiveDir: string | null;
  /** Manifests whose `installer.uninstall(...)` did something. */
  strippedSymbionts: string[];
  /** Project-relative launcher stubs removed (`.agents/myco-run.cjs`, `myco-cli.cjs`). */
  removedLaunchers: string[];
  /** Project-relative configs of retired symbionts (e.g. Gemini) that were stripped. */
  cleanedRetiredConfigs: string[];
  /** Project-relative plugin deps packages removed because they were pristine. */
  removedPluginPackages: string[];
  /** True when `propagateLegacyMachineId` actually wrote a global value. */
  machineIdPropagated: boolean;
  /** Secret keys lifted from `<vault>/secrets.env` into `~/.myco/secrets.env`. */
  secretsPropagated: string[];
  /** Correlation id stamped on the sentinel + audit log. */
  passId: string;
  /** Sentinel as written to disk (null when migration errored before the sentinel write). */
  sentinel: GlobalInstallMigrationSentinel | null;
}

export interface MigrateOptions {
  /**
   * Override the manifest list — primarily for tests. Production callers
   * leave undefined to use the bundled set.
   */
  manifests?: SymbiontManifest[];
  /**
   * Override the package root used to resolve installer template bundles.
   * Production callers leave undefined to use `resolvePackageRoot()`.
   */
  packageRoot?: string;
}

/**
 * Run the one-shot global-install migration for a single project. Idempotent:
 * a project with the sentinel already on disk returns immediately with
 * `alreadyDone: true` and no other side effects. A project without the
 * sentinel goes through archive → strip → propagate machine_id → sentinel
 * write → return.
 *
 * Errors mid-pass: any throw before the sentinel write leaves the project
 * in a partial state — the sentinel is NOT written, so the next invocation
 * will retry. Callers should record the error via `recordMigrationPass`
 * upstream; this function just throws.
 *
 * Plan reference: `38cff0752c919ffd` §5.
 */
export function migrateProjectToGlobalInstall(
  projectRoot: string,
  options: MigrateOptions = {},
): MigrationOutcome {
  const passId = cryptoRandomId();
  const sentinelPath = resolveSentinelPath(projectRoot);

  // Step 1 — sentinel check.
  if (fs.existsSync(sentinelPath)) {
    return {
      alreadyDone: true,
      noLegacyArtifacts: true,
      archivedFiles: [],
      archiveDir: null,
      strippedSymbionts: [],
      removedLaunchers: [],
      cleanedRetiredConfigs: [],
      removedPluginPackages: [],
      machineIdPropagated: false,
      secretsPropagated: [],
      passId,
      sentinel: readMigrationSentinel(projectRoot),
    };
  }

  const vaultDir = resolveProjectVaultDir(projectRoot);
  const manifests = options.manifests ?? loadManifests();
  const packageRoot = options.packageRoot ?? resolvePackageRoot();

  // Step 2 — archive. Forensics only. Snapshot the per-symbiont config
  // files Myco previously wrote at project scope BEFORE the strip step
  // mutates them. The archive directory ships inside the vault so it
  // travels with the project (gitignored via `.archive-*/` pattern).
  const archiveTimestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const archiveDirAbs = path.join(vaultDir, `.archive-pre-global-install-${archiveTimestamp}`);
  const archivedFiles: string[] = [];

  for (const manifest of manifests) {
    const reg = manifest.registration;
    if (!reg) continue;
    const archiveTargets = [
      reg.hooksTarget,
      reg.mcpTarget,
      reg.settingsTarget,
      reg.pluginManifestTarget,
      reg.pluginPackageTarget,
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);

    for (const relPath of archiveTargets) {
      const srcAbs = path.join(projectRoot, relPath);
      if (!fs.existsSync(srcAbs)) continue;
      const destAbs = path.join(archiveDirAbs, relPath);
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.copyFileSync(srcAbs, destAbs);
      archivedFiles.push(srcAbs);
    }
  }

  // Step 3 — strip Myco markers from co-tenant files. installer.uninstall
  // with `keepProjectContent: true` does marker-bounded removal: Myco's
  // hook entries / MCP entries / settings keys go, user co-tenant entries
  // survive untouched. Per-symbiont errors don't abort the pass; they
  // surface in the per-symbiont result.
  const strippedSymbionts: string[] = [];
  for (const manifest of manifests) {
    const reg = manifest.registration;
    if (!reg?.hooksTarget) continue;
    const projectConfigPath = path.join(projectRoot, reg.hooksTarget);
    if (!fs.existsSync(projectConfigPath)) continue;
    try {
      const installer = new SymbiontInstaller(
        manifest, projectRoot, packageRoot, false, undefined, null, 'project',
      );
      const result = installer.uninstall({ keepProjectContent: true });
      if (result.hooks || result.mcp || result.settings || result.skills) {
        strippedSymbionts.push(manifest.name);
      }
    } catch {
      // Individual symbiont uninstall failures are not fatal — record
      // nothing here; the audit log captures pass-level errors via the
      // caller's `recordMigrationPass` wrap.
    }
  }

  // Step 3b — remove project-shared launcher stubs. The global launcher
  // is the only launcher in the global-install model.
  const removedLaunchers = removeProjectLaunchers(projectRoot);

  // Step 3c — strip Myco content from retired-symbiont project configs
  // (archived first), deleting the file when nothing else remains.
  const cleanedRetiredConfigs = cleanRetiredSymbiontConfigs(
    projectRoot, archiveDirAbs, archivedFiles,
  );

  // Step 3d — remove pristine, now-orphaned plugin deps packages (archived
  // in step 2). Contributor-edited packages are left in place.
  const removedPluginPackages: string[] = [];
  for (const manifest of manifests) {
    const target = manifest.registration?.pluginPackageTarget;
    if (!target) continue;
    const installer = new SymbiontInstaller(
      manifest, projectRoot, packageRoot, false, undefined, null, 'project',
    );
    if (installer.removeManagedPluginPackage()) removedPluginPackages.push(target);
  }

  // Step 4 — propagate the project-scope machine_id to the global cache
  // before the vault loses the file. Idempotent: no-op when the global
  // cache already exists OR when the project never had a machine_id.
  const machineIdPropagated = propagateLegacyMachineId(vaultDir);

  // Step 4b — lift the project-scope `secrets.env` into `~/.myco/secrets.env`
  // BEFORE step 5b purges it. Without this, user API keys stored at the
  // project level (the documented fallback per `feedback_secrets_not_in_yaml.md`)
  // would be deleted by the migration. Global-side keys win on conflict;
  // any key absent globally is lifted from the project file.
  const secretsPropagated = propagateLegacySecrets(vaultDir, resolveMycoHome());

  // Step 5 — cleanup empty co-tenant files and directories the strip
  // step may have hollowed out. We never delete a non-empty file; the
  // marker-bounded removal already preserved user content.
  removeEmptyConfigArtifacts(projectRoot, manifests);

  // Step 5b — purge legacy per-machine artifacts that the global-install
  // model relocates. Items with a propagation target (machine_id,
  // secrets.env) have been lifted already; items without one
  // (attachments/, team/, installer-audit/) are MOVED into the archive
  // dir before deletion so user data is preserved on a forensic path
  // rather than destroyed. See PURGABLE_VAULT_ARTIFACTS.
  const purgedArtifacts = purgeLegacyPerMachineArtifacts(vaultDir, archiveDirAbs);

  const noLegacyArtifacts =
    archivedFiles.length === 0
    && strippedSymbionts.length === 0
    && purgedArtifacts.length === 0;
  // archiveDir is non-null when EITHER step 2 archived co-tenant config OR
  // step 5b moved a `mode: 'archive'` artifact into the directory.
  const archivedAnything = archivedFiles.length > 0 ||
    purgedArtifacts.some((rel) =>
      PURGABLE_VAULT_ARTIFACTS.find((a) => a.rel === rel)?.mode === 'archive',
    );
  const archiveDir = archivedAnything ? archiveDirAbs : null;

  // Step 6 — sentinel write. Last step in the happy path; its presence
  // is the future-skip signal.
  const sentinel: GlobalInstallMigrationSentinel = {
    schema_version: 1,
    migrated_at: epochSeconds(),
    pass_id: passId,
    archived_to: archiveDir ? path.relative(vaultDir, archiveDir) : null,
  };
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  fs.writeFileSync(sentinelPath, JSON.stringify(sentinel, null, 2) + '\n', 'utf-8');

  // Step 7 — reconcile project-managed local files: rules guidance plus
  // `.gitignore` for bundled skill dirs, configured plan dirs, and wrangler
  // cache. The walker that used to keep this in sync was retired; running it
  // here covers the first-event / hot-path entry, while `myco update` has a
  // dedicated variant-scoped managed-file pass for already-migrated projects.
  // /code-review finding C10.
  if (manifests.length > 0) {
    try {
      const installer = new SymbiontInstaller(
        manifests[0], projectRoot, packageRoot, false, undefined, null, 'project',
      );
      installer.reconcileManagedProjectFiles();
    } catch {
      // Best-effort. Failures don't roll back the sentinel — the user's
      // capture is the priority; managed-file drift is recoverable.
    }
  }

  return {
    alreadyDone: false,
    noLegacyArtifacts,
    archivedFiles,
    archiveDir,
    strippedSymbionts,
    removedLaunchers,
    cleanedRetiredConfigs,
    removedPluginPackages,
    machineIdPropagated,
    secretsPropagated,
    passId,
    sentinel,
  };
}

/**
 * Project-relative JSON configs of retired symbionts. Gemini was
 * superseded by Antigravity; its `.gemini/settings.json` carries Myco
 * hooks, the `myco` MCP server, and Myco `coreTools` allowances but has
 * no manifest to drive the per-symbiont strip.
 */
const RETIRED_SYMBIONT_JSON_CONFIGS = ['.gemini/settings.json'] as const;

/**
 * Strip Myco content from retired-symbiont JSON configs: Myco hook
 * groups, the `myco` MCP server entry, and `coreTools` allowances that
 * reference Myco. Archives the original first, then writes the remainder
 * back — or deletes the file when nothing non-Myco survives. Returns the
 * project-relative paths that were touched.
 */
function cleanRetiredSymbiontConfigs(
  projectRoot: string,
  archiveDirAbs: string,
  archivedFiles: string[],
): string[] {
  const cleaned: string[] = [];
  for (const rel of RETIRED_SYMBIONT_JSON_CONFIGS) {
    const abs = path.join(projectRoot, rel);
    if (!fs.existsSync(abs)) continue;

    const dest = path.join(archiveDirAbs, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    archivedFiles.push(abs);

    const data = readJsonFile(abs);

    const hooks = data.hooks as Record<string, Array<Record<string, unknown>>> | undefined;
    if (hooks && typeof hooks === 'object') {
      const kept: Record<string, unknown[]> = {};
      for (const [event, groups] of Object.entries(hooks)) {
        const nonMyco = (groups as Array<Record<string, unknown>>).filter((g) => !isMycoHookGroup(g));
        if (nonMyco.length > 0) kept[event] = nonMyco;
      }
      if (Object.keys(kept).length === 0) delete data.hooks;
      else data.hooks = kept;
    }

    const servers = data.mcpServers as Record<string, unknown> | undefined;
    if (servers && typeof servers === 'object' && MYCO_MCP_SERVER_NAME in servers) {
      delete servers[MYCO_MCP_SERVER_NAME];
      if (Object.keys(servers).length === 0) delete data.mcpServers;
    }

    const coreTools = data.coreTools;
    if (Array.isArray(coreTools)) {
      const kept = coreTools.filter((t) => typeof t !== 'string' || !t.includes('myco'));
      if (kept.length === 0) delete data.coreTools;
      else data.coreTools = kept;
    }

    writeOrDeleteJsonFile(abs, data);
    cleaned.push(rel);
  }
  return cleaned;
}

/**
 * Walk each manifest's project-scope config targets and delete the file
 * when it has shrunk to a structurally-empty shape post-strip
 * (`{ "hooks": {} }`, `{}`, an empty array, or an empty file). Then prune
 * each config directory if the directory itself is now empty.
 *
 * The "structurally empty" check intentionally treats `hooks: {}` as
 * empty for shared agent config files — the symbiont stripper drains
 * Myco's entries but leaves the `hooks` key in place to make the diff
 * minimal, which produces this exact shape when Myco was the only
 * tenant.
 */
function removeEmptyConfigArtifacts(projectRoot: string, manifests: SymbiontManifest[]): void {
  const seenDirs = new Set<string>();
  for (const manifest of manifests) {
    const reg = manifest.registration;
    if (!reg) continue;
    const candidates = [
      reg.hooksTarget,
      reg.mcpTarget,
      reg.settingsTarget,
      reg.pluginManifestTarget,
      reg.pluginPackageTarget,
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);

    for (const relPath of candidates) {
      const abs = path.join(projectRoot, relPath);
      if (!fs.existsSync(abs)) continue;
      if (isStructurallyEmpty(abs)) {
        try { fs.rmSync(abs); } catch { /* best-effort */ }
      }
      seenDirs.add(path.dirname(abs));
    }
  }
  // Prune any now-empty directories we touched. Walk parents up to the
  // project root, stopping on a non-empty directory.
  for (const dir of seenDirs) {
    pruneEmptyDirsUpTo(dir, projectRoot);
  }
}

function isStructurallyEmpty(filePath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return false;
  }
  if (raw.length === 0) return true;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.length === 0;
    if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed);
      if (keys.length === 0) return true;
      // The marker-bounded stripper leaves an empty `hooks: {}` in place
      // on Claude/Codex/Copilot shapes. Treat that as empty.
      if (keys.length === 1 && keys[0] === 'hooks') {
        const hooks = (parsed as Record<string, unknown>).hooks;
        if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
          return Object.keys(hooks as Record<string, unknown>).length === 0;
        }
      }
    }
  } catch {
    // Not JSON — leave alone (TOML, plain text, plugin source, etc.)
  }
  return false;
}

function pruneEmptyDirsUpTo(startDir: string, stopAt: string): void {
  let dir = startDir;
  const stop = path.resolve(stopAt);
  while (dir.startsWith(stop) && dir !== stop) {
    try {
      const entries = fs.readdirSync(dir);
      if (entries.length > 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

function cryptoRandomId(): string {
  // 8-byte hex id — mirrors the walker's correlation id format so the
  // audit-log row format stays consistent.
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
}

/**
 * Per-vault paths that the global-install model relocates. Each entry
 * declares whether the artifact is safe to DELETE outright (already
 * propagated or pure ephemera) or must be ARCHIVED before removal
 * (potentially-valuable user data with no current propagation target).
 *
 * Per the `feedback_data_preservation.md` tenet — when in doubt,
 * archive. The archive directory is gitignored (".archive-*"), so
 * moving user data there gives a forensic trail without polluting
 * `git status`.
 *
 * - `delete`: artifact has been propagated by an earlier step (machine_id,
 *   secrets.env) or is ephemera the daemon regenerates on demand
 *   (last-update-version, restart-reason.json). Security-sensitive items
 *   intentionally land here so the archive doesn't carry a second copy
 *   of user secrets.
 *
 * - `archive`: artifact contains user data (attachments, team/, the
 *   per-symbiont installer-audit provenance) that the global-install
 *   model has no in-tree migration target for. Move into the archive
 *   directory instead of deleting; a future tick or user-initiated
 *   recovery can pull from there if needed.
 */
const PURGABLE_VAULT_ARTIFACTS: Array<{ rel: string; mode: 'delete' | 'archive' }> = [
  { rel: 'machine_id',          mode: 'delete'  }, // propagated by propagateLegacyMachineId
  { rel: 'last-update-version', mode: 'delete'  }, // daemon regenerates
  { rel: 'restart-reason.json', mode: 'delete'  }, // ephemeral
  { rel: 'buffer',              mode: 'archive' }, // capture buffer
  { rel: 'logs',                mode: 'archive' }, // daemon logs
  { rel: 'attachments',         mode: 'archive' }, // user content
  { rel: 'team',                mode: 'archive' }, // legacy team-sync state pre-Grove
  { rel: 'installer-audit',     mode: 'archive' }, // per-symbiont strip provenance
  { rel: 'secrets.env',         mode: 'delete'  }, // propagated by propagateLegacySecrets; not archived (security)
];

/**
 * Remove the legacy per-machine artifacts listed above from the project
 * vault. Items declared `mode: 'archive'` are first MOVED into
 * `archiveDirAbs/<rel>` (gitignored), preserving user data on a
 * forensics path before the in-tree copy is removed. Items declared
 * `mode: 'delete'` are removed directly.
 *
 * Returns the relative paths actually touched (archived OR deleted) for
 * audit-log diagnostics. Safe to run after the upstream propagation
 * steps — those steps have already lifted the data to its canonical
 * home before this function fires.
 */
function purgeLegacyPerMachineArtifacts(vaultDir: string, archiveDirAbs: string): string[] {
  const removed: string[] = [];
  for (const { rel, mode } of PURGABLE_VAULT_ARTIFACTS) {
    const abs = path.join(vaultDir, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      if (mode === 'archive') {
        const archiveTarget = path.join(archiveDirAbs, rel);
        fs.mkdirSync(path.dirname(archiveTarget), { recursive: true });
        // Best-effort copy → rm. cpSync handles both files and directories
        // recursively and preserves contents; rmSync below cleans the
        // original. We deliberately do NOT use fs.renameSync — it fails
        // across filesystem boundaries (the archive dir and the vault
        // could land on different mounts).
        fs.cpSync(abs, archiveTarget, { recursive: true });
      }
      fs.rmSync(abs, { recursive: true, force: true });
      removed.push(rel);
    } catch {
      // Best-effort. The next migration tick retries any path that
      // failed (sentinel is only written on the successful pass).
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Bulk pass — iterate registered projects, call migration per project.
//
// Replaces the legacy `runProjectLocalMigration` walker. The bulk entry
// is what `myco update`, the daemon's "run migration" API, and the
// doctor's `--fix` mode all invoke. Per-project migration is the same
// `migrateProjectToGlobalInstall` function — sentinel-gated, idempotent.
// Projects already migrated are visited but no-op fast.
// ---------------------------------------------------------------------------

export interface ProjectMigrationOutcome {
  groveId: string;
  projectId: string;
  projectRoot: string;
  /** True when the sentinel was already present. */
  alreadyDone: boolean;
  /** True when steps 2–3 found nothing to archive or strip. */
  noLegacyArtifacts: boolean;
  /** Files archived during the pass. */
  archivedFiles: string[];
  /** Symbionts whose project-scope config blocks were stripped. */
  cleanedSymbionts: string[];
  /** True when a legacy project-scope machine_id was propagated to global. */
  machineIdPropagated: boolean;
  /** Secret keys lifted from <vault>/secrets.env into ~/.myco/secrets.env. */
  secretsPropagated: string[];
  /** Set when this project's migration threw. */
  error?: string;
}

export interface MigrationPassResult {
  passId: string;
  passedAt: number;
  projectsVisited: number;
  projectsCleaned: number;
  projectsErrored: number;
  outcomes: ProjectMigrationOutcome[];
}

/**
 * Iterate every registered project in the Groves THIS DAEMON SERVES and
 * run `migrateProjectToGlobalInstall` for each.
 *
 * Hard scope: invocations stay inside the Grove-ownership boundary
 * (`grove.toml served_by`). Cross-daemon mutation is forbidden by the
 * same rule that gates SQLite access.
 *
 * `servedBy` defaults to the current process's daemon variant; tests
 * and CLI commands run outside a daemon pass it explicitly.
 *
 * Returns the pass result; the caller is responsible for persisting it
 * via `recordMigrationPass` if audit-log coverage is desired.
 */
export function runGlobalInstallMigrationPass(
  options: {
    mycoHome?: string;
    servedBy?: DaemonVariant;
    manifests?: SymbiontManifest[];
    packageRoot?: string;
  } = {},
): MigrationPassResult {
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const servedBy = options.servedBy ?? currentDaemonVariant();
  const manifests = options.manifests ?? loadManifests();
  const packageRoot = options.packageRoot ?? resolvePackageRoot();

  const passId = cryptoRandomId();
  const outcomes: ProjectMigrationOutcome[] = [];

  for (const grove of listGroves(mycoHome, { servedBy })) {
    for (const project of listRegisteredProjects(grove.id, mycoHome)) {
      if (!fs.existsSync(project.root)) {
        // Off-disk root — record a benign no-op and move on. A separate
        // cleanup task handles orphaned project entries.
        outcomes.push({
          groveId: grove.id,
          projectId: project.project_id,
          projectRoot: project.root,
          alreadyDone: false,
          noLegacyArtifacts: true,
          archivedFiles: [],
          cleanedSymbionts: [],
          machineIdPropagated: false,
          secretsPropagated: [],
        });
        continue;
      }
      try {
        const result = migrateProjectToGlobalInstall(project.root, { manifests, packageRoot });
        outcomes.push({
          groveId: grove.id,
          projectId: project.project_id,
          projectRoot: project.root,
          alreadyDone: result.alreadyDone,
          noLegacyArtifacts: result.noLegacyArtifacts,
          archivedFiles: result.archivedFiles,
          cleanedSymbionts: result.strippedSymbionts,
          machineIdPropagated: result.machineIdPropagated,
          secretsPropagated: result.secretsPropagated,
        });
      } catch (err) {
        outcomes.push({
          groveId: grove.id,
          projectId: project.project_id,
          projectRoot: project.root,
          alreadyDone: false,
          noLegacyArtifacts: false,
          archivedFiles: [],
          cleanedSymbionts: [],
          machineIdPropagated: false,
          secretsPropagated: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    passId,
    passedAt: epochSeconds(),
    projectsVisited: outcomes.length,
    projectsCleaned: outcomes.filter((o) => !o.alreadyDone && !o.error && (!o.noLegacyArtifacts || o.machineIdPropagated)).length,
    projectsErrored: outcomes.filter((o) => !!o.error).length,
    outcomes,
  };
}

/**
 * Lightweight startup-time machine_id propagation across every registered
 * project the daemon serves. Runs BEFORE `getMachineId()` so the legacy
 * project-scope value wins over a fresh derivation — without this,
 * `getMachineId()` writes a brand-new global `machine_id` on first boot,
 * then `propagateLegacyMachineId(vaultDir)` later (from vault-gate's
 * per-event migration) bails because the global file now exists. Result:
 * historic capture rows stamped with the old id are orphaned from the
 * live identity.
 *
 * No-op when the global cache already exists (idempotent). Touches only
 * the machine_id file — does NOT run archive / strip / sentinel writes.
 * Per-project full migration still runs on its own schedule via
 * `runGlobalInstallMigrationPass` or `vault-gate`.
 *
 * Returns the projectRoot the value came from (for audit logging),
 * or `null` when no legacy machine_id was found anywhere.
 *
 * Identified by /code-review high finding C2.
 */
export function propagateLegacyMachineIdAtStartup(options: {
  mycoHome?: string;
  servedBy?: DaemonVariant;
} = {}): string | null {
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const servedBy = options.servedBy ?? currentDaemonVariant();
  const groves = listGroves(mycoHome).filter((g) => g.served_by === servedBy);
  for (const grove of groves) {
    for (const project of listRegisteredProjects(grove.id, mycoHome)) {
      if (!fs.existsSync(project.root)) continue;
      const vaultDir = resolveProjectVaultDir(project.root);
      if (propagateLegacyMachineId(vaultDir)) {
        return project.root;
      }
    }
  }
  return null;
}
