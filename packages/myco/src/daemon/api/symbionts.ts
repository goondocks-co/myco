import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { loadConfig, loadMergedConfig, getEnabledSymbiontNames, TierConfigUnreadableError } from '../../config/loader.js';
import type { RouteHandler, RouteResponse } from '../router.js';
import { detectSymbiontInjectionSupport } from '@myco/symbionts/injection-support.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { findRegisteredProject } from '@myco/grove/registry.js';
import { resolveMycoHome } from '@myco/grove/paths.js';
import { runGlobalInstallMigrationPass } from '@myco/grove/global-install-migration.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { getDatabase } from '@myco/db/client.js';
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

  // -------------------------------------------------------------------
  // Capability profile — drives the chip set on the Symbionts page.
  // Each field maps to a single Myco feature: the UI is purely
  // declarative over these booleans (see capability-map.ts).
  // Derived from the manifest at request time; not stored.
  // -------------------------------------------------------------------

  /** Records prompts/tool-uses/responses (Sessions feature). */
  supportsSessions: boolean;
  /** Canopy file-read context injection on PreToolUse hooks. */
  supportsCanopyInjection: boolean;
  /** Cortex primer injection when this symbiont starts a subagent. */
  supportsSubagentStartInjection: boolean;
  /** Plans the symbiont writes are picked up automatically. */
  supportsPlanCapture: boolean;
  /** Myco's skills are exposed inside the symbiont. */
  supportsSkills: boolean;
  /** Myco's MCP server is reachable from the symbiont. */
  supportsMcp: boolean;

  /**
   * Live MCP status. Only present when `supportsMcp === true`.
   *   - `true` — at least one Myco MCP tool call observed from a
   *     session of this symbiont in the last 7 days (per-machine,
   *     aggregated across the daemon's Groves).
   *   - `false` — MCP wired but no recent traffic.
   *   - omitted — `supportsMcp === false`.
   */
  mcpActive?: boolean;

  /**
   * Per-project override block, when the project's `myco.yaml`
   * explicitly sets `symbionts.<name>`. Absent when the project has no
   * override (the effective `enabled` value comes from the global
   * default). The UI uses this to render an "override active" affordance
   * + the reset action.
   */
  projectOverride?: { enabled: boolean };
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

  // Project-only view (no merge) — used to detect which symbionts have
  // an explicit project override. A symbiont without an entry here gets
  // its effective `enabled` from the global default; one with an entry
  // shows the reset affordance.
  let projectOverrides: Record<string, { enabled: boolean }> = {};
  try {
    const projectCfg = loadConfig(vaultDir);
    projectOverrides = (projectCfg.symbionts ?? {}) as Record<string, { enabled: boolean }>;
  } catch { /* config not loadable */ }

  // MCP live status is computed once per request and applied to every
  // Symbiont that supports MCP. Single scan across the bound Grove's
  // activity log avoids N round-trips to SQLite per request.
  const mcpActiveByAgent = scanMcpActiveSymbionts(groveId);

  return manifests.map((manifest) => {
    const detector = new SymbiontInstaller(
      manifest, '/', pkgRoot, false, undefined, null, 'global',
    );
    const detected = detector.isAvailableForScope();
    const globallyInstalled = detected && detector.isConfigured();

    const reg = manifest.registration;
    const supportsSessions = !!reg?.hooksTarget || !!reg?.globalHooksTarget;
    const supportsCanopyInjection =
      (manifest.capabilities?.preToolUseInjection ?? false)
      && ((manifest.capabilities?.canopyReadTools?.length ?? 0) > 0);
    const supportsSubagentStartInjection = manifest.capabilities?.subagentStartInjection ?? false;
    // Plans surface counts either mechanism: filesystem watch (`planDirs`)
    // or transcript tag extraction (`planTags`).
    const supportsPlanCapture =
      (manifest.capture?.planDirs?.length ?? 0) > 0
      || (manifest.capture?.planTags?.length ?? 0) > 0;
    const supportsSkills = !!reg?.skillsTarget || !!reg?.globalSkillsTarget;
    const supportsMcp = !!reg?.mcpTarget || !!reg?.globalMcpTarget;

    return {
      name: manifest.name,
      displayName: manifest.displayName,
      binary: manifest.binary,
      enabled: enabledNames ? enabledNames.has(manifest.name) : true,
      detected,
      globallyInstalled,
      ...(manifest.resumeCommand ? { resumeCommand: manifest.resumeCommand } : {}),
      ...detectSymbiontInjectionSupport(manifest),
      supportsSessions,
      supportsCanopyInjection,
      supportsSubagentStartInjection,
      supportsPlanCapture,
      supportsSkills,
      supportsMcp,
      ...(supportsMcp ? { mcpActive: mcpActiveByAgent.get(manifest.name) ?? false } : {}),
      ...(projectOverrides[manifest.name]
        ? { projectOverride: { enabled: !!projectOverrides[manifest.name].enabled } }
        : {}),
    };
  });
}

/**
 * Scan the REQUEST'S Grove DB for recent Myco MCP tool calls, grouped
 * by symbiont (`sessions.agent`). A symbiont is "active" when any
 * session of that symbiont has fired at least one Myco MCP tool
 * within the look-back window.
 *
 * DB scoping: `getDatabase()` returns the AsyncLocalStorage-scoped
 * DB when one is bound (the daemon's request handlers bind the
 * request's Grove DB via `scopedDatabase`). Falling back to the
 * singleton matches the daemon's own bound Grove. The caller passes
 * the requested groveId for documentation and forward-compatibility
 * if we ever need an explicit-DB-handle variant.
 *
 * Best-effort: if the database isn't reachable, returns an empty
 * map and every symbiont reports `mcpActive: false`. The UI
 * surfaces this as "configured but quiet" — never as an error.
 */
