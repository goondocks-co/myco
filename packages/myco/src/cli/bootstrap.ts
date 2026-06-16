/**
 * Global bootstrap + symbiont detection.
 *
 * Two functions, split by *when* migration runs:
 *
 *   - `runGlobalBootstrap()` — ensure this variant's default Grove,
 *     clean up retired launcher trampolines, run a detection pass, AND
 *     walk every registered
 *     project for legacy per-project install artifacts. Migration is
 *     fire-once-per-project: it runs at daemon first-start and on
 *     auto-Grove-create when a fresh project registers. Explicit retry
 *     happens via `myco doctor --fix`. This entry MUST NOT be called on
 *     the hourly tick — re-running the migration walker every hour
 *     normalizes failure as ongoing operational state. Failures land in
 *     the bounded migration audit log and surface as doctor warnings.
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
import {
  removeRetiredGlobalLaunchers,
  type RetiredLauncherReport,
} from '../grove/launcher-cleanup.js';
import { runGlobalInstallMigrationPass, type MigrationPassResult } from '../grove/global-install-migration.js';
import {
  runGlobalConfigMigration,
  type GlobalConfigMigrationResult,
} from '../grove/global-config-migration.js';
import {
  ensureDefaultGrove,
  resolveDefaultGroveForVariant,
  type DaemonVariant,
  type GroveRecord,
} from '../grove/registry.js';
import { daemonVariantFromEnvValue, resolveMycoHome } from '../grove/paths.js';

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
  /** Retired launcher trampolines deleted this pass (empty when none lingered). */
  launchers: RetiredLauncherReport;
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

export interface GlobalBootstrapStartupDecision {
  shouldRun: boolean;
  defaultGroveAbsent: boolean;
  servedBy: DaemonVariant;
  mycoHome: string;
}

/**
 * Startup bootstrap is needed when this daemon variant lacks its default
 * Grove. The default Grove is the durable "has this variant bootstrapped"
 * signal — it persists across daemon restarts, and dev/prod each own a
 * distinct one (so service-dev still bootstraps on a machine where prod has
 * already run). Launcher presence is NOT a trigger: the launcher
 * unification retired the global trampolines, and bootstrap's cleanup step
 * deletes any that linger — keying on their absence would re-run bootstrap
 * (and its migration walker) on every start.
 */
export function shouldRunGlobalBootstrap(
  mycoHome: string = resolveMycoHome(),
  servedBy: DaemonVariant = daemonVariantFromEnvValue(process.env.MYCO_SERVICE_VARIANT),
): GlobalBootstrapStartupDecision {
  const defaultGroveAbsent = resolveDefaultGroveForVariant(mycoHome, { servedBy }) === null;
  return {
    shouldRun: defaultGroveAbsent,
    defaultGroveAbsent,
    servedBy,
    mycoHome,
  };
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
 *   2. Any retired global launcher trampolines (`~/.myco/launcher.cjs` +
 *      `~/.myco/mcp-launcher.cjs`) left by a previous release are deleted.
 *   3. Every detected agent has the global Myco config installed.
 *   4. Any per-project legacy install artifacts left over from
 *      pre-global-install Myco are migrated.
 *
 * Order is load-bearing:
 *
 *   - **Default Grove FIRST.** Hooks that fire before the Grove exists
 *     would call `ensureProjectRegistered`, which silently returns null
 *     when no default Grove is set (capture loss). Creating the Grove
 *     before installing symbionts guarantees the receiving end is ready
 *     by the time any agent sends its first hook.
 *   - Launcher cleanup SECOND — it deletes inert orphan files; ordering
 *     relative to the symbiont installs no longer matters (nothing
 *     executes the deleted files), but it stays here for continuity.
 *   - Symbiont installs THIRD — they write the hook configs that invoke
 *     the binary directly.
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
 * directly rather than this function — re-running the walker every hour
 * treats failures as retry-next-hour instead of failures to fix.
 *
 * Idempotent — a re-invocation against a populated `~/.myco/` returns
 * the same `defaultGrove`, `launchers.removed === []`, per-symbiont
 * `'already-configured'` results, and `migration.projectsCleaned === 0`.
 */
export function runGlobalBootstrap(
  packageRoot: string = resolvePackageRoot(),
): BootstrapResult {
  const servedBy = daemonVariantFromEnvValue(process.env.MYCO_SERVICE_VARIANT);
  const defaultGrove = ensureDefaultGrove(undefined, { servedBy });
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
  // Delete retired launcher trampolines LAST — only after detection has
  // rewritten every detected agent's hook/MCP config onto the binary and the
  // config migration scrubbed escaped references. Deleting earlier would orphan
  // a config not yet rewritten in this pass (capture-loss window); by here no
  // config references `~/.myco/launcher.cjs`, so removing it is safe.
  const launchers = removeRetiredGlobalLaunchers();
  return { defaultGrove, launchers, symbionts, migration, globalConfigMigration };
}
