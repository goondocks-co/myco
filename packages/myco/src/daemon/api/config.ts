import {
  loadConfig,
  updateConfig,
  updateLocalConfig,
  loadMergedConfig,
  loadLocalConfig,
  loadGroveConfig,
  saveGroveConfig,
  loadMachineConfig,
  saveMachineConfig,
  deepMergeConfig,
  migrateLegacyLocalAppearanceToGrove,
} from '../../config/loader.js';
import { z } from 'zod';
import {
  MycoConfigSchema,
  GroveConfigSchema,
  MachineConfigSchema,
  type MycoConfig,
  type GroveConfig,
  type MachineConfig,
} from '../../config/schema.js';
import { getAtPath, setAtPath, unsetAtPath } from '../../utils/dot-path.js';
import { enumerateLeafPaths } from '../config-reactions/touched-paths.js';
import type { RouteRequest, RouteResponse } from '../router.js';

export async function handleGetConfig(vaultDir: string): Promise<RouteResponse> {
  const config = loadConfig(vaultDir);
  return { body: config };
}

// ---------------------------------------------------------------------------
// Scoped config handlers (project vs. local overlay)
// ---------------------------------------------------------------------------

/** GET /api/config/merged — full four-tier merge (machine + grove + project + personal). */
export async function handleGetMergedConfig(
  vaultDir: string,
  options: { groveId?: string | null } = {},
): Promise<RouteResponse> {
  const config = loadMergedConfig(vaultDir, { groveId: options.groveId ?? null });
  return { body: config };
}

/** GET /api/config/local — raw local overrides (may be empty). */
export async function handleGetLocalConfig(
  vaultDir: string,
  options: { groveId?: string | null } = {},
): Promise<RouteResponse> {
  if (options.groveId !== undefined) {
    migrateLegacyLocalAppearanceToGrove(vaultDir, options.groveId ?? null);
  }
  return { body: loadLocalConfig(vaultDir) };
}

// ---------------------------------------------------------------------------
// List-delta op types — shared by scoped + tier config PUT handlers
// ---------------------------------------------------------------------------

interface ListDeltaEntry {
  path: string;
  values: unknown[];
}

interface ScopedPutBody {
  scope?: 'project' | 'local';
  patch?: Record<string, unknown>;
  clear?: string[];
  /** Add values to the named array path (deduped, server-side read-modify-write). */
  addToList?: ListDeltaEntry[];
  /** Remove values from the named array path (server-side read-modify-write). */
  removeFromList?: ListDeltaEntry[];
}

const SCOPED_CONFIG_SCOPES = ['project', 'local'] as const;

function isScopedConfigScope(value: unknown): value is ScopedPutBody['scope'] {
  return typeof value === 'string'
    && (SCOPED_CONFIG_SCOPES as readonly string[]).includes(value);
}

