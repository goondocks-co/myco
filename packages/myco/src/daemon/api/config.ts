import {
  loadConfig,
  updateConfig,
  updateLocalConfig,
  loadMergedConfig,
  loadLocalConfig,
  deepMergeConfig,
} from '../../config/loader.js';
import { z } from 'zod';
import { MycoConfigSchema, type MycoConfig } from '../../config/schema.js';
import { unsetAtPath } from '../../utils/dot-path.js';
import { enumerateLeafPaths } from '../config-reactions/touched-paths.js';
import type { RouteRequest, RouteResponse } from '../router.js';

export async function handleGetConfig(vaultDir: string): Promise<RouteResponse> {
  const config = loadConfig(vaultDir);
  return { body: config };
}

// ---------------------------------------------------------------------------
// Scoped config handlers (project vs. local overlay)
// ---------------------------------------------------------------------------

/** GET /api/config/merged — project config with local overlay applied. */
export async function handleGetMergedConfig(vaultDir: string): Promise<RouteResponse> {
  const config = loadMergedConfig(vaultDir);
  return { body: config };
}

/** GET /api/config/local — raw local overrides (may be empty). */
export async function handleGetLocalConfig(vaultDir: string): Promise<RouteResponse> {
  return { body: loadLocalConfig(vaultDir) };
}

interface ScopedPutBody {
  scope?: 'project' | 'local';
  patch?: Record<string, unknown>;
  clear?: string[];
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
 * PUT /api/config/scoped — atomic patch + clear against project or local config.
 *
 * Request body:
 *   { scope: 'project' | 'local',
 *     patch?: DeepPartial<MycoConfig>,   // deep-merged into scope
 *     clear?: string[] }                  // dot-paths removed from scope
 *
 * At least one of `patch` (non-empty object) or `clear` (non-empty array) is
 * required. If both are present, overlapping keys are rejected (400). The
 * server applies `clear` first, then merges `patch`, in a single write.
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

  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { status: 400, body: { error: 'patch must be an object' } };
  }
  const patchLeaves = enumerateLeafPaths(patch);
  const hasPatch = patchLeaves.length > 0;
  const hasClear = clearList.length > 0;
  if (!hasPatch && !hasClear) {
    return { status: 400, body: { error: 'patch or clear required' } };
  }

  const overlap = patchLeaves.filter((leaf) => clearList.some((clearPath) => pathsOverlap(leaf, clearPath)));
  if (overlap.length > 0) {
    return { status: 400, body: { error: 'patch_clear_overlap', keys: overlap } };
  }

  if (scope === 'local') {
    try {
      const project = loadConfig(vaultDir);
      const updated = updateLocalConfig(vaultDir, (local) => {
        const working = structuredClone(local) as Record<string, unknown>;
        for (const key of clearList) unsetAtPath(working, key);
        const nextLocal = deepMergeConfig(
          working,
          patch as Record<string, unknown>,
        ) as Partial<MycoConfig>;
        const merged = deepMergeConfig(
          project as Record<string, unknown>,
          nextLocal as Record<string, unknown>,
        );
        MycoConfigSchema.parse(merged);
        return nextLocal;
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
      return deepMergeConfig(working, patch as Record<string, unknown>) as MycoConfig;
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
