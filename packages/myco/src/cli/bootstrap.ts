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
import { runGlobalInstallMigrationPass, type MigrationPassResult } from '../grove/global-install-migration.js';
import {
  runGlobalConfigMigration,
  type GlobalConfigMigrationResult,
} from '../grove/global-config-migration.js';
import { ensureDefaultGrove, type GroveRecord } from '../grove/registry.js';

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
  /**
   * The default Grove for this daemon's variant. Created on first
   * bootstrap; idempotent thereafter. Projects auto-register into this
   * Grove on first hook (Decision 3).
   */
  defaultGrove: GroveRecord;
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
 * Ensure the machine is in a state where projects can auto-register on
 * first hook. Specifically:
 *
 *   1. The default Grove for this daemon's variant exists.
 *   2. The two global launchers (`~/.myco/launcher.cjs` +
 *      `~/.myco/mcp-launcher.cjs`) are present and current.
 *   3. Every detected agent has the global Myco config installed.
 *   4. Any per-project legacy install artifacts left over from
 *      pre-global-install Myco are migrated.
 *
 * Order is load-bearing:
 *
 *   - **Default Grove FIRST.** Hooks that fire before the Grove exists
 *     would call `ensureProjectRegistered`, which silently returns null
 *     when no default Grove is set (capture loss). Creating the Grove
 *     before installing launchers + symbionts guarantees the receiving
 *     end is ready by the time any agent sends its first hook.
 *   - Launchers SECOND per the Decision 8 write-ordering invariant:
 *     launchers must exist on disk before any agent's hook config
 *     points at them.
 *   - Symbiont installs THIRD — they write the hook configs that
 *     reference the launcher paths.
 *   - Migration walker LAST — it operates on already-registered
 *     projects and doesn't depend on launcher state.
 *
 * Variant-aware: `MYCO_SERVICE_VARIANT=dev` produces a `default-dev`
 * Grove with `served_by=service-dev`; unset or `service` produces
 * `default` / `service`. Dev and prod daemons can coexist on the same
 * machine — each has its own default Grove.
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
 * the same `defaultGrove`, `launchers.written === []`, per-symbiont
 * `'already-configured'` results, and `migration.projectsCleaned === 0`.
 */
export function runGlobalBootstrap(
  packageRoot: string = resolvePackageRoot(),
): BootstrapResult {
  const variant = process.env.MYCO_SERVICE_VARIANT?.trim();
  const servedBy = variant === 'dev' ? 'service-dev' : 'service';
  const defaultGrove = ensureDefaultGrove(undefined, { servedBy });
  const launchers = installGlobalLaunchers();
  const symbionts = runSymbiontDetection(packageRoot);
  // Per-project global-install migration. Sentinel-gated: projects
  // already migrated return alreadyDone immediately. Hot path on every
  // bootstrap is a stat per registered project; the cold path (legacy
  // project not yet migrated) runs the archive + strip + sentinel-write
  // sequence once. Scope is enforced by listing only Groves THIS
  // DAEMON SERVES — cross-variant mutation is forbidden by the same
  // rule that gates SQLite access.
  const migration = runGlobalInstallMigrationPass({ packageRoot });
  const globalConfigMigration = runGlobalConfigMigration();
  return { defaultGrove, launchers, symbionts, migration, globalConfigMigration };
}