function validateClearList(clear: unknown): string[] | RouteResponse {
  if (clear === undefined) return [];
  if (!Array.isArray(clear)) {
    return { status: 400, body: { error: 'clear must be an array of dot-paths' } };
  }
  const invalidEntry = clear.find((entry) => typeof entry !== 'string' || entry.trim().length === 0);
  if (invalidEntry !== undefined) {
    return { status: 400, body: { error: 'clear entries must be non-empty strings' } };
  }
  return clear;
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * PUT /api/config/scoped — atomic patch + clear + list-delta against project or local config.
 *
 * Request body:
 *   { scope: 'project' | 'local',
 *     patch?: DeepPartial<MycoConfig>,              // deep-merged into scope
 *     clear?: string[],                              // dot-paths removed from scope
 *     addToList?: [{ path, values }],                // set-union additions (deduped)
 *     removeFromList?: [{ path, values }] }          // set-difference removals
 *
 * At least one of patch/clear/addToList/removeFromList must be non-empty. When
 * both patch and clear are present, overlapping keys are rejected (400). The
 * server applies clear first, then patch, then list deltas, in a single write.
 */
export async function handlePutScopedConfig(vaultDir: string, body: unknown): Promise<RouteResponse> {
  const payload = (body ?? {}) as ScopedPutBody;
  if (!isScopedConfigScope(payload.scope)) {
    return { status: 400, body: { error: 'scope must be project or local' } };
  }
  const scope = payload.scope;
  const patch = payload.patch ?? {};
  const clearListOrError = validateClearList(payload.clear);
  if (Array.isArray(clearListOrError) === false) return clearListOrError;
  const clearList = clearListOrError;

  const addOpsOrError = validateListDeltaOps(payload.addToList);
  if (!Array.isArray(addOpsOrError)) return addOpsOrError;
  const removeOpsOrError = validateListDeltaOps(payload.removeFromList);
  if (!Array.isArray(removeOpsOrError)) return removeOpsOrError;

  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { status: 400, body: { error: 'patch must be an object' } };
  }
  const patchLeaves = enumerateLeafPaths(patch);
  const hasPatch = patchLeaves.length > 0;
  const hasClear = clearList.length > 0;
  const hasListOps = addOpsOrError.length > 0 || removeOpsOrError.length > 0;
  if (!hasPatch && !hasClear && !hasListOps) {
    return { status: 400, body: { error: 'patch or clear required' } };
  }

  const overlap = patchLeaves.filter((leaf) => clearList.some((clearPath) => pathsOverlap(leaf, clearPath)));
  if (overlap.length > 0) {
    return { status: 400, body: { error: 'patch_clear_overlap', keys: overlap } };
  }
  const appearancePaths = [
    ...patchLeaves.filter((leaf) => pathsOverlap(leaf, 'appearance')),
    ...clearList.filter((clearPath) => pathsOverlap(clearPath, 'appearance')),
  ];
  if (appearancePaths.length > 0) {
    return {
      status: 400,
      body: {
        error: 'appearance_is_grove_scoped',
        message: 'appearance settings must be written through Grove config',
        keys: appearancePaths,
      },
    };
  }

  if (scope === 'local') {
    try {
      const project = loadConfig(vaultDir);
      const updated = updateLocalConfig(vaultDir, (local) => {
        const working = structuredClone(local) as Record<string, unknown>;
        for (const key of clearList) unsetAtPath(working, key);
        const withPatch = deepMergeConfig(
          working,
          patch as Record<string, unknown>,
        ) as Partial<MycoConfig> & { config_version?: unknown };
        applyListDeltas(withPatch as Record<string, unknown>, addOpsOrError, removeOpsOrError);
        const merged = deepMergeConfig(
          project as Record<string, unknown>,
          withPatch as Record<string, unknown>,
        );
        MycoConfigSchema.parse(merged);
        // config_version is a migration-bookkeeping key that belongs to the
        // project tier, not the personal overlay. Strip it from the persisted
        // local doc so it never appears in local.yaml as a stale artifact of
        // a prior migration run.
        delete withPatch.config_version;
        return withPatch;
      });
      return { body: updated };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return { status: 400, body: { error: 'validation_failed', issues: err.issues } };
      }
      throw err;
    }
  }

  try {
    // saveConfig (called by updateConfig) runs the Zod parse — the callback
    // returns the deep-merged object without validating, and any invalid
    // shape raises a ZodError that we convert to a 400 below.
    const updated = updateConfig(vaultDir, (current) => {
      const working = structuredClone(current) as Record<string, unknown>;
      for (const key of clearList) unsetAtPath(working, key);
      const withPatch = deepMergeConfig(working, patch as Record<string, unknown>) as Record<string, unknown>;
      applyListDeltas(withPatch, addOpsOrError, removeOpsOrError);
      return withPatch as MycoConfig;
    });
    return { body: updated };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { status: 400, body: { error: 'validation_failed', issues: err.issues } };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Grove-tier config handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/grove-config — return the current Grove's config.
 *
 * Sources `groveId` from the request context (x-myco-grove-id header).
 * Returns 404 when no Grove is bound — UI surfaces that as the
 * "pick a project" placeholder.
 */
export async function handleGetGroveConfig(
  groveId: string | null | undefined,
): Promise<RouteResponse> {
  if (!groveId) {
    return { status: 404, body: { error: 'no_grove_in_context' } };
  }
  const config = loadGroveConfig(groveId);
  return { body: { groveId, config } };
}

// ---------------------------------------------------------------------------
// List-delta ops — shared validation + application helpers
// ---------------------------------------------------------------------------

interface TierPutBody {
  patch?: Record<string, unknown>;
  /** Add values to the named array path (deduped, server-side read-modify-write). */
  addToList?: ListDeltaEntry[];
  /** Remove values from the named array path (server-side read-modify-write). */
  removeFromList?: ListDeltaEntry[];
}

function validateListDeltaOps(ops: unknown): ListDeltaEntry[] | RouteResponse {
  if (ops === undefined) return [];
  if (!Array.isArray(ops)) {
    return { status: 400, body: { error: 'addToList/removeFromList must be an array' } };
  }
  for (const op of ops) {
    if (typeof op !== 'object' || op === null) {
      return { status: 400, body: { error: 'each list op must be an object with path and values' } };
    }
    const { path, values } = op as Record<string, unknown>;
    if (typeof path !== 'string' || path.trim().length === 0) {
      return { status: 400, body: { error: 'list op path must be a non-empty string' } };
    }
    if (!Array.isArray(values)) {
      return { status: 400, body: { error: 'list op values must be an array' } };
    }
  }
  return ops as ListDeltaEntry[];
}

/**
 * Apply addToList / removeFromList deltas to a config object in-place.
 * Returns the dot-paths that were touched (for config-write reactions).
 *
 * - addToList: reads current array at path, appends values, deduplicates.
 * - removeFromList: reads current array at path, filters out values.
 * Non-array targets are replaced with an array (add) or treated as empty (remove).
 */
function applyListDeltas(
  working: Record<string, unknown>,
  addOps: ListDeltaEntry[],
  removeOps: ListDeltaEntry[],
): string[] {
  const touchedPaths: string[] = [];

  for (const op of addOps) {
    const existing = getAtPath(working, op.path);
    const arr = Array.isArray(existing) ? [...existing] : [];
    for (const v of op.values) {
      if (!arr.includes(v)) arr.push(v);
    }
    setAtPath(working, op.path, arr);
    touchedPaths.push(op.path);
  }

  for (const op of removeOps) {
    const existing = getAtPath(working, op.path);
    const arr = Array.isArray(existing) ? existing : [];
    setAtPath(working, op.path, arr.filter((v) => !op.values.includes(v)));
    touchedPaths.push(op.path);
  }

  return touchedPaths;
}

interface TierPutOptions<TConfig> {
  load: () => TConfig;
  save: (validated: TConfig) => void;
  validate: (merged: unknown) => TConfig;
  /** Optional patch sanitizer — strip fields the user can't write to this tier. */
  sanitizePatch?: (patch: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Shared PUT handler for tier config files (Grove, Machine). Loads
 * current, applies sanitized patch and any list-delta ops, validates,
 * persists, returns the canonical post-merge value plus touched leaf
 * paths so the caller can fire `applyConfigWriteReactions`.
 *
 * Request body may contain any combination of:
 *   patch          — deep-merged into the current config
 *   addToList      — [{ path, values }] set-union additions (deduped)
 *   removeFromList — [{ path, values }] set-difference removals
 * At least one of the three must be non-empty.
 */
async function handlePutTierConfig<TConfig>(
  body: unknown,
  options: TierPutOptions<TConfig>,
): Promise<{ response: RouteResponse; touchedPaths: string[] }> {
  const payload = (body ?? {}) as TierPutBody;

  const incoming = payload.patch ?? {};
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
    return {
      response: { status: 400, body: { error: 'patch must be an object' } },
      touchedPaths: [],
    };
  }

  const addOpsOrError = validateListDeltaOps(payload.addToList);
  if (!Array.isArray(addOpsOrError)) return { response: addOpsOrError, touchedPaths: [] };
  const removeOpsOrError = validateListDeltaOps(payload.removeFromList);
  if (!Array.isArray(removeOpsOrError)) return { response: removeOpsOrError, touchedPaths: [] };

  const patch = options.sanitizePatch
    ? options.sanitizePatch(incoming as Record<string, unknown>)
    : (incoming as Record<string, unknown>);
  const patchLeaves = enumerateLeafPaths(patch);
  const hasListOps = addOpsOrError.length > 0 || removeOpsOrError.length > 0;

  if (patchLeaves.length === 0 && !hasListOps) {
    return {
      response: { status: 400, body: { error: 'patch, addToList, or removeFromList required' } },
      touchedPaths: [],
    };
  }

  try {
    const current = options.load();
    let working = deepMergeConfig(
      current as Record<string, unknown>,
      patch as Record<string, unknown>,
    ) as Record<string, unknown>;
    const listTouched = applyListDeltas(working, addOpsOrError, removeOpsOrError);
    const validated = options.validate(working);
    options.save(validated);
    const allTouched = [...patchLeaves, ...listTouched];
    return { response: { body: validated }, touchedPaths: allTouched };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return {
        response: { status: 400, body: { error: 'validation_failed', issues: err.issues } },
        touchedPaths: [],
      };
    }
    throw err;
  }
}

/**
 * PUT /api/grove-config — patch the current Grove's config.
 * Request body: `{ patch: Partial<GroveConfig> }`. 404 when no Grove is bound.
 */
export async function handlePutGroveConfig(
  groveId: string | null | undefined,
  body: unknown,
): Promise<{ response: RouteResponse; touchedPaths: string[] }> {
  if (!groveId) {
    return {
      response: { status: 404, body: { error: 'no_grove_in_context' } },
      touchedPaths: [],
    };
  }
  return handlePutTierConfig<GroveConfig>(body, {
    load: () => loadGroveConfig(groveId),
    save: (validated) => saveGroveConfig(groveId, validated),
    validate: (merged) => GroveConfigSchema.parse(merged) as GroveConfig,
  });
}

// ---------------------------------------------------------------------------
// Machine-tier config handlers
// ---------------------------------------------------------------------------

export async function handleGetMachineConfig(): Promise<RouteResponse> {
  const config = loadMachineConfig();
  return { body: { config } };
}

/**
 * PUT /api/machine-config — patch the machine-wide config.
 * The Grove registry's `grove.default_grove_id` block is owned by the
 * registry (separate write surface), so we strip it from incoming
 * patches.
 */
export async function handlePutMachineConfig(
  body: unknown,
): Promise<{ response: RouteResponse; touchedPaths: string[] }> {
  return handlePutTierConfig<MachineConfig>(body, {
    load: () => loadMachineConfig(),
    save: (validated) => saveMachineConfig(validated),
    validate: (merged) => MachineConfigSchema.parse(merged) as MachineConfig,
    sanitizePatch: (patch) => {
      const { grove: _grove, ...rest } = patch;
      return rest;
    },
  });
}

// ---------------------------------------------------------------------------
// Plan-dirs factory (requires mutable references to runtime state)
// ---------------------------------------------------------------------------

export interface PlanDirDeps {
  symbiontPlanDirsByAgent: Record<string, string[]>;
}

export function createPlanDirHandlers(deps: PlanDirDeps) {
  /**
   * GET /api/config/plan-dirs — returns the symbiont-derived plan dir
   * inventory (manifest-driven, never user-editable). Custom plan dirs
   * are read/written through /api/config/scoped like any other config
   * field.
   */
  async function handleGetPlanDirs(_req: RouteRequest): Promise<RouteResponse> {
    return { body: { symbiont: deps.symbiontPlanDirsByAgent } };
  }

  return { handleGetPlanDirs };
}