const MCP_ACTIVE_WINDOW_SECONDS = 7 * 24 * 60 * 60;
function scanMcpActiveSymbionts(_requestedGroveId: string | null | undefined): Map<string, boolean> {
  const active = new Map<string, boolean>();
  try {
    const db = getDatabase();
    const cutoff = Math.floor(Date.now() / 1000) - MCP_ACTIVE_WINDOW_SECONDS;
    const rows = db
      .prepare(
        `SELECT DISTINCT s.agent
           FROM activities a
           JOIN sessions s ON s.id = a.session_id
          WHERE a.tool_name LIKE 'myco_%'
            AND a.timestamp > ?`,
      )
      .all(cutoff) as Array<{ agent: string }>;
    for (const row of rows) active.set(row.agent, true);
  } catch {
    // No DB or query failed — fall through; every MCP-capable symbiont
    // reports `mcpActive: false`. Acceptable degradation: "configured
    // but quiet" reads the same to the user.
  }
  return active;
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
  const symbionts = listSymbiontInfos(vaultDir, groveId);
  // Project-level customization is active when the project's myco.yaml
  // carries an explicit `symbionts:` block (any entry). When inactive,
  // the project follows global defaults and per-symbiont overrides are
  // not meaningful — surfaced to the UI as a page-level toggle.
  let projectCustomizationActive = false;
  try {
    const projectCfg = loadConfig(vaultDir);
    projectCustomizationActive = !!projectCfg.symbionts && Object.keys(projectCfg.symbionts).length > 0;
  } catch { /* config not loadable */ }
  return { body: { symbionts, projectCustomizationActive } };
}

/**
 * Trigger an on-demand symbiont detection + bootstrap pass.
 *
 * Routes through `runGlobalBootstrap` — the documented single side-effect
 * entry point for "wire up Myco's global state." Same code path as the
 * daemon first-start handler, the PowerManager periodic tick, and the
 * version-drift handler:
 *
 *   - `removeRetiredGlobalLaunchers`: delete any retired launcher
 *     trampolines (`~/.myco/launcher.cjs` + `mcp-launcher.cjs`) left by a
 *     previous release (idempotent; the binary is the launcher now).
 *   - `runSymbiontDetection`: install Myco's global config into every
 *     detected symbiont.
 *   - `runGlobalInstallMigrationPass`: walk every registered project and
 *     strip stale per-project Myco state. The strip is unconditional —
 *     the global model has no project-local install to preserve, and the
 *     `symbionts:` block is a capture-time opt-out, not an install switch.
 *     Without this step here the UI's "Re-detect now" button skipped the
 *     walker entirely — a real defect the unit tests missed because they
 *     hit `runSymbiontDetection` directly.
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
 * Wraps `runGlobalInstallMigrationPass()` — the same code path the daemon's
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
  const pass = runGlobalInstallMigrationPass();
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
export function createProjectSymbiontsPatchHandler(_daemonStateDir: string): RouteHandler {
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
      // `null` entries already handled above. Translate object entries
      // into the capability's SymbiontOverride shape. The batch method
      // runs ONE updateConfig for the whole patch, preserving the
      // atomicity contract the pre-capability handler relied on.
      sanitized[name] = { enabled: enabledRaw ?? true };
    }

    const vault = new ProjectVault(found.project.root);
    let updated;
    try {
      updated = vault.patchSymbiontOverrides(
        sanitized as Record<string, { enabled: boolean } | null>,
      );
    } catch (err) {
      if (err instanceof TierConfigUnreadableError) {
        return { status: 422, body: errorBody('tier_config_unreadable', err.message) };
      }
      return { status: 500, body: errorBody('patch_failed', (err as Error).message) };
    }
    return { body: { symbionts: updated.symbionts ?? {} } };
  };
}

/**
 * Toggle per-project symbiont customization as a whole.
 *
 *   PUT /projects/:projectId/symbionts-customization
 *   Body: { "enabled": true | false }
 *
 *   true  — ensure the project's myco.yaml has a `symbionts:` block,
 *           pre-populated with every detected symbiont set to enabled.
 *           Per-symbiont toggles in the UI then become meaningful.
 *   false — REMOVE the `symbionts:` block entirely. Project follows
 *           global defaults. Idempotent.
 */
export function createProjectSymbiontsCustomizationHandler(_daemonStateDir: string): RouteHandler {
  return async (req) => {
    const projectId = req.params.projectId;
    const mycoHome = resolveMycoHome();
    const found = findRegisteredProject({ projectId }, mycoHome);
    if (!found) {
      return { status: 404, body: errorBody('project_not_found', `Project ${projectId} is not registered in any Grove`) };
    }
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      return { status: 400, body: errorBody('invalid_body', 'Body must include `enabled: boolean`') };
    }
    const seed = body.enabled ? loadManifests().map((m) => m.name) : undefined;
    const vault = new ProjectVault(found.project.root);
    try {
      const updated = vault.setProjectCustomization(body.enabled, seed);
      return {
        body: {
          projectCustomizationActive: !!updated.symbionts && Object.keys(updated.symbionts).length > 0,
          symbionts: updated.symbionts ?? {},
        },
      };
    } catch (err) {
      return { status: 500, body: errorBody('customization_failed', (err as Error).message) };
    }
  };
}
