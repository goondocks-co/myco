import fs from 'node:fs';
import path from 'node:path';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { loadMergedConfig, getEnabledSymbiontNames, updateConfig } from '../../config/loader.js';
import type { RouteHandler, RouteResponse } from '../router.js';
import { detectSymbiontInjectionSupport } from '@myco/symbionts/injection-support.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { findRegisteredProject } from '@myco/grove/registry.js';
import { resolveMycoHome, resolveProjectVaultDir, resolveServiceDirName } from '@myco/grove/paths.js';
import { runProjectLocalMigration } from '@myco/grove/migration-walker.js';
import { ensureVaultGitignoreCurrent } from '@myco/vault/gitignore.js';
import { errorBody } from './error-envelope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public manifest fields exposed via the API (no internal hook config). */
export interface SymbiontInfo {
  name: string;
  displayName: string;
  binary: string;
  enabled: boolean;
  resumeCommand?: string;
  supportsSessionStartInjection: boolean;
  supportsPromptSubmitInjection: boolean;
  /**
   * Whether the agent appears installed on this machine — manifest
   * `detectionDir` exists. The basis for global-config wiring.
   */
  detected: boolean;
  /**
   * Whether Myco's global config block is present in the agent's
   * user-global config file. True when the agent's
   * `globalHooksTarget` file contains a Myco hook entry.
   */
  globallyInstalled: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function listSymbiontInfos(vaultDir: string, groveId?: string | null): SymbiontInfo[] {
  const manifests = loadManifests();
  const pkgRoot = resolvePackageRoot();

  let enabledNames: Set<string> | null = null;
  try {
    enabledNames = getEnabledSymbiontNames(loadMergedConfig(vaultDir, { groveId: groveId ?? null }));
  } catch { /* config not loadable */ }

  return manifests.map((manifest) => {
    const detector = new SymbiontInstaller(
      manifest, '/', pkgRoot, false, undefined, null, 'global',
    );
    const detected = detector.isAvailableForScope();
    const globallyInstalled = detected && detector.isConfigured();
    return {
      name: manifest.name,
      displayName: manifest.displayName,
      binary: manifest.binary,
      enabled: enabledNames ? enabledNames.has(manifest.name) : true,
      detected,
      globallyInstalled,
      ...(manifest.resumeCommand ? { resumeCommand: manifest.resumeCommand } : {}),
      ...detectSymbiontInjectionSupport(manifest),
    };
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * List all registered symbiont manifests with their enabled state.
 *
 * Returns the public-facing subset of each manifest — enough for the UI
 * to build resume commands, display agent names, and show enabled state.
 * When the config lacks a `symbionts` section (pre-existing installs),
 * all manifests default to `enabled: true`.
 */
export async function handleListSymbionts(vaultDir: string, groveId?: string | null): Promise<RouteResponse> {
  return { body: { symbionts: listSymbiontInfos(vaultDir, groveId) } };
}

/**
 * Trigger an on-demand symbiont detection + bootstrap pass.
 *
 * Routes through `runGlobalBootstrap` — the documented single side-effect
 * entry point for "wire up Myco's global state." Same code path as the
 * daemon first-start handler, the PowerManager periodic tick, and the
 * version-drift handler:
 *
 *   - `installGlobalLaunchers`: write `~/.myco/launcher.cjs` +
 *     `mcp-launcher.cjs` (idempotent; content-diff gated).
 *   - `runSymbiontDetection`: install Myco's global config into every
 *     detected symbiont.
 *   - `runProjectLocalMigration`: walk every registered project and
 *     strip stale per-project Myco state, honoring the `symbionts:`
 *     opt-in. Without this step here the UI's "Re-detect now" button
 *     skipped the walker entirely — a real defect the unit tests
 *     missed because they hit `runSymbiontDetection` directly.
 *
 * Returns `results` (per-symbiont install outcomes) and `migration`
 * (per-project walker outcomes) so the UI can surface both.
 */
export async function handleDetectSymbionts(vaultDir: string, groveId?: string | null): Promise<RouteResponse> {
  const { runGlobalBootstrap } = await import('../../cli/bootstrap.js');
  const bootstrap = runGlobalBootstrap();
  return {
    body: {
      results: bootstrap.symbionts,
      migration: bootstrap.migration,
      symbionts: listSymbiontInfos(vaultDir, groveId),
    },
  };
}

/**
 * Drain the brownfield migration-walker queue on demand.
 *
 * Wraps `runProjectLocalMigration()` — the same code path the daemon's
 * first-start handler and the PowerManager periodic tick run. Surfaced
 * as an explicit UI button so users don't have to wait for the next
 * tick when they've just committed Myco config to a repo or rebound
 * a project between Groves.
 *
 * Mirrors the audit-log call from `daemon/main.ts`: every walker
 * invocation persists a pass-summary row so `myco doctor` and the
 * Operations page can surface per-project errors. A UI-triggered sweep
 * that errored on a project is exactly the signal the audit log
 * exists to capture; skipping it here would silently break that
 * invariant.
 */
export async function handleDrainMigration(): Promise<RouteResponse> {
  const pass = runProjectLocalMigration();
  try {
    const { getDatabase } = await import('../../db/client.js');
    const { recordMigrationPass } = await import('../../db/queries/migration-log.js');
    recordMigrationPass(getDatabase(), pass);
  } catch {
    // Audit-log write is best-effort here: the walker outcome still
    // returns to the caller. The daemon-startup path logs failures
    // explicitly; this handler is exercised from the dashboard where
    // the response already carries the same data the audit row would.
  }
  return { body: { migration: pass } };
}

/**
 * Patch the per-project `symbionts:` block in the project's myco.yaml.
 *
 * Each key in the body's `symbionts` object overrides the matching
 * manifest entry's `enabled` state for THIS project; absent keys are
 * left untouched. Names are validated against `loadManifests()` — a
 * symbiont that no longer ships is rejected at the gate rather than
 * persisted as an orphan block.
 *
 * Routes through `updateConfig()` (single-config-write-path invariant).
 */
export function createProjectSymbiontsPatchHandler(daemonStateDir: string): RouteHandler {
  return async (req) => {
    const projectId = req.params.projectId;
    const mycoHome = resolveMycoHome();
    const found = findRegisteredProject({ projectId }, mycoHome);
    if (!found) {
      return {
        status: 404,
        body: errorBody('project_not_found', `Project ${projectId} is not registered in any Grove`),
      };
    }
    const variant = resolveServiceDirName(daemonStateDir, mycoHome);
    if (found.grove.served_by !== variant) {
      return {
        status: 404,
        body: errorBody('project_not_found', `Project ${projectId} is not registered in any Grove`),
      };
    }

    const body = (req.body ?? {}) as { symbionts?: Record<string, unknown> };
    const incoming = body.symbionts;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return {
        status: 400,
        body: errorBody('invalid_body', 'Body must include a `symbionts` object: { <name>: { enabled: boolean } | null }'),
      };
    }

    const knownNames = new Set(loadManifests().map((m) => m.name));
    const unknown = Object.keys(incoming).filter((name) => !knownNames.has(name));
    if (unknown.length > 0) {
      return {
        status: 400,
        body: errorBody('unknown_symbiont', `Unknown symbiont(s): ${unknown.join(', ')}`),
      };
    }

    // Per-entry shape check. Each value must be `null` (delete the
    // override) or a plain object with an optional boolean `enabled`.
    // Raw booleans, strings, or numbers slip past the outer object
    // guard but would either crash on `.enabled` deref or silently
    // invert the caller's intent via `?? true` in the merge below.
    const sanitized: Record<string, { enabled?: boolean } | null> = {};
    for (const [name, entry] of Object.entries(incoming)) {
      if (entry === null) {
        sanitized[name] = null;
        continue;
      }
      if (typeof entry !== 'object' || Array.isArray(entry)) {
        return {
          status: 400,
          body: errorBody(
            'invalid_entry',
            `symbionts.${name} must be an object { enabled?: boolean } or null`,
          ),
        };
      }
      const enabledRaw = (entry as { enabled?: unknown }).enabled;
      if (enabledRaw !== undefined && typeof enabledRaw !== 'boolean') {
        return {
          status: 400,
          body: errorBody(
            'invalid_entry',
            `symbionts.${name}.enabled must be a boolean if provided`,
          ),
        };
      }
      sanitized[name] = enabledRaw === undefined ? {} : { enabled: enabledRaw };
    }

    const projectVaultDir = resolveProjectVaultDir(found.project.root);
    // A project that's only auto-registered may not have a myco.yaml
    // yet — this PATCH is itself the first reason to create one. Seed
    // a minimal version-3 doc so `loadConfig` succeeds; schema defaults
    // fill every other section. Pair the file creation with a gitignore
    // refresh so per-machine state (daemon.json, project.local.toml,
    // buffer/) can't be staged on the user's next `git add .myco`.
    const configPath = path.join(projectVaultDir, 'myco.yaml');
    if (!fs.existsSync(configPath)) {
      fs.mkdirSync(projectVaultDir, { recursive: true });
      fs.writeFileSync(configPath, 'version: 3\n', { mode: 0o600 });
    }
    ensureVaultGitignoreCurrent(projectVaultDir);
    try {
      const updated = updateConfig(projectVaultDir, (config) => {
        const next = { ...config };
        const symbionts = { ...(config.symbionts ?? {}) };
        for (const [name, entry] of Object.entries(sanitized)) {
          if (entry === null) {
            delete symbionts[name];
            continue;
          }
          symbionts[name] = { ...symbionts[name], enabled: entry.enabled ?? true };
        }
        next.symbionts = symbionts;
        return next;
      });
      return { body: { symbionts: updated.symbionts ?? {} } };
    } catch (err) {
      return { status: 500, body: errorBody('patch_failed', (err as Error).message) };
    }
  };
}
