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
  resolveDefaultGrove,
  type GroveRecord,
} from '../grove/registry.js';
import { resolveMycoHome } from '../grove/paths.js';
import { shouldDeferSubsystem, SYMBIONT_CONFIG_SUBSYSTEM } from '../grove/subsystem-claim.js';
import { ensureManagedSkills } from '../symbionts/managed-skills.js';

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
  mycoHome: string;
}

/**
 * Startup bootstrap is needed when this home lacks a default Grove.
 * The default Grove is the durable "has this daemon bootstrapped" signal
 * — it persists across daemon restarts. Launcher presence is NOT a
 * trigger: the launcher unification retired the global trampolines, and
 * bootstrap's cleanup step deletes any that linger — keying on their
 * absence would re-run bootstrap (and its migration walker) on every start.
 */
export function shouldRunGlobalBootstrap(
  mycoHome: string = resolveMycoHome(),
): GlobalBootstrapStartupDecision {
  const defaultGroveAbsent = resolveDefaultGrove(mycoHome) === null;
  return {
    shouldRun: defaultGroveAbsent,
    defaultGroveAbsent,
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
  // Seed the managed skills dir (`<mycoHome>/skills`) from the binary-embedded
  // bundle before linking, so global skill symlinks resolve to a stable managed
  // target instead of a checkout. This is the chokepoint every global-install
  // entry funnels through (first-start bootstrap, the hourly detection tick,
  // `myco doctor --fix`, `myco update`). Gated by the same subsystem-claim
  // deferral as the per-symbiont config writes so a dogfood daemon (which
  // defers to the prod claim) can't overwrite the managed skills.
  const manifests = loadManifests();
  const deferGlobal = shouldDeferSubsystem(SYMBIONT_CONFIG_SUBSYSTEM);
  if (!deferGlobal) {
    ensureManagedSkills(resolveMycoHome());
  }
  const results: DetectionResult[] = [];
  for (const manifest of manifests) {
    // `projectRoot` is unused in global scope — every operation that
    // touches it (AGENTS.md, .gitignore, instructions) is skipped. The
    // SymbiontInstaller takes the value through its constructor for
    // backward compatibility with the project path.
    const installer = new SymbiontInstaller(
      manifest, '/', packageRoot, false, undefined, null, 'global',
    );
    // Sweep this agent's retired global skill dirs (links left behind after a
    // `globalSkillsTarget` migration, often dangling into a deleted checkout).
    // Runs for EVERY manifest, not just detected ones — a retired link can
    // outlive the agent's detectionDir. Gated by the same claim deferral.
    if (!deferGlobal) installer.sweepRetiredGlobalSkills();
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
 * Home-aware: each `MYCO_HOME` has its own `groves/` tree; daemons in
 * distinct homes coexist without conflict.
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
  const defaultGrove = ensureDefaultGrove();
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
