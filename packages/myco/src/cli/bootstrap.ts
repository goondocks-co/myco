/**
 * Global bootstrap + symbiont detection.
 *
 * Two functions, split by *when* migration runs:
 *
 *   - `runGlobalBootstrap()` — write launchers, run a detection pass,
 *     AND walk every registered project for legacy per-project install
 *     artifacts. Migration is fire-once-per-project: it runs at daemon
 *     first-start and on auto-Grove-create when a fresh project
 *     registers. Explicit retry happens via `myco doctor --fix`. This
 *     entry MUST NOT be called on the hourly tick — re-running the
 *     migration walker every hour normalizes failure as ongoing
 *     operational state. Failures land in the bounded migration audit
 *     log and surface as doctor warnings.
 *   - `runSymbiontDetection()` — walk the manifest registry, install
 *     the global Myco config into each agent whose `detectionDir`
 *     exists. Idempotent: a symbiont already installed (settings-merge
 *     produces a no-diff write) is reported as `already-configured`.
 *     This is the detection-only entry the hourly PowerManager tick
 *     calls — new agents installed on the machine since the last tick
 *     are a legitimately ongoing concern.
 *
 * Both functions are deliberately side-effect-free for an absent
 * `detectionDir` — Myco NEVER creates an agent's config dir on its
 * behalf. The detection gate in `SymbiontInstaller.isAvailableForScope`
 * is the structural enforcement; this module reports.
 */

import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { SymbiontInstaller, type InstallResult } from '../symbionts/installer.js';
import { installGlobalLaunchers, type InstalledLauncherReport } from '../grove/launcher-install.js';
import { runProjectLocalMigration, type MigrationPassResult } from '../grove/migration-walker.js';
import {
  runGlobalConfigMigration,
  type GlobalConfigMigrationResult,
} from '../grove/global-config-migration.js';

export interface DetectionResult {
  /** Manifest name (e.g. 'claude-code'). */
  symbiont: string;
  /** Outcome for this manifest in this pass. */
  status: 'installed' | 'already-configured' | 'not-detected' | 'error';
  /** When status === 'installed' or 'already-configured', the install result. */
  install?: InstallResult;
  /** Error message when status === 'error'. */
  error?: string;
}

export interface BootstrapResult {
  /** Whether the launchers were written (true) or already current (false). */
  launchers: InstalledLauncherReport;
  /** Per-symbiont detection outcomes. */
  symbionts: DetectionResult[];
  /**
   * Per-pass migration walker outcome. Walks every registered project for
   * legacy per-project install artifacts. Idempotent — projects with no
   * legacy state contribute a `noOp: true` outcome.
   */
  migration: MigrationPassResult;
  /** Per-pass global-config scrub outcomes (e.g. legacy ~/.gemini state). */
  globalConfigMigration: GlobalConfigMigrationResult;
}

/**
 * Walk every manifest and install the global Myco config into each agent
 * whose `detectionDir` exists. Idempotent: settings-merge writes the
 * same content on a second pass, returning `install.hooks === false`
 * etc. — the caller distinguishes a fresh install from a no-op via the
 * `newly_installed` flag set on the InstallResult.
 *
 * `packageRoot` is resolved lazily via `resolvePackageRoot()` so tests
 * don't need to thread it through. Pass an explicit value when a custom
 * package layout is needed.
 */
export function runSymbiontDetection(
  packageRoot: string = resolvePackageRoot(),
): DetectionResult[] {
  const results: DetectionResult[] = [];
  for (const manifest of loadManifests()) {
    // `projectRoot` is unused in global scope — every operation that
    // touches it (AGENTS.md, .gitignore, instructions) is skipped. The
    // SymbiontInstaller takes the value through its constructor for
    // backward compatibility with the project path.
    const installer = new SymbiontInstaller(
      manifest, '/', packageRoot, false, undefined, null, 'global',
    );
    if (!installer.isAvailableForScope()) {
      results.push({ symbiont: manifest.name, status: 'not-detected' });
      continue;
    }
    try {
      const install = installer.install();
      // "Changed" tracks config-file writes — hooks, MCP, settings.
      // Skills are symlinks; they're verified-or-created every pass
      // (ensureSymlink early-returns when the link already points right)
      // and don't represent a config drift worth surfacing as a fresh
      // install. pluginPackage is project-only and always false in global.
      const anythingChanged = install.hooks || install.mcp || install.settings;
      results.push({
        symbiont: manifest.name,
        status: anythingChanged ? 'installed' : 'already-configured',
        install,
      });
    } catch (err) {
      results.push({
        symbiont: manifest.name,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Write the global launchers, run a symbiont detection pass, then walk
 * every registered project for legacy per-project install artifacts.
 *
 * Order matters per the Decision 8 write-ordering invariant: launchers
 * MUST exist before any agent's hook config points at them. Symbiont
 * installs only run after the launcher install completes. The migration
 * walker runs last (it operates on already-registered projects and
 * doesn't depend on launcher state).
 *
 * Migration is fire-once-per-project. Call sites:
 *   - daemon first-start (greenfield bootstrap)
 *   - auto-Grove-create when a fresh project registers
 *   - explicit `myco doctor --fix` retry for previously-failed projects
 *
 * The hourly PowerManager tick MUST call `runSymbiontDetection()`
 * directly (plus its own launcher refresh) rather than this function —
 * re-running the walker every hour treats failures as retry-next-hour
 * instead of failures to fix.
 *
 * Idempotent — a re-invocation against a populated `~/.myco/` returns
 * `launchers.written === []`, per-symbiont `'already-configured'`
 * results, and `migration.projectsCleaned === 0`.
 */
export function runGlobalBootstrap(
  packageRoot: string = resolvePackageRoot(),
): BootstrapResult {
  const launchers = installGlobalLaunchers();
  const symbionts = runSymbiontDetection(packageRoot);
  // Walker scope is enforced inside `runProjectLocalMigration` via its
  // default `servedBy` arg (sourced from the current daemon variant);
  // bootstrap doesn't override it.
  const migration = runProjectLocalMigration(packageRoot);
  const globalConfigMigration = runGlobalConfigMigration();
  return { launchers, symbionts, migration, globalConfigMigration };
}
