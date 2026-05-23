/**
 * Global bootstrap + symbiont detection — the shared code path the daemon's
 * first-start auto-bootstrap, the PowerManager periodic tick, the
 * version-drift handler, the on-demand UI/CLI re-detect trigger, and the
 * manual `myco init` (no flag) all invoke.
 *
 * Two functions:
 *
 *   - `runGlobalBootstrap()` — write the global launchers and run a
 *     detection pass. Used for greenfield first-start + the manual CLI
 *     entry point.
 *   - `runSymbiontDetection()` — walk the manifest registry, install the
 *     global Myco config into each agent whose `detectionDir` exists,
 *     emit a notification for each newly-detected symbiont. Idempotent:
 *     a symbiont already installed (settings-merge produces a no-diff
 *     write) is reported as `already-configured`.
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
 * Single side-effect entry point — the CLI, the daemon's first-start
 * bootstrap, the PowerManager periodic tick, the version-drift handler,
 * and the on-demand `/api/symbionts/detect` route all invoke this same
 * function. Orchestrators are thin wrappers that route the result to
 * console / logger / notification channels; no orchestrator adds or
 * drops side effects.
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
